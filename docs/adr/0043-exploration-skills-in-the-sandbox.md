---
status: accepted
date: 2026-10-30
amends: 0029（単一協調 Trial の主経路）と 0039（探索の mode）に、Trial へ渡すスキルの置き場と記録を足す。0042（区画分配型）は比較の腕として残す
---

# 探索の手順をスキルに分けて sandbox に渡す

## 背景

報奨が出た探索は、Root が子に配る協調 Trial だった（v1.7 の 7 件、v8 の 8 件。LESSONS、所有者の 2026-10-30 の確認）。2026-10-28 に本番へ入れた区画分配型（ADR 0042）は、列挙役の inventory が長さ超過で 11 / 29 差し戻され、34 Trial で Finding 2 件にとどまり、所有者の 2026-10-30 の指示で探索を止めた。既存 CVE 19 件で列挙 script の再現率を測ると、入口 17 / 19、出口 12 / 19、両方 11 / 19 で、落ちた類は plugin 固有の wrapper、本体へ値を渡す書き込み、JavaScript 側の出口だった（[2026-10-30-enumeration-recall-cve-bench.md](../reviews/2026-10-30-enumeration-recall-cve-bench.md)）。script だけの列挙は床にならない。

公開 harness（Anthropic 参照 harness、Mantis、Cloudflare skill / VDH、Shopify、AVDH、PRISM、Ulysses）に共通する線は、[2026-10-27 の報告](../reviews/2026-10-27-public-harness-repos-responsibility-split.md)のとおり「中身は AI、形は Harness」で、中身の側はどれも **地図を先に作る → 仮説で配る → 短命の子で追う → 別の体で反証する** の順を手順として model に渡している。本リポジトリでは、この手順を目的文に書き足すと目的文が肥大する（v15〜v18 wide の教訓: 文を足すほど Finding が減った。ADR 0039 追記 12・14）。

所有者は 2026-10-30 に「定石に従って直す。ただし巨大プロンプトは辞め、スキルとして分割する」と決めた（#682）。

## 決定

### 置き場と渡し方

- 探索の手順は `SKILL.md` に分け、`src/profiles/wordpress/prompts/skills/<id>/SKILL.md` に置く。front matter は `name` と `description` の 2 行（Codex CLI と Claude Code が共通して読む形）。本文は手順だけを書く。汎用の parser は `src/discovery/skill-definition.ts`、WordPress の registry は `prompts/skills.ts`（`WORDPRESS_DISCOVERY_SKILLS`: id、name、digest、status）。
- campaign 設定の `discovery.skills` に id を並べると、Harness は digest を検証した file を sandbox の CLI home（Codex は `CODEX_HOME/skills/<name>/SKILL.md`、Claude は `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`）に読み取り専用で置く。CLI が `name` と `description` を model に一覧し、本文は agent が使うときに読む。目的文、生成する節、出力契約は変えない。目的文の digest も変わらない。
- `discovery.skills` は `deep` と `wide` だけで書ける。`partitioned` では拒む。省略すれば従来どおり何も置かない（既定は off）。上限は 8 本、1 本 32 KiB、名前は `^[a-z][a-z0-9-]{0,63}$`、同じ `name` を 2 回並べない。
- Claude runtime は、スキルがあるときだけ setting source `user`（Harness が staging した空の home）と SDK の `skills` の名指し、`Skill` tool を有効にする。無いときは従来どおり何も読まない。Codex runtime は `--ignore-user-config` のままでも `CODEX_HOME/skills` を読む（本番 image codex 0.164 で確認、2026-10-30）。
- 台帳は `discovery-run-started.configuration.skills [{id, digest}]` を残す。再開（`campaign resume`）は記録した id と digest を registry と照合し、無ければ `skill-version-differs` で拒む。本文を変えたら id の版を上げ、旧 id は `archived` で残す（prompt と同じ規則）。

### 本文の規則

