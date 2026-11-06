/**
 * The files of an earlier Trial's notes that a later Trial of the same
 * target may receive (ADR 0048, widened by ADR 0049 D): the map `wbh-recon`
 * wrote, the setup record `wbh-setup` wrote, the sink registry, the
 * assumption tables and walks `wbh-falsify` wrote, and the store table the
 * Harness assembles from that Trial's Lab lookups. All derive from that
 * version's pinned source and that Trial's own Lab observations. ADR 0052
 * adds the Root's own open-route list, `continuation.json`, and (2026-11-06
 * addendum) the operator's focus note, `operator-focus.md`, which a named
 * continuation receives from the attachment store, never from an archive.
 */

/** Named files at the root of the sealed notes directory (plus the operator's note). */
export const PRIOR_RESEARCH_FILE_NAMES = [
  "recon-map.md",
  "lab-setup.md",
  "REGISTRY.md",
  "continuation.json",
  "operator-focus.md",
] as const;
export type PriorResearchFileName = (typeof PRIOR_RESEARCH_FILE_NAMES)[number];
/**
 * ADR 0052 (2026-11-06): the operator's note a named continuation passes.
 * It is store-sourced: an archive entry of this name is never admitted.
 */
export const OPERATOR_FOCUS_FILE = "operator-focus.md";
/** The note is passed whole or refused at the command line; it is never cut. */
export const MAX_OPERATOR_FOCUS_BYTES = 8 * 1024;
/** Directories whose `.md` files (one level) are passed whole. */
export const PRIOR_RESEARCH_DIRECTORIES = ["assumptions", "walks"] as const;
/** The Harness-built store table (`buildResearchStores`), never from the archive. */
export const PRIOR_RESEARCH_STORES_FILE = "stores.json";

/** Where the sandbox places the files, relative to `/workspace/research`. */
export const PRIOR_RESEARCH_DIRECTORY = "prior";
/** A whole file is passed or withheld; it is never cut. */
export const MAX_PRIOR_RESEARCH_FILE_BYTES = 64 * 1024;
/** All passed files together; the largest are withheld first past this. */
export const MAX_PRIOR_RESEARCH_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_PRIOR_RESEARCH_FILES = 64;

/**
 * A passed file's name relative to `prior/`: one of the root names, the
 * store table, or `<directory>/<plain name>.md`.
 */
export const PRIOR_RESEARCH_NAME =
  /^(?:recon-map\.md|lab-setup\.md|REGISTRY\.md|continuation\.json|operator-focus\.md|stores\.json|(?:assumptions|walks)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md)$/;

export function isPriorResearchName(name: string): boolean {
  return PRIOR_RESEARCH_NAME.test(name) && !name.includes("..");
}

/** The path the sandbox gives a passed file. */
export function priorResearchPath(name: string): string {
  return `${PRIOR_RESEARCH_DIRECTORY}/${name}`;
}

/** Whether a sandbox path is one a passed file may have. */
export function isPriorResearchPath(path: string): boolean {
  const prefix = `${PRIOR_RESEARCH_DIRECTORY}/`;
  return (
    path.startsWith(prefix) && isPriorResearchName(path.slice(prefix.length))
  );
}

