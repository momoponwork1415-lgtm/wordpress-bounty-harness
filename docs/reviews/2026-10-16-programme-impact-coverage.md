# Programme impact の observer / judge 対応表（2026-10-16、#277）

調べて報告。対象は Finding schema の impact から `isWordPressProgrammeImpact` が対象内とする 17 種。`Lab observer` は判定に使う主な Lab 側の観測メソッド、`Judge ID` は `createWordPressJudges(...).for(finding)` の現行値。`—` は専用の観測器または judge が無いことを示す。表は現状の棚卸しであり、成功条件や提出可否を変更しない。

| Impact | Lab observer | Judge ID |
| --- | --- | --- |
| `rce` | `observeExecution` | `wordpress-execution-canary` |
| `php-file-write` | `observeExecution` | `wordpress-execution-canary` |
| `arbitrary-file-read` | `readCapture` | `wordpress-file-canary-read` |
| `arbitrary-file-delete` | `observeCanaryFiles` | `wordpress-file-canary-delete` |
| `arbitrary-file-download` | `readCapture` | `wordpress-file-canary-read` |
| `lfi` | `readCapture` | `wordpress-file-canary-read` |
| `rfi` | — | — |
| `sqli` | `readCapture`, `observeCanaryTable` | `wordpress-sql-canary` |
| `options-update` | `observeOptions` | `wordpress-option-canary` |
| `privesc-to-admin` | `observeSessionUser`, `observeAccountRoles` | `wordpress-administrator-principal` |
| `auth-bypass-to-admin` | `observeSessionUser`, `observeAccountRoles` | `wordpress-administrator-principal` |
| `account-takeover` | `observeSessionUser`, `observeAccountRoles` | `wordpress-administrator-principal` |
| `privesc-to-contributor+` | `observeSessionUser`, `observeAccountRoles` | `wordpress-non-administrator-principal` |
| `auth-bypass-non-admin` | `observeSessionUser`, `observeAccountRoles` | `wordpress-non-administrator-principal` |
| `sensitive-object-access` | `readCapture`, `observeSessionUser` | `wordpress-sensitive-object-canary` |
| `content-deletion` | — | — |
| `stored-xss` | `observeStoredScript` | `wordpress-stored-script` |

## 構造上の未対応

- **`rfi` と `content-deletion`:** 両者は Finding schema にあり、Programme 除外一覧には無い（`src/profiles/wordpress/discovery/finding.ts:48,57`、`src/profiles/wordpress/discovery/programme-impacts.ts:13-20`）。judge の switch に mapping が無く（`src/profiles/wordpress/verification/judges.ts:1382-1410`）、標準 reproducer の `expectedCanaries` にも対応が無い（`src/profiles/wordpress/verification/standard-reproducer.ts:59-79`）。後者は canary が空なら `incomplete(observation)` を返す（同 `:113-118`）。
- **no-judge の実行経路:** 標準 runner が設定されると judge set に reproducer が付く（`src/profiles/wordpress/verification/judges.ts:1368-1381`）。Verifier の早期 `incomplete(no-judge)` は judge と reproducer が両方無い場合だけであり（`src/verification/index.ts:312-317`）、judge が無い場合も標準再現へ進む（同 `:534`）。このため、現行の `rfi` と `content-deletion` は正常な再現試行に進めば `incomplete(observation)` になる。ADR 0032 Q1 が `content-deletion` に求める `incomplete(no-judge)` と差がある。表とテストはこの実行時挙動を変えない。
- **nonce 付き REST:** `sensitive-object-access` の judge は header 名に `nonce` を含むだけで `incomplete(evidence)` にする（`src/profiles/wordpress/verification/judges.ts:911-920`）。Lab の公開契約には WordPress REST nonce の発行値を低権限 cookie の所有者と結び付けて照合するメソッドが無い（`src/profiles/wordpress/lab/index.ts:286-367`）。従って、Lab 発行の `X-WP-Nonce` を使う正規 REST 経路は今の judge では確認できない。

専用 observer、no-judge の実行経路、REST nonce の取扱いをどの順で実装するかは所有者の判断事項。判定器の成功条件は緩めない。
