# アカウント乗っ取りの受理基準 v1

Asset ID: `account-takeover-v1`。根拠: `docs/SPEC.md` §7、§8a、§8b、および `src/profiles/wordpress/policy/programme-scope.md`（観測日 2026-10-08）。提出前に scope 方針を再確認する。この文書は技術的成立と提出先の対象範囲を別々に示す。

```json criteria-v1
{
  "id": "account-takeover-v1",
  "version": 1,
  "category": "account-takeover",
  "judgeSuccessCriterion": "低権限主体が別主体である管理者の認証状態または管理者相当の能力を得たことをHarnessが観測する。別主体のcookie送信だけでは成立しない。",
  "programmeCriteria": {
    "wordfence": [
      "低権限主体が管理者の認証状態または管理者相当の能力に到達する。観測した到達形態を記録する。",
      "Active installationsは25以上。25〜999ではWordPress.org掲載が必要。premiumは1,000未満を除外。",
      "提出直前の最新版、既定設定または一般的な利用範囲で成立する。管理者の明示的な権限付与に依存しない。"
    ],
    "patchstack": [
      "低権限主体が管理者の認証状態または管理者相当の能力に到達し、到達形態を記録する。",
      "Active installationsは100以上。100〜999ではCVSS 8.5以上。",
      "提出直前の最新版、既定設定または一般的な利用範囲で低権限または未認証から成立する。"
    ]
  }
}
```

## 技術的成立

- 未認証、subscriber、customer 相当の主体が、別主体である管理者の認証状態または管理者相当の能力を得たことを Harness が観測する。
- 単に別主体の cookie を送っただけでは成立としない。Lab が別主体の session または管理者相当の能力を検査し、攻撃者本人の正当な権限との差を記録する。
- 原 Finding と検証結果の Target Snapshot digest が一致する。認証状態と HTTP の証拠は Harness が捕捉したものを使い、観測できなければ `incomplete` とする。

## Wordfence の充足欄

- 低権限主体が管理者の認証状態または管理者相当の能力に到達したか。Harness が観測した到達形態を記録する。
- Active installations が 25 以上か。25〜999 の場合は WordPress.org 掲載が必要で、premium は 1,000 未満を除外する。
- 提出直前の最新版かつ既定設定または一般的な利用範囲で再現したか。管理者の明示的な権限付与・誤設定に依存していないか。

## Patchstack の充足欄

- 低権限主体が管理者の認証状態または管理者相当の能力に到達したか。対象と到達形態を記録する。
- Active installations が 100 以上か。100〜999 の場合は CVSS 8.5 以上か。
- 提出直前の最新版かつ既定設定または一般的な利用範囲で、未認証・subscriber・customer 相当から再現したか。

各欄は Harness の観測と programme scope 評価結果で満たす。根拠が欠ける欄を `in-scope` と推測しない。修正版での負の対照が採れなければ、その旨を再現パッケージに明示する。
