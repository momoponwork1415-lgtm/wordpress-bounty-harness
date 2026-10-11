# SQLi の受理基準 v1

Asset ID: `sqli-v1`。根拠: `docs/SPEC.md` §7、§8a、§8b、および `src/profiles/wordpress/policy/programme-scope.md`（観測日 2026-10-08）。提出前に scope 方針を再確認する。この文書は技術的成立と提出先の対象範囲を別々に示す。

```json criteria-v1
{
  "id": "sqli-v1",
  "version": 1,
  "category": "sqli",
  "judgeSuccessCriterion": "Labが置いたnonce付きcanary行の値がHTTP応答に現れる、またはcanary表への書き込みがHarnessに観測される。wp_magic_quotesは既定のまま。timing差だけでは成立しない。",
  "programmeCriteria": {
    "wordfence": [
      "canary行の読み出しまたはcanary表への書き込みをwp_magic_quotes既定で観測する。無効化が前提なら対象外。",
      "Active installationsは500以上。500〜999ではWordPress.org掲載が必要。premiumは1,000未満を除外。",
      "提出直前の最新版、既定設定または一般的な利用範囲で成立する。"
    ],
    "patchstack": [
      "canary行の読み出しまたはcanary表への書き込みを低権限または未認証から観測する。",
      "Active installationsは100以上。100〜999ではCVSS 8.5以上。",
      "提出直前の最新版、既定設定または一般的な利用範囲で成立する。"
    ]
  }
}
```

## 技術的成立

- 未認証、subscriber、customer 相当の主体による SQLi で、Lab が置いた nonce 付き canary 行の値が HTTP 応答に現れる、または canary 表への書き込みが Harness に観測される。
- Lab は `wp_magic_quotes` を既定のままにする。timing 差や Verifier の自己申告だけでは成立としない。
- 原 Finding と検証結果の Target Snapshot digest が一致する。HTTP と canary の証拠は Harness が捕捉したものを使い、観測できなければ `incomplete` とする。

## Wordfence の充足欄

- canary 行の読み出しまたは canary 表への書き込みを、`wp_magic_quotes` 既定で観測したか。無効化が前提なら対象外。
- Active installations が 500 以上か。500〜999 の場合は WordPress.org 掲載が必要で、premium は 1,000 未満を除外する。
- 提出直前の最新版かつ既定設定または一般的な利用範囲で再現したか。管理者の明示的な誤設定に依存していないか。

## Patchstack の充足欄

- canary 行の読み出しまたは canary 表への書き込みを、未認証・subscriber・customer 相当から観測したか。
- Active installations が 100 以上か。100〜999 の場合は CVSS 8.5 以上か。
- 提出直前の最新版かつ既定設定または一般的な利用範囲で再現したか。

各欄は Harness の観測と programme scope 評価結果で満たす。根拠が欠ける欄を `in-scope` と推測しない。修正版での負の対照が採れなければ、その旨を再現パッケージに明示する。
