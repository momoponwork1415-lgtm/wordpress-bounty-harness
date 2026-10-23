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
