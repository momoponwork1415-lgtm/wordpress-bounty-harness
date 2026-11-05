---
status: accepted
date: 2026-11-05
amends: 0045（目的文の凍結の限定例外）、0050（探索方式の主従）
---

# 7 月 30 日方式を一つの目的文として本番で試す

所有者は 2026-11-05 に、TranslatePress 3.2.6 の元 run の `DISCOVERY.md` を出発点に、探索を一つの目的文へ任せる比較実験を決めた。8 月 1 日版の SQLi / Stored XSS への時間配分は持ち込まない。元 run は途中で「最初の候補で止めない」という追加入力を受けたため、その継続も新版の本文で明記する。

新しい版付き候補は、固定 source、trust / Programme Boundary、Harness が生成する出力契約、既存の gVisor Lab に合わせる。Root が仮説、子の割り当て、反証、次に読む経路を決める。具体的な実行時の問いがある場合だけ探索 Lab を使い、観測を記録する。対象固有の答えや固定の脆弱性類型は与えない。Cloudflare 派生の `wbh-audit-v2` 六段階と `wbh-lab-v1` の全 open 行への実行指示は同じ Trial に重ねず、別方式として保持する。旧 trust-boundary-v1 に残る退役済みの independent judge / canary の文は原本を変えず、既に v25 用に版を分けた、人間の観測を正しく述べる trust-boundary-v2 を v26 にも渡す。再開では Trial 開始時に記録した版を使う。新しい実行エンジン、候補受理契約、選定規則、検証器は作らない。

この目的文に限り、「固定版に少なくとも 1 件の報告可能な脆弱性がある」を探索努力の**作業仮定**として与える。これは脆弱性の存在・成立・新規性の証拠ではない。根拠のない Finding / Lead を作らず、支持できる候補が 0 件なら 0 件と報告する。この限定例外は ADR 0045 の目的文凍結と AGENTS.md の従来の禁止を改めるが、SPEC の不変条件 1〜8 と、人間の Lab 観測だけが確定の根拠である規則は維持する。

最初の実験は、旧版を残した新目的文と opt-in の Lab 付き campaign 設定による**独立 Trial 1 回**である。既定の v22-wide、本番ランナー、自動後続の規則は変えない。生成済みの v4 出力契約と `direct/v1` を使う。独立反証は目的文による指示であり、この比較では機械的な昇格 gate ではない。研究 file に次の調査を記録するが、この版では自動継続の起動条件としては読まない。

同一 Snapshot の条件付き 2・3 回目、4 回目以降の手動起動、同一 Snapshot と版をまたぐ研究・Finding・Lead の構造化再利用は、今回の Trial の結果を見て受け渡し契約を別に定める。新しい保存基盤を先に作らない。

採否は同じ選定帯で旧版と新版を Lab 条件を揃えて交互に走らせ、DEVELOPMENT.md 第 5 節の本番計測で決める。[agent に渡る全文と日本語訳](../reviews/2026-11-05-july30-single-prompt-ja.md)、[元の `DISCOVERY.md`](../knowledge/imported/08-whitebox/DISCOVERY-2026-07-30-translatepress-original-run.md) と digest、今回の差分を残す。戻すときは新規 Trial の prompt ID を旧版へ戻し、記録済みの Trial と Private Evidence は読み続ける。
