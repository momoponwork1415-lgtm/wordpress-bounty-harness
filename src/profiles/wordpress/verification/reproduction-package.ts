import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import type { ReproductionRenderer } from "../../../verification/reproduction-package.js";
import { snapshotSchema } from "../../../snapshot/index.js";
import {
  loadWordPressAcceptanceCriteria,
  loadWordPressReproductionTemplate,
} from "../acceptance/index.js";
import { wordpressVictimRouteSchema } from "../lab/index.js";
import { setupSchema } from "../lab/provision-input.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !/[\r\n\0]/.test(value),
  );
const evidencePath = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) =>
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."),
  );
export const wordpressReproductionStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("http"),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    path,
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    expected: z.string().min(1).max(2000),
  }),
  z.strictObject({
    kind: z.literal("browser"),
    path,
    expected: z.string().min(1).max(2000),
  }),
]);
const routeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotDigest: digest,
  labSetupDigest: digest,
  role: z.enum(["unauthenticated", "subscriber", "customer"]),
  account: z.string().min(1).max(128),
  defaultSettings: z.boolean(),
  configurationChanges: z.array(z.string().min(1).max(500)).max(30),
  steps: z.array(wordpressReproductionStepSchema).min(1).max(30),
  victim: wordpressVictimRouteSchema.optional(),
  evidence: z
    .array(
      z.strictObject({
        kind: z.enum(["http", "screenshot", "canary", "structured-output"]),
        path: evidencePath,
        capture: z.enum(["harness-captured", "agent-authored"]).optional(),
      }),
    )
    .min(2)
    .max(30),
});
const reconstructionSchema = z.strictObject({
  wordpressVersion: z.string().min(1).max(100),
  target: z.strictObject({
    identity: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    sourceDigest: digest,
  }),
  enabledSettings: z.array(z.string().min(1).max(500)).max(100),
  roles: z.array(z.string().min(1).max(100)).min(1).max(30),
});
const snapshotWithDigestSchema = snapshotSchema.safeExtend({ digest });

export type WordPressReconstruction = z.infer<typeof reconstructionSchema>;

const capturedExchangeSchema = z.strictObject({
  request: z.looseObject({
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    path,
    truncated: z.literal(false),
  }),
  response: z.looseObject({
    statusCode: z.number().int().min(100).max(599),
    truncated: z.literal(false),
  }),
});

function evidenceOrigin(
  entry: z.infer<typeof routeSchema>["evidence"][number],
): "harness-captured" | "agent-authored" {
  return (
    entry.capture ??
    (entry.kind === "http" ? "agent-authored" : "harness-captured")
  );
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/[&<>]/g, (character) =>
    character === "&" ? "\\u0026" : character === "<" ? "\\u003c" : "\\u003e",
  );
}

/** Only the Lab proxy's recorded method, path and status may enter the main steps. */
function capturedHttpSequence(bytes: Buffer): string[] {
  const rows = bytes.toString("utf8").trimEnd().split("\n");
  if (rows.length > 500) return [];
  try {
    return rows.map((row, index) => {
      const parsed: unknown = JSON.parse(row);
      const exchange = capturedExchangeSchema.parse(parsed);
      return `${index + 1}. ${exchange.request.method} ${safeInlineJson(exchange.request.path)} → ${exchange.response.statusCode}`;
    });
  } catch {
    // The raw, digest-bound capture stays available even if its display shape differs.
    return [];
  }
}

function renderScript(): string {
  return [
    "#!/usr/bin/env python3",
    "# Agent-authored route data lives in agent-authored.json; compare with Harness evidence before use.",
    "import json",
    "import os",
    "from pathlib import Path",
    "from urllib.parse import urljoin, urlsplit",
    "",
    "ROUTE = json.loads(Path(__file__).with_name('agent-authored.json').read_text(encoding='utf-8'))",
    "STEPS = ROUTE['steps']",
    "for index, step in enumerate(STEPS, 1):",
    "    if step['kind'] == 'http' and step['method'] in ('POST', 'PUT', 'PATCH', 'DELETE') and 'body' not in step:",
    "        raise SystemExit(f'Step {index} has no request body. Use the manual steps and captured Private Evidence; no request was sent.')",
    "import requests",
    "base_url = os.environ['WBH_BASE_URL'].rstrip('/') + '/'",
    "origin = urlsplit(base_url)",
    "if origin.scheme not in ('http', 'https') or not origin.hostname:",
    "    raise SystemExit('WBH_BASE_URL must be an HTTP Lab origin')",
    "def lab_url(path):",
    "    target = urljoin(base_url, path)",
    "    parsed = urlsplit(target)",
    "    if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc):",
    "        raise SystemExit('Route leaves the Lab origin; no request was sent')",
    "    return target",
    "for step in STEPS:",
    "    lab_url(step['path'])",
    "username = os.environ.get('WBH_USERNAME', '')",
    "password = os.environ.get('WBH_PASSWORD', '')",
    "session = requests.Session()",
    "session.trust_env = False",
    "if ROUTE['role'] != 'unauthenticated':",
    "    if not username or not password:",
    "        raise SystemExit('Set WBH_USERNAME and WBH_PASSWORD for the Lab account')",
    "    session.post(lab_url('/wp-login.php'), data={'log': username, 'pwd': password, 'wp-submit': 'Log In', 'redirect_to': base_url, 'testcookie': '1'}, timeout=30, allow_redirects=False)",
    "    if not any(cookie.name.startswith('wordpress_logged_in_') for cookie in session.cookies):",
    "        raise SystemExit('Lab login failed')",
    "for index, step in enumerate(STEPS, 1):",
    "    if step['kind'] == 'browser':",
    "        print(f\"{index}. Open in browser: {lab_url(step['path'])}\")",
    "        print(f\"   Expected: {step['expected']}\")",
    "        continue",
    "    body = step.get('body', '').replace('{{USERNAME}}', username).replace('{{PASSWORD}}', password)",
    "    response = session.request(step['method'], lab_url(step['path']), headers=step.get('headers'), data=body if 'body' in step else None, timeout=30, allow_redirects=False)",
    "    print(f\"{index}. {step['method']} {step['path']} -> {response.status_code}\")",
    "    print(response.text[:1000])",
    "    print(f\"   Expected: {step['expected']}\")",
    "print('HTTP responses alone do not prove reproduction; confirm the fresh Lab canary and victim observation.')",
    "",
  ].join("\n");
}

