import { z } from "zod";

import type { ReproductionRenderer } from "../../../verification/reproduction-package.js";
import {
  loadWordPressAcceptanceCriteria,
  loadWordPressReproductionTemplate,
} from "../acceptance/index.js";
import { wordpressVictimRouteSchema } from "../lab/index.js";

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
        kind: z.enum(["http", "screenshot", "canary"]),
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
    "from urllib.parse import urljoin",
    "import requests",
    "",
    "ROUTE = json.loads(Path(__file__).with_name('agent-authored.json').read_text(encoding='utf-8'))",
    "STEPS = ROUTE['steps']",
    "base_url = os.environ['WBH_BASE_URL'].rstrip('/') + '/'",
    "username = os.environ.get('WBH_USERNAME', '')",
    "password = os.environ.get('WBH_PASSWORD', '')",
    "session = requests.Session()",
    "if ROUTE['role'] != 'unauthenticated':",
    "    if not username or not password:",
    "        raise SystemExit('Set WBH_USERNAME and WBH_PASSWORD for the Lab account')",
    "    session.post(urljoin(base_url, 'wp-login.php'), data={'log': username, 'pwd': password, 'wp-submit': 'Log In', 'redirect_to': base_url, 'testcookie': '1'}, timeout=30)",
    "    if not any(cookie.name.startswith('wordpress_logged_in_') for cookie in session.cookies):",
    "        raise SystemExit('Lab login failed')",
    "for index, step in enumerate(STEPS, 1):",
    "    if step['kind'] == 'browser':",
    "        print(f\"{index}. Open in browser: {urljoin(base_url, step['path'].lstrip('/'))}\")",
    "        print(f\"   Expected: {step['expected']}\")",
    "        continue",
    "    body = step.get('body', '').replace('{{USERNAME}}', username).replace('{{PASSWORD}}', password)",
    "    response = session.request(step['method'], urljoin(base_url, step['path'].lstrip('/')), headers=step.get('headers'), data=body if 'body' in step else None, timeout=30)",
    "    print(f\"{index}. {step['method']} {step['path']} -> {response.status_code}\")",
    "    print(response.text[:1000])",
    "    print(f\"   Expected: {step['expected']}\")",
    "",
  ].join("\n");
}

/** WordPress owns the HTTP and browser shape; no generic module knows these terms. */
export const wordpressReproductionRenderer: ReproductionRenderer<WordPressReconstruction> =
  {
    async render(input) {
      const route = routeSchema.parse(input.route);
      const reconstruction = reconstructionSchema.parse(input.reconstruction);
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
      if (
        !route.evidence.some((entry) => entry.kind === "http") ||
        !route.evidence.some((entry) => entry.kind === "canary")
      )
        throw new Error("HTTP and nonce canary evidence are required");
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
        `Actual [harness-captured]: judge ${safeInlineJson(input.judgeId)} recorded ${safeInlineJson(Object.fromEntries(Object.entries(input.conditions).sort(([left], [right]) => left.localeCompare(right))))}; evidence artifact ${input.evidenceDigest}.`,
        ...route.evidence.map(
          (entry) =>
            `${entry.kind} evidence [${evidenceOrigin(entry)}]: ${entry.path}`,
        ),
        "",
        `## 3. ${template.sections[2].heading}`,
        "Fixed-version negative control [harness-captured]: not-recorded-in-this-package. Check the separate fixed-snapshot verification before submission; absence here is not a contradicted result.",
        "",
        `## 4. ${template.sections[3].heading}`,
        `Target [harness-captured]: ${safeInlineJson(reconstruction.target.identity)} ${safeInlineJson(reconstruction.target.version)}`,
        `WordPress [harness-captured]: ${safeInlineJson(reconstruction.wordpressVersion)}`,
        `Snapshot digest [harness-captured]: ${route.snapshotDigest}`,
        `Lab setup digest [harness-captured]: ${input.labSetupDigest}`,
        `Enabled settings [harness-captured]: ${reconstruction.enabledSettings.length ? safeInlineJson(reconstruction.enabledSettings) : "none"}`,
        `Available Lab roles [harness-captured]: ${safeInlineJson(reconstruction.roles)}`,
        "Attacker role, Lab account, setup claims and intended route [agent-authored]: agent-authored.json. Verify these against the fresh Lab and captured evidence.",
        "Set WBH_BASE_URL to the fresh Lab endpoint; the helper script uses WBH_USERNAME and WBH_PASSWORD only from the environment.",
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
      return {
        manual: `${lines.join("\n")}\n`,
        script: renderScript(),
        reconstruction: {
          ...reconstruction,
          labSetupDigest: input.labSetupDigest,
          snapshotDigest: input.snapshotDigest,
          provenance: {
            wordpressVersion: "harness-captured",
            target: "harness-captured",
            enabledSettings: "harness-captured",
            roles: "harness-captured",
            labSetupDigest: "harness-captured",
            snapshotDigest: "harness-captured",
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
