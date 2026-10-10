---
status: accepted
---

# 検証 Lab の前提を profile の版付き通常機能シナリオにして Finding と照合する

## 決定

対象プラグインの通常の利用状態を、profile が持つ版と digest 付きの「通常機能シナリオ」として定義し、探索 Lab と検証 Lab の setup はシナリオ ID を持つ。

- シナリオは通常機能の有効化と無害なデータの投入に限る。管理者権限の付与、既定外の危険設定、既知脆弱性の答えや PoC は含めない。最初の catalogue は WordPress profile に置き、TranslatePress 向けの二次言語と翻訳データ、承認済みコメント（ADR 0017 の fixture）を最初の項目にする。
- `lab-provisioned` event にシナリオ ID と digest を残す。Lab Setup digest はシナリオを含めて計算する。
- Finding の `configurationPrecondition` は catalogue と照合する。Verifier が `incomplete(precondition)` を返すとき、next step には catalogue にある次のシナリオ名か「catalogue に無い前提」のどちらかを書く。
- catalogue に無い前提は人間が読んでシナリオを追加するか、`incomplete` のまま残す。Verifier にシナリオの追加や Lab の設定変更は許さない。

## 理由

検証 Lab は探索 Lab と同じ setup digest で立つため、Finding が要求する前提を Harness が満たす手段がない。2026-10-10 の tp326-wp2-comment-c1 では SQLi と Stored XSS の検証が、翻訳データの不在、machine translation の無効、管理者画面の操作の必要、という前提不足で `incomplete(precondition)` になった。現行の TranslatePress Lab setup は二次言語の有効化と空の辞書表の作成だけで、プラグインの通常の利用状態ではない。3.3.1 のゲートでも最初の検証は言語設定の不足で止まり、人手で Lab を変えてから確定した。前提を自由文のままにすると、同じ失敗が対象ごとに繰り返される。

## 採らなかった選択肢

- Verifier に管理者アカウントを渡して前提を自分で作らせる: 不変条件 6（権限拡張は人間の明示承認）に反し、判定の独立性も損なう。
- 探索 agent に Lab の設定変更を許す: 探索の入力が Trial ごとに変わり、比較できなくなる。
- 対象ごとに人間が Lab を手で整える: 本番の 3 対象以降で人手が律速になる。

## 既存決定との関係

- SPEC 第7節の Verifier 入力に「Lab Setup（シナリオ ID を含む）」を加える。不変条件 2 と 6 は変えない。
- ADR 0010 のとおり、シナリオが既定設定か一般的な利用範囲かは scope 評価の材料として記録し、検証を止める条件にはしない。
- ADR 0022 の再試行方針は、`precondition` の再試行をシナリオ ID の変更に結び付ける。

## 帰結

- 受入条件: 記録済みの tp326-wp2-comment-c1 の Finding 2 件を、翻訳データを持つシナリオで再検証し、結果と理由を記録する。確認できない場合も `incomplete` のまま残す。
- 2 つ目の profile ができるまで、シナリオの型は WordPress profile に閉じる（ADR 0011）。
