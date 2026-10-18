import { z } from "zod";

/**
 * The read side of the Lab HTTP recorder: the one place that knows what a
 * capture line looks like, how to parse a capture file and what its
 * truncation and dropped counts mean. The recorder (`./recorder/`) writes the
 * lines; it runs alone inside the Lab image and cannot depend on this module.
 * Profiles store the bytes as evidence and decide from the parsed exchanges;
 * neither re-declares the line shape.
 */
export {
  RECORDER_CAPTURE_PATH,
  RECORDER_DROPPED_PATH,
  RECORDER_STATE_DIRECTORY,
} from "./recorder/index.js";

/**
 * One recorded exchange. Bodies are UTF-8 text plus the exact bytes in
 * base64; `truncated` says a body hit the recorder's per-body limit, so its
 * contents cannot serve as evidence. Headers stay unknown-valued: the recorder
 * writes Node's header map, and every judge checks the type it needs.
 */
export const capturedExchangeSchema = z.strictObject({
  request: z.looseObject({
    method: z.string(),
    path: z.string(),
    headers: z.record(z.string(), z.unknown()),
    body: z.string(),
    bodyBase64: z.string(),
    truncated: z.boolean(),
  }),
  response: z.looseObject({
    statusCode: z.number().int(),
    headers: z.record(z.string(), z.unknown()),
    body: z.string(),
    bodyBase64: z.string(),
    truncated: z.boolean(),
  }),
});
/** The parsed line; `tests/lab/capture.test.ts` pins that every `RecordedExchange` is one. */
export type CapturedExchange = z.infer<typeof capturedExchangeSchema>;

/** A line that cannot serve as evidence, in file order. */
export type CaptureDefect = {
  /** One-based line number in the capture file. */
  readonly line: number;
  readonly kind:
    /** Not JSON. */
    | "unreadable"
    /** JSON, but not an exchange. */
    | "shape"
    /** An exchange whose request or response body hit the recorder's limit. */
    | "truncated";
};

export interface ParsedHttpCapture {
  /** Every line that parsed, including truncated ones; defects list those too. */
  readonly exchanges: readonly CapturedExchange[];
  readonly defects: readonly CaptureDefect[];
}

/** What the Lab hands back for one capture window. */
export interface HttpCapture extends ParsedHttpCapture {
  /** The recorder's lines as written; Private Evidence stores exactly these. */
  readonly bytes: Buffer;
  /** Exchanges the recorder refused once the capture file reached its cap. */
  readonly dropped: number;
}

export type HttpCaptureRead =
  | ({ readonly status: "captured" } & HttpCapture)
  | { readonly status: "unavailable" };

/**
 * Parses a capture file. Empty bytes are an empty capture; otherwise every
 * line must be one exchange. A defective line is reported, not skipped, so a
 * caller that needs evidence can refuse the whole capture while a caller that
 * only summarizes can still read the exchanges that parsed.
 */
export function parseHttpCapture(bytes: Buffer): ParsedHttpCapture {
  const text = bytes.toString("utf8");
  if (text.length === 0) return { exchanges: [], defects: [] };
  const exchanges: CapturedExchange[] = [];
  const defects: CaptureDefect[] = [];
  for (const [index, line] of text.trimEnd().split("\n").entries()) {
    const number = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      defects.push({ line: number, kind: "unreadable" });
      continue;
    }
    const exchange = capturedExchangeSchema.safeParse(parsed);
    if (!exchange.success) {
      defects.push({ line: number, kind: "shape" });
      continue;
    }
    if (exchange.data.request.truncated || exchange.data.response.truncated)
      defects.push({ line: number, kind: "truncated" });
    exchanges.push(exchange.data);
  }
  return { exchanges, defects };
}

/** Pairs the recorder's bytes and dropped count with their parsed form. */
export function httpCapture(bytes: Buffer, dropped: number): HttpCapture {
  return { bytes, dropped, ...parseHttpCapture(bytes) };
}
