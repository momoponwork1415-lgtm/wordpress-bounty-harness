---
status: accepted
date: 2026-10-21
amends: 0031（段 1 で落とした Finding は Lab に回さないが、理由付きで一覧に残す）, 0035（skill による検証の前後に段を置く）
---

# 検証から提出までを 6 段に分け、所有者が手動で再現してから提出する（#441）

## 背景

本番の台帳（2026-10-21 時点）では、v8 の scope 内 Finding 51 件のうち runner の自動検証だけを受けたものが 39 件で、自動検証 40 回の `runtime-confirmed` は 0 件だった。handoff の skill 検証は 22 回で 3 件が判定器の結論に届いた（[設計課題の報告](../reviews/2026-10-20-design-issues-from-production-results.md) 3.1 節）。探索側は Finding を出しており、詰まっているのは検証と triage である（[公開ハーネスの共通点 5](../reviews/2026-10-21-public-harness-alignment.md) 2.5 節）。

所有者は 2026-10-21 に次を決めた。

- 探索方式の改善は、検証から提出までの流れが通ってから行う。探索は脆弱性を見つけている。残る問題はトークン使用量だけで、それはモデルの変更で扱う（#418 の実験で子を Sonnet にした。[記録](../evaluation/2026-10-21-child-model-experiment.md)）。
- 検証は段に分け、各段を skill で行う。結果の判定は所有者も手で確かめるので、自動検証が失敗し続けるよりは緩くてよい。ただし手順は明確でなければならない。
- 報告書は Patchstack の Submission requirements に揃える。過去の提出は所有者の提出フォルダ（Git 外）を参照する。
- 所有者が手動で再現し、中身を理解してから、フォーム入力の拡張機能で提出する。
- 提出先は報酬が出る先に限る。Wordfence が既存 VDP のため受け付けない対象は Patchstack か vendor に出す。
- 選定に Patchstack VDP の対象を含めてよい。

## 決定

受理した scope 内 Finding は、次の 6 段を順に通る。段ごとの skill と Issue は親 Issue #441 にある。

| 段 | 内容 | 受け持ち |
| --- | --- | --- |
| 1 | Wordfence の受理規則の文（所有者が持ってくる写し）に照らし、確実に受理されない前提の Finding を検証前に落とす。落とすのは、競合状態を要するもの、非現実的な前提を要するものなど、規則文が明示する種類に限る。受理が怪しい程度のものは落とさない。**2026-10-22 追記:** 段 1 は Finding ごとに提出可 / 提出不可と確度（高 / 中 / 低）を決め、対象ごとの表にして人間に示す。「確実に受理されない」は「両プログラムが受けないと読める」（`wbh-screen` v2 の条件 a〜g）に、「受理が怪しい程度のものは落とさない」（迷うものは Lab へ）は「五分五分なら提出可（確度 低）」に改めた。落とした Finding は従来どおり理由付きの一覧に残る（`harness review` に `reject (out-of-scope)` と出る）。**2026-10-23 追記:** 写しが条件付きで外す前提の型（競合、キャッシュ汚染、時間窓、設定に依る前提）は、ローカル Wordfence 履歴 mirror にある 2025 年以降の同じ型の公開記録（先例）を数えて決める。0 件なら提出不可（`wbh-screen` v2.1 の条件 h）、3 件以上なら提出可、1〜2 件なら提出可・確度 低。一律に外す型は従来どおり提出不可。あわせて、同じ slug の直近 6 か月の公開で、影響版が Snapshot の版を含むか 1 つ下で終わる同じ種別の記録があれば「回避 / 重複の候補」と注記し、Lab の前に修正差分を見る。段 4 の照合は変えない。**同日の 2 つ目の追記:** 前提が「古い版から更新した跡」か「外部サービスへの認証付きの接続」でしか作れない Finding は、受け渡しの Lab では前提が作れない。`wbh-screen` v2.2 の手順 7 でこれを注記し、次の一手を所有者の判断にする。提出可否は変えない | skill（#436） |
| 2 | 同じ Snapshot 内で同じ経路の Finding を群にし、群の代表から検証する。判定と提出の単位は Finding のまま | Harness の集合判定 + review の表示（#424） |
| 3 | Harness が立てた Lab で、種別ごとに明確な手順で再現する。被害者側の表示は Lab 観測器が行う。判定器が `incomplete` を返しても、観測（HTTP 記録、画面、動画）は review に届ける | skill `wbh-verify` v7（#437）、判定器は変えない |
| 4 | 同じ plugin の同じ版で公開済みの脆弱性が無いかを照合する。無ければ提出候補にする | skill `wbh-dedupe`（#442） |
| 5 | 提出先を Wordfence → Patchstack → vendor の順で決める。報酬が出ない先には提出しない | skill（#438） |
| 6 | Patchstack / Wordfence の要件に揃えた英語の報告書を書き、HTTP 記録・画面を添える。動画は実在する場合だけ添える。過去の提出を参照する | skill `wbh-report`（#439） |

その後、所有者が手動で再現して中身を理解し、自身の拡張機能で提出する。Harness は送信しない（不変条件 7）。

「緩くてよい」の読み方を固定する。

- 判定器の `runtime-confirmed` の条件（nonce 付き canary の回収、不変条件 3）は変えない。
- 緩くするのは結果による選別である。判定器が `incomplete` の Finding も、観測を付けてレビュー列に残す。落とすのは段 1 の規則文による篩と、段 4 の公開済み照合だけである。
- 段 1 で落とした Finding は Lab に回さないが、`finding-parked` と同じ要領で理由付きの一覧に残す。ADR 0031 の「全件がレビュー列に出る」は、この一覧を含めて満たす。

選定については、コードを変えない。選定の programme 判定は「Wordfence programme が plugin という資産種別を受け付けるか」というプログラム単位の確認で、対象ごとの VDP の有無では落としていない（`src/profiles/wordpress/selection/wordpress-selection.ts` の `programmeAcceptsAsset`）。対象ごとの除外は `excludedAuthors` の 7 社だけである。Patchstack にしか出せない対象は候補に入り、振り分けは段 5 で行う。

## 理由

