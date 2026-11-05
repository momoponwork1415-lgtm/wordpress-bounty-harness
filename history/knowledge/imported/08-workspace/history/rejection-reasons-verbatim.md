<!-- provenance: /home/dev/wp-bounty-workspace/history/rejection-reasons-verbatim.md, mtime 2026-08-13, imported 2026-10-13, generation 08-workspace. 取り込み時に plugin 名・版・record id・Wordfence が引用した source 行番号を除いた。Wordfence の却下文言（日本語）は規則の根拠なのでそのまま残す -->

# Wordfence rejection reasons — verbatim (supplied by the researcher 2026-08-13)

Ground truth for the Feb–Aug 2026 rejections. These are Wordfence triage's own words.
Plugin attribution was partial in the original and is removed here.
[件別の表は Git 外: /home/dev/wp-bounty-workspace/history/rejection-reasons-verbatim.md の該当節]

---

## R1 — "logic bug, not a vulnerability, out of scope"
> これは脆弱性というよりは論理バグであり、当社の対象範囲外であるため、CVE IDを割り当てることはできません。

Appears **twice**. The second occurrence carries the false-positive warning.

**Rule:** Wordfence maintains an explicit *logic bug* category that is out of scope regardless of
whether the behaviour is unintended. Unintended ≠ vulnerability.

---

## R2 — "the nonce is not leaked, therefore not exploitable"
> nonceが漏洩していないため悪用できず、したがって脆弱性とはみなされません。

**This is the single most instructive rejection in the set.** A paid SQLi report on the *same plugin,
submitted the same day* depended on the same static public nonce — and was paid. The difference:

- Paid report: the nonce was a **step** in a chain whose terminal effect was full DB read. The
  nonce's public exposure was *demonstrated in passing* while proving the real impact.
- Rejected report: the nonce exposure was submitted as **the finding itself**. Wordfence assessed
  it standalone, found no demonstrated disclosure path, and ruled it unexploitable.

**Rule:** never submit an access primitive as a finding. A nonce/token/permission gap is only
worth reporting attached to the terminal effect it unlocks.

---

## R3 — "code quality, not security — no attacker control"
> これはセキュリティ上の脆弱性ではなく、コード品質の問題です。加入者が実行できるあらゆる操作において、
> 攻撃者が制御を制御できる余地は一切ありません。影響は、WordPressのcronジョブを予定時刻より早く実行した
> 場合とほぼ同じです。開発者に連絡を取り、この問題を通知して、適切に対処してもらうことをお勧めします。

**Rule:** reachability by a low-privilege role is not impact. If the attacker cannot **control**
any data that flows through the action, it is a code-quality issue. Wordfence's own yardstick here
is memorable: *"about the same as running a WordPress cron job earlier than scheduled."*

**Test to apply before submitting:** name the exact attacker-controlled value, and name what
changes in the database, filesystem, or another user's session as a result. If the answer is
"the action ran", there is no finding.

---

## R4 — "the endpoint is intentionally public, and the control you claim is missing exists"
> （該当 endpoint）は意図的に公開されています。利用可能な数量は（source の該当行）で確認されます。
> また、確保分は一定時間後に自動的に解放されます（source の該当行）。
> ただし、たとえそうでなくても、利用可能な数量よりも多くを割り当てることは、
> セキュリティ脆弱性というよりは、ビジネスロジックのバグのように見えます。引き続き調査してください。

**This is the most damaging category: the premise was factually wrong.** Wordfence cited the exact
source lines proving the control the report claimed was absent. Two independent kill shots
(a quantity check and an auto-release), plus a fallback ruling that even without them it
would be business logic.

**Rule:** a "missing check" claim must be proven absent along *every* path, not merely absent at
the entry point. The discovery stage has to search for the control that would refute the lead —
this is what the harness's falsification-first verification is for, applied at source level.

---

## R5 — "the returned information is not sensitive"
> これは有効な脆弱性ではなく、返された情報は機密情報ではありません。

**Rule:** information disclosure requires the disclosed data to be sensitive *on its own terms*.
Wordfence judges the data, not the access-control gap that exposed it.

---

## R6 — "real issue, impact below the CVE bar" (no penalty)
> この報告内容を検討し、実際の影響を評価した結果、CVE を割り当てるほどの影響ではないと判断しました。
> ただし、確かに問題のある脆弱性であるため、ベンダーに直接報告し、適切な承認を得てエンドポイントの
> セキュリティ強化を図ることをお勧めします。**この却下は、研究者の割り当てにおいて不利になることはありません。**

**Rule:** an explicit "below the CVE bar" tier exists. Acknowledged as a genuine vulnerability,
still worth nothing, and explicitly **does not count against the researcher**.

---

## R7 — "conditional impact requiring an unlikely configuration"
> 影響は非常に小さく、CVE を割り当てるには不十分だと考えています。むしろ、ベンダーに報告してセキュリティ
> 強化を依頼するべき問題です。基本的に、影響は条件付きです。複数の役割が利用可能なメンバーシップが存在する
> 必要があります。管理者をダウングレードするには、管理者がメンバーである必要があります。**プラグインの
> マーケティング方法から判断すると、これは考えにくいです。** ... **これは確かに IDOR ですが、結果として生じる影響は迷惑なもの
> に過ぎません。** ... 今回の却下は、研究者ティアの割り当てにおいて不利になることはありません。

**Rule — the most important one for target selection:** Wordfence evaluates the impact under the
plugin's *realistic deployment*, and reasons explicitly from **how the plugin is marketed** to
decide whether the required configuration is plausible. A finding whose maximum impact depends on
a configuration most sites will not have is scored at that realistic impact, not the best case.

