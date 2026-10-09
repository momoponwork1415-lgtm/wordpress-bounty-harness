import { describe, expect, it } from "vitest";

import type { WordPressCanaryTableObservation } from "../../../src/profiles/wordpress/lab/index.js";
import { canaries, judgeOnce, quietLab, route } from "./judge-fixture.js";

const rowValue = canaries.sqlCanary.value;
const exchange = (request: string, response: string) => ({
  request: { method: "GET", path: `/synthetic?q=${request}` },
  response: { status: 200, body: response },
});

function observe(options: {
  readonly table?: WordPressCanaryTableObservation["status"];
  readonly http?: unknown;
  readonly seeded?: boolean;
}) {
  return judgeOnce({
    impact: "sqli",
    lab: quietLab({
      canaryLedger: () => (options.seeded === false ? null : canaries),
      async observeCanaryTable() {
        return { status: options.table ?? "intact" };
      },
    }),
    files: {
      "route.json": JSON.stringify(route),
      "http.json": JSON.stringify(
        options.http ?? { exchanges: [exchange("1", "nothing")] },
      ),
      "notes.md": `The Verifier reports that ${rowValue} was read.\n`,
    },
  });
}

describe("WordPress SQL canary judge", () => {
  it("observes the canary row value in a response that no request carried", async () => {
    const { judgeId, observed, store } = await observe({
      http: {
        exchanges: [
          exchange("1", "unrelated"),
          exchange("2", `<td>${rowValue}</td>`),
        ],
      },
    });
    expect(judgeId).toBe("wordpress-sql-canary");
    expect(observed).toEqual({
      status: "observed",
      evidenceDigest: expect.stringMatching(/^sha256:/),
      evidenceCapture: "agent-authored",
      conditions: {
        observedVia: "canary-row-read",
        attackerRole: "subscriber",
        defaultSettings: "true",
        magicQuotes: "wordpress-default",
      },
    });
    if (observed?.status !== "observed") return;
    for (const name of [
      "confirmed-route.json",
      "http.json",
      "canary-observation.json",
    ])
      expect(
        (await store.readFile(observed.evidenceDigest, name, 100_000)).status,
      ).toBe("resolved");
  });

  it("observes a write to the canary table inside the Lab", async () => {
    const { observed } = await observe({ table: "changed" });
    expect(observed).toMatchObject({
      status: "observed",
      conditions: { observedVia: "canary-table-write" },
    });
  });

  it.each([
    [
      "the value only reflected from a request",
      { exchanges: [exchange(rowValue, `echo ${rowValue}`)] },
    ],
    [
      "the public canary nonce instead of the row value",
      { exchanges: [exchange("1", canaries.nonce)] },
    ],
    [
      "a slow response without the row value",
      {
        exchanges: [
          { ...exchange("1", "same page"), elapsedMs: 10_000 },
          { ...exchange("2", "same page"), elapsedMs: 5 },
        ],
      },
    ],
  ])("does not fire on %s", async (_label, http) => {
    const { observed } = await observe({ http });
    expect(observed).toEqual({ status: "not-observed" });
  });

  it("stays incomplete when the Lab or the HTTP record cannot be read", async () => {
    expect((await observe({ seeded: false })).observed).toMatchObject({
      status: "incomplete",
      reason: "precondition",
    });
    expect((await observe({ table: "unavailable" })).observed).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
    expect((await observe({ http: [{ status: 200 }] })).observed).toMatchObject(
      { status: "incomplete", reason: "evidence" },
    );
  });
});