- 自動検証は precondition で止まり続け、skill の handoff だけが判定器の結論に届いた。検証の中身を skill に置く ADR 0035 の方向と一致する。
- 段を分けると、各段の落とした件数と所要分を別々に測れる。詰まる段が分かる。
- 所有者が手動で再現する前提を置くと、検証の自動化を完全にする必要が無くなる。Harness は観測を漏れなく渡すことに集中できる。
- 報酬が出ない提出をしないのは、所有者の目的（LESSONS、月額の目標）に直接従う。
- 2026-10-22 追記: 本番の台帳で判定の無い Finding 93 件に段 1 の v1 を当てたところ、提出不可 0、条件付き 49、可 44 で、1 件も落ちなかった（#436 の 2026-10-22 のコメント）。3 値の形は、判断を先送りしただけだった。所有者は「ここに関しては人間にわかりやすく表示するとこまで責務にしたい。もうこの段階で提出可否を決める」と決めた。
- 2026-10-23 追記: 写しの条件付きの文（「容易に再現できない競合」「影響が示せないキャッシュ汚染」「管理者の誤設定」）は、文だけでは当否が決まらない。運用者が 2026-10-23 に mirror で先例を数えると、設定依存の stored XSS の受理は 63 件、競合は 16 件（stored XSS では 0）、一時保存に残る stored XSS は 16 件、キャッシュ経由の認証回避は 2 件、開発者モード依存・管理者の操作から始まる時間窓・ピンバック経由は 0 件だった。所有者はこの数で基準を決め、0 件の 3 群 8 件を提出不可にして reject を記録した（#436 の 2026-10-23 のコメント）。公開記録は受理だけを示し、却下は示さないので、0 件は弱い証拠として扱う。同じ slug で 1 つ下の版に直近の公開がある対象が 4 つあり、Lab の前に修正差分を見ないと、修正の回避か既知の再発見かが分からない。そのため重複照合の一部を段 1 に前倒しした。

## 採らなかった選択肢

- 判定器の条件を緩める（agent の自己申告や観測器の表示結果を `runtime-confirmed` にする）。不変条件 3 に反する。「緩くてよい」は結果による選別の話として読んだ。
- 段 1 を Harness のコードにする（前提の文から種類を選ぶ正規表現）。判断を含むので skill に置く（AGENTS.md「Harness と AI の責務」）。
- 段 3 の前に探索方式を直す。所有者が後回しにすると決めた。
- 選定に Patchstack VDP 用の採点や gate を足す。現状で落としていないので不要である。

## 帰結

- Step 2「レビュー側と検証側の作り込み」を、Step 1 の判定（#238、2026-10-27）を待たずに始める。DEVELOPMENT.md 第 2 節に追記した。
- Patchstack の Submission requirements の写しを `src/profiles/wordpress/policy/patchstack-submission-requirements-2026-10-21.md` に置いた。Wordfence の受理規則の写しは所有者から届いたら隣に置く。
- 過去の提出フォルダは Git 外に置いたまま参照する。Git、Issue、PR、会話に写さない（不変条件 8）。
- 2026-10-21 の merge（#419、#434、#413）は所有者が門を免除した 1 回限りの扱いで、以後は `docs/agents/pr-review-merge.md` の門に戻る。
- 段ごとの結果（落とした理由、群、判定器の結論、照合の 3 値、提出先、文案の digest）は review export か台帳に残し、本文は Private Evidence に置く。

## 消し方

- 段 1 と段 5 の skill を消し、全件を Lab に回して Wordfence だけに出す形へ戻す。
- 段 1 の 2026-10-22 追記だけを戻すときは、`wbh-screen` を `versions/v1.md` の 3 値に戻し、`wbh-review` の手順 8 と出力 1、OPERATIONS §3 の 0 を元に戻す。記録済みの reject は、`defer` などの判断を記録すれば handoff 列に戻る。
- 段 1 の 2026-10-23 追記だけを戻すときは、`wbh-screen` を `versions/v2.md` に戻し、OPERATIONS §3 の 0 の先例の文を消す。
- 段 2 は #424 の消し方（群の識別子を読まない）に従う。
- 本 ADR を `superseded` にし、ADR 0031 と 0035 の該当行を元に戻す。

## 2026-10-23 追記: 段 3 の skill を v6 にする

本番の受け渡しを 1 日に 4 回行い、判定器の結論まで届いたのは 2 回だった。届かなかった 1 回の理由は、canary を含む要求を 2 本送って 1 本しか `route.json` に書かなかったことで、判定器は「canary を含む要求が、完了した route step と一致しない」を返した。もう 1 回は、前提が外部のサービスへの接続を要し、Lab から外へ出られないための `incomplete(precondition)` である。

v6 は、判定器が照合する条件を skill 本文に書き足した。足したのは、形を試す要求を `setup-done` より前に送ること、canary を含む要求を 1 本に限ること、本文を 1 バイトも違わずに書くこと、`headers` は書かなければ照合されないこと、`unauthenticated` では `x-wp-nonce` と不定の cookie を送らないこと、被害者の画面と入力に token を書かないことである。`route.json` の行には、表に無かった `account` と `configurationChanges` を足した。この 2 つが欠けると schema に通らず、攻撃者位置の誤りとして報告されるので、別の問題に見えていた。

判定器と Harness のコードは変えていない。足したのは、コードが既に求めている条件の説明である。

## 2026-10-23 追記 2: Lab で前提が作れない 2 つの型を段 1 で見分ける

本番の受け渡しを 1 日に 13 回行い、3 回が前提の不足で終わった。内訳は、プラグインを外部の画像サービスに接続した状態を要するもの（2 回、同じ Finding）、古い版だけが書く設定の跡を要するもの（1 回、その Finding は通算 2 回）、外部サービスの鍵で開く画面でしか作れない行を要するもの（1 回）である。どれも操作役が実測で理由を確かめ、`precondition` に書いて中断した。前提を偽って作る道は選んでいない。

この 2 つの型は、`finding.configurationPrecondition` の文から Lab を立てる前に見分けられる。見分けを `wbh-screen` v2.2 の手順 7 に置いた。注意に「Lab 不可（更新の跡）」か「Lab 不可（外部サービス）」と書き、次の一手を「所有者の判断（Lab の前提を用意するか、手で再現するか）」にする。

