import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  AgentRuntimeProfile,
  NativeRunReceipt,
  OneShotExecutor,
  OneShotRun,
} from "../../../discovery/index.js";
import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { WordPressLab, WordPressLabHandle } from "../lab/index.js";
import { HANDOFF_WALL_MS, WBH_VERIFY_SKILL_ID } from "./handoff-verifier.js";
import {
  WORDPRESS_VERIFIER_FILE_NAMES,
  type WordPressVerifierFiles,
  type WordPressVerifierRun,
  type WordPressVerifierTransport,
  type WordPressVerifierTransportResult,
} from "./wordpress-verifier.js";

const SKILL_URL = new URL(
  "../../../../.claude/skills/wbh-verify/SKILL.md",
  import.meta.url,
);
const digest = (content: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

/** The Harness's path and phase mapping for the unchanged wbh-verify/v11 skill (#651). */
export const ONE_SHOT_VERIFY_SECTION = `## Harness one-shot Lab paths and phases

Use the supplied wbh-verify/v11 skill for this one Finding. In that skill, <dir> means /workspace/output. Read /workspace/input/lab.json during setup only; its files paths below are authoritative. Read /workspace/input/review-export.json for the Finding. The fixed target source is read-only under /workspace/source; fixed dependencies are read-only at their mounted paths.

The skill's setup-done marker is /workspace/output/setup-done.json: write {} as valid JSON after all administrator setup ends. The Harness then revokes the administrator, restarts the HTTP capture and Lab baseline, removes lab.json, and publishes /workspace/input/attack.json. Its publication is the skill's observation-ready signal. Wait for attack.json; compare its runId, findingId and snapshotDigest with /workspace/input/binding.json. Write /workspace/output/observation-ready.json as {} only after that comparison succeeds. Never reuse administrator credentials after setup-done.json.

Write the six skill files under /workspace/output with their specified names; complete each by atomic rename, with precondition last. If the skill requires abort, write its allowed reason code in /workspace/output/abort.json and its detail in /workspace/output/precondition. Do not call review observe or review decide. The Harness records evidence for a human to judge.`;

type AutoReceipt = WordPressVerifierTransportResult["receipt"] & {
  readonly transport: "one-shot-codex/v1";
  readonly skill: typeof WBH_VERIFY_SKILL_ID;
  readonly skillDigest: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly reason: "wall" | "provider" | "policy" | "evidence" | "unavailable";
  readonly nativeReceipt?: NativeRunReceipt;
  readonly filesArtifactDigest?: string;
};

/** Runs the existing verifier skill in a Lab-attached, disposable Codex sandbox. */
export class OneShotWordPressVerifier implements WordPressVerifierTransport {
  readonly preconditionSetup = "transport" as const;

  constructor(
    readonly options: {
      readonly oneShot: OneShotExecutor;
      readonly profile: AgentRuntimeProfile;
      readonly handle: WordPressLabHandle;
      readonly lab: Pick<WordPressLab, "reviewAdministrator">;
      readonly sourceFor: (snapshotDigest: string) => Promise<{
        readonly directory: OneShotRun["sourceDirectory"];
        readonly tree: OneShotRun["sourceTree"];
        readonly dependency?: OneShotRun["dependencySource"];
        readonly dependencySources?: OneShotRun["dependencySources"];
      }>;
      readonly reviewExport: () => Promise<string>;
      readonly store: PrivateArtifactStore;
      readonly clock: () => Date;
      readonly skillPath?: string;
    },
  ) {}

  async run(
    input: WordPressVerifierRun,
  ): Promise<WordPressVerifierTransportResult> {
    const startedAt = this.options.clock();
    const skill = await readFile(
      this.options.skillPath ?? fileURLToPath(SKILL_URL),
    );
    const skillDigest = digest(skill);
    const prompt = `${skill.toString("utf8")}\n\n${ONE_SHOT_VERIFY_SECTION}\n`;
    const promptDigest = digest(prompt);
    const finish = (
      outcome: WordPressVerifierTransportResult["outcome"],
      reason: AutoReceipt["reason"],
      nativeReceipt?: NativeRunReceipt,
      filesArtifactDigest?: string,
    ): WordPressVerifierTransportResult => {
      const body = {
        transport: "one-shot-codex/v1" as const,
        skill: WBH_VERIFY_SKILL_ID,
        skillDigest,
        runId: input.runId,
        targetSnapshotDigest: input.finding.snapshotDigest,
        terminal:
          outcome.status === "files"
            ? ("completed" as const)
            : ("incomplete" as const),
        startedAt: startedAt.toISOString(),
        completedAt: this.options.clock().toISOString(),
        reason,
        ...(nativeReceipt === undefined ? {} : { nativeReceipt }),
        ...(filesArtifactDigest === undefined ? {} : { filesArtifactDigest }),
      };
      return {
        promptDigest,
        outcome,
        receipt: {
          ...body,
          digest: digest(canonicalJson(body)),
        } satisfies AutoReceipt,
      };
    };
    const incomplete = (
      reason: Exclude<AutoReceipt["reason"], "unavailable">,
      nativeReceipt?: NativeRunReceipt,
    ) =>
      finish(
        { status: "incomplete", nextStep: `auto:${reason}` },
        reason,
        nativeReceipt,
      );
    const administrator = this.options.lab.reviewAdministrator(
      this.options.handle,
    );
    if (administrator === null) return incomplete("evidence");
    const attackerRole = input.finding.attackerPosition;
    if (
      attackerRole !== "unauthenticated" &&
      input.lab.attackerAccounts[attackerRole] === undefined
    )
      return incomplete("evidence");

    let setupClosed = false;
    let nativeReceipt: NativeRunReceipt | undefined;
    try {
      const source = await this.options.sourceFor(input.finding.snapshotDigest);
      const binding = {
        runId: input.runId,
        findingId: input.finding.findingId,
        snapshotDigest: input.finding.snapshotDigest,
      };
      const expiresAt = new Date(
        Math.max(Date.now(), startedAt.getTime()) + HANDOFF_WALL_MS,
      ).toISOString();
      const labJson = canonicalJson({
        schema: "wbh-handoff-lab/v2",
        skill: WBH_VERIFY_SKILL_ID,
        ...binding,
        endpoint: input.lab.endpoint,
        host: {
          url: input.lab.endpoint,
          hostHeader: new URL(input.lab.endpoint).host,
        },
        administrator,
        ...(input.lab.secondaryLocale === undefined
          ? {}
          : { secondaryLocale: input.lab.secondaryLocale }),
        reviewExport: "/workspace/input/review-export.json",
        files: {
          setupDone: "/workspace/output/setup-done.json",
          observationReady: "/workspace/input/attack.json",
          attack: "/workspace/input/attack.json",
          abort: "/workspace/output/abort.json",
          outputs: Object.fromEntries(
            WORDPRESS_VERIFIER_FILE_NAMES.map((name) => [
              name,
              `/workspace/output/${name}`,
            ]),
          ),
        },
        expiresAt,
      });
      const result = await this.options.oneShot.execute({
        runId: input.runId,
        targetSnapshotDigest: input.finding.snapshotDigest,
        profile: this.options.profile,
        prompt,
        inputFiles: [
          {
            name: "review-export.json",
            content: await this.options.reviewExport(),
          },
          { name: "binding.json", content: canonicalJson(binding) },
        ],
        toolFiles: [],
        output: "files",
        wallMs: HANDOFF_WALL_MS,
        expiresAt,
        sourceDirectory: source.directory,
        sourceTree: source.tree,
        ...(source.dependency !== undefined
          ? { dependencySource: source.dependency }
          : {}),
        ...(source.dependencySources === undefined
          ? {}
          : { dependencySources: source.dependencySources }),
        lab: {
          endpoint: input.lab.endpoint,
          networkName: input.lab.networkName,
          internalIp: input.lab.recorderIp,
          labJson,
          administratorExpiresAt: expiresAt,
          outputFileNames: WORDPRESS_VERIFIER_FILE_NAMES,
          closeSetup: async (signal) => {
            if (
              signal.aborted ||
              setupClosed ||
              !(await input.restartObservation())
            )
              return undefined;
            setupClosed = true;
            return canonicalJson({
              schema: "wbh-handoff-attack/v1",
              ...binding,
              accounts:
                attackerRole === "unauthenticated"
                  ? {}
                  : {
                      [attackerRole]: input.lab.attackerAccounts[attackerRole],
                    },
              ...(input.lab.database === undefined
                ? {}
                : {
                    database: {
                      host: input.lab.database.ipv4,
                      port: input.lab.database.port,
                      name: input.lab.database.name,
                      readOnlyAccount: input.lab.database.readOnlyAccount,
                    },
                  }),
              ...(input.referenceRoute === undefined
                ? {}
                : { referenceRoute: input.referenceRoute }),
            });
          },
        },
      });
      const native = result.receipt;
      nativeReceipt = native;
      if (
        native.runId !== input.runId ||
        native.targetSnapshotDigest !== input.finding.snapshotDigest
      )
        return incomplete("evidence", native);
      if (native.terminal !== "completed" || !setupClosed)
        return incomplete(
          native.reason === "provider" &&
            native.reasonDetail === "provider-cyber-policy"
            ? "policy"
            : native.reason === "wall" ||
                native.reason === "provider" ||
                native.reason === "policy"
              ? native.reason
              : "evidence",
          native,
        );
      const output = new Map(
        result.outputFiles?.map((file) => [file.name, file.content]) ?? [],
      );
      if (!output.has("observation-ready.json"))
        return incomplete("evidence", native);
      const files = Object.fromEntries(
        WORDPRESS_VERIFIER_FILE_NAMES.map((name) => [name, output.get(name)]),
      );
      if (Object.values(files).some((value) => value === undefined))
        return incomplete("evidence", native);
      const complete = files as Record<
        (typeof WORDPRESS_VERIFIER_FILE_NAMES)[number],
        string
      >;
      const filesArtifactDigest = await this.options.store.putFiles(complete);
      return finish(
        { status: "files", files: complete as WordPressVerifierFiles },
        "unavailable",
        native,
        filesArtifactDigest,
      );
    } catch {
      return incomplete("evidence", nativeReceipt);
    }
  }
}
