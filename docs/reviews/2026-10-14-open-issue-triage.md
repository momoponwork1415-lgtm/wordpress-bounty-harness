# Open Issue の整理案（2026-10-14）

## 範囲と判断基準

2026-10-14 13時台の GitHub open Issue 30件を、`main` の文書・マージ済みPR・Issueコメントと照合した。Draft PR の成果は `main` の完了機能に数えない。現行の正本は [SPEC](../SPEC.md)、[ADR](../adr/)、[DEVELOPMENT 第2節](../DEVELOPMENT.md)、[PARKING](../PARKING.md)。この文書は採否を決めるための報告であり、Issue は変更していない。

整理の目的は、Step 1「選定から検証まで quota 1週分を人手0で完走し、範囲内Findingを全件exportへ届ける」に必要な問いを見えるようにすること。Issue の open/closed とコードの有無は同義ではない。とくに古い Issue 本文より、採用済みADRと後続の所有者判断を優先する。

## 閉じる候補：実装済みの問い

| Issue | 根拠 | 閉じる際に残す説明 |
| --- | --- | --- |
| [#118](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/118) Stored XSS の screenshot | [PR #135](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/135) merged。画面証拠経路の実Lab確認あり | 別の victim 操作・観測失敗は #126 / #213 と区別する。 |
| [#143](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/143) v3 生成契約 | [PR #151](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/151) merged | v2/v3 比較は未達のまま所有者指示で merge。現行の問いからは外す。 |
| [#178](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/178) Lab image | [PR #180](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/180) merged、実Lab測定あり | 後の一般的な前提不足 #213 とは分ける。 |
| [#185](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/185) Finding/Lead・review queue | [PR #191](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/191) merged。後続実測で範囲内 Finding 7/7 が queue/export に到達 | 本文の「範囲外→Lead」「content-deletion除外」は古い。現行は `finding-parked`、`content-deletion` は対象内。軽微な効果の狭い例外は #218。 |

[#186](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/186) は [PR #197](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/197) で当初の差分・export・Lab操作を実装した。一方、後続の [実測コメント](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/186#issuecomment-6144904316) は `incomplete(precondition)` の具体説明への直接参照が export に欠けると示す。この1点を独立して追うか、#186 の残件として本文を縮めてから閉鎖を判断する。

## 閉じる候補：現在は採らない設計

| Issue | 現行の受け皿・残件 |
| --- | --- |
| [#189](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/189) 研究file＋整形run＋自動追加Trial | 自動追加2 Trial は単一協調Trialの [ADR 0029](../adr/0029-single-wp2shell-cooperative-trial.md) と #215 の事前承認に反する。v4目的文は #214 / Draft PR #217、研究file回収の一部は PR #205 で別途扱われた。旧案として閉じる。 |
| [#141](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/141) `reproduced` と人間作業の機械工程 | 根拠の ADR 0028 は [ADR 0031](../adr/0031-review-report-dedupe-as-skills.md) により withdrawn。既存実装や台帳履歴は消さず、Issue の旧受入条件を止める。 |
| [#95](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/95) Harness 内の英語レポートと人間Lab | Lab 操作と証拠の束は #186、文案は #188 の skill へ移った。旧責務のIssueとして閉じる。 |

[#96](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/96) は重複照合を #188 の skill に移す一方、**提出前に最新版の新しいSnapshotで再検証する**問いが残る。丸ごと閉じず、その残件だけに縮める。実施時点は最初の提出判断までとし、Step 1 の無人運転ゲートとは分ける。

## 残して本文を直す候補

- [#100](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/100)：本番パイロットの親として維持する。PR #182 と本番周回の実測、現行 Step 1 の完了条件を1か所に整理する。本文の1万install下限、公開履歴による選定、追加Trial、人間再現までを現行の選定方針・ADR・DEVELOPMENTに照合する。過去の所有者コメントに「閉じない」があるため無断で閉じない。
- [#120](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/120)：Issue本文の「agent-authored HTTPの補助利用はADR違反」は不正確。[ADR 0015](../adr/0015-harness-captured-http-evidence.md) は補助資料として許す。一方、捕捉0でも読出し系判定器の成立証拠になり得る経路は残る。問いを「Harness捕捉のないHTTPを `runtime-confirmed` の根拠にしない」へ狭める。
- [#186](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/186)：上記の不足前提説明への参照を追う。既にできた差分・export・Lab操作を未実装として再着手しない。
- [#188](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/188)：3 skill は PR #202 / #204 で実装済み。Step 1 の残件は所有者が1 batchを処理して時間を記録する実測。実測を #100 に移す場合のみ閉じる。

## 維持と延期

Step 1 の実際の障害・正確性として維持：[#107](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/107) 再試行上限、[#179](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/179) options判定、[#183](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/183) schemaエラー、[#211](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/211) recipe空値、[#212](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/212) usage時刻、[#213](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/213) Lab前提、[#220](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/220) provider拒否、[#222](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/222) source権限、[#223](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/223) source取得。

進行中のDraftと対になるため維持：[#214](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/214) v4目的文、[#215](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/215) 追加Trial承認、[#218](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/218) 軽微効果、[#224](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/224) Opus、[#226](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/226) Opus broker。`main` の完成機能と数えない。Opus は現に所有者が進めているため、古い PARKING の「Step 1後」との優先順位の差は文書更新時に解消する。

Step 2以降へ保留：[#126](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/126) の修正版負対照、[#127](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/127) の残りの既知7件、[#175](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/175) Patchstack、[#177](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/177) 派生source。#126 の live smoke 自体は既存実装を使い、負の対照を完成扱いにしない。

## 整理後に必要な問い

現行の open Issue には、(1) 24時間分の候補在庫と実行直前の鮮度確認・予約、(2) Codex・Opus共通の対象と資源の入場制御、(3) 複数バッチの補充・期限・台帳照合・再開を一つの問いとして追うものがない。既存Issueの整理後、DEVELOPMENT 第3節の「問い1つ・測る数字」に沿って分ける。Step 1 の統合ゲートは quota 1週分の人手0運転、範囲内Findingの全件export、所有者の1 batchレビュー時間で測る。
