import { request, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BODY_LIMIT_BYTES = 1024 * 1024;
const INPUT_LIMIT_BYTES = 32 * BODY_LIMIT_BYTES;
const MAX_BINDING_BYTES = 4096;
const BINDING_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;
const SAFE_PATTERN =
  /^(?:\^)?(?:\[[^\]\r\n]{1,96}\]|\\[dws]|[A-Za-z0-9._~-])(?:[+*?]|\{[0-9]{1,4}(?:,[0-9]{1,4})?\})?(?:\$)?$/;

type Reason =
  | "invalid-input"
  | "missing-binding"
  | "ambiguous-binding"
  | "binding-pattern"
  | "request-failed"
  | "response-too-large";

/** A step counts after its entire HTTP response arrived, even if extraction then failed. */
export type ReplayResult =
  | { readonly status: "completed"; readonly completedSteps: number }
  | {
      readonly status: "incomplete";
      readonly completedSteps: number;
      readonly reason: Reason;
    };

type BindingAfter = {
  readonly name: string;
  readonly left: string;
  readonly right: string;
  readonly occurrence: "unique" | "last";
  readonly pattern?: RegExp;
};
type Step = {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly bindingsAfter: readonly BindingAfter[];
};
type ReplayInput = {
  readonly steps: readonly Step[];
  readonly initialBindings: ReadonlyMap<string, string>;
};

class ReplayFailure extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;

function parseBinding(value: unknown): BindingAfter {
  if (!record(value)) throw new ReplayFailure("invalid-input");
  const { name, left, right, pattern, occurrence = "unique" } = value;
  if (
    typeof name !== "string" ||
    !BINDING_NAME.test(name) ||
    !text(left, 512) ||
    left.length === 0 ||
    !text(right, 512) ||
    right.length === 0 ||
    (occurrence !== "unique" && occurrence !== "last")
  )
    throw new ReplayFailure("invalid-input");
  if (pattern === undefined) return { name, left, right, occurrence };
  // A single character class and one optional repetition cannot contain a
  // nested or alternating expression that would backtrack on a response body.
  if (typeof pattern !== "string" || !SAFE_PATTERN.test(pattern))
    throw new ReplayFailure("invalid-input");
  try {
    return {
      name,
      left,
      right,
      occurrence,
      pattern: new RegExp(`^(?:${pattern})$`, "u"),
    };
  } catch {
    throw new ReplayFailure("invalid-input");
  }
}

function parseInput(value: unknown): ReplayInput {
  if (
    !record(value) ||
    !Array.isArray(value.steps) ||
    !record(value.initialBindings)
  )
    throw new ReplayFailure("invalid-input");
  if (value.steps.length < 1 || value.steps.length > 30)
    throw new ReplayFailure("invalid-input");
  if (Object.keys(value.initialBindings).length > 128)
    throw new ReplayFailure("invalid-input");
  const initialBindings = new Map<string, string>();
  for (const [name, binding] of Object.entries(value.initialBindings)) {
    if (!BINDING_NAME.test(name) || !text(binding, MAX_BINDING_BYTES))
      throw new ReplayFailure("invalid-input");
    initialBindings.set(name, binding);
  }
  const steps: Step[] = value.steps.map((entry: unknown) => {
    if (!record(entry)) throw new ReplayFailure("invalid-input");
    const { method, path, body } = entry;
    if (
      typeof method !== "string" ||
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      !text(path, 4096)
    )
      throw new ReplayFailure("invalid-input");
    let normalizedBody: string | undefined;
    if (body !== undefined) {
      if (!text(body, BODY_LIMIT_BYTES))
        throw new ReplayFailure("invalid-input");
      normalizedBody = body;
    }
    const headers: Record<string, string> = {};
    if (entry.headers !== undefined) {
      if (!record(entry.headers) || Object.keys(entry.headers).length > 64)
        throw new ReplayFailure("invalid-input");
      const headerNames = new Set<string>();
      for (const [name, header] of Object.entries(entry.headers)) {
        const normalizedName = name.toLowerCase();
        if (
          !HEADER_NAME.test(name) ||
          !text(header, 8192) ||
          /[\r\n\0]/.test(header) ||
          headerNames.has(normalizedName) ||
          [
            "cookie",
            "cookie2",
            "set-cookie",
            "content-length",
            "transfer-encoding",
          ].includes(normalizedName)
        )
          throw new ReplayFailure("invalid-input");
        headerNames.add(normalizedName);
        headers[name] = header;
      }
    }
    const after = entry.bindingsAfter ?? [];
    if (!Array.isArray(after) || after.length > 30)
      throw new ReplayFailure("invalid-input");
    const bindingsAfter = after.map(parseBinding);
    if (
      new Set(bindingsAfter.map((binding) => binding.name)).size !==
      bindingsAfter.length
    )
      throw new ReplayFailure("invalid-input");
    return {
      method,
      path,
      headers,
      ...(normalizedBody === undefined ? {} : { body: normalizedBody }),
      bindingsAfter,
    };
  });
  return { steps, initialBindings };
}