**提出可否は変えない。** Lab で確かめられないことは、提出できないことではない。所有者は自分の環境で、更新を経たサイトやサービスの鍵を使って再現できる。段 1 が落とすのは、規則の写しが受けないと読める Finding だけである。

Lab の側で前提を用意する道（サービスの代役を固定して置く、更新後の状態を scenario として供給する）は、所有者が決めることとして残す。Harness のコードに「このプラグインならこの前提」を入れるのは、責務の境界の外にある（AGENTS.md の削除の節）。

## 2026-10-23 追記 3: 段 3 の skill を v7 にし、canary の受け口の契約を書く

受け渡しを 16 回行い、2 件が「被害者画面は開いたが beacon が来ない」で終わった。診断の形は 2 件とも同じで、canary の属性は描かれた文書にあり、4xx が 1 件出ていた。原因は運び手である。どちらの操作役も beacon の URL を属性に持たせて handler の中で要求を自分で組み、header を付けなかった。canary の受け口は、`/b/<token>` への POST で header の値が token と一致するものだけを記録し、それ以外は 403 を返す。

片方を、Harness が渡す `canary.javascript` を 1 文字も変えずに実行する形でやり直したところ、7 分で `runtime-confirmed` が出た。変えたのは運び手だけである。

v7 は、この受け口の契約と「自分で組まない」を `stored-xss` の手順 1 に書いた。判定器と受け口のコードは変えていない。

## 2026-10-23 追記 4: 暫定文案を先に作り、人間の確認を最後に置く

所有者は、検証に時間がかかる現状を踏まえ、6 段の結果から AI が英語の暫定文案と添付一覧まで用意し、その後に人間が手動で再現して文案を査読する順を選んだ。当面は Wordfence 向けの報告でこの経路を通し、Patchstack 向けの追加自動化は報告が増えてから扱う。段 1 の結果で `reject` を記録する操作、検証後の重複・scope・提出先の照合、暫定 `accept` の記録も AI 操作役が所有者に代わって担う。上の段 1 に残る「所有者が記録する」という当時の運用は、この追記で置き換える。各 skill の判断方法は変えず、旧運用を記す skill 本文の版更新は別 PR で行う。AI の中間判断に人間の作業時間を付けず、提出前の人間査読と区別する。

`wbh-report` は、判定器と Lab が残した事実だけを使い、Wordfence 向け英語 Markdown、フォーム入力用 JSON、添付一覧と manifest を Private Evidence に暫定版として作る。今回の Wordfence 向け経路は `runtime-confirmed` の Finding に限る。Review API は `reproduced` も人間の再現より先に `review draft --prepared-by ai` で保存できるが、この skill の経路には含めない。`incomplete` は観測と次の手を review に残すが、提出用の文案としない。重複が `possible-match` / `unavailable`、scope が `ambiguous` の場合も根拠不足として止める。6 段を起動・引き継ぐ自動 orchestrator はまだ無く、AI 操作役が skill と CLI を順に実行する。

最新版の再検証で新しい Target Snapshot になれば、元 Finding とは別の派生 Finding ID が作られる。AI は `review reverify` の出力 `as <findingId>` を受け取り、その ID で `wbh-review`、重複照合と暫定 `review decide`、scope 評価、提出先選択、報告書作成をやり直す。元 Finding の暫定判断や重複結果は継承しない。元 Finding の文案は、この派生 Finding が記録された時点で承認と提出へ進めない。同じ Snapshot での再試行は元 ID のまま扱う。

人間は暫定版を受け取ってから Lab で再現し、同じ検証 ID と再現パッケージ digest に対する `match` を記録する。続けて本文・手順・版・影響・添付・送信先を査読し、Markdown、JSON、manifest の最終版を作って `review draft --prepared-by human` で文案を保存する。その版の保存と手動再現より後に、同じ人が `review decide --decision accept` を記録する。`review authorize` と提出時の admission は、最新の文案が人間の最終版で、最新の再現が `match`、最後の判断が同じ人の `accept` であること、および Candidate・文案 digest・送信先の一致を要求する。`mismatch` / `unavailable`、新版の保存、後続の否定判断、後続の検証や同じ Finding の最新版再検証では、旧文案の承認を通さない。CLI の `human` 属性と `--by` は本人認証ではないため、AI は手動再現・人間の最終版・最終 `accept`・承認のコマンドを代行しない。送信は引き続き人間が行う。

## 2026-10-23 追記 5: Wordfence 候補を保守的に選ぶ

所有者は、検証に時間がかかるため、未確認の Finding も先に読んで Wordfence の受理基準に照らし、Lab に時間を使う候補を悲観的に選ぶと決めた。段 1 の `wbh-screen` を v3 にする。判定は `Wordfence 候補として採用 / 非採用` の二値で、`保留` を新しい状態としては設けない。これは v2.2 の `提出可 / 提出不可` と同じ意味ではなく、技術的な真偽、正式な programme scope、提出許可のいずれも決めない。

`採用`には、Finding の主張に攻撃者からサイトまたは別利用者への実害までの具体的な経路、通常の前提、Wordfence の資産・install 閾値・役割・最終影響との整合が要る。`stored-xss` 等のラベルだけでは足りない。`not-verified` または `incomplete` 自体を非採用の根拠にしない。明示除外、重要な辺の記述欠落、近接する公開修正との独立性未証明は `非採用` とし、理由を分け、再評価に必要な証拠を 1 つ書く。Lab で前提を作れないこと自体は受理見込みを変えず、準備か手動確認を別の次の一手として残す。公開履歴 mirror は報奨採否の台帳ではなく、`informational=0` の中にも Wordfence 報奨範囲外の Contributor+ の記録がある。条件付き前提の近い公開記録は直近 6 か月で数え、0 件も 3 件以上も採否の閾値に使わない。これにより 2026-10-22 の「五分五分なら提出可」と 2026-10-23 の「先例 0 件なら提出不可」という段 1 の規則を置き換える。

