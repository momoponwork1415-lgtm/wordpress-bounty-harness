import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import type { WordPressSourceIndex } from "./storage-index.js";

/**
 * Entry-point assignment (SPEC 6: 分担されたfile集合; ADR 0011: WordPress-specific).
 *
 * This module is an optional discovery axis. Removing it means deleting this
 * file, the `assignment` block of the campaign config, and the branch in the
 * CLI profile that calls `planWordPressEntryAssignments`. Nothing else depends
 * on it. It only lists where the plugin registers externally reachable
 * handlers; it does not judge anything.
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

export interface WordPressEntryAssignment {
  /** 0-based partition ordinal and the number of partitions. */
  readonly partition: number;
  readonly of: number;
  readonly entries: readonly WordPressEntryPoint[];
  /** Registration files of the assigned entries, sorted and unique. */
  readonly files: readonly string[];
  /** Digest of the whole plan (all partitions), so runs of one plan share it. */
  readonly planDigest: string;
  readonly indexDigest?: string;
  readonly componentIds?: readonly string[];
  readonly boundaryKeys?: readonly string[];
  readonly sourceIndex?: WordPressSourceIndex;
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

/**
 * Packs entries into partitions of about `entriesPerRun`, keeping entries that
 * share a registration file together so a run reads one class at a time.
 * Returns an empty list when the source registers nothing.
 */
export function partitionWordPressEntryPoints(
  entries: readonly WordPressEntryPoint[],
  entriesPerRun: number,
): WordPressEntryAssignment[] {
  if (!Number.isSafeInteger(entriesPerRun) || entriesPerRun < 1)
    throw new Error("Invalid entries per run");
  const byFile = new Map<string, WordPressEntryPoint[]>();
  for (const entry of [...entries].sort(compareEntries)) {
    const group = byFile.get(entry.file);
    if (group === undefined) byFile.set(entry.file, [entry]);
    else group.push(entry);
  }
  // Files in order of their most reachable entry; large files are split.
  const groups = [...byFile.values()].sort((a, b) =>
    compareEntries(a[0]!, b[0]!),
  );
  const partitions: WordPressEntryPoint[][] = [];
  let current: WordPressEntryPoint[] = [];
  for (const group of groups) {
    for (let start = 0; start < group.length; start += entriesPerRun) {
      const slice = group.slice(start, start + entriesPerRun);
      if (current.length > 0 && current.length + slice.length > entriesPerRun) {
        partitions.push(current);
        current = [];
      }
      current.push(...slice);
    }
  }
  if (current.length > 0) partitions.push(current);
  const planDigest = canonicalDigest({
    entriesPerRun,
    partitions: partitions.map((partition) => partition.map(entryKey)),
  });
  return partitions.map((partition, index) => ({
    partition: index,
    of: partitions.length,
    entries: partition,
    files: [...new Set(partition.map((entry) => entry.file))].sort(),
    planDigest,
  }));
}

export function entryKey(entry: WordPressEntryPoint): string {
  return `${entry.kind} ${entry.name} ${entry.file}:${entry.line}`;
}

/** Packs connected entry components before splitting by key at the width limit. */
export function planWordPressEntryAssignments(
  index: WordPressSourceIndex,
  entriesPerRun: number,
): WordPressEntryAssignment[] {
  if (!Number.isSafeInteger(entriesPerRun) || entriesPerRun < 1)
    throw new Error("Invalid entries per run");
  if (index.incomplete && index.entries.length === 0)
    return [
      {
        partition: 0,
        of: 1,
        entries: [],
        files: [],
        planDigest: canonicalDigest({
          indexDigest: index.digest,
          entriesPerRun,
          partitions: [[]],
        }),
        indexDigest: index.digest,
        componentIds: [],
        boundaryKeys: [],
        sourceIndex: index,
      },
    ];
  if (index.components.every((component) => component.entries.length === 1)) {
    const legacy = partitionWordPressEntryPoints(index.entries, entriesPerRun);
    const byEntry = new Map(
      index.components.map((component) => [
        component.entries[0]!,
        component.id,
      ]),
    );
    const planDigest = canonicalDigest({
      indexDigest: index.digest,
      legacyPlanDigest: legacy[0]?.planDigest ?? canonicalDigest([]),
    });
    return legacy.map((assignment) => ({
      ...assignment,
      planDigest,
      indexDigest: index.digest,
      componentIds: [
        ...new Set(
          assignment.entries
            .map((entry) => byEntry.get(entryKey(entry)))
            .filter((id): id is string => id !== undefined),
        ),
      ].sort(),
      boundaryKeys: [],
      sourceIndex: index,
    }));
  }
  const byKey = new Map(index.entries.map((entry) => [entryKey(entry), entry]));
  const partitions: {
    entries: WordPressEntryPoint[];
    componentIds: string[];
    boundaryKeys: string[];
  }[] = [];
  let current: (typeof partitions)[number] = {
    entries: [],
    componentIds: [],
    boundaryKeys: [],
  };
  const push = () => {
    if (current.entries.length > 0) partitions.push(current);
    current = { entries: [], componentIds: [], boundaryKeys: [] };
  };
  for (const component of index.components) {
    const members = component.entries
      .map((key) => byKey.get(key))
      .filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined,
      );
    members.sort(compareEntries);
    if (
      current.entries.length > 0 &&
      current.entries.length + members.length > entriesPerRun
    )
      push();
    if (members.length <= entriesPerRun) {
      current.entries.push(...members);
      current.componentIds.push(component.id);
      continue;
    }
    const slices: WordPressEntryPoint[][] = [];
    for (let offset = 0; offset < members.length; offset += entriesPerRun)
      slices.push(members.slice(offset, offset + entriesPerRun));
    const keySets = slices.map(
      (slice) =>
        new Set(
          slice.flatMap(
            (entry) =>
              byKey
                .get(entryKey(entry))
                ?.storage.filter((ref) => ref.key !== "dynamic")
                .map((ref) => `${ref.kind}:${ref.key}`) ?? [],
          ),
        ),
    );
    slices.forEach((slice, sliceIndex) => {
      const shared = [...keySets[sliceIndex]!].filter((key) =>
        keySets.some((set, other) => other !== sliceIndex && set.has(key)),
      );
      partitions.push({
        entries: slice,
        componentIds: [component.id],
        boundaryKeys: shared.sort(),
      });
    });
  }
  push();
  const planDigest = canonicalDigest({
    indexDigest: index.digest,
    entriesPerRun,
    partitions: partitions.map((part) => ({
      entries: part.entries.map(entryKey),
      componentIds: part.componentIds,
      boundaryKeys: part.boundaryKeys,
    })),
  });
  return partitions.map((part, partition) => ({
    partition,
    of: partitions.length,
    entries: part.entries,
    files: [...new Set(part.entries.map((entry) => entry.file))].sort(),
    planDigest,
    indexDigest: index.digest,
    componentIds: [...new Set(part.componentIds)].sort(),
    boundaryKeys: part.boundaryKeys,
    sourceIndex: index,
  }));
}

