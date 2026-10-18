# Harness 全体図解（2026-10-14）

スマートフォンで1枚ずつ読める縦長の SVG。**現行 `main`、未マージの Draft PR、今回の設計案、実測課題、将来案**を文字と線種でも区別した。正本は [SPEC](../../SPEC.md) と [ADR](../../adr/) であり、この図は調査・設計提案である。特定対象の slug、候補本文、payload、HTTP 本文、認証情報は含めない。

1. [全体像と責任の境界](01-overview.svg) — 戦略設定から提出転帰まで。
2. [対象選定と初回 Trial](02-selection.svg) — 既往照合、候補在庫、新版、候補不足。
3. [並列実行と資源管理](03-execution.svg) — campaign 内の実装と Codex・Opus 横断の差。
4. [検証・証拠・レビュー](04-verification.svg) — 信頼境界、nonce 判定、`incomplete`、人間への受け渡し。
5. [継続運転と現在地](05-continuous.svg) — 枠待ち、停止、異常復旧、実測障害、実装順。

## 読む際の注意

- `main` の既定探索 prompt は `v3`。`v4` は [PR #217](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/217) の Draft、Opus は [PR #225](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/225) の Draft。ユーザー提示の AGENTS 要約には `v4` 既定と書かれているため、図では版の実装状態を明示した。
- `main` は1 campaign内で対象2並列、provider上限停止、同じ campaign ID での未完了対象再開まで実装済み（[PR #203](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/203)）。複数 batch の自動補充、全 provider 共通の対象予約・PC資源管理、枠回復後の自動再開は設計案。
- `main` の [review queue](../../src/review/index.ts) は `contradicted` と未検証 Finding を件数だけ表示する。ユーザー提示の「scope内Finding全件をreview queue」という契約との字義差を図4に記した。
- 24時間は候補在庫の目安。親運転の終了期限ではない。現在の `maximumTargets=5` は1バッチの対象上限であり、24時間在庫の量ではない。
- 「初回のみ自動、同 slug の2回目以降は毎 Trial 承認」は[#215](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/215#issuecomment-6147213921)の所有者決定。横断ガードは[PR #216](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/216)の Draft。

## 主な根拠

- [SPEC](../../SPEC.md)、[DEVELOPMENT](../../DEVELOPMENT.md)、[LESSONS](../../LESSONS.md)、[既存の設計図](../../DESIGN-DIAGRAMS.md)
- [現行の選定方針](../../src/profiles/wordpress/policy/selection.json)、[campaign方針](../../src/profiles/wordpress/policy/campaign.json)
- [本番3周の検証実測](../2026-10-13-human-review-contract-and-parallel.md)、[直近の初回Trial](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/216)
- [Lab前提不足 #213](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/213)、[再試行上限 #107](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/107)、[provider拒否 #220](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/220)、[権限問題 #222](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/222)、[取得タイムアウト #223](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/223)

ローカル shell が起動せず、作業ツリーや Private Evidence は照合できていない。図の実装状態は GitHub `main` と公開 PR / Issue の確認結果に基づく。
