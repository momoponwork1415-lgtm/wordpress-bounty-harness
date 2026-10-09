import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  createNativeRunReceipt,
  nativeRunReceiptSchema,
  type AgentRuntimeProfile,
  type CodexNativeAgentRuntime,
  type DiscoveryTransportRun,
  type NativeRunReceipt,
} from "../../../discovery/index.js";
import type { ExpectedSourceTree } from "../../../infrastructure/canonical-source-tree.js";
import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Ledger } from "../../../ledger/index.js";
import {
  VerifierTransportIncompleteError,
  type Verifier,
  type VerifierAttempt,
} from "../../../verification/index.js";
import {
  readWordPressFinding,
  type WordPressFinding,
} from "../discovery/finding.js";
import type { WordPressLab, WordPressLabHandle } from "../lab/index.js";
import { loadWordPressVerifierPrompt } from "../prompts/index.js";

const httpSchema = z.looseObject({
  exchanges: z
    .array(
      z.looseObject({
        request: z.unknown(),
        response: z.looseObject({ body: z.string() }),
      }),
    )
    .min(1)
    .max(500),
});
const attachmentSchema = z.looseObject({
  "http.json": z.string().nullable().optional(),
  "steps.md": z.string().nullable().optional(),
  "route.json": z.string().nullable().optional(),
  "session.json": z.string().nullable().optional(),
  "refutation.md": z.string().nullable().optional(),
  precondition: z.string().nullable().optional(),
});
/** The same cookie shape the Lab accepts when it resolves a session. */
const sessionSchema = z.strictObject({
  cookie: z.string().regex(/^[A-Za-z0-9%|._@+-]{1,4096}$/),
});

const routeSchema = z.looseObject({
  role: z.enum(["unauthenticated", "subscriber", "customer"]),
  defaultSettings: z.boolean(),
  steps: z
    .array(z.looseObject({ kind: z.string(), path: z.string().optional() }))
    .max(30)
    .optional(),
});

type LowPrivilegeAccounts = Readonly<{
  subscriber: Readonly<{ username: string; password: string }>;
  customer?: Readonly<{ username: string; password: string }>;
}>;

/** Copy named low-privilege fields only, including when an untyped handle has extras. */
function lowPrivilegeAccounts(
  handle: WordPressLabHandle,
): LowPrivilegeAccounts {
  const { subscriber, customer } = handle.attackerAccounts;
  return {
    subscriber: {
      username: subscriber.username,
      password: subscriber.password,
    },
    ...(customer === undefined
      ? {}
      : {
          customer: {
            username: customer.username,
            password: customer.password,
          },
        }),
  };
}

/** A fresh, isolated transport invocation for each Finding attempt. */
export class CodexVerifier implements Verifier<
  WordPressFinding,
  WordPressLabHandle
