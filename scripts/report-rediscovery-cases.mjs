import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

function countBy(items) {
  const counts = Object.create(null);
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Only aggregate routing metadata from the ledger; never copy artifact bodies. */
export function summarizeRediscoveryCase(campaignId, events) {
  const starts = new Map();
  const finishes = new Map();
  const findings = new Map();
  const fixedControls = new Map();
  const verifications = new Map();
  const verifierRuns = [];
  const verificationEvents = [];
  const opened = new Set();
  const candidateKeys = new Set();
  const heldKeys = new Set();
  const rejectedKeys = new Set();
  const labFailures = [];
  const preflightBlocks = [];
  let leads = 0;
  let reviewDecisions = 0;
  for (const event of events) {
    if (event.campaignId !== campaignId) throw new Error("campaign mismatch");
    switch (event.type) {
      case "lab-provisioned":
        if (event.status === "failed")
          labFailures.push(
            `${event.failureStage ?? "unknown"}:${event.reason ?? "unknown"}`,
          );
        break;
      case "evaluation-case-blocked":
        preflightBlocks.push({
          caseId: event.caseId,
          stage: event.stage,
          reason: event.reason,
        });
        break;
      case "discovery-run-started":
        starts.set(event.runId, event);
        break;
      case "discovery-run-finished":
        finishes.set(event.runId, event);
        break;
      case "candidate-normalized":
      case "candidate-held":
      case "candidate-rejected": {
        const key = `${event.runId}:${event.candidateKind}:${event.candidateIndex}`;
        candidateKeys.add(key);
        if (event.type === "candidate-held") heldKeys.add(key);
        if (event.type === "candidate-rejected") rejectedKeys.add(key);
        break;
      }
      case "finding-recorded":
        if (event.derivationKind === "fixed-version-control")
          fixedControls.set(event.findingId, event);
        else findings.set(event.findingId, event);
        break;
      case "lead-recorded":
        leads++;
        break;
      case "verifier-run-finished":
        verifierRuns.push(event);
        break;
      case "verification-finished":
        verificationEvents.push(event);
        verifications.set(event.findingId, event);
        break;
      case "review-item-opened":
        opened.add(event.findingId);
        break;
      case "review-decided":
        reviewDecisions++;
        break;
    }
  }
  const roots = [...starts.values()].filter(
    (event) => (event.runKind ?? "explore") === "explore",
  );
  const rootFinishes = roots
    .map((event) => finishes.get(event.runId))
    .filter((event) => event !== undefined);
  const agentFinishes = [...starts.keys()].map((runId) => finishes.get(runId));
  const observed = rootFinishes.map((event) => event.observed);
  const agentObserved = agentFinishes.map((event) => event?.observed);
  const observedFileReads =
    observed.length > 0 && observed.every((item) => item !== undefined)
      ? observed.reduce((sum, item) => sum + item.filesRead, 0)
      : null;
  const observedUniqueFileReadsByRun =
    observed.length > 0 && observed.every((item) => item !== undefined)
      ? observed.reduce((sum, item) => sum + item.uniqueFilesRead, 0)
      : null;
  const allAgentObservedFileReads =
    agentObserved.length > 0 &&
    agentObserved.every((item) => item !== undefined)
      ? agentObserved.reduce((sum, item) => sum + item.filesRead, 0)
      : null;
  const allAgentObservedUniqueFileReadsByRun =
    agentObserved.length > 0 &&
    agentObserved.every((item) => item !== undefined)
      ? agentObserved.reduce((sum, item) => sum + item.uniqueFilesRead, 0)
      : null;
  const statuses = [];
  const reasons = [];
  for (const findingId of findings.keys()) {
    const verification = verifications.get(findingId);
    if (verification === undefined) {
      statuses.push("unverified");
      continue;
    }
    statuses.push(verification.result.status);
    if (verification.result.status === "incomplete")
      reasons.push(verification.result.reason ?? "unknown");
  }
  return {
    campaignId,
    publicRecordMatch: "unassessed",
    discovery: {
      rootTrials: roots.length,
      completed: rootFinishes.filter((event) => event.outcome === "completed")
        .length,
      outcomes: countBy(rootFinishes.map((event) => event.outcome)),
      failures: countBy(
        rootFinishes
          .filter((event) => event.outcome !== "completed")
          .map((event) => event.reasonDetail ?? event.reason ?? event.outcome),
      ),
      historyModes: countBy(
        roots.map((event) => event.history?.mode ?? "unknown"),
      ),
      rootWallMedianMs: median(rootFinishes.map((event) => event.wallTimeMs)),
      observedFileReads,
      observedUniqueFileReadsByRun,
      allAgentObservedFileReads,
      allAgentObservedUniqueFileReadsByRun,
    },
    candidates: {
      reachedBoundary: candidateKeys.size,
      held: heldKeys.size,
      rejected: rejectedKeys.size,
      findings: findings.size,
      leads,
      zeroCandidateCoverage:
        findings.size + leads > 0
          ? null
          : allAgentObservedFileReads === null
            ? "unmeasured"
            : allAgentObservedFileReads === 0
              ? "no-file-read"
              : "read-no-candidate",
    },
    verification: {
      verifierAttempts: verifierRuns.filter((event) =>
        findings.has(event.findingId),
      ).length,
      attempts: verificationEvents.filter((event) =>
        findings.has(event.findingId),
      ).length,
      latestStatuses: countBy(statuses),
      latestIncompleteReasons: countBy(reasons),
    },
    fixedVersionControls: {
      findings: fixedControls.size,
      attempts: verificationEvents.filter((event) =>
        fixedControls.has(event.findingId),
      ).length,
      latestStatuses: countBy(
        [...fixedControls.keys()].map(
          (id) => verifications.get(id)?.result.status ?? "unverified",
        ),
      ),
    },
    humanOpenedFindings: [...opened].filter((id) => findings.has(id)).length,
    reviewDecisions,
    labFailures: countBy(labFailures),
    preflightBlocks,
  };
}

async function main(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !["--state", "--campaign"].includes(key) || values.has(key))
      throw new Error(
        "Usage: --state <absolute private state directory> --campaign <id>",
      );
    values.set(key, value);
  }
  const state = values.get("--state");
  const campaignId = values.get("--campaign");
  if (
    !state ||
    !isAbsolute(state) ||
    !campaignId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(campaignId)
  )
    throw new Error(
      "Usage: --state <absolute private state directory> --campaign <id>",
    );
  const directory = await lstat(state);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Unsafe state directory");
  const databasePath = join(state, "ledger.sqlite");
  const databaseFile = await lstat(databasePath);
  if (!databaseFile.isFile() || databaseFile.isSymbolicLink())
    throw new Error("Unsafe ledger database");
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
  });
  try {
    const rows = database
      .prepare(
        "SELECT event_json FROM ledger_events WHERE campaign_id = ? ORDER BY sequence",
      )
      .all(campaignId);
    if (rows.length === 0) throw new Error("Campaign has no ledger events");
    const events = rows.map((row) => JSON.parse(row.event_json));
    process.stdout.write(
      `${JSON.stringify(summarizeRediscoveryCase(campaignId, events), null, 2)}\n`,
    );
  } finally {
    database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
