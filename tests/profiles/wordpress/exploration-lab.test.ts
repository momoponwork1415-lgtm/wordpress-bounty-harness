import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { httpCapture } from "../../../src/lab/capture.js";
import type { ControlRequest } from "../../../src/lab/control/index.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { openWordPressExplorationLab } from "../../../src/profiles/wordpress/lab/exploration-lab.js";
import type {
  WordPressLab,
  WordPressLabHandle,
  WordPressLabState,
} from "../../../src/profiles/wordpress/lab/index.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const handle = {
  id: "11111111-2222-4333-8444-555555555555",
  snapshotDigest: `sha256:${"a".repeat(64)}`,
  setupDigest: `sha256:${"b".repeat(64)}`,
  endpoint: "http://wordpress",
  networkName: "wbh-11111111-2222-4333-8444-555555555555-net",
  internalIp: "172.20.0.10",
  recorderIp: "172.20.0.2",
  attackerAccounts: { subscriber: { username: "s", password: "p" } },
  exploration: {
    control: { host: "labctl", ipv4: "172.20.0.130" },
    administrator: { username: "harness-admin", password: "a" },
  },
} satisfies WordPressLabHandle;

const state = (blogname: string): WordPressLabState => ({
  schema: "wordpress-lab-state/v1",
  capturedAt: "2026-10-25T00:00:00.000Z",
  tablePrefix: "wp_",
  options: [{ name: "blogname", value: blogname, autoload: "yes" }],
  users: [],
  tables: [],
});

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("synthetic"),
]);
const exchange = JSON.stringify({
  request: {
    method: "GET",
    path: "/",
    headers: {},
    body: "",
    bodyBase64: "",
    truncated: false,
  },
  response: {
    statusCode: 200,
    headers: {},
    body: "",
    bodyBase64: "",
    truncated: false,
  },
});

