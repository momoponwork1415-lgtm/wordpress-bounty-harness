# wbh-review v5 の差分（所有者が当てる）

AI セッションは `.claude/skills/` の本文を編集できない（自己改変として止まる）ため、ADR 0040 追記 3 に合わせた skill の差分をここに置く。当て方は本文の末尾。

## 変える行

1. 見出し `# wbh-review v4` → `# wbh-review v5`。同じ段落の「旧版の v1〜v3 は `versions/` に残す」→「旧版の v1〜v4 は `versions/` に残す」。
2. 手順 14 の末尾近くの 1 文「AI はこの 2 つの記録を代行しない（OPERATIONS 第 3 節）。」を次に置き換える。

   > 所有者が会話の中で結果と通常の公開サイトの申告を明言し、自分の画面画像を渡したときは、AI 操作役がその画像を `--evidence` にして所有者の名前で 2 つの記録を代行する。代行の前に、所有者の発言の原文、時刻、会話の識別子、画像の digest を Private Evidence の `manual-observation-attestations/<Finding>-<画像の digest>.json` に書く。AI が自分で Lab を見た結果は記録しない（OPERATIONS 第 3 節、ADR 0040 追記 3）。

3. 出力の注意書きの 1 行「人間の `review observe`、`review decide --reproduced`、`--prepared-by human` の文案、最終の `accept`、`review authorize` は代行しない。」を次に置き換える。

   > `--prepared-by human` の文案、最終の `accept`、`review authorize` は代行しない。`review observe` と `review decide --reproduced` は、所有者の会話内の明言と画面画像があるときだけ代行する。

4. 変更前の本文を `.claude/skills/wbh-review/versions/v4.md` に写す。

## 当て方

リポジトリの root で次を順に実行する。

```bash
cp .claude/skills/wbh-review/SKILL.md .claude/skills/wbh-review/versions/v4.md
```

```bash
sed -i -e 's/^# wbh-review v4$/# wbh-review v5/' -e 's/旧版の v1〜v3 は `versions\/` に残す。/旧版の v1〜v4 は `versions\/` に残す。/' .claude/skills/wbh-review/SKILL.md
```

```bash
sed -i 's/AI はこの 2 つの記録を代行しない（OPERATIONS 第 3 節）。/所有者が会話の中で結果と通常の公開サイトの申告を明言し、自分の画面画像を渡したときは、AI 操作役がその画像を `--evidence` にして所有者の名前で 2 つの記録を代行する。代行の前に、所有者の発言の原文、時刻、会話の識別子、画像の digest を Private Evidence の `manual-observation-attestations\/<Finding>-<画像の digest>.json` に書く。AI が自分で Lab を見た結果は記録しない（OPERATIONS 第 3 節、ADR 0040 追記 3）。/' .claude/skills/wbh-review/SKILL.md
```

```bash
sed -i 's/   - 人間の `review observe`、`review decide --reproduced`、`--prepared-by human` の文案、最終の `accept`、`review authorize` は代行しない。/   - `--prepared-by human` の文案、最終の `accept`、`review authorize` は代行しない。`review observe` と `review decide --reproduced` は、所有者の会話内の明言と画面画像があるときだけ代行する。/' .claude/skills/wbh-review/SKILL.md
```

当てた後は `git diff --stat` で 2 file（SKILL.md と versions/v4.md）だけが変わっていることを確かめ、不変条件 3 の PR と同じ branch か別 PR で出す。
