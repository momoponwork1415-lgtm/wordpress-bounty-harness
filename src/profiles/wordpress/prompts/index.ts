import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const WORDPRESS_DISCOVERY_PROMPT_IDS = [
  "wp2shell-derived-v1",
  "short-objective-v1",
] as const;

export const WORDPRESS_DISCOVERY_ASSET_IDS = [
  ...WORDPRESS_DISCOVERY_PROMPT_IDS,
  "trust-boundary-v1",
  "file-assignment-v1",
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
    case "trust-boundary-v1":
    case "file-assignment-v1":
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
export async function loadWordPressVerifierPrompt(): Promise<{
  readonly text: string;
  readonly digest: `sha256:${string}`;
}> {
  const bytes = await readFile(new URL("./verifier-v2.md", import.meta.url));
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
