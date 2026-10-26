# #608 skill と OPERATIONS の古い参照 4 点の出典対照表（2026-10-27）

## 対象と結論

wbh-destination v3、wbh-screen v4.2、`docs/OPERATIONS.md` 第 3 節の表 6 行目の 4 点を、現行の記述に揃えた。要素は足していない。旧版は各 skill の `versions/` に残した（wbh-destination は `v2.md`、wbh-screen は `v4.1.md`）。この文書は正本ではない。

## 出典対照表

| 変えた箇所 | 前 | 後 | 出典 |
| --- | --- | --- | --- |
| wbh-destination の「wbh-report v2」3 か所（8・104・133 行） | wbh-report v2 | wbh-report v8 | `.claude/skills/wbh-report/SKILL.md` の見出し `# wbh-report v8` |
| wbh-screen 37 行 | 名指しした人間が新しい review Lab で記録した | 名指しした人間が保持された検証 Lab か新しい review Lab で記録した | ADR 0038 追記 12（観測の場所、#600） |
| OPERATIONS 第 3 節の表 6 行目 | 所有者を `lab up --for-review` に送る | `verify next --handoff` が残した検証 Lab が先で、残っていなければ `lab up --for-review` の新しい review Lab | ADR 0038 追記 12、同じ文書の第 3 節の review 表（`incomplete(awaiting-human-observation)` の行）の記述 |
| wbh-destination の `review scope` の括弧書き | runtime-confirmed か reproduced の Finding だけに打てる | 判定器の `runtime-confirmed` か `reproduced`、または人間の観測 `match` と `--reproduced match` がある `incomplete(awaiting-human-observation)` の Finding だけに打てる | `src/review/submission-basis.ts` の `BasisUse` の `scope` と `submissionBasis` の判定、ADR 0040 |

## 版の扱い

- wbh-destination は v2 から v3 にした。メモの先頭行の固定文字列も `wbh-destination v3` に揃えた。この文字列を読む src や test は無い（grep で確認した）。
- wbh-screen は v4.1 から v4.2 にした。Finding ごとのメモの名前 `screen-<campaign>-<Finding>-v4.md` は変えていない。
- `grep -rn "wbh-report v2" .claude/skills` は、旧版の保存先（`wbh-destination/versions/v1.md`、`wbh-dedupe/versions/`、`wbh-report/versions/v2.md`）には残る。旧版は上書きしない決まりなので、`SKILL.md` に 0 件であることで受け入れを見る。
