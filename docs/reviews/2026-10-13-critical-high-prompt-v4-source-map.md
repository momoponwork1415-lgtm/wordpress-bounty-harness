# WP2Shell bounty v4 探索目的文の出典対照と日本語訳

日付: 2026-10-13。探索 agent に渡す正本は [`wp2shell-bounty-v4.md`](../../src/profiles/wordpress/prompts/wp2shell-bounty-v4.md)。この文書は owner review 用の対照表で、探索には渡さない。目的文 digest は `sha256:6c823fe2ddb8a9af27ea743927f5d4a8203ec29ef4bca7dbadf3135c1739ab62`。旧 v3 は byte 不変の `sha256:a97b4b3c1101470cec743dd51af1d2169f15d4d5ee1a2797997be05edef72c9b`。

## 英語原文の全文

> # WordPress discovery: WP2Shell bounty v4
>
> Investigate the pinned target source and disposable Lab from first principles. Find complete security failures reachable by an `unauthenticated`, `subscriber`, or `customer` attacker in an ordinary WordPress deployment. A vulnerability is not assumed. The supplied trust boundary and Programme Boundary define the allowed attacker position and programme scope; contributor and higher roles and administrator-chosen permissions are trusted. The defect must be attributable to the target, although pinned WordPress or required dependency source may complete a chain.
>
> The Finding targets are these Critical examples for an unauthenticated attacker: arbitrary file deletion; arbitrary file read; arbitrary file upload leading to remote code execution; remote code execution; privilege escalation; SQL injection; stored XSS; missing authorization causing critical data alteration or read; and authentication bypass to administrator. The Finding targets are these High examples for a subscriber or customer attacker: remote code execution; arbitrary file upload leading to remote code execution; arbitrary file deletion; arbitrary file read; privilege escalation to administrator; SQL injection; stored XSS; and missing authorization causing critical data alteration or read. These examples assume no extra exploit prerequisites, such as special settings or active user interaction beyond the ordinary feature flow. Report a Finding only for a complete route to one of these effects. Keep concrete unresolved chains as Leads with their exact gaps. An impact label alone, including `options-update` or `sensitive-object-access`, does not establish critical data alteration or read; trace the complete effect and its prerequisites. Do not turn a partial or weaker effect into a matching Finding merely to fill the report.
>
> As Root, start three subagents with genuinely different questions grounded in the assigned source. Choose the questions from the target's actual entry points, data flows, state transitions, and interactions; do not give them preset vulnerability types or tell them all the currently favored route. Investigate cross-file and cross-feature chains yourself. Keep a private registry of approach families, their source evidence, contrary evidence, blocked routes, and unresolved questions. When agents converge on one family, redirect the next wave toward a different source-grounded family. Keep independent approaches alive long enough to test their real strengths and gaps.
>
> After each wave, synthesize the children's evidence, challenge promising routes, and choose another wave when a concrete question remains. Do not stop because the first wave found nothing. For each proposed chain, test attacker control, reachability, capability and nonce checks, transformations, persistence, the later consumer, ordinary configuration, and the behavior of pinned dependencies where relevant. Combine partial routes only when every connecting edge has source or Lab support. A missing required dependency or Lab setup is an unresolved precondition, not evidence that the route is safe.
>
> Run at least two distinct waves, including a wave on a different approach family after the first complete priority Finding. Work on new source-grounded questions between waves. You may finish when the Lab is unusable, the provider interrupts, or the externally enforced run limit is reached. Otherwise, stop when two consecutive waves add no new approach family, material evidence, or concrete unresolved question. Report the strongest surviving Lead and exact gap rather than implying the target is secure.

## 日本語訳の全文

