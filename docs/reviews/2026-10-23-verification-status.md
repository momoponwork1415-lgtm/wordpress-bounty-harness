# 検証部分の現状（2026-10-23）

## 問いと結論

Finding ごとの handoff → 使い捨て Lab → Harness 所有の観測と canary 判定 → Private Evidence / 台帳、という検証の主経路は動いている。対象範囲内 12 分類のうち 11 分類に判定器がある。ただし本番の handoff で確認に届いたのは保存型 XSS とアカウント乗っ取りの 2 分類で、最新版確認・重複照合・英語レポート保存までの縦断は未実証である。現行の報告 skill は人間の手動再現を先に要求しており、「AI が報告案まで作り、最後に人間が再現・査読する」という [SPEC](../SPEC.md) と [ADR 0038](../adr/0038-verification-phases-and-submission-flow.md) の順序に合っていない。これは 2026-10-23 時点の観測であり、正本の仕様ではない。

## 検証できる範囲

「判定器が実装されている」「模擬 Lab のテストが通る」「本番の実 Lab で確認まで届いた」を分ける。

| 対象範囲内の impact | Harness が照合する証拠 | 本番 handoff の元 Finding の最新結果 |
| --- | --- | --- |
| `stored-xss` | Lab 所有ブラウザで別主体の画面を開き、発行した nonce の beacon と捕捉済みの攻撃者 request・画面を照合 | 確認 9 / incomplete 14 |
| `account-takeover`、`privesc-to-admin`、`auth-bypass-to-admin` | canary 管理者セッション、または攻撃者アカウントの新たな管理者 role | account-takeover 確認 1。残る 2 分類は本番 handoff 実証なし |
| `rce`、`php-file-write` | 発行した execution canary が Lab 内で実行された marker | 本番 handoff 実証なし |
| `arbitrary-file-read`、`arbitrary-file-download`、`lfi` | request に含まれない canary ファイル値が応答へ現れる | download incomplete 2、lfi incomplete 1。read は実証なし |
| `arbitrary-file-delete` | 播種した canary ファイルの消失 | 本番 handoff 実証なし |
| `sqli` | canary 行の更新、または request に含まれない canary 行値の応答 | 本番 handoff 実証なし |
| `rfi` | 判定器も標準 reproducer も未登録 | `incomplete(no-judge)`。本番 handoff 実証なし |

分類と境界は [programme impacts](../../src/profiles/wordpress/discovery/programme-impacts.ts)、判定器は [judges](../../src/profiles/wordpress/verification/judges.ts)、標準 reproducer は [standard-reproducer](../../src/profiles/wordpress/verification/standard-reproducer.ts) にある。ファイル操作の判定では path / 拡張子の制御が 1 種だけなら `partial` と記録されるため、canary 観測だけで提出先の対象範囲を満たしたとは言えない。標準 reproducer が自動再実行できるのは SQLi とファイル読み取り系の応答 canary で、`runtime-confirmed` とは別の `reproduced` を出す。

`other`、`csrf-to-write`、`missing-authz`、`idor`、`reflected-xss`、`sensitive-object-access`、`content-deletion`、`options-update`、`privesc-to-contributor+`、`auth-bypass-non-admin` の 10 分類は現在の Programme Boundary で park され、通常の検証列に入らない。一部の古い判定器コードは残っている。

本番 handoff の元 Finding 27 件の最新結果は確認 10 / incomplete 17。これは保存型 XSS 23 件、アカウント乗っ取り 1 件、ファイル download 2 件、LFI 1 件という試行母集団であり、他の分類の成功率を推定できない。上表の「実証なし」は未実装の意味ではない。実 Lab 以外の判定器テスト 6 ファイル 61 件は成功したが、各 impact が本番対象で再現できることの証明ではない。

## 実行実績

本番台帳 `~/.local/state/wordpress-bounty-harness/ledger.sqlite` の `verification-finished` を、`campaign_id like 'prod-%'` かつ `promptVersion like 'wbh-verify/%'` で集計した（台帳の更新は 2026-10-23 16:23 JST）。Private Evidence の本文は読んでいない。

