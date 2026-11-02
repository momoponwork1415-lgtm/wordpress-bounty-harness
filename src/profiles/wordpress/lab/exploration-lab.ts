import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type {
  ControlAnswer,
  ControlRequest,
} from "../../../lab/control/index.js";
import type { TrialLab, TrialLabRecord } from "../../../lab/index.js";
import type { LabStateDiffRecord } from "../../../verification/index.js";
import { createWordPressLabStateObserver } from "../verification/lab-state-diff.js";
import type { WordPressLab, WordPressLabHandle } from "./index.js";
import {
  isSingleSelect,
  wordpressExplorationFindSchema,
  wordpressExplorationSqlSchema,
} from "./lab-lookup.js";
import {
  wordpressExplorationObserveSchema,
  type WordPressExplorationObserveRequest,
} from "./lab-observation.js";
import {
  wordpressExplorationTraceSchema,
  type WordPressExplorationTraceRequest,
} from "./lab-trace.js";

/** The Private Evidence bundle one Trial's exploration Lab leaves behind. */
export const EXPLORATION_LAB_CAPTURE_FILE = "capture.jsonl";
export const EXPLORATION_LAB_RECORD_FILE = "exploration-lab.json";
export const EXPLORATION_LAB_SCREENSHOT_FILE = "screenshot.png";
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
  /** `harness-error`: the Harness threw while handling the command; the attempt counts. */
  readonly reason?: "budget" | "unavailable" | "harness-error";
  /** The answer did not reach labctl, even after one retry. */
  readonly answerDropped?: true;
};
type ObservationRecord = {
  readonly requestedAt: string;
  readonly answeredAt: string;
  readonly status: "observed" | "failed" | "refused";
  readonly reason?:
    | "budget"
    | "unavailable"
    | "invalid-request"
    | "role-unavailable"
    | "harness-error";
  /** With `invalid-request`: the name of the first field that failed, never its value. */
  readonly field?: string;
  readonly request?: WordPressExplorationObserveRequest;
  readonly answer: Readonly<Record<string, unknown>>;
  /** The answer did not reach labctl, even after one retry. */
  readonly answerDropped?: true;
};
type LookupCommand = "find" | "sql" | "trace";
/**
 * The request of one `trace` as the agent sent it: the body is its input and
 * is kept whole; of the cookie only the length is kept, never its value.
 */
type TraceRequestRecord = {
  readonly method: WordPressExplorationTraceRequest["method"];
  readonly path: string;
  readonly contentType?: WordPressExplorationTraceRequest["contentType"];
  readonly body?: string;
  readonly bodyLength: number;
  readonly cookieLength?: number;
};
/** One `find`, `sql` or `trace` lookup (ADR 0049); the three share the Trial's `maxLookups`. */
type LookupRecord = {
  readonly requestedAt: string;
  readonly answeredAt: string;
  readonly command: LookupCommand;
  readonly status: "answered" | "refused" | "failed";
  readonly reason?:
    | "budget"
    | "unavailable"
    | "invalid-request"
    | "sql-error"
    | "harness-error";
  /** With `invalid-request`: the name of the first field that failed, never its value. */
  readonly field?: string;
  /** The marker or the SELECT text as the agent sent it; for `trace`, the request record. */
  readonly request?: string | TraceRequestRecord;
  readonly answer: Readonly<Record<string, unknown>>;
  /** The answer did not reach labctl, even after one retry. */
  readonly answerDropped?: true;
};

/**
 * The first failing field of an observe request as a dotted path (`body` for
 * the whole body). An unaccepted field is named when its name is a plain
 * identifier; no value is ever echoed.
 */
function invalidField(
  issues: readonly {
    readonly code: string;
    readonly path: readonly PropertyKey[];
    readonly keys?: readonly string[];
  }[],
): string {
  const issue = issues[0];
  const unknown =
    issue?.code === "unrecognized_keys" ? issue.keys?.[0] : undefined;
  const path = [
    ...(issue?.path ?? []).map(String),
    ...(unknown !== undefined && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(unknown)
      ? [unknown]
      : []),
  ];
  return path.length === 0 ? "body" : path.join(".");
}

/**
 * One Trial's exploration Lab as the Harness drives it (ADR 0003, 2026-10-25
 * addendum): it answers `POST /reset` within `maxResets`, `POST /observe`
 * within `maxObservations`, and `POST /find`, `POST /sql` and `POST /trace`
 * within one shared `maxLookups` (ADR 0049), takes the site state before and after every Lab
 * generation, and at the end seals the recorder's capture with those states,
 * the observations and the lookups. It judges nothing; whether anything fired
 * is the agent's report (`labObservations`) and the human's call.
 */
