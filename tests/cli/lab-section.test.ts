import { describe, expect, it } from "vitest";

import { wordPressLabSection } from "../../src/cli/wordpress.js";
import type { WordPressLabHandle } from "../../src/profiles/wordpress/lab/index.js";

const handle = {
  id: "11111111-2222-4333-8444-555555555555",
  snapshotDigest: `sha256:${"a".repeat(64)}`,
  setupDigest: `sha256:${"b".repeat(64)}`,
  endpoint: "http://wordpress",
  networkName: "wbh-11111111-2222-4333-8444-555555555555-net",
  internalIp: "172.20.0.10",
  recorderIp: "172.20.0.2",
  attackerAccounts: { subscriber: { username: "s", password: "p" } },
  exploration: {
    control: { host: "labctl", ipv4: "172.20.0.130" },
    administrator: { username: "harness-admin", password: "a" },
  },
} satisfies WordPressLabHandle;

const budget = { maxResets: 2, maxObservations: 20, maxLookups: 60 };

const SENTENCE =
  "The installed skill wbh-lab describes when to use Find, Query, Trace and Observe from the research files and how to record each answer; read it before the first of these commands.";

describe("## Lab section and the staged wbh-lab skill (ADR 0049 addendum 6)", () => {
  it("names the installed wbh-lab skill once, after the Trace paragraph and before the closing paragraph", () => {
    const section = wordPressLabSection(handle, budget, undefined, [
      "wbh-recon",
      "wbh-tools",
      "wbh-setup",
      "wbh-lab",
    ]);
    const paragraphs = section.split("\n\n");
    const index = paragraphs.indexOf(SENTENCE);
    expect(index).toBeGreaterThan(0);
    expect(paragraphs[index - 1]).toMatch(
      /^Trace: .* Trace shares the Find and Query budget\.$/,
    );
    expect(paragraphs[index + 1]).toMatch(
      /^The Harness records the HTTP traffic/,
    );
    expect(paragraphs.at(-1)).toBe(paragraphs[index + 1]);
    expect(section.split(SENTENCE)).toHaveLength(2);
    expect(section.split("wbh-lab")).toHaveLength(2);
  });

  it("is byte-identical to the section without skills when no staged skill is named wbh-lab", () => {
    const withoutSkills = wordPressLabSection(handle, budget);
    expect(withoutSkills).not.toContain("wbh-lab");
    expect(withoutSkills).not.toContain("installed skill");
    expect(wordPressLabSection(handle, budget, undefined, [])).toBe(
      withoutSkills,
    );
    // Another name, and the skill id rather than the front-matter name, add nothing.
    expect(
      wordPressLabSection(handle, budget, undefined, [
        "wbh-recon",
        "wbh-tools",
        "wbh-setup",
      ]),
    ).toBe(withoutSkills);
    expect(wordPressLabSection(handle, budget, undefined, ["wbh-lab-v1"])).toBe(
      withoutSkills,
    );
  });

  it("names the skill in a resumed segment's notice the same way", () => {
    const used = { resetsUsed: 1, observationsUsed: 2, lookupsUsed: 3 };
    const resumed = wordPressLabSection(handle, budget, used, ["wbh-lab"]);
    expect(resumed).toContain(
      "This segment resumes the Trial in a new sandbox with a new Lab.",
    );
    expect(resumed).toContain(
      `Trace shares the Find and Query budget.\n\n${SENTENCE}\n\nThe Harness records the HTTP traffic`,
    );
    expect(wordPressLabSection(handle, budget, used)).not.toContain("wbh-lab");
  });
});