| 指標 | 件数 |
| --- | ---: |
| handoff 試行 | 49（元 Finding 48、最新版再検証 1） |
| handoff を受けた元 Finding | 27（別に `basis.kind: latest-version` の派生 Finding 1 ID） |
| `runtime-confirmed` | 元 Finding 11 試行、最新版再検証 1 試行 |
| 元 Finding の最新結果が `runtime-confirmed` | 10 |
| 元 Finding の最新結果が `incomplete` | 17（precondition 10、observation 4、recipe 2、evidence 1） |
| 現行 `wbh-verify/v8` の本番試行 | 0（最新の記録は v7） |

したがって「動く」の実績は、元 Finding 10 件と、別の最新版再検証 1 試行が決定論的判定器の canary 確認に届いたことまでである。元 Finding で一度でも確認された件数と最新結果が確認済みの件数は同じ 10 件である。最新版の派生 Finding には、その確認後に `incomplete(recipe)` の再試行が 3 回あり、最新試行は incomplete である。最新版の確認 1 試行を「提出準備完了 1 件」とは数えない。これは固有の脆弱性、未知の脆弱性、提出、報奨の件数ではない。旧自動検証は 2026-10-20 の切り出しで 40 試行中確認 0、37 試行が前提不足だったため、runner から外した（[当時の集計](2026-10-20-design-issues-from-production-results.md)、[ADR 0038](../adr/0038-verification-phases-and-submission-flow.md)）。当時の handoff 22 試行は上の 49 試行に含まれ、足し合わせない。

本番の handoff 待ちは、台帳の最新判定・reject・再検証用の別 ID を除いた論理的な列で 55 Finding。2026-10-23 18:40 JST に現行本番 checkout `/home/dev/wordpress-bounty-harness-prod19` から `continuous status` を見ると `stale` / `pid none` で、runner プロセスも無かった。直近の error は `The campaign's reserved selection batch is unavailable or does not match this policy`。検証の手動 handoff の最終台帳書込は同日 16:23 JST。レビュー判断は本番で accept 1 件が記録されているが、台帳に提出・転帰 event は無い。

## 実装済みの境界

- 現行の `discovery.lab` は `none`。`continuous run` は探索のみで、受理した scope 内 Finding は handoff 列に置く。`verify next` は `--handoff` を要求する（[設定](../../src/profiles/wordpress/policy/campaign.json)、[runner](../../src/cli/continuous.ts)、[CLI](../../src/cli/index.ts)）。
- handoff は `setup-done` 後に設定管理者と canary 主体の認証を無効化し、HTTP 捕捉と role・option の基線を取り直してから攻撃者用 `attack.json` を渡す（[handoff](../../src/profiles/wordpress/verification/handoff-verifier.ts)、[Lab の境界](../../src/profiles/wordpress/lab/canary-placement.ts)）。
- Lab は `runsc` を要求する。Finding・Snapshot・Lab の digest を照合し、判定器が nonce canary を観測したときだけ `runtime-confirmed` にする。証拠不足は `incomplete` に残す（[Lab 起動](../../src/profiles/wordpress/lab/container-startup.ts)、[検証 core](../../src/verification/index.ts)）。

実装の責務は次のように分かれている。`verify next --handoff` と [pipeline](../../src/cli/pipeline.ts) が Finding を選び、[wordpress session](../../src/cli/wordpress-session.ts) が Lab・Verifier・判定器を組み立てる。[verification core](../../src/verification/index.ts) は digest 照合、Lab 供給、結果の正規化、片付けと台帳記録を担う。WordPress profile の [Lab](../../src/profiles/wordpress/lab/index.ts) は固定した対象と依存を検査し、`runsc` の WordPress / MySQL / HTTP recorder / canary receiver を排他的に立てる。Lab 内の [recorder](../../src/lab/recorder/index.ts) が request / response を捕捉し、[capture](../../src/lab/capture.ts) は欠損や切詰めを検知する。[judges](../../src/profiles/wordpress/verification/judges.ts) が捕捉事実と canary を突き合わせ、[ledger](../../src/ledger/index.ts) が digest 参照を追記する。台帳も Snapshot 不一致や証拠欠落なら `incomplete` へ降格する。再現の手順と前提作りは [wbh-verify](../../.claude/skills/wbh-verify/SKILL.md) の責務である。

