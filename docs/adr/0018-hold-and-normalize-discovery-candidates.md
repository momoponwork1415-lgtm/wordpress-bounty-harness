---
status: accepted
---

# 探索候補を出力境界で失わず、受理できない候補も理由付きで保持する

## 決定

探索 run の出力境界を「候補ごと・transcript ごとに受理か棄却か」から「生のまま保持し、正規化して受理し、受理できなければ保留」に変える。

1. Root と各子の最終 JSON から抽出した Finding / Lead 候補は、正規化の前に生のまま Private Evidence へ保存する。transcript 全体が不適合でも、抽出できた候補は保存と受理の対象にする。
2. 受理の前に profile の正規化を通す。正規化は構文の受理であり、内容や有効性の判断ではない。最初に持つのは、テキスト欄の文字列配列を改行で結合すること、`file / function / line` 形式の `sourceTrace` 文字列を object に構造化すること、固定 mount の表記を `@wordpress/` 接頭辞に揃えること（ADR 0017）の 3 つ。正規化した内容は台帳の event に残す。
3. 正規化後も schema を通らない候補は `candidate-held` として台帳に残す。event が持つのは run ID、候補の digest、schema の issue path、Finding なら impact 分類、Lead なら primitive と missingEdge だけで、本文は Private Evidence に置く。正規化を直した後、保留候補は同じ Snapshot digest のまま再受理できる。
4. 出力境界で候補を保留した Trial は、停止規則の `noFindingRuns` に数えない。保留だけの Trial の停止理由は `no-new-finding` ではなく `output-boundary` とする。

## 理由

ADR 0016 は「provider 上限・schema 失敗を含めて子の成果が失われないこと」を最初の本番探索の受入条件にした。2026-10-10 の TranslatePress 3.2.6 の 5 Trial では、Root の最終 JSON に優先分類の候補が 4 Trial で現れたが、正式記録は 1 Trial だけだった。残りは `sourceTrace` の文字列化（tp326-wp1-c1）、transcript の `file_change` 不許容（tp326-wp2-c2、候補 6 件が一括で消失）、`../wordpress/` 表記（tp326-wp2-comment-c1）で失われ、別に `labObservations` が配列の候補（tp326-sv4-c1 の子 Lead、tp326-wp1-c1 の子 Finding）も棄却された。形式のずれは 4 種あり、1 種ずつ parser を直す方法では次の形式で同じ損失が起きる。`candidate-rejected` が `reason: "schema"` しか持たないため、診断には Private Evidence を読む必要があった。tp326-wp1-c1 は全候補が棄却された結果 `stoppedBy: no-new-finding` と記録され、出力境界の失敗が探索の陰性結果として停止規則に入った。

## 採らなかった選択肢

- 形式ずれごとに parser を直し続ける: 既に 4 種で、次の種類を予測できない。
- 候補の schema を緩める: Finding の型は検証と判定器の入力契約なので緩めない。緩めるのは受理の前段の正規化だけにする。
- 不適合候補をそのまま Finding として記録する: 不変条件 3・5 に反する。保留は記録であり、Finding でも検証対象でもない。

## 既存決定との関係

- SPEC 第6節「schema 失敗は 0 件の正常完了にしない」を、保持・正規化・保留の契約へ具体化する。不変条件 8（台帳は digest 参照だけ）は保留 event にも適用する。
- ADR 0005 の追記専用台帳は変えない。過去の `candidate-rejected` event はそのまま残し、再受理は新しい event として追記する。
- ADR 0017 の `@wordpress/` 正規化と `file_change` 許容は、この決定の正規化規則の最初の 2 つとして位置付ける。

## 帰結

- 受入条件: 保存済みの 3.2.6 最終 JSON（tp326-wp1-c1、tp326-wp2-c2、tp326-wp2-comment-c1、tp326-sv4-c1 の子 Lead）を新しい境界に通し、候補 10 件の受理数と保留数を記録する。
- `ledger funnel` は保留候補を別の列で数える（ADR 0023）。
- 出力契約を prompt から Harness 生成の節へ移す決定（ADR 0019）と対にし、正規化規則と契約節は同じ schema から導く。
