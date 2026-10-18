import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
export const WBH_VERIFY_SKILL_ID = "wbh-verify/v1" as const;
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

/**
 * Hands one Verifier run to a skill running on the host (#352): writes
 * `lab.json`, waits for `setup-done`, restarts the Harness observation, then
 * waits for the six Verifier files or `abort`. It never reads the files'
 * meaning; `WordPressVerifier` and the judges do that as for any transport.
 */
export class HandoffVerifier implements WordPressVerifierTransport {
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

    await mkdir(directory, { recursive: true, mode: 0o700 });
    const administrator = lab.reviewAdministrator(handle);
    if (administrator === null)
      return incomplete(
        "administrator",
        "The Lab setup administrator is unavailable; repeat in a fresh Lab",
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
      });
      await writeFile(
        join(directory, "lab.json"),
        canonicalJson({
          schema: "wbh-handoff-lab/v1",
          skill: WBH_VERIFY_SKILL_ID,
          runId: input.runId,
          findingId: input.finding.findingId,
          snapshotDigest: input.finding.snapshotDigest,
          endpoint: input.lab.endpoint,
          host: {
            url: `http://127.0.0.1:${exposed.httpPort}`,
            hostHeader: new URL(input.lab.endpoint).host,
          },
          accounts: input.lab.attackerAccounts,
          /** Setup only; after `setup-done` the attacker position alone (ADR 0035). */
          administrator,
          ...(input.lab.scenario === undefined
            ? {}
            : { scenario: input.lab.scenario }),
          ...(input.lab.secondaryLocale === undefined
            ? {}
            : { secondaryLocale: input.lab.secondaryLocale }),
          ...(input.lab.database === undefined || exposed.databasePort === null
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
          reviewExport,
          files: {
            setupDone: join(directory, "setup-done"),
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
        { mode: 0o600 },
      );

      const setup = await this.#waitFor(["setup-done"], deadline);
      if (setup !== "found")
        return incomplete(
          setup,
          setup === "abort"
            ? `Aborted before setup-done: ${await this.#abortReason()}`
            : "setup-done was not placed within the wall",
        );
      // Setup is finished: capture and diff only what follows.
      await input.restartObservation();
      const route = await this.#waitFor(
        WORDPRESS_VERIFIER_FILE_NAMES,
        deadline,
      );
      if (route !== "found")
        return incomplete(
          route,
          route === "abort"
            ? `Aborted after setup-done: ${await this.#abortReason()}`
            : "The six Verifier files were not placed within the wall",
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
  }

  async #waitFor(
    names: readonly string[],
    deadline: number,
  ): Promise<"found" | "abort" | "timeout"> {
    for (;;) {
      const present = await Promise.all(
        names.map((name) => exists(join(this.options.directory, name))),
      );
      if (present.every(Boolean)) return "found";
      if (await exists(join(this.options.directory, "abort"))) return "abort";
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
    return line.length === 0 ? "no reason given" : line.slice(0, 200);
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
