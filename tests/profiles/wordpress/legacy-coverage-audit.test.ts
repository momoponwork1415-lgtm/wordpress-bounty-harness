import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  runCoverageAuditCli,
  writePrivateAuditCandidate,
} from "../../../src/cli/coverage-audit.js";
import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import {
  privateExistingAuditFile,
  privateNewAuditPath,
} from "../../../src/infrastructure/private-audit-path.js";
import {
  auditLegacyCoveragePlan,
  readStableAuditFile,
} from "../../../src/profiles/wordpress/discovery/legacy-coverage-audit.js";
import { repeatTrialCoverageManifestSchema } from "../../../src/profiles/wordpress/discovery/repeat-trial-gate.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const hash = (bytes: string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legacy-coverage-audit-"));
  roots.push(root);
  const source = join(root, "source.sqlite");
  const evidencePath = join(root, "evidence.json");
  const bytes = "synthetic source without private payload";
  await writeFile(source, bytes);
  const records = [
    { recordId: "one", classification: "confirmed-start", slug: "known" },
    { recordId: "two", classification: "possible-start", slug: "held" },
    { recordId: "three", classification: "not-start" },
  ];
  const writeEvidence = async (value: unknown = records) =>
    writeFile(
      evidencePath,
      JSON.stringify({
        schemaVersion: 1,
        sourceDigest: hash(bytes),
        records: value,
      }),
    );
  await writeEvidence();
  const plan = {
    schemaVersion: 1,
    stateInventoryDigest: hash("inventory"),
    sources: [
      { sourceClass: "archives", entries: [] },
      { sourceClass: "legacy-queues", entries: [] },
      {
        sourceClass: "state-ledgers",
        entries: [{ path: source, evidencePath }],
      },
      { sourceClass: "legacy-research-databases", entries: [] },
    ],
  };
  return { source, evidencePath, plan, writeEvidence };
}

it("produces deterministic private slug evidence and public-safe counts, never an importable manifest", async () => {
  const { plan } = await fixture();
  const first = await auditLegacyCoveragePlan(plan);
  const reversed = await auditLegacyCoveragePlan({
    ...plan,
    sources: [...plan.sources].reverse(),
  });
  expect(first).toEqual(reversed);
  expect(first.candidate.legacyStarts).toEqual([
    {
      slug: "known",
      minimumStartedTrials: 1,
      evidenceDigest: expect.stringMatching(/^sha256:/),
    },
  ]);
  expect(first.candidate.heldSlugs).toEqual([
    { slug: "held", evidenceDigest: expect.stringMatching(/^sha256:/) },
  ]);
  expect(first.publicSummary).toEqual({
    sourceFiles: 1,
    confirmedStartRecords: 1,
    possibleStartRecords: 1,
    notStartRecords: 1,
    knownStartedSlugs: 1,
    heldSlugs: 1,
    unknownSlugStarts: 0,
    importable: false,
  });
  expect(JSON.stringify(first.publicSummary)).not.toMatch(
    /"known"|"held"|source.sqlite/,
  );
  expect(first.candidate.sources.every((source) => !source.complete)).toBe(
    true,
  );
  expect(() =>
    repeatTrialCoverageManifestSchema.parse(first.candidate),
  ).toThrow();
  expect(first.candidate.auditDigest).toBe(
    canonicalDigest({
      stateInventoryDigest: first.candidate.stateInventoryDigest,
      sources: first.candidate.sources,
      legacyStarts: first.candidate.legacyStarts,
      heldSlugs: first.candidate.heldSlugs,
    }),
  );
});

it("holds unknown-slug records and never adds copied starts as independent Trials", async () => {
  const { plan, source, evidencePath, writeEvidence } = await fixture();
  await writeEvidence([
    { recordId: "one", classification: "confirmed-start", slug: "known" },
    { recordId: "two", classification: "confirmed-start", slug: "known" },
    { recordId: "three", classification: "possible-start" },
    { recordId: "four", classification: "confirmed-start" },
    { recordId: "five", classification: "possible-start", slug: "known" },
  ]);
  const result = await auditLegacyCoveragePlan(plan);
  expect(result.candidate.legacyStarts).toHaveLength(1);
  expect(result.candidate.legacyStarts[0]?.minimumStartedTrials).toBe(1);
  expect(result.candidate.heldSlugs).toEqual([]);
  expect(result.publicSummary.unknownSlugStarts).toBe(2);
  expect(
    result.candidate.sources.find((s) => s.sourceClass === "state-ledgers")
      ?.unknownSlugStarts,
  ).toBe(2);
  expect(JSON.stringify(result.candidate)).not.toContain(source);
  expect(JSON.stringify(result.candidate)).not.toContain(evidencePath);
});

