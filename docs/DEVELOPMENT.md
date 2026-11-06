# 開発の流れ

対象読者: このリポジトリの所有者と、依頼を受けて変更する AI。設計の正本は [SPEC.md](SPEC.md) と [ADR](adr/)。この文書は「何を作るか」ではなく「どう進めるか」を決める。

## 1. 目標

- 報奨で月 1,000 ドル以上（所有者、2026-10-10）。所有者の換算: アクティブインストール 30〜40 万規模の対象で、ATO を月 1 件、または Stored XSS を月 4 件、または SQLi を月 2 件程度。選定の下限と重みは[選定方針 JSON](../src/profiles/wordpress/policy/selection.json)が正本。
- 前の harness の問題は「対象選定に人間が入る」「結果確認に人間が入る」の 2 点だった。前者は自動選定で解けた。後者は人間を無くすのではなく、人間が読む件数を Harness が絞ることで解く。偽陰性（本物を落として報奨を逃す）は偽陽性より高くつく（所有者、2026-10-13）。
- 設計の教訓は [LESSONS.md](LESSONS.md)。新しい案はまずここに反していないかを見る。

## 2. 運用規則（2026-11-05）

2026-10-13 のロードマップ（Step 1〜3）は役目を終えた。本番ランナーの稼働状態を Git 外で確認し、次の規則で変更を決める。当時のロードマップと決定の経緯は Git 履歴と [ADR 0032](adr/0032-owner-decisions-on-constraints-2026-10-13.md) にある。

- **本番が bench。** 探索の数字は本番の対象から取る（所有者決定 2026-10-26）。開発セットに戻すのは、本番で対象範囲内の Finding は出るのに人間の観測の `match` が 1 週間 0 件のときだけ。既知の公開事例の benchmark は、現行の方法が 1 回の Trial で既知の型を外したときに、その型を名指しして回す。pass@3 のような反復は置かない。
- **変えない 5 つ。** 不変条件 1〜8、Harness は制御だけ、確定は人間の Lab 観測だけ、探索プロンプトの文面（消すだけは許す）、設計変更は月 1 回（[ADR 0045](adr/0045-frozen-core-and-three-exploration-forces.md)）。2026-11-05 に所有者が決めた 7 月 30 日方式の版付き目的文だけ、文面の凍結の例外とする（[ADR 0051](adr/0051-july30-prompt-pilot.md)）。
- **リポジトリの探索既定。** wide は v26-wide の単一目的文、探索 Lab 付き、最低時間なし、子の上限 4 とし、別 Snapshot の研究 file を `priorResearch: same-target` で引き継ぐ。六段階探索方式は 2026-11-05 に削除した（ADR 0050）。同一 Snapshot の自動再探索は continuation 契約（ADR 0052）だけで行い、リポジトリの wide 方針は `continuation: open-routes` を指定する。Harness は `continuation.json` の形・件数・id の digest だけを読み、連鎖 3 Trial までを自動で組む。本番ランナーの Git 外設定は、このリポジトリの既定を変えるだけでは切り替わらない（ADR 0051 の 2026-11-05 追記）。
- **採用した方式の運転を測る。** 現行の v26-wide を本番対象で回し、完了率、停止理由、Finding / Lead、Lab の利用、人間の観測、時間と使用量を記録する。旧版・新版を交互に走らせる比較や旧 6 段の採否基準は必須にしない（ADR 0051 の 2026-11-05 追記）。分母は Codex 1 時間あたりの Lab 発火数と Wordfence の結果（ADR 0045）。手順は [docs/agents/measurement.md](agents/measurement.md)。
- **Harness の変更は制御だけ。** 選定、Snapshot、sandbox、制限、保存、park、Lab の供給、観測の記録、台帳。探索と検証の「やり方」が code に現れたらプロンプトかスキルへ移す（[AGENTS.md](../AGENTS.md) の責務）。bug 修正と削除は随時、新しい機構は ADR 0045 の月 1 回の枠で。
- **文書の役割。** 正本は [SPEC.md](SPEC.md) と [ADR](adr/)。いまの動きの説明は [SYSTEM.md](SYSTEM.md)。調べて報告した文書は [docs/reviews/](reviews/) に日付付きで置き、正本ではない。本番の設定、台帳、Private Evidence は Git 外。
- **人間の判断点は 2 つ。** 提出前のレビュー（Lab で自分の目で観測する）と外部行動の承認。人間はコマンドを打たず、会話で述べたことを AI が本人の名で記録する（2026-10-31）。

