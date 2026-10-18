import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  isWordPressProgrammeImpact,
  WORDPRESS_PROGRAMME_EXCLUDED_IMPACTS,
} from "../../../src/profiles/wordpress/discovery/programme-impacts.js";

describe("Programme Boundary impact labels (#185)", () => {
  it("pins the revised boundary version and names every parked impact as out of scope", async () => {
    const campaign = JSON.parse(
      await readFile(
        new URL(
          "../../../src/profiles/wordpress/policy/campaign.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { programmeBoundary: { version: string; text: string } };
    expect(campaign.programmeBoundary.version).toBe("wordfence-2026-10-17");
    const outOfScope = campaign.programmeBoundary.text.split(
      "Out of scope for this campaign: ",
    )[1];
    expect(outOfScope).toBeDefined();
    const terms: Record<string, string> = {
      other: "business-logic-only impact",
      "csrf-to-write": "CSRF",
      "missing-authz": "missing authorization",
      idor: "IDOR",
      "reflected-xss": "reflected XSS",
      "sensitive-object-access": "sensitive information disclosure",
      "content-deletion": "arbitrary content deletion",
      "options-update": "arbitrary options update",
      "privesc-to-contributor+":
        "privilege escalation or authentication bypass that stops below admin",
      "auth-bypass-non-admin":
        "privilege escalation or authentication bypass that stops below admin",
    };
    expect(Object.keys(terms)).toEqual([
      ...WORDPRESS_PROGRAMME_EXCLUDED_IMPACTS,
    ]);
    for (const term of Object.values(terms)) expect(outOfScope).toContain(term);
  });

  it("routes every excluded label away from verification and review", () => {
    for (const excluded of WORDPRESS_PROGRAMME_EXCLUDED_IMPACTS)
      expect(isWordPressProgrammeImpact(excluded)).toBe(false);
  });

  it("keeps the labels the Programme Boundary pays for", () => {
    for (const impact of ["account-takeover", "sqli", "stored-xss"])
      expect(isWordPressProgrammeImpact(impact)).toBe(true);
  });

  it("parks the five hard-to-judge labels the owner removed on 2026-10-17", () => {
    for (const impact of [
      "sensitive-object-access",
      "content-deletion",
      "options-update",
      "privesc-to-contributor+",
      "auth-bypass-non-admin",
    ])
      expect(isWordPressProgrammeImpact(impact)).toBe(false);
  });

  it("keeps arbitrary file access and PHP file classes", () => {
    for (const impact of [
      "rce",
      "php-file-write",
      "arbitrary-file-read",
      "arbitrary-file-delete",
      "lfi",
      "privesc-to-admin",
    ])
      expect(isWordPressProgrammeImpact(impact)).toBe(true);
  });

  it("does not admit labels outside the Finding schema", () => {
    expect(isWordPressProgrammeImpact("not-a-label")).toBe(false);
  });
});
