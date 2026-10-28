# 機能一覧と、Harness・スキル・人間の役割

2026-10-23。調査対象は main の `2a8e7e25e157e34afbeded94f67f14c090de4991`（PR #475 マージ後）。機能の採否を判断するための報告であり、正本の改訂ではない。コード・設定・スキル・実データは変更していない。

コード、CLI の登録、既定設定、SPEC、関係する ADR を静的に確認した。本番の現在のプロセス、私有設定、台帳を今回は調べていない。「実装がある」「既定で使う」「実際に使った」は別に扱う。先行資料の F01〜F27 を維持し、CLI 自体を F28 として追加した。機能の数は説明上の分け方であり、独立した部品の数ではない。

## 1. 責務を決める基準

| 担当 | 受け持つもの | 例 |
| --- | --- | --- |
| Harness | 合意済みの条件を機械的に守ること、実行の管理、入力と出力の契約、観測、保存、照合 | 版固定、隔離、時間上限、出力の形式検査、証拠の保存、判定器、文案の版と承認の対応 |
| 目的プロンプト・スキルを読む AI | 文脈の理解、調査、比較、手順の判断、説明の作成 | 何を読むか、候補の意味、規則の解釈、公開情報との比較、報告書の文章 |
| 人間 | 運用方針、権限・対象範囲の変更、提出前の手動確認・最終査読、承認と送信 | 残す機能を決める、最終文案を確認する、正確な宛先と版を承認して提出する |
| Codex / Claude 等の実行環境 | AI の会話、道具利用、協調セッションの実行 | Harness が入力を渡し、その出力・終了状態を回収する |

スキルは AI が読む手順書であり、それだけで動くプログラムや常駐ランナーではない。探索の目的プロンプトと、確認・報告側のスキルも別のものである。

「判断をスキルへ」は、すべての条件分岐を AI に任せるという意味ではない。入力が形式に合うか、同じ版か、証拠が決まった条件を満たすか、承認された文案と送信先が一致するかは Harness が確定する。一方、自然言語の前提から対象固有の手順を推測する処理は、文脈に依存する判断である。この区別は既存の AGENTS の責務方針、SPEC §2、ADR 0034・0035 に沿う。

## 2. 現在の機能一覧

「採否の単位」は、今後の運用について別々に必要性を考えられる範囲を示す。削除済み・不要と確認したという意味ではない。

### 対象の準備と実行の管理

| ID | 機能 | 現在していること・担当 | 採否の単位 |
| --- | --- | --- | --- |
| F01 | 対象候補の収集・選定 | Harness が公開一覧と方針に沿って選ぶ。人間による対象名・版の明示指定もある | 自動収集、順位付け、手動指定を分けて考える。方針の所有者は人間 |
| F02 | ソース取得・版固定 | Harness が対象、本体、PHP、依存の内容を固定し、digest で識別する | 保存方法は置換可能。同じ版である保証は、結果の対応を保つ責務 |
| F03 | AI の起動・協調実行・出力回収 | Harness が目的とソースを渡して実行を管理。どこを読みどう考えるかは AI | AI の仕事の内容と、起動・回収の仕組みは分ける |
| F04 | Codex / Claude 両対応 | Harness に両方の接続処理がある。Git 上の既定は Codex、Claude は設定による選択肢 | 一方だけを使うか、両方を残すか |
| F05 | 単発・無人の連続運転 | Harness が対象を順に処理し、状態・待機・停止要求を管理する | 単発だけで足りるか、常時運転が必要か。後段の全スキルの自動進行とは別 |
| F06 | 中断した実行の再開 | Harness が元の実行と続きの記録を結び付ける | 中断再開を製品機能として持つか |
| F07 | 時間・人数・資源の制御 | Harness が時間、子の数、並列数等を制限・記録する。能動時間の最低値という運用規則もある | 上限の保護、最低時間という方針、実行中の並列数変更を分ける |
| F08 | 隔離・通信・認証情報管理 | Harness が使い捨て環境と通信仲介を管理する | 実行を残す場合、同等の隔離と資格管理の責務が必要 |

