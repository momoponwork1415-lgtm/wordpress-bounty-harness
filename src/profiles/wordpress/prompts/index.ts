import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * One row per agent-facing text under this directory. The `.md` file is
 * `${id}.md`; the digest pins its exact bytes. Only the texts a new Trial
 * receives stay here. Earlier versions were moved to `history/prompts/` on
 * 2026-11-05; the Harness does not read them, and a Trial that recorded one is
 * refused on resume as `prompt-version-differs`.
 */
interface WordPressPromptRecord {
  readonly id: string;
  readonly digest: `sha256:${string}`;
  /**
   * Exactly one row per table (per mode for discovery) is `current`. A
   * discovery `candidate` is the new version of a production comparison
   * (DEVELOPMENT §5): a campaign launches it only by naming it.
   */
  readonly status: "current" | "candidate";
}

/**
 * The launch mode a new Trial may take. `deep` was retired on 2026-11-05
 * (ADR 0039 addendum); its Trials keep `mode: "deep"` in the ledger.
 */
export type WordPressDiscoveryMode = "wide";
export const WORDPRESS_DISCOVERY_MODES = ["wide"] as const;

/** Generated Finding / Lead contract versions the Harness appends (ADR 0019). */
export type WordPressOutputContractVersion = "v4";

export interface WordPressDiscoveryPromptRecord extends WordPressPromptRecord {
  /**
   * `null`: the body carries its own handwritten output contract.
   * Otherwise the body is objective-only and receives this generated version.
   */
  readonly outputContract: WordPressOutputContractVersion | null;
  /** The campaign mode that launches it. */
  readonly mode: WordPressDiscoveryMode;
}

export const WORDPRESS_DISCOVERY_PROMPTS = [
  {
    id: "wp2shell-bounty-v26-wide",
    digest:
      "sha256:5524803320490e0ce15f3fed4253a13216cf8c37a3545b26a27c162bfd6939e4",
    outputContract: "v4",
    status: "current",
    mode: "wide",
    // Current wide objective based on the exact 2026-07-30 TranslatePress
    // direct-discovery contract. The Root owns a class-neutral portfolio,
    // adversarial review and on-demand Lab questions. The historical source
    // and this current-Harness adaptation have distinct digests.
  },
] as const satisfies readonly WordPressDiscoveryPromptRecord[];

/** Human-written trust declarations; v26 receives v2. */
export const WORDPRESS_TRUST_BOUNDARIES = [
  {
    id: "trust-boundary-v2",
    digest:
      "sha256:23d5e9ebe487751f93fdf7b290ed30c898d20f4d8443d778125e5a4dde1dfb2e",
    status: "current",
  },
] as const satisfies readonly WordPressPromptRecord[];

type DiscoveryPromptRow = (typeof WORDPRESS_DISCOVERY_PROMPTS)[number];
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

/** The declaration every new Trial receives. */
export const WORDPRESS_TRUST_BOUNDARY = currentOf(WORDPRESS_TRUST_BOUNDARIES);

/** The declaration a Trial recorded, if the registry still has it. */
export function wordPressTrustBoundaryId(
  id: string | undefined,
): (typeof WORDPRESS_TRUST_BOUNDARIES)[number]["id"] | undefined {
  return WORDPRESS_TRUST_BOUNDARIES.find((row) => row.id === id)?.id;
}

export type WordPressDiscoveryPromptId = DiscoveryPromptRow["id"];
export type WordPressDiscoveryAssetId =
  | WordPressDiscoveryPromptId
  | (typeof WORDPRESS_TRUST_BOUNDARIES)[number]["id"];

export const WORDPRESS_DISCOVERY_PROMPT_IDS: readonly WordPressDiscoveryPromptId[] =
  WORDPRESS_DISCOVERY_PROMPTS.map((prompt) => prompt.id);

/** The current discovery objective of each launch mode (ADR 0039). */
export const WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS = {
  wide: currentOf(WORDPRESS_DISCOVERY_PROMPTS, "wide").id,
} as const satisfies Record<WordPressDiscoveryMode, WordPressDiscoveryPromptId>;

/**
 * Every objective a new campaign may name: the current one of each mode and
 * any `candidate` under comparison with it (DEVELOPMENT §5).
 */
export const WORDPRESS_LAUNCHABLE_DISCOVERY_PROMPT_IDS =
  WORDPRESS_DISCOVERY_PROMPTS.map((row) => row.id);

/** The current objective of the only launch mode, `wide`. */
export const WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID =
  WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS.wide;

/** The mode a registered objective launches under; other ids have none. */
export function wordPressDiscoveryModeOf(
  id: string,
): WordPressDiscoveryMode | undefined {
  return WORDPRESS_DISCOVERY_PROMPTS.find((prompt) => prompt.id === id)?.mode;
}

/** These objectives receive the current Harness-generated output contract. */
export const WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS: readonly WordPressDiscoveryPromptId[] =
  WORDPRESS_DISCOVERY_PROMPTS.filter(
    (prompt) => prompt.outputContract !== null,
  ).map((prompt) => prompt.id);

export const WORDPRESS_DISCOVERY_ASSET_IDS: readonly WordPressDiscoveryAssetId[] =
  [
    ...WORDPRESS_DISCOVERY_PROMPT_IDS,
    ...WORDPRESS_TRUST_BOUNDARIES.map((row) => row.id),
  ];

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
}

const DISCOVERY_ASSET_IDS: ReadonlySet<string> = new Set(
  WORDPRESS_DISCOVERY_ASSET_IDS,
);

export async function loadWordPressDiscoveryAsset(
  id: WordPressDiscoveryAssetId,
): Promise<WordPressDiscoveryAsset> {
  if (!DISCOVERY_ASSET_IDS.has(id))
    throw new Error("Unknown WordPress discovery asset");
  const sourceUrl = new URL(`./${id}.md`, import.meta.url);
  const bytes = await readFile(sourceUrl);
  const asset = {
    id,
    sourceUrl,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  } as const;
  const trustBoundary = WORDPRESS_TRUST_BOUNDARIES.find((row) => row.id === id);
  if (trustBoundary !== undefined && asset.digest !== trustBoundary.digest)
    throw new Error("WordPress trust boundary differs from its pinned digest");
  return asset;
}