async function fixture(options: {
  readonly requests: number;
  readonly maxResets: number;
  readonly resetsUsedBefore?: number;
  readonly resetSucceeds?: boolean;
  /** The first this many resets throw instead of answering. */
  readonly resetThrows?: number;
  /** The first this many answers do not reach labctl. */
  readonly answerFails?: number;
  readonly captureAvailable?: boolean;
  /** Observe bodies queued after the resets, in order. */
  readonly observe?: readonly unknown[];
  readonly maxObservations?: number;
  readonly observationsUsedBefore?: number;
  readonly observed?: Awaited<
    ReturnType<WordPressLab["observeExplorationPage"]>
  >;
  /** Find and sql bodies queued after the observes, in order (ADR 0049). */
  readonly lookups?: readonly {
    readonly command: "find" | "sql";
    readonly body: unknown;
  }[];
  readonly maxLookups?: number;
  readonly lookupsUsedBefore?: number;
  readonly found?: Awaited<ReturnType<WordPressLab["findInExplorationLab"]>>;
  readonly queried?: Awaited<ReturnType<WordPressLab["queryExplorationLab"]>>;
}) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-exploration-lab-"));
  directories.push(directory);
  const store = new PrivateArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    maxEntries: 8,
    maxBytes: 1024 * 1024,
  });
  const queue: ControlRequest[] = [
    ...Array.from({ length: options.requests }, (_, index) => ({
      id: String(index).repeat(32),
      command: "reset" as const,
      receivedAt: "2026-10-25T00:00:00.000Z",
    })),
    ...(options.observe ?? []).map((body, index) => ({
      id: "abcdef"[index]!.repeat(32),
      command: "observe" as const,
      receivedAt: "2026-10-25T00:00:00.000Z",
      body,
    })),
    ...(options.lookups ?? []).map(({ command, body }, index) => ({
      id: `${index}f`.padStart(2, "0").repeat(16),
      command,
      receivedAt: "2026-10-25T00:00:00.000Z",
      body,
    })),
  ];
  const expectedAnswers = queue.length;
  const observedRequests: unknown[] = [];
  const lookupRequests: { command: "find" | "sql"; request: string }[] = [];
  let drained!: () => void;
  const allAnswered = new Promise<void>((resolve) => (drained = resolve));
  if (queue.length === 0) drained();
  const answers: unknown[] = [];
  let resets = 0;
  let answerCalls = 0;
  const lab: Parameters<typeof openWordPressExplorationLab>[0]["lab"] = {
    async captureState() {
      return { status: "captured", state: state(`generation-${resets}`) };
    },
    async readCapture() {
      return options.captureAvailable === false
        ? { status: "unavailable" }
        : {
            status: "captured",
            ...httpCapture(Buffer.from(`${exchange}\n${exchange}\n`), 3),
          };
    },
    async reset() {
      resets++;
      if (resets <= (options.resetThrows ?? 0))
        throw new Error("secret-bearing failure /home/dev/state");
      return options.resetSucceeds ?? true;
    },
    // Like labctl, a command stays pending until its answer lands.
    async nextControlRequest() {
      return queue[0] ?? null;
    },
    async observeExplorationPage(_handle, request) {
      observedRequests.push(request);
      return (
        options.observed ?? {
          status: "observed",
          httpStatus: 200,
          dialogCount: 1,
          markerDialog: true,
          consoleErrorCount: 2,
          screenshot: PNG,
        }
      );
    },
    async findInExplorationLab(_handle, marker) {
      lookupRequests.push({ command: "find", request: marker });
      return (
        options.found ?? {
          status: "found",
          database: [
            { table: "wp_postmeta", column: "meta_value", keys: ["7", "9"] },
          ],
          files: ["wp-content/uploads/cache/a.json"],
          truncated: false,
        }
      );
    },
    async queryExplorationLab(_handle, select) {
      lookupRequests.push({ command: "sql", request: select });
      return (
        options.queried ?? {
          status: "rows",
          columns: ["option_name", "option_value"],
          rows: [["blogname", "Synthetic"]],
          truncated: false,
        }
      );
    },
    async answerControlRequest(_handle, id, answer) {
      if (++answerCalls <= (options.answerFails ?? 0)) return false;
      queue.splice(
        queue.findIndex((request) => request.id === id),
        1,
      );
      answers.push({ id, ...answer });
      if (answers.length === expectedAnswers) drained();
      return true;
    },
  } satisfies Pick<
    WordPressLab,
    | "captureState"
    | "readCapture"
    | "reset"
    | "nextControlRequest"
    | "answerControlRequest"
    | "observeExplorationPage"
    | "findInExplorationLab"
    | "queryExplorationLab"
  >;
  const trialLab = openWordPressExplorationLab({
    lab,
    handle,
    maxResets: options.maxResets,
    ...(options.resetsUsedBefore === undefined
      ? {}
      : { resetsUsedBefore: options.resetsUsedBefore }),
    maxObservations: options.maxObservations ?? 20,
    ...(options.observationsUsedBefore === undefined
      ? {}
      : { observationsUsedBefore: options.observationsUsedBefore }),
    maxLookups: options.maxLookups ?? 60,
    ...(options.lookupsUsedBefore === undefined
      ? {}
      : { lookupsUsedBefore: options.lookupsUsedBefore }),
    store,
    clock: () => new Date("2026-10-25T00:00:00.000Z"),
  });
  const readBytes = async (digest: string, name: string) => {
    const file = await store.readFile(digest, name, 1024 * 1024);
    if (file.status !== "resolved") throw new Error(file.status);
    return file.bytes;
  };
  const read = async (digest: string, name: string) =>
    (await readBytes(digest, name)).toString("utf8");
  return {
    trialLab,
    allAnswered,
    answers,
    read,
    readBytes,
    observedRequests,
    lookupRequests,
    resets: () => resets,
  };
}