`非採用` は Wordfence 向けの検証投資の判断なので、Programme Boundary 全体の `out-of-scope` や Finding の `contradicted` に読み替えない。段 1 は `review decide --decision reject` を実行・提案しない。`verify next` の列は変えず、操作役は v3 の `採用`を Finding ID で名指しして Lab に回す。v2.2 で既に記録された `reject` はこの変更だけでは書き換えず、名指しの再評価で判断が変われば新しい `defer` decision として記録し、handoff 列へ戻す。報告と個別メモは版・時刻付きで Private Evidence に残し、後段の判定器、重複、scope、暫定文案、人間の再現と承認の門は変えない。当面 Patchstack の候補選別は後回しにする。条件付き公開記録の傾向を見る窓は直近 6 か月だが、同じ slug の既知修正との照合は mirror の全期間を使う。近い修正の独立性は別工程で source 差分を比較した非公開メモを、ID・Snapshot・版・入力面を照合してから v3 に渡す。

v3 を戻すときは `versions/v2.2.md` を skill 本文に戻し、OPERATIONS §3 の段 0 と `wbh-review` の段 1 の読み方を戻す。旧版の結果を新しい判断として流用しない。

## 2026-10-24 追記 6: 明示除外だけを検証前に分け、検証の到達を優先する

所有者は、段 1 の保守的な `採用 / 非採用` が、未確認の通常構成、実害、再現性、既知修正との関係まで検証前に判断していたため、方針を改めた。段 1 の `wbh-screen` v4 は `検証へ / 明示除外` の二値とする。これは追記 5 の採用基準を置き換える。`明示除外` は Wordfence の規則が一律に外す条件と、その Finding の確認できた事実が直接一致する場合に限る。規則の条件句を満たすか未測定、主張の辺が欠ける、通常構成が不明、ミラーが無い、近接する既知修正があるだけの場合は、未解決事項を付けて `検証へ` にする。時間窓、競合、任意機能の有効化を名前だけで除外しない。

公開履歴の件数と同じ slug の記録は、段 1 での除外条件にしない。修正回避や重複は段 4 で経路と差分を照合する。通常構成、被害者への実害、競合の再現性、最新版での成立は Lab の観測を得てから Wordfence の条件付き除外と照らす。`検証へ` は脆弱性や受理の確認ではない。段 1 は技術判定も programme 全体の対象範囲も変更せず、台帳の `reject` を書かない。Wordfence 以外の提出先は後段で判断する。

旧版の `reject` は、各 Finding を新基準で再評価し、明示除外でなければ新しい `defer` 判断を追記して通常の検証列へ戻す。旧判断は削除しない。探索時の Programme Boundary による `finding-parked` の 10 分類と、明示された特別な管理者設定の規則は変えない。群の代表から検証しても、群内の Finding は保持する。

次の作業は判定器の条件変更より、検証が判定器の結論に届くことを優先する。まず公開済み開発対象の Brizy / TranslatePress を現行 `wbh-verify` で受け渡し、所要時間、`runtime-confirmed` / `contradicted` / `incomplete`、未完の理由を #352 に記録する。前提・観測・手順の不足は各原因に絞って直す。nonce 付き canary、Snapshot digest、一時 Lab と `incomplete` の扱いは SPEC 第 2 節のまま維持する。判定器の条件を緩めて通過数を増やさない。

## 2026-10-24 追記 7: 操作が必要な出口を一律に除外しない

代表 22 件の受け渡しで、ある stored XSS 候補を 2 回試した。1 回目は被害者画面への遷移に失敗し、2 回目は保存値が属性まで届いたが、click を宣言せず beacon を観測しなかった。この 2 回から分かるのは、その手順で発火を観測できなかったことまでであり、操作後にも発火しないことではない。

