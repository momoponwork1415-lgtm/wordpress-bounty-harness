import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createNativeRunReceipt,
  nativeRunReceiptSchema,
  type AgentRuntimeProfile,
  type CodexNativeAgentRuntime,
  type DiscoveryTransportRun,
  type NativeRunReceipt,
} from "../../../discovery/index.js";
import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { WordPressMountedSourcePack } from "../acquisition/mounted-source-pack.js";
import { loadWordPressVerifierPrompt } from "../prompts/index.js";
import {
  WORDPRESS_VERIFIER_FILE_NAMES,
  type WordPressVerifierFiles,
  type WordPressVerifierRun,
  type WordPressVerifierTransport,
  type WordPressVerifierTransportResult,
} from "./wordpress-verifier.js";

/** The sealed attachment the v8 prompt asks for: each file as a string, or null. */
const attachmentSchema = z.looseObject({
  "http.json": z.string().nullable().optional(),
  "steps.md": z.string().nullable().optional(),
  "route.json": z.string().nullable().optional(),
  "session.json": z.string().nullable().optional(),
  "refutation.md": z.string().nullable().optional(),
  precondition: z.string().nullable().optional(),
});

const STORED_SCRIPT_INSTRUCTIONS = [
  "## Harness victim operation contract",
  'If a stored script fires only after a victim UI action, describe that action in route.json victim.paths as {path, actions}, instead of a path string. The Lab browser supports at most three actions per path: {kind: "click", selector: "CSS selector"} or {kind: "click-text", text: "visible text", exact: false}. Use a uniquely identifiable visible element. The Harness performs these actions as the declared victim in a fresh browser; do not request victim credentials or include executable browser code.',
  "Use canary.javascript for a direct nonce-bound POST. If the injection surface truncates long code, canary.loaderJavascript loads a short module that sends the same POST. Loading the module URL as an image or stylesheet does not record a beacon.",
] as const;
const SQL_CANARY_INSTRUCTIONS =
  "## Harness SQL canary target\nFor SQL injection, canary.table is the Lab-owned table to target through the reported low-privilege HTTP route. Its row value is withheld. A response containing that row or a table change is assessed by the Harness judge; do not report either as proof yourself. The supplied database account is read only.";

/** A fresh, isolated Codex transport invocation for each Finding attempt. */
export class CodexVerifier implements WordPressVerifierTransport {
  constructor(
    readonly options: {
      readonly runtime: Pick<
        CodexNativeAgentRuntime,
        "execute" | "attachments"
      >;
      readonly profile: AgentRuntimeProfile;
      readonly sourcePack: WordPressMountedSourcePack;
      readonly clock: () => Date;
      readonly wallTimeMs?: number;
    },
  ) {}

