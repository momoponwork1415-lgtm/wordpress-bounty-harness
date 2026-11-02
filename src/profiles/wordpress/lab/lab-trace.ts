import { z } from "zod";

import { wordpressVisitPathSchema } from "./lab-observation.js";
import type { WordPressLabSession } from "./lab-session.js";

/**
 * The exploration Lab's function trace (ADR 0049): `POST /trace` names one
 * HTTP request, the Harness sends it to the site from inside the WordPress
 * container with Xdebug's trace trigger, and answers with the functions the
 * request ran inside the plugin directories. The trigger value is the Lab
 * session's secret; Xdebug reads it only from GET, POST, cookie or the
 * environment (never a header), so it travels as a cookie on that one
 * request. Nothing here judges; the answer is an observation.
 */

export const TRACE_METHODS = ["GET", "POST"] as const;
export const TRACE_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "application/json",
  "text/plain",
] as const;
export const MAX_TRACE_BODY_CHARACTERS = 8192;
export const MAX_TRACE_ENTRIES = 2000;

export const wordpressExplorationTraceSchema = z.strictObject({
  method: z.enum(TRACE_METHODS),
  path: wordpressVisitPathSchema,
  cookie: z
    .string()
    .max(4096)
    .regex(/^[\x21-\x7e ]*$/)
    .optional(),
  contentType: z.enum(TRACE_CONTENT_TYPES).optional(),
  body: z.string().max(MAX_TRACE_BODY_CHARACTERS).optional(),
});
export type WordPressExplorationTraceRequest = z.infer<
  typeof wordpressExplorationTraceSchema
>;

/** One function entry of the trace: call depth, name, file relative to the site root, line. */
export type WordPressTraceEntry = {
  readonly depth: number;
  readonly function: string;
  readonly file: string;
  readonly line: number;
};

export type WordPressExplorationTraceResult =
  | {
      readonly status: "traced";
      readonly httpStatus: number;
      /** Plugin entries in call order, at most 2000. */
      readonly entries: readonly WordPressTraceEntry[];
      /** Plugin entries the request ran, before the cap. */
      readonly entryCount: number;
      readonly truncated: boolean;
    }
  | { readonly status: "unavailable" }
  | { readonly status: "failed" };

/** What the trace needs from a Lab: the WordPress container, the trigger secret and the runner. */
export type TraceLab = Pick<
  WordPressLabSession,
  "wordpress" | "xdebugTrigger" | "docker"
>;

export const TRACE_DIRECTORY = "/var/tmp/wbh-trace";
const SITE_ROOT = "/var/www/html";
const PLUGIN_DIRECTORIES = [
  `${SITE_ROOT}/wp-content/plugins/`,
  `${SITE_ROOT}/wp-content/mu-plugins/`,
];
/** The site address inside its own container (`--add-host=wordpress:127.0.0.1`). */
const SITE_ORIGIN = "http://wordpress";
const REQUEST_SECONDS = 60;
const REQUEST_TIMEOUT_MS = (REQUEST_SECONDS + 10) * 1_000;
const COMMAND_TIMEOUT_MS = 30_000;
/** The filtered trace: at most 2001 lines of a few hundred bytes each. */
const TRACE_OUTPUT_LIMIT = 4 * 1024 * 1024;
const SMALL_OUTPUT_LIMIT = 64 * 1024;
/** The line the in-container filter appends with the number of plugin entries. */
const COUNT_MARKER = "WBH_PLUGIN_ENTRIES";

/**
 * Sends the request with curl inside the WordPress container. Every value
 * arrives as a positional argument, never through shell quoting; the body goes
 * to curl's stdin so a leading `@` is never read as a file name.
 */
const REQUEST_SCRIPT = `method=$1; path=$2; cookie=$3; type=$4; body=$5
set -- -s -o /dev/null -w '%{http_code}' --max-time ${REQUEST_SECONDS} -X "$method" -H "Cookie: $cookie"
if [ "$method" = POST ]; then
  if [ -n "$type" ]; then set -- "$@" -H "Content-Type: $type"; fi
  set -- "$@" --data-binary @-
fi
printf '%s' "$body" | curl "$@" "${SITE_ORIGIN}$path"`;
/**
 * Waits up to 5 s for Xdebug to close the trace (its footer is written at
 * request shutdown, after the response may have left), then lists the files.
 */
const LIST_SCRIPT = `i=0
while [ "$i" -lt 20 ]; do
  f=$(find ${TRACE_DIRECTORY} -type f -name 'trace.*.xt' | sort | head -n 1)
  if [ -n "$f" ] && tail -c 400 "$f" | grep -q 'TRACE END'; then break; fi
  i=$((i+1)); sleep 0.25
done
find ${TRACE_DIRECTORY} -type f -name 'trace.*.xt' | sort`;
/**
 * Keeps the entry lines (field 3 is "0") whose file is under a plugin
 * directory, prints the first 2000 and appends the full count, so the output
 * stays small whatever the request ran.
 */
