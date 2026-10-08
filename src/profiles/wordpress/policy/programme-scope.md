# プログラム対象範囲の方針

観測日: 2026-10-08。提出前に各プログラムの公式ページで再確認し、観測日と差分をこのファイルへ追記する。既知脆弱性の答えは書かない。

## Wordfence

- 公式: https://www.wordfence.com/threat-intel/bug-bounty-program/
- Reflected XSSは明示的に対象外。
- 閾値は分類と研究者tierで異なる。High Threatは25件以上かつ条件付き、Stored XSS / SQLiは500件以上かつ条件付き、その他は1337 tierで1,000件以上。premiumで1,000件未満は除外。
- 攻撃者の権限: 未認証とsubscriber（WooCommerceのcustomer相当を含む）だけを提出候補にする。contributor以上を要するものは対象外として記録する（判断者の指示、2026-10-08）。公式規約の該当文言は未取得（wordfence.comがbot検査で取得できず）。検索結果では規約がPR:H（administrator / editor）を報奨対象外としていることだけ確認できた。提出前に公式ページでcontributorの扱いを再確認する。
- 権限昇格は、未認証またはsubscriberからcontributor以上へ上がるものだけを対象にする。
- IDOR・broken access control・missing authorizationは、アカウント乗っ取り・権限昇格・サイト全体への影響に到達する場合だけ提出候補にする（判断者の方針）。

## Patchstack

- 公式: https://patchstack.com/ の規則ページ。2026-06-01の改定で報奨poolの対象が変わっている。提出前に確認する。
- 攻撃者の権限（2026-10-08、公式ガイドライン2026年版の観測）: 未認証はx2、subscriber / customerはx1。contributorはmVDPのみでx0.75（XPが付かないことがある）。editor / author / admin / shop managerは不受理。subscriberより多い権限のcustom roleは不受理。管理者が明示的に付与するroleは対象外。
- contributor以上のStored XSSは除外。権限昇格はcontributor以上へ到達するものだけ。
- 除外種別（抜粋）: open redirect、CSV injection、full path disclosure、HTMLのみ / CSSのみのinjection、2FA bypass、rate limit欠如、multi-step CSRF、non-arbitrary LFI、AC:Hの報告、PIIだけのIDOR、添付 / チケット / 注文 / 予約のIDOR。
- 閾値: 1,000件以上。倍率は件数帯で x0.5（1K）〜x10（5M）。
- 管理画面だけで発火するStored XSSは出さない（旧リポジトリIssue 200の決定を引き継ぐ）。

## 判定の規則

- 探索の攻撃者位置は未認証とsubscriberに限る。trust境界宣言ではcontributor以上を信頼する側に置く（両プログラムで報奨に届かないため）。判定器はcontributor以上の経路も技術的に確認できるが、探索の目的には含めない。
- `runtime-confirmed` と対象範囲は別に記録する。対象外でもVerified Vulnerabilityは残す。
- 公開資料間で矛盾する場合は `ambiguous` にして人間へ回す。
