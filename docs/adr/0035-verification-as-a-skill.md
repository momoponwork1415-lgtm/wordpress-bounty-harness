---
status: accepted
date: 2026-10-18
supersedes: 0026 for the administrator boundary of a Verifier run
---

# 検証を skill にし、Harness は Lab 供給・canary・判定器だけを持つ

## 決定

検証の中身（前提の作り方、再現の手順、recipe の修正、反証）は skill `wbh-verify` が持つ。Harness は `WordPressVerifierTransport` の第 2 実装 handoff Verifier を持ち、`verify next --campaign <id> --config <path> --handoff <dir>` で選ぶ。handoff Verifier は Lab を供給して `<dir>/lab.json`（接続先、攻撃者位置の資格、Lab の設定管理者の資格、canary の節、Finding の review export の path）を書き、`<dir>/setup-done` を待ち、置かれてから HTTP 捕捉と Lab 状態の基線を取り始め、`route.json` `http.json` `session.json` `steps.md` `refutation.md` `precondition` の 6 file か `<dir>/abort` を待つ。6 file は Codex Verifier と同じ recipe として保存し判定器に渡す。`abort` と wall 超過は理由付き `incomplete(recipe)`。判定器、`verification-finished`、`finding-parked` の event 形は変えない。Codex Verifier の経路は変えない。

**管理者の使用範囲。** ADR 0026 の「Verifier にブラウザや管理者セッションを渡さない」を次に改訂する。handoff の skill には前提作り（通常機能の設定）のためだけに Lab の設定管理者を渡し、`setup-done` 以後は攻撃者位置の資格のみで route を実行する。前提作りの操作は捕捉も判定の対象にもしない。被害者側の画面は引き続き Harness 所有の Lab browser が `route.json` の `victim` を読んで開き、skill はブラウザを持たない。Codex Verifier には従来どおり管理者を渡さない。

**誰が回すか。** AI session が `verify next --handoff` を起動し、skill を実行する。定期実行（loop / timer）は後に決める。どちらの transport を使ったかは `verification-finished` の `promptVersion`（Codex は `verifier-v8`、handoff は `wbh-verify/v1`）で分かる。`promptDigest` は skill 本文の sha256。

## 理由

所有者決定 2026-10-18（AGENTS.md「Harness と AI の責務」）。検証の「やり方」を Harness の code に入れると Harness が肥大し報酬が止まる（LESSONS 14）。開発セットと本番の scope 内 Finding は `incomplete(precondition)` `common-usage-scenario-missing` で止まっており、前提は Lab の通常機能の設定で満たせる。所有者は 2026-10-18 に「前提作りは AI に任せる」と述べた。前提作りと攻撃者位置の操作を `setup-done` で時間的に分けると、ADR 0026 が守ろうとした権限境界と判定の独立性（低権限の攻撃手順と管理者操作が混ざらない）は保てる。

## 採らなかった選択肢

- Harness が precondition 文から scenario を選び、plugin 別 adapter で前提を作る: Harness に判断が入り、対象の答えが Lab 前提に混ざる（#353 で削除）。
- skill に管理者セッションを渡さない: 前提作りができず、`incomplete(precondition)` から動かない。
- skill の自己申告を根拠にする: 不変条件 3 に反する。

## 帰結

- ADR 0026 の「Verifier にブラウザや管理者セッションを渡さない」は handoff の前提作りについて本 ADR が上書きし、ブラウザを渡さない点と Codex Verifier の扱いは残る。
- 不変条件 3・4・5 は変えない。`runtime-confirmed` は判定器だけが出し、`abort` / wall 超過は `incomplete`、digest 照合は従来どおり。
- `<dir>` には Lab 内だけで有効な資格と review export が置かれる。Git の外に置き、終わったら消す。
- 受入の数字（Brizy stored-xss 1 件で判定器が結論を出す、TranslatePress 3.2.6 の confirmed 済み 1 件で handoff 経路でも `runtime-confirmed`）は後続の計測で docs/evaluation に置く。

## 消し方

`src/profiles/wordpress/verification/handoff-verifier.ts`、`tests/profiles/wordpress/handoff-verifier.test.ts`、`.claude/skills/wbh-verify/`、`WordPressCampaignBoundaries.handoffVerifier`、CLI の `--handoff` / `verify next --finding`、`WordPressLab.exposeToHost` の `via: "recorder"` と `withdrawFromHost`、`Verifier.attempt` の `restartObservation` を削除し、ADR 0026 の文を戻す。台帳の `promptVersion: wbh-verify/v1` の event は読み続ける。

