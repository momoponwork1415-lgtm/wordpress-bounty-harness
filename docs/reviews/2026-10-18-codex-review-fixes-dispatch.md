# Codex の dispatch 実装 9 本の review と修正依頼（2026-10-18）

Codex オーケストレーター（[依頼文](2026-10-18-codex-orchestration-dispatch.md)）が出した 3 列の成果を、Claude 側で独立 review した結果と、Codex に戻す修正の依頼文。正本ではない。

## 1. 成果と判定

| 列 | PR / branch | 追加行（累積） | pnpm check | 判定 |
|---|---|---|---|---|
| 1a task-plan | #324 | +132 | 通る | **merge**（2026-10-18 に Claude が merge） |
| 1b mode / ledger | codex/dispatch-1b-mode-ledger | +508 | 通る | **fix first**（§2.1） |
| 1c sandbox limits | codex/dispatch-1c-sandbox-limits | +584 | 通る | merge（1b の後） |
| 1d example / CLI | codex/dispatch-1d-example-cli | +714 | 765 件 | merge（1b の後） |
| 4a refutation transport | #325 | +374 | 通る | merge |
| 4a2 refutation service | codex/dispatch-4a2-refutation-flow | +804 | 通る | **fix first**（§2.2） |
| 4a3 refutation routing | codex/dispatch-4a3-refutation-routing | +1277 | 通る | **fix first**（§2.2） |
| 4b refute-v1 prompt | codex/dispatch-4b-refute-prompt | +1302 | 767 件 | merge（出典対照表 7 行以外は見出し 1 行のみ。所有者の 2026-10-18 の決定で AI が label を付ける） |
| 5 verification consumer | #326 | +499 | 761 件 | **fix first**（§2.3） |

不変条件の確認: 3 列とも判定器（judges.ts）、既定 prompt、campaign.json、台帳の既存 event の形に変更なし。refutation は `refutation-recorded` と `finding-parked` しか書かず、`runtime-confirmed` を出す経路が無いことを test で確認している（不変条件 3）。refutation の agent に渡るのは prompt、schema、claim の 7 field、読み取り専用 source だけで、Lab・PoC・履歴・公開記録は渡らない（不変条件 1）。

merge の順: 各列の先端は単独では main に衝突なく乗るが、列どうしは衝突する（1d と 4b: runtime / sandbox / ledger / cli の 7 file、1d と 5: 4 file、4b と 5: pipeline.ts）。1a → 1b → 1c → 1d を先に入れ、4 列と 5 列は Codex が main に追従してから入れる。

## 2. 修正依頼（Codex オーケストレーターに貼る）

