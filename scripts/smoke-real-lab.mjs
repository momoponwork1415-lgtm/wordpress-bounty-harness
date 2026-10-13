#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const workspace = await realpath(
  resolve(fileURLToPath(new URL("../", import.meta.url))),
);
const usage =
  "usage: pnpm build && node scripts/smoke-real-lab.mjs --host <private-host.json> --state <private-state-dir> --config <campaign.json> --source-campaign <id> --binding-campaign <independent-positive-id> --finding <id> [--campaign <new-id>]";
const digest = /^sha256:[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const knownTarget = "wporg:translatepress-multilingual@3.3.1";
const targetSlug = "translatepress-multilingual";

class SmokeFailure extends Error {}

function required(value, name) {
  if (value === undefined || value.length === 0)
    throw new SmokeFailure(`missing --${name}; ${usage}`);
  return value;
}

function eventOf(ledger, query, type) {
  const event = ledger
    .read({ ...query, type, limit: 1000 })
    .map((row) => row.event)
    .find((candidate) => candidate.type === type);
  if (event === undefined)
    throw new SmokeFailure(`missing ${type} in the source campaign`);
  return event;
}

function inside(directory, parent) {
  return directory === parent || directory.startsWith(`${parent}${sep}`);
}

function verificationReason(ledger, campaignId, verificationId) {
  const record = ledger
    .read({ campaignId, type: "verification-finished", limit: 1000 })
    .map((row) => row.event)
    .find(
      (event) =>
        event.type === "verification-finished" &&
        event.verificationId === verificationId,
    );
  return record?.type === "verification-finished" &&
    record.result.status === "incomplete"
    ? record.result.reason
    : "unavailable";
}

async function capturedFailureDetail(
  ledger,
  store,
  campaignId,
  verificationId,
) {
  const event = ledger
    .read({ campaignId, type: "verification-finished", limit: 1000 })
    .map((row) => row.event)
    .find(
      (candidate) =>
        candidate.type === "verification-finished" &&
        candidate.verificationId === verificationId,
    );
  const evidenceDigest = event?.result?.evidenceDigest;
  if (!digest.test(evidenceDigest ?? "")) return "no captured route evidence";
  const record = await store.readFile(
    evidenceDigest,
    "route-observation.json",
    8192,
  );
  if (record.status !== "resolved") return `evidence ${evidenceDigest}`;
  try {
    const observation = JSON.parse(record.bytes.toString("utf8"));
    const count = observation.completedSteps;
    const reason = observation.replayReason;
    return Number.isInteger(count) &&
      count >= 0 &&
      count <= 8 &&
      (reason === null || /^[a-z-]{1,40}$/.test(reason))
      ? `replayed ${count}/8, ${reason ?? "route-mismatch"}, evidence ${evidenceDigest}`
      : `evidence ${evidenceDigest}`;
  } catch {
    return `evidence ${evidenceDigest}`;
  }
}

let stage = "arguments";
try {
  const { values } = parseArgs({
    options: {
      host: { type: "string" },
      state: { type: "string" },
      config: { type: "string" },
      "source-campaign": { type: "string" },
      "binding-campaign": { type: "string" },
      finding: { type: "string" },
      campaign: { type: "string" },
    },
    strict: true,
  });
  const hostPath = resolve(required(values.host, "host"));
  const stateDirectory = await realpath(
    resolve(required(values.state, "state")),
  );
  const configPath = resolve(required(values.config, "config"));
  const sourceCampaignId = required(
    values["source-campaign"],
    "source-campaign",
  );
  const findingId = required(values.finding, "finding");
  const bindingCampaignId = required(
    values["binding-campaign"],
    "binding-campaign",
  );
  const campaignId =
    values.campaign ??
    `smoke-real-lab-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  if (
    !id.test(sourceCampaignId) ||
    !id.test(bindingCampaignId) ||
    !id.test(campaignId) ||
    !digest.test(findingId) ||
    sourceCampaignId === campaignId ||
    bindingCampaignId === campaignId ||
    bindingCampaignId === sourceCampaignId
  )
    throw new SmokeFailure("invalid or reused campaign/Finding identity");
  if (
    inside(stateDirectory, workspace) ||
    inside(await realpath(hostPath), workspace)
  )
    throw new SmokeFailure(
      "host and Private Evidence must stay outside the Git worktree",
    );

  stage = "configuration";
  const { wordpressCampaignConfigSchema } =
    await import("../dist/cli/wordpress.js");
  const { wordPressSelectionPolicySchema } =
    await import("../dist/profiles/wordpress/selection/index.js");
  const config = wordpressCampaignConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  const policy = wordPressSelectionPolicySchema.parse(
    JSON.parse(
      await readFile(
        resolve(required(config.selectionPolicyPath, "selectionPolicyPath")),
        "utf8",
      ),
    ),
  );
  if (
    policy.pinnedVersions?.[targetSlug] !== "3.3.1" ||
    !policy.candidateSlugs.includes(targetSlug) ||
    config.lab.scenarioId !== "translatepress-translation-data-v1" ||
    config.lab.translatePress?.administratorSecondaryLocale !== "fr_FR"
  )
    throw new SmokeFailure(
      "the smoke config must pin TranslatePress 3.3.1 and its translation-data Lab scenario",
    );

  stage = "source-reference";
  const { PrivateArtifactStore } =
    await import("../dist/infrastructure/private-artifact-store.js");
  const { Ledger } = await import("../dist/ledger/index.js");
  const store = new PrivateArtifactStore({
    rootDirectory: join(stateDirectory, "private-evidence"),
    maxEntries: 64,
    maxBytes: 72 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(stateDirectory, "ledger.sqlite"),
    artifactStore: store,
  });
  if (ledger.read({ campaignId, limit: 1 }).length !== 0)
    throw new SmokeFailure(
      "the smoke campaign must be new; use another --campaign ID",
    );
  const finding = eventOf(
    ledger,
    { campaignId: sourceCampaignId, findingId },
    "finding-recorded",
  );
  if (
    finding.category !== "account-takeover" ||
    finding.historyRecordId !== undefined ||
    finding.derivedFromFindingId !== undefined
  )
    throw new SmokeFailure("the source Finding is not the original ATO case");
  const selection = ledger
    .read({
      campaignId: sourceCampaignId,
      type: "target-selected",
      limit: 1000,
    })
    .map((row) => row.event)
    .find(
      (event) =>
        event.type === "target-selected" &&
        event.snapshotDigest === finding.snapshotDigest,
    );
  const snapshot = ledger
    .read({
      campaignId: sourceCampaignId,
      type: "snapshot-frozen",
      limit: 1000,
    })
    .map((row) => row.event)
    .find(
      (event) =>
        event.type === "snapshot-frozen" &&
        event.snapshotDigest === finding.snapshotDigest,
    );
  if (
    selection?.selectionId !== knownTarget ||
    snapshot?.type !== "snapshot-frozen"
  )
    throw new SmokeFailure(
      "the source Finding is not bound to a frozen TranslatePress 3.3.1 snapshot",
    );
  const confirmed = ledger
    .read({
      campaignId: sourceCampaignId,
      findingId,
      type: "verification-finished",
      limit: 1000,
    })
    .map((row) => row.event)
    .filter(
      (event) =>
        event.type === "verification-finished" &&
        event.snapshotDigest === finding.snapshotDigest &&
        event.result.status === "runtime-confirmed",
    )
    .at(-1);
  if (confirmed?.type !== "verification-finished")
    throw new SmokeFailure("the source Finding has no Harness-confirmed route");
  const [routeFile, captureFile] = await Promise.all([
    store.readFile(
      confirmed.result.evidenceDigest,
      "confirmed-route.json",
      64 * 1024,
    ),
    store.readFile(
      confirmed.result.evidenceDigest,
      "proxy-capture.jsonl",
      64 * 1024 * 1024 + 1024,
    ),
  ]);
  if (routeFile.status !== "resolved" || captureFile.status !== "resolved")
    throw new SmokeFailure(
      "the confirmed route and Harness capture are required in Private Evidence",
    );
  const { matchesReferenceRoute } =
    await import("../dist/profiles/wordpress/verification/judges.js");
  let recordedRoute;
  let captured;
  try {
    recordedRoute = JSON.parse(routeFile.bytes.toString("utf8"));
    captured = captureFile.bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    throw new SmokeFailure("the source route or capture is unreadable");
  }
  if (
    captured.some(
      (entry) =>
        entry.request?.truncated !== false ||
        entry.response?.truncated !== false,
    ) ||
    !matchesReferenceRoute({ exchanges: captured }, recordedRoute)
  )
    throw new SmokeFailure(
      "the source confirmed route does not match its Harness capture",
    );

  stage = "typed-bindings";
  const comparison = ledger
    .read({
      campaignId: bindingCampaignId,
      findingId,
      type: "verification-finished",
      limit: 1000,
    })
    .map((row) => row.event)
    .filter(
      (event) =>
        event.type === "verification-finished" &&
        event.snapshotDigest === finding.snapshotDigest &&
        event.result.status === "runtime-confirmed",
    )
    .at(-1);
  if (
    comparison?.type !== "verification-finished" ||
    comparison.result.status !== "runtime-confirmed"
  )
    throw new SmokeFailure(
      "an independent positive Harness capture is required",
    );
  const [comparisonRouteFile, comparisonCaptureFile] = await Promise.all([
    store.readFile(
      comparison.result.evidenceDigest,
      "confirmed-route.json",
      64 * 1024,
    ),
    store.readFile(
      comparison.result.evidenceDigest,
      "proxy-capture.jsonl",
      64 * 1024 * 1024 + 1024,
    ),
  ]);
  if (
    comparisonRouteFile.status !== "resolved" ||
    comparisonCaptureFile.status !== "resolved"
  )
    throw new SmokeFailure(
      "the independent positive route and capture are unavailable",
    );
  let comparisonRoute;
  let comparisonCapture;
  try {
    comparisonRoute = JSON.parse(comparisonRouteFile.bytes.toString("utf8"));
    comparisonCapture = comparisonCaptureFile.bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    throw new SmokeFailure(
      "the independent positive route or capture is unreadable",
    );
  }
  if (!matchesReferenceRoute({ exchanges: comparisonCapture }, comparisonRoute))
    throw new SmokeFailure(
      "the independent positive route lacks exact Harness capture",
    );
  const { createSmokeReplayRecipe } =
    await import("../dist/profiles/wordpress/verification/smoke-replay-recipe.js");
  const { canonicalJson } =
    await import("../dist/infrastructure/canonical-json.js");
  let replayRecipe;
  try {
    replayRecipe = createSmokeReplayRecipe({
      sourceRoute: recordedRoute,
      sourceCapture: captured,
      comparisonRoute,
      comparisonCapture,
      findingSnapshotDigest: finding.snapshotDigest,
    });
  } catch {
    throw new SmokeFailure(
      "the two positive captures do not prove typed replay bindings",
    );
  }
  const smokeReplayDigest = await store.putFiles({
    "replay-recipe.json": canonicalJson(replayRecipe),
  });

  stage = "runtime-preflight";
  const { createWordPressHostProfile, loadWordPressHostConfig } =
    await import("../dist/cli/wordpress-host.js");
  const profile = await createWordPressHostProfile({
    host: await loadWordPressHostConfig(hostPath),
  });
  const state = {
    ledger,
    store,
    evidenceDirectory: join(stateDirectory, "private-evidence"),
    clock: () => new Date(),
    newId: randomUUID,
  };
  const runtime = await profile.checkRuntime(state, { configPath });
  if (runtime.some(({ profile, image }) => profile !== image))
    throw new SmokeFailure("runtime image differs from its pinned profile");

  stage = "campaign-seed";
  const occurredAt = new Date().toISOString();
  for (const source of [selection, snapshot, finding]) {
    const appended = await ledger.append({
      ...source,
      identity: `smoke-seed-${source.type}-${randomUUID()}`,
      campaignId,
      occurredAt,
    });
    if (appended.status !== "appended")
      throw new SmokeFailure(
        `could not append ${source.type} to the smoke campaign`,
      );
  }
  process.stdout.write(
    `smoke campaign ${campaignId}: seeded ATO Finding reference\n`,
  );

  stage = "positive-3.3.1";
  let positiveVerificationId;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const positive = await profile.reverify(state, {
      campaignId,
      findingId,
      configPath,
      referenceCampaignId: sourceCampaignId,
      snapshotCampaignId: sourceCampaignId,
      smokeReplayDigest,
    });
    process.stdout.write(
      `${positive.version} attempt ${attempt}: ${positive.status} (verification ${positive.verificationId})\n`,
    );
    if (
      positive.version !== "3.3.1" ||
      positive.snapshotDigest !== finding.snapshotDigest
    )
      throw new SmokeFailure("positive check used the wrong Snapshot");
    if (positive.status === "runtime-confirmed") {
      positiveVerificationId = positive.verificationId;
      break;
    }
    const reason = verificationReason(
      ledger,
      campaignId,
      positive.verificationId,
    );
    if (
      attempt === 3 ||
      positive.status !== "incomplete" ||
      (reason !== "recipe" && reason !== "observation")
    )
      throw new SmokeFailure(
        `positive check failed: ${positive.status}, reason ${reason}`,
      );
  }
  stage = "positive-route";
  const positiveRecord = ledger
    .read({
      campaignId,
      findingId,
      type: "verification-finished",
      limit: 1000,
    })
    .map((row) => row.event)
    .find(
      (event) =>
        event.type === "verification-finished" &&
        event.verificationId === positiveVerificationId &&
        event.result.status === "runtime-confirmed",
    );
  if (
    positiveRecord?.type !== "verification-finished" ||
    positiveRecord.result.status !== "runtime-confirmed"
  )
    throw new SmokeFailure("the positive judge evidence is unavailable");
  const positiveCaptureFile = await store.readFile(
    positiveRecord.result.evidenceDigest,
    "proxy-capture.jsonl",
    64 * 1024 * 1024 + 1024,
  );
  if (positiveCaptureFile.status !== "resolved")
    throw new SmokeFailure("the positive Harness capture is unavailable");
  let positiveCaptured;
  try {
    positiveCaptured = positiveCaptureFile.bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    throw new SmokeFailure("the positive Harness capture is unreadable");
  }
  let positiveRoute;
  try {
    const route = await store.readFile(
      positiveRecord.result.evidenceDigest,
      "confirmed-route.json",
      64 * 1024,
    );
    if (route.status !== "resolved") throw new Error("route missing");
    positiveRoute = JSON.parse(route.bytes.toString("utf8"));
  } catch {
    throw new SmokeFailure("the positive bound route is unavailable");
  }
  let positiveBindingProven = false;
  try {
    createSmokeReplayRecipe({
      sourceRoute: recordedRoute,
      sourceCapture: captured,
      comparisonRoute: positiveRoute,
      comparisonCapture: positiveCaptured,
      findingSnapshotDigest: finding.snapshotDigest,
    });
    positiveBindingProven = true;
  } catch {
    /* Fail closed below without printing private capture. */
  }
  if (
    positiveCaptured.some(
      (entry) =>
        entry.request?.truncated !== false ||
        entry.response?.truncated !== false,
    ) ||
    !matchesReferenceRoute({ exchanges: positiveCaptured }, positiveRoute) ||
    !positiveBindingProven
  )
    throw new SmokeFailure(
      "the positive judge confirmed ATO, but the known route was not replayed",
    );

  stage = "negative-3.3.2";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const negative = await profile.reverify(state, {
      campaignId,
      findingId,
      configPath,
      version: "3.3.2",
      referenceCampaignId: sourceCampaignId,
      snapshotCampaignId: sourceCampaignId,
      smokeReplayDigest,
    });
    process.stdout.write(
      `${negative.version} attempt ${attempt}: ${negative.status} (verification ${negative.verificationId})\n`,
    );
    if (negative.version !== "3.3.2")
      throw new SmokeFailure("fixed-version check used the wrong version");
    if (negative.status === "contradicted") break;
    const reason = verificationReason(
      ledger,
      campaignId,
      negative.verificationId,
    );
    if (
      attempt === 3 ||
      negative.status !== "incomplete" ||
      (reason !== "recipe" && reason !== "observation")
    )
      throw new SmokeFailure(
        `fixed-version check failed: ${negative.status}, reason ${reason}, ${await capturedFailureDetail(ledger, store, campaignId, negative.verificationId)}`,
      );
  }
  process.stdout.write(`smoke passed: campaign ${campaignId}\n`);
} catch (error) {
  const safeErrors = new Set([
    "The original pinned Snapshot is unavailable",
    "The pinned reference Snapshot is not recorded",
    "The pinned reference Snapshot is unavailable",
    "Pinned Snapshot artifact is unavailable",
  ]);
  const detail =
    error instanceof SmokeFailure
      ? error.message
      : error instanceof Error && safeErrors.has(error.message)
        ? error.message
        : error instanceof Error &&
            error.message.startsWith("Host preflight failed")
          ? "host preflight failed; inspect the local host configuration"
          : "unexpected error; inspect the separate smoke campaign and Private Evidence";
  process.stderr.write(`smoke failed at ${stage}: ${detail}\n`);
  process.exitCode = 1;
}
