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
13. **harness を作っている間は報酬が止まる。** 2026-07-25〜08-11 の 18 日で有償 9 件、08-12〜10-13 の 2 か月で有償 3 件、09-02 以降は提出 0（所有者の Wordfence 履歴、2026-10-13）。開発の期日を切り、本番周回を止めない。
14. **AI と harness の責務が曖昧だと、harness が中身を抱え込む。** 探索の舵取り（索引、分担、coverage）と検証の手順（Verifier 指示の連鎖、scenario 選択）を code にした世代は肥大して捨てた（wpb の先回り 7,300 行、wordpress-harness v1〜v9、本 repo の 2026-10-11〜18 の索引・dispatch・coverage）。harness は制御だけ、中身は prompt と skill（AGENTS.md「Harness と AI の責務」、所有者 2026-10-18）。
15. **止める条件を文で書かない。続ける条件を形で書く。** 「網羅したら止める」「残 0 で止める」は Root がそう書けば満たせる（bench30 v1 は 48/48 が「残 0」と書き、観測した被覆は hooks 0.71 / sinks 0.38。v6 coverage、v13〜v14 の「消化」、v19〜v21 の行数も同じ）。「未解決経路が残っていれば次を組む」は、書いても得がなく、空配列なら終わるだけである。harness が握れるのは時間、回数、形だけで、質は握れない（docs/reviews/2026-11-06-continuation-what-failed-and-how-to-implement.md）。
16. **書く側を作ったら、読む側を同時に作る。** coverage record、priorLeads、priorResearch、continuation.json は、どれも Root に「残り」を書かせる仕組みで、次の Trial がそれを読む契約が無かった。読む義務の無い入力は読まれない（Lab arm の要求 0、wbh-lab の読み込み 0）。渡すなら、生成節に「これが最初の作業」と書き、解消したかを形で記録させる。公開 harness で同じ対象を続けられるものは全部、対象ごとの状態台帳を次の run の最初に読み直す（Cloudflare `coverage-ledger.json`、Mantis `.mantis_state.json`）。
17. **交絡した計測は、無かったのと同じ。** pass@3 は契約 v5 と子 8 の下で走り、leads2 は Lab の効果と入力の効果を分けられない設計だった。どちらも結論を出せず、数字の無いまま採否が決まった。1 本の PR で変える軸は 1 つ、分母は Codex 時間に固定し、1 つの変更に最低 20 対象分の本番を当ててから次を決める（followUp は 3 日、六段階は Trial 0 件、区画分配は数字を待たずに廃止）。
18. **prompt の文面を改善指標にしない。** v16〜v22 の文の変更は Finding と Lead の境目を動かしただけで、本物の率（段 1b 通過 / Trial）は 0.05〜0.07 から動かなかった。同じ prompt を 2 回回しただけで 0.2〜0.8 F/Trial の幅が出る。測れるのは運転条件（帯、effort、子、Lab）と状態の形（未解決経路の件数と解消率、2 回目以降の新規 Finding 群 / Codex 時間）である。prompt は固定し、消す方向にだけ触る（ADR 0045）。
19. **再開の仕組みを目的文の形に縛らない。** 再開が「最後の段落の接頭辞」に依存していたため、v19-wide は全 Trial が skip した（ADR 0039 追記 17）。再開は digest と台帳の記録にだけ結ぶ。
