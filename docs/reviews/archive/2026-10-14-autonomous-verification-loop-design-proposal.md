# 検証までの自律運転: 設計承認案（2026-10-14）

状態: **提案。未承認。** 正本は [SPEC](../../SPEC.md) と [ADR](../../adr/) であり、この文書は変更しない。GitHub `main` と公開済み Issue / PR を照合した。ローカル作業ツリーと旧研究 DB・アーカイブの完全性は、ローカル実行環境の起動エラーにより未確認。

## 目的と優先順位

直近の目的は、未探索対象の初回 Trial から独立検証と `review export` までを、Harness 単体で継続実行し、提出に値する候補を人間へ届けること。運転は固定 24 時間で終了させず、所有者の通常停止、適格な初回対象の枯渇、または安全上の停止まで続ける。一時的な provider 枠切れは待機して再開する。

検証と人間への配送を先に改善する。過去の完了済み本番 3 周は 15 対象から Finding 14 件、`runtime-confirmed` 0 件で、全 14 件が `incomplete` だった（[実測](../2026-10-13-human-review-contract-and-parallel.md)）。直近の初回 3 Trial も Finding 9 件の最新検証が全件 `incomplete`（precondition 7、observation 2）である（[PR #216](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/216)）。探索数だけを先に増やすと、検証できない候補とレビュー負担が増える。

現行 `review.queue()` は `runtime-confirmed` / `reproduced` / `incomplete` を項目として列挙する一方、`contradicted` と未検証 Finding は件数のみである（[実装](../../../src/review/index.ts)）。ユーザー提示の「scope 内 Finding は判定結果に関係なく全件 review queue」という契約との差も、Step 1 の配送測定で解消する。

全体の詳細図は [SVG 図解（5 枚）](2026-10-14-harness-diagrams/README.md) に置く。図は GitHub `main`、Draft PR、未実装提案を区別する。

## 決める設計

```text
人間が版付きの対象方針を設定し、運転を開始
  ↓
selection: 未探索と確認できる対象のメタデータ在庫
  ↓ 直前に公開情報・Programme・既往を再観測
global claim: 対象予約 + PC資源枠 + provider枠
  ↓
固定 batch / campaign: Snapshot → gVisor Lab → 1協調Trial
  ↓
独立Verifier → Harness判定器 → 全scope内Findingをreview export
  ↓
人間: 内容理解・手動確認・提出判断・外部行動承認

Harness supervisor: batch補充、枠待ち、停止、復旧、台帳照合
Codex heartbeat: 通知とログ要約のみ
```

1. **既存のモジュール境界を使う。** `selection` が候補在庫と選定方針、`discovery` が連続運転の監督、`ledger` が Trial と検証結果の追記記録を担う。新しい対象 profile や探索方式の抽象化は、2つ目の実例ができるまで作らない（[SPEC §4a](../../SPEC.md)、[LESSONS](../../LESSONS.md)）。
2. **在庫は slug と観測情報だけにする。** 在庫を作る段階で Snapshot や Lab を量産しない。直近の実測処理速度から「次の約24時間で使う初回対象数」を補充目安にし、上限は版付き方針で制御する。24時間は運転期限ではない。候補源は許可済みの範囲で段階的に列挙し、取得失敗を枯渇と誤認しない。適格候補が尽きたら `waiting-review` とし、install 下限やカテゴリを AI が勝手に緩めない。install 下限は方針の版付き数値、上限は現段階では比較区分とする。カテゴリも人間が版付き方針で変更でき、新しい batch にだけ適用する。
3. **初回と追加 Trial を実行直前に区別する。** plugin slug を同一性とする。全 campaign、provider、`--state` の `discovery-run-started` と旧 DB・アーカイブの実探索を照合し、初回と証明できる slug のみ自動 claim する。旧記録が曖昧な slug は保留する。新版・prompt 変更でも自動初回在庫へ戻さない。2回目以降は、対象・目的・費用・1 Trial に結び付く事前承認が必要（[#215](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/215#issuecomment-6147213921)）。`target-selected` だけで Trial 済みとは数えない。
4. **固定 batch をつなぐ。** 現在の `selection-batch-bound` と campaign ID は不変に保ち、親の運転 ID の下で複数の小さな campaign を順次作る。各 batch の終了後に在庫を補充し、未消費対象だけ次へ進める。親 ID と運転状態は既存モジュール内に追加し、過去 event を変更しない。
5. **ホスト共通の排他と資源管理を置く。** 同じ PC の Codex と Opus、別 campaign、別 `--state` が使う単一の運用 SQLite で対象 claim と CPU・メモリ・Lab・provider の枠を原子的に予約する。運用表は再構築可能な投影であり、Trial 実績と Finding の正本は追記専用台帳に置く。Snapshot 前の在庫・予約に偽の snapshot digest を付けて台帳へ書かない。Opus は最大 2 並列、全体は実 Lab で測った PC 資源上限の内側で動かす。初期値は現行の対象並列 2 とし、測定を伴わずに引き上げない。
6. **停止と復旧は Harness が決める。** 通常停止は新規 claim を止め、進行中 Trial・検証・export を各上限内で完了させる。緊急停止は容器を停止・回収し、途中結果を理由付き `incomplete` にする。監督プロセス自身はホストのサービスマネージャが再起動し、Harness は台帳、運用表、実プロセス・容器を照合する。開始済み Trial の既存成果は回収し、同じ slug の探索を自動で再実行しない。曖昧なら対象だけ保留し、他の安全な初回対象を続ける。隔離・broker・方針の違反は全体停止とする。
7. **provider 枠切れは待機状態にする。** 5時間枠・週次枠の回復後に preflight を通して新しい初回対象から再開する。別 provider が使えるなら、別の未探索 slug を進める。従量課金 API へ自動切替しない。quota 応答で中断した Trial を正常な候補0件として扱わず、同 slug の自動再 Trial もしない。
8. **検証結果は全件届け、失敗理由を減らす。** Programme Boundary 内の Finding は `runtime-confirmed` / `contradicted` / `incomplete` を問わず `review export` に出す。`incomplete` を陰性にしない。まず [#107](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/107#issuecomment-6144327897) の再試行上限の不一致を直し、[#213](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/213) の前提不足を原因別に測る。汎用 scenario を再利用し、必要な通常機能だけ追加する。判定器の証明条件は緩めない。既存のレビュー待ち候補は運転基盤の開発と並行して人間が読む。

## 実装と測定の順

| 順 | 変更単位 | 合格を示す数字 |
| --- | --- | --- |
| 1 | 既存候補のレビュー、#107 の上限修正、#213 の前提不足の選別。review export を欠落させない | 実 Lab で attempt・wall と理由内訳を記録。scope 内 Finding の export 欠落 0。レビュー済み件数と提出判断を記録 |
| 2 | 正本の矛盾を解き、[#215](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/215) の横断既往ガードを完成する。旧 DB・アーカイブの照合対象と不明集合を報告する | 別 campaign・provider・state・同時起動で無承認の同 slug 追加 Trial 0。未開始の選定だけで初回権を失わない |
| 3 | 在庫・複数 batch の補充・共通 claim と資源枠を追加する | 複数 batch で適格な初回対象を補充し、PC 資源超過・対象重複 0。並列 2 の実 Lab wall と失敗率を記録 |
| 4 | 枠待ち、通常・緊急停止、異常・再起動復旧を実装する | 1週分の購読枠を人手介入0で運転。quota回復・強制終了後に成果欠落、無承認再 Trial、残留 gVisor 容器が各0 |

本番の評価は対象数だけでなく、Trial正常完了、Finding分類、`incomplete`理由、reviewで開いた件数、提出可能判定、提出転帰と入金を同じ run / policy digest で追う。月額720ドルの購読費は固定費として純収益に入れる。既知旧版での `runtime-confirmed` は配線の検査であり、未知・最新版の当たり率には算入しない（[SPEC §10](../../SPEC.md)）。

## 承認に含まれる正本の例外と保留範囲

この案は、[DEVELOPMENT §2](../../DEVELOPMENT.md) の Step 1 中の選定方針構造の凍結と、[SPEC §2](../../SPEC.md) の「人間の判断点は2つ」に対し、**同一 slug の追加 Trial 承認、連続在庫・運転**に限る明示例外を要する。既存の `version-or-prompt-changed` 再候補化と [ADR 0032](../../adr/0032-owner-decisions-on-constraints-2026-10-13.md) の自動 +2 Trial、SPEC と実装の再試行上限は整合させる。承認後、コードより先に正本を改訂し、Issue の古い受入条件を更新する。大きな変更は1 PR に混ぜず、上表の問いごとに測定する。

今回の設計には、検証後のレポート自動化、提出自動化、探索方式切替、WordPress以外の profile、選定方針の自動調整を含めない。これらは実測と人間の戦略判断から次の案を作る。
