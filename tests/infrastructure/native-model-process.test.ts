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
});
