import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import { persistImmutableFile } from "../../../infrastructure/immutable-file.js";
import {
  SourceAcquisitionError,
  type AcquiredSource,
} from "../../../snapshot/index.js";
import {
  acquiredSourceFromIntakePacket,
  targetIntakeDirectory,
} from "./local-directory-target-intake.js";
import type { TargetIntakePacket, TargetIntakePolicy } from "./contracts.js";
import {
  wordPressOrgTargetObservationRefSchema,
  type WordPressOrgAcquisitionResult,
  type WordPressOrgTargetSource,
} from "./wordpress-org-contracts.js";

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const versionSchema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const MAX_PLUGIN_DEPENDENCIES = 16;

const pinsetBodySchema = z.strictObject({
  kind: z.literal("wordpress-plugin-dependency-pinset"),
  schemaVersion: z.literal(1),
  targetSlug: slugSchema,
  targetSourceDigest: digestSchema,
  explicitPins: z.record(slugSchema, versionSchema),
  explicitSlugs: z.array(slugSchema).max(MAX_PLUGIN_DEPENDENCIES),
  versionPolicy: z.enum(["stable-observed", "pinned-only"]),
  dependencies: z.array(
    z.strictObject({
      slug: slugSchema,
      version: versionSchema,
      sourceDigest: digestSchema,
      observationRef: wordPressOrgTargetObservationRefSchema,
      declaredBy: z.array(slugSchema),
      explicitlyPinned: z.boolean(),
    }),
  ),
});
const pinsetSchema = pinsetBodySchema.safeExtend({ digest: digestSchema });
type PinsetBody = z.infer<typeof pinsetBodySchema>;