/** WordPress owns the HTTP and browser shape; no generic module knows these terms. */
export const wordpressReproductionRenderer: ReproductionRenderer<WordPressReconstruction> =
  {
    async render(input) {
      const route = routeSchema.parse(input.route);
      const reconstruction = reconstructionSchema.parse(input.reconstruction);
      const setup = setupSchema.parse(input.setup);
      const snapshot = snapshotWithDigestSchema.parse(input.snapshot);
      const snapshotBody = {
        kind: snapshot.kind,
        schemaVersion: snapshot.schemaVersion,
        target: snapshot.target,
        dependencies: snapshot.dependencies,
      };
      if (
        setup.snapshotDigest !== input.snapshotDigest ||
        snapshot.digest !== input.snapshotDigest ||
        canonicalDigest(snapshotSchema.parse(snapshotBody)) !== snapshot.digest
      )
        throw new Error("Lab reconstruction does not match the Snapshot");
      const [criteria, template] = await Promise.all([
        loadWordPressAcceptanceCriteria(input.category),
        loadWordPressReproductionTemplate(),
      ]);
      if (
        ["stored-xss", "sqli", "account-takeover"].includes(input.category) &&
        criteria === null
      )
        throw new Error("A versioned acceptance criterion is required");
      if (
        route.snapshotDigest !== input.snapshotDigest ||
        route.labSetupDigest !== input.labSetupDigest
      )
        throw new Error("Judge route snapshot mismatch");
      if (route.defaultSettings && route.configurationChanges.length > 0)
        throw new Error("Default settings conflict with configuration changes");
      if (!reconstruction.roles.includes(route.role))
        throw new Error("Required role is absent from Lab reconstruction");
      if (!route.evidence.some((entry) => entry.kind === "http"))
        throw new Error("Harness HTTP evidence is required");
      if (
        input.proofKind === "nonce-canary" &&
        !route.evidence.some((entry) => entry.kind === "canary")
      )
        throw new Error("Nonce canary evidence is required");
      if (
        input.proofKind === "captured-script-observation" &&
        !route.evidence.some((entry) => entry.kind === "structured-output")
      )
        throw new Error("Structured reproduction output is required");
      if (
        route.steps.some((step) => step.kind === "browser") &&
        !route.evidence.some((entry) => entry.kind === "screenshot")
      )
        throw new Error("Browser observation requires a screenshot");
      const capturedHttp: string[] = [];
      for (const entry of route.evidence) {
        const resolved = await input.store.readFile(
          input.evidenceDigest,
          entry.path,
          evidenceOrigin(entry) === "harness-captured"
            ? 64 * 1024 * 1024 + 1024
            : 5 * 1024 * 1024,
        );
        if (resolved.status !== "resolved")
          throw new Error("Judge evidence is unavailable");
        if (
          entry.kind === "http" &&
          evidenceOrigin(entry) === "harness-captured"
        )
          capturedHttp.push(...capturedHttpSequence(resolved.bytes));
      }

      const lines: string[] = [
        "# Manual reproduction",
        "",
        `Template: ${template.id} v${template.version} ${template.digest} [harness-captured]`,
        `Acceptance criteria: ${criteria === null ? "not-catalogued" : `${criteria.id} v${criteria.version} ${criteria.digest}`} [harness-captured]`,
        `Category [agent-authored, Finding impact]: ${safeInlineJson(input.category)}`,
        "",
        `## 1. ${template.sections[0].heading}`,
        `Judge criterion [harness-captured]: ${criteria?.judgeSuccessCriterion ?? "No category criterion is catalogued yet."}`,
        "Wordfence status [harness-captured]: not-assessed",
        ...(criteria?.programmeCriteria.wordfence.map(
          (criterion, index) =>
            `Wordfence condition ${index + 1} [harness-captured]: ${criterion}`,
        ) ?? []),
        "Patchstack status [harness-captured]: not-assessed",
        ...(criteria?.programmeCriteria.patchstack.map(
          (criterion, index) =>
            `Patchstack condition ${index + 1} [harness-captured]: ${criterion}`,
        ) ?? []),
        "",
        `## 2. ${template.sections[1].heading}`,
        `Expected [harness-captured]: ${criteria?.judgeSuccessCriterion ?? "See the judge's recorded nonce-canary condition."}`,
        `Actual [harness-captured]: ${safeInlineJson(input.judgeId)} recorded ${safeInlineJson(Object.fromEntries(Object.entries(input.conditions).sort(([left], [right]) => left.localeCompare(right))))}; evidence artifact ${input.evidenceDigest}.`,
        ...route.evidence.map(
          (entry) =>
            `${entry.kind} evidence [${evidenceOrigin(entry)}]: ${entry.path}`,
        ),
        "",
        `## 3. ${template.sections[2].heading}`,
        input.negativeControl === "unavailable-no-fixed-release"
          ? "Fixed-version negative control [harness-captured]: unavailable (no fixed release). This is not a contradicted result."
          : "Fixed-version negative control [harness-captured]: not-recorded-in-this-package. Check the separate fixed-snapshot verification before submission; absence here is not a contradicted result.",
        "",
        `## 4. ${template.sections[3].heading}`,
        `Target [harness-captured]: ${safeInlineJson(reconstruction.target.identity)} ${safeInlineJson(reconstruction.target.version)}`,
        `WordPress [harness-captured]: ${safeInlineJson(reconstruction.wordpressVersion)}`,
        `Snapshot digest [harness-captured]: ${route.snapshotDigest}`,
        `Lab setup digest [harness-captured]: ${input.labSetupDigest}`,
        `Enabled settings [harness-captured]: ${reconstruction.enabledSettings.length ? safeInlineJson(reconstruction.enabledSettings) : "none"}`,
        `Available Lab roles [harness-captured]: ${safeInlineJson(reconstruction.roles)}`,
        "Attacker role, Lab account, setup claims and intended route [agent-authored]: agent-authored.json. Verify these against the fresh Lab and captured evidence.",
        input.proofKind === "captured-script-observation"
          ? "The attached standard script is the exact Harness-executed script; its /run/wbh-reproduction/input.json is generated inside the automated Lab. For manual reproduction, use the fresh review Lab and follow the captured route and agent-authored steps."
          : "Set WBH_BASE_URL to the fresh Lab endpoint; the helper script uses WBH_USERNAME and WBH_PASSWORD only from the environment.",
        ...route.steps.map(
          (_, index) =>
            `${index + 1}. Intended step [agent-authored]: agent-authored.json#/steps/${index}`,
        ),
        "Captured HTTP exchange order [harness-captured]:",
        ...(capturedHttp.length === 0
          ? [
              "- No Lab proxy sequence was attached; consult the evidence reference and do not treat the intended route as captured.",
            ]
          : capturedHttp.map((step) => `- ${step}`)),
      ];
      const executedScript =
        input.proofKind === "captured-script-observation"
          ? await input.store.readFile(
              input.evidenceDigest,
              "standard-reproduce.py",
              64 * 1024,
            )
          : null;
      if (
        input.proofKind === "captured-script-observation" &&
        executedScript?.status !== "resolved"
      )
        throw new Error("Executed standard script is unavailable");
      return {
        manual: `${lines.join("\n")}\n`,
        script:
          executedScript?.status === "resolved"
            ? executedScript.bytes.toString("utf8")
            : renderScript(),
        reconstruction: {
          ...reconstruction,
          setup,
          snapshot,
          labSetupDigest: input.labSetupDigest,
          snapshotDigest: input.snapshotDigest,
          provenance: {
            wordpressVersion: "harness-captured",
            target: "harness-captured",
            enabledSettings: "harness-captured",
            roles: "harness-captured",
            labSetupDigest: "harness-captured",
            snapshotDigest: "harness-captured",
            setup: "harness-captured",
            snapshot: "harness-captured",
          },
        },
        evidence: {
          judgeEvidenceDigest: input.evidenceDigest,
          entries: route.evidence.map((entry) => ({
            ...entry,
            capture: evidenceOrigin(entry),
          })),
        },
        ...(criteria === null
          ? {}
          : {
              acceptanceCriteria: {
                id: criteria.id,
                version: criteria.version,
                digest: criteria.digest,
              },
            }),
        reproductionTemplate: {
          id: template.id,
          version: template.version,
          digest: template.digest,
        },
        auxiliaryFiles: {
          "agent-authored.json": JSON.stringify({
            provenance: "agent-authored",
            role: route.role,
            account: route.account,
            defaultSettings: route.defaultSettings,
            configurationChanges: route.configurationChanges,
            ...(route.victim === undefined ? {} : { victim: route.victim }),
            steps: route.steps,
          }),
        },
      };
    },
  };
