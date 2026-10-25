import { describe, expect, it } from "vitest";

import {
  assessWordpressScope,
  loadWordpressScopePolicy,
} from "../../../src/profiles/wordpress/scope-policy.js";
import {
  wordpressHumanObservedScopeFacts,
  wordpressScopeFacts,
} from "../../../src/profiles/wordpress/scope-facts.js";

const target = { activeInstallations: 5_000 };
const route = { attackerRole: "subscriber", defaultSettings: "true" };

describe("WordPress scope facts from judge conditions", () => {
  it("keeps a confirmed protected-object read separate from programme sensitivity", async () => {
    const facts = wordpressScopeFacts({
      category: "sensitive-object-access",
      conditions: {
        observedVia: "sensitive-canary-access",
        objectKind: "private-post",
        ...route,
      },
      target,
      latestVersionVerified: true,
      ordinaryScenarioVerified: true,
    });
    expect(facts.observations).toEqual(["sensitive-canary-access"]);
    expect(
      assessWordpressScope(await loadWordpressScopePolicy(), facts).map(
        (item) => [item.status, item.reason],
      ),
    ).toEqual([
      ["ambiguous", "object-sensitivity-needs-review"],
      ["ambiguous", "object-sensitivity-needs-review"],
    ]);
  });
  it("builds scope input from the judge, selection, version basis and verified ordinary setup", async () => {
    const facts = wordpressScopeFacts({
      category: "account-takeover",
      conditions: {
        reachedRole: "administrator",
        observedVia: "session",
        ...route,
      },
      target,
      latestVersionVerified: true,
      ordinaryScenarioVerified: true,
    });
    expect(facts).toEqual({
      category: "account-takeover",
      attacker: "subscriber",
      activeInstalls: 5_000,
      wordpressOrgListed: true,
      premium: false,
      latestVersionVerified: true,
      defaultOrCommonSettings: true,
      observations: ["admin-session-reached", "other-session-reached"],
    });
    const assessed = assessWordpressScope(
      await loadWordpressScopePolicy(),
      facts,
    );
    expect(assessed.map((item) => [item.programme, item.status])).toEqual([
      ["wordfence", "in-scope"],
      ["patchstack", "in-scope"],
    ]);
  });

  it("keeps a narrow stored XSS eligible for Wordfence on a verified ordinary setup", async () => {
    const facts = wordpressScopeFacts({
      category: "stored-xss",
      conditions: {
        attackerRole: "subscriber",
        defaultSettings: "false",
        observedVia: "canary-beacon",
        siteWide: "no",
        victimRole: "administrator",
        victimPrincipal: "separate",
      },
      target,
      latestVersionVerified: true,
      ordinaryScenarioVerified: true,
    });
    expect(facts.defaultOrCommonSettings).toBe(true);
    expect(
      assessWordpressScope(await loadWordpressScopePolicy(), facts).map(
        (item) => [item.programme, item.status, item.reason],
      ),
    ).toEqual([
      ["wordfence", "in-scope", "policy-conditions-met"],
      ["patchstack", "ambiguous", "observation-missing"],
    ]);
  });

  it.each(["true", "false"])(
    "does not use the Verifier's defaultSettings=%s claim without an ordinary Lab record",
    async (defaultSettings) => {
      const facts = wordpressScopeFacts({
        category: "sqli",
        conditions: {
          attackerRole: "subscriber",
          defaultSettings,
          observedVia: "canary-row-read",
        },
        target,
        latestVersionVerified: true,
        ordinaryScenarioVerified: false,
      });
      expect(facts.defaultOrCommonSettings).toBeUndefined();
      expect(
        assessWordpressScope(await loadWordpressScopePolicy(), facts).map(
          (item) => [item.status, item.reason],
        ),
      ).toEqual([
        ["ambiguous", "version-or-configuration-unknown"],
        ["ambiguous", "version-or-configuration-unknown"],
      ]);
    },
  );

  it("leaves the version unknown until a latest-version re-verification confirms it", async () => {
    const facts = wordpressScopeFacts({
      category: "sqli",
      conditions: { observedVia: "canary-row-read", ...route },
      target,
      latestVersionVerified: false,
      ordinaryScenarioVerified: true,
    });
    expect(facts.latestVersionVerified).toBeUndefined();
    expect(
      assessWordpressScope(await loadWordpressScopePolicy(), facts).map(
        (item) => item.reason,
      ),
    ).toEqual([
      "version-or-configuration-unknown",
      "version-or-configuration-unknown",
    ]);
  });

  it.each([
    [
      "sensitive-object-access",
      { observedVia: "sensitive-canary-access", objectKind: "private-post" },
      "sensitive-object-access",
      ["sensitive-canary-access"],
    ],
    [
      "arbitrary-file-read",
      {
        observedVia: "canary-file-read",
        canaryFilesRead: "outside-webroot,php-source",
        pathAndExtension: "attacker-chosen",
      },
      "arbitrary-php-file-read",
      ["canary-file-read", "path-extension-control"],
    ],
    [
      "arbitrary-file-delete",
      {
        observedVia: "canary-file-deleted",
        canaryFilesDeleted: "outside-webroot",
        pathAndExtension: "partial",
      },
      "arbitrary-file-delete",
      ["canary-file-deleted"],
    ],
    [
      "rce",
      {
        observedVia: "execution-canary",
        canaryFiles: "wp-content/uploads/synthetic.php",
      },
      "rce",
      ["execution-canary", "path-extension-control"],
    ],
    [
      "options-update",
      {
        observedVia: "option-change",
        changedOptions: "default_role",
        optionClass: "critical",
      },
      "options-update",
      ["option-canary-changed", "significant-option-changed"],
    ],
    [
      "options-update",
      {
        observedVia: "option-change",
        changedOptions: "wbh_canary_x",
        optionClass: "canary",
      },
      "options-update",
      ["option-canary-changed"],
    ],
    [
      "privesc-to-contributor+",
      {
        observedVia: "role-change",
        reachedRole: "editor",
        attackerBaselineRoles: "subscriber",
      },
      "privesc-to-contributor+",
      ["contributor-capability-reached"],
    ],
    [
      "stored-xss",
      {
        observedVia: "canary-beacon",
        firedContexts: "front",
        siteWide: "yes",
      },
      "stored-xss",
      ["javascript-executed", "site-wide"],
    ],
  ] as const)(
    "maps %s conditions to the policy vocabulary",
    (category, conditions, expectedCategory, observations) => {
      const facts = wordpressScopeFacts({
        category,
        conditions: { ...conditions, ...route },
        target,
        latestVersionVerified: false,
        ordinaryScenarioVerified: true,
      });
      expect(facts.category).toBe(expectedCategory);
      expect(facts.observations).toEqual(observations);
    },
  );

  it("refuses to guess the attacker when the judge did not record it", () => {
    expect(() =>
      wordpressScopeFacts({
        category: "sqli",
        conditions: { observedVia: "canary-row-read" },
        target,
        latestVersionVerified: false,
        ordinaryScenarioVerified: true,
      }),
    ).toThrow();
  });

  it("carries the Lab-observed victim identity into scope facts", () => {
    const facts = wordpressScopeFacts({
      category: "stored-xss",
      conditions: {
        ...route,
        observedVia: "canary-beacon",
        victimRole: "self",
      },
      target,
      latestVersionVerified: true,
      ordinaryScenarioVerified: true,
    });
    expect(facts.victimRole).toBe("self");
  });
});