/** The "Assigned files" section of the run prompt; no procedure, only the scope. */
export function renderWordPressEntryAssignment(
  assignment: WordPressEntryAssignment,
  coreMounted = false,
): string {
  const lines = assignment.entries.map((entry) => {
    const indexed = assignment.sourceIndex?.entries.find(
      (item) => entryKey(item) === entryKey(entry),
    );
    const calls =
      indexed?.crossings
        .filter((item) => item.kind === "core-api-call")
        .map((item) => item.name) ?? [];
    const hooks =
      indexed?.crossings
        .filter((item) => item.kind === "core-hook-callback")
        .map((item) => item.name) ?? [];
    return `- ${entry.kind} \`${entry.name}\` — ${entry.file}:${entry.line}${calls.length ? ` [calls core: ${[...new Set(calls)].join(", ")}]` : ""}${hooks.length ? ` [hooks core: ${[...new Set(hooks)].join(", ")}]` : ""}`;
  });
  const scoped =
    assignment.sourceIndex?.entries.filter((entry) =>
      assignment.entries.some((item) => entryKey(item) === entryKey(entry)),
    ) ?? [];
  const storageLines = [
    ...new Set(
      scoped.flatMap((entry) =>
        entry.storage
          .filter((ref) => ref.key !== "dynamic")
          .map((ref) => `${ref.kind}:${ref.key}`),
      ),
    ),
  ]
    .sort()
    .map((key) => {
      const usages = (access: "write" | "read") => [
        ...new Set(
          scoped.flatMap((entry) =>
            entry.storage
              .filter(
                (ref) =>
                  `${ref.kind}:${ref.key}` === key && ref.access === access,
              )
              .map((ref) => `${entryKey(entry)} (${ref.file}:${ref.line})`),
          ),
        ),
      ];
      const writers = usages("write");
      const readers = usages("read");
      return `- ${key.replace(":", " \`")}\` — written by ${writers.join(", ") || "none"}; read by ${readers.join(", ") || "none found in this partition"}`;
    });
  return [
    `## Assigned entry points (partition ${assignment.partition + 1} of ${assignment.of})`,
    `Source root: /workspace/main.${coreMounted ? " WordPress core: /workspace/wordpress (read-only)." : ""} These registrations are this run's starting scope. Other entry points are assigned to other runs.`,
    ...lines,
    `Registration files: ${assignment.files.join(", ")}`,
    ...(assignment.sourceIndex === undefined
      ? []
      : [
          "Storage keys in scope:",
          ...storageLines,
          ...(assignment.boundaryKeys?.length
            ? [
                `Boundary keys shared with another partition: ${assignment.boundaryKeys.join(", ")}`,
              ]
            : []),
          `Settings keys this plugin reads: ${assignment.sourceIndex.settingsKeys.join(", ") || "none"}`,
          `Index: ${assignment.sourceIndex.incomplete ? "partial (limit reached)" : "complete"}`,
        ]),
  ].join("\n");
}

/** Stable text of the whole plan, for the operator and for tests. */
export function describeWordPressEntryPlan(
  assignments: readonly WordPressEntryAssignment[],
): string {
  return canonicalJson(
    assignments.map((assignment) => ({
      partition: assignment.partition,
      of: assignment.of,
      entries: assignment.entries.map(entryKey),
    })),
  );
}
