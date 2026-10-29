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