> # WordPress 探索: WP2Shell bounty v4
>
> 固定された対象 source と使い捨て Lab を第一原理から調べよ。通常の WordPress 配備で、`unauthenticated`（未認証）、`subscriber`（購読者）、`customer`（顧客）の攻撃者が到達できる、完成した security failure を見つけよ。脆弱性があるとは前提しない。渡された trust boundary と Programme Boundary が、許される攻撃者位置とプログラムの対象範囲を定める。contributor 以上の役割と、管理者が選んで付与した権限は信頼側にある。欠陥は対象に帰属しなければならないが、固定された WordPress 本体や必要な依存の source が連鎖を完成させてもよい。
>
> Finding の対象は、未認証の攻撃者について次の Critical の例とする: 任意のファイル削除、任意のファイル読み取り、remote code execution につながる任意のファイル upload、remote code execution、権限昇格、SQL injection、stored XSS、認可欠落による重大なデータ改変または読み取り、管理者への認証 bypass。Finding の対象は、購読者または顧客の攻撃者について次の High の例とする: remote code execution、remote code execution につながる任意のファイル upload、任意のファイル削除、任意のファイル読み取り、管理者への権限昇格、SQL injection、stored XSS、認可欠落による重大なデータ改変または読み取り。これらの例は、特別な設定や通常の機能の流れを超えた能動的なユーザー操作など、追加の悪用前提を要しないことを想定する。いずれかの影響に至る完成した経路だけを Finding として報告せよ。具体的だが未解決の連鎖は、正確な欠落を示した Lead として残せ。`options-update` や `sensitive-object-access` を含む impact ラベルだけでは、重大なデータ改変または読み取りは成立しない。完成した影響とその前提条件をたどれ。報告を埋めるために部分的または弱い影響を対象例に見せかけた Finding にしないこと。
>
> Root として、割り当てられた source に根拠を持つ、本当に異なる 3 つの問いで 3 人の subagent を始めよ。問いは対象の実際の入口、データの流れ、状態遷移、相互作用から選ぶ。あらかじめ決めた脆弱性の種類を与えたり、いま有望に見える経路を全員に伝えたりしないこと。file や機能をまたぐ連鎖は自分で調べよ。approach family（取り組みの系統）、その source 上の根拠、反する証拠、行き止まりの経路、未解決の問いを、自分用の registry に持て。agent が 1 つの family に収束したら、次の波は別の source に根拠のある family へ向け直せ。独立した取り組みは、その本当の強みと穴が分かるまで十分長く生かしておけ。
>
> 各波の後、子の証拠を統合し、有望な経路を疑い、具体的な問いが残っていれば次の波を選べ。第 1 波が何も見つけなかったからといって止めないこと。提案された各連鎖について、攻撃者の制御、到達可能性、capability と nonce の検査、変換、永続化、後続の消費者、通常の設定、関係する場合は固定された依存の挙動を検証せよ。部分的な経路は、つなぐ辺のすべてに source か Lab の裏付けがあるときだけ結合せよ。必要な依存や Lab の準備が無いことは未解決の前提条件であり、その経路が安全だという証拠ではない。
>
> 少なくとも 2 つの異なる波を走らせよ。最初の優先 Finding が完成した後に、別の approach family に関する波を含めること。波の間は、source に根拠のある新しい問いに取り組め。Lab が使えなくなった、provider が中断した、外部から課された実行上限に達した、のいずれかなら終えてよい。それ以外では、2 波連続で新しい approach family も、重要な証拠も、具体的な未解決の問いも増えなかったときに止めよ。対象が安全だと示唆するのではなく、生き残った最も強い Lead と、その正確な欠落を報告せよ。

## 出典対照表

| v4 要素 | 出典 | 対照 |
| --- | --- | --- |
| 固定 source、使い捨て Lab、低権限の位置、trust 境界、対象への帰属 | 旧 [`wp2shell-bounty-v3.md`](../../src/profiles/wordpress/prompts/wp2shell-bounty-v3.md) 第 1 段落。SPEC 第 2、6 節 | v3 の目的と trust 境界を継承。Programme Boundary が「優先順位」を定めるという旧表現だけ、優先順位を owner 指定のリストに合わせて「programme scope」に変更 |
| Critical 9 例、High 8 例と攻撃者位置 | 所有者が本会話で提示した 2 リスト、および [Wordfence Bug Bounty Program の Critical / High Severity Examples](https://www.wordfence.com/threat-intel/bug-bounty-program/) | 全 17 例を効果と攻撃者位置の組み合わせとして Finding の対象にした。公式ページは CVSS 単独での判定を否定し、例に例外の可能性を認めるため、prompt は severity の自動確定を指示しない |
| 追加の悪用前提を要しない | 同じ [Wordfence 公式ページ](https://www.wordfence.com/threat-intel/bug-bounty-program/) の例の前提、および所有者の今回の Critical / High 指定 | 特別な設定や通常の機能の流れを超えた能動的な操作を例に挙げた。stored XSS の通常の閲覧を機械的に除外せず、実際の影響や前提を source / Lab で確かめる |
| `options-update` と `sensitive-object-access` のラベルだけでは十分でない | 所有者が本会話で「2 分類を一律に外す」から「Critical／High に当たる場合は対象にする」へ訂正した判断 | 分類名による一律排除も一律採用も指示せず、重大な実害の完成を要する |
| 対象の完成した効果だけを Finding、具体的だが未解決の連鎖を Lead とする | 所有者が本会話で Critical / High の例を「対象の脆弱性」と指定。[SPEC](../SPEC.md) 第 6 節の Finding / Lead 区別 | 弱い効果のラベル付けによる水増しを避ける。出力境界での正規化・保留は従来の契約に従う |
| 部分的 primitive を Finding にしない、3 子の協調、波、検証の問い、停止条件、Lead | 旧 [`wp2shell-bounty-v3.md`](../../src/profiles/wordpress/prompts/wp2shell-bounty-v3.md) 第 2〜5 段落 | 優先効果の段落以外は v3 と同じ。旧 v3 本文と digest は保持 |
| Finding / Lead の schema、出力形式 | [ADR 0019](../adr/0019-harness-generated-output-contract.md)、`wordpress-discovery-contract-v2` | 本文へ転記せず Harness が生成する契約を従来どおり付ける |

この対象リストは owner の探索優先事項であり、公式の全報奨対象を列挙するものではない。Wordfence の公式例は、対象 plugin / theme の active installations が 50,000 以上であることも条件としている。既定の機械選定下限は別規則で 100,000。
