import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { VerifierRunReceipt } from "../../../verification/index.js";
import type { WordPressLab, WordPressLabHandle } from "../lab/index.js";
import {
  WORDPRESS_VERIFIER_FILE_NAMES,
  type WordPressVerifierFiles,
  type WordPressVerifierRun,
  type WordPressVerifierTransport,
  type WordPressVerifierTransportResult,
} from "./wordpress-verifier.js";

/** The skill that runs this transport; its body is the fixed instruction the run's promptDigest names. */
export const WBH_VERIFY_SKILL_ID = "wbh-verify/v4" as const;
const SKILL_URL = new URL(
  "../../../../.claude/skills/wbh-verify/SKILL.md",
  import.meta.url,
);

/** The receipt of one handoff run; `reason` is why it ended short of six files. */
type HandoffRunReceipt = VerifierRunReceipt & {
  readonly transport: "handoff/v1";
  readonly skill: typeof WBH_VERIFY_SKILL_ID;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly reason?: string;
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const HANDOFF_CLAIM = ".wbh-handoff-active";
const HANDOFF_FILES = new Set([
  "lab.json",
  ".lab.json.tmp",
  "attack.json",
  ".attack.json.tmp",
  "review-export.json",
  "setup-done",
  "observation-ready",
  "abort",
  ...WORDPRESS_VERIFIER_FILE_NAMES,
]);
const ABORT_REASON_CODES = new Set([
  "precondition-unavailable",
  "route-unavailable",
  "observer-unavailable",
  "handoff-interrupted",
]);

/**
 * Hands one Verifier run to a skill running on the host (#352): writes
 * setup-only `lab.json`, waits for `setup-done`, has the Harness close setup
 * and restart its observation, then releases
 * attacker-only `attack.json` and waits for the six
 * Verifier files or `abort`. It never reads the files'
 * meaning; `WordPressVerifier` and the judges do that as for any transport.
 */
export class HandoffVerifier implements WordPressVerifierTransport {
  readonly preconditionSetup = "transport" as const;

  constructor(
    readonly options: {
      readonly directory: string;
      readonly handle: WordPressLabHandle;
      readonly lab: Pick<
        WordPressLab,
        "exposeToHost" | "withdrawFromHost" | "reviewAdministrator"
      >;
      readonly ports: { readonly http: number; readonly database: number };
      /** The Finding's review export JSON, written beside `lab.json`. */
      readonly reviewExport: () => Promise<string>;
      readonly clock: () => Date;
      /** Bounds setup and the route together; the Codex Verifier's default. */
      readonly wallTimeMs?: number;
      readonly pollIntervalMs?: number;
      readonly skillPath?: string;
    },
  ) {}

  async run(
    input: WordPressVerifierRun,
  ): Promise<WordPressVerifierTransportResult> {
    const { directory, handle, lab } = this.options;
    const skill = await readFile(
      this.options.skillPath ?? fileURLToPath(SKILL_URL),
    );
    const promptDigest = `sha256:${createHash("sha256").update(skill).digest("hex")}`;
    const startedAt = this.options.clock();
    const deadline =
      startedAt.getTime() + (this.options.wallTimeMs ?? 30 * 60_000);
    const finish = (
      outcome: WordPressVerifierTransportResult["outcome"],
      reason?: string,
    ): WordPressVerifierTransportResult => ({
      promptDigest,
      receipt: this.#receipt(input, startedAt, outcome, reason),
      outcome,
    });
    const incomplete = (reason: string, nextStep: string) =>
      finish(
        { status: "incomplete", nextStep: `handoff: ${nextStep}` },
        reason,
      );
    const aborted = async () => {
      const precondition = await readFile(
        join(directory, "precondition"),
        "utf8",
      ).catch(() => undefined);
      return finish(
        {
          status: "incomplete",
          nextStep: `handoff:${await this.#abortReason()}`,
          ...(precondition?.trim() ? { precondition } : {}),
        },
        "abort",
      );
    };

    await mkdir(directory, { recursive: true, mode: 0o700 });
    const claimPath = join(directory, HANDOFF_CLAIM);
    const claim = await open(claimPath, "wx", 0o600).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    });
    if (claim === null)
      return incomplete(
        "directory-in-use",
        "Another attempt is using the handoff directory; use a fresh handoff directory",
      );
    try {
      if ((await readdir(directory)).some((name) => HANDOFF_FILES.has(name)))
        return incomplete(
          "stale-directory",
          "The directory contains files from another attempt; use a fresh handoff directory",
        );
      const administrator = lab.reviewAdministrator(handle);
      if (administrator === null)
        return incomplete(
          "administrator",
          "The Lab setup administrator is unavailable; repeat in a fresh Lab",
        );
      const attackerRole = input.finding.attackerPosition;
      const attackerAccount =
        attackerRole === "unauthenticated"
          ? undefined
          : input.lab.attackerAccounts[attackerRole];
      if (attackerRole !== "unauthenticated" && attackerAccount === undefined)
        return incomplete(
          "attacker-account",
          "The Lab attacker account for this Finding is unavailable; repeat in a fresh Lab",
        );
      const exposed = await lab.exposeToHost(handle, {
        httpPort: this.options.ports.http,
        ...(input.lab.database === undefined
          ? {}
          : { databasePort: this.options.ports.database }),
        via: "recorder",
      });
      if (exposed.status !== "exposed")
        return incomplete(
          "exposure",
          `The Lab could not be published on the host: ${exposed.diagnostic}`,
        );
      try {
        const reviewExport = join(directory, "review-export.json");
        await writeFile(reviewExport, await this.options.reviewExport(), {
          mode: 0o600,
          flag: "wx",
        });
        const labJsonTemp = join(directory, ".lab.json.tmp");
        await writeFile(
          labJsonTemp,
          canonicalJson({
            schema: "wbh-handoff-lab/v2",
            skill: WBH_VERIFY_SKILL_ID,
            runId: input.runId,
            findingId: input.finding.findingId,
            snapshotDigest: input.finding.snapshotDigest,
            endpoint: input.lab.endpoint,
            host: {
              url: `http://127.0.0.1:${exposed.httpPort}`,
              hostHeader: new URL(input.lab.endpoint).host,
            },
            /** Setup only; revoked at `setup-done`, then the attacker position alone (ADR 0035). */
            administrator,
            ...(input.lab.scenario === undefined
              ? {}
              : { scenario: input.lab.scenario }),
            ...(input.lab.secondaryLocale === undefined
              ? {}
              : { secondaryLocale: input.lab.secondaryLocale }),
            reviewExport,
            files: {
              setupDone: join(directory, "setup-done"),
              observationReady: join(directory, "observation-ready"),
              attack: join(directory, "attack.json"),
              abort: join(directory, "abort"),
              outputs: Object.fromEntries(
                WORDPRESS_VERIFIER_FILE_NAMES.map((name) => [
                  name,
                  join(directory, name),
                ]),
              ),
            },
            expiresAt: new Date(deadline).toISOString(),
          }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(labJsonTemp, join(directory, "lab.json"));

        const setup = await this.#waitFor(["setup-done"], deadline);
        if (setup !== "found")
          return setup === "abort"
            ? aborted()
            : incomplete(
                "timeout",
                "setup-done was not placed within the wall",
              );
        // Setup is finished: only what follows is captured and diffed, and
        // no attacker data is released unless the Harness closed setup (#430).
        if (!(await input.restartObservation()))
          return incomplete(
            "setup-boundary",
            "The Harness could not close setup and retake the Lab baseline; repeat in a fresh Lab",
          );
        await writeFile(join(directory, "observation-ready"), "", {
          mode: 0o600,
          flag: "wx",
        });
        const attackJsonTemp = join(directory, ".attack.json.tmp");
        await writeFile(
          attackJsonTemp,
          canonicalJson({
            schema: "wbh-handoff-attack/v1",
            runId: input.runId,
            findingId: input.finding.findingId,
            snapshotDigest: input.finding.snapshotDigest,
            accounts:
              attackerRole === "unauthenticated"
                ? {}
                : { [attackerRole]: attackerAccount },
            ...(input.lab.database === undefined ||
            exposed.databasePort === null
              ? {}
              : {
                  database: {
                    host: "127.0.0.1",
                    port: exposed.databasePort,
                    name: input.lab.database.name,
                    readOnlyAccount: input.lab.database.readOnlyAccount,
                  },
                }),
            ...(input.canary === undefined ? {} : { canary: input.canary }),
            ...(input.referenceRoute === undefined
              ? {}
              : { referenceRoute: input.referenceRoute }),
          }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(attackJsonTemp, join(directory, "attack.json"));
        const route = await this.#waitFor(
          WORDPRESS_VERIFIER_FILE_NAMES,
          deadline,
        );
        if (route !== "found")
          return route === "abort"
            ? aborted()
            : incomplete(
                "timeout",
                "The six Verifier files were not placed within the wall",
              );
        const files: Record<string, string> = {};
        for (const name of WORDPRESS_VERIFIER_FILE_NAMES)
          files[name] = await readFile(join(directory, name), "utf8");
        return finish({
          status: "files",
          files: files as WordPressVerifierFiles,
        });
      } finally {
        await lab.withdrawFromHost(handle);
      }
    } finally {
      await claim.close();
      await rm(claimPath, { force: true });
    }
  }

  async #waitFor(
    names: readonly string[],
    deadline: number,
  ): Promise<"found" | "abort" | "timeout"> {
    for (;;) {
      if (await exists(join(this.options.directory, "abort"))) return "abort";
      const present = await Promise.all(
        names.map((name) => exists(join(this.options.directory, name))),
      );
      if (present.every(Boolean)) return "found";
      if (this.options.clock().getTime() >= deadline) return "timeout";
      await sleep(this.options.pollIntervalMs ?? 1_000);
    }
  }

  async #abortReason(): Promise<string> {
    const text = await readFile(
      join(this.options.directory, "abort"),
      "utf8",
    ).catch(() => "");
    const line = text.split("\n")[0]?.trim() ?? "";
    return ABORT_REASON_CODES.has(line) ? line : "unspecified";
  }

  #receipt(
    input: WordPressVerifierRun,
    startedAt: Date,
    outcome: WordPressVerifierTransportResult["outcome"],
    reason: string | undefined,
  ): HandoffRunReceipt {
    const body = {
      transport: "handoff/v1" as const,
      skill: WBH_VERIFY_SKILL_ID,
      runId: input.runId,
      targetSnapshotDigest: input.finding.snapshotDigest,
      terminal:
        outcome.status === "files"
          ? ("completed" as const)
          : ("incomplete" as const),
      startedAt: startedAt.toISOString(),
      completedAt: this.options.clock().toISOString(),
      ...(reason === undefined ? {} : { reason }),
    };
    return {
      ...body,
      digest: `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`,
    };
  }
}
