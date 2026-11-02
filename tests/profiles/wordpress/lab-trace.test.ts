import { describe, expect, it } from "vitest";

import type { DockerResult } from "../../../src/profiles/wordpress/lab/lab-docker.js";
import {
  parseXdebugTrace,
  traceExplorationRequest,
  wordpressExplorationTraceSchema,
  type TraceLab,
} from "../../../src/profiles/wordpress/lab/lab-trace.js";

describe("trace request schema", () => {
  it.each([
    { method: "GET", path: "/" },
    { method: "GET", path: "/?p=1&wbh=1234567890" },
    {
      method: "POST",
      path: "/wp-admin/admin-ajax.php",
      cookie: "wordpress_logged_in=abc; wp-settings-1=x",
      contentType: "application/x-www-form-urlencoded",
      body: "action=x",
    },
    {
      method: "POST",
      path: "/wp-json/wbh/v1/x",
      contentType: "application/json",
      body: "{}",
    },
    { method: "POST", path: "/x", contentType: "text/plain", body: "" },
    { method: "POST", path: "/x", body: "a".repeat(8192) },
    { method: "GET", path: `/${"a".repeat(2047)}`, cookie: "" },
  ])("accepts %j", (body) => {
    expect(wordpressExplorationTraceSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    [{ path: "/" }, "method"],
    [{ method: "PUT", path: "/" }, "method"],
    [{ method: "get", path: "/" }, "method"],
    [{ method: "GET" }, "path"],
    [{ method: "GET", path: "wp-admin" }, "path"],
    [{ method: "GET", path: "//evil" }, "path"],
    [{ method: "GET", path: "/a b" }, "path"],
    [{ method: "GET", path: "/a\\b" }, "path"],
    [{ method: "GET", path: `/${"a".repeat(2048)}` }, "path"],
    [{ method: "GET", path: "/", cookie: "a=b\r\nX: y" }, "cookie"],
    [{ method: "GET", path: "/", cookie: "a=é" }, "cookie"],
    [{ method: "GET", path: "/", cookie: "x".repeat(4097) }, "cookie"],
    [{ method: "POST", path: "/", contentType: "text/html" }, "contentType"],
    [
      { method: "POST", path: "/", contentType: "multipart/form-data" },
      "contentType",
    ],
    [{ method: "POST", path: "/", body: "a".repeat(8193) }, "body"],
    [{ method: "POST", path: "/", body: 1 }, "body"],
    [{ method: "GET", path: "/", headers: { a: "b" } }, "headers"],
  ])("refuses %j on %s", (body, field) => {
    const parsed = wordpressExplorationTraceSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues[0]!;
    const named =
      issue.code === "unrecognized_keys"
        ? (issue as { keys: string[] }).keys[0]
        : String(issue.path[0]);
    expect(named).toBe(field);
  });
});

/** Xdebug 3.4 format 1 (computerized): header, entries, exits, a return, footer. */
const TRACE = [
  "Version: 3.4.7",
  "File format: 4",
  "TRACE START [2026-11-02 01:02:03.456789]",
  "1\t0\t1\t0.000312\t400000",
  "1\t1\t0\t0.000320\t400100\t{main}\t1\t\t/var/www/html/index.php\t0",
  "2\t2\t0\t0.000330\t400200\trequire\t1\t/var/www/html/wp-blog-header.php\t/var/www/html/index.php\t17",
  "3\t3\t0\t0.001000\t500000\tWP_Hook->apply_filters\t1\t\t/var/www/html/wp-includes/class-wp-hook.php\t324",
  "4\t4\t0\t0.001100\t500100\tWBH_Synthetic\\\\Plugin->init\t1\t\t/var/www/html/wp-content/plugins/synthetic/includes/class-plugin.php\t42",
  "5\t5\t0\t0.001200\t500200\tget_option\t1\t\t/var/www/html/wp-includes/option.php\t150",
  "5\t5\t1\t0.001300\t500200",
  "5\t6\t0\t0.001400\t500300\t{closure:/var/www/html/wp-content/plugins/synthetic/synthetic.php:30-33}\t1\t\t/var/www/html/wp-content/plugins/synthetic/synthetic.php\t31",
  "5\t6\tR\t\t\t'rewritten'",
  "5\t6\t1\t0.001500\t500300",
  "4\t4\t1\t0.001600\t500100",
  "4\t7\t0\t0.001700\t500400\twbh_mu_loader\t1\t\t/var/www/html/wp-content/mu-plugins/loader.php\t8",
  "4\t7\t1\t0.001800\t500400",
  "4\t8\t0\t0.001900\t500500\twbh_theme_hook\t1\t\t/var/www/html/wp-content/themes/twentytwentyfive/functions.php\t9",
  "4\t8\t1\t0.002000\t500500",
  "3\t3\t1\t0.002100\t500000",
  "\t\t\t0.002200\t400000",
  "TRACE END   [2026-11-02 01:02:03.556789]",
  "",
].join("\n");

describe("parseXdebugTrace", () => {
  it("keeps plugin and mu-plugin entries in call order, skipping core, theme, exit and return lines", () => {
    expect(parseXdebugTrace(TRACE)).toEqual({
      entries: [
        {
          depth: 4,
          function: "WBH_Synthetic\\\\Plugin->init",
          file: "wp-content/plugins/synthetic/includes/class-plugin.php",
          line: 42,
        },
        {
          depth: 5,
          function:
            "{closure:/var/www/html/wp-content/plugins/synthetic/synthetic.php:30-33}",
          file: "wp-content/plugins/synthetic/synthetic.php",
          line: 31,
        },
        {
          depth: 4,
          function: "wbh_mu_loader",
          file: "wp-content/mu-plugins/loader.php",
          line: 8,
        },
      ],
    });
  });

  it("reads the count the in-container filter appends and skips lines that are not entries", () => {
    expect(
      parseXdebugTrace(
        `${TRACE}WBH_PLUGIN_ENTRIES\t2345\nnot a trace line\n4\tx\t0\t0\t0\tf\t1\t\t/var/www/html/wp-content/plugins/p/p.php\tnan\n`,
      ),
    ).toMatchObject({ total: 2345 });
    expect(parseXdebugTrace("").entries).toEqual([]);
  });
});

type Call = {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};

function fakeLab(
  respond: (args: readonly string[]) => DockerResult | undefined,
): { readonly lab: TraceLab; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    lab: {
      wordpress: "wbh-wp",
      xdebugTrigger: "0123456789abcdef0123456789abcdef",
      async docker(args, timeoutMs = 60_000, maxOutputBytes = 64 * 1024) {
        calls.push({ args, timeoutMs, maxOutputBytes });
        return respond(args) ?? { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

const ok = (stdout: string): DockerResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});
const failedExit: DockerResult = { exitCode: 1, stdout: "", stderr: "" };
const isCurl = (args: readonly string[]) =>
  args[2] === "sh" && args[4]?.includes("curl") === true;
const isList = (args: readonly string[]) =>
  args[2] === "sh" && args[4]?.includes("TRACE END") === true;
const isFilter = (args: readonly string[]) =>
  args[2] === "sh" && args[4]?.includes("awk") === true;
const isClear = (args: readonly string[]) =>
  args[2] === "find" && args.includes("-delete");
const TRACE_FILE = "/var/tmp/wbh-trace/trace.1762045323_456789.xt";

describe("traceExplorationRequest", () => {
  it("clears, sends the request with the trigger cookie and the body on stdin, filters the one trace and clears again", async () => {
    const { lab, calls } = fakeLab((args) => {
      if (isCurl(args)) return ok("200");
      if (isList(args)) return ok(`${TRACE_FILE}\n`);
      if (isFilter(args)) return ok(`${TRACE}WBH_PLUGIN_ENTRIES\t3\n`);
      return undefined;
    });
    const traced = await traceExplorationRequest(lab, {
      method: "POST",
      path: "/wp-admin/admin-ajax.php?x=1",
      cookie: "wordpress_logged_in=abc; wp-settings-1=x",
      contentType: "application/x-www-form-urlencoded",
      body: "action=wbh_save&value=@1234567890",
    });
    expect(traced).toEqual({
      status: "traced",
      httpStatus: 200,
      entries: [
        expect.objectContaining({ function: "WBH_Synthetic\\\\Plugin->init" }),
        expect.objectContaining({ line: 31 }),
        expect.objectContaining({ function: "wbh_mu_loader" }),
      ],
      entryCount: 3,
      truncated: false,
    });
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["exec", "wbh-wp", "find"],
      ["exec", "wbh-wp", "sh"],
      ["exec", "wbh-wp", "sh"],
      ["exec", "wbh-wp", "sh"],
      ["exec", "wbh-wp", "find"],
    ]);
    expect(isClear(calls[0]!.args)).toBe(true);
    expect(isClear(calls[4]!.args)).toBe(true);
    // Every value is a positional argument of the script, never shell text;
    // the trigger goes first in the cookie, as Xdebug reads cookies, not headers.
    const request = calls[1]!;
    expect(request.args.slice(5)).toEqual([
      "wbh-trace",
      "POST",
      "/wp-admin/admin-ajax.php?x=1",
      "XDEBUG_TRIGGER=0123456789abcdef0123456789abcdef; wordpress_logged_in=abc; wp-settings-1=x",
      "application/x-www-form-urlencoded",
      "action=wbh_save&value=@1234567890",
    ]);
    expect(request.args[4]).toContain("--data-binary @-");
    expect(request.args[4]).toContain('"http://wordpress$path"');
    expect(request.args[4]).toContain("--max-time 60");
    expect(request.timeoutMs).toBe(70_000);
    // The filter runs on the listed file with room for 2001 lines.
    const filter = calls[3]!;
    expect(filter.args.slice(5)).toEqual(["wbh-trace", TRACE_FILE]);
    expect(filter.args[4]).toContain("(plugins|mu-plugins)");
    expect(filter.maxOutputBytes).toBe(4 * 1024 * 1024);
  });

  it("sends a GET without a body or content type and reports a cut list as truncated", async () => {
    const { lab, calls } = fakeLab((args) => {
      if (isCurl(args)) return ok("404");
      if (isList(args)) return ok(`${TRACE_FILE}\n`);
      if (isFilter(args)) return ok(`${TRACE}WBH_PLUGIN_ENTRIES\t2345\n`);
      return undefined;
    });
    const traced = await traceExplorationRequest(lab, {
      method: "GET",
      path: "/missing",
    });
    expect(traced).toMatchObject({
      status: "traced",
      httpStatus: 404,
      entryCount: 2345,
      truncated: true,
    });
    expect(calls[1]!.args.slice(5)).toEqual([
      "wbh-trace",
      "GET",
      "/missing",
      "XDEBUG_TRIGGER=0123456789abcdef0123456789abcdef",
      "",
      "",
    ]);
  });

  it("is unavailable when the image has no trace directory or no trace appeared", async () => {
    const noDirectory = fakeLab((args) =>
      isClear(args) ? failedExit : undefined,
    );
    expect(
      await traceExplorationRequest(noDirectory.lab, {
        method: "GET",
        path: "/",
      }),
    ).toEqual({ status: "unavailable" });
    expect(noDirectory.calls).toHaveLength(1);
    const noTrace = fakeLab((args) => {
      if (isCurl(args)) return ok("200");
      if (isList(args)) return ok("");
      return undefined;
    });
    expect(
      await traceExplorationRequest(noTrace.lab, { method: "GET", path: "/" }),
    ).toEqual({ status: "unavailable" });
    expect(noTrace.calls.some((call) => isFilter(call.args))).toBe(false);
  });

  it("fails when the request gets no HTTP status, when a step exits non-zero, or when the request is not one the schema takes", async () => {
    const noStatus = fakeLab((args) =>
      isCurl(args) ? { exitCode: 28, stdout: "000", stderr: "" } : undefined,
    );
    expect(
      await traceExplorationRequest(noStatus.lab, { method: "GET", path: "/" }),
    ).toEqual({ status: "failed" });
    // The directory is cleared after the failure too.
    expect(noStatus.calls.filter((call) => isClear(call.args))).toHaveLength(2);
    const badFilter = fakeLab((args) => {
      if (isCurl(args)) return ok("200");
      if (isList(args)) return ok(`${TRACE_FILE}\n`);
      if (isFilter(args)) return failedExit;
      return undefined;
    });
    expect(
      await traceExplorationRequest(badFilter.lab, {
        method: "GET",
        path: "/",
      }),
    ).toEqual({ status: "failed" });
    const thrown = fakeLab(() => {
      throw new Error("docker is gone");
    });
    expect(
      await traceExplorationRequest(thrown.lab, { method: "GET", path: "/" }),
    ).toEqual({ status: "failed" });
    const untouched = fakeLab(() => undefined);
    expect(
      await traceExplorationRequest(untouched.lab, {
        method: "GET",
        path: "/",
        body: "x",
      }),
    ).toEqual({ status: "failed" });
    expect(
      await traceExplorationRequest(untouched.lab, {
        method: "GET",
        path: "//x",
      }),
    ).toEqual({ status: "failed" });
    expect(untouched.calls).toEqual([]);
  });
});
