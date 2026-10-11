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
const observerBytes = Buffer.from("synthetic observer output");

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
      screenshot: observerBytes,
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
      const { observed } = await judge({
        status: "observed",
        contexts,
        screenshot: observerBytes,
      });
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
      {
        status: "observed",
        contexts: ["victim-route-page"],
        victimRole: "administrator",
        screenshot: observerBytes,
      },
      victim,
    );
    expect(victims).toEqual([victim]);
    expect(observed).toMatchObject({
      status: "observed",
      conditions: {
        firedContexts: "victim-route-page",
        victimRole: "administrator",
        victimPrincipal: "separate",
        siteWide: "no",
      },
    });
  });

  it("does not confirm a script observed in the attacker's own account", async () => {
    const { observed, store } = await judge(
      {
        status: "observed",
        contexts: ["victim-route-page"],
        victimRole: "self",
        screenshot: observerBytes,
      },
      { role: "subscriber", paths: ["/account"] },
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "precondition",
      nextStep: expect.stringContaining("victimRole: self"),
      evidenceDigest: expect.stringMatching(/^sha256:/),
    });
    if (observed?.status !== "incomplete" || !observed.evidenceDigest)
      throw new Error("Expected private self-observation evidence");
    const evidence = await store.readFile(
      observed.evidenceDigest,
      "canary-observation.json",
      1024 * 1024,
    );
    expect(evidence.status).toBe("resolved");
    if (evidence.status === "resolved")
      expect(JSON.parse(evidence.bytes.toString("utf8"))).toMatchObject({
        status: "self-observed",
        victimRole: "self",
      });
  });

  it("keeps a separate front-page observation when a self page also fires", async () => {
    const { observed } = await judge(
      {
        status: "observed",
        contexts: ["front", "victim-route-page"],
        victimRole: "self",
        screenshot: observerBytes,
      },
      { role: "subscriber", paths: ["/account"] },
    );
    expect(observed).toMatchObject({
      status: "observed",
      conditions: {
        firedContexts: "front",
        siteWide: "yes",
      },
    });
    if (observed?.status === "observed")
      expect(observed.conditions.victimRole).toBeUndefined();
  });

  it("requires the Lab to identify the victim principal", async () => {
    const { observed } = await judge(
      {
        status: "observed",
        contexts: ["victim-route-page"],
        screenshot: observerBytes,
      },
      { role: "administrator", paths: ["/wp-admin/"] },
    );
    expect(observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
    });
  });

  it("requires a Lab account for a declared customer victim", async () => {
    const { observed } = await judge(
      {
        status: "observed",
        contexts: ["victim-route-page"],
        screenshot: observerBytes,
      },
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

  it("keeps a fired beacon incomplete when the Lab screenshot is missing", async () => {
    expect(
      (await judge({ status: "observed", contexts: ["front"] })).observed,
    ).toMatchObject({ status: "incomplete", reason: "evidence" });
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
