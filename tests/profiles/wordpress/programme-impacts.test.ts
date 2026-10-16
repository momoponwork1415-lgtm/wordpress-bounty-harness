import { describe, expect, it } from "vitest";

import {
  isWordPressProgrammeImpact,
  WORDPRESS_PROGRAMME_EXCLUDED_IMPACTS,
} from "../../../src/profiles/wordpress/discovery/programme-impacts.js";

describe("Programme Boundary impact labels (#185)", () => {
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
