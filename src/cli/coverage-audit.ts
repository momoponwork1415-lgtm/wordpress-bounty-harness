import { open, readFile, unlink } from "node:fs/promises";

import {
  privateExistingAuditPath,
  privateNewAuditPath,
} from "../infrastructure/private-audit-path.js";
import {
  auditLegacyCoveragePlan,
  parseLegacyCoverageAuditJson,
} from "../profiles/wordpress/discovery/legacy-coverage-audit.js";

type AuditIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

type CandidateWriter = {
  writeFile(value: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

export async function writePrivateAuditCandidate(
  outputPath: string,
  candidate: unknown,
  openOutput: () => Promise<CandidateWriter> = () =>
    open(outputPath, "wx", 0o600),
): Promise<void> {
  // The handle exists only after exclusive creation succeeds, so cleanup
  // cannot remove a pre-existing candidate.
  const output = await openOutput();
  let written = false;
  try {
    await output.writeFile(`${JSON.stringify(candidate, null, 2)}\n`);
    await output.sync();
    written = true;
  } finally {
    try {
      await output.close();
    } finally {
      if (!written) await unlink(outputPath);
    }
  }
}

/** A read-only audit; no Trial gate is constructed or changed. */
export async function runCoverageAuditCli(
  args: readonly string[],
  io: AuditIo,
): Promise<number> {
  if (
    args.length !== 4 ||
    args[0] !== "--file" ||
    args[1] === undefined ||
    args[2] !== "--out" ||
    args[3] === undefined
  ) {
    io.stderr(
      "Use trial coverage-audit --file <Git-outside plan.json> --out <Git-outside candidate.json>",
    );
    return 2;
  }
  try {
    const planPath = await privateExistingAuditPath(args[1]);
    const outputPath = await privateNewAuditPath(args[3]);
    if (planPath === outputPath)
      throw new Error("Audit output must differ from the input plan");
    const value = parseLegacyCoverageAuditJson(
      await readFile(planPath, "utf8"),
      "plan",
    );
    const result = await auditLegacyCoveragePlan(value);
    await writePrivateAuditCandidate(outputPath, result.candidate);
    io.stdout(JSON.stringify(result.publicSummary));
    return 0;
  } catch {
    // Parser and filesystem exceptions may contain private JSON fragments or
    // source paths. Keep CLI diagnostics independent of private input content.
    io.stderr("Coverage audit failed; inspect private inputs and output path");
    return 1;
  }
}
