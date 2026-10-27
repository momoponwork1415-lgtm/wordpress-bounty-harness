import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseRoleDefinition } from "../../src/discovery/role-definition.js";

// ADR 0042: a role definition is front matter plus a body of whole paragraphs;
// the digest covers the whole file, so a changed body is a new version.

const valid = [
  "---",
  "role: tracer",
  "version: 2",
  "output: report",
  "---",
  "",
  "First paragraph.",
  "",
  "Second paragraph.",
  "",
].join("\n");

describe("parseRoleDefinition", () => {
  it("parses the front matter, keeps the body and digests the whole file", () => {
    const definition = parseRoleDefinition(valid);
    expect(definition.frontMatter).toEqual({
      role: "tracer",
      version: 2,
      output: "report",
    });
    expect(definition.body).toBe("First paragraph.\n\nSecond paragraph.\n");
    expect(definition.digest).toBe(
      `sha256:${createHash("sha256").update(valid).digest("hex")}`,
    );
  });

  it.each([
    ["no front matter", "First paragraph.\n"],
    ["a line without `key: value`", valid.replace("version: 2", "version 2")],
    ["a repeated key", valid.replace("version: 2", "role: x\nversion: 2")],
    ["an unknown key", valid.replace("version: 2", "version: 2\nextra: y")],
    ["a missing key", valid.replace("version: 2\n", "")],
    ["a non-numeric version", valid.replace("version: 2", "version: two")],
    ["a role with capitals", valid.replace("role: tracer", "role: Tracer")],
    ["a body that ends in a blank line", `${valid}\n`],
    ["an empty body", valid.split("---\n\n")[0] + "---\n\n"],
  ])("refuses %s", (_, text) => {
    expect(() => parseRoleDefinition(text)).toThrow();
  });
});