HTTP recorder には 1 body 1 MiB・試行全体 64 MiB の上限があり、必要な証拠が欠ければ確認できない。被害者側の browser は Lab 所有で、Verifier へ一般的な browser 操作権を渡していない。XSS ではスクリーンショットを保存するが、全般的な画面・録画の review export への接続は [PR #455](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/455) の受け入れ待ちである。

### 1 試行の経路

1. `verify next` が scope 内で未結論の Finding を群代表優先で選び、最新判断が reject のものを除き、同じ Snapshot と setup を読む。再試行は Lab Setup digest・skill 版・失敗理由で予算を数える（[queue](../../src/cli/pipeline.ts)、[再試行予算](../../src/verification/retry-budget.ts)）。
2. Finding を Private Evidence から再読込し、digest を照合する。新しい WordPress・MySQL・recorder・canary receiver の Lab を `runsc` で供給し、canary を播種する。検証 Lab はホスト全体の lease を取得するため、同一ホストでは事実上直列で、lease 取得だけの待機上限は既定 30 分（[検証 core](../../src/verification/index.ts)、[Lab](../../src/profiles/wordpress/lab/index.ts)）。
3. Harness が接続先と前提作り専用の管理者資格を `lab.json` に渡す。`wbh-verify` skill の AI が固定ソースと Finding を読んで通常機能の前提を作り、`setup-done` を置く。Harness は管理者資格を無効化し、HTTP 捕捉と状態基線を取り直して `attack.json` に攻撃者資格と canary を渡す（[skill](../../.claude/skills/wbh-verify/SKILL.md)、[handoff](../../src/profiles/wordpress/verification/handoff-verifier.ts)）。
4. AI が攻撃者位置で HTTP を実行し、route・HTTP・session・steps・refutation・precondition の 6 ファイルか `abort` を置く。前提作りと攻撃の待機には合わせて既定 30 分の deadline がある。被害者画面の表示と操作は Harness の Lab browser が実行する（[handoff](../../src/profiles/wordpress/verification/handoff-verifier.ts)、[Lab 観測器](../../src/profiles/wordpress/lab/lab-observation.ts)）。
5. Harness が recipe を検査・保存し、HTTP 捕捉、canary、被害者画面、Lab 状態差分を照合する。判定器が canary を観測した場合だけ確認と再現パッケージを出す。Lab は毎試行後に片付け、結果と証拠 digest を追記専用台帳に残し、review export から参照できるようにする（[Verifier](../../src/profiles/wordpress/verification/wordpress-verifier.ts)、[判定器](../../src/profiles/wordpress/verification/judges.ts)、[review export](../../src/review/export.ts)）。

### 時間の観測範囲

元 Finding の本番 handoff 48 試行について、台帳の `lab-provisioned(ready)` から `verification-finished` までの壁時計は中央値 3.3 分、75 百分位 7.7 分だった。1 試行だけ 645.5 分の異常値があり、原因は台帳だけでは分からない。Lab ready から Verifier run 完了までの中央値は 2.9 分、そこから判定・片付けまでは中央値約 0.3 分である。

48 試行の結果は確認 11、`incomplete` 37（observation 16、precondition 13、recipe 5、evidence 3）。元 Finding 27 件のうち 19 件は 1 試行、残る 8 件は 2〜8 試行だった。確認に到達した 10 件でも、到達まで 4 試行と 6 試行を要したものが各 1 件ある。単発の判定処理より、前提不足・観測・recipe の修正で新しい Lab を立て直すことが、実測上の長期化として見えている。

ただし台帳に Lab 供給開始、`setup-done`、`observation-ready` の時刻がない。Lab 起動時間と handoff 内の待機・能動作業は分解できない。Lab の毎回の再供給、ホスト lease、被害者画面の逐次観測、状態差分の取得には構造上の費用があるが、それぞれが全所要時間の何割かは現状の記録から断定できない。

## 未完と判断

- [#352](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/352) の Brizy / TranslatePress の handoff 受け入れは未記録で、Issue も開いている。その条件を満たしてから削除する予定の旧シナリオ選択・アダプタ・Verifier 経路はまだコードに残る（[#353](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/353)、[ADR 0035](../adr/0035-verification-as-a-skill.md)）。
- 現行 v8 は本番試行前で、v6・v7・v8 の skill 本文改訂による改善幅はまだ測れない。直近の主な `incomplete` は Lab で前提が作れないものと被害者側の観測である（[ADR 0038 追記](../adr/0038-verification-phases-and-submission-flow.md)）。
- 対象が必要とする依存プラグインの欠落、被害者側で必要な操作の表現、include 型 LFI の canary には、それぞれ [#467](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/467)、[#468](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/468)、[#464](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/464) の制約が残る。RFI は scope 内の分類だが現行の判定器には登録されず、`incomplete(no-judge)` になる（[分類](../../src/profiles/wordpress/discovery/programme-impacts.ts)、[判定器](../../src/profiles/wordpress/verification/judges.ts)）。
- 検証から提出までの 6 段を実 Finding で通す [#441](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/441) は未完である。したがって現状を「提出まで無人で動く」とは評価しない。

## レポートまでの接続

本番台帳全体では元 Finding 82 件の最新検証結果が確認 10 / incomplete 72。`review-decided` は 19 件（accept 1 / reject 18）、`scope-assessed` は 6 回・3 Finding で全件 `ambiguous`、`draft-saved`・外部行動承認・提出・転帰はいずれも 0 件である（台帳最終更新 2026-10-23 16:23 JST）。重複照合の個数は台帳イベントだけから算出できず、「0 件」とは判定しない。`review draft` は in-scope 評価を要求するため、現時点の台帳には正式文案へ進める記録がない（[実装](../../src/review/index.ts)）。

調査時点の [OPERATIONS 第 3 節](../OPERATIONS.md) では、skill が各段の材料を作る間に、所有者が screen の棄却記録、重複照合の記録、最新版再検証、scope 評価、Lab 手動再現、採否を実行していた。最後に [wbh-report v3](../../.claude/skills/wbh-report/versions/v3.md) が英語本文、フォーム欄、添付一覧を Private Evidence に作る。同 skill は `humanReproduction.match` と `accept` を**執筆前**に要求し、人間が歩いた手順と実値から PoC を書く。`vendor:<名>` は対応していない。各 skill は次の skill を起動しないので、段を通す自動実行役も未実装だった。

これは [SPEC 第 3 節](../SPEC.md) と [ADR 0038](../adr/0038-verification-phases-and-submission-flow.md) の「英語レポート案 → 人間の手動 Lab 再現と査読」の順序と食い違っていた。調査時点のコードは `runtime-confirmed` の `review draft --prepared-by ai` を手動再現前に保存できたが、`reproduced` の文案は手動 `match` を要求した。PR #472 で後者の gate も解除された（[saveDraft](../../src/review/index.ts)）。公開提出先の要件では、Patchstack は最新版・英語・遠隔攻撃者視点の詳細な手順と HTTP / 画面等の証拠を要求し、Wordfence は有効な動く PoC と重複の扱いを重視する（[Patchstack の第三者プラグイン報告フォーム](https://www.patchstack.com/database/report)、[Wordfence Bug Bounty Program](https://www.wordfence.com/threat-intel/bug-bounty-program/)）。AI が先に作る文案は、手動確認前であることを内部状態で明示し、未観測の手順や影響を補ってはならない。

### 選択肢と推奨

1. 現行順序を維持する。所有者が各段で操作し、手動再現後に skill がレポートを書く。技能の入口は変えずに済むが、目標の「人間は最後」に届かない。
2. **推奨: AI が証拠付きの暫定文案まで準備し、最後に人間が再現・査読する。** AI が screen、handoff、最新版照合・再検証、重複照合、scope、提出先の根拠を連続して扱う。`runtime-confirmed` / `reproduced` と最新版・範囲内の根拠が揃う Finding について、Lab 捕捉 request と再現パッケージから英語の暫定文案、フォーム値、添付一覧を Private Evidence に作る。`incomplete` はレビュー資料に残すが、提出できる報告書と呼ばない。人間はその資料で Lab 再現し、文案の実値・影響・提出先を査読して修正し、正確な candidate / 文案 digest / 送信先に対して承認する。送信は人間が行う。

選択肢 2 を実装する場合、(a) 中間の AI 判断を人間の `review-decided` や `humanElapsedSeconds` に混ぜず記録する、(b) wbh-report の人間再現を執筆の入口から最終承認前へ移し、暫定と最終の版を区別する、(c) `reproduced` の早期文案の扱いと、全結果での最終再現 gate を揃える、(d) scope `ambiguous` や重複 `unavailable` は止めて根拠不足を示す、(e) 画面・録画の証拠を接続し、1 件を段 1〜6 まで通して所要時間を測る、の順で行う。Harness は Lab・証拠・判定・記録だけを持ち、照合や再現の考え方は skill に置く。現行の正式文案・承認 gate を迂回して提出してはならない。

未確認なのは、現行 10 件の確認済み Finding に最新の範囲内判定・重複なし・人間が追える PoC が揃うか、実際の提出フォーム拡張機能が Markdown の `Form fields` を読めるか、各段と手動再現の所要時間である。実 Finding を Private Evidence から監査して段 1〜6 を通すまで、レポート自動作成が動くとは言えない。

### 所有者の選択（同日）

所有者は選択肢 2 を選び、当面は Wordfence 向けを主経路にした。既存の Fill-Only Extension は `wordfence-fill-only/2` の JSON を読むため、Wordfence の暫定文案と同じ証拠から JSON 案も作る。Patchstack 用の新しいフォーム入力機能は、報告が増えてから実装する。この選択は上記の集計時点より後の決定であり、上記の `draft-saved=0` などの観測値を変更しない。

所有者はさらに、Wordfence の文案では公開履歴 mirror の類似例の記述を参考にするよう提案した。Git 外の `history.sqlite` の `vulnerabilities` 表には現在 `description` 列がある。過去の[スキル出典対照表](archive/2026-10-13-skill-source-comparison.md)は「Description を corpus から読み取って本文にする」を、当時の mirror に本文が無い理由で不採用にした。今回採るのは、**判定器の確認と重複照合を終えた後**に公開済みの別 slug の説明を最大 3 件読み、文の順序・長さ・役割の呼び方だけを参考にする狭い操作である。技術的な事実や文章は写さず、Finding・固定 source・Lab の証拠から独立に書く。公開履歴を探索エージェントへ渡さない。

## 今回の確認

現行 checkout で `pnpm test -- tests/profiles/wordpress/handoff-verification.test.ts tests/profiles/wordpress/handoff-verifier.test.ts tests/profiles/wordpress/verification-negative-control.test.ts` を実行した。Vitest は全 suite を実行し、121 files / 1,101 tests が成功、実 `runsc` Lab 統合テスト 1 件は `WBH_REAL_LAB_IMAGES` が無いため skip された。模擬 Lab を通す handoff・判定器のテストは通るが、実対象の #352 受け入れの代わりにはならない。

### TranslatePress 開発セットでの追加確認

所有者の依頼を受け、公開済みの TranslatePress 3.3.1 アカウント乗っ取り Finding を、既存の開発用 state の複製から新しい gVisor Lab に受け渡した。最初の起動は scratch の work に Snapshot/source artifact が無く `source-mismatch` で止まった。固定済み Snapshot と source cache の所在を正して再実行すると、2026-10-23 19:52 JST に判定器が `runtime-confirmed` を記録した。Finding と検証の Target Snapshot digest は一致し、`wordpress-administrator-principal` 判定器が nonce canary を回収した。Lab の handoff 開始から結果までの壁時計は約 5 分 41 秒である。台帳と HTTP・再現パッケージはすべて Git 外に置き、元の開発用 state は変更していない。

この事例は [Wordfence に公開済み](https://www.wordfence.com/blog/2026/08/400000-wordpress-sites-affected-by-account-takeover-vulnerability-in-translatepress-wordpress-plugin/)で、3.3.2 で修正されている。所有者の指示に従い、重複照合は**報告書の形式を試す今回の開発演習に限り**省く。過去版に対する確認を現行版の scope や提出適格性として扱わず、正式な `review draft`、外部行動の承認、送信には進めない。

新しい検証の証拠から、英語の暫定 Markdown、`wordfence-fill-only/2` の 15 項目 JSON、`submission-package/v1` manifest、内部チェックリストを Git 外に作った。15 項目の重複・型・必須値と、Markdown・JSON・添付の byte 数と SHA 整合を確認した。`human_verification.status` は `pending` で、画面と人間の手動再現は未取得である。動画も未取得だが、Wordfence の Video Demonstration は任意である。これらを含む暫定 package は形式の試験結果であり、送信可能という結論ではない。
