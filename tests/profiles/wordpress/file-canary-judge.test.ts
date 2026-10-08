import { describe, expect, it } from "vitest";

import type { WordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import type { WordPressCanaryFilesObservation } from "../../../src/profiles/wordpress/lab/index.js";
import { canaries, judgeOnce, quietLab, route } from "./judge-fixture.js";

const [outside, phpSource] = canaries.fileCanaries;
const exchange = (request: string, response: string) => ({
  request: { method: "GET", path: `/synthetic?file=${request}` },
  response: { status: 200, body: response },
});

function judge(options: {
  readonly impact?: WordPressFinding["impact"];
  readonly http?: unknown;
  readonly files?: WordPressCanaryFilesObservation;
}) {
  return judgeOnce({
    impact: options.impact ?? "arbitrary-file-read",
    lab: quietLab({
      async observeCanaryFiles() {
        return options.files ?? { status: "observed", deleted: [] };
      },
    }),
    files: {
      "route.json": JSON.stringify(route),
      "http.json": JSON.stringify(
        options.http ?? { exchanges: [exchange("1", "nothing")] },
      ),
    },
  });
}

describe("WordPress canary file judges", () => {
  it("maps read, download and LFI to the read judge, delete to the delete judge, and leaves RFI without one", async () => {
    for (const impact of [
      "arbitrary-file-read",
      "arbitrary-file-download",
      "lfi",
    ] as const)
      expect((await judge({ impact })).judgeId).toBe(
        "wordpress-file-canary-read",
      );
    expect((await judge({ impact: "arbitrary-file-delete" })).judgeId).toBe(
      "wordpress-file-canary-delete",
    );
    expect((await judge({ impact: "rfi" })).judgeId).toBeNull();
  });

  it("records full path and extension control when both canary files come back", async () => {
    const { observed } = await judge({
      http: {
        exchanges: [
          exchange("a", `contents: ${outside!.value}`),
          exchange("b", `<?php /* ${phpSource!.value} */`),
        ],
      },
    });
    expect(observed).toEqual({
      status: "observed",
      evidenceDigest: expect.stringMatching(/^sha256:/),
      conditions: {
        observedVia: "canary-file-read",
        canaryFilesRead: "outside-webroot,php-source",
        pathAndExtension: "attacker-chosen",
        attackerRole: "subscriber",
        defaultSettings: "true",
      },
    });
  });

  it("records partial control when only one canary file comes back", async () => {
    const { observed } = await judge({
      http: { exchanges: [exchange("a", outside!.value)] },
    });
    expect(observed).toMatchObject({
      status: "observed",
      conditions: {
        canaryFilesRead: "outside-webroot",
        pathAndExtension: "partial",
      },
    });
  });

  it.each([
    [
      "the path string reflected in an error",
      { exchanges: [exchange(outside!.path, `${outside!.path} not found`)] },
    ],
    [
      "a value the request itself carried",
      { exchanges: [exchange(outside!.value, `echo ${outside!.value}`)] },
    ],
  ])("does not fire on %s", async (_label, http) => {
    expect((await judge({ http })).observed).toEqual({
      status: "not-observed",
    });
  });

  it("observes a deleted canary file inside the Lab", async () => {
    const deleted = await judge({
      impact: "arbitrary-file-delete",
      files: { status: "observed", deleted: ["php-source"] },
    });
    expect(deleted.observed).toMatchObject({
      status: "observed",
      conditions: {
        observedVia: "canary-file-deleted",
        canaryFilesDeleted: "php-source",
        pathAndExtension: "partial",
      },
    });
    expect((await judge({ impact: "arbitrary-file-delete" })).observed).toEqual(
      { status: "not-observed" },
    );
    expect(
      (
        await judge({
          impact: "arbitrary-file-delete",
          files: { status: "unavailable" },
        })
      ).observed,
    ).toMatchObject({ status: "incomplete", reason: "observation" });
  });

  it("stays incomplete when the HTTP record cannot be read", async () => {
    expect((await judge({ http: [{ status: 200 }] })).observed).toMatchObject({
      status: "incomplete",
      reason: "evidence",
    });
  });
});
