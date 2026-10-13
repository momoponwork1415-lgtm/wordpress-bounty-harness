import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { runForegroundReviewLab } from "../../src/cli/index.js";

const sessionFields = {
  endpoint: "http://wordpress",
  networkName: "review-net",
  recorderIp: "172.20.0.2",
  receiverIp: "172.20.0.5",
  attackerAccounts: {},
  administrator: {},
  canaries: {},
  browserImage: "browser@test",
};

describe("review Lab startup signals", () => {
  it("remembers an interrupt during launch and closes the returned session", async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    let finishLaunch!: (
      session: typeof sessionFields & {
        wait(): Promise<void>;
        close(): Promise<void>;
      },
    ) => void;
    const launch = new Promise<Parameters<typeof finishLaunch>[0]>(
      (resolve) => {
        finishLaunch = resolve;
      },
    );
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    let closeStarted!: () => void;
    const closeCalled = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    let waits = 0;
    const running = runForegroundReviewLab(
      () => launch,
      { stdout: (line) => lines.push(line), stderr: () => undefined },
      signals,
    );
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);

    signals.emit("SIGINT");
    finishLaunch({
      ...sessionFields,
      async wait() {
        waits += 1;
      },
      close() {
        closeStarted();
        return closing;
      },
    });
    await closeCalled;
    expect(waits).toBe(0);
    expect(lines).toEqual([]);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);

    signals.emit("SIGTERM");
    finishClose();
    await running;
    expect(lines).toEqual(["review Lab removed"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not enter wait when an interrupt arrives while presenting the session", async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    let waits = 0;
    let closes = 0;
    await runForegroundReviewLab(
      async () => ({
        ...sessionFields,
        async wait() {
          waits += 1;
        },
        async close() {
          closes += 1;
        },
      }),
      {
        stdout(line) {
          lines.push(line);
          if (line.startsWith("review Lab ready")) signals.emit("SIGTERM");
        },
        stderr: () => undefined,
      },
      signals,
    );
    expect(waits).toBe(0);
    expect(closes).toBe(1);
    expect(lines.at(-1)).toBe("review Lab removed");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("removes the temporary signal handlers when launch fails", async () => {
    const signals = new EventEmitter();
    await expect(
      runForegroundReviewLab(
        async () => {
          throw new Error("startup failed");
        },
        { stdout: () => undefined, stderr: () => undefined },
        signals,
      ),
    ).rejects.toThrow("startup failed");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