## 3. 単位は「問い 1 つ」

- 1 週間に答える問いを 1 つ決め、GitHub Issue に「問い」と「答えが分かる数字」を書く。例: 「`gpt-6-luna` は 90 分のうち何分使うか。prompt を変えると変わるか」「答えは台帳の run wall 中央値と `observed.filesRead`」。
- PR はその Issue を参照する。問いに関係ない変更は別の問いにする。
- 問いが決まっていない間は、PR を作らない。報告（第4節）だけを依頼する。
- 過去 4 世代の実験記録は `history/knowledge/` に置いてある（読む順には入れない）。同じ問いを前に立てた覚えがあるときだけ見に行く。

## 4. AI への依頼は 2 種類

| 種類 | 成果物 | 置き場 | 所有者がすること |
| --- | --- | --- | --- |
| 調べて報告 | 事実、選択肢、推奨、未確認の仮定を分けた文書 | [docs/reviews/](reviews/) に日付付き | 読んで決める。決めるまで変更は依頼しない |
| 変更して PR | 問い 1 つに答える PR | GitHub PR | テンプレートの 5 項目を読んで merge する |

報告を読まずに変更を依頼しない。変更の依頼には、報告のどの選択肢を採るかを書く。

## 5. PR の規則

- テンプレートの 5 項目（問い、変えたこと、変えなかったこと、測った数字、消し方）を日本語で埋める。AI が書いてよいが、所有者が分からない行があれば merge しない。書き直しを依頼する。
- 探索に触る PR は数字を貼る。分母は本番の対象である（所有者決定 2026-10-26 の 2 回目: 「今後は開発ベンチではなく普通に本番探索して止まったらバグ修正」）。同日の 1 回目の決定（開発セット 6 case × 3 run）は、次の切り分けのときだけに残す。
  - **本番の運転を記録する。** agent 入力（prompt 本文、契約節、Lab setup）に触る場合は、その版の本番対象での完了・停止理由、Finding / Lead、Lab の利用、時間と使用量を記録する。旧版と新版の交互運転、Trial 数の一致、比較による合否は求めない（ADR 0051 追記）。先行 Trial の数字は運転診断として示し、旧版に対する優位性とは扱わない。
  - **開発セットに戻す条件。** 本番で対象範囲内の Finding は出ているのに、人間の観測（`review observe`）の `match` が 1 週間 0 件のとき。このときだけ、答えの分かっている開発セット 6 case を回し、探索と検証のどちらが壊れたかを切り分ける。Finding が 0 件のときは探索の問題なので、本番の停止理由と `incomplete` の理由から直す。
  - **止まったら直す。** 本番の runner が止まった理由と、Finding の保留率・`incomplete` の理由の偏りは、[production-monitoring](agents/production-monitoring.md) で拾い、バグとして直す。
  - **探索 Lab の採否も本番で。** 開発セットの Lab arm（2026-10-26 の l14、6 Trial）は記録だけ残し、採否は本番で 1 arm 回して決める。

  運転の数字は、completed / incomplete と理由、scope 内 Finding / Lead / parked、人間の `match`、Root の wall、非 cache token を分けて読む。人間が読む件数に上限は置かず、列の長さを検証の並列数と確認票の供給を増やす合図に使う（所有者決定 2026-10-26）。過去の比較用 6 段は[当時の監査](reviews/2026-10-26-system-audit.md)第 B.3 節に残す。

  配線・runtime・選定の PR は runner が流した異なる slug の初回 3 Trial の completed・wall・停止理由で足りる。同じ slug の反復で件数を埋めない。未 merge branch で本番 runner を回すときは campaign ID に branch 名を含め、本番の分母に混ぜない。数字のない探索変更は merge されない。数字は M1〜M6（docs/reviews/2026-10-26-system-history-and-metrics.md 第 4 節）の名前で出し、版をまたいで同じ問い合わせで読めるようにする。
