import { expect, it } from "vitest";

import {
  admitWordPressFinding,
  type WordPressFinding,
} from "../../../src/profiles/wordpress/discovery/finding.js";
import { isWordPressOwnerPriorityFinding } from "../../../src/profiles/wordpress/discovery/owner-impact-priority.js";

const digest = `sha256:${"a".repeat(64)}`;
function finding(
  impact: WordPressFinding["impact"],
  impactScope?: WordPressFinding["impactScope"],
) {
  return admitWordPressFinding(
    {
      claim: "Synthetic effect",
      attackerPosition: "subscriber",
      impact,
      ...(impactScope === undefined ? {} : { impactScope }),
      configurationPrecondition: "default",
      brokenProperty: "Synthetic property",
      sourceTrace: [
        { file: "includes/example.php", function: "example", line: 1 },
      ],
      existingControls: "none",
      labObservations: "synthetic observation",
    },
    { runId: "run-1", snapshotDigest: digest, reportArtifactDigest: digest },
  );
}

it("parks only the owner's narrow low-value effects, retaining broad labels with unknown or severe effects", () => {
  expect(
    isWordPressOwnerPriorityFinding(
      finding("options-update", "minor-ui-setting-only"),
    ),
  ).toBe(false);
  for (const scope of [
    "non-sensitive-enumeration-only",
    "protected-content-only",
    "private-media-reference-only",
  ] as const)
    expect(
      isWordPressOwnerPriorityFinding(
        finding("sensitive-object-access", scope),
      ),
    ).toBe(false);
  expect(
    isWordPressOwnerPriorityFinding(
      finding("options-update", "other-or-uncertain"),
    ),
  ).toBe(true);
  expect(
    isWordPressOwnerPriorityFinding(finding("sensitive-object-access")),
  ).toBe(true);
  expect(
    isWordPressOwnerPriorityFinding(finding("sqli", "protected-content-only")),
  ).toBe(true);
  expect(
    isWordPressOwnerPriorityFinding(
      finding("sensitive-object-access", "minor-ui-setting-only"),
    ),
  ).toBe(true);
});
