# Stored XSS の受理基準 v1

Asset ID: `stored-xss-v1`。根拠: `docs/SPEC.md` §7、§8a、§8b、および `src/profiles/wordpress/policy/programme-scope.md`（観測日 2026-10-08）。提出前に scope 方針を再確認する。この文書は技術的成立と提出先の対象範囲を別々に示す。

```json criteria-v1
{
  "id": "stored-xss-v1",
  "version": 1,
  "category": "stored-xss",
  "judgeSuccessCriterion": "低権限主体のnonce付き値が影響ページでJavaScriptとして実行され、canary受信先へ届く。発火contextと範囲を記録する。",
  "programmeCriteria": {
    "wordfence": [
      "低権限または未認証の保存値が被害者の閲覧するページでJavaScriptとして実行される。特定ページだけの発火も候補。",
      "Active installationsは500以上。500〜999ではWordPress.org掲載が必要。premiumは1,000未満を除外。",
      "提出直前の最新版、既定設定または一般的な利用範囲で成立する。"
    ],
    "patchstack": [
      "保存されたXSSがサイト全体に効く。サイト全体に効かないものはmVDPのみで、報奨提出候補にはしない。",
      "Active installationsは100以上。100〜999ではCVSS 8.5以上。",
      "提出直前の最新版、既定設定または一般的な利用範囲で低権限または未認証から成立する。"
    ]
  }
}
```

## 技術的成立

- 未認証、subscriber、customer 相当の主体が保存した nonce 付き値が、影響を受けるページを被害者が開いたときに JavaScript として実行され、Harness の canary 受信先に届く。
- Harness が発火した画面、被害者ロール、JavaScript の発火 context と影響範囲を記録する。単なる HTML 表示や agent の自己申告を成立証拠にしない。
- 原 Finding と検証結果の Target Snapshot digest が一致する。HTTP と canary の証拠は Harness が捕捉したものを使い、観測できなければ `incomplete` とする。

## Wordfence の充足欄

- 低権限または未認証の入力が保存され、被害者が開くページで JavaScript が実行されたか。特定ページだけで発火しても候補とする。
- Active installations が 500 以上か。500〜999 の場合は WordPress.org 掲載が必要で、premium は 1,000 未満を除外する。
- 提出直前の最新版かつ既定設定または一般的な利用範囲で再現したか。管理者の明示的な誤設定に依存していないか。

## Patchstack の充足欄

- 保存された XSS がサイト全体に効くか。サイト全体に効かない stored XSS は mVDP のみで、報奨提出候補にはしない。
- Active installations が 100 以上か。100〜999 の場合は CVSS 8.5 以上か。
- 提出直前の最新版かつ既定設定または一般的な利用範囲で、未認証・subscriber・customer 相当から再現したか。

各欄は Harness の観測と programme scope 評価結果で満たす。根拠が欠ける欄を `in-scope` と推測しない。修正版での負の対照が採れなければ、その旨を再現パッケージに明示する。