> {
  constructor(
    readonly options: {
      readonly runtime: Pick<
        CodexNativeAgentRuntime,
        "execute" | "attachments"
      >;
      readonly store: PrivateArtifactStore;
      readonly ledger: Ledger;
      readonly profile: AgentRuntimeProfile;
      readonly source: {
        readonly directory: string;
        readonly tree: ExpectedSourceTree;
      };
      readonly dependencySource?: {
        readonly directory: string;
        readonly tree: ExpectedSourceTree;
      };
      /** Issues the canary a Finding's impact needs; only the Lab can observe it. */
      readonly lab: Pick<
        WordPressLab,
        "prepareExecutionCanary" | "prepareScriptCanary"
      >;
      readonly clock: () => Date;
      readonly wallTimeMs?: number;
    },
  ) {}

  /** The canary the Finding's impact needs, issued fresh for this attempt. */
  #canaryFor(
    finding: WordPressFinding,
    lab: WordPressLabHandle,
  ):
    | { readonly kind: "execution"; readonly php: string }
    | { readonly kind: "script"; readonly beaconUrl: string }
    | undefined {
    switch (finding.impact) {
      case "rce":
      case "php-file-write": {
        const canary = this.options.lab.prepareExecutionCanary(lab);
        return canary === null
          ? undefined
          : { kind: "execution", php: canary.php };
      }
      case "stored-xss": {
        const canary = this.options.lab.prepareScriptCanary(lab);
        return canary === null
          ? undefined
          : { kind: "script", beaconUrl: canary.beaconUrl };
      }
      default:
        return undefined;
    }
  }

  async attempt({
    finding,
    lab,
  }: {
    readonly finding: WordPressFinding;
    readonly lab: WordPressLabHandle;
  }): Promise<VerifierAttempt> {
    const event = this.options.ledger
      .read({
        findingId: finding.findingId,
        type: "finding-recorded",
        limit: 1,
      })
      .at(0)?.event;
    const reference = event?.artifacts.find(
      (artifact) => artifact.kind === "finding",
    );
    if (
      event === undefined ||
      reference === undefined ||
      lab.snapshotDigest !== finding.snapshotDigest
    )
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: "Use a recorded Finding and a Lab from its snapshot",
      };
    const saved = await this.options.store.readFile(
      reference.digest,
      "finding.json",
      1024 * 1024,
    );
    if (saved.status !== "resolved")
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: "Restore the private Finding record",
      };
    let admitted: WordPressFinding;
    try {
      admitted = readWordPressFinding(
        JSON.parse(saved.bytes.toString("utf8")) as unknown,
      );
    } catch {
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: "Restore the valid private Finding record",
      };
    }
    if (
      admitted.findingId !== finding.findingId ||
      admitted.snapshotDigest !== lab.snapshotDigest
    )
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: "Use the Finding recorded for this Lab snapshot",
      };

    const fixed = await loadWordPressVerifierPrompt();
    const runId = `verify-${finding.findingId}-${randomUUID()}`;
    const now = this.options.clock();
    const accounts = lowPrivilegeAccounts(lab);
    const needsCanary =
      admitted.impact === "rce" ||
      admitted.impact === "php-file-write" ||
      admitted.impact === "stored-xss";
    const canary = this.#canaryFor(admitted, lab);
    if (needsCanary && canary === undefined)
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: "Issue a canary from a fresh Lab and repeat",
      };
    const prompt = [
      fixed.text.trim(),
      "## Finding",
      canonicalJson(admitted),
      "## Lab",
      canonicalJson({
        endpoint: lab.endpoint,
        accounts,
        ...(this.options.dependencySource === undefined
          ? {}
          : { wordpressCoreSource: "/workspace/wordpress" }),
        ...(canary === undefined ? {} : { canary }),
      }),
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
        internalIp: lab.internalIp,
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
        promptDigest: fixed.digest,
        stopRules: { maxRuns: 1, noFindingRuns: 1 },
        lab: { setupDigest: lab.setupDigest },
        history: { mode: "none" },
      },
      sourceDirectory: this.options.source.directory,
      sourceTree: this.options.source.tree,
      ...(this.options.dependencySource === undefined
        ? {}
        : { dependencySource: this.options.dependencySource }),
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
    if (
      receipt.runId !== runId ||
      receipt.targetSnapshotDigest !== finding.snapshotDigest ||
      receipt.runtimeProfileDigest !== this.options.profile.digest
    )
      throw new Error("Verifier receipt does not match its run");
    await this.#recordRun(
      event.campaignId,
      finding.findingId,
      fixed.digest,
      receipt,
      canary?.kind,
    );

    if (receipt.terminal === "incomplete") {
      if (receipt.reason === "provider" || receipt.reason === "sandbox")
        throw new VerifierTransportIncompleteError(receipt.reason);
      return {
        status: "incomplete",
        reason: "recipe",
        nextStep: `Repair the Verifier transport (${receipt.reason}) and repeat in a fresh Lab`,
      };
    }
    if (
      result.attachment === undefined ||
      result.attachment.kind !== "verification" ||
      receipt.reportArtifactDigest !== result.attachment.digest
    )
      return {
        status: "incomplete",
        reason: "recipe",
        nextStep: "Record a Verifier attachment and repeat",
      };
    const attachment = await this.options.runtime.attachments.read(
      result.attachment,
    );
    if (attachment.status !== "resolved")
      return {
        status: "incomplete",
        reason: "recipe",
        nextStep: "Recover the Verifier attachment and repeat",
      };
    let data: z.infer<typeof attachmentSchema>;
    try {
      data = attachmentSchema.parse(
        JSON.parse(attachment.bytes.toString("utf8")) as unknown,
      );
    } catch {
      return {
        status: "incomplete",
        reason: "recipe",
        nextStep: "Record a readable Verifier attachment and repeat",
      };
    }
    if (
      typeof data.precondition === "string" &&
      data.precondition.trim().length > 0
    )
      return {
        status: "incomplete",
        reason: "precondition",
        nextStep: data.precondition.slice(0, 2000),
      };
    if (
      typeof data["http.json"] !== "string" ||
      typeof data["steps.md"] !== "string" ||
      !data["steps.md"].trim()
    )
      return {
        status: "incomplete",
        reason: "recipe",
        nextStep: "Record http.json and steps.md, then repeat",
      };
    try {
      httpSchema.parse(JSON.parse(data["http.json"]) as unknown);
    } catch {
      return {
        status: "incomplete",
        reason: "recipe",
        nextStep: "Repair the http.json exchanges schema and repeat",
      };
    }
    let route: string | undefined;
    if (typeof data["route.json"] === "string") {
      try {
        const parsed = routeSchema.parse(
          JSON.parse(data["route.json"]) as unknown,
        );
        if (parsed.role !== admitted.attackerPosition)
          throw new Error("Route role differs from Finding");
        route = data["route.json"];
      } catch {
        return {
          status: "incomplete",
          reason: "recipe",
          nextStep: "Repair the route.json role and settings, then repeat",
        };
      }
    }
    let session: string | undefined;
    if (typeof data["session.json"] === "string") {
      try {
        session = canonicalJson(
          sessionSchema.parse(JSON.parse(data["session.json"]) as unknown),
        );
      } catch {
        return {
          status: "incomplete",
          reason: "recipe",
          nextStep: "Repair the session.json cookie record, then repeat",
        };
      }
    }
    const recipeDigest = await this.options.store.putFiles({
      "http.json": data["http.json"],
      "steps.md": data["steps.md"],
      ...(route === undefined ? {} : { "route.json": route }),
      ...(session === undefined ? {} : { "session.json": session }),
    });

    const refutationDigest =
      typeof data["refutation.md"] === "string" && data["refutation.md"].trim()
        ? await this.options.store.putFiles({
            "refutation.md": data["refutation.md"],
          })
        : undefined;
    return {
      status: "attempted",
      recipeDigest,
      ...(refutationDigest === undefined ? {} : { refutationDigest }),
    };
  }

  async #recordRun(
    campaignId: string,
    findingId: string,
    promptDigest: string,
    receipt: NativeRunReceipt,
    canaryIssued?: "execution" | "script",
  ): Promise<void> {
    const receiptDigest = await this.options.store.putFiles({
      "receipt.json": canonicalJson(receipt),
    });
    const appended = await this.options.ledger.append({
      schemaVersion: 1,
      identity: `verifier-${receipt.digest}`,
      campaignId,
      snapshotDigest: receipt.targetSnapshotDigest,
      occurredAt: this.options.clock().toISOString(),
      type: "verifier-run-finished",
      findingId,
      runId: receipt.runId,
      promptDigest,
      receiptDigest,
      terminal: receipt.terminal,
      ...(canaryIssued === undefined ? {} : { canaryIssued }),
      artifacts: [{ kind: "native-run-receipt", digest: receiptDigest }],
    });
    if (appended.status === "conflict")
      throw new Error("Verifier run identity conflict");
  }
}
