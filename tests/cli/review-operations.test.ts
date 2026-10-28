import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { reviewExportV1Schema } from "../../src/review/index.js";
import {
  RECORDED_PROMPT_VARIANT,
  recordedReviewState,
} from "../support/recorded-review-state.js";

/** Admin commands on a recorded ledger; no selection, discovery or Lab runs (#495). */
describe("review operations on recorded history", () => {
  it("fails a command that reaches selection, discovery or a Lab", async () => {
    const { run, root, executions } = await recordedReviewState();
    const config = ["--config", join(root, "campaign.json")];
    await expect(
      run("campaign", "run", "--all", "--campaign", "campaign-1", ...config),
    ).rejects.toThrow("An admin command reached execution: runCampaign");
    await expect(
      run(
        "verify",
        "next",
        "--campaign",
        "campaign-1",
        ...config,
        "--handoff",
        join(root, "handoff"),
      ),
    ).rejects.toThrow("runCampaign, verifyNext");
    expect(executions).toEqual(["runCampaign", "verifyNext"]);
  });

  it("lists recorded Leads with position and summary and says when there are none", async () => {
    const { run, ledger, store } = await recordedReviewState();
    const empty = await run("review", "leads", "--campaign", "campaign-leads");
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("no leads recorded");
    const snapshot = `sha256:${"c".repeat(64)}`;
    const digest = await store.putFiles({
      "lead.json": Buffer.from(
        JSON.stringify({
          attackerPosition: "unauthenticated",
          summary:
            "Imported feed text reaches an administrator preview unescaped",
        }),
      ),
    });
    for (const ordinal of [1, 2]) {
      await ledger.append({
        schemaVersion: 1,
        identity: `lead-${ordinal}`,
        campaignId: "campaign-leads",
        snapshotDigest: snapshot,
        occurredAt: "2026-10-26T00:00:00Z",
        type: "lead-recorded",
        leadId: "lead-a",
        runId: `run-${ordinal}`,
        trialId: "trial-1",
        missingEdge: "consumer",
        primitive: "partial-execution",
        storageKind: "option",
        artifacts: [{ kind: "lead", digest }],
      });
    }
    const listed = await run("review", "leads", "--campaign", "campaign-leads");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(
      "lead  partial-execution/consumer  unauthenticated  lead-a  Imported feed text reaches an administrator preview unescaped",
    );
    // The same leadId recorded twice is listed once.
    expect(listed.stdout.split("lead-a").length).toBe(2);
    const none = await run("review", "leads");
    expect(none.code).not.toBe(0);
  });

  it("lists parked Findings by one-line property and says when there are none (#185)", async () => {
    const { run, ledger, store } = await recordedReviewState();
    const empty = await run(
      "review",
      "parked",
      "--campaign",
      "campaign-parked",
    );
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("no parked findings");
    const snapshot = `sha256:${"b".repeat(64)}`;
    const digest = await store.putFiles({
      "finding.json": Buffer.from(
        JSON.stringify({
          brokenProperty: "Throttle trusts a forwarded header",
        }),
      ),
    });
    await ledger.append({
      schemaVersion: 1,
      identity: "parked-1",
      campaignId: "campaign-parked",
      snapshotDigest: snapshot,
      occurredAt: "2026-10-13T00:00:00Z",
      type: "finding-parked",
      findingId: "finding-parked-1",
      runId: "run-1",
      category: "other",
      reason: "outside-programme-boundary",
      artifacts: [{ kind: "finding", digest }],
    });
    // #613: a park on the agent's declaration shows the declared values next to the reason.
    await ledger.append({
      schemaVersion: 1,
      identity: "parked-2",
      campaignId: "campaign-parked",
      snapshotDigest: snapshot,
      occurredAt: "2026-10-26T00:00:00Z",
      type: "finding-parked",
      findingId: "finding-parked-2",
      runId: "run-1",
      category: "stored-xss",
      reason: "declared-precondition",
      declaredPrecondition: {
        configurationClass: "default",
        attackerInputPath: "vendor-controlled-data",
        exploitTiming: "any-time",
      },
      artifacts: [{ kind: "finding", digest }],
    });
    const listed = await run(
      "review",
      "parked",
      "--campaign",
      "campaign-parked",
    );
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(
      "parked  other  finding-parked-1  Throttle trusts a forwarded header",
    );
    expect(listed.stdout).toContain("reason: outside-programme-boundary\n");
    expect(listed.stdout).toContain(
      "parked  stored-xss  finding-parked-2  Throttle trusts a forwarded header  reason: declared-precondition configurationClass=default attackerInputPath=vendor-controlled-data exploitTiming=any-time",
    );
    expect(
      ledger.read({
        campaignId: "campaign-parked",
        type: "finding-recorded",
      }),
    ).toHaveLength(0);
    const other = await run("review", "parked", "--campaign", "campaign-1");
    expect(other.stdout).toContain("no parked findings");
    const neither = await run("review", "parked");
    expect(neither.code).not.toBe(0);
    const badSince = await run("ledger", "stops", "--since", "yesterday");
    expect(badSince.code).not.toBe(0);
    const stops = await run("ledger", "stops", "--campaign", "campaign-parked");
    expect(stops.code).toBe(0);
    expect(stops.stdout).toContain("no stops recorded");
    const funnel = await run(
      "ledger",
      "funnel",
      "--since",
      "2026-10-12T00:00:00Z",
    );
    expect(funnel.code).toBe(0);
    expect(funnel.stdout).toContain("campaign *");
  });

  it("lists held Finding candidates with their issue paths and codes", async () => {
    const { run, ledger, store } = await recordedReviewState();
    const empty = await run("review", "held", "--campaign", "campaign-held");
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("no held findings");
    const candidate = await store.putFiles({
      "candidate.json": Buffer.from(JSON.stringify({ impact: "stored-xss" })),
    });
    const held = (
      candidateKind: "finding" | "lead",
      candidateIndex: number,
      extra: object,
    ) =>
      ledger.append({
        schemaVersion: 1,
        identity: `held-${candidateKind}-${candidateIndex}`,
        campaignId: "campaign-held",
        snapshotDigest: `sha256:${"b".repeat(64)}`,
        occurredAt: "2026-10-20T00:00:00Z",
        type: "candidate-held",
        runId: "run-1",
        candidateKind,
        candidateIndex,
        artifacts: [{ kind: "candidate", digest: candidate }],
        ...extra,
      } as never);
    // An event from before issue codes were recorded reads unchanged.
    await held("finding", 0, {
      issuePaths: ["configurationPrecondition"],
      impact: "stored-xss",
    });
    await held("finding", 1, {
      issuePaths: ["attackerPosition", "impact"],
      issueCodes: ["invalid_value", "invalid_value"],
      impact: "unclassified",
    });
    await held("lead", 0, { issuePaths: ["summary"] });
    const listed = await run("review", "held", "--campaign", "campaign-held");
    expect(listed.code).toBe(0);
    const lines = listed.stdout.split("\n").filter((line) => line !== "");
    expect(lines).toEqual([
      `held  stored-xss  ${candidate}  run-1#0  issues: configurationPrecondition  ${store.contentPath(candidate)}`,
      `held  unclassified  ${candidate}  run-1#1  issues: attackerPosition(invalid_value), impact(invalid_value)  ${store.contentPath(candidate)}`,
    ]);
    expect((await run("review", "held")).code).not.toBe(0);
  });

  it("lists recorded verification results, records a decision and counts the funnel", async () => {
    const { run, findings } = await recordedReviewState();
    const queue = await run("review", "--campaign", "campaign-1");
    expect(queue.code).toBe(0);
    expect(queue.stdout).toMatch(/^runtime-confirmed .* account-takeover$/m);
    expect(queue.stdout).toMatch(
      /reproduction package: sha256:[a-f0-9]{64} \(\S+private-evidence\/sha256:[a-f0-9]{64}\/content\)/,
    );
    expect(queue.stdout).toContain(
      "observed: attackerRole=subscriber defaultSettings=true observedVia=session reachedRole=administrator",
    );
    expect(queue.stdout).toMatch(/evidence: sha256:[a-f0-9]{64}/);
    expect(queue.stdout).toMatch(/^incomplete .* sqli$/m);
    expect(queue.stdout).toContain("reason: evidence");
    expect(queue.stdout).toMatch(/next: .+/);
    const confirmedFinding = /^runtime-confirmed\s+\S+\s+finding (\S+)/m.exec(
      queue.stdout,
    )?.[1];
    expect(confirmedFinding).toBe(findings.accountTakeover.findingId);
    const decided = await run(
      "review",
      "decide",
      "--campaign",
      "campaign-1",
      "--finding",
      confirmedFinding!,
      "--decision",
      "accept",
      "--reason",
      "reproduced-by-hand",
      "--duplicate",
      "no-match",
    );
    expect(decided.stderr).toBe("");
    expect(decided.stdout).toContain("recorded accept (reproduced-by-hand)");

    const funnel = await run("ledger", "funnel", "--campaign", "campaign-1");
    expect(funnel.stdout).toContain(
      "raw 2 → verifier通過 2 → confirmed 1 / reproduced 0 / contradicted 0 / incomplete 1 → reviewed 1 → in-scope 0 → submitted 0 → outcome 0",
    );
    expect(funnel.stdout).toContain("runs 1 (discovery attempts 1)");
    expect(funnel.stdout).toContain("cost unavailable");
    expect(funnel.stdout).toContain("confirmed / 1M tokens 1111.11");
    expect(funnel.stdout).toMatch(/account-takeover: .*raw 1 .* confirmed 1/);
  });

  it("records a reject before verification and lists it with its reason (#436)", async () => {
    const { run, findings } = await recordedReviewState({
      campaignId: "campaign-screen",
      verified: false,
    });
    const campaign = ["--campaign", "campaign-screen"];
    const rejected = findings.accountTakeover.findingId;
    const listed = await run("review", ...campaign);
    expect(listed.stdout).toMatch(
      new RegExp(
        `^not-verified\\s+campaign-screen\\s+finding ${rejected} `,
        "m",
      ),
    );
    // An unverified Finding has no package to reproduce.
    const reproduce = await run(
      "review",
      "decide",
      ...campaign,
      "--finding",
      rejected,
      "--decision",
      "accept",
      "--reason",
      "manual",
      "--reproduced",
      "match",
    );
    expect(reproduce.code).toBe(2);
    const decided = await run(
      "review",
      "decide",
      ...campaign,
      "--finding",
      rejected,
      "--decision",
      "reject",
      "--reason",
      "out-of-scope",
      "--minutes",
      "2",
    );
    expect(decided.stderr).toBe("");
    expect(decided.stdout).toContain(
      `recorded reject (out-of-scope) for finding ${rejected}`,
    );
    expect((await run("review", ...campaign)).stdout).toContain(
      "decision: reject (out-of-scope)",
    );
  });

  it("records scope, a draft, its authorization, the human submission and the outcome as ledger events", async () => {
    const { run, root, ledger, findings } = await recordedReviewState({
      scopeFacts: {
        // Synthetic facts standing in for judge evidence and target observations.
        load: async () => ({
          category: "account-takeover",
          attacker: "subscriber",
          activeInstalls: 5000,
          wordpressOrgListed: true,
          premium: false,
          latestVersionVerified: true,
          defaultOrCommonSettings: true,
          observations: ["admin-session-reached", "other-session-reached"],
        }),
      },
    });
    const campaign = ["--campaign", "campaign-1"];
    const finding = findings.accountTakeover.findingId;
    const target = [...campaign, "--finding", finding];

    const dedupe = await run("review", "dedupe", ...target);
    expect(dedupe.code).toBe(0);
    // No local Wordfence mirror is configured, so no duplicate verdict is inferred.
    expect(dedupe.stdout).toBe("duplicate: unavailable");

    const scoped = await run("review", "scope", ...target);
    expect(scoped.stderr).toBe("");
    expect(scoped.stdout).toMatch(/^wordfence in-scope /m);
    expect(scoped.stdout).toMatch(/^patchstack \S+ /m);

    const draftPath = join(root, "draft.md");
    await writeFile(draftPath, "Synthetic private draft text\n");
    const drafted = await run(
      "review",
      "draft",
      ...target,
      "--programme",
      "wordfence",
      "--file",
      draftPath,
    );
    expect(drafted.stderr).toBe("");
    expect(drafted.stdout).not.toContain("Synthetic private draft text");
    const [, provisionalCandidate, provisionalDraft] =
      /candidate (\S+)\s+draft (\S+)\s+revision 1/.exec(drafted.stdout)!;
    const provisional = [
      "--candidate",
      provisionalCandidate!,
      "--draft",
      provisionalDraft!,
      "--to",
      "wordfence",
    ];

    const early = await run("review", "submitted", ...provisional);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain("not authorized");
    const premature = await run(
      "review",
      "authorize",
      ...provisional,
      "--by",
      "operator",
    );
    expect(premature.code).toBe(1);
    expect(premature.stderr).toContain("human-reviewed-draft-required");
    const reproduced = await run(
      "review",
      "decide",
      ...target,
      "--decision",
      "defer",
      "--reason",
      "manual-reproduction",
      "--reproduced",
      "match",
      "--reproduce-minutes",
      "5",
      "--minutes",
      "3",
    );
    expect(reproduced.code).toBe(0);
    const finalDraft = await run(
      "review",
      "draft",
      ...target,
      "--programme",
      "wordfence",
      "--file",
      draftPath,
      "--prepared-by",
      "human",
    );
    expect(finalDraft.code).toBe(0);
    const [, candidate, draft] =
      /candidate (\S+)\s+draft (\S+)\s+revision 2/.exec(finalDraft.stdout)!;
    const exact = [
      "--candidate",
      candidate!,
      "--draft",
      draft!,
      "--to",
      "wordfence",
    ];
    const reviewed = await run(
      "review",
      "decide",
      ...target,
      "--decision",
      "accept",
      "--reason",
      "reproduced-by-hand",
      "--duplicate",
      "no-match",
      "--minutes",
      "3",
    );
    expect(reviewed.code).toBe(0);
    expect((await run("review", "authorize", ...exact)).code).toBe(2);
    expect(
      (await run("review", "authorize", ...exact, "--by", "operator")).code,
    ).toBe(0);
    expect((await run("review", "submitted", ...exact)).code).toBe(0);
    expect(
      (
        await run(
          "review",
          "outcome",
          "--candidate",
          candidate!,
          "--outcome",
          "triaged",
        )
      ).code,
    ).toBe(0);
    const resolved = await run(
      "review",
      "outcome",
      "--candidate",
      candidate!,
      "--outcome",
      "resolved",
      "--reward",
      "250",
    );
    expect(resolved.stderr).toBe("");
    expect(resolved.stdout).toBe("outcome resolved recorded (reward $250.00)");
    expect(
      (
        await run(
          "review",
          "outcome",
          "--candidate",
          candidate!,
          "--outcome",
          "resolved",
          "--reward",
          "-1",
        )
      ).code,
    ).toBe(2);

    const funnel = await run("ledger", "funnel", ...campaign);
    expect(funnel.stdout).toContain(
      "reviewed 1 → in-scope 1 → submitted 1 → outcome 1",
    );
    // Each candidate counts once, under its latest outcome.
    expect(funnel.stdout).toContain("outcomes: resolved 1  reward $250.00");
    expect(funnel.stdout).toContain("in-scope by programme: patchstack");
    expect(funnel.stdout).toMatch(/wordfence 1/);

    const previous = ledger
      .read({
        campaignId: "campaign-1",
        findingId: finding,
        type: "verification-finished",
      })
      .at(-1)?.event;
    if (previous?.type !== "verification-finished")
      throw new Error("missing verification");
    await ledger.append({
      ...previous,
      identity: "verification-after-report",
      verificationId: "verification-after-report",
      occurredAt: "2026-10-08T03:00:00Z",
    });
    const staleScope = await run(
      "review",
      "draft",
      ...target,
      "--programme",
      "wordfence",
      "--file",
      draftPath,
    );
    expect(staleScope.code).toBe(2);
    expect(staleScope.stderr).toContain("No in-scope assessment for wordfence");
    expect((await run("review", "scope", ...target)).code).toBe(0);
    expect(
      (
        await run(
          "review",
          "draft",
          ...target,
          "--programme",
          "wordfence",
          "--file",
          draftPath,
        )
      ).code,
    ).toBe(0);
  });

  it("records only the decision when review decide has no --reproduced", async () => {
    const { run, ledger, findings } = await recordedReviewState({
      askMinutes: async () => {
        throw new Error("AI decision prompted for human time");
      },
    });
    const campaign = ["--campaign", "campaign-1"];
    const finding = findings.accountTakeover.findingId;
    const decided = await run(
      "review",
      "decide",
      ...campaign,
      "--finding",
      finding,
      "--decision",
      "defer",
      "--reason",
      "needs-reading",
      "--minutes",
      "5",
    );
    expect(decided.stderr).toBe("");
    expect(decided.code).toBe(0);
    expect(decided.stdout).toMatch(
      new RegExp(`^recorded defer \\(needs-reading\\) for finding ${finding} `),
    );
    expect(decided.stdout).not.toContain("manual reproduction");
    const events = ledger
      .readAll({ campaignId: "campaign-1", findingId: finding })
      .map(({ event }) => event);
    expect(
      events.filter((event) => event.type === "human-reproduction-recorded"),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.type === "review-decided"),
    ).toHaveLength(1);
    expect(
      events.flatMap((event) =>
        event.type === "human-effort-recorded"
          ? [[event.action, event.minutes]]
          : [],
      ),
    ).toEqual([["read", 5]]);
    const ai = await run(
      "review",
      "decide",
      ...campaign,
      "--finding",
      finding,
      "--decision",
      "defer",
      "--reason",
      "ai-triage",
      "--by",
      "ai",
    );
    expect(ai.code).toBe(0);
    expect(
      (
        await run(
          "review",
          "decide",
          ...campaign,
          "--finding",
          finding,
          "--decision",
          "defer",
          "--reason",
          "ai-triage",
          "--by",
          "ai",
          "--minutes",
          "0",
        )
      ).code,
    ).toBe(2);
    const afterAi = ledger.readAll({
      campaignId: "campaign-1",
      findingId: finding,
    });
    expect(
      afterAi.filter(({ event }) => event.type === "human-effort-recorded"),
    ).toHaveLength(1);
    expect(
      afterAi.filter(({ event }) => event.type === "review-decided").at(-1)
        ?.event,
    ).not.toHaveProperty("humanElapsedSeconds");
  });

  it("records the human reproduction before the decision when review decide has --reproduced", async () => {
    const { run, ledger, findings } = await recordedReviewState();
    const campaign = ["--campaign", "campaign-1"];
    const finding = findings.accountTakeover.findingId;
    const decide = (...extra: string[]) =>
      run(
        "review",
        "decide",
        ...campaign,
        "--finding",
        finding,
        "--decision",
        "accept",
        "--reason",
        "reproduced-by-hand",
        ...extra,
      );
    const recorded = () =>
      ledger
        .readAll({ campaignId: "campaign-1", findingId: finding })
        .map(({ event }) => event)
        .filter(
          (event) =>
            event.type === "human-reproduction-recorded" ||
            event.type === "review-decided" ||
            event.type === "human-effort-recorded",
        );

    // A bad value or a stray minutes flag is a usage error that writes nothing.
    expect((await decide("--reproduced", "yes")).code).toBe(2);
    expect((await decide("--reproduce-minutes", "40")).code).toBe(2);
    expect(
      (await decide("--reproduced", "match", "--reproduce-minutes", "-1")).code,
    ).toBe(2);
    expect(recorded()).toHaveLength(0);

    const decided = await decide(
      "--reproduced",
      "match",
      "--reproduce-minutes",
      "40",
      "--minutes",
      "5",
    );
    expect(decided.stderr).toBe("");
    expect(decided.code).toBe(0);
    expect(decided.stdout.split("\n")[0]).toBe(
      `manual reproduction match recorded for finding ${finding}`,
    );
    expect(decided.stdout.split("\n")[1]).toMatch(
      /^recorded accept \(reproduced-by-hand\) /,
    );
    expect(
      recorded().map((event) =>
        event.type === "human-effort-recorded"
          ? `${event.type}:${event.action}:${event.minutes}`
          : event.type === "human-reproduction-recorded"
            ? `${event.type}:${event.result}`
            : event.type,
      ),
    ).toEqual([
      "human-reproduction-recorded:match",
      "human-effort-recorded:reproduce:40",
      "review-decided",
      "human-effort-recorded:read:5",
    ]);

    // The export reads the same event as before the fold.
    const exported = reviewExportV1Schema.parse(
      JSON.parse(
        (await run("review", "export", ...campaign, "--finding", finding))
          .stdout,
      ),
    );
    expect(exported.review.humanReproduction).toMatchObject({
      result: "match",
      minutes: 40,
    });
  });

  it("exports only the human result for the current verification attempt", async () => {
    const { run, ledger, findings } = await recordedReviewState();
    const campaign = ["--campaign", "campaign-1"];
    const finding = findings.accountTakeover.findingId;
    const decide = (result: "match" | "mismatch") =>
      run(
        "review",
        "decide",
        ...campaign,
        "--finding",
        finding,
        "--decision",
        result === "match" ? "defer" : "reject",
        "--reason",
        "manual-check",
        "--reproduced",
        result,
      );
    const exportedHuman = async () => {
      const output = await run(
        "review",
        "export",
        ...campaign,
        "--finding",
        finding,
      );
      expect(output.code).toBe(0);
      return reviewExportV1Schema.parse(JSON.parse(output.stdout)).review
        .humanReproduction;
    };

    expect((await decide("match")).code).toBe(0);
    expect(await exportedHuman()).toMatchObject({
      result: "match",
      minutes: null,
    });

    const previous = ledger
      .readAll({
        campaignId: "campaign-1",
        findingId: finding,
        type: "verification-finished",
      })
      .at(-1)?.event;
    if (previous?.type !== "verification-finished")
      throw new Error("Expected a verification fixture");
    expect(
      (
        await ledger.append({
          ...previous,
          identity: `second-${previous.verificationId}`,
          verificationId: `second-${previous.verificationId}`,
          attempt: 2,
        })
      ).status,
    ).toBe("appended");
    expect(await exportedHuman()).toBeNull();

    expect((await decide("match")).code).toBe(0);
    expect(await exportedHuman()).toMatchObject({ result: "match" });
    const matching = ledger
      .readAll({
        campaignId: "campaign-1",
        findingId: finding,
        type: "human-reproduction-recorded",
      })
      .at(-1)?.event;
    if (matching?.type !== "human-reproduction-recorded")
      throw new Error("Expected a human reproduction fixture");
    expect(
      (
        await ledger.append({
          ...matching,
          identity: "wrong-package",
          reproductionPackageDigest: `sha256:${"e".repeat(64)}`,
        })
      ).status,
    ).toBe("appended");
    expect(await exportedHuman()).toMatchObject({ result: "match" });
    expect(
      (
        await ledger.append({
          ...matching,
          identity: "wrong-snapshot",
          snapshotDigest: `sha256:${"f".repeat(64)}`,
        })
      ).status,
    ).toBe("appended");
    expect(await exportedHuman()).toMatchObject({ result: "match" });

    const old = ledger
      .readAll({
        campaignId: "campaign-1",
        findingId: finding,
        type: "human-reproduction-recorded",
      })
      .at(0)?.event;
    if (old?.type !== "human-reproduction-recorded")
      throw new Error("Expected the original manual result");
    expect(
      (await ledger.append({ ...old, identity: "late-old-attempt" })).status,
    ).toBe("appended");
    expect(await exportedHuman()).toMatchObject({ result: "match" });

    expect((await decide("mismatch")).code).toBe(0);
    expect(await exportedHuman()).toMatchObject({ result: "mismatch" });
    expect(
      ledger.readAll({
        campaignId: "campaign-1",
        findingId: finding,
        type: "human-reproduction-recorded",
      }),
    ).toHaveLength(6);
  });

  it("records the wbh-dedupe result with its note, lists it in the queue and keeps it through the reproduction (#442)", async () => {
    const { run, root, findings } = await recordedReviewState();
    const campaign = ["--campaign", "campaign-1"];
    const finding = findings.accountTakeover.findingId;
    const decide = (...extra: string[]) =>
      run(
        "review",
        "decide",
        ...campaign,
        "--finding",
        finding,
        "--decision",
        "accept",
        "--reason",
        "reproduced-by-hand",
        ...extra,
      );
    const note = join(root, "dedupe-note.md");
    await writeFile(note, "Public records only.\n");

    expect((await decide("--duplicate-note", note)).code).toBe(2);
    expect((await decide("--duplicate", "unavailable:")).code).toBe(2);
    const matched = await decide(
      "--duplicate",
      "possible-match:CVE-2026-0001",
      "--duplicate-note",
      note,
    );
    expect(matched.stderr).toBe("");
    expect((await decide("--reproduced", "match")).code).toBe(0);
    expect((await run("review", ...campaign)).stdout).toMatch(
      /^ {2}duplicate: possible-match {2}CVE-2026-0001 {2}checked \S+Z$/m,
    );
    const exported = reviewExportV1Schema.parse(
      JSON.parse(
        (await run("review", "export", ...campaign, "--finding", finding))
          .stdout,
      ),
    );
    // wbh-report v2 writes only on `no-match`; this one stays out.
    expect(exported.review.decision?.duplicate).toBe(
      "possible-match:CVE-2026-0001",
    );
    expect(exported.review.duplicate?.note?.path).toMatch(/dedupe-note\.md$/);

    expect((await decide("--duplicate", "unavailable:mirror-stale")).code).toBe(
      0,
    );
    expect((await run("review", ...campaign)).stdout).toMatch(
      /^ {2}duplicate: unavailable {2}mirror-stale {2}checked \S+Z$/m,
    );
  });

  it("assesses scope from the judge's evidence and the selection record without injected facts", async () => {
    const { run, findings } = await recordedReviewState();
    const scoped = await run(
      "review",
      "scope",
      "--campaign",
      "campaign-1",
      "--finding",
      findings.accountTakeover.findingId,
    );
    expect(scoped.stderr).toBe("");
    // Facts are read; only the unverified latest version keeps scope open.
    expect(scoped.stdout).toMatch(
      /^wordfence ambiguous \(version-or-configuration-unknown;/m,
    );
    expect(scoped.stdout).toMatch(
      /^patchstack ambiguous \(version-or-configuration-unknown;/m,
    );
  });

  it("refuses to record a decision for a finding outside the review queue", async () => {
    const { run, ledger } = await recordedReviewState();
    const before = ledger.readAll();
    const result = await run(
      "review",
      "decide",
      "--campaign",
      "campaign-1",
      "--finding",
      "absent",
      "--decision",
      "accept",
      "--reason",
      "manual",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not in the review queue");
    expect(ledger.readAll()).toEqual(before);
  });

  it("exports one-screen review material with Private Evidence paths, and the decision names its run (#186)", async () => {
    const { run, ledger, root, findings, runId } = await recordedReviewState();
    const confirmedFinding = findings.accountTakeover.findingId;
    const exported = await run(
      "review",
      "export",
      "--campaign",
      "campaign-1",
      "--finding",
      confirmedFinding,
    );
    expect(exported.stderr).toBe("");
    expect(exported.code).toBe(0);
    const bundle = reviewExportV1Schema.parse(JSON.parse(exported.stdout));
    expect(bundle.schema).toBe("review-export/v1");
    expect(bundle.finding).toMatchObject({
      claim: "Synthetic account-takeover claim",
      attackerPosition: "subscriber",
      impact: "account-takeover",
      brokenProperty: "Synthetic property",
      promptVariant: RECORDED_PROMPT_VARIANT,
      promptDigest: expect.stringMatching(/^sha256:/),
    });
    expect(bundle.target).toMatchObject({
      selectionId: "wporg:synthetic-plugin@3.3.1",
      activeInstallations: 5000,
      versions: {
        explored: "3.3.1",
        latestKnown: "3.3.1",
        sameAsExplored: true,
      },
    });
    expect(bundle.verification).toMatchObject({
      status: "runtime-confirmed",
      evidenceCapture: "agent-authored",
    });
    // The recorded http.json is not in the exchanges shape, so no rows are summarized.
    expect(bundle.http).toEqual({
      source: "unavailable",
      path: null,
      exchanges: [],
      truncated: false,
    });
    expect(bundle.labStateDiff).toMatchObject({
      status: "captured",
      summary: {
        settings: { changed: [{ key: "synthetic_plugin_shared" }] },
        principals: { added: [], removed: [], changed: [] },
      },
    });
    // Values stay in Private Evidence; the bundle carries names, digests and paths.
    expect(exported.stdout).not.toContain("untouched");
    expect(exported.stdout).not.toContain("written-");
    expect(exported.stdout).not.toContain("labObservations");
    const evidenceDirectory = join(root, "state", "private-evidence");
    expect(bundle.privateEvidence.directory).toBe(evidenceDirectory);
    expect(bundle.privateEvidence.artifacts.length).toBeGreaterThan(3);
    for (const artifact of bundle.privateEvidence.artifacts)
      expect(artifact.path).toBe(
        join(evidenceDirectory, artifact.digest, "content"),
      );
    if (bundle.labStateDiff.status !== "captured")
      throw new Error("unreachable");
    expect(
      JSON.parse(
        await readFile(
          join(bundle.labStateDiff.path, "lab-state-diff.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      schema: "wordpress-lab-state-diff/v1",
      summary: { optionsChanged: 1, usersChanged: 0 },
    });

    const decided = await run(
      "review",
      "decide",
      "--campaign",
      "campaign-1",
      "--finding",
      confirmedFinding,
      "--decision",
      "accept",
      "--reason",
      "reproduced-by-hand",
      "--minutes",
      "5",
    );
    expect(decided.stderr).toBe("");
    expect(decided.code).toBe(0);
    expect(
      ledger.read({
        campaignId: "campaign-1",
        findingId: confirmedFinding,
        type: "review-decided",
      })[0]?.event,
    ).toMatchObject({
      humanElapsedSeconds: 300,
      verificationId: findings.accountTakeover.verificationId,
      runId,
      promptDigest: bundle.finding.promptDigest,
    });
  });
});
