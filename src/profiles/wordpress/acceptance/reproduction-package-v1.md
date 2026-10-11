# 再現パッケージ雛形 v1

Asset ID: `reproduction-package-v1`。どの影響分類でも次の四節をこの順で読む。個別の値、HTTP 記録、認証情報、payload、画面画像は Private Evidence に置き、Git に入れない。各欄に `harness-captured` または `agent-authored` の出自を付ける。人間の判断と再現に使う欄は Harness が捕捉・生成したものに限り、agent 作成物は補助ファイルに分ける。

```json template-v1
{
  "id": "reproduction-package-v1",
  "version": 1,
  "sections": [
    { "id": "acceptance", "heading": "受理基準の充足" },
    { "id": "observation", "heading": "期待する観測と実際の観測" },
    { "id": "negative-control", "heading": "修正版での負の対照" },
    { "id": "steps", "heading": "再現手順" }
  ]
}
```

## 1. 受理基準の充足

- 影響分類、受理基準の版と digest: `harness-captured`。技術的成立の観測条件を示す。
- Wordfence: `in-scope` / `out-of-scope` / `ambiguous`、根拠と方針の観測日を示す。`harness-captured`。
- Patchstack: 同上。サイト全体など分類固有の条件が未観測なら `ambiguous` と明示する。`harness-captured`。

## 2. 期待する観測と実際の観測

- 期待する観測: 分類の受理基準に対応する canary / 認証状態と、期待する画面・応答。`harness-captured`。
- 実際の観測: Harness が捕捉した HTTP、canary、画面画像の証拠参照と、その観測条件。`harness-captured`。
- 観測に欠落がある場合は成立したことにせず、欠落した証拠を明示する。

## 3. 修正版での負の対照

- 修正版の Target Snapshot digest、同じ再現手順での期待と実際の観測、Harness の捕捉証拠参照を示す。`harness-captured`。
- 負の対照が採れない場合は「未取得」と理由を明示する。未取得を `contradicted` の証拠にしない。

## 4. 再現手順

- 前提設定: WordPress / 対象の版、Target Snapshot digest、Lab Setup digest、既定設定か変更内容、setup manifest からの起動方法。`harness-captured`。
- 使用ロール: 未認証・subscriber・customer 相当のどれか、被害者ロールと必要な Lab-only 認証情報の参照。`harness-captured`。
- 手順: 遠隔攻撃者の視点の HTTP リクエストと必要な被害者画面操作を番号順に示す。WP-CLI などサーバー側だけの操作を再現手順にしない。`harness-captured`。
- agent の補助手順がある場合は別ファイルに置き、ここには混ぜない。
