import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import {
  AUTHORED_HTTP_FILE,
  createWordPressHttpEvidenceReader,
  PROXY_CAPTURE_FILE,
} from "../../../src/profiles/wordpress/verification/http-evidence.js";

const QUERY_VALUE = "query-value-sentinel-33af";
const RESPONSE_BODY = "RESPONSE-BODY-SENTINEL-7b21";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-http-evidence-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  return { store, reader: createWordPressHttpEvidenceReader({ store }) };
}

function captureLine(method: string, path: string, statusCode: number) {
  return canonicalJson({
    request: {
      method,
      path,
      headers: { cookie: "session=secret" },
      body: "",
      bodyBase64: "",
      truncated: false,
    },
    response: {
      statusCode,
      headers: {},
      body: RESPONSE_BODY,
      bodyBase64: Buffer.from(RESPONSE_BODY).toString("base64"),
      truncated: false,
    },
  });
}

describe("WordPress HTTP evidence reader", () => {
  it("prefers the Harness capture, keeps parsable lines and hands over addresses only", async () => {
    const { store, reader } = await fixture();
    const digest = await store.putFiles({
      [PROXY_CAPTURE_FILE]: [
        captureLine(
          "POST",
          `/wp-admin/admin-ajax.php?token=${QUERY_VALUE}`,
          200,
        ),
        "not json",
        captureLine("GET", "/", 302),
      ].join("\n"),
      [AUTHORED_HTTP_FILE]: canonicalJson({ exchanges: [] }),
    });
    const record = await reader.read(digest);
    expect(record).toEqual({
      source: "harness-captured",
      path: join(store.contentPath(digest), PROXY_CAPTURE_FILE),
      exchanges: [
        {
          method: "POST",
          address: `/wp-admin/admin-ajax.php?token=${QUERY_VALUE}`,
          status: 200,
        },
        { method: "GET", address: "/", status: 302 },
      ],
    });
    expect(canonicalJson(record)).not.toContain(RESPONSE_BODY);
    expect(canonicalJson(record)).not.toContain("session=secret");
  });

  it("falls back to the Verifier's record and reports no record as null", async () => {
    const { store, reader } = await fixture();
    const authored = await store.putFiles({
      [AUTHORED_HTTP_FILE]: canonicalJson({
        exchanges: [
          {
            request: { method: "GET", url: "http://wordpress/?p=1" },
            response: { status: 200, body: RESPONSE_BODY },
          },
          { request: {}, response: { statusCode: 404 } },
        ],
      }),
    });
    expect(await reader.read(authored)).toEqual({
      source: "agent-authored",
      path: join(store.contentPath(authored), AUTHORED_HTTP_FILE),
      exchanges: [
        { method: "GET", address: "http://wordpress/?p=1", status: 200 },
        { method: "?", address: "", status: 404 },
      ],
    });
    const neither = await store.putFiles({ "route.json": "{}" });
    expect(await reader.read(neither)).toBeNull();
    expect(await reader.read(`sha256:${"0".repeat(64)}`)).toBeNull();
  });
});
