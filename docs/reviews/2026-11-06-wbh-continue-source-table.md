# wbh-continue v1 の出典対照表（2026-11-06）

## 対象と結論

新しい操作役 skill `.claude/skills/wbh-continue/SKILL.md` の本文は、次の表にある要素だけで組んだ。要素は足していない。探索エージェント（Root）に渡る文はこの skill には無い。Root に渡るのは、skill が書く焦点メモ（操作役の内容）と、Harness が生成する `## Prior research` 節の 1 文（`docs/reviews/2026-11-06-focus-section.md`）である。

## 出典対照表

| skill の要素 | 出典 |
| --- | --- |
| 「読む側」を操作役が受け持つ。Harness は形だけ見る | ADR 0052（continuation 契約）、LESSONS 15〜19（深さの試みは書く側だけで読む側が無かった）、AGENTS.md「Harness と AI の責務」（内容は AI、形は Harness。所有者決定 2026-10-27） |
| 自動の続きは open route > 0 のときだけ。80 本中 15 本 | ADR 0052、台帳の数（prod-v26d / v26e、2026-11-06 07:35Z 時点の `discovery-run-finished.continuation`） |
| 所有者が判断を AI に委ね、採否は数字で見る | 所有者決定 2026-11-06（「私に判断する力がない。だから AI に任せるしかない」「2 は欲しい」）、DEVELOPMENT.md 第 5 節（数字のない探索変更はマージしない） |
| `campaign trials`、`review leads` の runId 列、`campaign continue --focus` | 同 PR の Harness 変更（ADR 0052 の 2026-11-06 追記） |
| 研究 file の置き場と読む file の限定（REGISTRY.md、recon-map.md、continuation.json） | ADR 0048（Prior research 入力。渡す file の一覧）、SPEC 第 2 節 不変条件 1（route file、traces、tools は渡さない） |
| 固定ソースの読み方（snapshots → sources、読み取り専用） | `.claude/skills/wbh-source-check/SKILL.md`「入力と境界」 |
| 公開記録を読まない、PoC・ペイロードを写さない | SPEC 第 2 節 不変条件 1、ADR 0012（時点で切った公開履歴はカタログ情報のみ）、ADR 0037（mirror は選定の件数と日付にだけ使う） |
| 当てない対象 1（provider-limited / interrupted は再開の役目） | ADR 0036（再開）、ADR 0052 の自動条件の除外 |
| 当てない対象 2（open route > 0 かつ連鎖 3 未満はランナー）、no-progress で止まった連鎖は候補に戻す | ADR 0052（3 回の上限、進捗の規則、`target-skipped continuation-refused`） |
| 当てない対象 3（manual は Snapshot ごとに 1 度） | ADR 0052（4 回目以降は名指し）、本 PR の運用規則（所有者の名指しだけが 2 度目を組む） |
| 当てない対象 5（新版の再訪が予定されている） | ADR 0037 追記 3（版上昇再訪）、`policy/selection.md` |
| 2 つの問い（入力支配、到達性）と攻撃者位置の範囲 | `.claude/skills/wbh-source-check/SKILL.md`「2 つの問い」、SPEC 第 2 節（contributor 以上は trust 境界の内側）、ADR 0038 追記 14 |
| 埋まらない辺（管理者の設定変更、開発者モード、競合、時間窓、ベンダーのデータ） | 所有者決定 2026-10-28（前提の重い群は Lab の前に落とす）、ADR 0038 追記 13（`declared-precondition` の park 理由）、Wordfence 却下記録の分類（docs/reviews の 2026-10-31 却下データ） |
| Lead 数は理由にならない（leads2: Lead 133 群 → Finding 3） | `docs/agents/measurement.md` 5e の対照、ADR 0049 追記 7 |
| 3 経路まで、同じ sink は 1 つにまとめる | ADR 0038 の群（同根の重複は 1 群）、本 PR の運用規則（焦点メモ 8 KiB の上限から） |
| 焦点メモの形（4 要素、8 KiB、Private Evidence に置く、末尾の 1 行） | 本 PR の Harness 変更（8 KiB の検査）、SPEC 第 2 節 不変条件 8（台帳に本文を置かない）、ADR 0048 の「ヒントであり誤りうる」 |
| Root への命令文を書かない | ADR 0039（目的文は変えない。言い換えをしない）、AGENTS.md「探索と検証の中身はプロンプトとスキルが受け持つ」 |
| 同時 2 本まで、空きメモリを見る | memory 2026-10-28（host 64 GB、8 tracers + 1 の実績）、campaign 設定 `resources.memoryBudgetMiB` |
| 進行中の状態は Issue のコメントに書く | AGENTS.md「Agent skills」、`docs/agents/issue-tracker.md` |
| 台帳に直接書かない | SPEC 第 2 節 不変条件 8、wbh-source-check の「この skill は台帳に直接書かない」 |
| 測り方（新規 Finding 群 / Codex 時間、盲目 pass@5 との対照、2 週 20 Snapshot、±2 を分けられない） | `docs/agents/measurement.md` 5e、ADR 0045（分母は Codex 時間）、ADR 0043 追記 8 |
| 消し方 | ADR 0052 の 2026-11-06 追記の消し方 |

## 版の扱い

v1 が初版である。旧版は無い。本文を変えるときは版を上げ、`versions/v1.md` に写しを残す（他の wbh-* skill と同じ）。
