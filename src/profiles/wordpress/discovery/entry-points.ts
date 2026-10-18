import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { WordPressSourceIndex } from "./storage-index.js";

/**
 * Entry-point enumeration (ADR 0011: WordPress-specific). It only lists where
 * the plugin registers externally reachable handlers; it does not judge anything.
 */

export type WordPressEntryKind =
  | "ajax-nopriv"
  | "ajax"
  | "admin-post-nopriv"
  | "admin-post"
  | "rest-route"
  | "shortcode"
  | "request-hook";

export interface WordPressEntryPoint {
  readonly kind: WordPressEntryKind;
  readonly name: string;
  /** Registration site, relative to the source root with `/` separators. */
  readonly file: string;
  readonly line: number;
}

/** Hooks that run on ordinary front-end or login requests before any capability check. */
export const REQUEST_HOOKS = new Set([
  "init",
  "wp_loaded",
  "parse_request",
  "template_redirect",
  "wp",
  "login_init",
  "login_form",
  "lostpassword_post",
  "retrieve_password",
  "password_reset",
  "comment_post",
  "user_register",
  "wp_login",
  "rest_api_init",
  "admin_init",
  "wp_mail",
  "retrieve_password_message",
]);

const KIND_ORDER: readonly WordPressEntryKind[] = [
  "ajax-nopriv",
  "admin-post-nopriv",
  "rest-route",
  "shortcode",
  "request-hook",
  "ajax",
  "admin-post",
];

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git"]);

const quoted = String.raw`['"]([^'"]+)['"]`;
const patterns: readonly {
  readonly regex: RegExp;
  readonly kind: (match: RegExpExecArray) => WordPressEntryKind | null;
  readonly name: (match: RegExpExecArray) => string;
}[] = [
  {
    regex: new RegExp(String.raw`add_action\(\s*${quoted}`, "g"),
    kind: (match) => {
      const hook = match[1]!;
      if (hook.startsWith("wp_ajax_nopriv_")) return "ajax-nopriv";
      if (hook.startsWith("wp_ajax_")) return "ajax";
      if (hook.startsWith("admin_post_nopriv_")) return "admin-post-nopriv";
      if (hook.startsWith("admin_post_")) return "admin-post";
      return REQUEST_HOOKS.has(hook) ? "request-hook" : null;
    },
    name: (match) => match[1]!,
  },
  {
    regex: new RegExp(String.raw`add_filter\(\s*${quoted}`, "g"),
    kind: (match) => (REQUEST_HOOKS.has(match[1]!) ? "request-hook" : null),
    name: (match) => match[1]!,
  },
  {
    regex: new RegExp(
      String.raw`register_rest_route\(\s*([^,]+?)\s*,\s*${quoted}`,
      "g",
    ),
    kind: () => "rest-route",
    name: (match) => `${match[1]!.trim()} ${match[2]!}`,
  },
  {
    regex: new RegExp(String.raw`add_shortcode\(\s*${quoted}`, "g"),
    kind: () => "shortcode",
    name: (match) => match[1]!,
  },
];

async function phpFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".php")) {
        found.push(path);
      }
    }
  };
  await walk(root);
  return found.sort();
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++)
    if (text.charCodeAt(index) === 10) line++;
  return line;
}

/** Lists hook, route and shortcode registrations in the frozen source. Pure text scan. */
export async function enumerateWordPressEntryPoints(
  sourceDirectory: string,
): Promise<WordPressEntryPoint[]> {
  const sources: { file: string; text: string }[] = [];
  for (const path of await phpFiles(sourceDirectory)) {
    const text = await readFile(path, "utf8");
    const file = relative(sourceDirectory, path).split(sep).join("/");
    sources.push({ file, text });
  }
  return enumerateWordPressEntryPointsFromSources(sources);
}

/** Scan already bounded source texts so an index never rereads oversized files. */
export function enumerateWordPressEntryPointsFromSources(
  sources: readonly { readonly file: string; readonly text: string }[],
): WordPressEntryPoint[] {
  const entries: WordPressEntryPoint[] = [];
  for (const { file, text } of sources) {
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      for (
        let match = pattern.regex.exec(text);
        match !== null;
        match = pattern.regex.exec(text)
      ) {
        const kind = pattern.kind(match);
        if (kind === null) continue;
        entries.push({
          kind,
          name: pattern.name(match),
          file,
          line: lineOf(text, match.index),
        });
      }
    }
  }
  return entries.sort(compareEntries);
}

export function compareEntries(
  a: WordPressEntryPoint,
  b: WordPressEntryPoint,
): number {
  return (
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.name.localeCompare(b.name)
  );
}

export function entryKey(entry: WordPressEntryPoint): string {
  return `${entry.kind} ${entry.name} ${entry.file}:${entry.line}`;
}

/** Fixed-source catalogue for a Trial; the agent chooses what to inspect. */
export function renderWordPressEntryIndex(index: WordPressSourceIndex): string {
  return [
    "## Entry points",
    `Index digest: ${index.digest}`,
    `Index: ${index.incomplete ? "partial (limit reached)" : "complete"}`,
    `Incomplete: ${index.incomplete}`,
    ...index.entries.map(
      (entry, ordinal) =>
        `- e-${ordinal + 1}: ${entry.kind} \`${entry.name}\` — ${entry.file}:${entry.line}`,
    ),
  ].join("\n");
}
