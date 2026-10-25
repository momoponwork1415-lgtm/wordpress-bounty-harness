import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * The exploration Lab's control endpoint (`labctl`, ADR 0003 addendum
 * 2026-10-25). It runs alone in the Lab's pinned Node image on the Lab
 * network, so nothing here may import outside `src/lab/control/`. It decides
 * nothing: every command is written to its state directory, the Harness on
 * the host reads it with `docker exec … next`, acts, and writes the answer
 * back with `docker exec … answer`. The server then returns that answer.
 */
export const CONTROL_STATE_DIRECTORY = "/var/lib/wbh-control";
/** The commands the endpoint relays; anything else is answered 404 here. */
export const CONTROL_COMMANDS = ["reset", "observe"] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];
/** The largest request body relayed; the host validates its shape. */
export const MAX_CONTROL_BODY_BYTES = 16 * 1024;

export interface ControlRequest {
  readonly id: string;
  readonly command: ControlCommand;
  readonly receivedAt: string;
  /** The parsed JSON body, when the request had one; never interpreted here. */
  readonly body?: unknown;
}

export interface ControlAnswer {
  readonly statusCode: number;
  readonly body: Readonly<Record<string, unknown>>;
}

const REQUEST_FILE = "request.json";
const answerFile = (id: string) => `answer-${id}.json`;
const ID = /^[a-f0-9]{32}$/;

function writeAtomically(path: string, text: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function reply(
  response: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

/** One command at a time; a second one while the first waits is refused as busy. */
export function createControlServer(options: {
  readonly directory: string;
  readonly answerTimeoutMs?: number;
  readonly pollMs?: number;
  readonly clock?: () => Date;
}): Server {
  const timeoutMs = options.answerTimeoutMs ?? 20 * 60_000;
  const pollMs = options.pollMs ?? 250;
  const clock = options.clock ?? (() => new Date());
  let busy = false;
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const command = CONTROL_COMMANDS.find((name) => path === `/${name}`);
    if (request.method !== "POST" || command === undefined) {
      request.resume();
      reply(response, 404, {
        status: "unknown-command",
        commands: CONTROL_COMMANDS.map((name) => `POST /${name}`),
      });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CONTROL_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reply(response, 413, {
          status: "body-too-large",
          maxBytes: MAX_CONTROL_BODY_BYTES,
        });
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      let body: unknown;
      if (text !== "")
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          reply(response, 400, { status: "invalid-json" });
          return;
        }
      relay(response, command, body);
    });
  });
  return server;

  function relay(
    response: ServerResponse,
    command: ControlCommand,
    body: unknown,
  ): void {
    if (busy) {
      reply(response, 409, { status: "busy" });
      return;
    }
    busy = true;
    const id = randomBytes(16).toString("hex");
    const pending: ControlRequest = {
      id,
      command,
      receivedAt: clock().toISOString(),
      ...(body === undefined ? {} : { body }),
    };
    writeAtomically(
      join(options.directory, REQUEST_FILE),
      JSON.stringify(pending),
    );
    const deadline = Date.now() + timeoutMs;
    const answerPath = join(options.directory, answerFile(id));
    const finish = (answer: ControlAnswer) => {
      rmSync(join(options.directory, REQUEST_FILE), { force: true });
      rmSync(answerPath, { force: true });
      busy = false;
      reply(response, answer.statusCode, answer.body);
    };
    const poll = () => {
      if (existsSync(answerPath)) {
        let answer: ControlAnswer;
        try {
          answer = JSON.parse(
            readFileSync(answerPath, "utf8"),
          ) as ControlAnswer;
        } catch {
          answer = { statusCode: 500, body: { status: "unreadable-answer" } };
        }
        finish(answer);
        return;
      }
      if (Date.now() >= deadline) {
        finish({ statusCode: 504, body: { status: "no-answer" } });
        return;
      }
      setTimeout(poll, pollMs);
    };
    poll();
  }
}

/** The pending command, or null; the host calls this through `docker exec`. */
export async function nextControlRequest(
  directory: string,
  waitMs: number,
  pollMs = 250,
): Promise<ControlRequest | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const path = join(directory, REQUEST_FILE);
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as ControlRequest;
        if (
          ID.test(parsed.id) &&
          !existsSync(join(directory, answerFile(parsed.id)))
        )
          return parsed;
      } catch {
        // A request is renamed into place whole; an unreadable one is not ours.
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Writes the host's answer for one pending command. */
export function answerControlRequest(
  directory: string,
  id: string,
  answer: ControlAnswer,
): void {
  if (!ID.test(id)) throw new Error("Control request id is invalid");
  writeAtomically(join(directory, answerFile(id)), JSON.stringify(answer));
}
