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
  it("normalizes fixed sandbox source paths and retains a private recipe note", () => {
    const finding = admitWordPressFinding(
      {
        ...candidate,
        sourceTrace: [
          {
            file: "/workspace/main/includes/example.php",
            function: "f",
            line: 12,
          },
          {
            file: "/workspace/wordpress/wp-includes/load.php",
            function: "g",
            line: 1,
          },
          {
            file: "../wordpress/wp-admin/admin-ajax.php",
            function: "h",
            line: 2,
          },
        ],
        privateRecipeReference: "See the sealed report for Lab steps",
      },
      { runId: "run-1", snapshotDigest: digest, reportArtifactDigest: digest },
    );
    expect(finding.sourceTrace.map((location) => location.file)).toEqual([
      "includes/example.php",
      "@wordpress/wp-includes/load.php",
      "@wordpress/wp-admin/admin-ajax.php",
    ]);
    expect(readWordPressFinding(finding)).toEqual(finding);
    expect(() =>
      admitWordPressFinding(
        {
          ...candidate,
          sourceTrace: [{ file: "/etc/passwd", function: "f", line: 1 }],
        },
        {
          runId: "run-1",
          snapshotDigest: digest,
          reportArtifactDigest: digest,
        },
      ),
    ).toThrow();
  });

  it("canonicalizes a specific account takeover impact synonym", () => {
    const finding = admitWordPressFinding(
      { ...candidate, impact: "account-takeover-to-admin" },
      { runId: "run-1", snapshotDigest: digest, reportArtifactDigest: digest },
    );
    expect(finding.impact).toBe("account-takeover");
  });

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
