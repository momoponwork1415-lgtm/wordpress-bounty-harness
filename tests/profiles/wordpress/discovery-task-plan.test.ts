import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import {
  entryKey,
  planWordPressEntryAssignments,
} from "../../../src/profiles/wordpress/discovery/entry-points.js";
import { buildWordPressSourceIndex } from "../../../src/profiles/wordpress/discovery/storage-index.js";
import { planWordPressTasks } from "../../../src/profiles/wordpress/discovery/task-plan.js";

const fixture = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "wordpress-source-index",
);

describe("WordPress task plan", () => {
  it("dispatches each connected assignment once and leaves capped assignments unassigned", async () => {
    const index = await buildWordPressSourceIndex(fixture, "plugin");
    const assignments = planWordPressEntryAssignments(index, 1);
    const plan = planWordPressTasks(index, {
      entriesPerTask: 1,
      maxTasksPerTarget: 2,
    });

    expect(assignments).toHaveLength(4);
    expect(plan.planDigest).toBe(assignments[0]!.planDigest);
    expect(plan.tasks.map((task) => task.assignment)).toEqual(
      assignments.slice(0, 2),
    );
    expect(plan.unassigned).toEqual(assignments.slice(2));
    expect(plan.tasks.map((task) => task.ordinal)).toEqual([0, 1]);
    expect(plan.tasks.every((task) => task.taskKind === "initial")).toBe(true);
    expect(plan.tasks.map((task) => task.taskId)).toEqual(
      assignments.slice(0, 2).map((assignment) =>
        canonicalDigest({
          planDigest: assignment.planDigest,
          entryKeys: assignment.entries.map(entryKey),
        }),
      ),
    );
  });

  it("uses the documented defaults and rejects widths or caps outside their bounds", async () => {
    const index = await buildWordPressSourceIndex(fixture, "plugin");
    const plan = planWordPressTasks(index);
    expect(plan.tasks.map((task) => task.assignment)).toEqual(
      planWordPressEntryAssignments(index, 6),
    );
    expect(plan.unassigned).toEqual([]);
    expect(() => planWordPressTasks(index, { entriesPerTask: 0 })).toThrow();
    expect(() => planWordPressTasks(index, { entriesPerTask: 33 })).toThrow();
    expect(() => planWordPressTasks(index, { maxTasksPerTarget: 0 })).toThrow();
    expect(() =>
      planWordPressTasks(index, { maxTasksPerTarget: 201 }),
    ).toThrow();
  });
});
