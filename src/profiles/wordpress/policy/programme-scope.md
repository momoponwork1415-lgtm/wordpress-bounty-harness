# プログラム対象範囲の方針

観測日: 2026-10-08。提出前に各プログラムの公式ページで再確認し、観測日と差分をこのファイルへ追記する。既知脆弱性の答えは書かない。

## Wordfence

- 公式: https://www.wordfence.com/threat-intel/bug-bounty-program/ 。本文の写しは [wordfence-scope-2026-10-08.md](wordfence-scope-2026-10-08.md)（2026-10-08、判断者がブラウザで取得。Harnessからは自動取得できない）。
- 攻撃者の権限: 未認証、またはsubscriber / customer相当だけ。PR:H（administrator、editor、shop manager、`unfiltered_html` を持つrole）と中間権限（contributor、author、管理者が付与するrole）を要するものは対象外。
- 分類と閾値（判断者は1337 tier）:
  - High Threat（≥25件。25〜999件はWordPress.org掲載が条件）: 任意PHPファイルのupload / read / delete、任意options更新、RCE、管理者への認証回避、管理者への権限昇格。
  - Common and Dangerous（≥500件。500〜999件はWordPress.org掲載が条件。premiumは1,000件未満を除外）: Stored XSS、SQLi。
  - その他（1337 tierで≥500件）: 任意コンテンツ削除、任意ファイルのdownload / read / delete、LFI / RFI、directory traversal、非管理者への権限昇格 / 認証回避、機微情報の漏えい、gadget付きPHP object injection、開発者が仕込んだbackdoor。
- 対象外の資産: WordPress core、Automattic、Facebook、Google、SiteGround、Yoastの製品。提出時点で配布停止のplugin / theme。ローカルで動かないベンダー側のweb service。`selection` の除外リストに入れる。
- 明示的に対象外の種別: Reflected XSS、CSRF、Missing Authorization、IDOR、任意shortcode実行、DoS、限定的なfile upload、基本的な情報露出、gadgetなしPHP object injection、open redirect、SSRF、race condition依存、cache poisoning、API keyの更新 / 読み取り、非公開 / 下書き投稿の閲覧、業務ロジックの欠陥、過度なbrute force依存、管理者が明示的に権限を与える前提のもの。
- Missing Authorization / IDORは種別としては対象外だが、同じ欠陥が「任意options更新」「任意コンテンツ削除」「権限昇格」「認証回避」「機微情報の漏えい」に到達すれば、その到達先の種別として対象になる。scope評価では到達先で分類する（判断者の方針と一致）。
- 判定器と Lab 構成に効く却下条件: `wp_magic_quotes` 無効が前提のSQLiは不可（Labは既定設定のまま）。SVG upload経由のXSS、二重拡張子、安全な拡張子内のPHPコードは不可（file upload系はExecution Canaryの実行で証明する）。nonceで守られていて低権限に露出しないactionのmissing authorizationは不可。管理者の誤設定が前提のものは不可（Labの設定は既定または一般的な利用範囲に限る）。
- 提出前に公式ページで再確認し、差分があれば新しい日付の写しを置く。

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
