# プログラム対象範囲の方針

観測日: 2026-10-08。提出前に各プログラムの公式ページで再確認し、観測日と差分をこのファイルへ追記する。既知脆弱性の答えは書かない。

## 機械判定パラメータ（v1）

このブロックは下の人間向け方針と同時に更新する。`requiredObservations` は Harness 判定器が観測した条件だけで満たし、不明なら `ambiguous` とする。

```json scope-policy-v1
{
  "observedAt": "2026-10-08",
  "programmes": ["wordfence", "patchstack"],
  "wordfence": {
    "highThreatMinimum": 25,
    "commonMinimum": 500,
    "otherMinimum": 500,
    "wordpressOrgRequiredBelow": 1000,
    "premiumMinimum": 1000,
    "highThreat": ["rce", "php-file-write", "arbitrary-php-file-read", "arbitrary-php-file-delete", "options-update", "privesc-to-admin", "auth-bypass-to-admin", "account-takeover"],
    "common": ["stored-xss", "sqli"],
    "excluded": ["reflected-xss", "csrf-to-write", "missing-authz", "idor", "other"],
    "requiredObservations": {
      "rce": ["execution-canary"], "php-file-write": ["execution-canary"],
      "arbitrary-php-file-read": ["canary-file-read"], "arbitrary-php-file-delete": ["canary-file-deleted"],
      "options-update": ["option-canary-changed"], "stored-xss": ["javascript-executed", "site-wide"],
      "sqli": ["canary-row-access"], "content-deletion": ["other-content-deleted"],
      "sensitive-object-access": ["sensitive-canary-access"],
      "arbitrary-file-read": ["canary-file-read"], "arbitrary-file-delete": ["canary-file-deleted"],
      "arbitrary-file-download": ["canary-file-read"], "lfi": ["canary-file-read"], "rfi": ["canary-file-read"],
      "privesc-to-admin": ["admin-capability-reached"], "auth-bypass-to-admin": ["admin-session-reached"],
      "account-takeover": ["admin-session-reached"],
      "privesc-to-contributor+": ["contributor-capability-reached"],
      "auth-bypass-non-admin": ["other-session-reached"]
    }
  },
  "patchstack": {
    "minimumInstalls": 100,
    "cvssGateBelow": 1000,
    "cvssMinimumBelowGate": 8.5,
    "excluded": ["missing-authz", "idor", "other"],
    "requiredObservations": {
      "rce": ["execution-canary"], "php-file-write": ["execution-canary", "path-extension-control"],
      "arbitrary-php-file-read": ["canary-file-read", "path-extension-control"],
      "arbitrary-php-file-delete": ["canary-file-deleted", "path-extension-control"],
      "arbitrary-file-read": ["canary-file-read", "path-extension-control"],
      "arbitrary-file-delete": ["canary-file-deleted", "path-extension-control"],
      "arbitrary-file-download": ["canary-file-read", "path-extension-control"],
      "lfi": ["canary-file-read", "path-extension-control"], "rfi": ["canary-file-read", "path-extension-control"],
      "sqli": ["canary-row-access"], "options-update": ["significant-option-changed"],
      "privesc-to-admin": ["admin-capability-reached"], "privesc-to-contributor+": ["contributor-capability-reached"],
      "auth-bypass-to-admin": ["admin-session-reached"], "auth-bypass-non-admin": ["contributor-capability-reached"],
      "account-takeover": ["other-session-reached"], "sensitive-object-access": ["sensitive-canary-access"],
      "stored-xss": ["javascript-executed", "site-wide"],
      "reflected-xss": ["javascript-executed", "nonce-free"],
      "csrf-to-write": ["accepted-write-chained"],
      "content-deletion": ["other-content-deleted", "significant-impact"]
    }
  }
}
```

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

