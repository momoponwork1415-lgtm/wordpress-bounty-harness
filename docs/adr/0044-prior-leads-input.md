---
status: accepted
date: 2026-10-31
amends: 0029（対象ごとに 1 回の Trial、自動の追加 Trial はしない）、0012（探索へ渡す入力の範囲）
---

# 自分たちの過去 Trial の Lead を、名指しした第 2 Trial の入力にする（#715）

## 背景

探索は Trial あたり 4〜5 件の Lead を出す（2026-10-31 の本番 30 Trial で 134 件、腕を伏せた 5 項目判定で 84 / 97 が通過）が、Lead を Finding まで詰める段がどこにも無い。探索の中では「残りの隙間」として書かれて終わり、探索の外では人間が一覧を読むだけである（[構造調査](../reviews/2026-10-31-exploration-structure-investigation.md)）。所有者は 2026-10-31 に、停止条件の見直し（#714）と並べて「両方ともやろう」と決めた。設計案は [docs/reviews/2026-10-31-lead-input-trial-design.md](../reviews/2026-10-31-lead-input-trial-design.md) にある。

不変条件 1（SPEC 第 2 節）は探索へ渡してよい入力を列挙していて、自分たちの過去 Trial の出力は入っていなかった。自分の出力を戻すだけで公開記録の答えではないが、列挙に無いものは渡せないので、この ADR で例外を足す。

## 決定

- campaign 設定で名指ししたときに限り、同じ Target Snapshot に対する自分たちの過去 Trial の Lead（群の代表）を、Harness が生成する `## Prior leads` 節で渡してよい。
- 節に入れるのは、固定 source の file と関数の名前と、その Lead が書いた「示せなかったこと」の一文だけである。`labObservations`、storage の key、payload、URL、HTTP の要求、公開記録の答え（advisory 本文、原因箇所、修正差分）、PoC は渡さない。隙間の文は Lead の summary の先頭 1 文を形の検査（長さ、URL、HTTP の method と path、長い引用、`<` `>` を含まない）に通し、通らなければ `(withheld)` にする。出力契約 v4 に項目は足さない（契約 v5 で Finding が崩れた経緯、ADR 0038 追記 15）。
- 群は「入口の file と関数」と「効果の file と関数」の両方が一致する Lead と Finding をまとめる（`scripts/lead-groups.mjs` の `pair`）。代表は群で最初に記録された Lead。
- 第 2 Trial は ADR 0029 の「対象ごとに 1 回」の例外だが、自動の追加 Trial ではなく、pass@k の重ね掛けでもない。入力が違う Trial で、名指しでだけ走る。台帳では `configuration.priorLeads` の有無で分け、v14-wide、v18-wide、v19-wide の Trial と同じ比較の分母に混ぜない。同じ Snapshot に同じ代表の組で 2 回目は走らせない。
- 第 2 Trial には使い捨ての探索 Lab を付ける（`discovery.lab: attached`、既存の reset / observe の仕組み、ADR 0041 系）。判定器は置かない。確定は従来どおり人間の観測である（不変条件 3）。
- 渡してよい Lead は、それを出した Trial の入力が不変条件 1 の範囲にあったものに限る。v8 以降の Trial は満たす。ADR 0012 の時点カタログを受けた旧 Trial の Lead は渡さない。評価 run では、held-out の公開日以降に始まった Trial の Lead を渡さない。
- 制限時間と子の上限は第 1 Trial と同じ値を使う。Lab 付きの同時実行は 2 本から始め、メモリの実測で増やす。

## 理由

Lead は「筋はよいが 1 歩足りない」ルートで、同じ固定ソースを読み直せば詰められる可能性が高い。入力として渡すのは場所と隙間の文だけなので、探索へ答えを渡すことにはならず、公開記録とも無関係である。Lab を付けるのは、到達性を agent 自身が確かめる場を与えるためで、判定は人間に残す。

## 採らなかった選択肢

- 同じ版・同じ入力で Trial を重ねる（pass@k）: 所有者は 2026-10-31 に「同じ版は 1 回」と決めた。
- Lead の本文をそのまま渡す: payload や URL が混ざるので、名前と一文に絞る。
- 出力契約に「隙間」の項目を足す: 契約の変更は Finding の数を崩した前例がある。
- 第 1 Trial に Lab を付ける: 16 分で閉じる段階では使われない。

## 帰結

- SPEC 第 2 節の不変条件 1 と AGENTS.md の要約に例外を 1 文足した。ADR 0029 の「対象ごとに 1 回」はこの ADR で例外を持つ。
- 実装は別 PR で行う（campaign 設定、節の生成、`configuration.priorLeads` の記録、Lab 付きの起動）。節の雛形は agent に渡る文章なので、その PR は全文と日本語訳を貼って `owner-approved` を付ける。
- 計測: Lead の群が 1 つ以上ある対象 20 件で第 2 Trial を回し、「Finding になった Lead の群の数 / 入力した群の数」と、段 1b を通った Finding の数を出す。Lab なしとの比較は次の問いにする。

## 消し方

実装の PR を revert する（`discovery.priorLeads` のブロック、節の生成関数、`configuration.priorLeads` の書き込み）。この ADR と SPEC / AGENTS.md の例外の文を消す。台帳の既存 event は消さない。
