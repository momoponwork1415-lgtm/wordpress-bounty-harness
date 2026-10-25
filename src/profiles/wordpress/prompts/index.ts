import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * One row per agent-facing text under this directory. The `.md` file is
 * `${id}.md`; the digest pins its exact bytes so past Trials can be matched.
 * Old versions stay here for digest matching only (ADR 0029).
 */
interface WordPressPromptRecord {
  readonly id: string;
  readonly digest: `sha256:${string}`;
  /** Exactly one row per table (per mode for discovery) is `current`; everything else is archived. */
  readonly status: "current" | "archived";
}

/**
 * The launch mode a discovery objective is written for (ADR 0039). `deep` is
 * the single cooperative Trial with the 60-minute active floor; `wide` is the
 * short bounded pass without a floor. Archived rows carry no mode.
 */
export type WordPressDiscoveryMode = "deep" | "wide";
export const WORDPRESS_DISCOVERY_MODES = ["deep", "wide"] as const;

/** Generated Finding / Lead contract versions the Harness appends (ADR 0019). */
export type WordPressOutputContractVersion = "v1" | "v2" | "v4";

/**
 * The human-written parts of a discovery objective (redesign 2026-10-25 §5).
 * Run parameters and the output contract are generated, so they are not here.
 */
export const WORDPRESS_PROMPT_SECTIONS = [
  "objective",
  "strategy",
  "coordination",
  "persistence",
] as const;
export type WordPressPromptSection = (typeof WORDPRESS_PROMPT_SECTIONS)[number];

/** One file under `sections/<section>/`; a file holds whole paragraphs only. */
export interface WordPressPromptFragment {
  readonly section: WordPressPromptSection;
  readonly file: string;
}

export interface WordPressDiscoveryPromptRecord extends WordPressPromptRecord {
  /**
   * `null`: the body carries its own handwritten output contract.
   * Otherwise the body is objective-only and receives this generated version.
   */
  readonly outputContract: WordPressOutputContractVersion | null;
  /** Required on a `current` row: the campaign mode that launches it. */
  readonly mode?: WordPressDiscoveryMode;
  /**
   * The body is composed from these files in order. The composition is
   * byte-identical to `${id}.md`, which stays as the reference copy, so
   * `digest` is the same either way.
   */
  readonly fragments?: readonly WordPressPromptFragment[];
}

// Paragraphs both current objectives carry unchanged.
const TASK = { section: "objective", file: "task-v10" } as const;
const LIFETIME = { section: "coordination", file: "lifetime-v10" } as const;
const SOURCES = { section: "objective", file: "sources-v8" } as const;

