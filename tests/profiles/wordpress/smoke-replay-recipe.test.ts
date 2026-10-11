import { describe, expect, it } from "vitest";

import {
  bindSmokeReferenceRoute,
  createSmokeReplayRecipe,
  extractReplayBinding,
  replayInputFor,
} from "../../../src/profiles/wordpress/verification/smoke-replay-recipe.js";

const sourceUser = "wbh-canary-admin-source";
const comparisonUser = "wbh-canary-admin-comparison";
const thirdUser = "wbh-canary-admin-third";
const sourceKey = "01234567890123456789";
const comparisonKey = "98765432109876543210";
const thirdKey = "13579246801357924680";
const sourceSecurity = "ABCDEFGHIJ";
const comparisonSecurity = "KLMNOPQRST";
const thirdSecurity = "UVWXYZ1234";

function route(user: string, key: string) {
  return {
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    steps: [
      { kind: "http", method: "GET", path: "/first" },
      { kind: "http", method: "POST", path: "/second" },
      { kind: "http", method: "POST", path: "/third" },
      { kind: "http", method: "GET", path: `/fourth?user=${user}&key=${key}` },
      { kind: "http", method: "GET", path: "/fifth" },
      { kind: "http", method: "POST", path: "/sixth" },
      { kind: "http", method: "POST", path: "/seventh" },
      { kind: "http", method: "GET", path: "/eighth" },
    ],
  };
}

function exchange(
  method: string,
  path: string,
  body: string,
  response: string,
) {
  return {
    request: { method, path, headers: {}, body, truncated: false },
    response: {
      statusCode: 200,
      headers: {},
      body: response,
      truncated: false,
    },
  };
}

function capture(
  user: string,
  key: string,
  security: string,
  lateReset = false,
) {
  const rows = [
    exchange(
      "GET",
      "/first",
      "",
      `prefix-security-${security}-security-suffix`,
    ),
    exchange("POST", "/second", `user=${user}`, "ok"),
    exchange(
      "POST",
      "/third",
      `security=${security}`,
      lateReset ? "pending" : `prefix-reset-${key}-reset-suffix`,
    ),
  ];
  if (lateReset)
    rows.push(exchange("GET", "/poll", "", `prefix-reset-${key}-reset-suffix`));
  rows.push(
    exchange("GET", `/fourth?user=${user}&key=${key}`, "", "ok"),
    exchange("GET", "/fifth", "", "ok"),
    exchange("POST", "/sixth", `key=${key}`, "ok"),
    exchange("POST", "/seventh", `user=${user}`, "ok"),
    exchange("GET", "/eighth", "", "ok"),
  );
  return rows;
}

describe("private WordPress smoke replay bindings", () => {
  const sourceRoute = route(sourceUser, sourceKey);
  const sourceCapture = capture(sourceUser, sourceKey, sourceSecurity);
  const comparisonRoute = route(comparisonUser, comparisonKey);
  const comparisonCapture = capture(
    comparisonUser,
    comparisonKey,
    comparisonSecurity,
    true,
  );

  it("counts malformed delimiter intervals as the replay runner does", () => {
    const binding = {
      name: "resetKey",
      left: "prefix-reset-",
      right: "-reset-suffix",
      pattern: "[A-Za-z0-9]{20}",
      occurrence: "last",
    } as const;
    expect(
      extractReplayBinding(
        `prefix-reset-${sourceKey}-reset-suffix prefix-reset-invalid!-reset-suffix`,
        binding,
      ),
    ).toBeNull();
    expect(
      extractReplayBinding(
        `prefix-reset-invalid!-reset-suffix prefix-reset-${sourceKey}-reset-suffix`,
        binding,
      ),
    ).toBe(sourceKey);
  });

  it("derives request templates only after two positive captures agree", () => {
    const recipe = createSmokeReplayRecipe({
      sourceRoute,
      sourceCapture,
      comparisonRoute,
      comparisonCapture,
      findingSnapshotDigest: sourceRoute.snapshotDigest,
    });
    const input = replayInputFor(recipe, thirdUser);
    expect(input.steps).toHaveLength(8);
    expect(input.steps[0]?.bindingsAfter?.[0]?.name).toBe("security");
    expect(input.steps[2]?.bindingsAfter?.[0]?.occurrence).toBe("last");
    expect(input.steps[3]?.path).toContain("{{resetKey}}");
    expect(input.steps[3]?.path).toContain("{{adminUser}}");
    expect(input.initialBindings).toEqual({ adminUser: thirdUser });
  });

  it("binds the original route to fresh responses, and rejects a missing key", () => {
    const recipe = createSmokeReplayRecipe({
      sourceRoute,
      sourceCapture,
      comparisonRoute,
      comparisonCapture,
      findingSnapshotDigest: sourceRoute.snapshotDigest,
    });
    const fresh = capture(thirdUser, thirdKey, thirdSecurity);
    expect(() =>
      createSmokeReplayRecipe({
        sourceRoute,
        sourceCapture,
        comparisonRoute: route(thirdUser, thirdKey),
        comparisonCapture: fresh,
        findingSnapshotDigest: sourceRoute.snapshotDigest,
      }),
    ).not.toThrow();
    const bound = bindSmokeReferenceRoute({
      recipe,
      sourceRoute,
      capture: fresh,
      adminUser: thirdUser,
    }) as ReturnType<typeof route>;
    expect(bound.steps[3]?.path).toBe(
      `/fourth?user=${thirdUser}&key=${thirdKey}`,
    );
    expect(bound.steps).toHaveLength(8);
    fresh[2] = exchange(
      "POST",
      "/third",
      `security=${thirdSecurity}`,
      "pending",
    );
    expect(
      bindSmokeReferenceRoute({
        recipe,
        sourceRoute,
        capture: fresh,
        adminUser: thirdUser,
      }),
    ).toBeNull();
  });
});
