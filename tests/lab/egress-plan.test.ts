import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  labEgressPlanFileSchema,
  readLabEgressPlanFile,
} from "../../src/lab/egress-plan.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const plan = {
  schema: "wbh-egress-plan/v1",
  campaignId: "campaign-1",
  findingId: "finding-1",
  destinations: [{ host: "api.example.test", port: 443 }],
  reason: "The plugin's ordinary use connects to the service",
};

// ADR 0046 条件 2・4: fixed destinations only, and nothing the Harness could use as a credential.
describe("Lab egress plan", () => {
  it("accepts fixed lowercase hostnames on 443 or 80, up to four", () => {
    expect(labEgressPlanFileSchema.parse(plan).destinations).toEqual([
      { host: "api.example.test", port: 443 },
    ]);
    expect(
      labEgressPlanFileSchema.safeParse({
        ...plan,
        destinations: [
          { host: "a.example.test", port: 443 },
          { host: "b.example.test", port: 80 },
          { host: "c.example.test", port: 443 },
          { host: "d.example.test", port: 443 },
        ],
      }).success,
    ).toBe(true);
  });

  it("refuses wildcards, address literals, other ports, duplicates, more than four and extra fields", () => {
    for (const destinations of [
      [{ host: "*.example.test", port: 443 }],
      [{ host: "203.0.113.7", port: 443 }],
      [{ host: "API.example.test", port: 443 }],
      [{ host: "localhost", port: 443 }],
      [{ host: "api.example.test", port: 8443 }],
      [
        { host: "api.example.test", port: 443 },
        { host: "api.example.test", port: 443 },
      ],
      Array.from({ length: 5 }, (_, index) => ({
        host: `h${index}.example.test`,
        port: 443,
      })),
      [],
    ])
      expect(
        labEgressPlanFileSchema.safeParse({ ...plan, destinations }).success,
      ).toBe(false);
    expect(
      labEgressPlanFileSchema.safeParse({ ...plan, apiKey: "secret" }).success,
    ).toBe(false);
    expect(
      labEgressPlanFileSchema.safeParse({
        ...plan,
        destinations: [{ host: "api.example.test", port: 443, token: "x" }],
      }).success,
    ).toBe(false);
  });

  it("reads a plan file and names the invalid field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-egress-plan-"));
    directories.push(directory);
    const path = join(directory, "plan.json");
    await writeFile(path, JSON.stringify(plan));
    expect((await readLabEgressPlanFile(path)).findingId).toBe("finding-1");
    await writeFile(
      path,
      JSON.stringify({ ...plan, destinations: [{ host: "x", port: 443 }] }),
    );
    await expect(readLabEgressPlanFile(path)).rejects.toThrow(
      /egress plan is invalid: destinations\.0\.host/,
    );
    await writeFile(path, "{not json");
    await expect(readLabEgressPlanFile(path)).rejects.toThrow(
      /could not be read/,
    );
  });
});