export const WORDPRESS_DISCOVERY_PROMPTS = [
  {
    id: "wp2shell-derived-v1",
    digest:
      "sha256:99ce948c3985b054306f1e7ccda8a76db89d8b9a5c9e92f453cb0c852dcda96a",
    outputContract: null,
    status: "archived",
  },
  {
    id: "short-objective-v1",
    digest:
      "sha256:66c14c0334c5e70e546e1ed8c10f760b4005f56fe626b02e3de78f09f69af7c0",
    outputContract: null,
    status: "archived",
  },
  {
    id: "wp2shell-derived-v2",
    digest:
      "sha256:f9d90b8ad1dd955527756bf9ad9869624cff999dd7fab3908a7f050b1cd422be",
    outputContract: null,
    status: "archived",
  },
  {
    id: "short-objective-v2",
    digest:
      "sha256:e6a7a1650f2af3c1e34d73a42c2d378497f4553818967cb804227cbd01436809",
    outputContract: null,
    status: "archived",
  },
  {
    id: "short-objective-managed-v1",
    digest:
      "sha256:58460c592c424fe752c8e9fdf0b53b686302ee1e11d72a48a06dc9109a496215",
    outputContract: null,
    status: "archived",
  },
  {
    id: "short-objective-managed-v2",
    digest:
      "sha256:05331cbdf24b49b6352020ce6faf84f5d005e275d0665f88287c9ae7c4d54825",
    outputContract: null,
    status: "archived",
  },
  {
    id: "short-objective-managed-v3",
    digest:
      "sha256:989cec70830ff7d145e3c72fd9a984cacd253d181c253851e070f3bff50e6bab",
    outputContract: null,
    status: "archived",
  },
  {
    id: "short-objective-managed-v4",
    digest:
      "sha256:7aa340bdab52d28f0830f38b43703e958d44e163b3ac937ff7be7896ccd73040",
    outputContract: null,
    status: "archived",
  },
  {
    id: "short-objective-managed-v5",
    digest:
      "sha256:972ebe7d10a0173fef24a7603e01defcb17fd81e87810795f705737114f584b4",
    outputContract: "v1",
    status: "archived",
  },
  {
    id: "screening-v1",
    digest:
      "sha256:effeb9e343601157e2da76eb65b99d4de91a9618daf7379efce13491a1d6aba6",
    outputContract: "v1",
    status: "archived",
  },
  {
    id: "wp2shell-single-http-v2",
    digest:
      "sha256:a466aa5d5abba7ff18b70135d3ae7730880674652c87fd65feaa3534765904fe",
    outputContract: null,
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v1",
    digest:
      "sha256:5b334f59d315d6cee721b7dc698353ed5a9f44553474dd87c7aac7192d832a98",
    outputContract: null,
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v2",
    digest:
      "sha256:efeaefbd1775e2a4fd3984e19672e7e5cf8cfdbe0b16b84cededa23587b239c5",
    outputContract: null,
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v3",
    digest:
      "sha256:a97b4b3c1101470cec743dd51af1d2169f15d4d5ee1a2797997be05edef72c9b",
    outputContract: "v2",
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v4",
    digest:
      "sha256:6c823fe2ddb8a9af27ea743927f5d4a8203ec29ef4bca7dbadf3135c1739ab62",
    outputContract: "v2",
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v5",
    digest:
      "sha256:59c6bd1bb5fd5ef7618ce180de7f2d90af68fa4bcba26f90aa31aa3679d80cda",
    outputContract: "v2",
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v6",
    digest:
      "sha256:3b85b6bdacd3181da779fd6cc1eec5c45c9e01d4f16e80163fdab4e62dff3503",
    outputContract: "v2",
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v7",
    digest:
      "sha256:bb41592c57ce664a90b8b429d9d3d0c86da7c5547aeae9048a18440af9b1893e",
    outputContract: "v2",
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v8",
    digest:
      "sha256:d44532a985d1ef6b74f7117ea8bafbb60b25a7ae191d17ee362b2da58f3c639d",
    outputContract: "v4",
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v10",
    digest:
      "sha256:fd4e395ecb50923487c9bab6dbae81f0aff4e67342abecedda3f53cd9ff5f8b3",
    outputContract: "v4",
    status: "current",
    mode: "deep",
    fragments: [
      TASK,
      { section: "objective", file: "first-principles-v7" },
      { section: "coordination", file: "dynamic-v7" },
      { section: "strategy", file: "portfolio-v10" },
      { section: "coordination", file: "registry-v7" },
      LIFETIME,
      { section: "persistence", file: "research-v10" },
      SOURCES,
      { section: "coordination", file: "persist-deep-v7" },
      { section: "coordination", file: "stop-deep-v8" },
    ],
  },
  {
    id: "wp2shell-bounty-v10-wide",
    digest:
      "sha256:b886625bc576196e38879b3dd85bd25bc5d75e5e960c79b4d8aaec8c1e494a18",
    outputContract: "v4",
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v11-wide",
    digest:
      "sha256:e7c46f4b5289731f7d780640f009b58a305f99099e2ba10148fb2c1b6b4f676b",
    outputContract: "v4",
    status: "archived",
  },
  {
    id: "wp2shell-bounty-v12-wide",
    digest:
      "sha256:9a79a3b20fdba7af54f32464d868ab00806335c526781aba026e76ce9290c3c3",
    outputContract: "v4",
    status: "current",
    mode: "wide",
    fragments: [
      TASK,
      { section: "objective", file: "first-principles-v11" },
      { section: "strategy", file: "sinks-v12" },
      { section: "strategy", file: "shapes-v12" },
      LIFETIME,
      { section: "persistence", file: "research-v11" },
      SOURCES,
      { section: "coordination", file: "fixed-v11" },
      { section: "coordination", file: "stop-wide-v11" },
    ],
  },
  {
    id: "wp2shell-whitebox-v1.7",
    digest:
      "sha256:3318ae6a06290ffbf306533f66357eb41401c1c48ccc7de7cc4e991ac3e07afb",
    outputContract: "v2",
    status: "archived",
  },
] as const satisfies readonly WordPressDiscoveryPromptRecord[];

