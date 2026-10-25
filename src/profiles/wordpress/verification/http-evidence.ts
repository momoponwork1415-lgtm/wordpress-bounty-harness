import { join } from "node:path";

import { z } from "zod";

import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import { parseHttpCapture } from "../../../lab/capture.js";
import type { HttpEvidenceReader } from "../../../review/index.js";

/**
 * The two HTTP records a WordPress verification leaves in Private Evidence.
 * The Harness-captured one holds the Lab recorder's lines (format:
 * `src/lab/capture.ts`); the agent-authored one is the Verifier's own
 * `http.json`, kept for comparison and never as proof.
 */
export const PROXY_CAPTURE_FILE = "proxy-capture.jsonl";
export const AUTHORED_HTTP_FILE = "http.json";
/**
 * The Harness marks a recipe whose capture starts at `setup-done`, after an
 * administrator prepared the Lab (#430). Only that capture is kept as the
 * Harness record of the attack.
 */
export const SETUP_BOUNDARY_FILE = "setup-boundary.json";

const PROXY_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
const AUTHORED_HTTP_MAX_BYTES = 5 * 1024 * 1024;

const authoredHttpSchema = z.looseObject({
  exchanges: z.array(
    z.looseObject({
      request: z.looseObject({
        method: z.string().optional(),
        url: z.string().optional(),
        path: z.string().optional(),
      }),
      response: z
        .looseObject({
          status: z.number().int().optional(),
          statusCode: z.number().int().optional(),
        })
        .optional(),
    }),
  ),
});

/**
 * Reads a verification's HTTP evidence for `review export`: the captured record when
 * the Harness recorded one, else the Verifier's record. Only method, address
 * and status leave this module; Review strips query values and bodies never
 * appear. A capture line that does not parse is left out, not fatal.
 */
export function createWordPressHttpEvidenceReader(options: {
  readonly store: PrivateArtifactStore;
}): HttpEvidenceReader {
  const { store } = options;
  return {
    async read(evidenceDigest) {
      const captured = await store.readFile(
        evidenceDigest,
        PROXY_CAPTURE_FILE,
        PROXY_CAPTURE_MAX_BYTES,
      );
      if (captured.status === "resolved")
        return {
          source: "harness-captured",
          path: join(store.contentPath(evidenceDigest), PROXY_CAPTURE_FILE),
          exchanges: parseHttpCapture(captured.bytes).exchanges.map(
            (exchange) => ({
              method: exchange.request.method,
              address: exchange.request.path,
              status: exchange.response.statusCode,
            }),
          ),
        };
      const authored = await store.readJson(
        evidenceDigest,
        AUTHORED_HTTP_FILE,
        authoredHttpSchema,
        AUTHORED_HTTP_MAX_BYTES,
      );
      if (authored.status !== "resolved") return null;
      return {
        source: "agent-authored",
        path: join(store.contentPath(evidenceDigest), AUTHORED_HTTP_FILE),
        exchanges: authored.value.exchanges.map((exchange) => ({
          method: exchange.request.method ?? "?",
          address: exchange.request.url ?? exchange.request.path ?? "",
          status:
            exchange.response?.statusCode ?? exchange.response?.status ?? null,
        })),
      };
    },
  };
}
