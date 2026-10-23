# Wordfence 公開履歴 mirror を段 1 の候補選別に使う範囲（2026-10-23）

## 問いと観測範囲

未検証 Finding の Lab に時間を使う前に、Wordfence の公開履歴から受理傾向を読めるかを確かめた。Git 外の `history.sqlite`（`wordfence-history/v1`）を読み取り専用で開いた。mirror の `state.json` にある最終成功時刻は 2026-10-23 10:10:13 UTC。期間は 2026-04-23 以上、2026-10-24 未満の 6 か月、`informational=0` とした。タイトルと説明の語句を検索し、該当する公開記録の文を個別に確認した。私的 Finding、PoC、payload、HTTP 記録は使っていない。

## 確かめられたこと

| 観測 | 件数・公開例 | 段 1 への含意 |
| --- | --- | --- |
| 期間内の非 informational 記録 | 6,638 件 | これは公開脆弱性の件数で、報奨受理件数ではない。 |
| タイトルが Stored XSS の記録 | 1,732 件。そのうちタイトルに Contributor を含むものが 591 件 | 公開 record には Wordfence の報奨範囲から外れる Contributor+ も含まれる。`informational=0` を報奨受理の印として使えない。 |
| 別利用者の操作後に発火する Stored XSS | 管理者の hover: [CVE-2026-101924](https://www.wordfence.com/threat-intel/vulnerabilities/id/234d79fc-5f00-457d-a693-ad3f6d38447b)（2026-10-13）。コメント承認後: [CVE-2026-97339](https://www.wordfence.com/threat-intel/vulnerabilities/id/3c12e65c-eedf-4fc2-977a-7a07219ee1c2)（2026-10-15） | hover・承認という語だけで self XSS や非現実的前提と決めない。攻撃者が置ける入力、別利用者の通常操作、script 発火を Finding ごとに読む。 |
| 通常機能の設定に依る Stored XSS | 機能の有効化とコメント承認が前提の [CVE-2026-78438](https://www.wordfence.com/threat-intel/vulnerabilities/id/5580ad05-af50-4899-9cbf-39ad8000eb6a)（2026-09-04） | 設定が要ることだけで管理者の誤設定にしない。一般的な機能利用か、安全上重要な既定からの逸脱かを分ける。 |
| タイトルが Race Condition | 4 件。認証回避を主張する [CVE-2026-110653](https://www.wordfence.com/threat-intel/vulnerabilities/id/61fbc1dd-06c9-409b-8cad-3f350b38dfc3)（2026-10-16）を含む | 公開例はあるが、個別 Finding の再現容易性や報奨受理を示さない。Wordfence の「一般的な構成で容易に再現できない競合」を外す文を優先する。 |
| 短い時間窓 | 30 秒以内の管理者閲覧を条件にした [CVE-2026-2374](https://www.wordfence.com/threat-intel/vulnerabilities/id/99dfce3b-2b47-41bf-8b20-b53fb9f061a7)（2026-05-27） | 時間窓があるだけでは自動除外できない。攻撃者が現実に合わせられる条件かを具体的に問う。 |
| タイトルが Cache Poisoning | 3 件。[CVE-2026-79713](https://www.wordfence.com/threat-intel/vulnerabilities/id/4c4d2fd2-84e1-4da8-b969-7715315c2eb9)（2026-09-16）と、別の限定ファイル書込みの影響も記した [CVE-2026-103896](https://www.wordfence.com/threat-intel/vulnerabilities/id/83e672e7-2483-46e9-ae16-a9e7ccc4bcb8)（2026-10-15）を含む | 「cache poisoning」のラベルだけでは実害の大きさが分からない。Wordfence が要するサイトへの重大かつ実演可能な影響を別に示す。 |
| タイトルが Local File Inclusion | 181 件。Subscriber+ の [CVE-2026-54814](https://www.wordfence.com/threat-intel/vulnerabilities/id/06fc92e9-b2c0-46a0-99b2-10cf0d564f7b)（2026-06-17）と Contributor+ の [CVE-2026-57804](https://www.wordfence.com/threat-intel/vulnerabilities/id/03e845c0-5845-4d74-88e6-376c703b6145)（2026-07-02）を含む | 別利用者のブラウザは不要。攻撃者が通常読めないサイト内ファイルを読める、またはファイルを実行できるという最終影響と、攻撃者の役割を分けて読む。 |
| 外部サービスを要する前提 | タイトル・説明の語句検索では「接続済みアカウントが必要」を一貫して抽出できなかった | 件数による採否判断をしない。脆弱な対象がローカルの plugin か、Wordfence が対象外にする vendor 側 web service かを見分け、Lab に接続状態を作れないことは独立の準備事項にする。 |

[Wordfence の現行プログラム](https://www.wordfence.com/threat-intel/bug-bounty-program/)は、Contributor / Author、容易に再現できない競合、重大な影響が示せない cache poisoning、管理者の危険な誤設定等を除外する。同ページの FAQ は対象外報告を現在は受け付けず CVE も割り当てないとする。一方、[規約](https://www.wordfence.com/bug-bounty-program-terms/)の冒頭には種別を問わず CVE を依頼できるとあり、§1.2.14 は CVE 割当てが報奨適格性を保証しないとする。現時点の受付運用はこの二つの記述から一意に推定しない。mirror に報奨結果の欄はなく、公開 CVE は当該 Finding が報奨を得た証拠ではない。

Wordfence 公開記録: Copyright 2012-2026 Defiant Inc. 各 CVE のリンク先に原記録がある。

## 判断への反映

`wbh-screen` v3 は近い公開記録を「比較すべき条件」の手掛かりに限る。直近 6 か月の同種記録が 0 件でも Wordfence 非受理を意味せず、3 件以上でも個々の Finding の受理を意味しない。採用には Finding 自身の具体的な攻撃者位置、通常の前提、種別に応じた最終影響が要る。同じ slug で版・種別・入力面が近い公開修正は mirror の全期間で照合し、重複確定はせず、修正差分で独立性が分かるまで候補を非採用にする。入力面が明確に異なる場合はその事実を注意に残し、slug と種別だけで非採用にしない。採否は技術検証や提出許可に読み替えない。

この一次選別の `review export` には Finding 原票の `existingControls` と `labObservations` が出ない。空欄を「対策なし」「Lab で未観測」と読めない。これらの欄にだけ重要な経路説明がある Finding は、v3 の入力からは保守的に `根拠不足` となり得る。再評価には export 契約の拡張か、レビュー済みの安全な要約が必要である。また現時点の作者・配布状態も export には無い。`target.selectionId` は選定時の暫定 provenance に限り、提出前の公式再確認が要る。近接公開修正の独立性については、別工程で公開修正と固定版の差分を比較し、ID・版・入力面・根拠を記した Private Evidence のメモを名指しで v3 に渡す。screen 自体は source を開かない。

集計の主要条件は次のとおり。各件数は `vulnerabilities` の行数であり、商品数・報奨件数ではない。

```sql
WHERE published >= '2026-04-23'
  AND published < '2026-10-24'
  AND informational = 0
```

各分類は `lower(title) LIKE '%stored cross-site scripting%'`、`'%race condition%'`、`'%cache poisoning%'`、`'%local file inclusion%'` のいずれかを追加した。Contributor の件数は Stored XSS の条件に `lower(title) LIKE '%contributor%'` を追加した。hover、承認、設定、短い時間窓は語句検索の後に個別の説明を読んだもので、網羅的な件数を主張しない。