function interpolate(
  value: string,
  bindings: ReadonlyMap<string, string>,
): string {
  const expanded = value.replace(PLACEHOLDER, (_match, name: string) => {
    const binding = bindings.get(name);
    if (binding === undefined) throw new ReplayFailure("missing-binding");
    return binding;
  });
  if (expanded.includes("{{") || expanded.includes("}}"))
    throw new ReplayFailure("missing-binding");
  return expanded;
}

function extractBinding(body: string, binding: BindingAfter): string {
  const candidates: string[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const left = body.indexOf(binding.left, cursor);
    if (left < 0) break;
    const begin = left + binding.left.length;
    const right = body.indexOf(binding.right, begin);
    if (
      right < 0 ||
      (body.indexOf(binding.left, begin) >= 0 &&
        body.indexOf(binding.left, begin) < right)
    )
      throw new ReplayFailure("ambiguous-binding");
    candidates.push(body.slice(begin, right));
    cursor = right + binding.right.length;
  }
  if (
    candidates.length === 0 ||
    (binding.occurrence === "unique" && candidates.length !== 1)
  )
    throw new ReplayFailure("ambiguous-binding");
  const value = candidates.at(-1) ?? "";
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_BINDING_BYTES
  )
    throw new ReplayFailure("ambiguous-binding");
  if (binding.pattern !== undefined && !binding.pattern.test(value))
    throw new ReplayFailure("binding-pattern");
  return value;
}

function rememberCookies(
  headers: IncomingMessage["headers"],
  cookies: Map<string, string>,
): void {
  for (const line of headers["set-cookie"] ?? []) {
    const pair = line.split(";", 1)[0] ?? "";
    const equals = pair.indexOf("=");
    if (equals < 1) continue;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (!HEADER_NAME.test(name) || /[\r\n;]/.test(value)) continue;
    if (/;\s*max-age\s*=\s*0(?:;|$)/i.test(line)) cookies.delete(name);
    else cookies.set(name, value);
  }
}

type Response =
  | {
      readonly status: "received";
      readonly body: string;
      readonly headers: IncomingMessage["headers"];
    }
  | { readonly status: "request-failed" | "response-too-large" };

/** The TCP destination is fixed to loopback; the caller may choose only its port. */
function send(
  port: number,
  step: Step,
  path: string,
  headers: Readonly<Record<string, string>>,
  body: string | undefined,
): Promise<Response> {
  return new Promise((resolveResult) => {
    let settled = false;
    const done = (result: Response) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        method: step.method,
        path,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : { "Content-Length": Buffer.byteLength(body, "utf8") }),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > BODY_LIMIT_BYTES) {
            incoming.destroy();
            done({ status: "response-too-large" });
          } else chunks.push(chunk);
        });
        incoming.on("end", () =>
          done({
            status: "received",
            body: Buffer.concat(chunks).toString("utf8"),
            headers: incoming.headers,
          }),
        );
        incoming.on("error", () => done({ status: "request-failed" }));
      },
    );
    outgoing.on("error", () => done({ status: "request-failed" }));
    outgoing.setTimeout(30_000, () => outgoing.destroy());
    outgoing.end(body);
  });
}

/** Replays bounded HTTP steps through a loopback recorder without returning secrets. */
export async function runHttpReplay(
  value: unknown,
  options: { readonly port?: number } = {},
): Promise<ReplayResult> {
  let completedSteps = 0;
  try {
    const input = parseInput(value);
    const port = options.port ?? 80;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new ReplayFailure("invalid-input");
    const bindings = new Map(input.initialBindings);
    const cookies = new Map<string, string>();
    for (const step of input.steps) {
      const path = interpolate(step.path, bindings);
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        /[\r\n\0#\\]/.test(path) ||
        Buffer.byteLength(path, "utf8") > 4096
      )
        throw new ReplayFailure("invalid-input");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(step.headers)) {
        const expanded = interpolate(value, bindings);
        if (
          Buffer.byteLength(expanded, "utf8") > 8192 ||
          /[\r\n\0]/.test(expanded)
        )
          throw new ReplayFailure("invalid-input");
        headers[name] = expanded;
      }
      if (cookies.size > 0)
        headers.Cookie = [...cookies]
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
      const body =
        step.body === undefined ? undefined : interpolate(step.body, bindings);
      if (
        body !== undefined &&
        Buffer.byteLength(body, "utf8") > BODY_LIMIT_BYTES
      )
        throw new ReplayFailure("invalid-input");
      const response = await send(port, step, path, headers, body);
      if (response.status !== "received")
        throw new ReplayFailure(response.status);
      completedSteps++;
      rememberCookies(response.headers, cookies);
      for (const binding of step.bindingsAfter)
        bindings.set(binding.name, extractBinding(response.body, binding));
    }
    return { status: "completed", completedSteps };
  } catch (error) {
    return {
      status: "incomplete",
      completedSteps,
      reason: error instanceof ReplayFailure ? error.reason : "request-failed",
    };
  }
}

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > INPUT_LIMIT_BYTES) throw new ReplayFailure("invalid-input");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function main(): Promise<void> {
  let result: ReplayResult;
  try {
    result = await runHttpReplay(await readInput());
  } catch {
    result = {
      status: "incomplete",
      completedSteps: 0,
      reason: "invalid-input",
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "incomplete") process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main();