- 手順だけを書く。型の一覧、判断の基準、対象固有の名前、再現の手順、Harness が強制する数（最低時間、子の数）は書かない。これらは目的文・契約・Run parameters の側にある（契約 v5 の教訓、ADR 0038 追記 15）。
- 本文は agent に渡る文章なので `owner-approved` の規則（DEVELOPMENT 第 5 節）に従い、全文と日本語訳と出典対照表を `docs/reviews/` に置く。
- 最初の 1 本は `wbh-recon-v1`（地図を作る）。後続は列挙 script を HINT として使う手順、追跡と引き継ぎ、読んだ・止まった台帳、反証を、それぞれ 1 本ずつ PR にする。各 PR は数字で採否を決める。

### 変えないこと

- Root 配分型の協調 Trial の形（ADR 0029、0039）。Harness 側に索引・dispatch・coverage を戻さない（ADR 0034）。
- 区画分配型（ADR 0042）。比較の腕として残し、スキルは当てない。
- 不変条件 1〜8、ADR 0040。スキルは固定ソースの読み方であり、答え、PoC、公開履歴を含まない。

## 測り方

`docs/agents/measurement.md` 5b 節。所有者が探索の再開を指示した後、本番の同じ選定帯で `discovery.skills` 無しと有りを交互に回し、Trial 数をそろえる。数えるのは Finding / Trial、Lead / Trial、段 1b を通った数、Lab で人間が `match` を記録した数、読んだ file 数、token、時間、research artifact にある `recon-map.md` の有無と大きさ。既定を有りに切り替えるかは DEVELOPMENT 第 5 節の 6 段で決める。本 PR（形 + 1 本）は数字を持たない。

## 採らなかった選択肢

- 手順を目的文に足す: v15〜v18 wide で文を足すほど Finding が減った。目的文は変えず、手順は CLI の skill 機構で渡す。
- Harness が Run parameters に「スキルを使え」と書く: 使うかどうかは agent の判断で、description が合図になる。生成節を変えると目的文側の入力 digest が変わり、比較の分母が割れる。
- `.claude/skills/` の人間向け skill と同じ置き場: あれは host で人間と AI 操作役が使う。sandbox に渡す skill は digest 固定と registry が要るので prompts の下に置く。
- 1 本の大きな skill: 分けないと目的文の肥大を skill に移すだけになる。1 本 1 手順にして、PR ごとに数字で採否を決める。

## 消し方

`discovery.skills` を外せば従来の Trial。消すときは `src/discovery/skill-definition.ts`、`prompts/skills.ts`、`prompts/skills/`、設定と台帳の `skills` 欄、Claude runner の setting source の分岐、sandbox の staging と test を消し、この ADR と GLOSSARY の行、measurement.md の 5b 節、reviews/README の参照を revert する。台帳の既存 event は消さない。

## 2026-10-30 追記 1: 支援 file と `wbh-tools-v1`（#687）

- スキルの directory に `SKILL.md` 以外の file（script、参照文）を置ける。registry の行が `files [{name, digest}]` で固定し、Harness は読み込み時に digest を照合して sandbox の CLI home の同じ directory に写す。`.sh` は実行可（0500）、他は読み取り専用（0400）。1 本 16 file まで、合計 1 MiB まで、名前は `^[a-z0-9][a-z0-9._-]{0,63}$` で `SKILL.md` は使えない。Harness は支援 file を実行せず、出力も読まない。出力は agent が `/workspace/research` に残し、research artifact として全件保存される。
- 2 本目は `wbh-tools-v1`。区画分配型（ADR 0042）が持っていた列挙 script 2 本（`enumerate-hooks-v1.sh`、`enumerate-sinks-v2.sh`）と本体機能の固定参照（`core-fixed-list-v1.md`）を `prompts/skills/wbh-tools-v1/` に移し、agent が自分で走らせて地図（`wbh-recon-v1`）と突き合わせる手順を `SKILL.md` に書く。全文と対照表は [docs/reviews/2026-10-30-exploration-skills-wbh-tools-v1.md](../reviews/2026-10-30-exploration-skills-wbh-tools-v1.md)。
- 「変えないこと」の 2 項目目（区画分配型を比較の腕として残す）は、所有者決定 2026-10-30 で取り消した。区画分配型は #685 で削除し、再利用する部分はスキルとして運ぶ。ADR 0042 の追記を参照。
- 消し方に足す: `prompts/skills/wbh-tools-v1/` と registry の行、`skill-definition.ts` の `files` と `admittedSkillFiles`、transport schema の `files`、test の支援 file の項を消す。

