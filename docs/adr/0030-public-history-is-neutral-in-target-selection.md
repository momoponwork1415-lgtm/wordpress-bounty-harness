---
status: superseded by 0037 (2026-10-19; selection scores advisory counts and dates from the local mirror)
date: 2026-10-12
supersedes: selection history ranking in SPEC section 8b
---

# 対象選定では公開履歴を採点しない（#144）

## 背景

SPEC 第8b節は低権限・高影響の公開履歴を強い優先信号とし、OPERATIONS は履歴の多い対象を避けるとしていた。`selection.md` は履歴を使わないと書き、実装は履歴件数を加点していた。同じ方針から異なる対象が選ばれ得た。

公開履歴の件数は、まだ見つかっていない経路の有無も、提出時に重複と判定される確率も直接示さない。件数だけで加点・減点する根拠はこのリポジトリの実測にはない。

## 決定

公開履歴の件数・内容は選定候補の列挙・除外・採点に使わず、Finding 後の重複照合と時点で切った探索入力にのみ使う。

候補は WordPress.org の公開一覧から列挙し、方針 JSON にある install 数、更新の鮮度、公開タグ、High Threat 面で順位付けする。台帳にある過去の選定と未公開 Finding は別の除外規則として扱う。過去の手動方針にある `historySignals`、`historySource`、`scoreWeights.history` は読み取れるが、現行の順位や適格性には影響しない。

## 結果

履歴件数を増やすためだけに対象を変えることはなくなる。重複の疑いは Finding 後に新しい公開記録と照合し、人間が提出前に判断する。履歴と受理率の関係が本番台帳から測れた場合は、別 Issue と ADR で規則を改める。

## 2026-10-28 注記

本 ADR の順位と除外の行は [ADR 0037 の 2026-10-28 追記](0037-selection-uses-advisory-history-counts.md#2026-10-28-追記-選定をインストール数順の列にする533)で上書きした。現行の選定は履歴を読まず、10k 以上の列をインストール数と更新日で並べ、版上昇で再訪する。
