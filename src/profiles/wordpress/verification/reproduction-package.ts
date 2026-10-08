import { z } from "zod";

import type { ReproductionRenderer } from "../../../verification/reproduction-package.js";

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
const routeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotDigest: digest,
  labSetupDigest: digest,
  role: z.enum(["unauthenticated", "subscriber", "customer"]),
  account: z.string().min(1).max(128),
  defaultSettings: z.boolean(),
  configurationChanges: z.array(z.string().min(1).max(500)).max(30),
  steps: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("http"),
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
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
      ]),
    )
    .min(1)
    .max(30),
  evidence: z
    .array(
      z.strictObject({
        kind: z.enum(["http", "screenshot", "canary"]),
        path: evidencePath,
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

/** WordPress owns the HTTP and browser shape; no generic module knows these terms. */
export const wordpressReproductionRenderer: ReproductionRenderer<WordPressReconstruction> =
  {
    async render(input) {
      const route = routeSchema.parse(input.route);
      const reconstruction = reconstructionSchema.parse(input.reconstruction);
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
      for (const entry of route.evidence) {
        const resolved = await input.store.readFile(
          input.evidenceDigest,
          entry.path,
          5 * 1024 * 1024,
        );
        if (resolved.status !== "resolved")
          throw new Error("Judge evidence is unavailable");
      }

      const lines = [
        "# Manual reproduction",
        "",
        `Target: ${reconstruction.target.identity} ${reconstruction.target.version}`,
        `WordPress: ${reconstruction.wordpressVersion}`,
        `Snapshot digest: ${route.snapshotDigest}`,
        `Lab setup digest: ${input.labSetupDigest}`,
        `Default settings: ${route.defaultSettings ? "yes" : "no"}`,
        `Configuration changes: ${route.configurationChanges.length ? route.configurationChanges.join("; ") : "none"}`,
        `Attacker role: ${route.role}`,
        `Lab account: ${route.account}`,
        "",
        "Use a fresh Lab with the reconstruction data. Set WBH_BASE_URL to its HTTP endpoint. Use only this route's remote HTTP and browser actions.",
        ...(route.role === "unauthenticated"
          ? []
          : [
              "Sign in as the Lab account through POST /wp-login.php with its Lab-only password before step 1. The Python script reads WBH_USERNAME and WBH_PASSWORD from the environment.",
            ]),
        "",
      ];
      for (const [index, step] of route.steps.entries()) {
        lines.push(
          `${index + 1}. ${step.kind === "http" ? `${step.method} ${step.path}` : `Open ${step.path} in a browser`}`,
        );
        if (step.kind === "http") {
          if (step.headers !== undefined)
            lines.push(`   Headers: ${JSON.stringify(step.headers)}`);
          if (step.body !== undefined)
            lines.push(`   Body: ${JSON.stringify(step.body)}`);
        }
        lines.push(`   Expected observation: ${step.expected}`);
      }
      lines.push("", `Judge evidence artifact: ${input.evidenceDigest}`);
      for (const entry of route.evidence)
        lines.push(`- ${entry.kind}: ${entry.path}`);

      const script = [
        "#!/usr/bin/env python3",
        "import os",
        "from urllib.parse import urljoin",
        "import requests",
        "",
        `STEPS = ${JSON.stringify(route.steps)}`,
        "base_url = os.environ['WBH_BASE_URL'].rstrip('/') + '/'",
        "username = os.environ.get('WBH_USERNAME', '')",
        "password = os.environ.get('WBH_PASSWORD', '')",
        "session = requests.Session()",
        ...(route.role === "unauthenticated"
          ? []
          : [
              "if not username or not password:",
              "    raise SystemExit('Set WBH_USERNAME and WBH_PASSWORD for the Lab account')",
              "session.post(urljoin(base_url, 'wp-login.php'), data={'log': username, 'pwd': password, 'wp-submit': 'Log In', 'redirect_to': base_url, 'testcookie': '1'}, timeout=30)",
              "if not any(cookie.name.startswith('wordpress_logged_in_') for cookie in session.cookies):",
              "    raise SystemExit('Lab login failed')",
            ]),
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
      return {
        manual: `${lines.join("\n")}\n`,
        script,
        reconstruction: {
          ...reconstruction,
          labSetupDigest: input.labSetupDigest,
          snapshotDigest: input.snapshotDigest,
          attackerRole: route.role,
          labAccount: route.account,
          defaultSettings: route.defaultSettings,
          configurationChanges: route.configurationChanges,
        },
        evidence: {
          judgeEvidenceDigest: input.evidenceDigest,
          entries: route.evidence,
        },
      };
    },
  };