describe("WordPress scope facts from a person's Lab observation (#525)", () => {
  const observed = (category: string, victimRole?: "administrator" | "self") =>
    wordpressHumanObservedScopeFacts({
      category,
      attacker: "subscriber",
      ...(victimRole === undefined ? {} : { victimRole }),
      target,
      latestVersionVerified: true,
      ordinaryScenarioVerified: true,
    });

  it("reads the claimed effect from the match and the victim from the Lab browser record", async () => {
    const policy = await loadWordpressScopePolicy();
    const xss = observed("stored-xss", "administrator");
    expect(xss).toMatchObject({
      observations: ["javascript-executed"],
      victimRole: "administrator",
      victimPrincipal: "separate",
    });
    // Site-wide reach was a judge condition; Patchstack still needs it.
    expect(
      assessWordpressScope(policy, xss).map((item) => [
        item.programme,
        item.status,
      ]),
    ).toEqual([
      ["wordfence", "in-scope"],
      ["patchstack", "ambiguous"],
    ]);
    expect(
      assessWordpressScope(policy, observed("stored-xss", "self")).map(
        (item) => item.reason,
      ),
    ).toEqual(["self-xss", "self-xss"]);
  });

  it("does not imply path and extension control for a file read", async () => {
    const facts = observed("arbitrary-file-read");
    expect(facts.observations).toEqual(["canary-file-read"]);
    expect(
      assessWordpressScope(await loadWordpressScopePolicy(), facts).map(
        (item) => [item.programme, item.status],
      ),
    ).toEqual([
      ["wordfence", "in-scope"],
      ["patchstack", "ambiguous"],
    ]);
  });
});
