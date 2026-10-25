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
}) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-exploration-lab-"));
  directories.push(directory);
  const store = new PrivateArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    maxEntries: 8,
    maxBytes: 1024 * 1024,
  });
  const queue: ControlRequest[] = Array.from(
    { length: options.requests },
    (_, index) => ({
      id: String(index).repeat(32),
      command: "reset",
      receivedAt: "2026-10-25T00:00:00.000Z",
    }),
  );
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
    async answerControlRequest(_handle, id, answer) {
      if (++answerCalls <= (options.answerFails ?? 0)) return false;
      queue.splice(
        queue.findIndex((request) => request.id === id),
        1,
      );
      answers.push({ id, ...answer });
      if (answers.length === options.requests) drained();
      return true;
    },
  } satisfies Pick<
    WordPressLab,
    | "captureState"
    | "readCapture"
    | "reset"
    | "nextControlRequest"
    | "answerControlRequest"
  >;
  const trialLab = openWordPressExplorationLab({
    lab,
    handle,
    maxResets: options.maxResets,
    ...(options.resetsUsedBefore === undefined
      ? {}
      : { resetsUsedBefore: options.resetsUsedBefore }),
    store,
    clock: () => new Date("2026-10-25T00:00:00.000Z"),
  });
  const read = async (digest: string, name: string) => {
    const file = await store.readFile(digest, name, 1024 * 1024);
    if (file.status !== "resolved") throw new Error(file.status);
    return file.bytes.toString("utf8");
  };
  return {
    trialLab,
    allAnswered,
    answers,
    read,
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
