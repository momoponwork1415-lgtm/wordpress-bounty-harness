import { describe, expect, it } from "vitest";

import {
  assessWordpressScope,
  loadWordpressScopePolicy,
} from "../../../src/profiles/wordpress/scope-policy.js";
import { wordpressScopeFacts } from "../../../src/profiles/wordpress/scope-facts.js";

const target = { activeInstallations: 5_000 };
const route = { attackerRole: "subscriber", defaultSettings: "true" };

describe("WordPress scope facts from judge conditions", () => {
  it("builds scope input only from the judge, the selection record and the latest-version basis", async () => {
    const facts = wordpressScopeFacts({
      category: "account-takeover",
      conditions: {
        reachedRole: "administrator",
        observedVia: "session",
        ...route,
      },
      target,
      latestVersionVerified: true,
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

  it("leaves the version unknown until a latest-version re-verification confirms it", async () => {
    const facts = wordpressScopeFacts({
      category: "sqli",
      conditions: { observedVia: "canary-row-read", ...route },
      target,
      latestVersionVerified: false,
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
      }),
    ).toThrow();
  });
});