## 2026-11-01 追記 2: `wbh-setup-v1`（Lab で plugin の通常利用を作る、#749）

- 所有者の指示（2026-11-01「プラグインを単純に有効化するだけではなく、readme.txt というより wp.org などから、プラグインのフォーム設定の通常利用とか、その辺調べて、一通り作る」）で、3 本目は `wbh-setup-v1`。Lab 付きの Trial（`## Lab` 節がある Trial）で、agent が readme.txt と地図（`wbh-recon-v1`）から「site の持ち主が plugin を使うために作る object」を挙げ、plugin 自身の初回設定を既定値で終え、object を 1 つずつ作って公開ページに置き、`/workspace/research/lab-setup.md` に記録する手順を書く。reset の後は記録どおりに作り直す。既定から変えた設定は `configurationPrecondition` に写す。全文と日本語訳と出典対照表は [docs/reviews/2026-11-01-exploration-skills-wbh-setup-v1.md](../reviews/2026-11-01-exploration-skills-wbh-setup-v1.md)。
- 事実（提案 [2026-11-01-lab-normal-use-setup-proposal.md](../reviews/2026-11-01-lab-normal-use-setup-proposal.md)）: Lab の初期化は plugin の有効化で止まり、Lab 付き探索 30 run のうち `labObserved` が残った 6 run の site への要求は合計 41、observe は 0。検証の止まる理由は `precondition` が 365 件中 135 件で最大。readme.txt は固定ソースの中にあり、新しい入力は要らない（不変条件 1）。
- Harness は変えない。Lab の初期化（core install、plugin の有効化、基準、account、初期記事）も変えない。plugin の通常利用を作るのは agent の仕事で、Harness にシナリオや plugin 別アダプタを戻さない（#353、AGENTS.md）。sandbox に internet は無く、wp.org の page は取りに行かない。
- Lab の無い Trial（`discovery.lab: none`）でも名指しはできるが、`## Lab` 節が無いので使われない。本番の v19-wide（Lab なし）の campaign 設定には足さず、Lab 付きの campaign（ADR 0044 の第 2 Trial）で名指しする。
- 測り方は measurement.md 5b 節に足した。Lab 付き Trial の site への要求数 / Trial、observe の使用回数、`labObservations` が空でない Finding / Lead の数、research artifact の `lab-setup.md` の有無と Objects 行数と Verified の 200 の数。
- 消し方に足す: `prompts/skills/wbh-setup-v1/` と registry の行、test の launchable の 1 行、この追記、ADR 0044 の追記、measurement 5b の項、reviews/README の行。

## 2026-11-01 追記 3: `wbh-recon-v2`（子は親の履歴を引き継がずに始める、#752）

- 事実（本番 v19 の Codex 0.164 の rollout、2026-11-01）: 子は Root の会話を丸ごと引き継いで始まる。子の rollout の先頭 59〜61 件は Root の履歴で、その直後に「You are now a newly spawned child agent. The preceding conversation is inherited parent context.」が入る。子の最初の turn の入力は約 40,000 token（Root の最初の turn は 14,000）。`spawn_agent` の引数 `fork_turns` は既定 `all` で、`none` にすると親の履歴なしで始まる。`[agents]` 設定や custom agent の TOML にこの切り替えは無い。Harness の設定では変えられず、Root が spawn のたびに選ぶ。
- 所有者決定 2026-11-01（開発計画 2.3「全部提案どおり」）: `wbh-recon` の手順 8 に 1 文を足して v2 にする。「spawn の道具がその選択を許すなら、子は親の会話を引き継がずに始め、単位の地図の節、要る研究 file の行、task を最初の message に入れる」。runtime 固有の引数名は書かない。本文の他の部分は v1 と byte 単位で同じ。v1 は `archived`（過去 Trial の digest 照合のため）。
- campaign 設定は `wbh-recon-v2` を名指しする。v1 を名指すと `discovery.skills` の検証で拒まれる。ADR 0039 追記 16 の「v19-wide は recon と tools の両方を名指す」は v2 で読む。
- 測り方（measurement.md 5b）: rollout の子の最初の `token_count` の入力、Trial の入力 token、読んだ file / Trial、Finding / Lead / Trial。
- 全文と日本語訳と出典対照表: [docs/reviews/2026-11-01-exploration-skills-wbh-recon-v2.md](../reviews/2026-11-01-exploration-skills-wbh-recon-v2.md)。
- 消し方: `prompts/skills/wbh-recon-v2/` と registry の行を消し、v1 を `current` に戻す。