it("fails closed on missing sources, changed content, malformed metadata, and unknown classifications", async () => {
  const { plan, source, evidencePath, writeEvidence } = await fixture();
  await expect(
    auditLegacyCoveragePlan({ ...plan, sources: plan.sources.slice(1) }),
  ).rejects.toThrow("exactly one roster");
  await expect(
    auditLegacyCoveragePlan({
      ...plan,
      sources: [plan.sources[0], plan.sources[0], ...plan.sources.slice(2)],
    }),
  ).rejects.toThrow("exactly one roster");
  await writeFile(source, "changed");
  await expect(auditLegacyCoveragePlan(plan)).rejects.toThrow(
    "different source content",
  );
  await rm(source);
  await expect(auditLegacyCoveragePlan(plan)).rejects.toThrow();
  await writeFile(source, "synthetic source without private payload");
  await writeEvidence([{ recordId: "bad", classification: "unknown" }]);
  await expect(auditLegacyCoveragePlan(plan)).rejects.toThrow();
  await writeEvidence([
    { recordId: "dup", classification: "not-start" },
    { recordId: "dup", classification: "not-start" },
  ]);
  await expect(auditLegacyCoveragePlan(plan)).rejects.toThrow(
    "repeats a record ID",
  );
  await rm(evidencePath);
  await expect(auditLegacyCoveragePlan(plan)).rejects.toThrow();
});

it("rejects hard-linked source and evidence aliases across the whole roster", async () => {
  const { plan, source, evidencePath } = await fixture();
  const root = dirname(source);
  const sourceAlias = join(root, "source-alias.sqlite");
  const evidenceCopy = join(root, "evidence-copy.json");
  await link(source, sourceAlias);
  await writeFile(
    evidenceCopy,
    JSON.stringify({
      schemaVersion: 1,
      sourceDigest: hash("synthetic source without private payload"),
      records: [],
    }),
  );
  const withSourceAlias = {
    ...plan,
    sources: plan.sources.map((group) =>
      group.sourceClass === "state-ledgers"
        ? {
            ...group,
            entries: [
              ...group.entries,
              { path: sourceAlias, evidencePath: evidenceCopy },
            ],
          }
        : group,
    ),
  };
  await expect(auditLegacyCoveragePlan(withSourceAlias)).rejects.toThrow(
    "repeats a file identity",
  );

  await rm(sourceAlias);
  const evidenceAlias = join(root, "evidence-alias.json");
  const secondSource = join(root, "second-source.sqlite");
  await link(evidencePath, evidenceAlias);
  await writeFile(secondSource, "synthetic source without private payload");
  const withEvidenceAlias = {
    ...plan,
    sources: plan.sources.map((group) =>
      group.sourceClass === "state-ledgers"
        ? {
            ...group,
            entries: [
              ...group.entries,
              { path: secondSource, evidencePath: evidenceAlias },
            ],
          }
        : group,
    ),
  };
  await expect(auditLegacyCoveragePlan(withEvidenceAlias)).rejects.toThrow(
    "repeats a file identity",
  );
});

it("keeps plan, source, evidence, and output outside Git and rejects symlink inputs", async () => {
  const { plan, source, evidencePath } = await fixture();
  const gitRoot = join(dirname(source), "checkout");
  await mkdir(join(gitRoot, ".git"), { recursive: true });
  const inside = join(gitRoot, "evidence.json");
  await writeFile(inside, "synthetic metadata");
  await expect(privateExistingAuditFile(inside)).rejects.toThrow("outside Git");
  await expect(
    privateNewAuditPath(join(gitRoot, "candidate.json")),
  ).rejects.toThrow("outside Git");
  const withInsideEvidence = {
    ...plan,
    sources: plan.sources.map((group) =>
      group.sourceClass === "state-ledgers"
        ? { ...group, entries: [{ path: source, evidencePath: inside }] }
        : group,
    ),
  };
  await expect(auditLegacyCoveragePlan(withInsideEvidence)).rejects.toThrow(
    "outside Git",
  );
  const withInsideSource = {
    ...plan,
    sources: plan.sources.map((group) =>
      group.sourceClass === "state-ledgers"
        ? { ...group, entries: [{ path: inside, evidencePath }] }
        : group,
    ),
  };
  await expect(auditLegacyCoveragePlan(withInsideSource)).rejects.toThrow(
    "outside Git",
  );
  const evidenceLink = join(dirname(source), "evidence-link.json");
  await symlink(evidencePath, evidenceLink);
  await expect(privateExistingAuditFile(evidenceLink)).rejects.toThrow(
    "regular file",
  );
});

