import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openTranscribedWordfenceProgramme } from "../../../src/profiles/wordpress/wordfence-programme/index.js";

const fixtureDirectory = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "target-intelligence",
  "wordfence-programme",
);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function transcription(transcribedAt: string, drop?: string) {
  const root = await mkdtemp(join(tmpdir(), "wbh-programme-"));
  directories.push(root);
  const pages = await Promise.all(
    ["programme.json", "terms.json", "report-form.json"].map(
      async (file) =>
        JSON.parse(
          await readFile(join(fixtureDirectory, file), "utf8"),
        ) as Record<string, unknown>,
    ),
  );
  if (drop !== undefined) {
    const programme = pages[0] as {
      assertions: { eligibility: Record<string, unknown> };
    };
    delete programme.assertions.eligibility[drop];
  }
  const path = join(root, "wordfence-programme.json");
  await writeFile(
    path,
    JSON.stringify({ schemaVersion: 1, transcribedAt, pages }),
  );
  return { path, storageDirectory: join(root, "programme") };
}

const clock = () => new Date("2026-10-08T12:00:00Z");

describe("transcribed Wordfence Programme", () => {
  it("records a human transcription of the official pages as the current programme snapshot", async () => {
    const files = await transcription("2026-10-01");
    const { programme, programmeRef } = await openTranscribedWordfenceProgramme(
      {
        transcriptionPath: files.path,
        storageDirectory: files.storageDirectory,
        clock,
      },
    );
    const inspected = await programme.inspect({
      kind: "programme-eligibility-inspection",
      schemaVersion: 1,
      snapshotRef: programmeRef,
      requiredFor: "target-selection-batch",
    });
    expect(inspected).toMatchObject({
      status: "current",
      snapshot: {
        programmeIdentity: "programme:wordfence",
        sources: [
          {
            sourceUrl:
              "https://www.wordfence.com/threat-intel/bug-bounty-program/",
            parserVersion: "human-transcription-2026-10-01",
          },
          {
            sourceUrl:
              "https://www.wordfence.com/threat-intel/bug-bounty-program/terms-and-conditions/",
          },
          {
            sourceUrl:
              "https://www.wordfence.com/threat-intel/vulnerabilities/submit/",
          },
        ],
        policy: { programmeOpportunityBand: "high-impact-only" },
      },
    });
  });

  it("refuses a transcription older than the review interval", async () => {
    const files = await transcription("2026-08-01");
    await expect(
      openTranscribedWordfenceProgramme({
        transcriptionPath: files.path,
        storageDirectory: files.storageDirectory,
        clock,
      }),
    ).rejects.toThrow(
      "Wordfence Programme transcription is older than 35 days",
    );
  });

  it("refuses a transcription the programme adapter cannot complete", async () => {
    const files = await transcription("2026-10-01", "limits");
    await expect(
      openTranscribedWordfenceProgramme({
        transcriptionPath: files.path,
        storageDirectory: files.storageDirectory,
        clock,
      }),
    ).rejects.toThrow("Wordfence Programme transcription is not usable");
  });
});
