import { describe, expect, expectTypeOf, it } from "vitest";

import {
  capturedExchangeSchema,
  httpCapture,
  parseHttpCapture,
  RECORDER_CAPTURE_PATH,
  RECORDER_DROPPED_PATH,
  RECORDER_STATE_DIRECTORY,
  type CapturedExchange,
} from "../../src/lab/capture.js";
import type { RecordedExchange } from "../../src/lab/recorder/index.js";

function line(
  overrides: {
    readonly request?: Partial<RecordedExchange["request"]>;
    readonly response?: Partial<RecordedExchange["response"]>;
  } = {},
): string {
  const record: RecordedExchange = {
    request: {
      method: "GET",
      path: "/synthetic?x=1",
      headers: { host: "wordpress" },
      body: "",
      bodyBase64: "",
      truncated: false,
      ...overrides.request,
    },
    response: {
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: "ok",
      bodyBase64: Buffer.from("ok").toString("base64"),
      truncated: false,
      ...overrides.response,
    },
  };
  return `${JSON.stringify(record)}\n`;
}

describe("Lab HTTP capture format", () => {
  it("parses what the recorder writes, line by line, in order", () => {
    // Every record the recorder writes is a CapturedExchange (one owner for the shape).
    expectTypeOf<RecordedExchange>().toExtend<CapturedExchange>();
    const parsed = parseHttpCapture(
      Buffer.from(line() + line({ request: { method: "POST", path: "/b" } })),
    );
    expect(parsed.defects).toEqual([]);
    expect(
      parsed.exchanges.map((exchange) => [
        exchange.request.method,
        exchange.request.path,
        exchange.response.statusCode,
      ]),
    ).toEqual([
      ["GET", "/synthetic?x=1", 200],
      ["POST", "/b", 200],
    ]);
    expect(capturedExchangeSchema.safeParse({ request: {} }).success).toBe(
      false,
    );
  });

  it("treats empty bytes as no exchanges and keeps the recorder paths together", () => {
    expect(parseHttpCapture(Buffer.alloc(0))).toEqual({
      exchanges: [],
      defects: [],
    });
    expect(RECORDER_CAPTURE_PATH).toBe(
      `${RECORDER_STATE_DIRECTORY}/capture.jsonl`,
    );
    expect(RECORDER_DROPPED_PATH).toBe(`${RECORDER_STATE_DIRECTORY}/dropped`);
  });

  it("reports defective lines by number and kind instead of skipping them", () => {
    const bytes = Buffer.from(
      line() +
        "not json\n" +
        '{"request":{},"response":{}}\n' +
        line({ response: { truncated: true } }),
    );
    const parsed = parseHttpCapture(bytes);
    expect(parsed.defects).toEqual([
      { line: 2, kind: "unreadable" },
      { line: 3, kind: "shape" },
      { line: 4, kind: "truncated" },
    ]);
    // A truncated exchange still parses; the defect tells evidence readers to refuse it.
    expect(parsed.exchanges).toHaveLength(2);
    // A lone newline is one unreadable line, not an empty capture.
    expect(parseHttpCapture(Buffer.from("\n")).defects).toEqual([
      { line: 1, kind: "unreadable" },
    ]);
  });

  it("keeps the raw bytes and dropped count next to the parsed form", () => {
    const bytes = Buffer.from(line());
    const capture = httpCapture(bytes, 3);
    expect(capture.bytes).toBe(bytes);
    expect(capture.dropped).toBe(3);
    expect(capture.exchanges).toHaveLength(1);
    expect(capture.defects).toEqual([]);
  });
});
