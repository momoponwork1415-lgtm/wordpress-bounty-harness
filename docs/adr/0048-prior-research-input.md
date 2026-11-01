---
status: accepted
date: 2026-11-01
amends: 0012（探索へ渡す入力の範囲）、0044（自分の過去 Trial の出力を渡す例外の 2 つ目）
---

# 自分の過去 Trial の研究 file を、同じ対象の後の Trial に渡す（開発計画 §2.5）

## 背景

探索スキル（ADR 0043）は Trial ごとに `/workspace/research` に file を書く。`wbh-recon` が書く plugin の地図 `recon-map.md`、`wbh-tools` が保存する hook と sink の一覧 `tools/*.tsv`、`wbh-setup` が書く Lab の通常利用の記録 `lab-setup.md` である。Harness は Trial の終わりにこの directory を封じて Private Evidence に置き、台帳の `discovery-run-finished.researchArtifact` が digest で参照する。封じた file は再開（ADR 0036）で同じ Trial に戻るだけで、同じ plugin の次の Trial には渡らない。

本番台帳（2026-11-01 時点、読み取り専用で集計）では、研究 file を封じた Root run は v19-wide で 20 / 176、全体で約 950 ある。`recon-map.md` は 6〜16 KB（1 件だけ 98 KB）、`tools/hooks.tsv` は 4〜51 KB、`tools/sinks.tsv` は 3〜129 KB で、WooCommerce を依存に持つ対象では tsv が 400〜580 KB になる。探索した 574 対象のうち 168 は別の版で 2 回以上探索している。版が上がるたびに同じ地図を 1 から書き直している。

所有者は 2026-11-01 の開発計画（docs/reviews/2026-11-01-development-plan.md §2.5）で「plugin ごとの事実の DB（S6 → S3 の再利用）」を承認し、同日夜に「全部提案どおりで進めて」と決めた。渡す単位と版が上がったときの扱いは、計画の時点では未決だった。

不変条件 1（SPEC 第 2 節）は探索へ渡してよい入力を列挙し、ADR 0044 が自分の過去 Trial の Lead を名指しで渡す例外を足した。研究 file も自分の出力で、固定 source から作った派生物であり、公開記録の答えでも PoC でもない。列挙に無いものは渡せないので、この ADR で 2 つ目の例外を足す。

## 決定

- campaign 設定の `discovery.priorResearch` を `same-target` にしたときに限り、同じ対象（`targetId`）の別の Snapshot に対する自分たちの最新の過去 Trial が封じた研究 file のうち、`recon-map.md` と `lab-setup.md` の 2 つを、Harness が生成する `## Prior research` 節で渡してよい。既定は `none` で、何も渡さない。
- 渡す file は 2 つに限る。`tools/*.tsv` は `wbh-tools` が固定 source から毎回決定的に作り直せる（token 0、数分）ので渡さない。sink ごとの route file（`<sink>.md`、`REGISTRY.md`、`MERGED.md` など）は仮説と「示せなかったこと」の文を含み、ADR 0044 が名指しの第 2 Trial に限った Lead の文と同じ性質なので渡さない。
- file は丸ごと渡すか、渡さないかのどちらかで、切らない。1 file 64 KiB まで、完全（封じたときに切れていない）で、UTF-8 として読めるものだけを渡す。どちらも渡せなければ節を置かず、台帳に理由 `no-files` を残す。
- file は sandbox の `/workspace/research/prior/<名前>` に置く。この Trial 自身の file は従来どおり `/workspace/research` 直下に書かれる。再開区間（ADR 0036）は封じた archive を復元するので、`prior/` の file もそれで戻る。Harness は再開時に file を置き直さず、節だけを同じ元 run から作り直して digest を照合する。
- 節に書くのは、元 Trial が読んだ版、この Trial が読む版、置いた file の名前と場所と大きさだけである。何を試すかは書かない（ADR 0019 の生成節の型）。節の雛形は agent に渡る文章なので `owner-approved` を要し、全文と日本語訳を docs/reviews/2026-11-01-prior-research-section.md に置く。
- 渡してよい file は、それを封じた Trial の入力が不変条件 1 の範囲にあったものに限る。ADR 0044 と同じ判定（公開履歴カタログを受けていない、`wp2shell-bounty` の v8 以降）を使う。同じ Snapshot に対する Trial は「過去 Trial」に数えない（同じ版をもう一度回さないという ADR 0029 と、2026-10-31 の所有者決定に従う）。
- 台帳の `discovery-run-started.configuration.priorResearch` に、元 run の id、元 Snapshot の digest、元の版、file の名前・digest・大きさ、節の digest を残す。有効なのに渡せなかった Trial には理由（`no-earlier-trial` / `no-files`）を残す。ADR 0045 の分母（Codex 1 時間あたりの Lab 発火数）で比べるとき、`priorResearch` の有無で Trial を分けられる。
- **版が上がったときの扱い。** 節は「file は前の版を記述していて、この版で変わった部分は違いうる」と述べるにとどめる。2 つの Snapshot の間で変わった file の列挙は、#724 の差分監視（PR 3）が同じ Snapshot manifest から作るので、ここでは作らない。差分監視が入ったら、その一覧をこの節の隣に置く。

## 理由

地図と通常利用の記録は、同じ plugin の次の Trial で最初に作り直すものであり、固定 source から作った派生物なので、渡しても探索に答えを渡すことにならない。route file を渡さないのは、ADR 0044 が Lead の文を名指しの Trial に限った理由と同じで、仮説の文は探索の向きを決めてしまうからである。tsv を渡さないのは、作り直しが安く、版が変われば古い一覧は誤りになるからである。丸ごとか無しかにするのは、切った地図は欠けた場所を「無い」と読ませるからである。

## 採らなかった選択肢

- 研究 directory を丸ごと渡す: route file と WooCommerce の tsv（最大 580 KB）が混ざる。
- 探索 Lab の `lab-setup.md` だけを渡す: 本番の第 1 Trial には Lab が無いので、渡るものがほぼ無い。
- 設定を置かず常に渡す: 入力を変える Trial を台帳で分けられなくなる。設定と台帳の記録で分ける（AGENTS.md「実験の軸は外せる形で」）。
- スキルに「`prior/` があれば読め」と書く: スキル本文の変更は別の問いである。この PR は Harness が file を置き、節で場所を述べるところまでとし、スキル側の 1 文は数字を見てから決める。

## 帰結

- SPEC 第 2 節の不変条件 1 と AGENTS.md の要約に、この例外を 1 文足す。SPEC 第 6 節に `discovery.priorResearch` の 1 項を足す。OPERATIONS に設定の説明を足す。
- 実装は同じ PR で行う（設定、解決、節の生成、sandbox への配置、台帳の記録、再開時の照合）。
- 計測: 本番で `same-target` を有効にした後、版が上がって再訪した対象について、`priorResearch` あり / なしの Trial を ADR 0045 の分母で比べる。節の有無だけが違う対の比較はしない（所有者 2026-10-31「同じ版は 1 回」）。

## 消し方

`discovery.priorResearch`、`src/discovery/prior-research.ts`、`src/cli/wordpress-prior-research.ts`、transport の `priorResearch`、sandbox の `prior/` の配置を revert する。台帳の `configuration.priorResearch` は読み続ける。この ADR と SPEC / AGENTS.md の例外の文を消す。