- 実験軸（分担、継続、prompt 変種など）は opt-in の設定ブロック 1 つと profile の file 1 つに閉じ、台帳の run 記録に軸を残す。消し方を PR に書く。
- agent に渡る文章（`src/profiles/wordpress/prompts/` の本文、`.claude/skills/` の本文、Harness が生成して渡す節の雛形: 出力契約、Run parameters、Prior research、Lab・Programme Boundary の節）を変える PR は、変更後の全文と日本語訳を PR 本文か `docs/reviews/` の文書に貼る。2026-10-13 に所有者は、出典対照表の採否と `owner-approved` の付与を AI に委任した（「採用するかどうかはあなたの方で決めてもらって構いません」「よしなにやってください」）。AI はラベルを付けるとき、委任を明記した PR comment を残す。出典に無い要素を足さない規則は変わらない。2026-10-18 に所有者は読了ゲートも外した（「owner-approved のラベルはいらないかも。結局、脆弱性を発見できるかどうかだからそっちで実験して結果がある程度わかるはず」、ADR 0032 の 2026-10-18 節）。所有者の全文読了は merge の条件ではない。AI は出典付きで採った要素だけを書き、要素を足さない。
- 1 PR は追加差分 500 行以内を目安にする（削除行は数えない）。超えるなら問いを分ける。
- open の PR（Draft を含む）が 3 本を超えている間は、新しい実装 PR を出さない。先に既存 PR を merge するか閉じる。所有者の読む量が生産速度の上限で、agent の数ではない。
- `owner-approved` ラベルは、2026-10-18 以降は次の path も含めて委任済みの AI が差分を確認し、委任 comment を付けて付ける: `docs/adr/`、`docs/SPEC.md`、`src/profiles/wordpress/prompts/trust-boundary-v2.md`、`src/profiles/wordpress/policy/campaign.json`、`src/profiles/wordpress/policy/programme-scope.md`、`src/profiles/wordpress/discovery/programme-impacts.ts`、`src/profiles/wordpress/verification/judges.ts`、prompt の目的文、`policy/selection.json`、`.claude/skills/`、出力契約の雛形、Verifier の victim 契約。所有者本人だけが付けるものは残っていない（外部行動の承認は不変条件 7 のとおり所有者）。adr-guard の仕組みと、どの path が対象かの一覧は変えない。所有者が読了ゲートを戻すときは ADR 0032 に 1 行足してこの項を戻す。
- CI の `pnpm check` と `pnpm build` が通る。`private-guard`（Private Evidence・提出 package の構成物・記録や画像・512 KiB 超のファイルを止め、文書に貼られた canary token・HTTP 捕捉・秘密鍵・session cookie も見る）と `adr-guard` も通る。

## 6. 正本の改訂

- ADR を書くのは「不変条件かモジュール境界が変わる」か「実測が既存の ADR と矛盾した」ときだけ。週 1 本まで。それ以外の案は末尾の「止めてある案」に 1 行で置く。`docs/adr/` を変える PR は `owner-approved` ラベル（2026-10-18 以降は委任済みの AI が付ける、第 5 節）が無いと CI で落ちる。agent に渡る文章を変える PR、`src/profiles/wordpress/policy/` と Programme Boundary の impact 分類を変える PR も同じ（第 5 節、ADR 0032）。
- SPEC や ADR と実態が食い違ったら、コードより先に ADR 1 本で改訂する。未コミットの変更を溜めない。
- 大きな設計変更（確定の方式、探索の構造）は、報告 → 所有者の決定 → ADR → PR の順。ADR のない大きな変更は merge しない。

## 7. 週末に見る数字