- 公式: 報告フォームの対象範囲（2026-06-01改定）の写しは [patchstack-scope-2026-10-08.md](patchstack-scope-2026-10-08.md)（2026-10-08、判断者がブラウザで取得）。詳細規則は https://patchstack.com/articles/bug-bounty-guidelines-rules/ （2026年版）。
- 受理条件: 次のどれか1つ。(a) guideline 22.4を満たすzero-day（最新安定版、既定設定、動くexploit、未認証 / subscriber / customerでのサイト全体の侵害）、(b) 下の受理種別で条件を満たす、(c) mVDP対象ソフトで実害を示す（mVDPではcontributorも対象。XPは付かないことがある）。
- 攻撃者の権限: 未認証、subscriber、customer、同等のcustom roleだけ。contributor以上と、subscriberより多い権限のcustom roleは不受理。倍率は未認証x2、subscriber / customer x1、contributor（mVDPのみ）x0.75。
- 受理種別と条件: SQLi。任意ファイルupload / delete / download（pathと拡張子の両方を完全に制御）。RCE。PHP object injection。任意設定変更（サイトに重大な影響を持つoption）。権限昇格（contributor以上へ到達）。LFI / RFI（pathと拡張子を完全に制御）。broken access control（API key / secret、password hash、backup / SQLファイルなど機微な対象）。IDOR（重大な影響。PIIだけ、添付 / ticket / event / order / appointmentはmVDPのみ）。CSRF（上の書き込み系に連鎖する場合）。XSS（サイト全体に効くstored、またはJS実行を伴うreflected。contributor級stored、HTMLのみ、nonce付きreflectedは不可）。DoS（サイト全体のcrash / deface）。
- 不受理: 機微でない情報露出・列挙・full path disclosure、race condition、blind SSRF、open redirect、CRLF、XXE（影響なし）、CSV injection、clickjacking、AC:H、2FA bypass、rate limit欠如、contributor未満への登録、multi-step CSRF、admin notice dismissal、非arbitraryなLFI / upload、`.phtml` などlegacy拡張子、価格改ざん / 決済回避（mVDPのみ）、サイト全体に効かないstored XSS（mVDPのみ）、高権限者の明示設定が前提、pluginのPermissions UIで管理者が権限を付与する前提、WordPress core由来、既定機能の範囲内。
- 件数: 1,000件未満はCVSS 8.5以上のときだけ。100件未満は常に不受理。倍率は件数帯でx0.5（1K）〜x10（5M）、WordPress coreはx20。
- 提出要件のうちHarnessに効くもの: 最新版に対して検証済みであること（提出直前に最新版でLab再検証する）。PoCは遠隔攻撃者の視点の手順（HTTPリクエスト、画面画像または動画）で、WP-CLIなどサーバー側だけの手順は不可（再現パッケージの手動手順とPythonスクリプトはこの形式に合わせる）。同種の複数発見は1報告に統合。pro版の問題をfree版に報告しない。
- 管理画面だけで発火するStored XSSは出さない（旧リポジトリIssue 200の決定を引き継ぐ。Patchstackの「サイト全体に効く」条件とも一致）。

## 判定の規則

- 探索の攻撃者位置は未認証とsubscriberに限る。trust境界宣言ではcontributor以上を信頼する側に置く（両プログラムで報奨に届かないため）。判定器はcontributor以上の経路も技術的に確認できるが、探索の目的には含めない。
- Reflected XSSはWordfenceでは対象外、PatchstackではJS実行を伴いnonceを要しない場合だけ対象。Reflected XSSの候補はPatchstack向けにだけscope評価する。
- CSRFはWordfenceでは対象外、Patchstackでは受理種別の書き込み系に連鎖する場合だけ対象。
- 両プログラムとも「最新版で成立すること」「既定設定または一般的な利用範囲で成立すること」を要する。提出直前に最新版のsnapshotで再検証し、設定前提を再現パッケージに明記する。
- `runtime-confirmed` と対象範囲は別に記録する。対象外でもVerified Vulnerabilityは残す。
- 公開資料間で矛盾する場合は `ambiguous` にして人間へ回す。
