import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { ControlRequest } from "../../../lab/control/index.js";
import type { TrialLab, TrialLabRecord } from "../../../lab/index.js";
import type { LabStateDiffRecord } from "../../../verification/index.js";
import { createWordPressLabStateObserver } from "../verification/lab-state-diff.js";
import type { WordPressLab, WordPressLabHandle } from "./index.js";

/** The Private Evidence bundle one Trial's exploration Lab leaves behind. */
export const EXPLORATION_LAB_CAPTURE_FILE = "capture.jsonl";
export const EXPLORATION_LAB_RECORD_FILE = "exploration-lab.json";
/** How long one `docker exec … next` waits for a command before asking again. */
const CONTROL_WAIT_SECONDS = 10;

type StateBefore = { readonly digest: string; readonly state: unknown };
type Generation = {
  readonly generation: number;
  readonly startedAt: string;
  readonly state: LabStateDiffRecord;
};
type ResetRecord = {
  readonly requestedAt: string;
  readonly answeredAt: string;
  readonly status: "reset" | "refused" | "failed";
  readonly reason?: "budget" | "unavailable";
};

/**
 * One Trial's exploration Lab as the Harness drives it (ADR 0003, 2026-10-25
 * addendum): it answers `POST /reset` within `maxResets`, takes the site
 * state before and after every Lab generation, and at the end seals the
 * recorder's capture with those states. It judges nothing; whether anything
 * fired is the agent's report (`labObservations`) and the human's call.
 */
export function openWordPressExplorationLab(options: {
  readonly lab: Pick<
    WordPressLab,
    | "captureState"
    | "readCapture"
    | "reset"
    | "nextControlRequest"
    | "answerControlRequest"
  >;
  readonly handle: WordPressLabHandle;
  readonly maxResets: number;
  readonly store: PrivateArtifactStore;
  readonly clock: () => Date;
}): TrialLab {
  const { lab, handle, maxResets, store, clock } = options;
  const states = createWordPressLabStateObserver({ store, lab });
  const generations: Generation[] = [];
  const resets: ResetRecord[] = [];
  let before: StateBefore | null = null;
  let generationStartedAt = clock().toISOString();
  let broken = false;
  let closing = false;
  let serving: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  /** A pause `seal` cuts short. */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const closeGeneration = async (): Promise<void> => {
    generations.push({
      generation: generations.length,
      startedAt: generationStartedAt,
      state:
        before === null
          ? { status: "missing", reason: "before-capture" }
          : await states.after(handle, before),
    });
  };
  const openGeneration = async (): Promise<void> => {
    generationStartedAt = clock().toISOString();
    before = await states.before(handle);
  };
  const answer = async (
    request: ControlRequest,
    record: Omit<ResetRecord, "requestedAt" | "answeredAt">,
    statusCode: number,
  ): Promise<void> => {
    const used = resets.filter((entry) => entry.status !== "refused").length;
    const status = record.status;
    await lab.answerControlRequest(handle, request.id, {
      statusCode,
      body: {
        status,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        resetsUsed: used + (status === "refused" ? 0 : 1),
        maxResets,
      },
    });
    resets.push({
      requestedAt: request.receivedAt,
      answeredAt: clock().toISOString(),
      ...record,
    });
  };
  const handleReset = async (request: ControlRequest): Promise<void> => {
    const used = resets.filter((entry) => entry.status !== "refused").length;
    if (broken)
      return answer(request, { status: "refused", reason: "unavailable" }, 503);
    if (used >= maxResets)
      return answer(request, { status: "refused", reason: "budget" }, 429);
    await closeGeneration();
    const ok = await lab.reset(handle);
    if (!ok) {
      broken = true;
      before = null;
      return answer(request, { status: "failed" }, 503);
    }
    await openGeneration();
    return answer(request, { status: "reset" }, 200);
  };
  const serve = async (): Promise<void> => {
    while (!closing) {
      const asked = Date.now();
      const request = await lab
        .nextControlRequest(handle, CONTROL_WAIT_SECONDS)
        .catch(() => "unavailable" as const);
      if (request !== null && request !== "unavailable") {
        if (request.command === "reset") await handleReset(request);
        continue;
      }
      // An endpoint that is gone, or answers at once, is asked again only
      // after a pause, so the loop never spins.
      const pause = (request === null ? 1_000 : 5_000) - (Date.now() - asked);
      if (pause > 0 && !closing) await sleep(pause);
    }
  };

  return {
    labId: handle.id,
    async open() {
      await openGeneration().catch(() => {
        before = null;
      });
      serving = serve();
    },
    async seal(): Promise<TrialLabRecord> {
      closing = true;
      wake?.();
      await serving?.catch(() => undefined);
      if (!broken) await closeGeneration().catch(() => undefined);
      const capture = await lab
        .readCapture(handle, "0")
        .catch(() => ({ status: "unavailable" }) as const);
      const counts = {
        requests:
          capture.status === "captured"
            ? capture.exchanges.length +
              capture.defects.filter((defect) => defect.kind !== "truncated")
                .length +
              capture.dropped
            : 0,
        droppedRequests: capture.status === "captured" ? capture.dropped : 0,
        resets: resets.filter((entry) => entry.status !== "refused").length,
        refusedResets: resets.filter((entry) => entry.status === "refused")
          .length,
      };
      const record = {
        schemaVersion: 1,
        labId: handle.id,
        setupDigest: handle.setupDigest,
        maxResets,
        capture:
          capture.status === "captured"
            ? {
                status: "captured",
                exchanges: capture.exchanges.length,
                dropped: capture.dropped,
                defects: capture.defects,
              }
            : { status: "unavailable" },
        generations,
        resetLog: resets,
        ...counts,
      };
      try {
        const artifactDigest = await store.putFiles({
          [EXPLORATION_LAB_RECORD_FILE]: canonicalJson(record),
          ...(capture.status === "captured"
            ? { [EXPLORATION_LAB_CAPTURE_FILE]: capture.bytes }
            : {}),
        });
        return { artifactDigest, ...counts };
      } catch {
        return counts;
      }
    },
  };
}