describe("exploration Lab driver", () => {
  it("resets within the budget, refuses past it and seals capture and states", async () => {
    const { trialLab, allAnswered, answers, read, resets } = await fixture({
      requests: 3,
      maxResets: 2,
    });
    await trialLab.open();
    await allAnswered;
    const record = await trialLab.seal();
    expect(resets()).toBe(2);
    expect(answers).toEqual([
      {
        id: "0".repeat(32),
        statusCode: 200,
        body: { status: "reset", resetsUsed: 1, maxResets: 2 },
      },
      {
        id: "1".repeat(32),
        statusCode: 200,
        body: { status: "reset", resetsUsed: 2, maxResets: 2 },
      },
      {
        id: "2".repeat(32),
        statusCode: 429,
        body: {
          status: "refused",
          reason: "budget",
          resetsUsed: 2,
          maxResets: 2,
        },
      },
    ]);
    // Two kept exchanges plus three the recorder counted past its cap.
    expect(record).toMatchObject({
      requests: 5,
      droppedRequests: 3,
      resets: 2,
      refusedResets: 1,
    });
    const sealed = JSON.parse(
      await read(record.artifactDigest!, "exploration-lab.json"),
    );
    expect(sealed).toMatchObject({
      labId: handle.id,
      setupDigest: handle.setupDigest,
      maxResets: 2,
      capture: { status: "captured", exchanges: 2, dropped: 3 },
    });
    // One before / after pair per Lab generation: the first and one per reset.
    expect(
      sealed.generations.map(
        (generation: { state: { status: string } }) => generation.state.status,
      ),
    ).toEqual(["captured", "captured", "captured"]);
    expect(
      sealed.resetLog.map((entry: { status: string }) => entry.status),
    ).toEqual(["reset", "reset", "refused"]);
    expect(await read(record.artifactDigest!, "capture.jsonl")).toBe(
      `${exchange}\n${exchange}\n`,
    );
  });

  it("gives a resumed segment only the resets earlier segments left", async () => {
    const { trialLab, allAnswered, answers, read, resets } = await fixture({
      requests: 2,
      maxResets: 2,
      resetsUsedBefore: 1,
    });
    await trialLab.open();
    await allAnswered;
    const record = await trialLab.seal();
    expect(resets()).toBe(1);
    expect(answers).toEqual([
      {
        id: "0".repeat(32),
        statusCode: 200,
        body: { status: "reset", resetsUsed: 2, maxResets: 2 },
      },
      {
        id: "1".repeat(32),
        statusCode: 429,
        body: {
          status: "refused",
          reason: "budget",
          resetsUsed: 2,
          maxResets: 2,
        },
      },
    ]);
    // The segment's own counts; the ledger sums them across segments.
    expect(record).toMatchObject({ resets: 1, refusedResets: 1 });
    expect(
      JSON.parse(await read(record.artifactDigest!, "exploration-lab.json")),
    ).toMatchObject({ maxResets: 2, resetsUsedBefore: 1 });
  });

  it("runs typed observe requests within the budget, keeps each screenshot and seals the log (Phase D2)", async () => {
    const {
      trialLab,
      allAnswered,
      answers,
      read,
      readBytes,
      observedRequests,
    } = await fixture({
      requests: 0,
      maxResets: 2,
      maxObservations: 2,
      observationsUsedBefore: 1,
      observe: [
        { role: "subscriber", path: "/?p=1", dialogMarker: "1234567890" },
        { role: "visitor", path: "/", script: "alert(1)" },
        { role: "administrator", path: "/wp-admin/" },
      ],
    });
    await trialLab.open();
    await allAnswered;
    const record = await trialLab.seal();
    // Only the valid request reaches the observer; no free-form field passes.
    expect(observedRequests).toEqual([
      { role: "subscriber", path: "/?p=1", dialogMarker: "1234567890" },
    ]);
    expect(answers).toEqual([
      {
        id: "a".repeat(32),
        statusCode: 200,
        body: {
          status: "observed",
          httpStatus: 200,
          dialogOpened: true,
          marker: { text: "1234567890", alertOpened: true },
          consoleErrorCount: 2,
          screenshotDigest: expect.stringMatching(/^sha256:/),
          observationsUsed: 2,
          maxObservations: 2,
        },
      },
      {
        id: "b".repeat(32),
        statusCode: 400,
        body: {
          status: "refused",
          reason: "invalid-request",
          field: "script",
          observationsUsed: 2,
          maxObservations: 2,
        },
      },
      {
        id: "c".repeat(32),
        statusCode: 429,
        body: {
          status: "refused",
          reason: "budget",
          observationsUsed: 2,
          maxObservations: 2,
        },
      },
    ]);
    // Nothing in the answer says the hypothesis holds.
    expect(JSON.stringify(answers)).not.toMatch(/confirm/i);
    const screenshot = (answers[0] as { body: { screenshotDigest: string } })
      .body.screenshotDigest;
    expect(await readBytes(screenshot, "screenshot.png")).toEqual(PNG);
    expect(record).toMatchObject({
      resets: 0,
      observations: 1,
      refusedObservations: 2,
    });
    const sealed = JSON.parse(
      await read(record.artifactDigest!, "exploration-lab.json"),
    );
    expect(sealed).toMatchObject({
      maxObservations: 2,
      observationsUsedBefore: 1,
      observations: 1,
      refusedObservations: 2,
    });
    expect(
      sealed.observationLog.map(
        (entry: { status: string; reason?: string }) =>
          entry.reason ?? entry.status,
      ),
    ).toEqual(["observed", "invalid-request", "budget"]);
    expect(sealed.observationLog[0].request).toEqual({
      role: "subscriber",
      path: "/?p=1",
      dialogMarker: "1234567890",
    });
  });

  it("answers an observer failure and a missing role without a screenshot", async () => {
    const failed = await fixture({
      requests: 0,
      maxResets: 2,
      observe: [{ role: "subscriber", path: "/" }],
      observed: { status: "failed", failureCode: "victim-login" },
    });
    await failed.trialLab.open();
    await failed.allAnswered;
    expect(await failed.trialLab.seal()).toMatchObject({
      observations: 1,
      refusedObservations: 0,
    });
    expect(failed.answers).toEqual([
      {
        id: "a".repeat(32),
        statusCode: 502,
        body: {
          status: "failed",
          failureCode: "victim-login",
          observationsUsed: 1,
          maxObservations: 20,
        },
      },
    ]);
    const missing = await fixture({
      requests: 0,
      maxResets: 2,
      observe: [{ role: "customer", path: "/" }],
      observed: { status: "role-unavailable" },
    });
    await missing.trialLab.open();
    await missing.allAnswered;
    expect(await missing.trialLab.seal()).toMatchObject({
      observations: 0,
      refusedObservations: 1,
    });
    expect(missing.answers).toMatchObject([
      {
        statusCode: 400,
        body: { status: "refused", reason: "role-unavailable" },
      },
    ]);
  });

  it("names the field an invalid observe request failed on, never its value", async () => {
    const { trialLab, allAnswered, answers, observedRequests } = await fixture({
      requests: 0,
      maxResets: 2,
      observe: [
        "not an object",
        { role: "subscriber", path: "//evil.example/" },
        {
          role: "subscriber",
          path: "/",
          actions: [{ kind: "fill", selector: "#q", value: "v".repeat(121) }],
        },
        {
          role: "subscriber",
          path: "/",
          actions: [{ kind: "click", selector: "a{color:red}" }],
        },
        {
          role: "subscriber",
          path: "/",
          actions: [{ kind: "click-text", text: "Go", exact: "yes" }],
        },
        { role: "subscriber", path: "/", dialogMarker: "0123456789" },
      ],
    });
    await trialLab.open();
    await allAnswered;
    await trialLab.seal();
    expect(observedRequests).toEqual([]);
    expect(
      answers.map(
        (entry) => (entry as { body: { field?: string } }).body.field,
      ),
    ).toEqual([
      "body",
      "path",
      "actions.0.value",
      "actions.0.selector",
      "actions.0.exact",
      "dialogMarker",
    ]);
    const text = JSON.stringify(answers);
    for (const value of [
      "evil.example",
      "v".repeat(121),
      "color:red",
      "0123456789",
    ])
      expect(text).not.toContain(value);
  });

  it("answers an observe request the Harness threw on as failed and counts it", async () => {
    const { trialLab, allAnswered, answers, read } = await fixture({
      requests: 0,
      maxResets: 2,
      observe: [{ role: "subscriber", path: "/" }],
      // An observer result that throws when read makes the driver throw mid-command.
      observed: Object.defineProperty({}, "status", {
        get() {
          throw new Error("secret-bearing failure");
        },
      }) as never,
    });
    await trialLab.open();
    await allAnswered;
    const record = await trialLab.seal();
    expect(answers).toEqual([
      {
        id: "a".repeat(32),
        statusCode: 500,
        body: {
          status: "failed",
          reason: "harness-error",
          observationsUsed: 1,
          maxObservations: 20,
        },
      },
    ]);
    expect(record).toMatchObject({ observations: 1, refusedObservations: 0 });
    expect(
      JSON.parse(await read(record.artifactDigest!, "exploration-lab.json"))
        .observationLog,
    ).toMatchObject([{ status: "failed", reason: "harness-error" }]);
    expect(JSON.stringify(answers)).not.toContain("secret-bearing");
  });

  it("refuses every later reset once one failed, and still seals", async () => {
    const { trialLab, allAnswered, answers } = await fixture({
      requests: 2,
      maxResets: 2,
      resetSucceeds: false,
    });
    await trialLab.open();
    await allAnswered;
    const record = await trialLab.seal();
    expect(answers).toMatchObject([
      { statusCode: 503, body: { status: "failed", resetsUsed: 1 } },
      {
        statusCode: 503,
        body: { status: "refused", reason: "unavailable", resetsUsed: 1 },
      },
    ]);
    expect(record).toMatchObject({ resets: 1, refusedResets: 1 });
    expect(record.artifactDigest).toMatch(/^sha256:/);
  });

  it("answers a command the Harness threw on as failed, counts it and keeps serving", async () => {
    const { trialLab, allAnswered, answers, read, resets } = await fixture({
      requests: 2,
      maxResets: 2,
      resetThrows: 1,
    });
    await trialLab.open();
    await allAnswered;
    const record = await trialLab.seal();
    expect(resets()).toBe(2);
    // A fixed reason only: nothing of the error's message reaches the agent.
    expect(answers).toEqual([
      {
        id: "0".repeat(32),
        statusCode: 500,
        body: {
          status: "failed",
          reason: "harness-error",
          resetsUsed: 1,
          maxResets: 2,
        },
      },
      {
        id: "1".repeat(32),
        statusCode: 200,
        body: { status: "reset", resetsUsed: 2, maxResets: 2 },
      },
    ]);
    expect(record).toMatchObject({ resets: 2, refusedResets: 0 });
    const sealed = JSON.parse(
      await read(record.artifactDigest!, "exploration-lab.json"),
    );
    expect(sealed.resetLog).toMatchObject([
      { status: "failed", reason: "harness-error" },
      { status: "reset" },
    ]);
    expect(JSON.stringify(sealed)).not.toContain("secret-bearing");
    // The generation the throw interrupted has no trusted before state.
    expect(
      sealed.generations.map(
        (generation: { state: { status: string } }) => generation.state.status,
      ),
    ).toEqual(["captured", "missing", "captured"]);
  });

  it("retries an answer once, counts it dropped, and hands labctl the same answer when it asks again", async () => {
    const { trialLab, allAnswered, answers, read, resets } = await fixture({
      requests: 1,
      maxResets: 2,
      answerFails: 2,
    });
    await trialLab.open();
    await allAnswered;
    const record = await trialLab.seal();
    // The command ran once; the kept answer was delivered on labctl's next ask.
    expect(resets()).toBe(1);
    expect(answers).toEqual([
      {
        id: "0".repeat(32),
        statusCode: 200,
        body: { status: "reset", resetsUsed: 1, maxResets: 2 },
      },
    ]);
    expect(record).toMatchObject({ resets: 1, droppedAnswers: 1 });
    expect(
      JSON.parse(await read(record.artifactDigest!, "exploration-lab.json"))
        .resetLog,
    ).toMatchObject([{ status: "reset", answerDropped: true }]);
  });

  it("answers find and sql within one shared lookup budget and seals the log (ADR 0049)", async () => {
    const { trialLab, allAnswered, answers, read, lookupRequests } =
      await fixture({
        requests: 0,
        maxResets: 2,
        maxLookups: 3,
        lookupsUsedBefore: 1,
        lookups: [
          { command: "find", body: { marker: "1234567890" } },
          {
            command: "sql",
            body: { select: "SELECT option_name FROM wp_options" },
          },
          { command: "find", body: { marker: "9876543210" } },
          { command: "sql", body: { select: "SELECT 1 FROM wp_users" } },
        ],
      });
    await trialLab.open();
    await allAnswered;
    const record = await trialLab.seal();
    // The two budgeted lookups reached the Lab; the third of each kind was refused.
    expect(lookupRequests).toEqual([
      { command: "find", request: "1234567890" },
      { command: "sql", request: "SELECT option_name FROM wp_options" },
    ]);
    expect(answers.map((entry) => (entry as { body: unknown }).body)).toEqual([
      {
        status: "answered",
        marker: "1234567890",
        database: [
          { table: "wp_postmeta", column: "meta_value", keys: ["7", "9"] },
        ],
        files: ["wp-content/uploads/cache/a.json"],
        truncated: false,
        lookupsUsed: 2,
        maxLookups: 3,
      },
      {
        status: "answered",
        columns: ["option_name", "option_value"],
        rows: [["blogname", "Synthetic"]],
        truncated: false,
        lookupsUsed: 3,
        maxLookups: 3,
      },
      { status: "refused", reason: "budget", lookupsUsed: 3, maxLookups: 3 },
      { status: "refused", reason: "budget", lookupsUsed: 3, maxLookups: 3 },
    ]);
    expect(
      answers.map((entry) => (entry as { statusCode: number }).statusCode),
    ).toEqual([200, 200, 429, 429]);
    // Nothing in the answer says the hypothesis holds.
    expect(JSON.stringify(answers)).not.toMatch(/confirm/i);
    expect(record).toMatchObject({
      observations: 0,
      lookups: 2,
      refusedLookups: 2,
    });
    const sealed = JSON.parse(
      await read(record.artifactDigest!, "exploration-lab.json"),
    );
    expect(sealed).toMatchObject({
      maxLookups: 3,
      lookupsUsedBefore: 1,
      lookups: 2,
      refusedLookups: 2,
    });
    expect(
      sealed.lookupLog.map(
        (entry: { command: string; status: string; reason?: string }) =>
          `${entry.command}:${entry.reason ?? entry.status}`,
      ),
    ).toEqual(["find:answered", "sql:answered", "find:budget", "sql:budget"]);
    expect(sealed.lookupLog[0]).toMatchObject({
      command: "find",
      request: "1234567890",
      requestedAt: "2026-10-25T00:00:00.000Z",
      answeredAt: "2026-10-25T00:00:00.000Z",
    });
    expect(sealed.lookupLog[1].request).toBe(
      "SELECT option_name FROM wp_options",
    );
  });

  it("refuses a lookup that is not a single SELECT or does not fit, naming the field, and passes the database's refusal on", async () => {
    const { trialLab, allAnswered, answers, lookupRequests } = await fixture({
      requests: 0,
      maxResets: 2,
      lookups: [
        { command: "find", body: { marker: "0123456789" } },
        { command: "find", body: "not an object" },
        { command: "sql", body: { select: "DELETE FROM wp_users" } },
        { command: "sql", body: { select: "SELECT 1; DROP TABLE wp_users" } },
        { command: "sql", body: { select: "SELECT 1", extra: true } },
        { command: "sql", body: { select: "SELECT * FROM nowhere" } },
      ],
      queried: {
        status: "refused",
        reason: "sql-error",
        message: "Table 'wordpress.nowhere' doesn't exist",
      },
    });
    await trialLab.open();
    await allAnswered;
    const record = await trialLab.seal();
    // Only the well-formed SELECT reaches the Lab; the shape check runs before it.
    expect(lookupRequests).toEqual([
      { command: "sql", request: "SELECT * FROM nowhere" },
    ]);
    expect(answers.map((entry) => (entry as { body: unknown }).body)).toEqual([
      {
        status: "refused",
        reason: "invalid-request",
        field: "marker",
        lookupsUsed: 0,
        maxLookups: 60,
      },
      {
        status: "refused",
        reason: "invalid-request",
        field: "body",
        lookupsUsed: 0,
        maxLookups: 60,
      },
      {
        status: "refused",
        reason: "invalid-request",
        field: "select",
        lookupsUsed: 0,
        maxLookups: 60,
      },
      {
        status: "refused",
        reason: "invalid-request",
        field: "select",
        lookupsUsed: 0,
        maxLookups: 60,
      },
      {
        status: "refused",
        reason: "invalid-request",
        field: "extra",
        lookupsUsed: 0,
        maxLookups: 60,
      },
      {
        status: "refused",
        reason: "sql-error",
        message: "Table 'wordpress.nowhere' doesn't exist",
        lookupsUsed: 0,
        maxLookups: 60,
      },
    ]);
    // A refused lookup names the field, never the value it carried.
    expect(JSON.stringify(answers)).not.toContain("0123456789");
    expect(JSON.stringify(answers)).not.toContain("DELETE");
    expect(record).toMatchObject({ lookups: 0, refusedLookups: 6 });
  });

  it("answers a failed find, an unavailable Lab and a Harness throw on a lookup, counting each", async () => {
    const failed = await fixture({
      requests: 0,
      maxResets: 2,
      lookups: [{ command: "find", body: { marker: "1234567890" } }],
      found: { status: "failed" },
    });
    await failed.trialLab.open();
    await failed.allAnswered;
    expect(await failed.trialLab.seal()).toMatchObject({
      lookups: 1,
      refusedLookups: 0,
    });
    expect(failed.answers).toEqual([
      {
        id: "0f".repeat(16),
        statusCode: 502,
        body: { status: "failed", lookupsUsed: 1, maxLookups: 60 },
      },
    ]);
    const unavailable = await fixture({
      requests: 0,
      maxResets: 2,
      lookups: [{ command: "sql", body: { select: "SELECT 1" } }],
      queried: { status: "unavailable" },
    });
    await unavailable.trialLab.open();
    await unavailable.allAnswered;
    expect(await unavailable.trialLab.seal()).toMatchObject({
      lookups: 0,
      refusedLookups: 1,
    });
    expect(unavailable.answers).toMatchObject([
      { statusCode: 503, body: { status: "refused", reason: "unavailable" } },
    ]);
    const thrown = await fixture({
      requests: 0,
      maxResets: 2,
      lookups: [{ command: "sql", body: { select: "SELECT 1" } }],
      queried: Object.defineProperty({}, "status", {
        get() {
          throw new Error("secret-bearing failure");
        },
      }) as never,
    });
    await thrown.trialLab.open();
    await thrown.allAnswered;
    const record = await thrown.trialLab.seal();
    expect(thrown.answers).toEqual([
      {
        id: "0f".repeat(16),
        statusCode: 500,
        body: {
          status: "failed",
          reason: "harness-error",
          lookupsUsed: 1,
          maxLookups: 60,
        },
      },
    ]);
    expect(record).toMatchObject({ lookups: 1, refusedLookups: 0 });
    expect(
      JSON.parse(
        await thrown.read(record.artifactDigest!, "exploration-lab.json"),
      ).lookupLog,
    ).toMatchObject([
      { command: "sql", status: "failed", reason: "harness-error" },
    ]);
    expect(JSON.stringify(thrown.answers)).not.toContain("secret-bearing");
  });

  it("records zero requests when the capture cannot be read", async () => {
    const { trialLab, read } = await fixture({
      requests: 0,
      maxResets: 2,
      captureAvailable: false,
    });
    await trialLab.open();
    const record = await trialLab.seal();
    expect(record).toMatchObject({
      requests: 0,
      droppedRequests: 0,
      resets: 0,
      refusedResets: 0,
      droppedAnswers: 0,
    });
    expect(
      JSON.parse(await read(record.artifactDigest!, "exploration-lab.json"))
        .capture,
    ).toEqual({ status: "unavailable" });
    await expect(read(record.artifactDigest!, "capture.jsonl")).rejects.toThrow(
      "missing",
    );
  });
});
