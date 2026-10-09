import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import {
  compareEntries,
  entryKey,
  enumerateWordPressEntryPointsFromSources,
  REQUEST_HOOKS,
  type WordPressEntryPoint,
} from "./entry-points.js";

export type WordPressStorageKind =
  "option" | "post-meta" | "user-meta" | "transient" | "db-table" | "file";
export interface WordPressStorageRef {
  readonly kind: WordPressStorageKind;
  readonly key: string | "dynamic";
  readonly access: "write" | "read" | "delete";
  readonly file: string;
  readonly line: number;
  readonly function: string;
}
export interface WordPressCoreCrossing {
  readonly kind: "core-hook-callback" | "core-api-call";
  readonly name: string;
  readonly file: string;
  readonly line: number;
}
export interface WordPressIndexedEntry extends WordPressEntryPoint {
  readonly callback: string | null;
  readonly reach: readonly string[];
  readonly storage: readonly WordPressStorageRef[];
  readonly crossings: readonly WordPressCoreCrossing[];
}
export interface WordPressComponent {
  readonly id: string;
  readonly keys: readonly string[];
  readonly entries: readonly string[];
  readonly producers: readonly string[];
  readonly consumers: readonly string[];
  readonly files: readonly string[];
}
export interface WordPressSourceIndex {
  readonly schemaVersion: 1;
  readonly entries: readonly WordPressIndexedEntry[];
  readonly dynamicStorage: readonly WordPressStorageRef[];
  readonly components: readonly WordPressComponent[];
  readonly settingsKeys: readonly string[];
  readonly incomplete: boolean;
  readonly digest: string;
}

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COMPONENT_KEYS = 200;
const IGNORE = new Set([".git", "node_modules"]);
const CORE_HOOKS = new Set([
  ...REQUEST_HOOKS,
  "retrieve_password_message",
  "retrieve_password_title",
  "wp_mail",
  "wp_mail_from",
  "authenticate",
  "wp_login",
  "wp_logout",
  "user_register",
  "register_new_user",
  "lostpassword_post",
  "password_reset",
  "after_password_reset",
  "wp_insert_post_data",
  "wp_insert_user",
  "profile_update",
  "set_user_role",
  "rest_pre_dispatch",
  "rest_request_before_callbacks",
  "determine_current_user",
  "auth_cookie_valid",
  "send_auth_cookies",
  "init",
  "template_redirect",
  "admin_init",
]);
const CORE_APIS = new Set([
  "get_password_reset_key",
  "check_password_reset_key",
  "wp_generate_password",
  "wp_set_auth_cookie",
  "wp_set_current_user",
  "wp_create_nonce",
  "wp_verify_nonce",
  "wp_mail",
  "wp_update_user",
  "wp_insert_user",
  "wp_signon",
  "wp_hash_password",
  "wp_check_password",
  "current_user_can",
  "check_ajax_referer",
]);
const lineOf = (text: string, offset: number): number =>
  text.slice(0, offset).split("\n").length;
const compareRefs = (a: WordPressStorageRef, b: WordPressStorageRef): number =>
  a.file.localeCompare(b.file) ||
  a.line - b.line ||
  a.kind.localeCompare(b.kind) ||
  a.key.localeCompare(b.key) ||
  a.access.localeCompare(b.access);
const compareCrossings = (
  a: WordPressCoreCrossing,
  b: WordPressCoreCrossing,
): number =>
  a.file.localeCompare(b.file) ||
  a.line - b.line ||
  a.kind.localeCompare(b.kind) ||
  a.name.localeCompare(b.name);

async function phpFiles(
  root: string,
): Promise<{ files: string[]; incomplete: boolean }> {
  const files: string[] = [];
  let incomplete = false;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !IGNORE.has(entry.name)) await walk(path);
      if (entry.isFile() && entry.name.endsWith(".php")) {
        if (files.length >= MAX_FILES) incomplete = true;
        else files.push(path);
      }
    }
  };
  await walk(root);
  return { files, incomplete };
}

