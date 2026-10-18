import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const WORDPRESS_DISCOVERY_PROMPT_IDS = [
  "wp2shell-derived-v1",
  "short-objective-v1",
  "wp2shell-derived-v2",
  "short-objective-v2",
  "short-objective-managed-v1",
  "short-objective-managed-v2",
  "short-objective-managed-v3",
  "short-objective-managed-v4",
  "short-objective-managed-v5",
  "screening-v1",
  "wp2shell-single-http-v2",
  "wp2shell-bounty-v1",
  "wp2shell-bounty-v2",
  "wp2shell-bounty-v3",
  "wp2shell-bounty-v4",
  "wp2shell-bounty-v5",
  "wp2shell-bounty-v6",
  "wp2shell-whitebox-v1.7",
] as const;

/** These objectives receive the current Harness-generated output contract. */
export const WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS = [
  "short-objective-managed-v5",
  "screening-v1",
  "wp2shell-bounty-v3",
  "wp2shell-bounty-v4",
  "wp2shell-bounty-v5",
  "wp2shell-bounty-v6",
  "wp2shell-whitebox-v1.7",
] as const;

export const WORDPRESS_DISCOVERY_ASSET_IDS = [
  ...WORDPRESS_DISCOVERY_PROMPT_IDS,
  "trust-boundary-v1",
] as const;

export type WordPressDiscoveryAssetId =
  (typeof WORDPRESS_DISCOVERY_ASSET_IDS)[number];

export interface WordPressDiscoveryAsset {
  readonly id: WordPressDiscoveryAssetId;
  readonly sourceUrl: URL;
  readonly text: string;
  readonly digest: `sha256:${string}`;
}

export async function loadWordPressDiscoveryAsset(
  id: WordPressDiscoveryAssetId,
): Promise<WordPressDiscoveryAsset> {
  let fileName: string;
  switch (id) {
    case "wp2shell-derived-v1":
    case "short-objective-v1":
    case "wp2shell-derived-v2":
    case "short-objective-v2":
    case "short-objective-managed-v1":
    case "short-objective-managed-v2":
    case "short-objective-managed-v3":
    case "short-objective-managed-v4":
    case "short-objective-managed-v5":
    case "screening-v1":
    case "wp2shell-single-http-v2":
    case "wp2shell-bounty-v1":
    case "wp2shell-bounty-v2":
    case "wp2shell-bounty-v3":
    case "wp2shell-bounty-v4":
    case "wp2shell-bounty-v5":
    case "wp2shell-bounty-v6":
    case "wp2shell-whitebox-v1.7":
    case "trust-boundary-v1":
      fileName = `${id}.md`;
      break;
    default:
      throw new Error("Unknown WordPress discovery asset");
  }
  const sourceUrl = new URL(`./${fileName}`, import.meta.url);
  const bytes = await readFile(sourceUrl);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return {
    id,
    sourceUrl,
    text,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

/** Fixed Verifier instructions; the caller records this exact byte digest. */
export const WORDPRESS_VERIFIER_PROMPT_ID = "verifier-v7" as const;
export async function loadWordPressVerifierPrompt(
  id: "verifier-v6" | "verifier-v7" = WORDPRESS_VERIFIER_PROMPT_ID,
): Promise<{
  readonly id: "verifier-v6" | "verifier-v7";
  readonly text: string;
  readonly digest: `sha256:${string}`;
}> {
  const fileName =
    id === "verifier-v6"
      ? "verifier-v6.md"
      : id === "verifier-v7"
        ? "verifier-v7.md"
        : undefined;
  if (fileName === undefined)
    throw new Error("Unknown WordPress Verifier prompt");
  const bytes = await readFile(new URL(`./${fileName}`, import.meta.url));
  return {
    id,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