## 2026-11-01 追記 4: `wbh-recon-v3`（終了の判断を手順にする、#714 / #686）

- 事実（本番 v21-wide の 10 Trial、2026-11-01）: Root の wall は 9〜54 分（中央値 16 分）で、どの Trial の登録簿も hooks.tsv の全行（34〜221 行）を全 sink 種で「読了 / 残 0」と記録して閉じている。v21 の停止文（行が残る間は閉じない）は守られていて、行を分類した時点で満たせる。子は 1 体 3〜4 分で戻る。読んだ固有 PHP file は plugin の 37〜84%。Finding 6 件に対し Lead 40 件が残り、隙間を詰める段が無い。
- 所有者の言葉（2026-11-01 夜）: 「Lead の第 2 Trial（#715）と deep の最低時間（#686）の 2 つができないと探索が浅いまま」。床は本番の wide に元々無いので、終了の判断を手順にする側を先に入れる。
- 決定: `wbh-recon` に手順 9「closing」を足して v3 にする。終われる条件は、(1) 地図の全 entry と一覧の全行が「check か効果まで handler を読んだ（file と行）」か「理由付きの未読」のどちらかになっている、(2) 隙間を残して sink に届いた経路のそれぞれを、書いた agent とは別の agent が file と行と隙間の文から読み直し、「決着（file と行）」か「供給ソースでは決着できない（足りないもの）」を経路の下に書いている、(3) Unread と Open questions の各項が読まれたか、まだ成り立つ理由を持っている、の 3 つ。満たしたら登録簿の末尾に Closing 節（件数と経過時間）を書いてから最終報告する。wall が先に来たら同じ節をその時点の件数で書く。description にも「最終報告の前にもう一度使う」の 1 文を足す。他は v2 と byte 単位で同じ。
- Harness は変えない。wall と読んだ file 数を記録するだけで、判定は持たない（AGENTS.md「Harness と AI の責務」）。`discovery.minimumActiveMinutes` の既定（deep の 60 分）は別 PR で 0 にする。
- 測り方: 本番で v3 を名指した 20 Trial を取り、v21 + v2 の 10 Trial（Root 中央値 16 分、Finding 0.6 / Trial、Lead 4.0 / Trial、固有 PHP file 読了 37〜84%）と並べる。見る数字は Root の wall、固有 file 読了率、Finding / Trial、段 1b を通った Finding、Lead / Trial、Closing 節の「決着した経路 / 隙間のあった経路」。対になっていない比較である。
- 全文と日本語訳と出典対照表: [docs/reviews/2026-11-01-exploration-skills-wbh-recon-v3.md](../reviews/2026-11-01-exploration-skills-wbh-recon-v3.md)。
- 消し方: `prompts/skills/wbh-recon-v3/` と registry の行を消し、v2 を `current` に戻す。

## 2026-11-02 追記 5: `wbh-falsify-v1`（単位ごとの仮定の表と、強制されていない行の両方向の読み、#786）

