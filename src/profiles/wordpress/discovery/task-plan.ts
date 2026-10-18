import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import {
  entryKey,
  planWordPressEntryAssignments,
  type WordPressEntryAssignment,
} from "./entry-points.js";
import type { WordPressSourceIndex } from "./storage-index.js";

export interface WordPressTask {
  readonly taskId: string;
  readonly taskKind: "initial";
  readonly ordinal: number;
  readonly assignment: WordPressEntryAssignment;
  readonly planDigest: string;
}

export interface WordPressTaskPlan {
  readonly tasks: readonly WordPressTask[];
  readonly unassigned: readonly WordPressEntryAssignment[];
  readonly planDigest: string;
}

export interface WordPressTaskPlanOptions {
  readonly entriesPerTask?: number;
  readonly maxTasksPerTarget?: number;
}

/** Turns every connected entry assignment into one task, up to the target cap. */
export function planWordPressTasks(
  index: WordPressSourceIndex,
  options: WordPressTaskPlanOptions = {},
): WordPressTaskPlan {
  const entriesPerTask = options.entriesPerTask ?? 6;
  const maxTasksPerTarget = options.maxTasksPerTarget ?? 24;
  if (
    !Number.isSafeInteger(entriesPerTask) ||
    entriesPerTask < 1 ||
    entriesPerTask > 32
  )
    throw new Error("entriesPerTask must be an integer from 1 to 32");
  if (
    !Number.isSafeInteger(maxTasksPerTarget) ||
    maxTasksPerTarget < 1 ||
    maxTasksPerTarget > 200
  )
    throw new Error("maxTasksPerTarget must be an integer from 1 to 200");

  const assignments = planWordPressEntryAssignments(index, entriesPerTask);
  const planDigest =
    assignments[0]?.planDigest ??
    canonicalDigest({
      indexDigest: index.digest,
      entriesPerTask,
      partitions: [],
    });
  return {
    tasks: assignments.slice(0, maxTasksPerTarget).map((assignment) => ({
      taskId: canonicalDigest({
        planDigest,
        entryKeys: assignment.entries.map(entryKey),
      }),
      taskKind: "initial",
      ordinal: assignment.partition,
      assignment,
      planDigest,
    })),
    unassigned: assignments.slice(maxTasksPerTarget),
    planDigest,
  };
}