function functionRanges(
  text: string,
): { name: string; start: number; end: number }[] {
  const ranges: { name: string; start: number; end: number }[] = [];
  const pattern = /\bfunction\s+([A-Za-z_][A-Za-z_0-9]*)\s*\([^)]*\)\s*\{/g;
  for (const match of text.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    let end = open + 1;
    while (end < text.length && depth > 0) {
      if (text[end] === "{") depth++;
      if (text[end] === "}") depth--;
      end++;
    }
    ranges.push({ name: match[1]!, start: open, end });
  }
  return ranges;
}
function enclosingFunction(
  ranges: ReturnType<typeof functionRanges>,
  offset: number,
): string {
  const found = ranges.filter(
    (range) => range.start <= offset && offset < range.end,
  );
  return found.at(-1)?.name ?? "(top-level)";
}
function literal(argument: string | undefined): string {
  const value = argument?.trim().match(/^['"]([^'"]+)['"]$/)?.[1];
  return value ?? "dynamic";
}
function tableKey(argument: string): string {
  return (
    argument.match(/\$wpdb->prefix\s*\.\s*['"]([^'"]+)['"]/)?.[1] ??
    argument.match(/\{\$wpdb->prefix\}([A-Za-z_][A-Za-z_0-9]*)/)?.[1] ??
    argument.match(/\$wpdb->([A-Za-z_][A-Za-z_0-9]*)/)?.[1] ??
    literal(argument)
  );
}

function scanStorage(text: string, file: string): WordPressStorageRef[] {
  const refs: WordPressStorageRef[] = [];
  const ranges = functionRanges(text);
  const add = (
    kind: WordPressStorageKind,
    key: string,
    access: WordPressStorageRef["access"],
    offset: number,
  ) =>
    refs.push({
      kind,
      key,
      access,
      file,
      line: lineOf(text, offset),
      function: enclosingFunction(ranges, offset),
    });
  const functions =
    /\b(update_option|add_option|get_option|delete_option|update_post_meta|add_post_meta|get_post_meta|delete_post_meta|update_user_meta|add_user_meta|get_user_meta|delete_user_meta|set_(?:site_)?transient|get_(?:site_)?transient|delete_(?:site_)?transient|file_put_contents|fwrite|wp_upload_bits|move_uploaded_file|copy|rename|file_get_contents|readfile|fopen|include|require|include_once|require_once|unlink|wp_delete_file)\s*\(\s*([^,)]+)(?:\s*,\s*([^,)]+))?/g;
  for (const match of text.matchAll(functions)) {
    const name = match[1]!;
    const kind: WordPressStorageKind = name.includes("_option")
      ? "option"
      : name.includes("post_meta")
        ? "post-meta"
        : name.includes("user_meta")
          ? "user-meta"
          : name.includes("transient")
            ? "transient"
            : "file";
    const access: WordPressStorageRef["access"] =
      /^(?:get_|file_get_contents|readfile|fopen|include|require)/.test(name)
        ? "read"
        : /^(?:delete_|unlink|wp_delete_file)/.test(name)
          ? "delete"
          : "write";
    add(
      kind,
      literal(
        kind === "post-meta" || kind === "user-meta" ? match[3] : match[2],
      ),
      access,
      match.index ?? 0,
    );
  }
  for (const match of text.matchAll(
    /\b(?:include|require)(?:_once)?\s+(?!\()([^;\n]+)/g,
  ))
    add("file", literal(match[1]), "read", match.index ?? 0);
  const db =
    /\$wpdb->(insert|update|replace|query|get_var|get_row|get_results|get_col|prepare)\s*\(\s*([^;)]+?)\s*\)/g;
  for (const match of text.matchAll(db)) {
    const method = match[1]!;
    const argument = match[2]!;
    const access: WordPressStorageRef["access"] =
      /^(?:insert|update|replace)$/.test(method) ||
      (method === "query" && /\b(?:INSERT|UPDATE|DELETE)\b/i.test(argument))
        ? "write"
        : "read";
    add(
      "db-table",
      tableKey(argument.split(",")[0]!),
      access,
      match.index ?? 0,
    );
  }
  return refs.sort(compareRefs);
}