Note the concession pattern: *"it is indeed an IDOR, but the resulting impact is merely a
nuisance."* Class correctness earns nothing on its own.

---

## R8 — "already fixed in a later version"
> この問題は、バージョン（後続版）でオブジェクトレベルの認証チェックによって修正されています。

**Rule:** patch lag. The report targeted a version that was no longer current. Purely avoidable —
always re-derive against the latest stable release immediately before submitting.

---

## R9 — "one-time-use script; residual presence is user misuse" (explicitly NOT an FP)
> しかしながら、（installer script）はバックアップの移行とインストールを行うためのワンタイム
> スクリプトであるため、これは有効な脆弱性ではありません。（その file）は削除されることが
> 想定されており、サイト所有者が手動で削除する必要があります。**これは誤検出としてカウントされません。**

Applied to all three reports on one backup/migration plugin (reflected XSS, arbitrary file deletion, RCE).

**Rule:** a precondition that depends on the site owner failing to clean up is treated as user
misuse, not a plugin vulnerability — no matter how complete the technical chain. Verified RCE in
a lab still scores zero. Explicitly **not counted as a false positive**.

---

## R10 — The false-positive warning (appears twice)
> **誤検出報告が多すぎると、一時的に脆弱性報告の資格が停止されたり、すべての脆弱性報告の報奨金対象から
> 除外されたりする可能性があることにご注意ください。** ただし、これが正当な低影響の問題である場合、
> または既に修正されている場合は、不利になることはありません。

**This is a program-level risk, not a per-report cost.** Too many false positives can lead to
temporary suspension from reporting, or exclusion from bounty eligibility across *all* reports.

**Carve-outs that do NOT count against the researcher:**
- legitimate low-impact issues (R6, R7)
- already-patched issues (R8)
- the one-time-installer ruling (R9), stated explicitly

**How to read this warning — corrected 2026-08-13 after the researcher pushed back.**

The opening sentence of the rejection template — 「これは誤検出、既に修正済み、または影響度の低い
問題であり」 — is a **canned three-way phrase**. Which of the three actually applied is decided by
the specific reasoning that follows, and the FP warning paragraph is boilerplate attached to the
template rather than an accusation against a particular report.

Reading the bodies, these rejections were overwhelmingly **scope and impact rulings, not
false-positive findings**. Wordfence repeatedly affirms the bug is real while placing it outside
the program:

- R3 — "code quality issue" **and recommends contacting the developer** → real bug, out of scope
- R1 — "a logic bug, outside our scope" → real bug, out of scope
- R4 — closes with **"please keep investigating"**
- R6 — "it is indeed a problematic vulnerability" + explicitly no penalty
- R7 — "it is indeed an IDOR" + explicitly no penalty
- R8, R9 — already-patched and the installer ruling, both explicitly not counted

Only **R2** (disagreement over whether the nonce is actually exposed) and **R4** (the controls the
report treated as absent) involve a genuine premise error, and both were phrased mildly. The
account-level false-positive risk is therefore **low** — considerably lower than a first reading
of the boilerplate suggests.

The economic finding is unaffected and is the one that matters: whether or not these count as
false positives, the 23 arguable-impact submissions returned $8.

---

# Taxonomy

| # | Category | Wordfence's test | Counts as FP? |
|---|---|---|---|
| A | Logic / business-logic bug | Unintended behaviour with no security boundary crossed | **no** — real bug, out of scope |
| B | Code quality, no attacker control | Can the attacker control any value that flows through? | **no** — dev-report recommended |
| C | Premise contested | The control you claimed missing exists — here are the lines | **possibly**, phrased mildly |
| D | Data not sensitive | Judge the disclosed data on its own terms | impact ruling, not FP |
| E | Below the CVE impact bar | Real vuln, impact too small | **no** (stated) |
| F | Conditional / unrealistic configuration | Is this config plausible given how the plugin is marketed? | **no** (stated) |
| G | Already patched | Is it still present in the latest release? | **no** (stated) |
| H | Precondition is user misuse | Does the premise require the owner to fail at cleanup? | **no** (stated) |

The cost of these rejections is therefore **spent effort and forgone revenue**, not account
standing. That reframes the countermeasure: the goal is not to avoid rejection for safety's sake,
it is to stop spending discovery and verification budget on a bucket that pays $8 per 23 reports.

## Where this maps onto the outcome data

The 23 "arguable impact" submissions (Missing Authorization, IDOR, Info Disclosure, Privilege
Escalation, SSTI, DoS) produced $8 and 17 of the 20 rejected-or-unpaid outcomes. Every category
above except G and H is a way of losing inside that bucket.

The 21 "self-evident impact" submissions excluding the three installer-script reports produced
**zero** rejections and **zero** unpaid outcomes — because none of A–F can be argued against a
demonstrated database read, script execution in another user's session, arbitrary file read, or
money changing hands.

## Pre-submission screen implied by these rulings

1. Name the attacker-controlled value. If none → R3.
2. Name the terminal effect on data, filesystem, or another principal's session. If the answer is
   "the action executed" → R3. If it is "information was returned", ask whether that data is
   sensitive standing alone → R5.
3. Prove the missing control is missing on **every** path. Search the source for the check that
   would refute it, the way Wordfence did → R4.
4. If the finding is an access primitive (nonce, token, capability gap), attach it to the terminal
   effect it unlocks, or do not submit it → R2.
5. State the required configuration, then ask whether a typical install has it — judged by how the
   plugin is marketed → R7.
6. Ask whether the premise depends on the site owner failing to clean up → R9.
7. Re-derive against the current latest stable release right before submitting → R8.
8. If the honest answer to "so what?" is "it is a nuisance" or "unintended but no boundary is
   crossed" → do not submit. That is R1/R7, and R1 likely counts as a false positive.
