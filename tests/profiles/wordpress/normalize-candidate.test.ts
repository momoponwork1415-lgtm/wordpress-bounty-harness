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

it("leaves valid fields and ambiguous labels to the schema", () => {
  const raw = {
    attackerPosition: "unauthenticated or subscriber",
    impact: "Data loss after stored XSS",
    configurationPrecondition: `${"p".repeat(999)}\u{1F600}`,
    claim: "c".repeat(4000),
  };
  const normalized = normalizeWordPressCandidate(raw);
  expect(normalized.changes).toEqual([
    { path: "configurationPrecondition", operation: "text-truncated" },
  ]);
  // The cut does not split a surrogate pair.
  expect(normalized.value).toMatchObject({
    attackerPosition: raw.attackerPosition,
    impact: raw.impact,
    configurationPrecondition: "p".repeat(999),
    claim: raw.claim,
  });
  expect(
    normalizeWordPressCandidate({
      impact: { kind: "sqli", note: "two strings" },
      attackerPosition: "customer",
    }).value,
  ).toMatchObject({ impact: "sqli", attackerPosition: "customer" });
});