`target="_blank"` の anchor は通常 opener を持たないが、HTML Standard は `rel=opener` を明示的な例外として定める。Mozilla の公開記録にも、`download` または `rel=opener` が付いたときの JavaScript 実行が記されている。したがって、`target="_blank"` の `href` にある `javascript:` を属性名だけで「原理として成立しない」と決めて click を省くと偽陰性になり得る（[HTML Standard](https://html.spec.whatwg.org/multipage/links.html#link-type-opener)、[Mozilla Bug 1863882](https://bugzilla.mozilla.org/show_bug.cgi?id=1863882)）。

`wbh-verify` v8 は、固定ソースと前提作り中の Lab の HTTP 応答で出力形を確認し、通常の操作を要する出口は型付き `victim.actions` に宣言して Harness の Lab browser で観測する。`setup-done` 後に管理者資格は再利用しない。値がサニタイズで消えるなど具体的な否定根拠があれば、入力・保存・描画のどこで落ちたかを `refutation.md` に記す。canary 不着だけで反証と断定せず、判定器の条件は変えない。この確認は段 3 で行い、段 1 の明示除外条件を増やさない。

## 2026-10-24 追記 8: 設定前提の文言では検証を止めない

追記 6 の「明示除外だけを検証前に分ける」を、探索候補の入口と handoff の直前にも適用する。追記 6 末尾の「明示された特別な管理者設定の規則は変えない」をこの決定で上書きする。`configurationPrecondition` に管理者が機能を有効化したと書かれているだけでは、Wordfence の「管理者の誤設定」や「低権限者への明示的な権限付与」と一致すると決められない。`admin-configuration` の分類は準備と後段の確認事項として残し、分類だけによる `finding-parked` と transport 前の中止をやめる。Lab で作れない前提は理由を付けた `incomplete(precondition)` としてレビュー列へ残す。

旧規則で入口 park された Finding は、Private Evidence の原本と Snapshot・identity・Programme Boundary を照合してから追記専用の復帰 event で検証列へ戻す。影響分類そのものが Programme Boundary 外の Finding と、検証中に park された Finding は、この復帰操作では戻さない。本番 runner が旧台帳 schema を使っている間は新しい event を共有台帳へ追記せず、runner 更新後に行う。復帰によって受理可能・脆弱性・提出可能と認定したことにはならない。

根拠は 2026-10-24 に確認した [Wordfence の公式規則](https://www.wordfence.com/bug-bounty-program-terms/) の「Environmental/Configuration-Based Issues」と管理者による明示的な権限付与の条項。通常の機能有効化を一律に除外する文はない。Finding に明示除外に当たる事実が既にあれば段 1 で分け、まだ確かでなければ誤設定かどうかと低権限の攻撃者に届くかを Lab で確認する。判定器の nonce canary・Snapshot digest・`incomplete` の条件は変更しない。

## 2026-10-24 追記 9: 発火の観測から人間向け内部プレビューを作る

所有者は canary の確認に時間がかかる場合、Harness 所有ブラウザで dialog を観測した事実を先に記録し、人間が後で手動再現する経路を選んだ。追記 4 の「`incomplete` は提出用の文案としない」は維持する。現在の `verification-finished` が `incomplete(observation)` でも、同じ Snapshot と Lab Setup に結び付いた Harness 所有ブラウザの dialog、同一検証内の setup 後の Harness 捕捉攻撃要求との marker 一致、その要求から被害者画面の訪問までの順序、別の被害者 principal を確かめた場合に限り、`wbh-report` は Wordfence 用の**登録しない内部プレビュー**を Git 外 Private Evidence に作れる。これらの一致と順序は因果関係を証明しない。人間が既存コンテンツによる dialog の可能性を調べるまで、攻撃による発火や脆弱性の再現成功と断定しない。ブラウザを開いたこと、クリック、画面内の文字列、Verifier の自己申告は dialog 観測の代用にならない。

内部プレビューには観測した事実と未確認事項を分けて書き、フォーム入力用 JSON は必須値に根拠が揃う場合だけ `human_verification.status: pending` で添える。動画は実在する場合だけ扱う。この経路から `review draft`、`submission-package/v1` manifest、Submission Candidate、外部承認・送信へは進めない。現行の `lab up --for-review` も確認済み再現パッケージを要する。canary を使わず人間の再現だけで正式な提出経路へ進める場合は、手動確認用 Lab とその記録、scope・文案・承認の basis を別途設計する。`runtime-confirmed` の nonce 条件、digest 不一致の `incomplete`、人間の最終査読と外部行動の承認は変更しない。

## 2026-10-24 追記 10: 判定器の役割と提出準備の到達点を固定する

所有者は、canary の回収に検証時間を費やすよりも、Harness が捕捉した発火を事実として残し、人間が手動で成立を確かめる方針を選んだ。提出準備の到達点を、**公開中の最新版の同じ Target Snapshot、通常の公開サイトで使う構成での人間の手動再現 `match`、解決済みの重複照合と Wordfence scope、証拠に基づく英語報告書と Fill-Only JSON、人間の最終査読に渡せる状態**とする。当面は Wordfence を主な提出先とし、Patchstack 向けの追加実装は報告が増えてから扱う。動画は必須としない。人間の手動再現は既存の「提出前のレビュー」に含め、人間による未検証候補の採否ゲートを増やさない。

判定器は引き続き必要である。Harness が所有する HTTP・ブラウザ観測と Snapshot / Lab Setup digest、攻撃者と被害者の主体、手順の順序を整合させ、agent の自己申告を事実と取り違えないために使う。ただし、観測器の dialog、marker の一致、画像だけから脆弱性成立を自動認定しない。`runtime-confirmed` を出す条件は nonce 付き canary の回収のままとし、この強い自動証明を人間の手動再現経路の前提にはしない。通常利用か、被害者への影響が十分か、Wordfence の条件付き除外に当たるかは、観測と公開資料を使って skill と人間が判断する。

有効な手順と同じ最新版 Snapshot で人間の再現が `mismatch` なら、その候補は提出へ進めない。原因の調査や新しい検証の記録はできる。環境、手順、観測、証拠の不足で再現不能なら `incomplete` / `defer` と次の手を残し、否定や棄却にしない。どちらの場合も、軽量観測を `runtime-confirmed` に格上げしない。探索出口で `finding-parked` にする既存の 10 impact 分類はそのまま維持する。

追記 9 の内部プレビューはこの到達点の前段であり、`human_verification.status: pending` の JSON を拡張機能で提出させない。現在の `review reverify`、`lab up --for-review`、scope / draft / Candidate の契約は `incomplete` の手動再現を正式な提出根拠として受け付けない。手動 Lab の再構築、同じ Snapshot の人間の `match` と捕捉証拠の結合、重複・scope・文案・承認が参照する basis は、別 PR で実装し受入試験を通す。それまでは内部プレビューを正式な文案や提出候補と呼ばない。既存の confirmed 経路と funnel 集計はこの決定だけでは変えない。

進捗は `runtime-confirmed` の件数を提出完了の代理指標にせず、上記の再現・重複・scope・報告書・Fill-Only JSON・最終査読の準備が揃った Finding 件数で見る。外部送信は従来どおり、正確な Submission Candidate、文案 digest、送信先に結び付いた所有者の承認を要し、Harness は送信しない。

## 2026-10-25 注記（#525、所有者決定 2026-10-25）

追記 10 の「判定器は引き続き必要である」と「`runtime-confirmed` を出す条件は nonce 付き canary の回収のまま」は、[ADR 0040](0040-human-lab-observation-replaces-judges.md) で置き換えた。判定器は削除し、段 3 の結果は `incomplete(awaiting-human-observation)` になる。観測器の dialog、marker の一致、画像だけから成立を自動認定しないことは変えない。正式な文案・提出候補へ進む basis は、人間の `review observe` の `match` と `review decide --reproduced match` にした（ADR 0040 の 2026-10-26 追記）。

## 2026-10-26 追記 11: Programme Boundary の文から管理者設定の除外を外す

PR #524 のマージ前レビュー（2026-10-26）で、`src/profiles/wordpress/policy/campaign.json` の `programmeBoundary.text` が、対象外の最後に「an administrator's explicit configuration or grant of permissions」を残していると分かった。これは追記 8 の「設定前提の文言では検証を止めない」と食い違う。目的プロンプト v10 の「Behaviour that depends on a plugin setting an administrator can enable is in scope when a typical site may plausibly enable it; state the setting as the precondition.」とも食い違う。探索エージェントには両方の文が渡る。

Programme Boundary を `wordfence-2026-10-26` 版にし、その節を次の文に直す。「routes requiring Contributor, Author, Editor, Shop Manager or Administrator, or a permission an administrator explicitly grants. A plugin setting an administrator can enable is not an exclusion when a typical site may plausibly enable it; the Finding must state the setting as the precondition.」冒頭の改定日と版のほかの語は変えない。旧文は過去 Trial の照合のため `docs/knowledge/programme-boundary-wordfence-2026-10-17.md` に残す。SPEC 第 8b 節の表の「管理者の明示設定を信頼側に置く」も同じ意味に揃える。

変えないもの: contributor 以上と、管理者が意図して付与する権限は trust 境界の内側に置く。`options-update` は対象外のままとする（所有者、2026-10-26）。探索出口で `finding-parked` にする 10 の impact 分類は、ADR 0032 の 2026-10-17 節のまま変えない。Wordfence の「管理者の誤設定」の除外は、追記 8 のとおり段 1 と検証で事実を確かめて当てる。判定器の条件も変えない。

消し方: `campaign.json` の `programmeBoundary` を `docs/knowledge/programme-boundary-wordfence-2026-10-17.md` の文と `wordfence-2026-10-17` 版に戻し、`tests/profiles/wordpress/programme-impacts.test.ts` の版と追加した 3 行、SPEC 第 8b 節の表の行を戻す。

## 2026-10-26 追記 12: 観測の場所（#600）

所有者決定 2026-10-26（3 回目のグリル）: 人間の観測は、operator が `observation-ready` まで進めた**検証 Lab そのもの**で行う。`lab up --for-review` の review Lab は package の初期設定（siteTitle / initialPosts / customerRole / databaseAccess）だけから作るので、検証中に skill が作った前提（フォームの作成、外部サービスに接続済みの状態など）が入らない。そのため、捕捉した要求を 1 本送っても発火しなかった（operator の報告、2026-10-26）。検証 Lab には前提も payload も残っている。

- `verify next --handoff` は、attempt を `incomplete(awaiting-human-observation)` として台帳に記録し、Harness の捕捉と review Lab package があれば、その Lab を落とさずに残す。残すのは `lab down`、中断（SIGINT / SIGTERM）、wall のどれかが来るまでである。wall は handoff と同じ長さ（30 分）で、記録の時点から数える。
- 残した Lab は review Lab と同じ方法で host に公開する。recorder を経由し、`127.0.0.1:80` を優先し、使えなければ空いている port を使う。出力には、接続先、hosts の 1 行（`127.0.0.1 wordpress`）、攻撃者 account、`setup-done` で作り直した Lab の管理者（人間の被害者側の操作に使う）、`manual observation receipt`（`review observe --receipt` に渡す digest）を出す。
- receipt は従来の `manual-observation-lab-ready` として、記録済みの attempt の review Lab package に結び付けて封じる。`review observe` は、検証 Lab の receipt も review Lab の receipt も同じ規則で受ける。数えるのは最新の ready より後の観測だけである。`manual-observation-recorded` には、どちらの Lab で観測したかを `labKind: verification | review` として型付きで残す。値は Private Evidence の receipt から取り、台帳には型の値と digest だけを置く（不変条件 8）。`labKind` の無い既存の event は review Lab として読む。
- Lab の記録は state dir の `review-lab.json` を共有し、`labKind: "verification"` を付ける。`lab down` は review Lab と同じ手順で持ち主の `verify next` に SIGTERM を送り、その後、残ったものを Lab id で消す。1 つの state dir で人間のために残せる Lab は 1 つである。すでに記録があるとき、または捕捉・package・公開・管理者のどれかが欠けたときは、Lab を残さずに従来どおり消し、理由を 1 行出す。
- 変えないもの: gVisor と loopback だけの公開（不変条件 2）、失敗の `incomplete`（不変条件 4）、`verification-finished` を書き換えないこと、確定の根拠が名指しした人間の `review observe` の `match` と `review decide --reproduced match` だけであること（ADR 0040）。AI 操作役は、記録後の Lab を操作しない。また、`review observe` も打たない。review Lab は、後日の再観測のために残す。
- ADR 0040 の「名指しした人間が新しい review Lab で記録した」は、この追記で「検証 Lab か新しい review Lab で記録した」に読み替える。skill 本文（`wbh-verify`、`wbh-review`）の該当行は #595 で直す。

消し方: この追記の PR を revert する。Lab は attempt の記録の前に消える経路に戻る。`labKind` を持つ `manual-observation-recorded` は旧版の台帳 schema では読めないので、revert の前に扱いを決める。

## 2026-10-26 追記 13: 申告欄の値で出口 park する（#613）

所有者決定 2026-10-26: (a) 偽陽性は探索プロンプトではなく出口の park で抑える。(b) 抑える型は 2 つある。「管理者が脆弱な設定を作らないと成立しない」型と、「sink はエスケープされていないが、攻撃者に入力の経路が無い」型である。(c) 外部サービスを経由する経路でも、攻撃者が公開の経路で書き込めれば対象に残す（所有者:「外部サービスでもいいが、SNS など書き込めればいい」）。所有者が以前に提出して報酬を得た Finding（custom-facebook-feed 4.13.0、[measurement.md](../agents/measurement.md) の表）は、誰でも書ける公開 Facebook ページのコメントが Graph API を通って管理画面の preview に入る経路だった。分けるのは「外部サービスに接続しているか」ではなく、攻撃者がそのサービスに公開の経路で書けるかどうかである。スキャナの結果、脆弱性データベース、API の応答本文のように、ベンダーや第三者だけが書くデータを握らないと届かない経路を「入力の経路が無い」型とする。(d) 文の規則は試して退けた。判断はエージェントが宣言した enum で行い、Harness は enum の値だけで park する。(e) 台帳で reject などになっているものが偽陽性である（所有者:「台帳で reject などになっているものが FP です」）。2026-10-18 以降の直近の reject 16 件のうち 6 件は、時間に頼る連鎖だった。transient の 24 分の窓、管理者の操作から 5 分の捕捉の窓、2 つの PHP worker の競合と、それぞれと根が同じ重複である（所有者の理由: `owner-excluded-24-minute-embed-precondition`、`five-minute-admin-capture-window`、`owner-excluded-race-dependent-precondition`）。Wordfence の先例で、競合やキャッシュに頼る XSS が受理された数は 0 である。これを 3 つ目の型とする。

文の規則を退けた理由: `admin has created|authored|added …` の規則は本番の Finding 167 件のうち 28 件に当たった。そのうち 4 件は runtime-confirmed で、管理画面の列を足す、ポップアップに自前のショートコードを置く、スニペットに変数を置く、という管理者の通常の機能利用だった。Wordfence の先例でも「設定依存の XSS」として 63 回受理されている型である。外部サービスの規則（PR #615、閉じた）は「接続済み」「攻撃者が … API を握る必要がある」という同じ文で、公開のコメントが入る経路とベンダーのデータにしか入らない経路の両方に当たった。どちらの境も判断であり、Harness の規則にすると「判断の要らない処理だけをコードにする」（AGENTS.md の Harness と AI の責務）を越える。

決定:

- WordPress の Finding schema に、任意の申告欄を 3 つ足す。`configurationClass` は `default` / `ordinary-feature-use` / `admin-authored-unsafe-content` / `admin-setting-change` / `developer-mode` のどれか、`attackerInputPath` は `direct-request` / `own-account-data` / `public-third-party-content` / `vendor-controlled-data` のどれか、`exploitTiming` は `any-time` / `time-window` / `race` のどれかである。各値の 1 行の説明は schema に書き、出力契約の節（ADR 0019）はそこから生成する。目的プロンプトの本文は変えない。
- 契約節は `wordpress-discovery-contract-v5` にする。新しい Trial を起こせる行（`wp2shell-bounty-v11`、`v16-wide`、candidate の `v15-wide`）は v5 を受け取る。archived の行（`v14-wide` を含む）は、記録した digest のとおり v4 のままにする。v1 / v2 / v4 は申告欄の無い schema から作るので、本文も digest も変わらない。過去 Trial の `contractDigest` はそのまま照合できる。
- 出口では、Programme Boundary の park（`outside-programme-boundary`）を先に見る。その次に、`configurationClass` が `admin-authored-unsafe-content` / `admin-setting-change` / `developer-mode` の Finding、`attackerInputPath` が `vendor-controlled-data` の Finding、`exploitTiming` が `time-window` / `race` の Finding を、reason `declared-precondition` で `finding-parked` にする。`finding-parked` の `declaredPrecondition` には、申告した enum 値だけを残す（不変条件 8）。`ordinary-feature-use`、`public-third-party-content`、`any-time` の Finding は、従来どおりレビュー列に入る。`vendor-controlled-data` は、所有者の screen-out（2026-10-26、新しい Finding 85 件のうち攻撃者が入力を制御できない 46 件）に合わせて、サービスのベンダーのほか、サイト自身や管理者だけが書くデータ（固定のフィード、公式の翻訳パック、管理者が走らせた検査の出力など）まで含める。値の名前は変えない。
- 欄は任意とする。申告の無い Finding は park も保留もしない（ADR 0018）。申告の無い Finding と旧 evidence は「未申告」として読む。enum に無い値を書いた候補は、ほかの欄と同じく `candidate-held` になる。
- `declared-precondition` の park は、旧規則の park と同じく `review restore` で戻せる。`review parked` は reason の後に申告した値を並べる。`review export` は 3 つの欄を出す（申告が無ければ null）。

追記 8 との関係: 追記 8 の「設定前提の文言では止めない」はそのまま残す。この追記で park するのは、エージェントが申告欄で選んだ値である。Harness は `configurationPrecondition` の文を読んで park しない。文言の分類（`default` / `common-usage` / `admin-configuration` / `unknown`）も変えない。

変えないもの: 10 の impact 分類の park（ADR 0032 の 2026-10-17 節）、確定の根拠（ADR 0040 の人間の観測と `review decide --reproduced match`）、探索プロンプトの目的文（所有者 2026-10-26「広く報告して review で落とす」を上書きしない。park した Finding は `review parked` に残る）、`configurationPrecondition` の自由文。

計測: 本番ランナーの再起動の後に、新しい Finding のうち 3 つの欄をすべて申告した割合と、`declared-precondition` の park の件数を見る。2026-10-26 の Finding 9 件を手で当てると、スキャナ / 脆弱性データベースの 4 件は `vendor-controlled-data`（park）、WAF ログの 2 件は攻撃者自身の要求が残るので `public-third-party-content`（レビュー列）、配信サービスの 3 件はエージェントの申告次第になる。時間に頼る 6 件の reject は、`time-window` か `race` を申告すれば park に回る。

消し方: `candidate-admission.ts` の `declared-precondition` の分岐と `finding.ts` の `wordPressDeclaredPreconditionPark` を消し、`review restore` の受け入れを旧 reason だけに戻す。prompt 表の 3 行（`v11`、`v16-wide`、`v15-wide`）を v4 の契約に戻せば、エージェントに欄が渡らなくなる。schema の 3 つの欄は、記録済みの Finding を読むために optional のまま残す。台帳の enum の `declared-precondition` と `declaredPrecondition` も、park 済みの event を読み続けるために残す。

## 2026-10-27 追記 14: 段 1 と段 2 の間にソース読み直しの段 1b（`wbh-source-check`）を置く

所有者決定 2026-10-27。探索の目的文で偽陽性を絞ると出力そのものが減る（ADR 0039 の 2026-10-27 追記 11）ので、目的文は広く報告する v16-wide に戻し、偽陽性は後段で落とす。落とす段は、探索エージェントの主張ではなく固定ソースを根拠にする。段 1 は review export の欄と規則の写ししか読まない（2026-10-23 追記 4）ので、別の段にする。

- 段 1b の skill `wbh-source-check` v1 は、Finding ごとに固定ソース（対象、依存、WordPress 本体）だけを読み、2 つの問いに yes / no / unknown で答える。入力支配（低権限の攻撃者が典型的なサイトでその値を置けるか。ベンダー、管理者、公式 feed にしか置けない値は no）と、到達性（既定かもっともらしい設定で sink に届くか。管理者が安全でない形で自分で書く設定は no）である。両方 yes で `成立`、どちらか no で `不成立`、必要なソースが Snapshot に無ければ `未決`。
- 対象ごとに agent 1 体、1 単位 10 件まで。実行も通信もしない。台帳には書かず、`不成立` の `review decide --decision reject --reason source-check:<input|reach>` を人間か運用者が打つ。`成立` は段 2 の群と段 3 の Lab へ進む。
- 2026-10-27 に 2026-10-25 以降の Finding 162 件（25 対象、31 単位）へ当てた結果は成立 88・不成立 67・未決 7。不成立の内訳は入力支配 no 51、到達性 no 14、両方 no 2。所有者の 2026-10-26 の選別と 2 つの問いについて 159 / 162 で一致し、ずれ 3 件は人間側の理由に先例が混じるものだった。人間が同根、impact、市場性で外した 19 件はこの段では成立になり、それらの軸は段 2、出口の park、段 4 に残る。
- 変えないもの: 段 1 の規則の篩、段 2 の群、段 3 の Lab と判定器、追記 13 の申告欄による park（2 つ目の線として残す）。
- 消し方: skill と OPERATIONS 第 3 節の表の 0b 行とこの追記を消す。記録した `reject` は別の判断を記録すれば handoff 列に戻る。

## 2026-10-27 追記 15: 新しい Trial の契約節を v4 に戻す（申告欄を渡さない）

追記 13 の契約 v5（申告欄 3 つと各値の説明を Finding schema に載せる）を受け取った Trial は、目的文に関わらず Finding が減った。同じ目的文 `wp2shell-bounty-v14-wide`、同じ選定帯、同じ Codex で、契約だけが違う 2 日の Root 単位の数字:

| 日 | 契約 | 子の上限 | Trial | Finding | Finding が 1 件以上出た Trial | Trial あたりの中央値 | Lead |
|---|---|---|---|---|---|---|---|
| 10-26 | v4 | 4 | 21 | 76 | 16 | 2 | 78 |
| 10-27 | v5 | 8 | 22 | 8 | 3 | 0 | 65 |

v16-wide（42 Trial、Finding 0.3/Trial）と v17-wide（36 Trial、0）はどちらも v5 の下でしか走っていない。ADR 0039 の追記 11 と 12 で目的文の文に帰した減り方は、契約 v5 と切り分けられていなかった。候補の `candidate-held` は増えていない（10-27 の Codex で 0）ので、schema の検証で落ちたのではなく、エージェントが Finding として書かなくなった。schema の値の説明（「典型的なサイトでは作らない」「ベンダーだけが書く」など）が、Finding の条件として読まれたと見る。子の上限 8 は同時に変わっているので、この表だけでは完全には分けられない。

決定:

- 新しい Trial を起こせる行（`wp2shell-bounty-v11`、`wp2shell-bounty-v14-wide`、candidate の `wp2shell-bounty-v15-wide`）の契約を v4 に戻す。目的文の本文と digest は変わらない。archived の `v16-wide` と `v17-wide` は、走った Trial の `contractDigest` のとおり v5 のまま残す。
- schema の 3 つの欄、`declared-precondition` の park、`review restore`、`review export` の出力は消さない。申告の無い Finding は park しないので、新しい Finding にこの park は当たらない。偽陽性は段 1b の `wbh-source-check`（追記 14）で落とす。
- 測り方: 本番の次の 20 Codex Trial で Finding/Trial と「Finding が 1 件以上出た Trial の割合」を見る。v4 の 10-26 の水準（3.6/Trial、16/21）に戻れば契約が原因。戻らなければ子の上限 8 を 4 に戻して同じ 20 Trial を見る。
- 消し方: 3 行の契約を v5 に戻す。schema と park は残っているので、それだけで欄が渡る。

- 2026-10-28 追記（#601）: `review submitted --external` は Harness 外で済んだ提出を Finding 参照・提出先・提出日・記録者だけの `submission-recorded-externally` として追記し、レビュー列から外して funnel の台帳外内訳と export に出すが、Harness 経由の提出の承認条件は変えず、外部送信も行わない。

## 2026-10-31 追記 16: 段 1 を 2 値にし、Wordfence の決定から確認した基準と通常利用の調査を足す（`wbh-screen` v5）

所有者決定 2026-10-31。所有者が受け取った Wordfence の決定（受理、却下、対象外の通知）を読み合わせると、Lab で再現できても報奨にならなかった種類が繰り返し出ていた。本体の振る舞いに依存して低権限になる経路、外部サービスの所有者しか書けない入力、cron やキャッシュや時間窓に頼る連鎖、導入時だけの一時スクリプト、乗っ取りに届かない影響、提出時に最新版で既に塞がれていたもの、管理者がその効果のためだけに組み立てる構成である。受理された記録との差は「プラグインの通常利用の範囲か」にあった。段 1 はこれらを規則の写しだけでは外せず、`検証へ` に流していた。

決定:

- `wbh-screen` を v5 にする。判定は `要検証` / `除外` の 2 値とし、確度を下げて残す中間の区分は置かない。
- 除外の項目を 11 に固定し、理由コードを `policy-out-of-scope` / `core-dependency` / `external-not-writable` / `contrived-usage` / `chain-fragile` / `installer-transient` / `cve-only-grade` / `same-root-ticket` / `public-duplicate` / `patched-in-latest` とする。各項目の確認の仕方は skill 本文にある。
- 通常利用の調査を段 1 に入れる。Snapshot の readme、WordPress.org の説明、開発元の公式資料を読み、前提となる構成を主機能 / 公式の周辺機能 / こじつけ に分ける。こじつけだけを除外し、周辺機能は公式資料の URL を付けて残す。
- 同根の Finding は 1 つの報告単位にまとめ、人間向けの一覧は報告単位で出す（所有者は CLI を使わない）。
- 重複は、公開記録で明らかに同じものだけ止める。Wordfence の内部キューでの重複は推測しない。公開記録に似たものがあれば、Lab の前に修正差分を確認する一手を置く。
- 最新版の確認は WordPress.org の API と SVN の trunk で行い、Lab の前と提出の直前の 2 回やり直す。

変えないもの: 段 1b（`wbh-source-check`）のソース読み直し、段 2 の群、段 3 の Lab、段 4 の照合、確定の根拠（ADR 0040）。Harness のコードは変えず、判定器は置かない（不変条件 3）。`除外` の台帳への記録は所有者の了解を得た AI 操作役が `review decide --decision reject --reason screen-v5:<理由コード> --by ai` で行う。

計測: 2026-10-31 の本番の未決 Finding 262 件に v5 の項目を当てた結果は `要検証` 52 件（22 報告単位）、`除外` 210 件（35 対象）。内訳は Git 外の `review-notes/exclusion-screen-2026-10-31.json` にある。出典対照表は `docs/reviews/2026-10-31-wbh-screen-v5-source-table.md`。

消し方: `SKILL.md` を `versions/v4.2.md` に戻し、OPERATIONS 第 3 節の 0 行をこの追記の前の文に戻す。記録した `reject` は別の判断を記録すれば検証列に戻る。