/** Human-written trust boundary declaration shared by every discovery prompt. */
export const WORDPRESS_TRUST_BOUNDARY = {
  id: "trust-boundary-v1",
  digest:
    "sha256:962eee77bb9a0e98c8f0ce53129ea842801714ad4cf3226f1d151dbdca0040fd",
  status: "current",
} as const satisfies WordPressPromptRecord;

/** Fixed Verifier instructions; the caller records this exact byte digest. */
export const WORDPRESS_VERIFIER_PROMPTS = [
  {
    id: "verifier-v6",
    digest:
      "sha256:f548a5a3121fc8eb1d761042577944c3fbf5899bd481884ed690753cf3400d58",
    status: "archived",
  },
  {
    id: "verifier-v7",
    digest:
      "sha256:df5ed497912146fd4ceaeacbf923d3cee3337c477afad8645044fca460bd3b18",
    status: "archived",
  },
  {
    id: "verifier-v8",
    digest:
      "sha256:798b881faa52504e68fde9a9129dee4bfe471798fe3f9bc21b38635caa12e830",
    status: "current",
  },
] as const satisfies readonly WordPressPromptRecord[];

type DiscoveryPromptRow = (typeof WORDPRESS_DISCOVERY_PROMPTS)[number];
type VerifierPromptRow = (typeof WORDPRESS_VERIFIER_PROMPTS)[number];
type CurrentOf<Row extends WordPressPromptRecord> = Extract<
  Row,
  { status: "current" }
>;

function currentOf<const Row extends WordPressPromptRecord>(
  rows: readonly Row[],
  mode?: WordPressDiscoveryMode,
): CurrentOf<Row> {
  const current = rows.filter(
    (row): row is CurrentOf<Row> =>
      row.status === "current" &&
      (mode === undefined || ("mode" in row && row.mode === mode)),
  );
  if (current.length !== 1)
    throw new Error("Exactly one prompt version must be current");
  return current[0]!;
}

export type WordPressDiscoveryPromptId = DiscoveryPromptRow["id"];
export type WordPressVerifierPromptId = VerifierPromptRow["id"];
export type WordPressDiscoveryAssetId =
  WordPressDiscoveryPromptId | typeof WORDPRESS_TRUST_BOUNDARY.id;

export const WORDPRESS_DISCOVERY_PROMPT_IDS: readonly WordPressDiscoveryPromptId[] =
  WORDPRESS_DISCOVERY_PROMPTS.map((prompt) => prompt.id);

/** The current discovery objective of each launch mode (ADR 0039). */
export const WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS = {
  deep: currentOf(WORDPRESS_DISCOVERY_PROMPTS, "deep").id,
  wide: currentOf(WORDPRESS_DISCOVERY_PROMPTS, "wide").id,
} as const satisfies Record<WordPressDiscoveryMode, WordPressDiscoveryPromptId>;

/** The `deep` objective: the single cooperative Trial every earlier decision names. */
export const WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID =
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS.deep;

/** The mode a current objective launches under; archived objectives have none. */
export function wordPressDiscoveryModeOf(
  id: string,
): WordPressDiscoveryMode | undefined {
  return wordPressDiscoveryPrompt(id).mode;
}

/** These objectives receive the current Harness-generated output contract. */
export const WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS: readonly WordPressDiscoveryPromptId[] =
  WORDPRESS_DISCOVERY_PROMPTS.filter(
    (prompt) => prompt.outputContract !== null,
  ).map((prompt) => prompt.id);

export const WORDPRESS_DISCOVERY_ASSET_IDS: readonly WordPressDiscoveryAssetId[] =
  [...WORDPRESS_DISCOVERY_PROMPT_IDS, WORDPRESS_TRUST_BOUNDARY.id];

