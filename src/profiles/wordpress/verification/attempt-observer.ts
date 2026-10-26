import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type {
  AttemptObservation,
  AttemptObserver,
} from "../../../verification/index.js";
import type { WordPressFinding } from "../discovery/finding.js";
import {
  wordpressVictimRouteSchema,
  type WordPressLab,
  type WordPressLabHandle,
} from "../lab/index.js";
import { AUTHORED_HTTP_FILE, PROXY_CAPTURE_FILE } from "./http-evidence.js";

/** The Lab browser's record of the declared victim pages; read by `review export`. */
export const LAB_BROWSER_OBSERVATION_FILE = "lab-browser-observation.json";
export const VICTIM_SCREEN_FILE = "victim-screen.png";

const markerSchema = z.strictObject({ marker: z.string().regex(/^\d+$/) });
const routeSchema = z.looseObject({
  victim: wordpressVictimRouteSchema.optional(),
});

async function readJson(
  store: PrivateArtifactStore,
  digest: string,
  name: string,
): Promise<unknown> {
  const file = await store.readFile(digest, name, 1024 * 1024);
  if (file.status !== "resolved") return undefined;
  try {
    return JSON.parse(file.bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const missingCapture = (nextStep: string): AttemptObservation => ({
  status: "incomplete",
  reason: "evidence",
  nextStep,
});

/**
 * What the Harness keeps after a finished WordPress attempt (#525, ADR 0040):
 * the recorder's capture from `setup-done` on, the Verifier's own `http.json`
 * beside it, and, when `route.json` declares victim pages, what the Lab
 * browser saw there. Nothing here decides whether the Finding holds; a person
 * reads these records and reproduces in a review Lab.
 */
export function createWordPressAttemptObserver(options: {
  readonly store: PrivateArtifactStore;
  readonly lab: Pick<WordPressLab, "readCapture" | "observeVictimPages">;
}): AttemptObserver<WordPressFinding, WordPressLabHandle> {
  const { store } = options;
  return {
    async observe({ lab, recipeDigest }) {
      const marker = markerSchema.safeParse(
        await readJson(store, recipeDigest, "capture-marker.json"),
      );
      if (!marker.success)
        return missingCapture(
          "The attempt has no Harness capture marker; repeat in a fresh Lab",
        );
      const capture = await options.lab.readCapture(lab, marker.data.marker);
      if (capture.status !== "captured" || capture.bytes.length === 0)
        return missingCapture(
          "The Harness captured no HTTP after setup; repeat in a fresh Lab",
        );
      if (capture.dropped > 0 || capture.defects.length > 0)
        return missingCapture(
          "The Harness HTTP capture is incomplete; repeat in a fresh Lab",
        );
      const authored = await store.readFile(
        recipeDigest,
        AUTHORED_HTTP_FILE,
        5 * 1024 * 1024,
      );
      const route = routeSchema.safeParse(
        await readJson(store, recipeDigest, "route.json"),
      );
      const victim = route.success ? route.data.victim : undefined;
      const browser =
        victim === undefined
          ? undefined
          : await options.lab.observeVictimPages(lab, victim);
      const bound = {
        schemaVersion: 1,
        observerId: "wordpress-lab-browser",
        snapshotDigest: lab.snapshotDigest,
        labSetupDigest: lab.setupDigest,
      };
      const browserFiles: Record<string, string | Buffer> =
        browser === undefined
          ? {}
          : browser.status === "unavailable"
            ? {
                [LAB_BROWSER_OBSERVATION_FILE]: canonicalJson({
                  ...bound,
                  status: "visit-failed",
                  phase: browser.phase,
                  failureCode: browser.failureCode ?? "browser-visit",
                  ...(browser.files === undefined
                    ? {}
                    : { files: browser.files }),
                }),
                ...(browser.privateDiagnostic === undefined
                  ? {}
                  : { "browser-stderr.txt": browser.privateDiagnostic }),
              }
            : {
                [LAB_BROWSER_OBSERVATION_FILE]: canonicalJson({
                  ...bound,
                  status: "visited",
                  victimRole: browser.victimRole,
                  visits: victim?.paths.length ?? 0,
                  ...(browser.dialog === undefined
                    ? {}
                    : {
                        dialog: {
                          marker: browser.dialog.event.message,
                          visitIndex: browser.dialog.visitIndex,
                          event: browser.dialog.event,
                        },
                      }),
                  ...(browser.files === undefined
                    ? {}
                    : { files: browser.files }),
                }),
                ...(browser.dialog === undefined
                  ? {}
                  : {
                      "victim-page-after-dialog.png": browser.dialog.screenshot,
                    }),
                ...(browser.screenshot === undefined
                  ? {}
                  : { [VICTIM_SCREEN_FILE]: browser.screenshot }),
                ...(browser.victimBrowserDiagnostic === undefined
                  ? {}
                  : {
                      "victim-browser-diagnostic.json": canonicalJson(
                        browser.victimBrowserDiagnostic,
                      ),
                    }),
              };
      return {
        status: "recorded",
        evidenceDigest: await store.putFiles({
          [PROXY_CAPTURE_FILE]: capture.bytes,
          ...(authored.status === "resolved"
            ? { [AUTHORED_HTTP_FILE]: authored.bytes }
            : {}),
          ...browserFiles,
        }),
      };
    },
  };
}
