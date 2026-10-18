# v8 r2 の公開記録照合（2026-10-18）

## 範囲と判定

Brizy 2.8.11、Simply Schedule Appointments（SSA）1.6.10.0、Relevanssi 4.28.3 の r2 Trial を、公開済みの記録と照合した。件数は r2 台帳の集計値で、重複候補を含む。公開記録との一致は候補と記録の照合結果であり、Lab による実行時確認を意味しない。候補本文と証拠はこの公開リポジトリへ転記しない。

| 対象 | r2 の状態 | Finding / Lead | 公開記録との照合 |
| --- | --- | ---: | --- |
| Brizy 2.8.11 | provider 拒否で `incomplete` | 3 / 0 | [CVE-2026-5324](https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-plugins/brizy/brizy-page-builder-2811-unauthenticated-stored-cross-site-scripting-via-fileupload-field-value) と同系統の source 候補が3件。重複を含み、実行時確認は未実施。 |
| SSA 1.6.10.0 | provider 拒否で `incomplete` | 2 / 1 | 基準記録 [CVE-2026-3658](https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-plugins/simply-schedule-appointments/appointment-booking-calendar-16100-unauthenticated-sql-injection-via-fields-parameter) と一致する Finding は0件。別の公開記録との厳密な一致は未判定。 |
| Relevanssi 4.28.3 | 完了 | 0 / 5 | [CVE-2026-97641](https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-plugins/relevanssi/relevanssi-4283-unauthenticated-stored-cross-site-scripting-via-comment-content) の経路の一部に触れる Lead が1件あるが、Finding は0件。再発見成功には数えない。 |

## 公開側の基準

- Brizy の [Wordfence 記録](https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-plugins/brizy/brizy-page-builder-2811-unauthenticated-stored-cross-site-scripting-via-fileupload-field-value)は CVE-2026-5324 を2026-05-01公開、影響版を2.8.11以前、修正版を2.8.12とする。
- SSA の基準 [Wordfence 記録](https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-plugins/simply-schedule-appointments/appointment-booking-calendar-16100-unauthenticated-sql-injection-via-fields-parameter)は CVE-2026-3658 を2026-03-18公開、影響版を1.6.10.0以前、修正版を1.6.10.2とする。別の公開 XSS 記録として、[WPScan の CVE-2026-13400](https://wpscan.com/vulnerability/501b2929-3216-4587-8124-088fd51becf1/)は2026-07-06公開・1.6.12.4修正、[Patchstack の CVE-2026-65513](https://patchstack.com/database/wordpress/plugin/simply-schedule-appointments/vulnerability/wordpress-simply-schedule-appointments-plugin-1-6-12-10-cross-site-scripting-xss-vulnerability)は2026-07-28公開・1.6.12.11修正と記す。いずれも公表上の影響範囲に1.6.10.0を含むが、r2候補をこれらの CVE に帰属させる証拠としては扱わない。
- Relevanssi の [Wordfence 記録](https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-plugins/relevanssi/relevanssi-4283-unauthenticated-stored-cross-site-scripting-via-comment-content)は CVE-2026-97641 を2026-10-01公開、影響版を4.28.3以前、修正版を4.28.4とする。成立には抜粋に許可するタグの設定条件がある。

3対象の r2 に実行時確認済み Finding はない。後続の r3 source-only Trial は独立した測定であり、この r2 の件数には加算しない。確定した集計は [v8・5対象の評価](../evaluation/2026-10-19-v8-five-target-rediscovery.md) に記録した。
