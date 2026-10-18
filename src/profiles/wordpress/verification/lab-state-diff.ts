import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type {
  StateDiffReader,
  StateDiffSummary,
} from "../../../review/index.js";
import type {
  LabStateDiffRecord,
  LabStateObserver,
} from "../../../verification/index.js";
import {
  diffWordPressLabState,
  wordpressLabStateDiffSchema,
  wordpressLabStateSchema,
  type WordPressLab,
  type WordPressLabHandle,
  type WordPressLabStateDiff,
} from "../lab/index.js";

export const LAB_STATE_FILE = "lab-state.json";
export const LAB_STATE_DIFF_FILE = "lab-state-diff.json";

/**
 * Captures the whole WordPress Lab state before and after the Verifier run and
 * writes `lab-state.json` (before, after) and `lab-state-diff.json` to Private
 * Evidence (#186). The Verifier never sees these; judges never read them.
 */
export function createWordPressLabStateObserver(options: {
  readonly store: PrivateArtifactStore;
  readonly lab: Pick<WordPressLab, "captureState">;
}): LabStateObserver<WordPressLabHandle> {
  return {
    async before(lab) {
      const captured = await options.lab.captureState(lab);
      if (captured.status !== "captured") return null;
      const digest = await options.store.putFiles({
        [LAB_STATE_FILE]: canonicalJson(captured.state),
      });
      return { digest, state: captured.state };
    },
    async after(lab, before): Promise<LabStateDiffRecord> {
      const previous = wordpressLabStateSchema.safeParse(before.state);
      if (!previous.success)
        return { status: "missing", reason: "before-capture" };
      const captured = await options.lab.captureState(lab);
      if (captured.status !== "captured")
        return { status: "missing", reason: "after-capture" };
      try {
        const afterDigest = await options.store.putFiles({
          [LAB_STATE_FILE]: canonicalJson(captured.state),
        });
        const diff = diffWordPressLabState(previous.data, captured.state, {
          before: before.digest,
          after: afterDigest,
        });
        const diffDigest = await options.store.putFiles({
          [LAB_STATE_DIFF_FILE]: canonicalJson(diff),
        });
        return {
          status: "captured",
          artifacts: [
            { kind: "lab-state-before", digest: before.digest },
            { kind: "lab-state-after", digest: afterDigest },
            { kind: "lab-state-diff", digest: diffDigest },
          ],
        };
      } catch {
        return { status: "missing", reason: "store" };
      }
    },
  };
}

/** Names and digests only: option values stay in `lab-state-diff.json` under Private Evidence. */
export function summarizeWordPressLabStateDiff(
  diff: WordPressLabStateDiff,
): StateDiffSummary {
  return {
    settings: {
      added: diff.options.added.map((option) => option.name),
      removed: diff.options.removed.map((option) => option.name),
      changed: diff.options.changed.map((option) => ({
        key: option.name,
        beforeDigest: option.beforeDigest ?? "",
        afterDigest: option.afterDigest ?? "",
      })),
    },
    principals: {
      added: diff.users.added.map((user) => ({
        name: user.login,
        roles: user.roles,
      })),
      removed: diff.users.removed.map((user) => user.login),
      changed: diff.users.changed.map((user) => ({
        name: user.login,
        rolesBefore: user.before.roles,
        rolesAfter: user.after.roles,
        credentialChanged:
          user.before.passwordDigest !== user.after.passwordDigest,
      })),
    },
    tables: {
      added: diff.tables.added,
      removed: diff.tables.removed,
      changed: diff.tables.changed,
    },
  };
}

/** Reads `lab-state-diff.json` for `review export`; an unreadable file yields null. */
export function createWordPressStateDiffReader(options: {
  readonly store: PrivateArtifactStore;
}): StateDiffReader {
  return {
    async read(digest) {
      const file = await options.store.readJson(
        digest,
        LAB_STATE_DIFF_FILE,
        wordpressLabStateDiffSchema,
        32 * 1024 * 1024,
      );
      return file.status === "resolved"
        ? summarizeWordPressLabStateDiff(file.value)
        : null;
    },
  };
}
