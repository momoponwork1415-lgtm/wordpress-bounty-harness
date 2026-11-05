import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { wordPressLabSection } from "../../src/cli/wordpress.js";
import { MAX_RESUME_NOTICE_LENGTH } from "../../src/discovery/sandbox-layout.js";
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

// The section past Trials received; a changed byte breaks their prompt digests.
const digest = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("## Lab section", () => {
  it("keeps the bytes past Trials received", () => {
    const section = wordPressLabSection(handle, budget);
    expect(section).not.toContain("wbh-lab");
    expect(section).not.toContain("installed skill");
    expect(digest(section)).toBe(
      "sha256:247381ec7ab594e372d1a4530d0237f13a254a665e509c88c45739038a0c25df",
    );
    const used = { resetsUsed: 1, observationsUsed: 2, lookupsUsed: 3 };
    const resumed = wordPressLabSection(handle, budget, used);
    expect(resumed).toContain(
      "This segment resumes the Trial in a new sandbox with a new Lab.",
    );
    expect(digest(resumed)).toBe(
      "sha256:d12a49b9bda043db10c13d9fad3edea00f688aead0d4475d64586539785a483f",
    );
  });

  // A resumed segment sends this section as its first-turn notice; the
  // sandboxes refuse a notice past MAX_RESUME_NOTICE_LENGTH. At 4,096 every
  // Lab-attached resume failed as policy before the model ran (2026-11-06).
  it("fits the resumed-segment notice bound with production-length accounts", () => {
    const long = "x".repeat(64);
    const production = {
      ...handle,
      endpoint: `http://${"w".repeat(63)}`,
      attackerAccounts: {
        subscriber: { username: long, password: long },
        customer: { username: long, password: long },
      },
      exploration: {
        control: { host: "labctl", ipv4: "172.20.0.130" },
        administrator: { username: "harness-admin", password: long },
      },
    } satisfies WordPressLabHandle;
    const used = { resetsUsed: 2, observationsUsed: 20, lookupsUsed: 60 };
    const resumed = wordPressLabSection(production, budget, used);
    expect(resumed.length).toBeGreaterThan(4_096);
    expect(resumed.length).toBeLessThanOrEqual(MAX_RESUME_NOTICE_LENGTH);
  });
});
