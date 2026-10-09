import { describe, expect, it } from "vitest";

import type { WordPressExecutionObservation } from "../../../src/profiles/wordpress/lab/index.js";
import { judgeOnce, quietLab, route } from "./judge-fixture.js";

const files = {
  "route.json": JSON.stringify(route),
  "http.json": JSON.stringify({
    exchanges: [
      {
        request: { method: "POST", path: "/synthetic" },
        response: { status: 200, body: "stored" },
      },
    ],
  }),
  "notes.md": "The Verifier reports that the code ran.\n",
};

function judge(
  execution: WordPressExecutionObservation,
  impact: "rce" | "php-file-write" = "rce",
) {
  return judgeOnce({
    impact,
    files,
    lab: quietLab({
      async observeExecution() {
        return execution;
      },
    }),
  });
}

describe("WordPress Execution Canary judge", () => {
  it("observes the salted marker and records where the canary sits on disk", async () => {
    for (const impact of ["rce", "php-file-write"] as const) {
      const { judgeId, observed, store } = await judge(
        { status: "executed", files: ["wp-content/uploads/synthetic.php"] },
        impact,
      );
      expect(judgeId).toBe("wordpress-execution-canary");
      expect(observed).toEqual({
        status: "observed",
        evidenceDigest: expect.stringMatching(/^sha256:/),
        evidenceCapture: "agent-authored",
        conditions: {
          observedVia: "execution-canary",
          canaryFiles: "wp-content/uploads/synthetic.php",
          attackerRole: "subscriber",
          defaultSettings: "true",
        },
      });
      if (observed?.status !== "observed") continue;
      const record = await store.readFile(
        observed.evidenceDigest,
        "canary-observation.json",
        10_000,
      );
      expect(record.status).toBe("resolved");
    }
  });

  it("records code that ran without leaving a file on disk", async () => {
    const { observed } = await judge({ status: "executed", files: [] });
    expect(observed).toMatchObject({
      status: "observed",
      conditions: { canaryFiles: "none-on-disk" },
    });
  });

  it("does not fire when the canary was stored but never ran", async () => {
    // A `.php.png`, SVG or safe-extension upload leaves no salted marker.
    expect((await judge({ status: "not-executed" })).observed).toEqual({
      status: "not-observed",
    });
  });

  it("stays incomplete without an issued canary or a readable Lab", async () => {
    expect((await judge({ status: "not-prepared" })).observed).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    expect((await judge({ status: "unavailable" })).observed).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });
});
