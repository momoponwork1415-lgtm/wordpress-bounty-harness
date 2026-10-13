# 教訓（過去 4 世代の harness から）

毎回読む短い版。出典と長い分析は [docs/reviews/2026-10-13-past-repos-lessons.md](reviews/2026-10-13-past-repos-lessons.md)。新しい設計案が出たら、まずここに反していないかを見る。

1. **選別は prompt ではなく出力側の gate で行う。** 100 行の prompt は Lab あたり Lead 1.1、65 行は 12.4（whitebox、2026-08）。prompt で絞ると候補が消え、gate で絞ると候補が残る。
2. **prompt は膨らむ。上限をテストで固定する。** 13.7 KB → 6.9 KB → 7.4 KB（wordpress-harness、2026-09）。長さから品質は推定できない。
3. **時間をかけても成果は増えない。** 報酬が出た Lab は 2.1 時間、5 時間超は全部成果なし（whitebox）。wall を広げる前に、Root が自主停止している理由を見る。
4. **判断の要らない処理は skill にしない。判断が仕事の処理はコードにしない。** 選定はコード、検証の解釈と文案は fresh session（whitebox commit 6f2738d、wpb README「Boundary」）。
5. **人間に見えない成果は無いのと同じ。** 再現済み 30 件と候補 12 件が放置された（wpb）。Lead 6 件が未検証で止まった（whitebox）。候補は 1 画面で、30 秒で捨てられる形で届ける。
6. **scope 外は探索の直後に落とす。** Lead の 58% が scope 外で、全文を読まないと分からなかった（wpb）。受理時の allowlist は 9 月版にあった（wordpress-harness `candidateAdmission`）。報酬が出た 8 月版（whitebox `bounded-wp2shell/v1.7`）は本文で accepted / dropped class を列挙していた。
7. **ADR は実測が矛盾を示したときだけ。** 144 本のうち初日 108 本、3 日目に 92 本削除（wordpress-harness）。30 本 / 5 日で主経路 2 往復（本 repo、2026-10）。
8. **先回りで作らない。** 先のフェーズ向け 7,300 行が 3 回目の廃棄の理由（wpb ADR 0007）。同じ手動作業を 3 回してから道具にする。
9. **量を増やしても報酬は増えない。** Snapshot 483、選定 110、提出 1（wpb）。選定と検証を厚くし、探索は触らない（barbell）。
10. **見込み薄の候補は捨てずに grade 付きで残す。kill も 2 度確認する。** 偽陰性は報酬を失う（whitebox commit 58775b8、所有者 2026-10-13）。
11. **払われない分類は追わない。** Programme Boundary 外の効果は Lead に落とし、Finding に数えない。
12. **AI に prompt を任せると要素が増える。** 出典に無い要素は入れない。採否は所有者が対照表で決める（所有者、2026-10-13）。