export const WORDPRESS_VERIFIER_PROMPT_ID = currentOf(
  WORDPRESS_VERIFIER_PROMPTS,
).id;

/** Looks a discovery prompt version up by id; unknown ids are a caller bug. */
export function wordPressDiscoveryPrompt(
  id: string,
): WordPressDiscoveryPromptRecord {
  const record = WORDPRESS_DISCOVERY_PROMPTS.find((prompt) => prompt.id === id);
  if (record === undefined)
    throw new Error("Unknown WordPress discovery prompt");
  return record;
}

export interface WordPressDiscoveryAsset {
  readonly id: WordPressDiscoveryAssetId;
  readonly sourceUrl: URL;
  readonly text: string;
  readonly digest: `sha256:${string}`;
  /**
   * Set only for an objective composed from fragments: sha256 of each
   * section's fragments composed alone, in the order the row lists them.
   */
  readonly sectionDigests?: Partial<
    Record<WordPressPromptSection, `sha256:${string}`>
  >;
}

const sha256 = (bytes: Uint8Array | string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function readPromptFile<Id extends string>(
  id: Id,
): Promise<{
  readonly id: Id;
  readonly sourceUrl: URL;
  readonly text: string;
  readonly digest: `sha256:${string}`;
}> {
  const sourceUrl = new URL(`./${id}.md`, import.meta.url);
  const bytes = await readFile(sourceUrl);
  return {
    id,
    sourceUrl,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    digest: sha256(bytes),
  };
}

const DISCOVERY_ASSET_IDS: ReadonlySet<string> = new Set(
  WORDPRESS_DISCOVERY_ASSET_IDS,
);
const VERIFIER_PROMPT_IDS: ReadonlySet<string> = new Set(
  WORDPRESS_VERIFIER_PROMPTS.map((prompt) => prompt.id),
);

/**
 * Fragments are whole paragraphs, each file ending in one newline. Joining
 * them with the blank line that separates paragraphs gives the `.md` bytes.
 */
function composeFragments(texts: readonly string[]): string {
  return `${texts.map((text) => text.slice(0, -1)).join("\n\n")}\n`;
}

async function readFragment(fragment: WordPressPromptFragment) {
  const text = await readFile(
    new URL(
      `./sections/${fragment.section}/${fragment.file}.md`,
      import.meta.url,
    ),
    "utf8",
  );
  if (!/^\S[\s\S]*\S\n$/.test(text) || text.endsWith("\n\n"))
    throw new Error("A prompt fragment must hold whole paragraphs");
  return text;
}

export async function loadWordPressDiscoveryAsset(
  id: WordPressDiscoveryAssetId,
): Promise<WordPressDiscoveryAsset> {
  if (!DISCOVERY_ASSET_IDS.has(id))
    throw new Error("Unknown WordPress discovery asset");
  if (id === WORDPRESS_TRUST_BOUNDARY.id) return readPromptFile(id);
  const record = wordPressDiscoveryPrompt(id);
  if (record.fragments === undefined) return readPromptFile(id);
  const texts = await Promise.all(record.fragments.map(readFragment));
  const text = composeFragments(texts);
  const digest = sha256(text);
  if (digest !== record.digest)
    throw new Error("Composed prompt differs from its pinned digest");
  const sectionDigests: Partial<
    Record<WordPressPromptSection, `sha256:${string}`>
  > = {};
  for (const section of WORDPRESS_PROMPT_SECTIONS) {
    const own = texts.filter(
      (_, index) => record.fragments![index]!.section === section,
    );
    if (own.length > 0) sectionDigests[section] = sha256(composeFragments(own));
  }
  return {
    id,
    sourceUrl: new URL(`./${id}.md`, import.meta.url),
    text,
    digest,
    sectionDigests,
  };
}

export async function loadWordPressVerifierPrompt(
  id: WordPressVerifierPromptId = WORDPRESS_VERIFIER_PROMPT_ID,
): Promise<{
  readonly id: WordPressVerifierPromptId;
  readonly text: string;
  readonly digest: `sha256:${string}`;
}> {
  if (!VERIFIER_PROMPT_IDS.has(id))
    throw new Error("Unknown WordPress Verifier prompt");
  const { text, digest } = await readPromptFile(id);
  return { id, text, digest };
}