根拠: [CLI の選定と実行入口](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/cli/index.ts#L878)、[Git 上の実行設定](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/profiles/wordpress/policy/campaign.json)、[Snapshot](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/snapshot/index.ts#L90)。既定設定は探索用 Lab なし、同時対象 1 であり、私有の本番設定と同一とは確認していない。公式取得の内部でも使うローカル取り込み部品を、独立した未使用機能とは数えない。

### 候補の保存と確認

| ID | 機能 | 現在していること・担当 | 採否の単位 |
| --- | --- | --- | --- |
| F09 | 出力の保存・正規化・形式不備の保留 | Harness が候補と手がかりを保存し、形式を検査する。不足は理由付きで保留する | 内容の妥当性判断と、データ形式の検査は別 |
| F10 | 対象範囲外の振り分け | Harness が決められた対象外分類を通常の列から外し、理由付きで保存する | 方針による振り分けと、対象外の一覧表示を分ける |
| F11 | 確認用 Lab の供給・片付け | Harness が固定した対象の環境を準備し、使用後に片付ける | 環境管理を誰が担うか。対象ごとの調査手順はこの責務に含めない |
| F12 | スキルへの受け渡し | Harness が環境と資料を渡し、結果を受け取る。確認の中身は `wbh-verify` を読む AI | 実行する AI の仕事と、受け渡し契約を分ける |
| F13 | 観測・証拠に基づく判定 | Harness が観測を残し、決定論的な判定器が結果を付ける | 証拠の保存と判定は別の機能。AI の自己申告だけでは確認済みにしない |
| F14 | 旧検証方式・シナリオ選択 | 旧 Verifier と対象別準備処理、文章からの手順選択がコードに残る。通常の手渡し経路とは別 | 既存の退役計画の対象。スキル化完了と旧実装の削除完了は同じではない |
| F15 | 最新版・別版での再確認 | Harness が版と結果の対応を別記録として保持する | 版間の記録管理と、作業手順の判断を分ける |
| F16 | 似た候補の群分け | Harness が定義済みのキーで候補をまとめ、代表を先に表示する | 一覧の便利機能。公開済み問題との重複照合とは別 |

根拠: [候補の保留表示](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/cli/index.ts#L1800)、[群分け](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/ledger/finding-groups.ts)、[ADR 0035 の現行・旧方式の区別](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/docs/adr/0035-verification-as-a-skill.md#L42)。探索の具体的方法や再現手順は本資料の対象に含めない。

### レビューと提出準備

| ID | 機能 | 現在していること・担当 | 採否の単位 |
| --- | --- | --- | --- |
| F17 | 一覧・レビュー材料の export | Harness が候補、状態、判断履歴、証拠の場所を表示・出力。スキルもこれを読む | 人間向け表示、AI 向けデータ出力を分ける |
| F18 | 採用・棄却・保留の記録 | スキルを読む AI が中間の判断案を作る。Harness が判断者・理由・参照資料を記録。最終査読は人間 | 判断の内容と記録機構を分ける |
| F19 | 公開情報・提出条件・提出先の整理 | Harness に公開履歴の検索と条件照合があり、スキルが規則の文脈・同一性・提出先を調査する | 重複検索、重複の解釈、scope の条件照合、提出先調査は個別に判断する |
| F20 | 人間用 Lab・手動確認の記録 | Harness が環境と記録先を用意し、人間が確認した一致・不一致等を保存する | 環境の供給、確認行為、結果の保存を分ける |
| F21 | 報告文・添付一覧の作成と版管理 | スキルが英語の暫定文案等を作る。Harness が AI 暫定版と人間最終版を区別して保存する | 執筆補助、入力用 JSON、添付の整理、文案の版管理を分ける |
| F22 | 承認・提出済み・回答・報酬の記録 | 人間が最終承認して送信。Harness が承認対象の版と宛先を照合し、提出済みや回答・報酬を記録する | 承認の記録、提出状況管理、報酬管理は個別の採否対象。Harness 自体は送信しない |

根拠: [Review の現行手順](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/review/README.md)、[文案保存](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/review/index.ts#L815)、[最終確認の条件](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/review/index.ts#L1000)。人間による実施という属性は本人認証ではなく、AI の中間記録を人間の最終確認へ読み替えない運用も必要である。

### 保存・運用・開発・操作画面

| ID | 機能 | 現在していること・担当 | 採否の単位 |
| --- | --- | --- | --- |
| F23 | 台帳と Private Evidence | Harness が履歴を追記し、本文・添付は Git 外へ保存して digest で結び付ける | 保存基盤を置き換えることと、履歴・証拠の保管をやめることは別 |
| F24 | 件数・時間・使用量の集計 | Harness が処理件数、停止・再開、使用量、人間の作業時間、提出結果等を集計する | 必要な指標だけ残す、工数記録をやめる、表計算等へ出す、といった判断ができる |
| F25 | 運転状態・診断・通知・復旧 | Harness が状態、履歴の鮮度、環境の整合性、残存資源を扱う。任意の通知フックや補助 script もある | 状態表示、通知、復旧、資源回収を分ける |
| F26 | 品質検査・開発分析 | 型、整形、テスト、依存の検査、Knip の未参照候補診断、開発集計 script | 本番の製品機能とは別。Knip は診断で、自動削除はしない |
| F27 | 過去の形式・版を読む互換性 | Harness が古いイベントや保存形式を読む。旧目的文・スキル本文も照合用に残す | 過去の記録を現行版から読む必要があるか。旧版の保存は旧機能の新規実行と別 |
| F28 | CLI | Harness の操作窓口。人間、AI、運用スクリプトから各機能を呼ぶ | 全機能の有無とは別に、誰にどの操作を公開するかを決める |

根拠: [集計・診断の入口](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/cli/index.ts#L1540)、[台帳](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/ledger/index.ts#L732)、[非公開資料の保管](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/infrastructure/private-artifact-store.ts#L97)、[開発用コマンドと依存](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/package.json#L25)。

## 3. 6 本のスキルが担当する内容

| スキル | AI が行う仕事 | Harness との受け渡し |
| --- | --- | --- |
| `wbh-screen` | 提出条件の文脈を読んだ一次評価と根拠の整理 | 候補の材料を読み、判断案を返す。記録操作は別 |
| `wbh-verify` | 供給された環境における確認作業 | 環境・材料を受け取り、結果を渡す。確認済みの確定は判定器 |
| `wbh-dedupe` | 公開済みの問題と同じかを比較し、根拠を説明 | 検索・資料を利用して照合結果を返す。結果の保存は Harness |
| `wbh-destination` | 提出先を調査し、理由付きで提案 | 提案を非公開メモへまとめる。宛先と文案の固定・承認は別 |
| `wbh-report` | 英語文案、フォーム入力用 JSON、添付一覧の作成 | 暫定資料を作り、AI 文案の保存機能を利用する |
| `wbh-review` | 証拠の要約、欠落の指摘、採否案の説明 | export を読む。最終的な人間の査読と承認は代行しない |

現行本文は [.claude/skills](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/tree/2a8e7e25e157e34afbeded94f67f14c090de4991/.claude/skills)。各スキルの手順、Harness の保存操作、その操作を起動する AI は区別する。たとえば `wbh-screen` の文章が直接台帳を変更するわけではない。現行 ADR は AI 操作役による中間判断の記録を許容する一方、一部スキル本文には以前の運用記述が残ると明記している。

## 4. 役割がまだ揃っていない箇所

1. **文脈を読んで手順を決める旧コードが残る。** `nextWordPressScenario` は自然言語の前提からシナリオを選び、対象別の準備処理も残る。既存の責務方針ではスキル側の仕事で、旧実装の退役が未完了である。[実装](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/profiles/wordpress/lab/scenarios.ts#L313)、[退役計画の注記](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/docs/adr/0034-harness-control-only-deletions.md)。
2. **提出条件の解釈と機械照合を区別する必要がある。** `wbh-screen` と `wbh-destination` は規則を読み、`scope-policy.ts` も明示条件を照合する。全部が重複というわけではない。規則の例外・文脈の解釈はスキル、確定した条件と証拠の照合は Harness、と規則ごとの所有者を説明できる形が必要である。[条件照合](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/profiles/wordpress/scope-policy.ts#L101)。
3. **報告書を作る仕事と文案を保存する仕事が同じ機能に見えやすい。** 英文や添付の説明を作るのはスキル、版・参照・作成者属性を保存するのは Review、人間が最終内容を確認する。今のコードもこの三者を持つ。残すかを一括で決める必要はない。
4. **CLI は判断の所有者ではない。** 引数・表示・呼出しの窓口である。CLI のコマンド数と、Harness が持つべき機能の数を同一視しない。スキルから利用する入口まで消す場合は、残す機能を呼ぶ方法が別途必要になる。

出力形式の契約は Harness のスキーマを正本とする。スキル本文にも別の契約を手書きすると更新箇所が増える。これは現在も [出力契約の生成](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/profiles/wordpress/discovery/output-contract.ts#L9) に分離されている。

## 5. 現在あると誤認しないもの

- 6 本のスキルを最後まで自動で引き継ぐ orchestrator は未実装。AI 操作役が個々のスキルと CLI を進める。[ADR 0038 の追記](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/docs/adr/0038-verification-phases-and-submission-flow.md#L103)。
- メール・報告フォームへの送信は Harness の機能ではない。フォーム入力用 JSON の生成と、実際の送信は別。
- 公開履歴 mirror の読取り・鮮度確認はあるが、更新処理はこのリポジトリ外にある。[mirror の説明](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/2a8e7e25e157e34afbeded94f67f14c090de4991/src/profiles/wordpress/wordfence-history/README.md)。
- 被害者側の画面を再訪して動画を収集する PR #455 は、この main には含まれない。既存の観測・画像と同一視しない。
- Temporal 等の外部ワークフロー基盤は導入されていない。今回入った dependency-cruiser と Knip は開発用の静的解析である。
- 入口・保存先索引の生成、coverage による探索判定、旧評価 CLI 等の削除済み機能を、今後の削減量に再計上しない。

## 6. 必要性を決めるときの分け方

機能ごとに「残す／簡素化／外部の道具へ移す／廃止／保留」を決める。そのうえで、残す機能の担当を決める。スキルへ移すことと機能を廃止することは異なるため、コード行数の減少だけを成果にしない。

独立して採否を考えやすいのは、両 provider 対応（F04）、連続運転（F05）、中断再開（F06）、群分け（F16）、提出補助の各作業（F19）、文案の版管理（F21）、提出後の管理（F22）、細かな集計と工数入力（F24）、通知（F25）、人間向け CLI の操作範囲（F28）。実行・証拠・最終承認の保証は、別の機能に付随する責務として一緒に扱う。

まずは新しい基盤を増やすより、各機能について「誰が判断するか」「何をコードで保証するか」「何を保存するか」を揃えるための一覧として使う。これは採用決定や実装変更ではない。
