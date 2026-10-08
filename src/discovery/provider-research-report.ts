import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  PrivateArtifactStore,
  type PrivateArtifactDescriptor,
} from "../infrastructure/private-artifact-store.js";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const kindSchema = z.enum(["findings", "coverage", "diagnostic"]);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const providerAttachmentRefSchema = z.strictObject({
  kind: kindSchema,
  digest: digestSchema,
  artifact: z.strictObject({
    artifactId: z.string().min(1),
    digest: digestSchema,
    entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
});
export type ProviderAttachmentRef = z.infer<typeof providerAttachmentRefSchema>;

/** Stores provider attachments privately; callers receive only a content digest and artifact reference. */
export class ProviderAttachmentStore {
  readonly #store: PrivateArtifactStore;

  constructor(rootDirectory: string) {
    this.#store = new PrivateArtifactStore({
      rootDirectory,
      maxEntries: 1,
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
  }

  async put(kindValue: unknown, bytes: Buffer): Promise<ProviderAttachmentRef> {
    const kind = kindSchema.parse(kindValue);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new Error("Provider attachment size is invalid");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const staging = await this.#store.stage();
    try {
      await writeFile(join(staging.contentDirectory, `${kind}.json`), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      const result = await this.#store.commit(
        `${kind}-${digest.slice(7)}`,
        staging,
      );
      if (result.status === "conflict")
        throw new Error("Provider attachment conflict");
      return providerAttachmentRefSchema.parse({
        kind,
        digest,
        artifact: result.artifact,
      });
    } catch (error: unknown) {
      await rm(staging.rootDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async read(
    reference: ProviderAttachmentRef,
  ): Promise<
    { status: "resolved"; bytes: Buffer } | { status: "missing" | "invalid" }
  > {
    const parsed = providerAttachmentRefSchema.safeParse(reference);
    if (!parsed.success) return { status: "invalid" };
    const result = await this.#store.readFile(
      parsed.data.artifact as PrivateArtifactDescriptor,
      `${parsed.data.kind}.json`,
      MAX_ATTACHMENT_BYTES,
    );
    if (result.status === "missing") return { status: "missing" };
    if (result.status !== "resolved") return { status: "invalid" };
    const digest = `sha256:${createHash("sha256").update(result.bytes).digest("hex")}`;
    return digest === parsed.data.digest
      ? { status: "resolved", bytes: result.bytes }
      : { status: "invalid" };
  }
}
