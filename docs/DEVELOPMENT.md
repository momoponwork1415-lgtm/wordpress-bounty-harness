# 開発の流れ

対象読者: このリポジトリの所有者と、依頼を受けて変更する AI。設計の正本は [SPEC.md](SPEC.md) と [ADR](adr/)。この文書は「何を作るか」ではなく「どう進めるか」を決める。

## 1. 目標

- 報奨で月 1,000 ドル以上（所有者、2026-10-10）。SPEC 第1節の KPI（$250 以上を月 2.5 件）は月 625 ドル相当で、目標より低い。KPI は目標に合わせて改訂する。
- 所有者の換算: アクティブインストール 30〜40 万規模の対象で、ATO を月 1 件、または Stored XSS を月 4 件、または SQLi を月 2 件程度。インストール数が小さい対象ほど必要な件数が増える。選定方針のインストール下限と High Threat の重みは、この換算から決める。
- いまの優先: 開発セット TranslatePress 3.2.5 の公開済み 3 件のうち 1 件を、探索 run が自力で出す。これが出るまで、探索と検証以外の機能は増やさない。

## 2. 現在地（2026-10-10）

- 2026-10-08 から 10-09 の 2 日間で 87 本の PR が merge された。探索は Trial 化、WordPress core の固定、読み取り専用 DB、保存先索引の分担、Lead 継続、prompt v2 まで入っている。
- 開発セットの A/B（#73）は prompt × 継続の 4 cell すべてで source 候補 0/3。実 wall time は上限 90 分より短く終わった。
- 未使用モジュール（wordfence-intelligence、patchstack-programme、file-assignment-v1）は別 PR で削除する。

## 3. 単位は「問い 1 つ」

- 1 週間に答える問いを 1 つ決め、GitHub Issue に「問い」と「答えが分かる数字」を書く。例: 「`gpt-6-luna` は 90 分のうち何分使うか。prompt を変えると変わるか」「答えは台帳の run wall 中央値と `observed.filesRead`」。
- PR はその Issue を参照する。問いに関係ない変更は別の問いにする。
- 問いが決まっていない間は、PR を作らない。報告（第4節）だけを依頼する。

## 4. AI への依頼は 2 種類

| 種類 | 成果物 | 置き場 | 所有者がすること |
| --- | --- | --- | --- |
| 調べて報告 | 事実、選択肢、推奨、未確認の仮定を分けた文書 | [docs/reviews/](reviews/) に日付付き | 読んで決める。決めるまで変更は依頼しない |
| 変更して PR | 問い 1 つに答える PR | GitHub PR | テンプレートの 5 項目を読んで merge する |

報告を読まずに変更を依頼しない。変更の依頼には、報告のどの選択肢を採るかを書く。

## 5. PR の規則

- テンプレートの 5 項目（問い、変えたこと、変えなかったこと、測った数字、消し方）を日本語で埋める。AI が書いてよいが、所有者が分からない行があれば merge しない。書き直しを依頼する。
- 探索に触る PR は、開発セットで最低 3 Trial 回した結果を貼る: Trial 数、completed 数、Finding と Lead の数、wall の中央値、失敗理由の内訳。数字のない探索変更は merge しない。
- 実験軸（分担、継続、prompt 変種など）は opt-in の設定ブロック 1 つと profile の file 1 つに閉じ、台帳の run 記録に軸を残す。消し方を PR に書く。
- 1 PR は差分 500 行以内を目安にする。超えるなら問いを分ける。
- CI の `pnpm check` が通る。

## 6. 正本の改訂

- SPEC や ADR と実態が食い違ったら、コードより先に ADR 1 本で改訂する。未コミットの変更を溜めない。
- 大きな設計変更（判定器の方式、探索の構造）は、報告 → 所有者の決定 → ADR → PR の順。ADR のない大きな変更は merge しない。

## 7. 週末に見る数字

```bash
node dist/cli/main.js ledger funnel --campaign <id>
```

```bash
node dist/cli/main.js ledger usage --campaign <id>
```

```bash
node dist/cli/main.js eval score --campaign <id> --keys <Git外の鍵> --case <case id>
```

見るのは、Trial 数と completed 率、Finding と Lead の数、source 候補の数、run wall の中央値、失敗理由の内訳、token の合計。当たりが 0 のまま wall 中央値が上限より十分短ければ、次の問いは「なぜ早く終わるか」になる。
