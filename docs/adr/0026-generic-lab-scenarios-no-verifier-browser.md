---
status: accepted
supersedes: 0020 for scenario selection priority and victim-side operations
superseded-in-part-by: 0035 for the administrator boundary of a handoff Verifier run
---

# 検証 Lab は汎用 scenario を主とし、Verifier にブラウザを渡さない

## 決定

WordPress profile の版・digest付き通常機能 scenario catalogue に、plugin に依存しない利用状態を優先して追加する。`incomplete(precondition)` の理由コードを台帳から、次の手の本文をdigestで参照するPrivate Evidenceから集計し、頻出する前提を2〜3件ずつ実装してから同じ Finding を再検証する。scenario は通常機能の有効化と無害なデータ投入だけを行い、対象固有の関数名、option名、URL、画面名、既知経路を含めない。

被害者側のブラウザ操作は Harness 所有の Lab 観測器が、型で制限した手順として実行する。Verifier にブラウザ、管理者セッション、scenario の編集権限を渡さない（2026-10-18 改訂: handoff の skill には前提作りのためだけに Lab の設定管理者を渡し、`setup-done` 以後は攻撃者位置のみ。[ADR 0035](0035-verification-as-a-skill.md)。Codex Verifier とブラウザについては本文のまま）。観測器は Finding が宣言した被害者ロールと画面の文脈で canary を観測し、結果を Private Evidence に保存する。必要な操作を catalogue と手順型で表せない場合は `incomplete(precondition)` または `incomplete(observation)` を理由と次の手付きで残す。

## 理由

検証の多数が判定器なし、または Lab の通常利用状態の不足で `incomplete` になった。対象ごとの特別な setup を増やすと探索への答えが混ざり、Verifier に管理者操作を任せると権限境界と判定の独立性を失う。汎用 scenario と Harness 観測器なら、同じ前提を複数対象で使える。

根拠: [完成度レビュー](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-harness-completeness-review.md) 第4.3節、[prompt 下書き](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-two-stage-prompts-draft.md)。

## 採らなかった選択肢

- Verifier の image にブラウザを入れて被害者を操作させる: 低権限の攻撃手順と被害者の観測が混ざる。
- 公開事例ごとの専用 scenario を増やす: 評価対象の答えを Lab 前提に埋め込む。

## 既存決定との関係と帰結

- [ADR 0020](0020-versioned-feature-scenarios-for-lab.md) の scenario ID、digest、Finding の前提照合、再試行時の Lab Setup 変更条件を維持し、catalogue の追加順と被害者操作の所有者を更新する。過去の対象向け scenario は履歴として残す。
- [ADR 0021](0021-stored-script-judge-victim-context.md) の被害者ロールと画面の宣言、[ADR 0004](0004-harness-owned-judges-decide-runtime-confirmed.md) の nonce 判定は維持する。
- `incomplete` の集計に payload、HTTP本文、recipe を台帳へ持ち込まない。台帳は理由と digest 参照だけを持つ。
