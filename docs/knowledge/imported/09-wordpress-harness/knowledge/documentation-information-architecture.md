<!-- provenance: /home/dev/wordpress-harness/docs/knowledge/documentation-information-architecture.md, mtime 2026-10-08, imported 2026-10-13, generation 09-wordpress-harness -->

# 調査資料: 文書の情報設計

状態: 一次資料に基づく調査、2026-09-05

## 結論

このrepositoryはDiátaxisをfolder構成として導入しない。Diátaxis自身も空の4分類を先に作る方法を求めていない（[Diátaxis as a guide to work](https://diataxis.fr/how-to-use-diataxis/)）。既存の文書ごとに役割を一つへ絞り、入口から必要な詳細へ段階的に移動できる構成にする。

## 採用ルール

1. **入口は案内だけにする。** root `README.md`はQuickstartと少数の入口、`docs/README.md`は目的別のReading pathだけを持つ。読者へ全資料の通読を求めない。Diátaxisも短いprimerから必要時に詳細へ進む使い方を推奨している（[Start here](https://diataxis.fr/start-here/)）。
2. **一つの文書に一つの読者目的を割り当てる。** Diátaxisはtask、learning、reference、explanationを混ぜると文書上の問題になるとする（[Start here](https://diataxis.fr/start-here/)）。このrepositoryでは下表の役割を混ぜない。
3. **概要から詳細へzoomする。** ArchitectureはContextとModuleの関係までを示し、詳細はCodebase GuideのModule節へ送る。C4はaudienceごとにzoom levelを選び、価値のないlevelは作らなくてよいとする（[Diagrams](https://c4model.com/diagrams)）。arc42も詳細化を重要・意外・高risk・複雑・変化しやすい要素へ限定する（[Building Block View](https://docs.arc42.org/section-5/)）。
4. **同種の情報は固定templateと表で書く。** Module節は `Purpose / Interface / Invariants / Failures / Tests` の順にする。arc42はblack boxをPurposeとInterface中心の表で短く記述する方法を示している（[Tip 5-7](https://docs.arc42.org/tips/5-7/)）。
5. **結論と識別語を先に置く。** 見出しは短く具体的にし、段落・箇条書きは主題語から始める。長い説明より表、短い段落、箇条書きを優先する。Write the Docsは、既知または不要な箇所を飛ばせる構造と、この書き方を推奨している（[Documentation principles: Skimmable](https://www.writethedocs.org/guide/writing/docs-principles/#skimmable)）。
6. **同じ事実を複製しない。** Module仕様と実装状態はCodebase Guide、理由はADR、根拠資料はKnowledgeを正本とし、他からはlinkする。Write the Docsはsource間のscopeを明確かつ非重複にし、並行保守を避けるとしている（[Documentation principles: Unique](https://www.writethedocs.org/guide/writing/docs-principles/#unique)）。Diátaxisもreferenceへ説明を混ぜず別文書へlinkする（[Reference](https://diataxis.fr/reference/)）。
7. **図は関係か動きを明確にするときだけ使う。** 静的な関係は少数のzoom level、動きは代表的なruntime scenarioだけにする。arc42は網羅よりarchitecture上重要なscenarioの代表例を推奨する（[Runtime View](https://docs.arc42.org/section-6/)）。図にはtypeとscopeを含むtitle、短い要素説明、方向と意図が分かるlabelを付ける（[C4 Notation](https://c4model.com/diagrams/notation)）。
8. **現在性のない文章は残さない。** 誤った文書は欠落より悪く、実装と文書を一緒に更新する必要がある（[Documentation principles: Current](https://www.writethedocs.org/guide/writing/docs-principles/#current)）。完了計画や旧snapshotは削除し、必要ならGit履歴を使う。

## 文書の役割

| 文書 | 答える質問 | 内容 |
| --- | --- | --- |
| root `README.md` | 何で、どう始めるか | mission、Quickstart、入口 |
| `docs/README.md` | 次に何を読むか | 目的別Reading path |
| `CODEBASE-GUIDE.md` | Moduleの契約と現在地は何か | Purpose、Interface、invariant、failure、status、source、Test |
| `ARCHITECTURE.md` | 全体はどう分かれ、どう流れるか | Context、Module、主要flow、boundary |
| ADR | なぜこの判断か | 前提、判断、結果、状態 |
| 調査資料 | 何を調べ、何が分かったか | 問い、証拠、設計への含意 |

Architecture Decisionは重要・高cost・大規模・高riskな判断と理由に限定し、本文との重複を避ける。arc42も重要な判断だけをADRとして保持し、Context、Decision、Status、Consequencesで記録する（[Architecture Decisions](https://docs.arc42.org/section-9/)）。

## 編集時の判定

各節を次の順で判定する。

1. この文書の「答える質問」に直接答えるか。答えなければ正本へ移すか削除する。
2. 別文書にも同じ事実があるか。正本だけを残してlinkへ置き換える。
3. 概要で十分か。Module契約はCodebase Guide、理由はADR、根拠はKnowledgeへ送る。
4. proseより表または箇条書きの方が速く比較できるか。できるなら置き換える。
5. 図が文章より関係または時間順を明確にするか。しないなら作らない。

この判定は、referenceを簡潔かつ一定のpatternで機械の構造に沿わせるDiátaxisの原則（[Reference](https://diataxis.fr/reference/)）と、抽象化して概要を保つarc42のBuilding Block View（[Building Block View](https://docs.arc42.org/section-5/)）をこのrepository向けに具体化したものである。
