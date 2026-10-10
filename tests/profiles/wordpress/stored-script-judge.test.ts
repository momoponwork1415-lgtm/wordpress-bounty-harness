import { describe, expect, it } from "vitest";

import type {
  WordPressStoredScriptObservation,
  WordPressVictimRoute,
} from "../../../src/profiles/wordpress/lab/index.js";
import { judgeOnce, quietLab, route } from "./judge-fixture.js";

const browserRoute = {
  ...route,
  steps: [
    ...route.steps,
    { kind: "browser", path: "/?p=7", expected: "Beacon reaches the receiver" },
  ],
};

async function judge(
  observation: WordPressStoredScriptObservation,
  victim?: WordPressVictimRoute,
) {
  const visited: (readonly string[])[] = [];
  const victims: (WordPressVictimRoute | undefined)[] = [];
  const result = await judgeOnce({
    impact: "stored-xss",
    lab: quietLab({
      async observeStoredScript(_lab, input) {
        visited.push(input.routePaths);
        victims.push(input.victim);
        return observation;
      },
    }),
    files: {
      "route.json": JSON.stringify({ ...browserRoute, victim }),
      "http.json": JSON.stringify({
        exchanges: [
          {
            request: { method: "POST", path: "/synthetic" },
            response: { status: 200, body: "saved" },
          },
        ],
      }),
      "notes.md": "The Verifier saw an alert box.\n",
    },
  });
  return { ...result, visited, victims };
}

describe("WordPress stored script judge", () => {
  it("confirms a beacon from the front page or every admin screen and records the contexts", async () => {
    const { judgeId, observed, visited } = await judge({
      status: "observed",
      contexts: ["front", "admin-all"],
    });
    expect(judgeId).toBe("wordpress-stored-script");
    expect(visited).toEqual([["/?p=7"]]);
    expect(observed).toEqual({
      status: "observed",
      evidenceDigest: expect.stringMatching(/^sha256:/),
      evidenceCapture: "agent-authored",
      conditions: {
        observedVia: "canary-beacon",
        firedContexts: "front,admin-all",
        siteWide: "yes",
        attackerRole: "subscriber",
        defaultSettings: "true",
      },
    });
  });

  it("confirms a beacon from an affected page and records limited scope", async () => {
    for (const contexts of [["route-page"], ["admin-partial"]] as const) {
      const { observed } = await judge({ status: "observed", contexts });
      expect(observed).toMatchObject({
        status: "observed",
        conditions: {
          observedVia: "canary-beacon",
          firedContexts: contexts[0],
          siteWide: "no",
        },
      });
    }
  });

  it("records a victim-role screen separately from site-wide firing", async () => {
    const victim = {
      role: "administrator" as const,
      paths: ["/wp-admin/admin.php?page=fixture"],
    };
    const { observed, victims } = await judge(
      { status: "observed", contexts: ["victim-route-page"] },
      victim,
    );
    expect(victims).toEqual([victim]);
    expect(observed).toMatchObject({
      status: "observed",
      conditions: {
        firedContexts: "victim-route-page",
        victimRole: "administrator",
        siteWide: "no",
      },
    });
  });

  it("requires a Lab account for a declared customer victim", async () => {
    const { observed } = await judge(
      { status: "observed", contexts: ["victim-route-page"] },
      { role: "customer", paths: ["/account"] },
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
  });

  it("does not fire when no beacon arrived, whatever the Verifier saw", async () => {
    expect(
      (await judge({ status: "observed", contexts: [] })).observed,
    ).toEqual({ status: "not-observed" });
  });

  it("stays incomplete without an issued script canary or a working observer", async () => {
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
