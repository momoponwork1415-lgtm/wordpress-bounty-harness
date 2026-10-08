import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAttachmentStore } from "../../src/discovery/provider-research-report.js";

describe("provider attachments", () => {
  it("stores report attachments in the private store and returns a digest reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-attachments-"));
    try {
      const store = new ProviderAttachmentStore(root);
      const bytes = Buffer.from(JSON.stringify({ findings: [] }));
      const reference = await store.put("findings", bytes);
      expect(JSON.stringify(reference)).not.toContain('findings":[]');
      expect(await store.read(reference)).toEqual({
        status: "resolved",
        bytes,
      });
      expect(await store.put("findings", bytes)).toEqual(reference);
      expect(
        await store.read({ ...reference, digest: `sha256:${"0".repeat(64)}` }),
      ).toEqual({ status: "invalid" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