/** The fixed order files appear in: root names, store table, then each directory alphabetically. */
export function priorResearchOrder(a: string, b: string): number {
  const rank = (name: string): number => {
    const root = (PRIOR_RESEARCH_FILE_NAMES as readonly string[]).indexOf(name);
    if (root >= 0) return root;
    if (name === PRIOR_RESEARCH_STORES_FILE)
      return PRIOR_RESEARCH_FILE_NAMES.length;
    const directory = PRIOR_RESEARCH_DIRECTORIES.findIndex((candidate) =>
      name.startsWith(`${candidate}/`),
    );
    return PRIOR_RESEARCH_FILE_NAMES.length + 1 + directory;
  };
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

export interface PriorResearchFile {
  readonly name: string;
  readonly bytes: number;
}

/**
 * Keeps the files within the total size and count; the largest are withheld
 * first (ties: the later in the fixed order) so that the small tables and
 * the map survive. Both lists come back in the fixed order.
 */
export function capPriorResearch<T extends PriorResearchFile>(
  files: readonly T[],
): { readonly kept: readonly T[]; readonly withheld: readonly T[] } {
  const kept = [...files].sort((a, b) => priorResearchOrder(a.name, b.name));
  const withheld: T[] = [];
  const total = () => kept.reduce((sum, file) => sum + file.bytes, 0);
  while (
    kept.length > 0 &&
    (kept.length > MAX_PRIOR_RESEARCH_FILES ||
      total() > MAX_PRIOR_RESEARCH_TOTAL_BYTES)
  ) {
    let largest = 0;
    for (let index = 1; index < kept.length; index += 1)
      if (kept[index]!.bytes >= kept[largest]!.bytes) largest = index;
    withheld.push(...kept.splice(largest, 1));
  }
  withheld.sort((a, b) => priorResearchOrder(a.name, b.name));
  return { kept, withheld };
}

export interface PriorResearchSectionInput {
  /** The version the earlier Trial read and the version this Trial reads. */
  readonly priorVersion: string;
  readonly currentVersion: string;
  readonly files: readonly PriorResearchFile[];
  /** Files of the same Trial withheld for size, by name only. */
  readonly withheld?: readonly string[];
  /** ADR 0052: a continuation Trial; the section ends with its one sentence. */
  readonly continuation?: boolean;
  /** ADR 0052 (2026-11-06): the operator's note was passed; one more sentence follows. */
  readonly focus?: boolean;
}

/**
 * ADR 0052: the one sentence a continuation Trial's section ends with.
 * Agent-facing text: changes need `owner-approved`
 * (docs/reviews/2026-11-06-continuation-section.md).
 */
export const CONTINUATION_SECTION_SENTENCE =
  "The open routes in `/workspace/research/prior/continuation.json` are this Trial's first work: check each against the pinned source, record in your research notes whether it is resolved, disproved or stopped by privilege, and only then move to new approach families.";

/**
 * ADR 0052 (2026-11-06 addendum): the one sentence added after the
 * continuation sentence when the operator's note was passed. Agent-facing
 * text: changes need `owner-approved`
 * (docs/reviews/2026-11-06-focus-section.md).
 */
export const FOCUS_SECTION_SENTENCE =
  "The operator's note in `/workspace/research/prior/operator-focus.md` names where this Trial starts; like the other prior files it is a hint and may be wrong.";

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DESCRIPTION: Partial<Record<string, string>> = {
  "recon-map.md": "the map of the plugin that wbh-recon wrote",
  "lab-setup.md": "the record of the Lab's ordinary use that wbh-setup wrote",
};

/**
 * The Harness-generated `## Prior research` section (ADR 0019 pattern, ADR
 * 0047): which files an earlier Trial of the same target left, which version
 * they describe, and where they are. It states facts and says nothing about
 * what to try. Agent-facing text: changes need `owner-approved`. The 2026-11-02
 * widening (ADR 0049 D) added file lines and the withheld line only; the
 * prose is the 2026-11-01 text.
 */
export function priorResearchSection(input: PriorResearchSectionInput): string {
  if (input.files.length === 0) throw new Error("No prior research to state");
  if (!VERSION.test(input.priorVersion) || !VERSION.test(input.currentVersion))
    throw new Error("A version is not a plain version string");
  const names = new Set(input.files.map(({ name }) => name));
  if (names.size !== input.files.length)
    throw new Error("A prior research file is named twice");
  for (const name of [...names, ...(input.withheld ?? [])])
    if (!isPriorResearchName(name))
      throw new Error("A prior research file has a name outside the set");
  const lines = [...input.files]
    .sort((a, b) => priorResearchOrder(a.name, b.name))
    .map((file) => {
      const description = DESCRIPTION[file.name];
      return description === undefined
        ? `- /workspace/research/${priorResearchPath(file.name)} (${file.bytes} bytes).`
        : `- /workspace/research/${priorResearchPath(file.name)}: ${description} (${file.bytes} bytes).`;
    });
  const withheld = [...(input.withheld ?? [])].sort(priorResearchOrder);
  if (withheld.length > 0)
    lines.push(`- Withheld for size, not placed: ${withheld.join(", ")}.`);
  return [
    "## Prior research",
    `An earlier Trial on version ${input.priorVersion} of this same plugin wrote the files below from that version's pinned source, with the same skills. This Trial reads version ${input.currentVersion}. The files describe the earlier version, not this one: a part of the plugin that changed since may differ from what they say, and nothing in them is confirmed. This Trial's own files go to /workspace/research as the skills describe; the prior files stay where they are.`,
    lines.join("\n"),
    ...(input.continuation === true ? [CONTINUATION_SECTION_SENTENCE] : []),
    ...(input.focus === true ? [FOCUS_SECTION_SENTENCE] : []),
  ].join("\n\n");
}
