---
status: accepted
---

# 出力契約を Harness が schema から生成し、prompt は目的文だけを持つ

## 決定

探索 prompt の版は目的文（目的、trust 境界の扱い、影響の優先順位、Finding と Lead の区別、Root の分担方針）だけを持つ。Finding / Lead の出力契約（key、enum、`sourceTrace` の形、テキスト欄は単一文字列、WordPress core は `@wordpress/` 接頭辞、Root の最終報告での JSON 文字列符号化）は、trust 境界や Lab の節と同じく `campaign run` が実行時に組み立てる節にし、profile の Zod schema から生成する。

- 台帳には目的文の digest と契約節の digest を別に記録する。prompt の版比較は目的文の差だけを表す。
- 契約節の生成文と schema の同期はテストで検査する。ADR 0018 の正規化規則は同じ schema から導き、契約節に明記する。
- 目的文だけを持つ新しい prompt 版を追加し、旧版は過去 Trial の再現用に残す（ADR 0013 の版管理規則）。
- 探索手順、checklist、役割分担は契約節にも目的文にも書かない（SPEC 第6節）。

## 理由

`short-objective-managed-v4` と `wp2shell-bounty-v2` は出力契約の段落をそれぞれ手で持つ。`wp2shell-bounty-v1` は契約の書き方が曖昧で全候補が棄却され、`labObservations` が配列になる形式ずれはどの版の契約文にも明記されていない。契約が prompt ごとにずれる構造では、prompt の比較に出力形式の差が混入し、ADR 0017 の比較が prompt の目的の差を測れない。契約の正本は profile の schema なので、そこから生成すれば prompt と schema の乖離は起きない。

## 採らなかった選択肢

- 各 prompt file の契約段落を手で揃え続ける: 版が増えるたびに乖離の機会が増える。
- 契約節を schema から生成せず固定の Markdown にする: schema の変更時に同じ乖離が起きる。

## 既存決定との関係

- ADR 0013 の「本文を変えたら版を上げる」規則は目的文に適用し、契約節は schema の版と digest で追う。
- ADR 0017 の比較 arm は、目的文の版だけが異なる構成として再定義できる。
- SPEC 第6節「入力」に、契約節が Harness 生成であることを追記する。

## 帰結

- `discovery-run-started` の configuration に `objectiveDigest` と `contractDigest` を持つ。既存の `promptDigest` は後方互換のため残す。
- 既定 prompt の切り替えはこの ADR では行わない。目的文だけの新版を追加した後、ADR 0017 の方針に従って比較する。
