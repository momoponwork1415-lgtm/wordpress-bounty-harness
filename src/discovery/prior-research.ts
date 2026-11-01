/**
 * The files of an earlier Trial's notes that a later Trial of the same
 * target may receive (ADR 0048): the map `wbh-recon` wrote and the setup
 * record `wbh-setup` wrote, both derived from that version's pinned source.
 */
export const PRIOR_RESEARCH_FILE_NAMES = [
  "recon-map.md",
  "lab-setup.md",
] as const;
export type PriorResearchFileName = (typeof PRIOR_RESEARCH_FILE_NAMES)[number];

/** Where the sandbox places the files, relative to `/workspace/research`. */
export const PRIOR_RESEARCH_DIRECTORY = "prior";
/** A whole file is passed or withheld; it is never cut. */
export const MAX_PRIOR_RESEARCH_FILE_BYTES = 64 * 1024;

export interface PriorResearchFile {
  readonly name: PriorResearchFileName;
  readonly bytes: number;
}

export interface PriorResearchSectionInput {
  /** The version the earlier Trial read and the version this Trial reads. */
  readonly priorVersion: string;
  readonly currentVersion: string;
  readonly files: readonly PriorResearchFile[];
}

/** The path the sandbox gives a passed file. */
export function priorResearchPath(name: PriorResearchFileName): string {
  return `${PRIOR_RESEARCH_DIRECTORY}/${name}`;
}

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DESCRIPTION: Record<PriorResearchFileName, string> = {
  "recon-map.md": "the map of the plugin that wbh-recon wrote",
  "lab-setup.md": "the record of the Lab's ordinary use that wbh-setup wrote",
};

/**
 * The Harness-generated `## Prior research` section (ADR 0019 pattern, ADR
 * 0047): which files an earlier Trial of the same target left, which version
 * they describe, and where they are. It states facts and says nothing about
 * what to try. Agent-facing text: changes need `owner-approved`.
 */
export function priorResearchSection(input: PriorResearchSectionInput): string {
  if (input.files.length === 0) throw new Error("No prior research to state");
  if (!VERSION.test(input.priorVersion) || !VERSION.test(input.currentVersion))
    throw new Error("A version is not a plain version string");
  const names = new Set(input.files.map(({ name }) => name));
  if (names.size !== input.files.length)
    throw new Error("A prior research file is named twice");
  const lines = PRIOR_RESEARCH_FILE_NAMES.flatMap((name) => {
    const file = input.files.find((candidate) => candidate.name === name);
    return file === undefined
      ? []
      : [
          `- /workspace/research/${priorResearchPath(name)}: ${DESCRIPTION[name]} (${file.bytes} bytes).`,
        ];
  });
  return [
    "## Prior research",
    `An earlier Trial on version ${input.priorVersion} of this same plugin wrote the files below from that version's pinned source, with the same skills. This Trial reads version ${input.currentVersion}. The files describe the earlier version, not this one: a part of the plugin that changed since may differ from what they say, and nothing in them is confirmed. This Trial's own files go to /workspace/research as the skills describe; the prior files stay where they are.`,
    lines.join("\n"),
  ].join("\n\n");
}