const FILTER_SCRIPT = `awk -F'\\t' -v max=${MAX_TRACE_ENTRIES} '$3=="0" && $9 ~ /^\\/var\\/www\\/html\\/wp-content\\/(plugins|mu-plugins)\\// { n++; if (n<=max) print } END { printf "${COUNT_MARKER}\\t%d\\n", n+0 }' "$1"`;

/**
 * Parses Xdebug trace format 1: tab-separated lines where an entry has "0" in
 * the third field, then time, memory, function name, user-defined flag,
 * include file, file name and line. Exit ("1") and return ("R") records,
 * header and footer lines are skipped. Only entries whose file is under a
 * plugin directory are kept, in order, with the file relative to the site
 * root; `total` is the count the in-container filter appended, when present.
 */
export function parseXdebugTrace(text: string): {
  readonly entries: readonly WordPressTraceEntry[];
  readonly total?: number;
} {
  const entries: WordPressTraceEntry[] = [];
  let total: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith(`${COUNT_MARKER}\t`)) {
      const count = Number.parseInt(line.slice(COUNT_MARKER.length + 1), 10);
      if (Number.isSafeInteger(count) && count >= 0) total = count;
      continue;
    }
    const fields = line.split("\t");
    if (fields[2] !== "0" || fields.length < 10) continue;
    const file = fields[8] ?? "";
    if (!PLUGIN_DIRECTORIES.some((directory) => file.startsWith(directory)))
      continue;
    const depth = Number.parseInt(fields[0] ?? "", 10);
    const lineNumber = Number.parseInt(fields[9] ?? "", 10);
    if (!Number.isSafeInteger(depth) || !Number.isSafeInteger(lineNumber))
      continue;
    entries.push({
      depth,
      function: fields[5] ?? "",
      file: file.slice(SITE_ROOT.length + 1),
      line: lineNumber,
    });
  }
  return total === undefined ? { entries } : { entries, total };
}

/**
 * Sends one request to the site with the trace trigger and reads the trace
 * Xdebug left. `unavailable` when no trace appeared (the image has no Xdebug,
 * or the trigger was not accepted); `failed` when a step did not run or the
 * request got no HTTP status.
 */
export async function traceExplorationRequest(
  lab: TraceLab,
  request: WordPressExplorationTraceRequest,
): Promise<WordPressExplorationTraceResult> {
  if (
    !wordpressExplorationTraceSchema.safeParse(request).success ||
    (request.method === "GET" && request.body !== undefined)
  )
    return { status: "failed" };
  const exec = (
    args: readonly string[],
    timeoutMs = COMMAND_TIMEOUT_MS,
    maxOutputBytes = SMALL_OUTPUT_LIMIT,
  ) => lab.docker(["exec", lab.wordpress, ...args], timeoutMs, maxOutputBytes);
  const clear = () =>
    exec(["find", TRACE_DIRECTORY, "-type", "f", "-delete"]).catch(
      () => undefined,
    );
  try {
    const cleared = await exec([
      "find",
      TRACE_DIRECTORY,
      "-type",
      "f",
      "-delete",
    ]);
    // A missing directory means an image without the trace ini: nothing to trace.
    if (cleared.exitCode !== 0) return { status: "unavailable" };
    const cookie = `XDEBUG_TRIGGER=${lab.xdebugTrigger}${request.cookie === undefined || request.cookie === "" ? "" : `; ${request.cookie}`}`;
    const sent = await exec(
      [
        "sh",
        "-c",
        REQUEST_SCRIPT,
        "wbh-trace",
        request.method,
        request.path,
        cookie,
        request.contentType ?? "",
        request.body ?? "",
      ],
      REQUEST_TIMEOUT_MS,
    );
    const httpStatus = Number.parseInt(sent.stdout.trim(), 10);
    if (
      sent.exitCode !== 0 ||
      !Number.isSafeInteger(httpStatus) ||
      httpStatus < 100 ||
      httpStatus > 599
    ) {
      await clear();
      return { status: "failed" };
    }
    const listed = await exec(["sh", "-c", LIST_SCRIPT, "wbh-trace"]);
    if (listed.exitCode !== 0) {
      await clear();
      return { status: "failed" };
    }
    const files = listed.stdout
      .split("\n")
      .filter((line) => line.startsWith(`${TRACE_DIRECTORY}/trace.`));
    // The earliest file is the request's own; a later one would be a
    // sub-request the site made with the same cookie.
    const file = files[0];
    if (file === undefined) return { status: "unavailable" };
    const filtered = await exec(
      ["sh", "-c", FILTER_SCRIPT, "wbh-trace", file],
      COMMAND_TIMEOUT_MS,
      TRACE_OUTPUT_LIMIT,
    );
    await clear();
    if (filtered.exitCode !== 0) return { status: "failed" };
    const parsed = parseXdebugTrace(filtered.stdout);
    const entryCount = parsed.total ?? parsed.entries.length;
    const entries = parsed.entries.slice(0, MAX_TRACE_ENTRIES);
    return {
      status: "traced",
      httpStatus,
      entries,
      entryCount,
      truncated: entryCount > entries.length,
    };
  } catch {
    await clear();
    return { status: "failed" };
  }
}