- 事実（bench h30 #726、2026-11-02、30 プラグイン各 1 Trial）: 当たった 69 記録は「要求の値が handler の中で直接 sink に届く」形。外れ 45 記録（要求上限で止まった 3 Trial を含む）は、最終 HTML を書き換える最適化系 12、訪問者の値が管理画面や JavaScript の表で描画される 14、署名・token・権限の論理 11、保存→再利用の形の崩れ 6、連結 SQL の Lead 止まり 2。本番の Lead の `missingEdge` は producer が Lead 入力 Trial で 124 / 168、v21 第 1 Trial で 86 / 128。agent は sink に届くが、「その値を誰が書けるか」「この変換は何を保つと仮定しているか」「この署名はどの欄を覆うか」を読む手順を持たない。
- 所有者の選択（2026-11-02「推奨で」）: 形ごとの対策ではなく、1 つの読み方の変更でまとめて狙う。本 ADR の決定が「後続」に挙げた「反証」がこれに当たる。
- 決定: 4 本目は `wbh-falsify-v1`。子は自分の単位について、Reach / Value / Store / Transformation / Proof / State の 6 種の仮定を 1 行 1 文で表にし（頼っている file と行、強制している file と行、無ければ not found）、not found の行を producer 側（store の書き手、引数の供給元、それぞれの入口と門）と consumer 側（描画、query、file、unserialize、比較）に 1 hop ずつ読み、enforced / not enforced / open で決着させる。not enforced の hop 列が下書きの `sourceTrace` になる。`## Prior leads` がある Trial では、その lead の単位を先に取る。終わりに Counts 節を書き、`wbh-recon` v3 の手順 9 がそれを読む。#697（`wbh-trace` の下書き）の hop ごとの追跡は手順 3〜5 に取り込み、#697 は close する。
- Harness、目的文（v21-wide）、出力契約は変えない。campaign 設定の `discovery.skills` に名指しするだけ。
- 測り方と採否の線は #786 と measurement.md 5b。bench の残り 20 件で、最適化系が 0 → 3 記録以上、論理系が 0 → 2 プラグイン以上、Lead 止まり 15 記録のうち Finding に進んだ数、全体の当たりが 9 / 20 を下回れば revert。本番の分母は ADR 0045 のまま。
- 全文と日本語訳と出典対照表: [docs/reviews/2026-11-02-exploration-skills-wbh-falsify-v1.md](../reviews/2026-11-02-exploration-skills-wbh-falsify-v1.md)。
- 消し方: `prompts/skills/wbh-falsify-v1/` と registry の行、test の launchable の 1 行、この追記、measurement 5b の項、reviews/README の行を消す。

## 2026-11-02 追記 6: `wbh-falsify-v2`（単位ごとに歩きと反証を別の子で 2 回読む、#791）

- 事実（bench h31 #786、2026-11-02、終わった 16 件・鍵の記録 62 件を h30 → h31 で記録ごとに追った）: Finding 到達 22 → 20、Lead 止まり 15 → 20、未到達 25 → 22。Lead 止まりから Finding に 3、未到達から新しく 10（うち Lead 止まり 7）が増えた一方、Finding だった 5 件（直接 sink 型）が未到達に、3 件が Lead に下がった。Root の時間は 10〜83 分（中央値 39 分）で、自力で 120 分に当たった Trial は無い。仮定の表は sink の名前が無い形に効き、その分だけ「handler の中で値が直接 sink に届く」形の読みが薄くなった。
- 所有者の言葉（2026-11-02）: 「これが終わったら改善して、6 対象くらいに絞ってベンチマークにしましょう。トークンをベンチマークだけに費やせない」。
- 決定: `wbh-falsify-v2`。1 単位を別々の 2 agent が 2 回読む。先に「歩き」（新しい手順 2）: `/workspace/research/walks/<subsystem>.md` に、地図の全 entry を要求から「check で止まる」か「要求の値が use に届く」まで読んで entry ごとに 1 行、check なしに届いた行は Routes として hop 付きで書き、Counts を付ける。次に表（手順 3〜6、旧 2〜5）を、歩いた agent とは別の agent が歩きの file から始める（歩きの check は enforced at を埋め、use は行が頼る場所、経路はそのまま not enforced の行）。手順 7 の Counts に歩きの数を写し、歩きの file が無い単位は open と読む。他は v1 と byte 単位で同じ。v1 は `archived`。
- Harness、目的文（v21-wide）、出力契約、`wbh-recon` v3 は変えない。
- 測り方（measurement.md 5b）: bench h32 は 6 対象 × 1 Trial に絞る（所有者決定）。v1 で失った直接 sink 型の記録が戻るか、v1 で増えた到達を失わないか、Root の時間、自力で 120 分に当たった件数。採否の線は #791。
- 全文と日本語訳と出典対照表: [docs/reviews/2026-11-02-exploration-skills-wbh-falsify-v2.md](../reviews/2026-11-02-exploration-skills-wbh-falsify-v2.md)。
- 消し方: `prompts/skills/wbh-falsify-v2/` と registry の行を消し、v1 を `current` に戻す。test の launchable の 1 行、この追記、measurement 5b の項、reviews/README の行を消す。

