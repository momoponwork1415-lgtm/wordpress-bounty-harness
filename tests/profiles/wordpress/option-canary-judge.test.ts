import { describe, expect, it } from "vitest";

import type { WordPressOptionsObservation } from "../../../src/profiles/wordpress/lab/index.js";
import { canaries, judgeOnce, quietLab, route } from "./judge-fixture.js";

function judge(options: WordPressOptionsObservation) {
  return judgeOnce({
    impact: "options-update",
    lab: quietLab({
      async observeOptions() {
        return options;
      },
    }),
    files: {
      "route.json": JSON.stringify(route),
      "http.json": JSON.stringify({
        exchanges: [
          {
            request: { method: "POST", path: "/synthetic" },
            response: { status: 200, body: "saved" },
          },
        ],
      }),
      "notes.md": "The Verifier reports that default_role changed.\n",
    },
  });
}

describe("WordPress option canary judge", () => {
  it("observes a critical option that changed from the seeded baseline", async () => {
    const { judgeId, observed } = await judge({
      status: "observed",
      changed: ["users_can_register", "default_role"],
    });
    expect(judgeId).toBe("wordpress-option-canary");
    expect(observed).toEqual({
      status: "observed",
      evidenceDigest: expect.stringMatching(/^sha256:/),
      conditions: {
        observedVia: "option-change",
        changedOptions: "users_can_register,default_role",
        optionClass: "critical",
        attackerRole: "subscriber",
        defaultSettings: "true",
      },
    });
  });

  it("observes the canary option alone as an arbitrary option update", async () => {
    const { observed } = await judge({
      status: "observed",
      changed: [canaries.option],
    });
    expect(observed).toMatchObject({
      status: "observed",
      conditions: { changedOptions: canaries.option, optionClass: "canary" },
    });
  });

  it("does not fire when no watched option changed, whatever the Verifier says", async () => {
    expect((await judge({ status: "observed", changed: [] })).observed).toEqual(
      { status: "not-observed" },
    );
  });

  it("stays incomplete when the Lab cannot read its options", async () => {
    expect((await judge({ status: "unavailable" })).observed).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });
});
