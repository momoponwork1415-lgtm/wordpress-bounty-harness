# `## Lab` 節に足した 1 文（staging 済みの `wbh-lab` を名指す）の本文・日本語訳・出典対照表（2026-11-02）

[Issue #793](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/793)、[ADR 0049](../adr/0049-lab-resident-exploration.md) の 2026-11-02 追記 6、[ADR 0043](../adr/0043-exploration-skills-in-the-sandbox.md) の 2026-11-02 追記 9。

Harness が生成する `## Lab` 節（`src/cli/wordpress.ts` の `wordPressLabSection`）に、staging するスキルのうち front matter の `name` が `wbh-lab` のものがあるときだけ、次の 1 文を独立の段落として足す。位置は Trace 段落の直後、結びの「The Harness records …」段落の前。`wbh-lab` を staging しない Trial の節は従来と byte 単位で同じである。

## 事実

本番 campaign `prod-v21-20261102-4`（目的文 v22-wide、スキル recon-v3 + tools-v1 + setup-v1 + wbh-lab-v1、Lab 付き）の終了した 5 Root の diagnostic で、`skills/wbh-recon/SKILL.md`、`skills/wbh-setup/SKILL.md`、`skills/wbh-tools/SKILL.md` はそれぞれ 4 回以上読まれ、`skills/wbh-lab/SKILL.md` は 0 回。`lab-facts.md` を書いた Trial は 0、lookups は 0〜2 / Trial。目的文は先の 3 つを名前で指し、`wbh-lab` を名指す文は無かった。

## 本文（英語、生成される byte そのもの）

```text
The installed skill wbh-lab describes when to use Find, Query, Trace and Observe from the research files and how to record each answer; read it before the first of these commands.
```

## 日本語訳

インストール済みのスキル wbh-lab は、研究 file から Find、Query、Trace、Observe をいつ使うか、答えをどう記録するかを書いている。最初の命令の前に読むこと。

## 出典対照表

要素は出典にあるものだけで、足していない。足したのは、installed であるスキルの名前を言うことだけである。

| 要素 | 出典 |
| --- | --- |
| `wbh-lab` が読まれない、という事実 | `prod-v21-20261102-4` の 5 Root の diagnostic: `skills/wbh-lab/SKILL.md` 0 回、他の 3 スキルは各 4 回以上。`lab-facts.md` 0 件、lookups 0〜2 / Trial |
| 「The installed skill wbh-lab」 | registry `src/profiles/wordpress/prompts/skills.ts` の `wbh-lab-v1`（name `wbh-lab`）。staging 先は CLI の skills ディレクトリ（ADR 0043） |
| 「when to use Find, Query, Trace and Observe」 | `## Lab` 節の Find / Query / Trace / Observe の 4 段落（命令の名前はそのまま）。ADR 0043 追記 7「Find / Query / Trace / Observe をどの行に、どの順で使い」 |
| 「from the research files」 | ADR 0043 追記 7（open の行、歩きの行、Store / Transformation 行を取って問いにする）。wbh-lab v1 の Inputs 節（recon-map.md、lab-setup.md、walks、assumptions） |
| 「how to record each answer」 | ADR 0043 追記 7「答えをどこに書き」、wbh-lab v1 手順 6（lab-facts.md と行の下に Lab 行） |
| 「read it before the first of these commands」 | wbh-lab v1 の Inputs 節「read that section before the first command」を、節からスキルへ向きを変えて言ったもの。他の 3 スキルを目的文が「Read wbh-recon …」と指しているのと同じ形 |
| 位置（Trace 段落の後、結びの前） | `## Lab` 節の既存の並び: Reset → Observe → Find → Query → Trace → 結び。4 命令を全部述べた直後に置く |

## 書かなかったもの（規則どおり）

- どの行に、どの順で使うか。それはスキル本文（ADR 0043 追記 7）が持つ。
- 使う回数や目標。予算は命令の段落が述べる。
- 対象固有の関数名、オプション名、URL、画面名。