## 2026-11-02 追記 7: `wbh-lab-v1`（Lab の命令をどの行に、どの順で使うかを手順にする、#793 決定 E）

- 事実（bench h34 と本番、2026-11-02）: Lab の Find / Query / Trace を第 1 Trial から付けても（ADR 0049）、bench h34 の 6 対象で lookups は 1〜10 / Trial、F は 12 → 9 で L が 5 → 12。本番の再開後 17 Root は 11〜47 分で閉じ、lookups は 0〜3。`## Lab` 節は命令の body と予算を言うだけで、recon / tools / setup / falsify のどのスキルも Lab の命令に触れていなかった。所有者の問い「道具の使い方が書いてないだけ？」に対する答えがこれで、「じゃあ進めてください」（2026-11-02）。
- 決定: 5 本目のスキル `wbh-lab-v1`。open の行（歩きで store 書き込みに止まった行、not found の Store / Transformation 行、次の hop の無い route、欠けた hop が保存・読み戻し・関数の Lead 下書き）を 1 つ取り、問いを「値 X を role R で entry E に送るとどこに保存されどこで読み戻されるか」の形にし、marker を site の普通の使い方で植え（lab-facts.md に先に書く）、Find で保存先、Query で保存された形、Trace で走った関数を歩きの hop の隣に並べ、読み戻しの要求を Trace と Observe で見て、行の下に Lab 行を追記する。trace は `lab-traces/` に保存して再送しない。最終報告の前に、Trial を調整する agent が Lab の答えられる open の行を全部この手順に通し、Closing 節に数を書く。
- 目的文は別 PR で v22-wide にし、hooks.tsv の行数で閉じる 2 段落を削除だけで消す（ADR 0039 の 2026-11-02 追記）。終わり方は wbh-recon v3 の手順 9 とこのスキルの手順 9 と Trial の wall に置く。
- Harness は変えない。命令と予算と `lookupLog` の記録は ADR 0049 のまま。lab-facts.md の中身は Harness が読まない。
- 測り方（measurement.md 5b）: 本番で `wbh-lab-v1` を名指した Trial と、再開後に名指していない v21-wide の Trial を、Root の wall、lookups / Trial（kind の内訳）、observations、F / Trial、L / Trial、Lab 発火 / Codex 時間で並べる。bench は 6 対象 × 2 Trial を後で 1 回だけ組む（所有者決定 2026-11-02「6 対象くらいに絞って」）。
- 全文と日本語訳と出典対照表: [docs/reviews/2026-11-02-exploration-skills-wbh-lab-v1.md](../reviews/2026-11-02-exploration-skills-wbh-lab-v1.md)。
- 消し方: `prompts/skills/wbh-lab-v1/` と registry の行、test の launchable の 1 行と本文の検査、この追記、measurement 5b の項、reviews/README の行を消し、campaign 設定の `discovery.skills` から外す。

## 2026-11-02 追記 8: `wbh-falsify-v2` を採らず `archived` にした（#791）

