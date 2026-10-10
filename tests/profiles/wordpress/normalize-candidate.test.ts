import { expect, it } from "vitest";

import { admitWordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import { normalizeWordPressCandidate } from "../../../src/profiles/wordpress/discovery/normalize-candidate.js";

it("normalizes a textual source trace and observation while retaining strict admission", () => {
  const raw = {
    claim: "Synthetic account change",
    attackerPosition: "subscriber",
    impact: "account-takeover",
    configurationPrecondition: "default",
    brokenProperty: "Account ownership",
    sourceTrace: ["../wordpress/wp-includes/user.php / change_user / 42"],
    existingControls: "No capability check",
    labObservations: ["The request succeeded", "The account changed"],
  };
  const normalized = normalizeWordPressCandidate(JSON.stringify(raw));
  expect(normalized.changes.map((change) => change.operation)).toEqual([
    "json-decoded",
    "text-array-joined",
    "source-trace-parsed",
    "source-path-normalized",
  ]);
  expect(
    admitWordPressFinding(normalized.value, {
      runId: "run-1",
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      reportArtifactDigest: `sha256:${"b".repeat(64)}`,
    }),
  ).toMatchObject({
    sourceTrace: [
      {
        file: "@wordpress/wp-includes/user.php",
        function: "change_user",
        line: 42,
      },
    ],
    labObservations: "The request succeeded\nThe account changed",
  });
  expect(() =>
    admitWordPressFinding(
      { ...raw, impact: "invented-impact" },
      {
        runId: "run-1",
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        reportArtifactDigest: `sha256:${"b".repeat(64)}`,
      },
    ),
  ).toThrow();
});
