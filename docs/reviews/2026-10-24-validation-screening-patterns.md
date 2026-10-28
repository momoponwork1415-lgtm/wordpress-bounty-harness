# 公開ハーネスの候補選別と検証の分担（2026-10-24）

## 問いと結論

探索が出した候補を、実行検証より前にどこまで落とすべきか。調べた公開例に共通するのは、**候補の形式や明らかな誤りの点検、独立した脆弱性検証、実運用での成立条件、重複、最終報告を別の判断として扱う**ことだった。ただし、全例が同じ順序や証明基準を採るわけではない。脆弱性の存在をソースで確認する方式と、実行して攻撃成功を確認する方式も分かれる。

Wordfence 向けの本ハーネスでは、検証前の段 1 で落とす範囲を、プログラムの明文と信頼できる材料から**明白に対象外と判定できるもの**に限るのが妥当である。競合、短い時間窓、任意機能の有効化、被害者への影響など、実際の再現や通常構成を見ないと決まらない条件は、Lab 後に判定する。これは公開例からの設計上の推論であり、各製品の仕様そのものではない。

## 一次資料による比較

| 公開例 | 前段の選別 | 独立検証・実行再現 | 検証後の判断と不確実な候補 |
| --- | --- | --- | --- |
| [Cloudflare VDH / VVS](https://blog.cloudflare.com/build-your-own-vulnerability-harness/) | Hunter に攻撃者と越える境界を先に記述させる。VDH の Validate は通常コードで schema、参照パス、テスト・patch の構文を確認し、別の Validator が主張を反証しに行く。 | 「確認済み」には未変更の元コードで動く PoC テストを要求する。PoC が動かないものは確認済みとして review に送らない。一方、同記事の集計は、もっと再現が必要な plausible な候補を `Needs repro` として反証済み候補と別に数える。 | VVS で重複をまとめた後、`Judgment` が deployment、設定、最新版のソースを調べ、現に実運用で悪用できるもの、実在するが潜在的なもの、担当 repo が違うものを分ける。つまり構成・本番到達性の判断は VDH の独立検証の後にもある。[工程と証明](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)、[集計上の区別](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)。 |
| [Anthropic Defending Code の `/triage`](https://github.com/anthropics/defending-code-reference-harness/blob/main/docs/triage.md) | 既存 pipeline や他 scanner の raw Finding を受ける。各主張をソースと照合して存在しないものを落とす。開始時に trust boundary、threat model、score、precision と recall の選好を設定できる。 | ここでの Verify は**読取専用のソース検証**で、コードを実行しない。重複は「片方の修正で両方閉じるか」を基準に、安い候補抽出と意味的判断でまとめる。 | 前提と信頼境界をもとに severity を付け直し、担当先へ回す。文書は分割票を precision 側へ寄せる既定を記すが、動的再現に失敗した候補の状態は定義していない。これを本ハーネスの `runtime-confirmed` と同等に扱うことはできない。 |
| [XBOW の結果分類](https://docs.xbow.com/console/guidance/interpreting-results/) | 公開文書は raw 候補の内部選別や重複処理の順序を説明していない。 | 実資産への攻撃を走らせ、`Validated` は成功した exploit、再現手順、証拠、trace を伴う。 | 確実に exploit できなかった潜在的問題や珍しい構成は `Informational` と別に示す。「未実証」を確認済みと呼ばない一方、公開結果の分類には残す。Wordfence の報奨対象内という意味は含まない。 |
| [Visa VVAH 1.5](https://github.com/visa/visa-vulnerability-agentic-harness) | S0 で source / sink の seed を拾う。S1 前に AI の自動除外調査があり、弱点別 playbook に報告前の hard gate がある。 | S5 はディスク上のコードと Finding を照合し、S6 は各候補を敵対的に検証して CVSS を付ける。これは基本的にソース上の判断。別機能の [Exploit Verification](https://github.com/visa/visa-vulnerability-agentic-harness/blob/main/docs/features.md) は使い捨てローカル API への任意の live HTTP 確認で、HTTP endpoint に対応しない静的候補も保持する。到達できない経路には別途 drop / warn / abort の設定があるため、すべての実行失敗を自動的に保持する設計とは言えない。 | S7 で重複を統合し、S8 で順位付け、S9 で報告書・SARIF・JSON を作る。Finding は人間の確認を要する triage 候補。S11 の `Validate` は**修正パッチの確認**であり、S6 の Finding 検証や任意の live Exploit Verification と別物である。[README の工程表](https://github.com/visa/visa-vulnerability-agentic-harness)、[機能説明](https://github.com/visa/visa-vulnerability-agentic-harness/blob/main/docs/features.md)。 |

Cloudflare は review に送る条件として実行可能 PoC を強く求めるが、反証済みと `Needs repro` の集計は分ける。Anthropic はソースだけで偽候補を落とす。XBOW は exploit 成功の有無を結果分類で分ける。Visa は静的検証と任意の live 確認を分ける。したがって、これらをまとめて「どの既存ハーネスも検証前にはほぼ落とさない」とは言えない。一方、**未知の再現可能性を明白な不採用の証拠に変えない**という区別には直接参考になる。[Cloudflare](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)、[Anthropic](https://github.com/anthropics/defending-code-reference-harness/blob/main/docs/triage.md)、[XBOW](https://docs.xbow.com/console/guidance/interpreting-results/)、[Visa](https://github.com/visa/visa-vulnerability-agentic-harness)。

## Wordfence の基準をどこで使うか

[Wordfence の公開 scope](https://www.wordfence.com/threat-intel/bug-bounty-program/)には、攻撃者に必要な権限、対象外の種別、理論上の問題、管理者の危険な誤設定など明文の除外がある。一方、競合は「**一般的な構成で容易に再現できない**」場合、キャッシュ汚染は「**相当かつ実証できる security impact がない**」場合に除外するという条件付きの書き方である。前提の名称だけではこの条件を満たすか決まらない。公開規則に一律の「100% 再現」条件や短い時間窓の一律除外は見当たらない。

[Wordfence の Terms](https://www.wordfence.com/bug-bounty-program-terms/)は、報奨には対象範囲と検証が必要で、確認に足る詳細を欠く報告は差し戻され得ること、同じ脆弱性の先着提出や以前の公開脆弱性と同じコード基盤が報奨に影響することを定める。また AI による報告は提出者自身の手動検証を要求する。したがって「脆弱性が実在する」「Wordfence の対象範囲に入る」「既報と異なる」「報告証拠が揃い、人間が確認した」を別々に管理する必要がある。公開 mirror に似た受理例が 0 件という事実だけでは、上記の条件付き除外の充足も、同じコード基盤の重複も証明できない。

## 現行ハーネスとの対応

正本の [SPEC 第 2・3 節](../SPEC.md)は Finding と Snapshot を固定し、使い捨て gVisor Lab で再現し、Harness 所有の nonce canary 判定器だけが `runtime-confirmed` を出す。環境、前提、観測、証拠の不足は `incomplete` で、反証 (`contradicted`) とは別にする。技術的な実行検証と提出先 scope は異なる。[ADR 0038](../adr/0038-verification-phases-and-submission-flow.md)は「段 1 screen → 段 2 group → 段 3 Lab → 段 4 dedupe → 段 5 提出先 → 段 6 report → 人間の手動再現・査読・承認」という順序を採る。この分担は上の公開例におおむね対応する。

問題は**段 1 の判定材料と強さ**である。本作業 checkout にある [`wbh-screen` v2.2](../../.claude/skills/wbh-screen/SKILL.md)は旧版で、`origin/main` の最新版は v3.1（2026-10-24 に `git show origin/main:.claude/skills/wbh-screen/SKILL.md` で確認）である。v3.1 は公開 mirror の先例 0 件だけで落とす規則を廃止し、`非採用` を技術的否定や台帳の `reject` と区別する。この修正は妥当である。しかし、**主張に根拠が足りない、資料が欠ける、近接修正との独立性がまだ分からない場合も `非採用` として、運用上の通常の Lab 検証対象から外す**。`wbh-screen` 自体は台帳を書き換えないため、`verify next` のコード上の列からは除かれない。後で同じ Finding を再 screen できるが、再評価の証拠を誰がいつ集めるかが未定なら、実質的な検証の先送りとなる。特に通常構成、影響、修正との独立性は Lab や後段の比較で初めて確かめられるものがある。これは公開例が示す「反証」と「未検証」の区別、および本 repo の偽陰性を重く見る [DEVELOPMENT 第 1 節](../DEVELOPMENT.md)と緊張する。旧版 v2.2 と最新版 v3.1 の `非採用` は意味も台帳への作用も異なり、過去の記録を同じ判定として合算しない。現在の受け渡し実績と判定器の範囲は[2026-10-23 の現状報告](2026-10-23-verification-status.md)に別記されている。

## 推奨する判定順（設計案、未実装）

1. **前段:** Programme Boundary と Wordfence の明文によって明白に対象外と分かるものだけを理由付きで除く。Finding 自身の未検証の説明、資料欠落、公開 mirror の先例 0 件、独立性未証明は確定除外に使わない。追加資料や修正比較が必要なら、検証候補を残して次の作業を指定する。群化は検証順を決めるだけで、各 Finding を失わない。
2. **独立検証:** 固定ソースで主張の source-to-effect を反証し、通常機能の前提を Lab で作って再現する。nonce 判定で成立なら `runtime-confirmed`、source による明白な反証なら `contradicted`、前提・観測・環境が足りなければ `incomplete` として理由を残す。この 3 値の証明責務は現行不変条件のまま。
3. **検証後の提出スクリーニング:** 最新版で成立するか、通常の公開サイト構成で攻撃が届くか、被害者への security impact があるか、Wordfence の条件付き除外に当たるかを証拠で判定する。類似公開記録はここで修正箇所と攻撃経路を比べ、単なる同種・同 slug・最近の公開だけで重複としない。
4. **報告:** 技術的に確認でき、scope と重複の根拠が揃ったものに英語の報告案と再現資料を作る。人間が手動で再現・査読した後、特定の文案と送信先を承認して提出する。`incomplete` はレビューと再試行の管理に残すが、実証済みの提出候補と表示しない。

この案を実装するなら、段 1 の意味を変更するため [ADR 0038](../adr/0038-verification-phases-and-submission-flow.md)との整合を先に取る。まず旧版の段 1 `reject` と v3.1 の `非採用` を別々に棚卸しし、明白な除外と、検証・追加証拠待ちの案件に分けて再評価する。検証に進む件数と後段で実際に落ちた理由・所要時間を測るべきである。公開ハーネスの事例は分担の参考であり、この対象集合での偽陰性率や Wordfence 採択率を証明する比較実験ではない。