- 事実（bench h32、6 対象 37 record、2026-11-02）: v2 で F 12 / L 5 / 未到達 20。h30（recon + tools + setup のみ）の 12 / 8 / 17 と同じ F で Lead が減り、未到達が増えた。plugin ごとの振れは ±4 で、6 対象 1 Trial の bench では ±2 を分けられない。
- 決定: `wbh-falsify-v2` を `archived` にする。v1 もすでに `archived`。本番の campaign 設定は v2 を名指していないので、本番は変わらない。走った Trial の台帳（`configuration.skills` の digest）はそのまま読める。
- 「仮定の表」の読み方そのものは捨てない。Store 行と Transformation 行の語は `wbh-lab-v1`（追記 7）が open の行の種類として使い、Lab の事実で埋める。次に反証の手順を戻すなら、Lab の事実を入力にする形で v3 として出す。
- 消し方: registry の status を `current` に戻し、test の 1 行を launchable 一覧に戻す。

## 2026-11-02 追記 9: 目的文のどこにも名指されないスキルは読まれない（#793）

- 事実（本番 `prod-v21-20261102-4`、5 Root、2026-11-02）: 目的文が名前で指す `wbh-recon` / `wbh-tools` / `wbh-setup` の SKILL.md は各 4 回以上読まれ、どの文も名指さない `wbh-lab` の SKILL.md は 0 回だった。staging は CLI の一覧に載せるだけで、読ませはしない。
- 道具を導入する Harness 生成の節は、その使い方を書いたスキルを名前で指してよい。何が installed かという事実であって、舵取りではない。`## Lab` 節に足した 1 文は [ADR 0049 の 2026-11-02 追記 6](0049-lab-resident-exploration.md)にある。

## 2026-11-03 追記 10: `wbh-recon-v4` の独立点検と指示の所有者（#807）

- 所有者は WordPress 特化の audit skill に向けて「新しく作るというよりはちょっと追加する」方針を選び、「それがいい」と確認した。その後「スキルどうしやシステムプロンプト同士の重複の整理も必要」と加えた。今回は既存 Trial の終了時に、担当者と別の Root が固定ソースと研究 file を突き合わせる手順を `wbh-recon-v4` に足す。
- Root は入口の登録、保存値の読み戻し箇所、ブラウザ側の描画箇所を固定ソースで開き、地図、列挙一覧、担当者の経路 file、目的文が求める登録簿に無い経路を、file・行・記録から漏れた内容付きで未完として登録する。担当 sink がまだ分からなければ未完のまま調べる。新しく未完になった sink は目的文どおり同じ sink の後続担当が追う。点検の自己申告は網羅や Finding 確定の根拠にしない。
- 指示の重複を照合した結果、目的文 v22 は子を sink 別に配り、`wbh-recon-v3` 手順 8 は subsystem 別に配るため衝突していた。子の分配は目的文が持つ。v4 手順 8 は割り当て済みの子へ地図を渡す手順だけにした。Lab 付きで `wbh-lab` がある場合、Lab に答えられる未完行はその手順 9 を先に通し、その後 recon の終了点検をする。Harness の生成節が Lab の命令・予算・出力契約を持つ境界は変えない。
- 別に見つかった目的文の「子は 30 行以内で返す」と生成契約の厳密な 4 キー JSON、および目的文の「3 skills」と Lab 付き Trial の 4 本の不一致は、版付き目的文の次の整理で扱う。今回の探索の測定軸を増やさないため、目的文と Harness は変えない。リポジトリ独自の system prompt は無く、目的文と生成節が CLI / SDK へ渡る。監査の対照表は [review 文書](../reviews/2026-11-03-discovery-instruction-overlap-and-recon-v4.md)に置く。
- v3 の本文と digest は残して `archived`、v4 を `current` にする。全文、日本語訳、出典対照表は同じ review 文書。新規 campaign は `discovery.skills` で v4 を名指すときだけ使う。採否は本番の Lab 発火 / Codex 時間と Wordfence の結果で行い、登録簿で新たに開いた経路の数は診断値にする。効果がなければ v4 を `archived` にし、v3 を `current` に戻して campaign の pin を戻す。既存 Trial の digest は維持する。