## 2026-10-19 注記（文書整理、所有者の委任で AI）

「採らなかった選択肢」の「（#353 で削除）」は予定で、scenario 選択と plugin 別 adapter はまだ main にある。削除は帰結の受入の数字（Brizy、TranslatePress 3.2.6）を docs/evaluation に置いた後に #353 で行う（#352 は受け入れの Issue に絞った）。

## 2026-10-21 注記（#423、所有者決定 2026-10-21）

決定の「Codex Verifier の経路は変えない」と「誰が回すか」を改める。runner（`continuous run`）の検証 worker と `--verify-concurrency` を削除し、`verify next` は `--handoff` を必須にした（無ければ UsageError）。受理した scope 内 Finding は全 campaign から handoff 列に並び、再試行予算は現行の skill 版の試行で数える。Codex Verifier（`verifier-v8`）は `review reverify`（`--handoff` なし）と `discovery.lab: attached` の campaign 内検証にだけ残る。後者は scenario 再試行と一体なので #353 で扱う。台帳の `verifier-v8` の event は読み続ける。本 ADR を消すときは #423 の PR も revert する。

## 2026-10-21 追記: 基線を取る時点と、設定管理者の無効化（#430、所有者の委任で AI）

PR #415 のレビュー指摘 2 への対応。決定の本文は変えず、次の 2 点を足す。

- **基線の時点。** `setup-done` を受けた Harness は、`observation-ready` と `attack.json` を置く前に、HTTP 捕捉の起点、Lab 状態の基線、攻撃者 account の role の基線、監視する option の基線をすべて取り直す。判定はこの時点より後の変化だけで行う。SQL と file の canary は基線を取り直さない。`setup-done` の時点で播種した値から変わっていれば、その attempt は `attack.json` を出さずに理由付き `incomplete`（`setup-boundary`）にする。
- **設定管理者の無効化。** 同じく `attack.json` を置く前に、Harness は Lab の中で、`lab.json` に渡した設定管理者の session と application password をすべて破棄し、password を変える。canary 管理者と canary user にも同じことをする。前提作りの間に得た session は、`setup-done` の後では認証に通らない。これは Lab 側の決まった操作で、skill の「使わない」という文には頼らない。無効化に失敗した attempt は、`attack.json` を出さずに理由付き `incomplete`（`setup-boundary`）にする。skill 本文は変えない。

## 2026-10-23 追記: 旧 Codex Verifier の退役（所有者指示）

所有者は、#352 の指定した受入記録が揃っていないとの報告を受けて「削除までして」と指示した。旧 Codex Verifier の退役を受入完了より先に行う。これは Brizy / TranslatePress 3.2.6 の受入達成や handoff の同等性を示す決定ではない。

- `CodexVerifier` の実装、専用 test、実 host での構築を削除する。実 host では `--handoff` のない `review reverify` と `discovery.lab: attached` を退役エラーで止め、別の実行経路へ暗黙に切り替えない。
- 既存の handoff、共有の `WordPressVerifier`、設定管理者の無効化、Snapshot 照合、scope の park、canary と判定器は変更しない。
- scenario の生成と選択、plugin 別 adapter、共有コードに残る指示の連鎖は今回の削除に含めず、#353 に残す。これらに関する受入条件は維持する。
- 旧 Verifier の prompt 本文と digest、台帳の `verifier-v8` event、Private Evidence の読取は維持する。過去の記録を新しい検証結果に読み替えない。退役を戻す場合は、この削除 PR を revert する。

## 2026-10-24 追記: 退役した依存と設定の整理（所有者指示）

- 共通セッションは旧 Verifier を必須とせず、検証を明示的に使う時だけ構築する。実 host の例外専用 Verifier は削除し、未提供の旧経路を使おうとした場合は退役エラーにする。handoff へ暗黙に切り替えない。
- 実行用 campaign 設定の `discovery.lab` は `none` だけを受理する。`attached` は host 初期化より前の設定検査で拒否し、`none` へ変換しない。
- 旧 `labAttached`、Verifier の版と digest、Private Evidence の読取は変更しない。旧 attached Trial の再開拒否も維持する。#352 の受入とシナリオ削除の残件は別に扱う。