```bash
node dist/cli/main.js ledger funnel --campaign <id>
```

```bash
node dist/cli/main.js ledger usage --campaign <id>
```

```bash
node dist/cli/main.js ledger stops --since <起動日>
node dist/cli/main.js continuous status --state <dir>
```

見るのは、Trial 数と completed 率、Finding と Lead の数、source 候補の数、run wall の中央値、失敗理由の内訳（拒否、上限、skip）、token の合計。当たりが 0 のまま wall 中央値が上限より十分短ければ、次の問いは「なぜ早く終わるか」になる。

## 8. 止めてある案

着手しない案を 1 行ずつ置く。ADR にも Issue の milestone にもしない。再開の条件が満たされたら Issue にする。2026-10-13〜25 の一覧（旧 `docs/PARKING.md`、2026-11-01 に削除、tag `archive/pre-docs-rewrite-2026-11-01`）から、実施済みと前提の消えた行を落とした。

| 案 | 再開の条件 |
| --- | --- |
| WooCommerce を Lab の依存として常備する | 同じ前提不足が 3 回出たとき |
| LLM による候補の要約・順位付け skill | 週のレビュー batch が 6 時間を超えたとき |
| 重複照合 skill を Harness から自動で呼ぶ | 人間が skill で 10 件回して出力が安定したとき |
| Patchstack を第 2 の提出先にする（Programme Boundary を 2 本） | 提出候補が出た後、#175 の線で |
| review CLI の多機能を skill 側へ寄せ、CLI を機械向けの最小集合にする | skill 3 本が 10 件回って出力が安定したとき（ADR 0032 Q27） |
| 継続運転の journal / owner lease / host 共通 claim / crash reconciliation（`codex/issue-229-*`、`codex/issue-227-inventory-slice`、`codex/issue-228-cross-campaign-claims`、`codex/repeat-trial-approval`。branch は参照用に残し merge しない） | 第 2 provider が実動したとき、または実機で連続運転が 2 回止まったとき |
| 軽微な到達効果の事前保留（`codex/low-value-impact-gate`、#218） | review queue が週 15 件を超えたとき |
| 探索 prompt の A/B 事前登録（#201） | 方法を比べる問いを 1 つ定めたとき |
| WordPress プラグイン以外の対象を第 2 の Target Profile として追加する | WordPress 版の縦断ループが安定し、第 2 対象の固有要件が確認できたとき |
| Google Mantis など探索手法の切り替えを比較可能な戦略として扱う | 既定手法の実測分母ができ、比較する問いを 1 つ定めたとき |
| 運転ログから週 1 件の変更案を数字付きで出す skill `wbh-tune`（提案のみ、[報告](reviews/2026-10-15-software-factory-and-meta-harness.md)） | 継続運転の記録と人間レビューの転帰が十分に溜まったとき。1 週に 1 変更 |
| 探索入力を非信頼データと宣言する Harness 生成の固定節と、stdin 全体の digest を run-started と receipt に結合する（#270 項目 7） | source や README 由来の指示に agent が従った実例が 1 件出たとき |
| 提出操作全体の再送契約（提出記録・付随記録・再開位置を 1 つの操作 identity に結合、#270 項目 12） | 提出の再送で記録がずれた実例が 1 件出たとき |
| 同梱 release note など既知の修正履歴を除いた派生 source を provenance 付き Snapshot として固定する（#177） | 公開済み修正の記述を source から読んで候補を出した Trial が 1 件確認されたとき |
| Codex runtime で Root と子のモデルを別々に選ぶ（#418 の Codex 側） | 探索の token 使用量をモデルで下げる問いを 1 つ定めたとき |
| Harness の健全性指標（Trial ごとの観測値と、終了 event の無い停滞の検知、#332） | 0 件の理由を区別する必要が出たとき |
| Argus 型の深さ優先探索（chain mode、#528 で PRISM 型の幅優先を選んだ） | wide の候補の大半が段数不足で止まり、所有者が連鎖の検証を自分で回せると判断したとき |

