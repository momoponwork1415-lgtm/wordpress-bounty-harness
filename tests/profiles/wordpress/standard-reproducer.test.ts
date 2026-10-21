import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { httpCapture } from "../../../src/lab/capture.js";
import { createWordPressStandardReproducer } from "../../../src/profiles/wordpress/verification/standard-reproducer.js";
import { canaries, finding, handle, route } from "./judge-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const value = canaries.sqlCanary.value;
const responseBody = `row:${value}`;

function exchange(requestBody: string, body = responseBody): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      request: {
        method: "GET",
        path: "/synthetic",
        headers: {},
        body: requestBody,
        bodyBase64: Buffer.from(requestBody).toString("base64"),
        truncated: false,
      },
      response: {
        statusCode: 200,
        headers: {},
        body,
        bodyBase64: Buffer.from(body).toString("base64"),
        truncated: false,
      },
    })}\n`,
  );
}

async function observe(input: {
  readonly impact?: Parameters<typeof finding>[0];
  readonly requestBody?: string;
  readonly responseBody?: string;
  readonly capture?: Buffer | null;
  readonly outputHash?: string;
  readonly scriptSaysExpected?: boolean;
  readonly referenceRoute?: unknown;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-standard-reproducer-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const recipeDigest = await store.putFiles({
    "route.json": JSON.stringify(route),
  });
  const body = input.responseBody ?? responseBody;
  const capture =
    input.capture === undefined
      ? exchange(input.requestBody ?? "", body)
      : input.capture;
  const reproducer = createWordPressStandardReproducer({
    store,
    lab: {
      canaryLedger: () => canaries,
      async markCapture() {
        return "0";
      },
      async readCapture() {
        return capture === null
          ? { status: "unavailable" as const }
          : { status: "captured" as const, ...httpCapture(capture, 0) };
      },
      async runStandardScript(_, scriptInput) {
        expect(JSON.parse(scriptInput)).toMatchObject({
          role: "subscriber",
          canaries: [value],
          steps: route.steps,
        });
        return {
          status: "completed" as const,
          output: JSON.stringify({
            schemaVersion: 1,
            stepResults: [
              {
                index: 0,
                statusCode: 200,
                bodySha256:
                  input.outputHash ??
                  createHash("sha256").update(body).digest("hex"),
                containsExpected:
                  input.scriptSaysExpected ?? body.includes(value),
              },
            ],
          }),
        };
      },
    },
  });
  const result = await reproducer.observe({
    finding: finding(input.impact ?? "sqli"),
    lab: handle,
    recipeDigest,
    ...(input.referenceRoute === undefined
      ? {}
      : { referenceRoute: input.referenceRoute }),
  });
  return { result, store, reproducer };
}

describe("Harness standard HTTP reproducer", () => {
  it("declares support only for effects proved by a captured HTTP response canary", async () => {
    const { reproducer } = await observe({});
    for (const impact of [
      "sqli",
      "sensitive-object-access",
      "arbitrary-file-read",
      "arbitrary-file-download",
      "lfi",
    ] as const)
      expect(reproducer.supports(finding(impact))).toBe(true);
    for (const impact of [
      "stored-xss",
      "account-takeover",
      "rce",
      "options-update",
    ] as const)
      expect(reproducer.supports(finding(impact))).toBe(false);
  });

  it("requires the executed script and the fresh proxy capture to agree on the canary", async () => {
    const { result, store } = await observe({});
    expect(result).toMatchObject({
      status: "observed",
      conditions: {
        observedVia: "canary-row-read",
        reproductionMethod: "standard-python-v1",
      },
    });
    if (result.status !== "observed") return;
    expect(
      (
        await store.readFile(
          result.evidenceDigest,
          "standard-reproduce.py",
          100_000,
        )
      ).status,
    ).toBe("resolved");
    expect(
      (
        await store.readFile(
          result.evidenceDigest,
          "proxy-capture.jsonl",
          100_000,
        )
      ).status,
    ).toBe("resolved");
    expect(
      (
        await store.readFile(
          result.evidenceDigest,
          "structured-output.json",
          100_000,
        )
      ).status,
    ).toBe("resolved");
  });

  it.each([
    value,
    encodeURIComponent(value).replaceAll("c", "%63"),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("hex"),
  ])(
    "does not reproduce a canary supplied by the request",
    async (requestBody) => {
      expect((await observe({ requestBody })).result).toMatchObject({
        status: "incomplete",
        reason: "observation",
      });
    },
  );

  it("does not trust structured success without a captured response", async () => {
    expect(
      (await observe({ capture: null, scriptSaysExpected: true })).result,
    ).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("requires the captured response bytes to match the script output", async () => {
    expect(
      (await observe({ outputHash: "0".repeat(64) })).result,
    ).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });

  it("records an absent canary only after replaying the reference route", async () => {
    expect(
      (await observe({ responseBody: "no canary", referenceRoute: route }))
        .result,
    ).toMatchObject({
      status: "not-observed",
    });
  });

  it("does not contradict a fixed release when the comparison changes the submitted body", async () => {
    expect(
      (
        await observe({
          responseBody: "no canary",
          referenceRoute: {
            ...route,
            steps: [{ ...route.steps[0], body: "changed-payload" }],
          },
        })
      ).result,
    ).toMatchObject({ status: "incomplete", reason: "observation" });
  });

  it("keeps browser-executed effects incomplete without a browser observer", async () => {
    expect((await observe({ impact: "stored-xss" })).result).toMatchObject({
      status: "incomplete",
      reason: "observation",
    });
  });
});