## 2026-10-25 追記: attached の探索 Lab の復活（Phase D1）

- `discovery.lab: attached` は、ADR 0003 の 2026-10-25 追記の探索 Lab として再び受理する。探索 Lab は Trial の間だけ使い、canary も判定器も置かない。
- campaign 内の自動検証は戻さない。attached の campaign も、検証は `verify next --handoff` で Finding ごとの検証 Lab に送る。到達しなくなっていた campaign 内検証の経路（旧 Verifier の再試行と scenario による再実行）は pipeline から削除した。旧 attached Trial の再開拒否は維持する。

## 2026-10-25 注記（#525、所有者決定 2026-10-25）

[ADR 0040](0040-human-lab-observation-replaces-judges.md) で、題の「canary・判定器」と、次の行を改めた。

- `lab.json` / `attack.json` に canary の節は無い。6 file は recipe として保存し、判定器には渡さない。Harness は `setup-done` 以後の捕捉と Lab browser の記録を残し、結果を `incomplete(awaiting-human-observation)` にする。
- 帰結の「`runtime-confirmed` は判定器だけが出す」は、「新しい検証は `runtime-confirmed` を出さず、確定は人間が Lab で観測して行う」に置き換わる。`abort` / wall 超過の `incomplete` と digest 照合は変えない。
- 2026-10-21 追記の基線: SQL と file の canary の照合（`setup-boundary`）は無くなった。HTTP 捕捉の起点と Lab 状態の基線は取り直す。判定のための role と option の基線は無くなった（Lab 状態の差分には users と options が残る）。
- 2026-10-21 追記の無効化: 破棄して password を変えるのは設定管理者だけになった。canary 管理者と canary user は作らない。
- 受入の数字（判定器が結論を出す件数）は、ADR 0040 の受入（handoff の結果が人間の観測待ちに届く件数）に読み替える。

## 2026-10-26 追記: 検証 Lab の単一枠を外す（#432、所有者決定 2026-10-26）

PR #415 は handoff の接続と同時に、host 単位の検証 Lab lease（`src/infrastructure/host-lab-lease.ts`、1 host 1 枠、取得待ち 30 分）を入れた。本 ADR の本文にも PARKING.md の再開条件にも無いまま入ったもので、OPERATIONS.md の「host 共通 claim は持たない」と食い違っていた。所有者は 2026-10-26 に「検証ラボの並列数は制限しません」と決めた。

### 決定

- lease を削除する。`verify next --handoff`、`review reverify --handoff`、`lab up --for-review` の Lab は同じ host で何台でも同時に立ち、互いを待たない。Harness は台数の上限も soft な上限も置かない。
- host への公開は Lab ごとに port を取る。`--port` と `--db-port` を省くと Docker が空いている `127.0.0.1` の port を選び、Harness は実際に bind された port を `lab.json` の `host.url` と `attack.json` の `database.port` に書く。skill は今までどおりこの 2 file だけを読む。skill 本文は変えない。
- lease が担っていた「広い掃除が他のプロセスの Lab を消さない」守りだけは、Lab ごとの持ち主記録（`~/.local/state/wordpress-bounty-harness-host/lab-owners/<labId>.json`、pid・boot id・process の開始 tick）で置き換える。Lab は最初の Docker 資源を作る前に記録を書き、持ち主が片付けを試みた後に（成否を問わず）消す。片付けで残ったものは残骸になる。`lab cleanup` は、持ち主が生きている Lab を一覧にも削除にも出さない。持ち主が死んだ Lab と記録の無い Lab は残骸として扱う。runner の掃除は ADR 0036 の 2026-10-25 追記（#526）で Lab を名指ししなくなったので、持ち主の記録も読まず、消さない。記録は排他ではなく、誰も待たせない。Lab ID を名指しする照合（`lab down`、campaign 再開前の残存確認）は記録を見ずに今までどおり数える。
- 移行の間だけ、旧版のプロセスが lease の `verification.json` に持つ生きた Lab も持ち主ありとして扱う。旧版が host から消えたら、この読取を消す。
- #526 より前の checkout で動く runner は、Lab も掃除し、持ち主の記録を読まない。同じ state の `verify next` も、#526 以後は sweep-hold を置かない。そのため、並列の `verify next` を使う前に runner を新しい checkout で再起動する。