it("rejects a valid plan substituted after path validation", async () => {
  const { plan, source } = await fixture();
  const root = dirname(source);
  const planPath = join(root, "plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  const inspected = await privateExistingAuditFile(planPath);
  await rename(planPath, join(root, "original-plan.json"));
  await writeFile(planPath, JSON.stringify({ ...plan, schemaVersion: 1 }));
  await expect(
    readStableAuditFile(inspected.path, inspected.identity),
  ).rejects.toThrow("changed after validation");
  await rm(planPath);
  await symlink(join(root, "original-plan.json"), planPath);
  await expect(
    readStableAuditFile(inspected.path, inspected.identity),
  ).rejects.toThrow();
});

it("keeps malformed plan and evidence fragments out of CLI stderr", async () => {
  const { plan, source, evidencePath } = await fixture();
  const root = dirname(source);
  const planPath = join(root, "plan.json");
  const outputPath = join(root, "candidate.json");
  const marker = "PRIVATE_SYNTHETIC_MARKER_58291";
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  };
  const run = () =>
    runCoverageAuditCli(["--file", planPath, "--out", outputPath], io);

  await writeFile(planPath, `{"secret":"${marker}"x`);
  expect(await run()).toBe(1);
  expect(stderr.join(" ")).not.toContain(marker);
  expect(stderr.join(" ")).not.toContain(planPath);
  expect(stdout).toEqual([]);

  stderr.length = 0;
  await writeFile(planPath, JSON.stringify({ ...plan, [marker]: true }));
  expect(await run()).toBe(1);
  expect(stderr.join(" ")).not.toContain(marker);

  stderr.length = 0;
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(evidencePath, `{"secret":"${marker}"x`);
  expect(await run()).toBe(1);
  expect(stderr.join(" ")).not.toContain(marker);
  expect(stderr.join(" ")).not.toContain(evidencePath);

  stderr.length = 0;
  await writeFile(
    evidencePath,
    JSON.stringify({
      schemaVersion: 1,
      sourceDigest: hash("synthetic source without private payload"),
      records: [
        { recordId: "one", classification: "confirmed-start", slug: marker },
      ],
    }),
  );
  expect(await run()).toBe(1);
  expect(stderr.join(" ")).not.toContain(marker);
  await expect(readFile(outputPath)).rejects.toThrow();
});

it("does not remove a pre-existing candidate when exclusive creation fails", async () => {
  const { plan, source } = await fixture();
  const root = dirname(source);
  const planPath = join(root, "plan.json");
  const outputPath = join(root, "candidate.json");
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(outputPath, "existing private result");
  const stderr: string[] = [];
  expect(
    await runCoverageAuditCli(["--file", planPath, "--out", outputPath], {
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(1);
  expect(await readFile(outputPath, "utf8")).toBe("existing private result");
  expect(stderr.join(" ")).not.toContain(outputPath);
});

it("removes only a newly opened partial candidate after write or sync failure", async () => {
  const { source } = await fixture();
  const root = dirname(source);
  for (const failedStep of ["write", "sync"] as const) {
    const outputPath = join(root, `${failedStep}-candidate.json`);
    await expect(
      writePrivateAuditCandidate(
        outputPath,
        { importable: false },
        async () => {
          const handle = await open(outputPath, "wx", 0o600);
          return {
            writeFile: async (value: string) => {
              await handle.writeFile(value);
              if (failedStep === "write")
                throw new Error("synthetic write failure");
            },
            sync: async () => {
              if (failedStep === "sync")
                throw new Error("synthetic sync failure");
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
      ),
    ).rejects.toThrow(`synthetic ${failedStep} failure`);
    await expect(readFile(outputPath)).rejects.toThrow();
    await writePrivateAuditCandidate(outputPath, { importable: false });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      importable: false,
    });
  }
});
