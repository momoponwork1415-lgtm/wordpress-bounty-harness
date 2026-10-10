---
status: accepted
---

# sensitive-object-access を優先順位に残すなら判定器を持つ

## 決定

`sensitive-object-access` を探索 prompt の優先順位に残す。そのために Harness 所有の判定器を作る。

- Lab は provision 時に、低権限主体が本来読めない対象（非公開投稿、下書き、他主体の個人設定など、profile が列挙する種類）に nonce 付きの canary 文字列を置く。
- 判定器は、Verifier の HTTP 記録のうち低権限または未認証の主体による応答に canary が現れたときだけ `runtime-confirmed` とする。文字列の反射、件数や応答長の差、エラーメッセージの差は採用しない。
- 読めた対象の種類を条件として記録し、Wordfence の「機微情報の漏えい」と Patchstack の「機微な対象に限る」の判定は scope 段階で行う（ADR 0010）。
- `other` は判定器を持たず `incomplete(no-judge)` のまま人間へ回す。`other` は分類できない効果の受け皿であり、確認条件を定義できない。

## 理由

2026-10-10 の短い prompt の 3.2.6 Trial（tp326-sv3-c1、tp326-sv4-comment-c1）で記録された Finding はすべて `sensitive-object-access` か `other` で、全件 `incomplete(no-judge)` に落ちた。SPEC 第7節は「両プログラムで報奨に届く分類だけ判定器を作る」とする。Wordfence の「その他」tier（install 数 500 以上）は機微情報の漏えいを含み、Patchstack も機微な対象なら受理するので、この分類は報奨に届く。優先順位に置きながら判定器を持たない状態は、短い Trial の成果を評価不能にし、ADR 0023 の funnel でも「verifier 通過」で止まる。優先順位から外す選択肢は、探索が実際に出している分類を捨てることになるため採らない。

## 採らなかった選択肢

- 優先順位から外す: 報奨に届く分類を探索の目的から外すことになり、短い Trial の主な成果を失う。
- 人間が手で確認する運用を続ける: 不変条件 6 の人間の判断点を増やし、本番の 3 対象以降で律速になる。
- `other` にも判定器を作る: 確認条件を定義できない分類に判定器は作れない。

## 既存決定との関係

- SPEC 第7節の判定器の表に `sensitive-object-access` の行を加える。ADR 0004 は変えない。
- `programme-scope.md` の `requiredObservations` にある `sensitive-canary-access` を、この判定器の観測名として使う。

## 帰結

- 受入条件: 記録済みの `sensitive-object-access` Finding（tp326-sv3-c1 または tp326-sv4-comment-c1）で判定器を 1 回動かし、結果と条件を記録する。
- canary を置く対象の種類は profile の一覧として版管理し、探索 agent には渡さない（不変条件 1）。
