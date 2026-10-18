import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { runNativeModelProcess } from "../../src/infrastructure/native-model-process.js";

describe("Native Model Process", () => {
  it("retains bounded stdout when a process times out", async () => {
    const result = await runNativeModelProcess({
      executablePath: "/bin/sh",
      args: [
        "-c",
        "printf 'partial-thread-event\\n'; while :; do sleep 1; done",
      ],
      workingDirectory: tmpdir(),
      environment: process.env,
      timeoutMs: 100,
      maxOutputBytes: 64 * 1024,
    });

    expect(result).toMatchObject({
      kind: "timed-out",
      stdout: "partial-thread-event\n",
    });
  });

  it("reaps an attached client on operator cancellation", async () => {
    const controller = new AbortController();
    const startedAt = performance.now();
    const running = runNativeModelProcess({
      executablePath: "/bin/sh",
      args: ["-c", "trap '' TERM; while :; do sleep 1; done"],
      workingDirectory: tmpdir(),
      environment: process.env,
      timeoutMs: 60_000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("operator"), 20);
    await expect(running).resolves.toMatchObject({ kind: "cancelled" });
    expect((performance.now() - startedAt) / 1000).toBeLessThan(3);
  });
});
