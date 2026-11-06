import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_CONTINUATION_ID_DIGESTS,
  continuationIdDigest,
  continuationMadeNoProgress,
  inspectContinuation,
} from "../../src/discovery/index.js";

const route = (id: string, overrides: object = {}) => ({
  id,
  sourceFile: "includes/class-ajax.php",
  sourceLine: 40,
  observation: "o",
  unresolved: "u",
  nextCheck: "n",
  ...overrides,
});

const archive = (entries: readonly object[]) =>
  Buffer.from(
    JSON.stringify({
      kind: "research-directory-archive",
      schemaVersion: 1,
      entries,
    }),
  );

const withFile = (content: string | object, extra: object = {}) =>
  archive([
    { path: "recon-map.md", type: "file", contentBase64: "" },
    {
      path: "continuation.json",
      type: "file",
      contentBase64: Buffer.from(
        typeof content === "string" ? content : JSON.stringify(content),
      ).toString("base64"),
      ...extra,
    },
  ]);

describe("the continuation.json shape check (ADR 0052)", () => {
  it("records a valid file by count and id digests only", () => {
    const record = inspectContinuation(
      withFile({ schemaVersion: 1, openRoutes: [route("a"), route("b")] }),
    );
    expect(record).toEqual({
      status: "valid",
      openRouteCount: 2,
      openRouteIdDigests: [
        continuationIdDigest("a"),
        continuationIdDigest("b"),
      ],
    });
    expect(continuationIdDigest("a")).toBe(
      `sha256:${createHash("sha256").update("a").digest("hex")}`,
    );
  });

  it("accepts an empty list as valid with no open route", () => {
    expect(
      inspectContinuation(withFile({ schemaVersion: 1, openRoutes: [] })),
    ).toEqual({ status: "valid", openRouteCount: 0, openRouteIdDigests: [] });
  });

  it("is absent when the archive has no continuation.json at the root", () => {
    expect(
      inspectContinuation(
        archive([
          { path: "prior", type: "directory" },
          {
            path: "prior/continuation.json",
            type: "file",
            contentBase64: "",
          },
        ]),
      ),
    ).toEqual({ status: "absent" });
  });

  it.each([
    ["not JSON", "{"],
    ["another schema version", { schemaVersion: 2, openRoutes: [] }],
    [
      "an extra key at the top",
      { schemaVersion: 1, openRoutes: [], closedRoutes: [] },
    ],
    [
      "an extra key on a route",
      { schemaVersion: 1, openRoutes: [route("a", { needs: "lab" })] },
    ],
    [
      "an absolute sourceFile",
      { schemaVersion: 1, openRoutes: [route("a", { sourceFile: "/etc/x" })] },
    ],
    [
      "a sourceFile starting with ..",
      {
        schemaVersion: 1,
        openRoutes: [route("a", { sourceFile: "../core.php" })],
      },
    ],
    [
      "a line that is not a positive integer",
      { schemaVersion: 1, openRoutes: [route("a", { sourceLine: 0 })] },
    ],
    [
      "an id longer than 128",
      { schemaVersion: 1, openRoutes: [route("x".repeat(129))] },
    ],
    ["an empty id", { schemaVersion: 1, openRoutes: [route("")] }],
    [
      "a missing text field",
      {
        schemaVersion: 1,
        openRoutes: [{ ...route("a"), nextCheck: undefined }],
      },
    ],
  ])("is invalid with %s", (_name, content) => {
    expect(inspectContinuation(withFile(content))).toEqual({
      status: "invalid",
    });
  });

  it("is invalid when the sealed file was cut", () => {
    expect(
      inspectContinuation(
        withFile({ schemaVersion: 1, openRoutes: [] }, { truncated: true }),
      ),
    ).toEqual({ status: "invalid" });
  });

  it("records nothing when the archive itself is unreadable", () => {
    expect(inspectContinuation(Buffer.from("not json"))).toBeUndefined();
  });

  it("keeps the first 64 id digests and marks the cut, still valid", () => {
    const routes = Array.from({ length: 70 }, (_, index) =>
      route(`route-${index}`),
    );
    const record = inspectContinuation(
      withFile({ schemaVersion: 1, openRoutes: routes }),
    );
    expect(record).toMatchObject({
      status: "valid",
      openRouteCount: 70,
      truncated: true,
    });
    if (record?.status !== "valid") throw new Error("not valid");
    expect(record.openRouteIdDigests).toHaveLength(MAX_CONTINUATION_ID_DIGESTS);
    expect(record.openRouteIdDigests[63]).toBe(
      continuationIdDigest("route-63"),
    );
    const exact = inspectContinuation(
      withFile({ schemaVersion: 1, openRoutes: routes.slice(0, 64) }),
    );
    expect(exact).not.toHaveProperty("truncated");
  });

  it("finds no progress only when every received id is still open", () => {
    const [a, b, c] = ["a", "b", "c"].map(continuationIdDigest) as [
      string,
      string,
      string,
    ];
    expect(continuationMadeNoProgress([a, b], [a, b, c])).toBe(true);
    expect(continuationMadeNoProgress([a, b], [b, a])).toBe(true);
    expect(continuationMadeNoProgress([a, b], [a, c])).toBe(false);
    expect(continuationMadeNoProgress([a], [])).toBe(false);
  });
});
