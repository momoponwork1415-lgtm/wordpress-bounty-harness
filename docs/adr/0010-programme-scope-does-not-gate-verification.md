---
status: accepted
---
# プログラム対象範囲は技術的検証を止めず、提出先ごとにreviewで評価する

対象範囲は `review` で提出先ごとに `in-scope` / `out-of-scope` / `ambiguous` として記録し、Verifierと判定器の実行条件にしない。対象外でもVerified Vulnerabilityは残す。方針は `src/profiles/wordpress/policy/programme-scope.md` に観測日付きで置き、提出前に公式ページで再確認する。2026-10-08時点では、Reflected XSSはWordfenceで対象外、IDOR・broken access control・missing authorizationはアカウント乗っ取り・権限昇格・サイト全体への影響に到達する場合だけ提出候補にする。対象範囲の規則は変わるため、方針ファイルで管理しコードに固定しない。
