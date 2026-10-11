import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const scenarioIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/;
const maxFindingBytes = 1024 * 1024;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function realDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("unsafe directory");
}

async function regularFile(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum)
      throw new Error("unsafe file");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("file changed while reading");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function privateFinding(state, digest, findingId, snapshotDigest) {
  if (!digestPattern.test(digest)) throw new Error("invalid digest");
  const root = join(state, "private-evidence");
  const artifact = join(root, digest);
  const content = join(artifact, "content");
  await realDirectory(root);
  await realDirectory(artifact);
  await realDirectory(content);
  const names = await readdir(content);
  if (names.length !== 1 || names[0] !== "finding.json")
    throw new Error("unexpected finding artifact");
  const bytes = await regularFile(
    join(content, "finding.json"),
    maxFindingBytes,
  );
  const manifestBytes = await regularFile(
    join(artifact, "manifest.json"),
    8192,
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const measured = sha256(
    canonicalJson({
      kind: "canonical-file-manifest",
      schemaVersion: 1,
      entries: [
        {
          path: "finding.json",
          digest: sha256(bytes),
          size: bytes.length,
        },
      ],
    }),
  );
  if (
    manifest.kind !== "private-artifact-manifest" ||
    manifest.schemaVersion !== 1 ||
    manifest.artifact?.artifactId !== digest ||
    manifest.artifact?.digest !== digest ||
    manifest.artifact.entries !== 1 ||
    manifest.artifact.bytes !== bytes.length ||
    measured !== digest
  )
    throw new Error("finding artifact integrity mismatch");
  const finding = JSON.parse(bytes.toString("utf8"));
  if (
    finding.findingId !== findingId ||
    finding.snapshotDigest !== snapshotDigest ||
    typeof finding.configurationPrecondition !== "string"
  )
    throw new Error("finding does not match ledger");
  return finding.configurationPrecondition;
}

function nextStepKind(nextStep) {
  // The catalogue response does not identify which prerequisite is missing.
  // Its trailing text, if any, is not a trustworthy prerequisite category.
  if (nextStep.startsWith("catalogue に無い前提"))
    return "catalogue-missing-unspecified";
  const scenarioId = nextStep.split(":", 1)[0];
  if (
    scenarioIdPattern.test(scenarioId) &&
    (nextStep === scenarioId || nextStep.startsWith(`${scenarioId}: `))
  )
    return `scenario:${scenarioId}`;
  if (/翻訳|translation/i.test(nextStep)) return "legacy-translation-scenario";
  if (/コメント|comment/i.test(nextStep)) return "legacy-comment-scenario";
  return "other";
}

/** Categories overlap: a Finding may require both a page and a language. */
function prerequisiteKinds(precondition) {
  const text = precondition.toLowerCase();
  const kinds = [];
  if (/\bprivate[ -]post\b|非公開.{0,8}投稿/.test(text))
    kinds.push("private-post");
  if (/\bprivate[ -]page\b|非公開.{0,8}(?:page|ページ)/.test(text))
    kinds.push("private-page");
  if (
    kinds.length === 0 &&
    /\bprivate[ -]content\b|非公開.{0,8}コンテンツ/.test(text)
  )
    kinds.push("private-content-unspecified");
  if (/\bprotected[ -](post|page|content|frontend)\b/.test(text))
    kinds.push("protected-content-unspecified");
  if (/\b(published|public)[ -](post|page|content)\b/.test(text))
    kinds.push("published-content");
  if (/\bcomment(s)?\b|コメント/.test(text)) kinds.push("comment");
  if (
    /translat|dictionary|secondary language|二次言語|翻訳|辞書|\blocale\b/.test(
      text,
    )
  )
    kinds.push("language-or-translation");
  if (/\bnotification(s)?\b|通知/.test(text)) kinds.push("notification-state");
  if (/\bform(s)?\b|フォーム/.test(text)) kinds.push("form");
  if (/\bproduct(s)?\b|woocommerce|\bcart\b|\bcheckout\b|商品/.test(text))
    kinds.push("commerce");
  if (/\bfeed(s)?\b|gallery|social/.test(text)) kinds.push("feed-or-gallery");
  return kinds.length === 0 ? ["unclassified"] : kinds;
}

function rank(groups) {
  return [...groups.entries()]
    .map(([kind, item]) => ({
      kind,
      attempts: item.attempts,
      findings: item.findings.size,
    }))
    .sort(
      (left, right) =>
        right.findings - left.findings ||
        right.attempts - left.attempts ||
        left.kind.localeCompare(right.kind),
    );
}

function add(groups, kind, findingId) {
  const item = groups.get(kind) ?? { attempts: 0, findings: new Set() };
  item.attempts++;
  item.findings.add(findingId);
  groups.set(kind, item);
}

export async function reportWordPressPreconditions(state, campaign) {
  if (
    !isAbsolute(state) ||
    (campaign !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(campaign))
  )
    throw new Error("state must be absolute and campaign must be a ledger ID");
  const database = new DatabaseSync(join(state, "ledger.sqlite"), {
    readOnly: true,
  });
  try {
    const where = campaign === undefined ? "" : " AND campaign_id = ?";
    const params = campaign === undefined ? [] : [campaign];
    const findings = new Map();
    for (const row of database
      .prepare(
        `SELECT event_json FROM ledger_events WHERE event_type = 'finding-recorded'${where} ORDER BY sequence`,
      )
      .iterate(...params)) {
      const event = JSON.parse(row.event_json);
      findings.set(`${event.campaignId}\0${event.findingId}`, event);
    }
    const latest = new Map();
    const attempts = [];
    let verificationEvents = 0;
    for (const row of database
      .prepare(
        `SELECT event_json FROM ledger_events WHERE event_type = 'verification-finished'${where} ORDER BY sequence`,
      )
      .iterate(...params)) {
      verificationEvents++;
      const event = JSON.parse(row.event_json);
      const key = `${event.campaignId}\0${event.findingId}`;
      latest.set(key, event.result);
      if (
        event.result?.status === "incomplete" &&
        event.result.reason === "precondition"
      )
        attempts.push(event);
    }
    const openFindings = new Set(
      [...latest.entries()]
        .filter(
          ([, result]) =>
            result.status === "incomplete" && result.reason === "precondition",
        )
        .map(([key]) => key),
    );
    const nextSteps = new Map();
    const declaredPrerequisites = new Map();
    const preconditions = new Map();
    let unavailablePrivateFindings = 0;
    for (const event of attempts) {
      const key = `${event.campaignId}\0${event.findingId}`;
      const nextStep = String(event.result.nextStep ?? "");
      add(nextSteps, nextStepKind(nextStep), key);
      if (!openFindings.has(key)) continue;
      let kinds = preconditions.get(key);
      if (kinds === undefined) {
        const finding = findings.get(key);
        const digest = finding?.artifacts?.find(
          (artifact) => artifact.kind === "finding",
        )?.digest;
        try {
          if (digest === undefined)
            throw new Error("missing finding reference");
          const precondition = await privateFinding(
            state,
            digest,
            event.findingId,
            event.snapshotDigest,
          );
          kinds = prerequisiteKinds(precondition);
        } catch {
          kinds = ["private-evidence-unavailable"];
          unavailablePrivateFindings++;
        }
        preconditions.set(key, kinds);
      }
      for (const kind of kinds) add(declaredPrerequisites, kind, key);
    }
    return {
      campaign: campaign ?? "all",
      verificationEvents,
      preconditionAttempts: attempts.length,
      preconditionFindings: new Set(
        attempts.map((event) => `${event.campaignId}\0${event.findingId}`),
      ).size,
      openPreconditionFindings: openFindings.size,
      unavailablePrivateFindings,
      nextSteps: rank(nextSteps),
      openFindingDeclaredPrerequisites: rank(declaredPrerequisites),
      verifierObservedPreconditions: "not-inspected",
    };
  } finally {
    database.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (
    (args.length !== 2 && args.length !== 4) ||
    args[0] !== "--state" ||
    (args.length === 4 && args[2] !== "--campaign")
  )
    throw new Error(
      "Usage: node scripts/report-wordpress-preconditions.mjs --state <absolute private state directory> [--campaign <id>]",
    );
  console.log(
    JSON.stringify(
      await reportWordPressPreconditions(args[1], args[3]),
      null,
      2,
    ),
  );
}
