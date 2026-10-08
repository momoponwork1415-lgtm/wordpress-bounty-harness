# プログラム対象範囲の方針

観測日: 2026-10-08。提出前に各プログラムの公式ページで再確認し、観測日と差分をこのファイルへ追記する。既知脆弱性の答えは書かない。

## Wordfence

- 公式: https://www.wordfence.com/threat-intel/bug-bounty-program/
- Reflected XSSは明示的に対象外。
- 閾値は分類と研究者tierで異なる。High Threatは25件以上かつ条件付き、Stored XSS / SQLiは500件以上かつ条件付き、その他は1337 tierで1,000件以上。premiumで1,000件未満は除外。
- IDOR・broken access control・missing authorizationは、アカウント乗っ取り・権限昇格・サイト全体への影響に到達する場合だけ提出候補にする（判断者の方針）。

## Patchstack

- 公式: https://patchstack.com/ の規則ページ。2026-06-01の改定で報奨poolの対象が変わっている。提出前に確認する。
- 管理画面だけで発火するStored XSSは出さない（旧リポジトリIssue 200の決定を引き継ぐ）。

## 判定の規則

- `runtime-confirmed` と対象範囲は別に記録する。対象外でもVerified Vulnerabilityは残す。
- 公開資料間で矛盾する場合は `ambiguous` にして人間へ回す。
