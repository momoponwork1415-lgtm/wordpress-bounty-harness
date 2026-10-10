import { deflateRawSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openSnapshot } from "../../../src/snapshot/index.js";
import {
  createWordPressOrgFetchAdapter,
  openWordPressOrgTargetSource,
  openWordPressOrgSnapshotSource,
  type WordPressOrgSourceAdapter,
} from "../../../src/profiles/wordpress/acquisition/index.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ArchiveEntry {
  readonly content: string;
  readonly unixMode?: number;
}

function archive(
  entries: Readonly<Record<string, string | ArchiveEntry>>,
): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [path, value] of Object.entries(entries)) {
    const content = typeof value === "string" ? value : value.content;
    const unixMode =
      typeof value === "string" ? 0o100644 : (value.unixMode ?? 0o100644);
    const name = Buffer.from(path, "utf8");
    const bytes = Buffer.from(content, "utf8");
    const compressed = deflateRawSync(bytes);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(bytes.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE((unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + compressed.byteLength;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centralParts.length / 2, 8);
  end.writeUInt16LE(centralParts.length / 2, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

const intakePolicy = {
  kind: "target-intake-policy" as const,
  schemaVersion: 1 as const,
  id: "wporg-intake-v1",
  digest: digest("a"),
  limits: {
    maxEntries: 100,
    maxFileBytes: 1_000_000,
    maxTotalBytes: 10_000_000,
    maxPathBytes: 512,
    maxDepth: 16,
  },
};

describe("WordPressOrgTargetSource", () => {
  it("uses the production fetch Adapter through the bounded external seam", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(Buffer.from("fixture response"), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const adapter = createWordPressOrgFetchAdapter({ fetch: fetchMock });

    await expect(
      adapter.retrieve({
        kind: "archive",
        sourceUrl:
          "https://downloads.wordpress.org/plugin/example-security.2.4.1.zip",
        maximumBytes: 1_000,
      }),
    ).resolves.toMatchObject({
      status: 200,
      sourceUrl:
        "https://downloads.wordpress.org/plugin/example-security.2.4.1.zip",
      bytes: new Uint8Array(Buffer.from("fixture response")),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://downloads.wordpress.org/plugin/example-security.2.4.1.zip",
      expect.objectContaining({
        method: "GET",
        redirect: "follow",
        headers: { accept: "application/zip" },
      }),
    );
  });

  it("observes official metadata and acquires a version-bound oracle-free Target Intake Packet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wporg-target-source-"));
    const pluginArchive = archive({
      "example-security/example.php": `<?php
/*
Plugin Name: Example Security
Version: 2.4.1
*/
`,
      "example-security/includes/feature.php": "<?php\n",
    });
    const adapter: WordPressOrgSourceAdapter = {
      retrieve: async (request) => {
        if (request.kind === "metadata") {
          return {
            status: 200,
            sourceUrl: request.sourceUrl,
            bytes: Buffer.from(
              JSON.stringify({
                slug: "example-security",
                name: "Example Security",
                version: "2.4.1",
                active_installs: 80_000,
                last_updated: "2026-09-04T12:00:00Z",
                author:
                  '<a href="https://profiles.wordpress.org/example">Independent Author</a>',
                tags: { forms: "forms", upload: "upload" },
                download_link:
                  "https://downloads.wordpress.org/plugin/example-security.2.4.1.zip",
                advisory: "must not cross the seam",
                cve: "must not cross the seam",
              }),
            ),
          };
        }
        return {
          status: 200,
          sourceUrl: request.sourceUrl,
          bytes: pluginArchive,
        };
      },
    };
    try {
      const source = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter,
        clock: () => new Date("2030-07-01T00:00:00.000Z"),
      });

      const observed = await source.observe({
        kind: "wordpress-org-target-observe",
        schemaVersion: 1,
        slug: "example-security",
      });
      expect(observed).toMatchObject({
        status: "observed",
        observation: {
          kind: "wordpress-org-target-observation",
          schemaVersion: 1,
          pluginIdentity: "wporg:example-security",
          officialSlug: "example-security",
          displayName: "Example Security",
          stableVersion: "2.4.1",
          activeInstallations: 80_000,
          lastUpdated: "2026-09-04T12:00:00Z",
          author: "Independent Author",
          tags: ["forms", "upload"],
          observedAt: "2030-07-01T00:00:00.000Z",
          intelligenceSource: {
            kind: "wordpress-org-plugin-directory",
            sourceUrl: expect.stringContaining(
              "api.wordpress.org/plugins/info",
            ),
            retrievedAt: "2030-07-01T00:00:00.000Z",
            contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            parserVersion: "wordpress-org-plugin-information-v1",
          },
          downloadProvenance: {
            sourceUrl:
              "https://downloads.wordpress.org/plugin/example-security.2.4.1.zip",
          },
        },
        observationRef: {
          id: expect.stringMatching(/^wporg-observation:/),
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });
      expect(JSON.stringify(observed)).not.toMatch(/advisory|cve/i);
      if (observed.status !== "observed") {
        throw new Error("Expected an observed WordPress.org target");
      }

      const acquired = await source.acquire({
        kind: "wordpress-org-target-acquire",
        schemaVersion: 1,
        observationRef: observed.observationRef,
        requestedVersion: "2.4.1",
        policy: intakePolicy,
      });
      expect(acquired).toMatchObject({
        status: "ready",
        acquisitionOriginal: {
          kind: "wordpress-org-acquisition-original",
          schemaVersion: 1,
          pluginIdentity: "wporg:example-security",
          version: "2.4.1",
          sourceUrl:
            "https://downloads.wordpress.org/plugin/example-security.2.4.1.zip",
          retrievedAt: "2030-07-01T00:00:00.000Z",
          contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          size: pluginArchive.byteLength,
        },
        intake: {
          status: "ready",
          packet: {
            pluginIdentity: "wporg:example-security",
            version: "2.4.1",
            canonicalInstallDirectory: "example-security",
            mainPluginFile: "example.php",
            pluginBasename: "example-security/example.php",
            sourceTree: { entries: 2 },
            sourceCapture: {
              kind: "captured-wordpress-org-archive",
            },
            provenance: {
              kind: "wordpress-org",
              sourceUrl:
                "https://downloads.wordpress.org/plugin/example-security.2.4.1.zip",
            },
          },
        },
      });
      const snapshot = openSnapshot({
        storageDirectory: join(directory, "snapshots"),
        source: openWordPressOrgSnapshotSource({
          targetSource: source,
          storageDirectory: directory,
        }),
      });
      const frozen = await snapshot.freeze({
        kind: "wordpress-org-target-acquire",
        schemaVersion: 1,
        observationRef: observed.observationRef,
        requestedVersion: "2.4.1",
        policy: intakePolicy,
      });
      expect(frozen.target.identity).toBe("wporg:example-security");
      expect(await snapshot.verify(frozen.digest)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays a persisted observation after restart and converges repeated official bytes to the same packet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wporg-target-replay-"));
    let currentTime = "2030-07-01T00:00:00.000Z";
    const pluginArchive = archive({
      "replay-plugin/replay.php":
        "<?php\n/* Plugin Name: Replay Plugin\nVersion: 1.7.0\n*/\n",
    });
    const adapter: WordPressOrgSourceAdapter = {
      retrieve: async (request) => ({
        status: 200,
        sourceUrl: request.sourceUrl,
        bytes:
          request.kind === "metadata"
            ? Buffer.from(
                JSON.stringify({
                  slug: "replay-plugin",
                  name: "Replay Plugin",
                  version: "1.7.0",
                  active_installs: 12_000,
                  last_updated: "2026-09-01T00:00:00Z",
                  download_link:
                    "https://downloads.wordpress.org/plugin/replay-plugin.1.7.0.zip",
                }),
              )
            : pluginArchive,
      }),
    };
    try {
      const firstSource = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter,
        clock: () => new Date(currentTime),
      });
      const observed = await firstSource.observe({
        kind: "wordpress-org-target-observe",
        schemaVersion: 1,
        slug: "replay-plugin",
      });
      if (observed.status !== "observed") {
        throw new Error("Expected a persisted Target Observation");
      }
      const request = {
        kind: "wordpress-org-target-acquire" as const,
        schemaVersion: 1 as const,
        observationRef: observed.observationRef,
        requestedVersion: "1.7.0",
        policy: intakePolicy,
      };
      const first = await firstSource.acquire(request);
      if (first.status !== "ready") {
        throw new Error("Expected the first acquisition to be ready");
      }

      currentTime = "2030-07-02T00:00:00.000Z";
      const restarted = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter,
        clock: () => new Date(currentTime),
      });
      const second = await restarted.acquire(request);
      if (second.status !== "ready") {
        throw new Error("Expected the replayed acquisition to be ready");
      }

      expect(second.acquisitionOriginal.retrievedAt).not.toBe(
        first.acquisitionOriginal.retrievedAt,
      );
      expect(second.acquisitionOriginalRef).toEqual(
        first.acquisitionOriginalRef,
      );
      expect(second.intake.packetRef).toEqual(first.intake.packetRef);
      expect(second.intake.packet).toEqual(first.intake.packet);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { status: 404, reason: "not-found" },
    { status: 429, reason: "rate-limited" },
    { status: 503, reason: "network-failure" },
  ] as const)(
    "returns $reason when WordPress.org metadata responds $status",
    async ({ status, reason }) => {
      const directory = await mkdtemp(join(tmpdir(), "wporg-target-http-"));
      try {
        const source = openWordPressOrgTargetSource({
          storageDirectory: directory,
          adapter: {
            retrieve: async (request) => ({
              status,
              sourceUrl: request.sourceUrl,
              bytes: new Uint8Array(),
            }),
          },
        });

        await expect(
          source.observe({
            kind: "wordpress-org-target-observe",
            schemaVersion: 1,
            slug: "missing-plugin",
          }),
        ).resolves.toEqual({
          status: "failed",
          operation: "observe",
          reason,
          pluginIdentity: "wporg:missing-plugin",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("returns typed network and metadata failures without inventing an observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wporg-target-invalid-"));
    try {
      const unavailable = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter: {
          retrieve: () => Promise.reject(new Error("network unavailable")),
        },
      });
      await expect(
        unavailable.observe({
          kind: "wordpress-org-target-observe",
          schemaVersion: 1,
          slug: "example",
        }),
      ).resolves.toMatchObject({
        status: "failed",
        operation: "observe",
        reason: "network-failure",
      });

      const invalid = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter: {
          retrieve: async (request) => ({
            status: 200,
            sourceUrl: request.sourceUrl,
            bytes: Buffer.from('{"slug":"example","cve":"oracle"}'),
          }),
        },
      });
      await expect(
        invalid.observe({
          kind: "wordpress-org-target-observe",
          schemaVersion: 1,
          slug: "example",
        }),
      ).resolves.toMatchObject({
        status: "failed",
        operation: "observe",
        reason: "invalid-metadata",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a plugin closed for distribution as closed, not as an observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wporg-target-closed-"));
    try {
      const source = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter: {
          retrieve: async (request) => ({
            status: 200,
            sourceUrl: request.sourceUrl,
            bytes: Buffer.from(
              JSON.stringify({
                slug: "closed-plugin",
                name: "Closed Plugin",
                version: "1.0.0",
                active_installs: 9_000,
                last_updated: "2026-09-01T00:00:00Z",
                closed: true,
                download_link:
                  "https://downloads.wordpress.org/plugin/closed-plugin.1.0.0.zip",
              }),
            ),
          }),
        },
      });
      await expect(
        source.observe({
          kind: "wordpress-org-target-observe",
          schemaVersion: 1,
          slug: "closed-plugin",
        }),
      ).resolves.toEqual({
        status: "failed",
        operation: "observe",
        reason: "closed",
        pluginIdentity: "wporg:closed-plugin",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("acquires a pinned older release from its official versioned archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wporg-target-version-"));
    const archiveUrls: string[] = [];
    const pinnedArchive = archive({
      "versioned-plugin/plugin.php":
        "<?php\n/* Plugin Name: Versioned\nVersion: 2.9.0\n*/\n",
    });
    const adapter: WordPressOrgSourceAdapter = {
      retrieve: async (request) => {
        if (request.kind === "archive") archiveUrls.push(request.sourceUrl);
        return {
          status: 200,
          sourceUrl: request.sourceUrl,
          bytes:
            request.kind === "archive"
              ? pinnedArchive
              : Buffer.from(
                  JSON.stringify({
                    slug: "versioned-plugin",
                    name: "Versioned Plugin",
                    version: "3.0.0",
                    active_installs: 2_000,
                    last_updated: "2026-09-01T00:00:00Z",
                    download_link:
                      "https://downloads.wordpress.org/plugin/versioned-plugin.3.0.0.zip",
                  }),
                ),
        };
      },
    };
    try {
      const source = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter,
      });
      const observed = await source.observe({
        kind: "wordpress-org-target-observe",
        schemaVersion: 1,
        slug: "versioned-plugin",
      });
      if (observed.status !== "observed") {
        throw new Error("Expected a version observation");
      }
      const acquire = (requestedVersion: string) =>
        source.acquire({
          kind: "wordpress-org-target-acquire",
          schemaVersion: 1,
          observationRef: observed.observationRef,
          requestedVersion,
          policy: intakePolicy,
        });

      await expect(acquire("2.9.0")).resolves.toMatchObject({
        status: "ready",
        acquisitionOriginal: {
          version: "2.9.0",
          sourceUrl:
            "https://downloads.wordpress.org/plugin/versioned-plugin.2.9.0.zip",
        },
      });
      // The Main Plugin File still has to name the pinned version.
      await expect(acquire("2.8.0")).resolves.toMatchObject({
        status: "failed",
        reason: "metadata-archive-mismatch",
      });
      // A version that cannot be an archive name is refused before any download.
      await expect(acquire("2.9.0/../../x")).resolves.toEqual({
        status: "failed",
        operation: "acquire",
        reason: "requested-version-mismatch",
        pluginIdentity: "wporg:versioned-plugin",
      });
      expect(archiveUrls).toEqual([
        "https://downloads.wordpress.org/plugin/versioned-plugin.2.9.0.zip",
        "https://downloads.wordpress.org/plugin/versioned-plugin.2.8.0.zip",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns metadata-archive-mismatch when the Main Plugin File reports another version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wporg-target-mismatch-"));
    const pluginArchive = archive({
      "mismatch-plugin/plugin.php":
        "<?php\n/* Plugin Name: Mismatch\nVersion: 1.9.0\n*/\n",
    });
    try {
      const source = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter: fixtureAdapter("mismatch-plugin", "2.0.0", pluginArchive),
      });
      const observed = await source.observe({
        kind: "wordpress-org-target-observe",
        schemaVersion: 1,
        slug: "mismatch-plugin",
      });
      if (observed.status !== "observed") {
        throw new Error("Expected an observation");
      }
      await expect(
        source.acquire({
          kind: "wordpress-org-target-acquire",
          schemaVersion: 1,
          observationRef: observed.observationRef,
          requestedVersion: "2.0.0",
          policy: intakePolicy,
        }),
      ).resolves.toMatchObject({
        status: "failed",
        operation: "acquire",
        reason: "metadata-archive-mismatch",
        pluginIdentity: "wporg:mismatch-plugin",
        acquisitionOriginal: {
          contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { status: 404, reason: "not-found" },
    { status: 429, reason: "rate-limited" },
    { status: 503, reason: "network-failure" },
  ] as const)(
    "returns $reason when archive acquisition responds $status",
    async ({ status, reason }) => {
      const directory = await mkdtemp(join(tmpdir(), "wporg-archive-http-"));
      const base = fixtureAdapter(
        "archive-http-plugin",
        "1.0.0",
        new Uint8Array(),
      );
      const adapter: WordPressOrgSourceAdapter = {
        retrieve: async (request) =>
          request.kind === "metadata"
            ? base.retrieve(request)
            : { status, sourceUrl: request.sourceUrl, bytes: new Uint8Array() },
      };
      try {
        const source = openWordPressOrgTargetSource({
          storageDirectory: directory,
          adapter,
        });
        const observed = await source.observe({
          kind: "wordpress-org-target-observe",
          schemaVersion: 1,
          slug: "archive-http-plugin",
        });
        if (observed.status !== "observed") {
          throw new Error("Expected an observation");
        }
        await expect(
          source.acquire({
            kind: "wordpress-org-target-acquire",
            schemaVersion: 1,
            observationRef: observed.observationRef,
            requestedVersion: "1.0.0",
            policy: intakePolicy,
          }),
        ).resolves.toEqual({
          status: "failed",
          operation: "acquire",
          reason,
          pluginIdentity: "wporg:archive-http-plugin",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects an invalid archive without falling back to another source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wporg-invalid-archive-"));
    try {
      const source = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter: fixtureAdapter(
          "invalid-archive-plugin",
          "1.0.0",
          Buffer.from("not a zip archive"),
        ),
      });
      const observed = await source.observe({
        kind: "wordpress-org-target-observe",
        schemaVersion: 1,
        slug: "invalid-archive-plugin",
      });
      if (observed.status !== "observed") {
        throw new Error("Expected an observation");
      }
      await expect(
        source.acquire({
          kind: "wordpress-org-target-acquire",
          schemaVersion: 1,
          observationRef: observed.observationRef,
          requestedVersion: "1.0.0",
          policy: intakePolicy,
        }),
      ).resolves.toMatchObject({
        status: "rejected",
        reasons: ["archive-invalid"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "path traversal",
      entries: {
        "unsafe-plugin/plugin.php":
          "<?php\n/* Plugin Name: Unsafe\nVersion: 1.0.0\n*/\n",
        "unsafe-plugin/../escape.php": "<?php\n",
      },
      reasons: ["path-traversal"],
    },
    {
      name: "symbolic link",
      entries: {
        "unsafe-plugin/plugin.php":
          "<?php\n/* Plugin Name: Unsafe\nVersion: 1.0.0\n*/\n",
        "unsafe-plugin/link.php": { content: "plugin.php", unixMode: 0o120777 },
      },
      reasons: ["link-entry"],
    },
    {
      name: "multiple plugin roots",
      entries: {
        "unsafe-plugin/plugin.php":
          "<?php\n/* Plugin Name: Unsafe\nVersion: 1.0.0\n*/\n",
        "other-plugin/other.php": "<?php\n",
      },
      reasons: ["multiple-plugin-roots"],
    },
    {
      name: "file and child path collision",
      entries: {
        "unsafe-plugin/plugin.php":
          "<?php\n/* Plugin Name: Unsafe\nVersion: 1.0.0\n*/\n",
        "unsafe-plugin/includes": "not a directory",
        "unsafe-plugin/includes/feature.php": "<?php\n",
      },
      reasons: ["path-collision"],
    },
  ] as const)(
    "rejects $name before publishing Target Intake",
    async ({ entries, reasons }) => {
      const directory = await mkdtemp(join(tmpdir(), "wporg-target-unsafe-"));
      try {
        const source = openWordPressOrgTargetSource({
          storageDirectory: directory,
          adapter: fixtureAdapter("unsafe-plugin", "1.0.0", archive(entries)),
        });
        const observed = await source.observe({
          kind: "wordpress-org-target-observe",
          schemaVersion: 1,
          slug: "unsafe-plugin",
        });
        if (observed.status !== "observed") {
          throw new Error("Expected an observation");
        }
        await expect(
          source.acquire({
            kind: "wordpress-org-target-acquire",
            schemaVersion: 1,
            observationRef: observed.observationRef,
            requestedVersion: "1.0.0",
            policy: intakePolicy,
          }),
        ).resolves.toMatchObject({ status: "rejected", reasons });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("applies quota before expansion and defers an ambiguous Main Plugin File through Target Intake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wporg-target-policy-"));
    const pluginArchive = archive({
      "policy-plugin/first.php":
        "<?php\n/* Plugin Name: First\nVersion: 1.0.0\n*/\n",
      "policy-plugin/second.php":
        "<?php\n/* Plugin Name: Second\nVersion: 1.0.0\n*/\n",
    });
    try {
      const source = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter: fixtureAdapter("policy-plugin", "1.0.0", pluginArchive),
      });
      const observed = await source.observe({
        kind: "wordpress-org-target-observe",
        schemaVersion: 1,
        slug: "policy-plugin",
      });
      if (observed.status !== "observed") {
        throw new Error("Expected an observation");
      }
      const base = {
        kind: "wordpress-org-target-acquire" as const,
        schemaVersion: 1 as const,
        observationRef: observed.observationRef,
        requestedVersion: "1.0.0",
      };
      await expect(
        source.acquire({
          ...base,
          policy: {
            ...intakePolicy,
            id: "wporg-one-entry-v1",
            digest: digest("b"),
            limits: { ...intakePolicy.limits, maxEntries: 1 },
          },
        }),
      ).resolves.toMatchObject({
        status: "rejected",
        reasons: ["quota-exceeded"],
      });

      await expect(
        source.acquire({ ...base, policy: intakePolicy }),
      ).resolves.toMatchObject({
        status: "deferred",
        intake: {
          status: "deferred",
          reasons: ["main-plugin-file-ambiguous"],
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("chooses the root slug PHP file when an official archive has secondary headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wporg-target-main-"));
    const pluginArchive = archive({
      "policy-plugin/policy-plugin.php":
        "<?php\n/* Plugin Name: Policy Plugin\nVersion: 1.0.0\n*/\n",
      "policy-plugin/secondary.php":
        "<?php\n/* Plugin Name: Secondary\nVersion: 1.0.0\n*/\n",
    });
    try {
      const source = openWordPressOrgTargetSource({
        storageDirectory: directory,
        adapter: fixtureAdapter("policy-plugin", "1.0.0", pluginArchive),
      });
      const observed = await source.observe({
        kind: "wordpress-org-target-observe",
        schemaVersion: 1,
        slug: "policy-plugin",
      });
      if (observed.status !== "observed")
        throw new Error("Expected observation");
      await expect(
        source.acquire({
          kind: "wordpress-org-target-acquire",
          schemaVersion: 1,
          observationRef: observed.observationRef,
          requestedVersion: "1.0.0",
          policy: intakePolicy,
        }),
      ).resolves.toMatchObject({
        status: "ready",
        intake: { packet: { mainPluginFile: "policy-plugin.php" } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function fixtureAdapter(
  slug: string,
  version: string,
  pluginArchive: Uint8Array,
): WordPressOrgSourceAdapter {
  const downloadUrl = `https://downloads.wordpress.org/plugin/${slug}.${version}.zip`;
  return {
    retrieve: async (request) => ({
      status: 200,
      sourceUrl: request.sourceUrl,
      bytes:
        request.kind === "metadata"
          ? Buffer.from(
              JSON.stringify({
                slug,
                name: "Sanitized Fixture Plugin",
                version,
                active_installs: 1_000,
                last_updated: "2026-09-01T00:00:00Z",
                download_link: downloadUrl,
              }),
            )
          : pluginArchive,
    }),
  };
}