export function openWordPressExplorationLab(options: {
  readonly lab: Pick<
    WordPressLab,
    | "captureState"
    | "readCapture"
    | "reset"
    | "nextControlRequest"
    | "answerControlRequest"
    | "observeExplorationPage"
    | "findInExplorationLab"
    | "queryExplorationLab"
    | "traceExplorationRequest"
  >;
  readonly handle: WordPressLabHandle;
  readonly maxResets: number;
  /** Resets earlier segments of the same Trial used; the budget is the Trial's. */
  readonly resetsUsedBefore?: number;
  readonly maxObservations: number;
  /** Observations earlier segments of the same Trial used. */
  readonly observationsUsedBefore?: number;
  /** Find, sql and trace lookups together (ADR 0049). */
  readonly maxLookups: number;
  /** Lookups earlier segments of the same Trial used. */
  readonly lookupsUsedBefore?: number;
  readonly store: PrivateArtifactStore;
  readonly clock: () => Date;
}): TrialLab {
  const { lab, handle, maxResets, maxObservations, maxLookups, store, clock } =
    options;
  const resetsUsedBefore = options.resetsUsedBefore ?? 0;
  const observationsUsedBefore = options.observationsUsedBefore ?? 0;
  const lookupsUsedBefore = options.lookupsUsedBefore ?? 0;
  const observations: ObservationRecord[] = [];
  const lookups: LookupRecord[] = [];
  /** Observer visits the Trial has used so far, across its segments. */
  const observedInTrial = () =>
    observationsUsedBefore +
    observations.filter((entry) => entry.status !== "refused").length;
  /** Find, sql and trace lookups the Trial has used so far, across its segments. */
  const lookedUpInTrial = () =>
    lookupsUsedBefore +
    lookups.filter((entry) => entry.status !== "refused").length;
  /** Resets the Trial has used so far, across its segments. */
  const usedInTrial = () =>
    resetsUsedBefore +
    resets.filter((entry) => entry.status !== "refused").length;
  const states = createWordPressLabStateObserver({ store, lab });
  const generations: Generation[] = [];
  const resets: ResetRecord[] = [];
  let before: StateBefore | null = null;
  let generationStartedAt = clock().toISOString();
  let broken = false;
  let closing = false;
  let serving: Promise<void> | undefined;
  /** Answers that did not reach labctl, by request id; labctl asks again until it times out. */
  const undelivered = new Map<string, ControlAnswer>();
  let droppedAnswers = 0;
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
  /** Hands one answer to labctl, and once more when the first try does not land. */
  const deliver = async (
    id: string,
    reply: ControlAnswer,
  ): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++)
      if (await lab.answerControlRequest(handle, id, reply).catch(() => false))
        return true;
    return false;
  };
  /** Delivers an answer; one that does not land is counted once and kept for labctl's next ask. */
  const send = async (id: string, reply: ControlAnswer): Promise<boolean> => {
    if (await deliver(id, reply)) return true;
    droppedAnswers++;
    undelivered.set(id, reply);
    return false;
  };
  const answer = async (
    request: ControlRequest,
    record: Omit<ResetRecord, "requestedAt" | "answeredAt" | "answerDropped">,
    statusCode: number,
  ): Promise<void> => {
    const used = usedInTrial();
    const status = record.status;
    const delivered = await send(request.id, {
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
      ...(delivered ? {} : { answerDropped: true as const }),
    });
  };
  const handleReset = async (request: ControlRequest): Promise<void> => {
    const used = usedInTrial();
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
  const answerObservation = async (
    request: ControlRequest,
    record: Omit<
      ObservationRecord,
      "requestedAt" | "answeredAt" | "answer" | "answerDropped"
    >,
    statusCode: number,
    result: Readonly<Record<string, unknown>> = {},
  ): Promise<void> => {
    const body = {
      status: record.status,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.field === undefined ? {} : { field: record.field }),
      ...result,
      observationsUsed:
        observedInTrial() + (record.status === "refused" ? 0 : 1),
      maxObservations,
    };
    const delivered = await send(request.id, { statusCode, body });
    observations.push({
      requestedAt: request.receivedAt,
      answeredAt: clock().toISOString(),
      ...record,
      answer: body,
      ...(delivered ? {} : { answerDropped: true as const }),
    });
  };
  const handleObserve = async (request: ControlRequest): Promise<void> => {
    const parsed = wordpressExplorationObserveSchema.safeParse(request.body);
    if (!parsed.success)
      return answerObservation(
        request,
        {
          status: "refused",
          reason: "invalid-request",
          field: invalidField(parsed.error.issues),
        },
        400,
      );
    const asked = parsed.data;
    if (broken)
      return answerObservation(
        request,
        { status: "refused", reason: "unavailable", request: asked },
        503,
      );
    if (observedInTrial() >= maxObservations)
      return answerObservation(
        request,
        { status: "refused", reason: "budget", request: asked },
        429,
      );
    const observed = await lab
      .observeExplorationPage(handle, asked)
      .catch(() => ({ status: "unavailable" }) as const);
    if (observed.status === "role-unavailable")
      return answerObservation(
        request,
        { status: "refused", reason: "role-unavailable", request: asked },
        400,
      );
    if (observed.status === "unavailable")
      return answerObservation(
        request,
        { status: "refused", reason: "unavailable", request: asked },
        503,
      );
    if (observed.status === "failed")
      return answerObservation(
        request,
        { status: "failed", request: asked },
        502,
        {
          failureCode: observed.failureCode,
        },
      );
    const screenshotDigest = await store
      .putFiles({ [EXPLORATION_LAB_SCREENSHOT_FILE]: observed.screenshot })
      .catch(() => null);
    return answerObservation(
      request,
      { status: "observed", request: asked },
      200,
      {
        httpStatus: observed.httpStatus ?? null,
        dialogOpened: observed.dialogCount > 0,
        ...(asked.dialogMarker === undefined
          ? {}
          : {
              marker: {
                text: asked.dialogMarker,
                alertOpened: observed.markerDialog === true,
              },
            }),
        consoleErrorCount: observed.consoleErrorCount,
        screenshotDigest,
      },
    );
  };
  const answerLookup = async (
    request: ControlRequest,
    record: Omit<
      LookupRecord,
      "requestedAt" | "answeredAt" | "answer" | "answerDropped"
    >,
    statusCode: number,
    result: Readonly<Record<string, unknown>> = {},
  ): Promise<void> => {
    const body = {
      status: record.status,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.field === undefined ? {} : { field: record.field }),
      ...result,
      lookupsUsed: lookedUpInTrial() + (record.status === "refused" ? 0 : 1),
      maxLookups,
    };
    const delivered = await send(request.id, { statusCode, body });
    lookups.push({
      requestedAt: request.receivedAt,
      answeredAt: clock().toISOString(),
      ...record,
      answer: body,
      ...(delivered ? {} : { answerDropped: true as const }),
    });
  };
  /** The refusals a lookup shares with observe, before the Lab is asked; null when it may run. */
  const lookupRefusal = (
    request: ControlRequest,
    command: LookupCommand,
    asked: string | TraceRequestRecord,
  ): Promise<void> | null => {
    if (broken)
      return answerLookup(
        request,
        { command, status: "refused", reason: "unavailable", request: asked },
        503,
      );
    if (lookedUpInTrial() >= maxLookups)
      return answerLookup(
        request,
        { command, status: "refused", reason: "budget", request: asked },
        429,
      );
    return null;
  };
  const handleFind = async (request: ControlRequest): Promise<void> => {
    const parsed = wordpressExplorationFindSchema.safeParse(request.body);
    if (!parsed.success)
      return answerLookup(
        request,
        {
          command: "find",
          status: "refused",
          reason: "invalid-request",
          field: invalidField(parsed.error.issues),
        },
        400,
      );
    const { marker } = parsed.data;
    const refused = lookupRefusal(request, "find", marker);
    if (refused !== null) return refused;
    const found = await lab
      .findInExplorationLab(handle, marker)
      .catch(() => ({ status: "unavailable" }) as const);
    if (found.status === "unavailable")
      return answerLookup(
        request,
        {
          command: "find",
          status: "refused",
          reason: "unavailable",
          request: marker,
        },
        503,
      );
    if (found.status === "failed")
      return answerLookup(
        request,
        { command: "find", status: "failed", request: marker },
        502,
      );
    return answerLookup(
      request,
      { command: "find", status: "answered", request: marker },
      200,
      {
        marker,
        database: found.database,
        files: found.files,
        truncated: found.truncated,
      },
    );
  };
  const handleSql = async (request: ControlRequest): Promise<void> => {
    const parsed = wordpressExplorationSqlSchema.safeParse(request.body);
    if (!parsed.success)
      return answerLookup(
        request,
        {
          command: "sql",
          status: "refused",
          reason: "invalid-request",
          field: invalidField(parsed.error.issues),
        },
        400,
      );
    const { select } = parsed.data;
    if (!isSingleSelect(select))
      return answerLookup(
        request,
        {
          command: "sql",
          status: "refused",
          reason: "invalid-request",
          field: "select",
          request: select,
        },
        400,
      );
    const refused = lookupRefusal(request, "sql", select);
    if (refused !== null) return refused;
    const queried = await lab
      .queryExplorationLab(handle, select)
      .catch(() => ({ status: "unavailable" }) as const);
    if (queried.status === "unavailable")
      return answerLookup(
        request,
        {
          command: "sql",
          status: "refused",
          reason: "unavailable",
          request: select,
        },
        503,
      );
    if (queried.status === "refused")
      return answerLookup(
        request,
        {
          command: "sql",
          status: "refused",
          reason: "sql-error",
          request: select,
        },
        400,
        { message: queried.message },
      );
    return answerLookup(
      request,
      { command: "sql", status: "answered", request: select },
      200,
      {
        columns: queried.columns,
        rows: queried.rows,
        truncated: queried.truncated,
      },
    );
  };
  const handleTrace = async (request: ControlRequest): Promise<void> => {
    const parsed = wordpressExplorationTraceSchema.safeParse(request.body);
    if (!parsed.success)
      return answerLookup(
        request,
        {
          command: "trace",
          status: "refused",
          reason: "invalid-request",
          field: invalidField(parsed.error.issues),
        },
        400,
      );
    const asked = parsed.data;
    const record: TraceRequestRecord = {
      method: asked.method,
      path: asked.path,
      ...(asked.contentType === undefined
        ? {}
        : { contentType: asked.contentType }),
      ...(asked.body === undefined ? {} : { body: asked.body }),
      bodyLength: asked.body?.length ?? 0,
      ...(asked.cookie === undefined
        ? {}
        : { cookieLength: asked.cookie.length }),
    };
    if (asked.method === "GET" && asked.body !== undefined)
      return answerLookup(
        request,
        {
          command: "trace",
          status: "refused",
          reason: "invalid-request",
          field: "body",
          request: record,
        },
        400,
      );
    const refused = lookupRefusal(request, "trace", record);
    if (refused !== null) return refused;
    const traced = await lab
      .traceExplorationRequest(handle, asked)
      .catch(() => ({ status: "unavailable" }) as const);
    if (traced.status === "unavailable")
      return answerLookup(
        request,
        {
          command: "trace",
          status: "refused",
          reason: "unavailable",
          request: record,
        },
        503,
      );
    if (traced.status === "failed")
      return answerLookup(
        request,
        { command: "trace", status: "failed", request: record },
        502,
      );
    return answerLookup(
      request,
      { command: "trace", status: "answered", request: record },
      200,
      {
        httpStatus: traced.httpStatus,
        entries: traced.entries,
        entryCount: traced.entryCount,
        truncated: traced.truncated,
      },
    );
  };
  /**
   * Runs one command. A throw answers it `failed` with a fixed reason (no
   * message, no stack), counts the attempt and is logged with its command,
   * so the loop keeps serving.
   */
  const handleCommand = async (request: ControlRequest): Promise<void> => {
    try {
      if (request.command === "reset") await handleReset(request);
      else if (request.command === "observe") await handleObserve(request);
      else if (request.command === "find") await handleFind(request);
      else if (request.command === "sql") await handleSql(request);
      else if (request.command === "trace") await handleTrace(request);
    } catch {
      if (request.command === "reset") {
        // The site state the next generation starts from is no longer known.
        before = null;
        await answer(
          request,
          { status: "failed", reason: "harness-error" },
          500,
        ).catch(() => undefined);
      } else if (
        request.command === "find" ||
        request.command === "sql" ||
        request.command === "trace"
      )
        await answerLookup(
          request,
          {
            command: request.command,
            status: "failed",
            reason: "harness-error",
          },
          500,
        ).catch(() => undefined);
      else
        await answerObservation(
          request,
          { status: "failed", reason: "harness-error" },
          500,
        ).catch(() => undefined);
    }
  };
  const serve = async (): Promise<void> => {
    while (!closing) {
      const asked = Date.now();
      const request = await lab
        .nextControlRequest(handle, CONTROL_WAIT_SECONDS)
        .catch(() => "unavailable" as const);
      if (request !== null && request !== "unavailable") {
        const kept = undelivered.get(request.id);
        if (kept === undefined) {
          await handleCommand(request);
          continue;
        }
        // labctl still waits on a command already run: hand it the same
        // answer again, never run the command twice.
        if (await deliver(request.id, kept)) {
          undelivered.delete(request.id);
          continue;
        }
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
        droppedAnswers,
        observations: observations.filter((entry) => entry.status !== "refused")
          .length,
        refusedObservations: observations.filter(
          (entry) => entry.status === "refused",
        ).length,
        lookups: lookups.filter((entry) => entry.status !== "refused").length,
        refusedLookups: lookups.filter((entry) => entry.status === "refused")
          .length,
      };
      const record = {
        schemaVersion: 1,
        labId: handle.id,
        setupDigest: handle.setupDigest,
        maxResets,
        resetsUsedBefore,
        maxObservations,
        observationsUsedBefore,
        maxLookups,
        lookupsUsedBefore,
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
        observationLog: observations,
        lookupLog: lookups,
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