/** Match WordPress get_file_data(): only the first 8 KiB of the main PHP file. */
export function requiredPluginSlugs(
  mainPluginBytes: Uint8Array,
): readonly string[] {
  const header = Buffer.from(mainPluginBytes)
    .subarray(0, 8 * 1024)
    .toString("utf8")
    .replace(/\r/g, "\n");
  const raw = /^(?:[ \t]*<\?(?:php)?)?[ \t\/*#@]*Requires Plugins:(.*)$/im
    .exec(header)?.[1]
    ?.replace(/\s*(?:\*\/|\?>).*$/, "")
    .trim();
  if (raw === undefined || raw === "") return [];
  const slugs = raw.split(",").map((value) => value.trim());
  if (
    slugs.length > MAX_PLUGIN_DEPENDENCIES ||
    slugs.some((slug) => !slugSchema.safeParse(slug).success)
  )
    throw new SourceAcquisitionError("deferred", {
      reason: "invalid-required-plugins-header",
    });
  return [...new Set(slugs)];
}

function acquisitionKind(
  result: Exclude<WordPressOrgAcquisitionResult, { status: "ready" }>,
) {
  if (result.status === "deferred") return "deferred" as const;
  if (result.status === "rejected") return "invalid-archive" as const;
  if ("diagnostic" in result && result.diagnostic?.kind !== undefined)
    return result.diagnostic.kind;
  if (result.reason === "quota-exceeded") return "quota-exceeded" as const;
  if (result.reason === "network-failure") return "network" as const;
  if (
    result.reason === "requested-version-mismatch" ||
    result.reason === "metadata-archive-mismatch"
  )
    return "source-mismatch" as const;
  return "http-response" as const;
}

/**
 * Freeze WordPress.org plugin dependencies before the Trial. The saved pinset
 * keeps repeat freezes on the same dependency versions and source digests.
 * Explicit pins cover plugins whose developers omit the WordPress header.
 */
export function openWordPressOrgPluginDependencySource(options: {
  readonly targetSource: WordPressOrgTargetSource;
  readonly storageDirectory: string;
  readonly policy: TargetIntakePolicy;
}): (
  packet: TargetIntakePacket,
  explicitPins: Readonly<Record<string, string>>,
  explicitSlugs: readonly string[],
  versionPolicy: "stable-observed" | "pinned-only",
  targetSource?: AcquiredSource,
) => Promise<readonly AcquiredSource[]> {
  const sourceFromPacket = (packet: TargetIntakePacket) =>
    acquiredSourceFromIntakePacket(
      packet,
      targetIntakeDirectory(options.storageDirectory),
    );
  const declaredBy = async (
    packet: TargetIntakePacket,
    capturedSource?: AcquiredSource,
  ) =>
    requiredPluginSlugs(
      await (capturedSource ?? sourceFromPacket(packet)).readFile(
        packet.mainPluginFile,
      ),
    );
  const acquire = async (
    slug: string,
    version: string,
    observationRef: z.infer<typeof wordPressOrgTargetObservationRefSchema>,
  ) => {
    const result = await options.targetSource.acquire({
      kind: "wordpress-org-target-acquire",
      schemaVersion: 1,
      observationRef,
      requestedVersion: version,
      policy: options.policy,
    });
    if (result.status !== "ready")
      throw new SourceAcquisitionError(acquisitionKind(result), {
        reason: "required-plugin-acquisition",
        slug,
        status: result.status,
        ...("reason" in result ? { detail: result.reason } : {}),
      });
    if (result.intake.packet.pluginIdentity !== `wporg:${slug}`)
      throw new SourceAcquisitionError("source-mismatch", {
        reason: "required-plugin-identity",
        slug,
      });
    return result.intake.packet;
  };

  return async (
    targetPacket,
    explicitPins,
    explicitSlugs,
    versionPolicy,
    targetSource,
  ) => {
    if (
      targetSource !== undefined &&
      (targetSource.identity !== targetPacket.pluginIdentity ||
        targetSource.version !== targetPacket.version ||
        canonicalDigest(targetSource.manifest) !==
          targetPacket.sourceTree.digest)
    )
      throw new SourceAcquisitionError("source-mismatch", {
        reason: "required-plugin-target-source-mismatch",
      });
    for (const [slug, version] of Object.entries(explicitPins)) {
      if (
        !slugSchema.safeParse(slug).success ||
        !versionSchema.safeParse(version).success
      )
        throw new SourceAcquisitionError("deferred", {
          reason: "invalid-required-plugin-pin",
        });
    }
    const targetSlug = slugSchema.parse(targetPacket.canonicalInstallDirectory);
    if (
      explicitSlugs.length > MAX_PLUGIN_DEPENDENCIES ||
      explicitSlugs.some((slug) => !slugSchema.safeParse(slug).success) ||
      (versionPolicy !== "stable-observed" && versionPolicy !== "pinned-only")
    )
      throw new SourceAcquisitionError("deferred", {
        reason: "invalid-required-plugin-resolution",
      });
    if (Object.hasOwn(explicitPins, targetSlug))
      throw new SourceAcquisitionError("deferred", {
        reason: "self-required-plugin-pin",
      });
    const targetSourceDigest = targetPacket.sourceTree.digest;
    const key = canonicalDigest({
      targetSlug,
      targetSourceDigest,
      explicitPins,
      explicitSlugs,
      versionPolicy,
    });
    const pinsetDirectory = join(
      options.storageDirectory,
      "plugin-dependency-pins",
    );
    const path = join(pinsetDirectory, `${key.slice(7)}.json`);
    let saved: z.infer<typeof pinsetSchema> | undefined;
    try {
      saved = pinsetSchema.parse(JSON.parse(await readFile(path, "utf8")));
      const { digest, ...body } = saved;
      if (
        digest !== canonicalDigest(body) ||
        body.targetSlug !== targetSlug ||
        body.targetSourceDigest !== targetSourceDigest ||
        canonicalJson(body.explicitPins) !== canonicalJson(explicitPins) ||
        canonicalJson(body.explicitSlugs) !== canonicalJson(explicitSlugs) ||
        body.versionPolicy !== versionPolicy
      )
        throw new SourceAcquisitionError("source-mismatch", {
          reason: "required-plugin-pinset-integrity",
        });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    if (saved !== undefined) {
      const sources: AcquiredSource[] = [];
      for (const entry of saved.dependencies) {
        const packet = await acquire(
          entry.slug,
          entry.version,
          entry.observationRef,
        );
        if (packet.sourceTree.digest !== entry.sourceDigest)
          throw new SourceAcquisitionError("source-mismatch", {
            reason: "required-plugin-tree-changed",
            slug: entry.slug,
          });
        sources.push(sourceFromPacket(packet));
      }
      return sources;
    }

    const roots = [
      ...(await declaredBy(targetPacket, targetSource)).map((slug) => ({
        slug,
        parent: targetSlug,
      })),
      ...Object.keys(explicitPins)
        .sort()
        .map((slug) => ({ slug, parent: null })),
      ...explicitSlugs.map((slug) => ({ slug, parent: null })),
    ];
    const active = new Set<string>();
    const visited = new Set<string>();
    const entries: PinsetBody["dependencies"][number][] = [];
    const sources: AcquiredSource[] = [];
    const declaredParents = new Map<string, Set<string>>();
    const visit = async (
      slug: string,
      parent: string | null,
    ): Promise<void> => {
      if (slug === targetSlug || active.has(slug))
        throw new SourceAcquisitionError("deferred", {
          reason: "required-plugin-cycle",
          slug,
        });
      const parents = declaredParents.get(slug) ?? new Set<string>();
      if (parent !== null) parents.add(parent);
      declaredParents.set(slug, parents);
      if (visited.has(slug)) return;
      if (visited.size + active.size >= MAX_PLUGIN_DEPENDENCIES)
        throw new SourceAcquisitionError("quota-exceeded", {
          reason: "too-many-required-plugins",
        });
      if (versionPolicy === "pinned-only" && explicitPins[slug] === undefined)
        throw new SourceAcquisitionError("deferred", {
          reason: "unpinned-required-plugin",
          slug,
        });
      active.add(slug);
      const observation = await options.targetSource.observe({
        kind: "wordpress-org-target-observe",
        schemaVersion: 1,
        slug,
      });
      if (observation.status !== "observed")
        throw new SourceAcquisitionError(
          observation.reason === "quota-exceeded"
            ? "quota-exceeded"
            : observation.reason === "network-failure"
              ? "network"
              : observation.reason === "rate-limited" ||
                  observation.reason === "not-found"
                ? "http-response"
                : "deferred",
          {
            reason: "required-plugin-observation",
            slug,
            detail: observation.reason,
          },
        );
      const version =
        explicitPins[slug] ?? observation.observation.stableVersion;
      const packet = await acquire(slug, version, observation.observationRef);
      for (const child of await declaredBy(packet)) await visit(child, slug);
      active.delete(slug);
      visited.add(slug);
      entries.push({
        slug,
        version,
        sourceDigest: packet.sourceTree.digest,
        observationRef: observation.observationRef,
        declaredBy: [],
        explicitlyPinned: Object.hasOwn(explicitPins, slug),
      });
      sources.push(sourceFromPacket(packet));
    };
    for (const { slug, parent } of roots) await visit(slug, parent);

    const body = pinsetBodySchema.parse({
      kind: "wordpress-plugin-dependency-pinset",
      schemaVersion: 1,
      targetSlug,
      targetSourceDigest,
      explicitPins,
      explicitSlugs,
      versionPolicy,
      dependencies: entries.map((entry) => ({
        ...entry,
        declaredBy: [...(declaredParents.get(entry.slug) ?? [])].sort(),
      })),
    });
    const pinset = pinsetSchema.parse({
      ...body,
      digest: canonicalDigest(body),
    });
    await mkdir(pinsetDirectory, { recursive: true, mode: 0o700 });
    if (
      (await persistImmutableFile(path, Buffer.from(canonicalJson(pinset)))) !==
      "stored"
    )
      throw new SourceAcquisitionError("source-mismatch", {
        reason: "required-plugin-pinset-conflict",
      });
    return sources;
  };
}
