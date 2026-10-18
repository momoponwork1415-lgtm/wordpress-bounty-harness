import { expect, it } from "vitest";

import {
  admitWordPressLead,
  readWordPressLead,
  wordPressLeadSignature,
} from "../../../src/profiles/wordpress/discovery/lead.js";

const digest = `sha256:${"a".repeat(64)}`;
const claim = {
  summary: "Source option write with no observed consumer",
  attackerPosition: "subscriber",
  primitive: "write",
  storage: { kind: "option", key: "plugin_shared" },
  missingEdge: "consumer",
  sourceTrace: [{ file: "plugin.php", function: "plugin_save", line: 8 }],
  labObservations: "No completed effect observed",
};
const context = {
  runId: "run-1",
  trialId: "trial-1",
  snapshotDigest: digest,
  reportArtifactDigest: digest,
};

it("admits and signs a private WordPress Lead independently of its wording", () => {
  const lead = admitWordPressLead(claim, context);
  expect(readWordPressLead(lead)).toEqual(lead);
  expect(lead.recipeRef).toEqual({ kind: "provider-report", digest });
  expect(
    admitWordPressLead(
      {
        ...claim,
        sourceTrace: [
          {
            file: "../wordpress/wp-includes/user.php",
            function: "core",
            line: 8,
          },
        ],
      },
      context,
    ).sourceTrace[0]?.file,
  ).toBe("@wordpress/wp-includes/user.php");
  expect(wordPressLeadSignature(lead)).toBe(
    wordPressLeadSignature(
      admitWordPressLead({ ...claim, summary: "Other wording" }, context),
    ),
  );
  expect(() =>
    admitWordPressLead(
      {
        ...claim,
        sourceTrace: [{ file: "../outside.php", function: "x", line: 1 }],
      },
      context,
    ),
  ).toThrow();
  expect(() => readWordPressLead({ ...lead, summary: "tampered" })).toThrow();
});