```text
前回のタスク（docs/reviews/2026-10-18-codex-orchestration-dispatch.md）の成果を独立 review した。判定と修正点は docs/reviews/2026-10-18-codex-review-fixes-dispatch.md §1〜§2。以下を順に。前回と同じ規則（branch 名、worktree、500 行、5 項目の PR 本文、repo identity の commit、owner-approved path と prompt .md に触らない、merge しない、~/.local/state と prod checkout に触らない）。

A. 1b の修正（branch codex/dispatch-1b-mode-ledger 上で追加 commit。1c、1d は 1b の上に stacked なので、1b を直したら 1c → 1d を順に 1b に rebase する）:
  1. src/discovery/campaign.ts の task mode の worker loop（l.836 付近）が options.signal?.aborted を見ていない。operator stop のあと残りの課題を全部回し（各課題が失敗 → retry）、discovery-concluded を stoppedBy "incomplete" で書くので campaign が再開できない。worker loop で signal を見て止め、operator stop のときは stoppedBy "operator" にする。pipeline.ts の lab none の経路（l.447 付近、#297 由来）も signal を渡していないので直す。
  2. 同 file l.766 付近の全 mode 共通の else { failure = { reason: "evidence", reasonDetail: "execution-error" } } は task mode だけに限定するか、wp2shell でも意図した変更なら PR 本文に書く（協調 Trial の挙動変更は禁止なので前者）。
  3. test を足す: tests/ledger/ledger.test.ts に runKind "task" と taskId / taskKind / taskOrdinal / taskOf / retryOf、stoppedBy "incomplete" の round trip。tests/discovery/campaign-run.test.ts に「1 課題が 2 回失敗しても他の課題は続き、失敗は incomplete で台帳に残る」と「operator stop で残りの課題を回さない」。
  4. dispatch.concurrency と resources.maxConcurrentRuns の関係（dispatch は後者を無視する）を config schema の description と examples/campaign-dispatch.json の comment 相当の場所に書く。課題 0 件のときは throw する。

B. 4a2 / 4a3 の修正（branch 上で追加 commit、4b を rebase）:
  1. 4a2: src/profiles/wordpress/discovery/refute.ts の continue（l.81〜219 の 12 箇所）が失敗を黙って捨てている。Finding ごとの結果（recorded / pending / failed と理由）を戻り値に持たせ、refute run の CLI 出力に出す。sourceTrace に件数の上限を付け、16 KiB の sandbox 上限で throw しないようにする。
  2. 4a2: config.refutation.promptId を読まずに "refute-v1" を直書きしているので config から読む。refute() の config 読み込みは loadConfig() を使う。
  3. 4a3: runCampaignPipeline で refutation の transport 失敗が verdict 無しのまま Lab 検証に進む。verify next と同じく verdict が記録されるまで検証しない（fail pending）に揃える。
  4. 4a3: test を足す: campaign.json の refutation.enabled の既定が false で、false のとき wordpress.ts が refuteFinding を配線しない。refute run に --finding も --all-pending も無い / 両方ある → UsageError。pipeline 側の transport 失敗が検証に進まない。
  5. 4a3: verify next が parked を refutation の有無に関係なく全部飛ばすようになった変更（pipeline.ts l.1005 付近）は AGENTS.md と合うので残すが、brief の外なので PR 本文の「変えたこと」に書く。
  6. 4a: 任意。契約の節に V2（output-contract.ts）と同じ見出しを schema から生成して付ける。手で文を足さない。

C. 5 の修正（PR #326 に追加 commit）:
  1. src/verification/index.ts l.327 付近で書く lab-provisioned status failed の record に scenario が無い。consumer.ts の scenarioForVerification がその record を先に拾って null を返すので、config.lab.scenarioId がある構成では precondition の retry が毎回 true になり、Lab を無限に立て続ける。failed の record に scenario を書くか、scenarioForVerification が status failed を飛ばす。test: 「scenario を設定した構成で provision が失敗した Finding は 2 回目以降 pull されない」。
  2. attached mode の post-processing が consumer の inFlight を通らないので、継続 runner の verify worker が同じ Finding を同時に取れる（Lab が 2 つ、verification-finished が 2 行）。attached 側も createVerificationConsumer(...).pullNext({campaignId, snapshotDigest}) か reserve / release を通す。test を足す。
  3. continuous.ts の verifyWorker が探索 loop の provider 制限 hold と状態を共有していない。探索が hold 中は verify worker も止める。login 待ちは 10 分一括でなく 1 分刻みで stop を見る。
  4. ledger の funnel の lab-provisioned failed の group に purpose を足し、検証 Lab の失敗を探索 Lab の失敗と混ぜない。
  5. consumer.ts l.127 の duplicateOf は台帳に無い field なので消す（brief 2b で入るまで）。空 commit b8415c6 を落とす。

D. 1a が main に入り、A の 1b〜1d が merge されたら、4a → 4a2 → 4a3 → 4b と 5 を main に rebase して衝突を解く（runtime / sandbox / ledger / cli / pipeline）。1d と 5 の双方が触る pipeline.ts と cli は、dispatch mode と verify consumer の両方が残る形にする。rebase 後に pnpm check と pnpm build を通し、PR を 1b、1c、1d、4a2、4a3、4b の順に開く（既存 branch から。base は前の branch、前が main に入っていれば main）。

報告: 前回と同じ 1 行形式。A → C → B → D の順で、各列 1 sub-session。
```

## 3. Claude 側の分担

- #324 の merge（済）。1b 〜 1d、#325、4a2 〜 4b、#326 は修正の commit が来てから再 review し、merge する。
- 4b は agent に渡る文章なので、merge 時に AI が delegation comment を残して owner-approved を付ける（ADR 0032 2026-10-18 節）。
- dispatch の開発セット gate（計画の Phase 1 gate）は provider が戻ってから `measure-driver.sh` で回し、`docs/evaluation/` に記録する。