  async run({
    runId,
    finding,
    lab,
    canary,
    referenceRoute,
  }: WordPressVerifierRun): Promise<WordPressVerifierTransportResult> {
    const fixed = await loadWordPressVerifierPrompt();
    const now = this.options.clock();
    const { sourcePack } = this.options;
    const fixedInstructions = [
      fixed.text.trim(),
      ...(finding.impact === "stored-xss" ? STORED_SCRIPT_INSTRUCTIONS : []),
      ...(finding.impact === "sqli" ? [SQL_CANARY_INSTRUCTIONS] : []),
    ].join("\n\n");
    // The versioned .md digest alone would hide changes to this fixed contract.
    const promptDigest =
      finding.impact === "stored-xss" || finding.impact === "sqli"
        ? `sha256:${createHash("sha256").update(fixedInstructions).digest("hex")}`
        : fixed.digest;
    const prompt = [
      fixedInstructions,
      "## Finding",
      canonicalJson(finding),
      "## Lab",
      canonicalJson({
        endpoint: lab.endpoint,
        accounts: lab.attackerAccounts,
        ...(lab.scenario === undefined ? {} : { scenario: lab.scenario }),
        ...(lab.secondaryLocale === undefined
          ? {}
          : { secondaryLocale: lab.secondaryLocale }),
        ...(lab.database === undefined
          ? {}
          : {
              database: {
                host: lab.database.host,
                port: lab.database.port,
                name: lab.database.name,
                readOnlyAccount: lab.database.readOnlyAccount,
              },
            }),
        sourcePack: {
          target: sourcePack.target.path,
          ...(sourcePack.core === undefined
            ? {}
            : { wordpressCore: sourcePack.core.path }),
          dependencies: sourcePack.dependencies.map((source) => source.path),
        },
        ...(canary === undefined ? {} : { canary }),
      }),
      ...(referenceRoute === undefined
        ? []
        : ["## Earlier confirmed route", canonicalJson(referenceRoute)]),
    ].join("\n\n");

    const run: DiscoveryTransportRun = {
      runId,
      targetSnapshotDigest: finding.snapshotDigest,
      profile: this.options.profile,
      prompt,
      outputKind: "verification",
      lab: {
        endpoint: lab.endpoint,
        networkName: lab.networkName,
        internalIp: lab.recorderIp,
        ...(lab.database === undefined
          ? {}
          : {
              database: { host: lab.database.host, ipv4: lab.database.ipv4 },
            }),
      },
      campaignInput: {
        schemaVersion: 1,
        snapshotDigest: finding.snapshotDigest,
        trustBoundary: {
          version: "verifier-v1",
          text: "Only the stated low-privilege attacker position",
        },
        programmeBoundary: {
          version: "verifier-v1",
          text: "Existing Finding only",
        },
        modelProfileDigest: this.options.profile.digest,
        promptDigest,
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
        lab: { setupDigest: lab.setupDigest },
        history: { mode: "none" },
      },
      sourceDirectory: sourcePack.target.directory,
      sourceTree: sourcePack.target.tree,
      ...(sourcePack.core === undefined
        ? {}
        : { dependencySource: sourcePack.core }),
      dependencySources: sourcePack.dependencies,
      expiresAt: new Date(
        now.getTime() + (this.options.wallTimeMs ?? 30 * 60_000),
      ).toISOString(),
    };
    let result: Awaited<ReturnType<CodexNativeAgentRuntime["execute"]>>;
    try {
      result = await this.options.runtime.execute(run);
    } catch {
      result = {
        receipt: createNativeRunReceipt({
          ...run,
          terminal: "incomplete",
          reason: "provider",
          startedAt: now.toISOString(),
          completedAt: this.options.clock().toISOString(),
        }),
      };
    }
    const receipt = nativeRunReceiptSchema.parse(result.receipt);
    if (receipt.runtimeProfileDigest !== this.options.profile.digest)
      throw new Error("Verifier receipt does not match its runtime profile");
    return {
      promptDigest,
      receipt,
      outcome: await this.#outcome(receipt, result.attachment),
    };
  }

  async #outcome(
    receipt: NativeRunReceipt,
    attachment: Awaited<
      ReturnType<CodexNativeAgentRuntime["execute"]>
    >["attachment"],
  ): Promise<WordPressVerifierTransportResult["outcome"]> {
    if (receipt.terminal === "incomplete") {
      // A CLI error event plus a failed broker relay is a transport failure,
      // even when the CLI exits zero and the transcript decoder reports schema.
      if (
        receipt.reason === "schema" &&
        receipt.reasonDetail === "unadmitted-event-type:error" &&
        (receipt.brokerMetrics?.relayFailures ?? 0) > 0
      )
        return { status: "transport-failed", reason: "provider" };
      if (receipt.reason === "provider" || receipt.reason === "sandbox")
        return { status: "transport-failed", reason: receipt.reason };
      return {
        status: "incomplete",
        nextStep: `Repair the Verifier transport (${receipt.reason}) and repeat in a fresh Lab`,
      };
    }
    if (
      attachment === undefined ||
      attachment.kind !== "verification" ||
      receipt.reportArtifactDigest !== attachment.digest
    )
      return {
        status: "incomplete",
        nextStep: "Record a Verifier attachment and repeat",
      };
    const sealed = await this.options.runtime.attachments.read(attachment);
    if (sealed.status !== "resolved")
      return {
        status: "incomplete",
        nextStep: "Recover the Verifier attachment and repeat",
      };
    let data: z.infer<typeof attachmentSchema>;
    try {
      data = attachmentSchema.parse(
        JSON.parse(sealed.bytes.toString("utf8")) as unknown,
      );
    } catch {
      return {
        status: "incomplete",
        nextStep: "Record a readable Verifier attachment and repeat",
      };
    }
    const files: Record<string, string> = {};
    for (const name of WORDPRESS_VERIFIER_FILE_NAMES) {
      const value = data[name];
      if (typeof value === "string") files[name] = value;
    }
    return { status: "files", files: files as WordPressVerifierFiles };
  }
}
