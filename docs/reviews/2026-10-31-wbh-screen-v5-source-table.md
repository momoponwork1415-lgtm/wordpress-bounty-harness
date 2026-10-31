# wbh-screen v5 の出典対照表（2026-10-31）

`wbh-screen` v5（段 1、ADR 0038 追記 16）の各項目を、出典に対応させる。出典は、所有者が受け取った Wordfence の決定の ticket 番号（本文は Git 外）、規則の写し（`src/profiles/wordpress/policy/wordfence-scope-2026-10-21.md`）の節、所有者決定の日付のどれかである。Finding の本文、対象の名前、経路は書かない。

| v5 の項目 | 理由コード | 出典 |
| --- | --- | --- |
| 2 値判定（`要検証` / `除外`） | — | 所有者決定 2026-10-31「確度下げは中途半端」 |
| 対象範囲 | `policy-out-of-scope` | 規則の写し: 対象資産・役割・影響種別、明示除外。v4.2 から継続 |
| 本体依存 | `core-dependency` | Wordfence 決定 481208、480992（対象外、CVE のみ）。所有者決定 2026-10-31「プラグイン単体で到達するか」 |
| 外部サービス入力 | `external-not-writable` | Wordfence 決定 480975（対象外）。受理側の先例は所有者の受理済み記録 1 件と公開記録 1 件（同じ対象の旧版） |
| 通常利用の範囲 | `contrived-usage` | Wordfence 決定 469807（却下）と同じ対象の受理 469822 の差。所有者決定 2026-10-31「通常利用について調べるステップを入れる」 |
| 連鎖の脆さ | `chain-fragile` | 規則の写し: Common False Positive（競合、実害の無い cache poisoning）。所有者決定 2026-10-28「重い前提の群は Lab の前に落とす」。ミラー検索 2026-10-23: 開発者モード / 競合 / キャッシュ依存の受理 0 件 |
| 一時的な導入・移行スクリプト | `installer-transient` | Wordfence 決定 465341、465346（意図した振る舞い） |
| 報奨にならない格付け | `cve-only-grade` | Wordfence 決定 465255（ロジックの不具合）、所有者決定 2026-10-31「乗っ取りにつながらない読み取りは対象外かもしれない」。規則の写し: 影響種別 |
| 同根の提出 | `same-root-ticket` | 所有者の提出記録（Git 外、2026-10-28 時点で 8 件）と 469807 |
| 明らかに公開済み | `public-duplicate` | 所有者決定 2026-10-31「内部キューの重複は提出する。明らかに公開済みは提出しない」。Wordfence 決定の重複通知 29 件 |
| 最新版での修正 | `patched-in-latest` | Wordfence 決定 480896（提出 2 日後の新版で修正、却下）。464463、466336、463936（提出時に Snapshot が旧版） |
| 報告単位 | — | 所有者決定 2026-10-31「根本原因が重複するものは 1 件にまとめる」 |
| 人間向けは HTML / Artifact | — | 所有者決定 2026-10-31「CLI は使っていない」 |

Wordfence 決定の記録は `~/.local/state/wordpress-bounty-harness-evaluation/wordfence-rejections-2026-10-31.json`（48 件）にあり、Git には入れない。
