import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("review Lab foreground signals", () => {
  it("remembers an interrupt during launch and closes the returned session", async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    let finishLaunch!: (
      session: typeof sessionFields & { close(): Promise<void> },
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
    const running = runForegroundReviewLab(
      () => launch,
      { stdout: (line) => lines.push(line), stderr: () => undefined },
      signals,
      async () => {
        throw new Error("An interrupted launch must not mint a receipt");
      },
    );
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);

    signals.emit("SIGINT");
    finishLaunch({
      ...sessionFields,
      close() {
        closeStarted();
        return closing;
      },
    });
    await closeCalled;
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

  it("does not start waiting when an interrupt arrives while presenting the session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const signals = new EventEmitter();
    const lines: string[] = [];
    let closes = 0;
    await runForegroundReviewLab(
      async () => ({
        ...sessionFields,
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
    expect(vi.getTimerCount()).toBe(0);
    expect(closes).toBe(1);
    expect(lines.at(-1)).toBe("review Lab removed");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "keeps the process alive after presenting until %s, then closes the session once",
    async (signal) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const signals = new EventEmitter();
      const lines: string[] = [];
      let closes = 0;
      let presented!: () => void;
      const ready = new Promise<void>((resolve) => {
        presented = resolve;
      });
      const running = runForegroundReviewLab(
        async () => ({
          ...sessionFields,
          async close() {
            closes += 1;
          },
        }),
        {
          stdout(line) {
            lines.push(line);
            if (line.startsWith("Run the private")) presented();
          },
          stderr: () => undefined,
        },
        signals,
      );
      await ready;
      await Promise.resolve();
      // The keep-alive interval is the only timer; it exists only while waiting.
      expect(vi.getTimerCount()).toBe(1);
      expect(closes).toBe(0);

      signals.emit(signal);
      signals.emit(signal);
      await running;
      expect(vi.getTimerCount()).toBe(0);
      expect(closes).toBe(1);
      expect(lines.at(-1)).toBe("review Lab removed");
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    },
  );

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

  it("closes the ready Lab when sealing its session receipt fails", async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    let closes = 0;
    await expect(
      runForegroundReviewLab(
        async () => ({
          ...sessionFields,
          async close() {
            closes += 1;
          },
        }),
        { stdout: (line) => lines.push(line), stderr: () => undefined },
        signals,
        async () => {
          throw new Error("receipt store failed");
        },
      ),
    ).rejects.toThrow("receipt store failed");
    expect(closes).toBe(1);
    expect(lines).toEqual([]);
  });
});
