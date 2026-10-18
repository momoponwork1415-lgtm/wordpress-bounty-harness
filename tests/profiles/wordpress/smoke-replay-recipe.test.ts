import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import {
  bindSmokeReferenceRoute,
  extractReplayBinding,
  type SmokeReplayRecipe,
} from "../../../src/profiles/wordpress/verification/smoke-replay-recipe.js";

const sourceUser = "wbh-canary-admin-source";
const thirdUser = "wbh-canary-admin-third";
const sourceKey = "01234567890123456789";
const thirdKey = "13579246801357924680";
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

function capture(user: string, key: string, security: string) {
  return [
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
      `prefix-reset-${key}-reset-suffix`,
    ),
    exchange("GET", `/fourth?user=${user}&key=${key}`, "", "ok"),
    exchange("GET", "/fifth", "", "ok"),
    exchange("POST", "/sixth", `key=${key}`, "ok"),
    exchange("POST", "/seventh", `user=${user}`, "ok"),
    exchange("GET", "/eighth", "", "ok"),
  ];
}

describe("legacy smoke replay bindings read by the canary judges", () => {
  const sourceRoute = route(sourceUser, sourceKey);
  const recipe: SmokeReplayRecipe = {
    schemaVersion: 1,
    findingSnapshotDigest: sourceRoute.snapshotDigest,
    sourceRouteDigest: canonicalDigest(sourceRoute),
    sourceAdminUser: sourceUser,
    sourceResetKey: sourceKey,
    securityBinding: {
      name: "security",
      left: "prefix-security-",
      right: "-security-suffix",
      pattern: "[A-Za-z0-9]{10}",
      occurrence: "unique",
    },
    resetKeyBinding: {
      name: "resetKey",
      left: "prefix-reset-",
      right: "-reset-suffix",
      pattern: "[A-Za-z0-9]{20}",
      occurrence: "last",
    },
    steps: sourceRoute.steps.map(({ method, path }) => ({
      method: method as "GET" | "POST",
      path,
    })),
  };

  it("counts malformed delimiter intervals as the replay runner did", () => {
    const binding = recipe.resetKeyBinding;
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

  it("binds the original route to fresh responses, and rejects a missing key", () => {
    const fresh = capture(thirdUser, thirdKey, thirdSecurity);
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
