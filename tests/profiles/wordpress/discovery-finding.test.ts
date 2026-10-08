import { describe, expect, it } from "vitest";

import {
  admitWordPressFinding,
  readWordPressFinding,
} from "../../../src/profiles/wordpress/discovery/finding.js";

const digest = `sha256:${"a".repeat(64)}`;
const candidate = {
  claim: "A synthetic low-privilege request changes a canary account",
  attackerPosition: "subscriber",
  impact: "account-takeover",
  configurationPrecondition: "default",
  brokenProperty: "Account ownership",
  sourceTrace: [
    { file: "includes/example.php", function: "fixture_handler", line: 12 },
  ],
  existingControls: "A capability check is present elsewhere",
  labObservations: "The canary account changed in the isolated Lab",
};

describe("WordPress Finding admission", () => {
  it("binds a low-privilege Finding to its run, snapshot, and private report", () => {
    const finding = admitWordPressFinding(candidate, {
      runId: "run-1",
      snapshotDigest: digest,
      reportArtifactDigest: digest,
    });
    expect(finding).toMatchObject({
      attackerPosition: "subscriber",
      impact: "account-takeover",
      discoveryRunId: "run-1",
      snapshotDigest: digest,
      recipeRef: { kind: "provider-report", digest },
    });
    expect(finding.findingId).toMatch(/^sha256:/);
    expect(() =>
      admitWordPressFinding(
        { ...candidate, attackerPosition: "administrator" },
        {
          runId: "run-1",
          snapshotDigest: digest,
          reportArtifactDigest: digest,
        },
      ),
    ).toThrow();
    expect(() =>
      admitWordPressFinding(
        { ...candidate, runtimeConfirmed: true },
        {
          runId: "run-1",
          snapshotDigest: digest,
          reportArtifactDigest: digest,
        },
      ),
    ).toThrow();
  });
});

it("reads a stored Finding back only when its identity matches its content", () => {
  const admitted = admitWordPressFinding(
    {
      claim: "Synthetic claim",
      attackerPosition: "subscriber",
      impact: "account-takeover",
      configurationPrecondition: "default",
      brokenProperty: "Synthetic property",
      sourceTrace: [{ file: "includes/a.php", function: "f", line: 1 }],
      existingControls: "Synthetic control",
      labObservations: "Synthetic observation",
    },
    {
      runId: "run-1",
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      reportArtifactDigest: `sha256:${"b".repeat(64)}`,
    },
  );
  const stored = JSON.parse(JSON.stringify(admitted)) as unknown;
  expect(readWordPressFinding(stored)).toEqual(admitted);
  expect(() =>
    readWordPressFinding({ ...admitted, impact: "privesc-to-admin" }),
  ).toThrow();
});
