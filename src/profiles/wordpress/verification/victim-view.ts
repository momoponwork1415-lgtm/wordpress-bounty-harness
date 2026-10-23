import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { VictimViewObserver } from "../../../verification/index.js";
import type { WordPressLab, WordPressLabHandle } from "../lab/index.js";

const routeVictimSchema = z.looseObject({ victim: z.unknown().optional() });
const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * Keeps what the Lab browser showed on the route's declared victim visits
 * (#439): `victim-<n>.png`, `victim-<n>.webm` and `victim-view.json` (each
 * file's sha256) in one Private Evidence artifact of kind `victim-view`. It
 * runs after the judge, and the recording is for the human's report: no judge
 * reads it, and it is never a proof (invariant 3).
 */
export function createWordPressVictimViewObserver(options: {
  readonly store: PrivateArtifactStore;
  readonly lab: Pick<WordPressLab, "recordVictimView">;
}): VictimViewObserver<WordPressLabHandle> {
  return {
    async record(lab, recipeDigest) {
      const route = await options.store.readJson(
        recipeDigest,
        "route.json",
        routeVictimSchema,
        1024 * 1024,
      );
      if (route.status !== "resolved" || route.value.victim === undefined)
        return [];
      const recording = await options.lab.recordVictimView(
        lab,
        route.value.victim,
      );
      const files: Record<string, Uint8Array> = {};
      const keep = (name: string, bytes: Uint8Array) => {
        files[name] = bytes;
        return { file: name, sha256: sha256(bytes) };
      };
      const visits =
        recording.status !== "recorded"
          ? []
          : recording.visits.map((visit, index) => {
              if (visit.status !== "recorded") return visit;
              const name = `victim-${index + 1}`;
              return {
                status: visit.status,
                path: visit.path,
                screenshot: keep(`${name}.png`, visit.screenshot),
                video:
                  visit.video === undefined
                    ? null
                    : keep(`${name}.webm`, visit.video),
              };
            });
      const digest = await options.store.putFiles({
        ...files,
        "victim-view.json": canonicalJson({
          schemaVersion: 1,
          purpose: "review-material",
          snapshotDigest: lab.snapshotDigest,
          labSetupDigest: lab.setupDigest,
          recipeDigest,
          ...(recording.status === "recorded"
            ? { status: recording.status, role: recording.role }
            : recording),
          visits,
        }),
      });
      return [{ kind: "victim-view", digest }];
    },
  };
}