type LocatedCrossing = WordPressCoreCrossing & { readonly function: string };
function scanCrossings(text: string, file: string): LocatedCrossing[] {
  const crossings: LocatedCrossing[] = [];
  const ranges = functionRanges(text);
  for (const match of text.matchAll(
    /\b(?:add_action|add_filter)\s*\(\s*['"]([^'"]+)['"]/g,
  )) {
    const name = match[1]!;
    if (CORE_HOOKS.has(name) || /^(?:pre_option_|option_|pre_user_)/.test(name))
      crossings.push({
        kind: "core-hook-callback",
        name,
        file,
        line: lineOf(text, match.index ?? 0),
        function: enclosingFunction(ranges, match.index ?? 0),
      });
  }
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z_0-9]*)\s*\(/g))
    if (CORE_APIS.has(match[1]!))
      crossings.push({
        kind: "core-api-call",
        name: match[1]!,
        file,
        line: lineOf(text, match.index ?? 0),
        function: enclosingFunction(ranges, match.index ?? 0),
      });
  return crossings.sort(compareCrossings);
}

function callbackFor(
  text: string,
  entry: WordPressEntryPoint,
): { name: string | null; body: string | null } {
  const line = text.split("\n")[entry.line - 1] ?? "";
  const tail = `${line}\n${text
    .split("\n")
    .slice(entry.line, entry.line + 5)
    .join("\n")}`;
  const named =
    tail.match(
      /(?:\[|array\s*\()\s*(?:\$this|__CLASS__)\s*,\s*['"]([A-Za-z_][A-Za-z_0-9]*)['"]/,
    )?.[1] ??
    tail.match(
      /['"]callback['"]\s*=>\s*['"]([A-Za-z_][A-Za-z_0-9]*)['"]/,
    )?.[1] ??
    tail.match(
      /,\s*['"]([A-Za-z_][A-Za-z_0-9]*(?:::[A-Za-z_][A-Za-z_0-9]*)?)['"]/,
    )?.[1];
  const name =
    named ??
    (tail.includes("function (") || tail.includes("function(")
      ? "(closure)"
      : null);
  if (name === null) return { name, body: null };
  const bare = name.split("::").at(-1)!;
  const ranges = functionRanges(text);
  const range = ranges.find((candidate) => candidate.name === bare);
  if (range === undefined) return { name, body: null };
  return { name, body: text.slice(range.start, range.end) };
}

function includedFiles(
  text: string,
  file: string,
  available: ReadonlySet<string>,
): string[] {
  const result = [file];
  const pattern =
    /\b(?:include|require)(?:_once)?\s*(?:\(\s*)?(?:(?:__DIR__|plugin_dir_path\s*\(\s*__FILE__\s*\)|dirname\s*\(\s*__FILE__\s*\))\s*\.\s*)?['"]([^'"]+\.php)['"]/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = normalize(
      join(dirname(file), match[1]!.replace(/^\/+/, "")),
    )
      .split(sep)
      .join("/");
    if (available.has(candidate)) result.push(candidate);
  }
  return [...new Set(result)].sort();
}

/** Deterministic, deliberately overinclusive text index. No source code is executed. */
export async function buildWordPressSourceIndex(
  sourceDirectory: string,
  pluginPrefix: string,
  suppliedEntries?: readonly WordPressEntryPoint[],
): Promise<WordPressSourceIndex> {
  const listed = await phpFiles(sourceDirectory);
  let incomplete = listed.incomplete;
  const texts = new Map<string, string>();
  for (const path of listed.files) {
    if ((await stat(path)).size > MAX_FILE_BYTES) {
      incomplete = true;
      continue;
    }
    texts.set(
      relative(sourceDirectory, path).split(sep).join("/"),
      await readFile(path, "utf8"),
    );
  }
  const available = new Set(texts.keys());
  const entries = [
    ...(suppliedEntries ??
      enumerateWordPressEntryPointsFromSources(
        [...texts].map(([file, text]) => ({ file, text })),
      )),
  ].sort(compareEntries);
  const storage = new Map(
    [...texts].map(([file, text]) => [file, scanStorage(text, file)]),
  );
  const crossings = new Map(
    [...texts].map(([file, text]) => [file, scanCrossings(text, file)]),
  );
  const indexed: WordPressIndexedEntry[] = entries.map((entry) => {
    const text = texts.get(entry.file);
    if (text === undefined) {
      incomplete = true;
      return {
        ...entry,
        callback: null,
        reach: [],
        storage: [],
        crossings: [],
      };
    }
    const callback = callbackFor(text, entry);
    const reach = includedFiles(text, entry.file, available);
    // A resolved callback narrows the registration file; included files stay a deliberate overapproximation.
    const refs = reach.flatMap((file) =>
      file === entry.file && callback.body !== null
        ? (storage.get(file) ?? []).filter(
            (ref) =>
              ref.function === callback.name ||
              ref.function === callback.name?.split("::").at(-1),
          )
        : (storage.get(file) ?? []),
    );
    const selectedCrossings = reach.flatMap((file) =>
      (crossings.get(file) ?? []).filter((crossing) => {
        if (file !== entry.file || callback.body === null) return true;
        if (crossing.kind === "core-hook-callback")
          return crossing.line === entry.line && crossing.name === entry.name;
        return crossing.function === callback.name?.split("::").at(-1);
      }),
    );
    return {
      ...entry,
      callback: callback.name,
      reach,
      storage: refs.sort(compareRefs),
      crossings: selectedCrossings
        .map(({ function: _function, ...crossing }) => crossing)
        .sort(compareCrossings),
    };
  });
  const dynamicStorage = [...storage.values()]
    .flat()
    .filter((ref) => ref.key === "dynamic")
    .sort(compareRefs);
  const parent = indexed.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) index = parent[index]!;
    return index;
  };
  const unite = (a: number, b: number) => {
    parent[find(b)] = find(a);
  };
  const byKey = new Map<
    string,
    { index: number; access: WordPressStorageRef["access"] }[]
  >();
  indexed.forEach((entry, index) => {
    for (const ref of entry.storage) {
      if (ref.key === "dynamic") continue;
      const key = `${ref.kind}:${ref.key}`;
      byKey.set(key, [
        ...(byKey.get(key) ?? []),
        { index, access: ref.access },
      ]);
    }
  });
  for (const refs of byKey.values())
    for (const first of refs)
      for (const second of refs)
        if (
          first.index !== second.index &&
          first.access === "write" &&
          (second.access === "read" || second.access === "write")
        )
          unite(first.index, second.index);
  const groups = new Map<number, number[]>();
  indexed.forEach((_, index) =>
    groups.set(find(index), [...(groups.get(find(index)) ?? []), index]),
  );
  const components = [...groups.values()].map((indices): WordPressComponent => {
    const members = indices.map((index) => indexed[index]!);
    const keys = [
      ...new Set(
        members.flatMap((entry) =>
          entry.storage
            .filter((ref) => ref.key !== "dynamic")
            .map((ref) => `${ref.kind}:${ref.key}`),
        ),
      ),
    ].sort();
    if (keys.length > MAX_COMPONENT_KEYS) incomplete = true;
    const entries = members.map(entryKey).sort();
    return {
      id: canonicalDigest(keys.length === 0 ? { keys, entries } : keys),
      keys,
      entries,
      producers: members
        .filter((entry) =>
          entry.storage.some(
            (ref) => ref.access === "write" && ref.key !== "dynamic",
          ),
        )
        .map(entryKey)
        .sort(),
      consumers: members
        .filter((entry) =>
          entry.storage.some(
            (ref) => ref.access === "read" && ref.key !== "dynamic",
          ),
        )
        .map(entryKey)
        .sort(),
      files: [...new Set(members.flatMap((entry) => entry.reach))].sort(),
    };
  });
  components.sort(
    (a, b) =>
      Math.min(
        ...a.entries.map((key) =>
          indexed.findIndex((entry) => entryKey(entry) === key),
        ),
      ) -
      Math.min(
        ...b.entries.map((key) =>
          indexed.findIndex((entry) => entryKey(entry) === key),
        ),
      ),
  );
  const prefix = pluginPrefix.toLowerCase().replace(/-/g, "_");
  const settingsKeys = [
    ...new Set(
      [...storage.values()]
        .flat()
        .filter(
          (ref) =>
            ref.kind === "option" &&
            ref.access === "read" &&
            ref.key !== "dynamic" &&
            (ref.key.startsWith(prefix) || ref.key.startsWith(pluginPrefix)),
        )
        .map((ref) => ref.key),
    ),
  ].sort();
  const body = {
    schemaVersion: 1 as const,
    entries: indexed,
    dynamicStorage,
    components,
    settingsKeys,
    incomplete,
  };
  return { ...body, digest: canonicalDigest(body) };
}