### 変えないこと

- 1 回の検証の中で Lab を 1 台ずつ使う順序（agent の Lab を片付けてから再現用の Lab を立てる）、`verification-finished` の形、判定器、Snapshot digest の照合、gVisor と内部 network の隔離。

### 消し方

この節と #432 の PR を revert する。lease が戻り、検証 Lab は再び 1 host 1 枠になり、port は `--port 8080` / `--db-port 3307` の既定に戻る。

## 2026-10-26 追記: `lab.json` と `attack.json`、`abort` の理由、前提の gate（#431、所有者の委任で AI）

PR #415 のレビュー指摘 4 への対応。決定の本文は #415 より前の設計のまま残し、今の code の動きをここに書く。決定の本文にある「`lab.json` に攻撃者位置の資格と canary の節を書く」と「`abort` は `incomplete(recipe)`」は、#415 の実装と食い違っていた。canary の節は ADR 0040 で無くなった（2026-10-25 注記）。

- **`lab.json`（前提作りの側）。** Harness は Lab を host に公開した直後にこれを置く。中身は、skill の版、`runId`・`findingId`・`snapshotDigest`、Lab 内の接続先、host から使う URL と Host header、前提作り専用の設定管理者の資格、Lab に scenario や第 2 言語があればその値、review export の path、受け渡しに使う file の path（`setup-done`、`observation-ready`、`attack.json`、`abort`、6 file）、wall の期限である。攻撃者位置の資格と DB account は入れない。
- **`attack.json`（攻撃者の側）。** `setup-done` が置かれた後、Harness は設定管理者を無効化し、HTTP 捕捉の起点と Lab 状態の基線を取り直す。無効化と捕捉の起点の取り直しができたときだけ `observation-ready` を置き、続けて `attack.json` を書く。中身は、`runId`・`findingId`・`snapshotDigest`、Finding の `attackerPosition` に当たる account 1 つ（`unauthenticated` なら空）、読み取り専用の DB account とその port、参照の route である。DB account は、Lab に DB があり host に公開できたときだけ入れる。`sensitive-object-access` の Finding には入れない。参照の route は、再検証が前の attempt の route を参照にするときだけ入れる。取り直しに失敗した attempt では `attack.json` を出さず、`incomplete(recipe)`（次の手は `setup-boundary`）にする。
- **`abort` の理由。** Harness は `abort` の 1 行目を理由コードとして読む。そのうち `precondition-unavailable` だけを `incomplete(precondition)` にする。ほかのコード（`route-unavailable`、`observer-unavailable`、`handoff-interrupted`、どれにも当たらない値は `unspecified`）と wall 超過は、従来どおり `incomplete(recipe)` にする。次の手は `abort-<コード>:<digest>` の形で、skill が `abort` の前に書いた `<dir>/precondition` の本文は Private Evidence に置き、台帳には digest だけを残す。
- **前提の gate を通さない。** SPEC 第 7 節の前提の分類は handoff でも行い、記録済みの分類と違うときと `admin-configuration` のときは `finding-precondition-classified` を記録する。ただし handoff の transport は、前提作りを自分で受け持つと宣言している（`preconditionSetup: "transport"`）。そのため、分類から `incomplete(precondition)` で早く終える次の 3 つの検査を飛ばす。(a) 分類が次の scenario ID を名指しするとき、run の前に返す。(b) 分類が理由コード `common-usage-scenario-missing` を返すとき、run の前に返す。(c) 6 file が揃った後、Finding の前提が `unknown` に分類されていたときに返す（「catalogue に無い前提」）。飛ばす理由は、本 ADR で前提作りを skill に移したことにある。scenario catalogue に無い前提も、skill が `setup-done` の前に Lab の通常機能で作る。作れなければ、skill は手順どおり `precondition-unavailable` で abort する。6 file の `precondition` が空でないときは、handoff でも `incomplete(precondition)` にする。次の手は、分類から決めた理由コード（`common-usage-precondition` など）と、本文を置いた Private Evidence の digest である。

この節は文書を code に合わせるだけで、skill 本文、code、台帳の event 形は変えない。取り消すときはこの節を消す。
