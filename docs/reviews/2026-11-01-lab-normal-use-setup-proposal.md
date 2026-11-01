# Lab の「通常利用」セットアップ — 提案（2026-11-01）

所有者の言葉（2026-11-01）: 「プラグインを単純に有効化するだけではなく、readme.txt というより wp.org などから、プラグインのフォーム設定の通常利用とか、その辺調べて、一通り作る。」

この文書は正本ではない。所有者が正しさを確かめるための提案で、事実と提案を分けて書く。

## 1. いまの事実（コードと台帳から）

### 1.1 Lab の初期化は plugin を有効化するところで止まる

`src/profiles/wordpress/lab/wordpress-initialization.ts` の順: core install → 同梱 plugin の削除 → 依存と対象の plugin をコピーして `wp plugin activate` → 基準 `hosting-default-v3` の適用と読み戻し → （TranslatePress のみ）第 2 locale → 攻撃者と被害者の account → 初期記事と承認済みコメント（管理者が作者）。plugin 固有の設定、plugin が作る object（フォーム、ギャラリー、表、予約枠など）、それを置いた公開ページは作らない。Harness がシナリオや plugin 別アダプタを持たないのは所有者決定（AGENTS.md、#353 で削除、ADR 0026 追記）。

### 1.2 「通常利用」を作る担い手は 2 か所にいて、どちらにも手順書が無い

- 検証 Lab（`verify next --handoff`、ADR 0035）: スキル `wbh-verify` が `lab.json` の管理者で前提を作り `setup-done` を置く。何を作るかは Finding と固定ソースから判断する。手順はスキル本文に固定しない（SKILL.md 32 行目）。
- 探索 Lab（`discovery.lab: attached`、ADR 0003 2026-10-25 追記、ADR 0044 の第 2 Trial）: Root は `## Lab` 節で管理者 account と低権限 account、`POST /reset`（既定 2 回）、`POST /observe`（既定 20 回）を受け取る。管理者で変えた設定は `configurationPrecondition` に書く決まり。通常利用を作れとは書いていない。

### 1.3 Lab はほとんど使われていない

| 数字 | 値 | 出所 |
| --- | --- | --- |
| `discovery-run-started` 全体 / うち Lab 付き | 6,820 / 30 | 台帳 |
| Lab 付きで `labObserved` が残った run | 6 | 台帳 |
| その 6 run の site への要求数 / reset / observe の合計 | 41 / 0 / 0 | 台帳 |
| `verification-finished` 全体 | 365 | 台帳 |
| うち理由 `precondition` | 135（37%） | 台帳 |
| `precondition-unavailable` を含む記録 | 30 | 台帳 |
| handoff 経路の記録 | 5 | 台帳 |

検証の止まり方の最大の理由は前提で、探索 Lab は 1 run あたり 7 要求しか受けていない。plugin を使える状態が無いので、agent は Lab に対して何をすればよいか分からず、ソースだけで報告している、と読む。

### 1.4 使える情報は固定ソースの中にすでにある

- `readme.txt` は wp.org の zip ごと固定ソースに入り、sandbox の `/workspace/main/readme.txt` で読める（例: `sources/<digest>/readme.txt` に `== Description ==`、`= Features =` の節）。wp.org の plugin ページの Description / Installation / FAQ / Screenshots の文はこの file を描画したもので、同じ内容である。
- `plugin_information` API で取るのは版、インストール数、作者、tag、download link だけで（`wordpress-org-target-source.ts`）、節は保存しない。sandbox には internet が無い。
- 不変条件 1 は、探索に渡せるものを固定ソースと trust 境界宣言、Programme Boundary、Lab、カタログ情報に限る。readme.txt は固定ソースの一部で、新しい入力を足さずに済む。
- `wbh-recon` の map（`/workspace/research/recon-map.md`）は、管理画面、shortcode と block、REST、設定 wrapper を subsystem ごとに持つ。「plugin を使うには何を作るか」を読む材料はここにある。
- `/workspace/research` は Trial ごとに `research-directory-archive` として Private Evidence に封じられる（`codex-gvisor-sandbox.ts`）。新しい記録 file を置けば、Harness の変更なしに残る。

## 2. 提案: スキル `wbh-setup`（通常利用の構築）を 1 本足す

Harness のコードではなく、agent のスキルにする（AGENTS.md「探索と検証の中身はプロンプトとスキルが受け持つ」）。設計書 `2026-11-01-system-design.html` の S0〜S7 に無い段で、S0（recon）の後、S5（probe）の前に入る。種別は B（固定の知識 = readme と map を読む手順）で、A/B/C の問いには「C 群へ届く前提として Lab の到達面を増やす」と答える。

### 2.1 入力

readme.txt の Description / Installation / FAQ / Screenshots の文、`recon-map.md` の subsystem と入口の表、Lab の管理者 account（探索 Lab は `## Lab` 節、検証 Lab は `lab.json` の `administrator`）。

### 2.2 手順（スキル本文の骨子。本文は agent に渡る文章なので PR で全文と日本語訳を貼り `owner-approved` を付ける）

1. **何を使う plugin か書く。** readme と map から、site の利用者から見える機能を列挙し、機能ごとに「site の持ち主がそれを使うために作る object」を 1 つずつ挙げる（フォーム、ギャラリー、表、スライダー、予約枠、会員レベル、商品、イベント など）。readme に無い機能は map の管理画面から拾う。
2. **既定のまま有効にする。** 初回セットアップのウィザードがあれば既定値で完了する。主要機能は既定値のまま有効にする。既定から変えた option は全部 `lab-setup.md` に書き、Finding / Lead では `configurationPrecondition` に写す。「典型的な site が選ばない」値には変えない。
3. **object を 1 つずつ作って公開する。** 手順 1 の object を plugin 自身の管理画面か REST で管理者として 1 つずつ作り、shortcode か block を置いた公開ページを object ごとに 1 枚作る。通常の流れで訪問者や低権限者が作るデータ（フォームの送信 1 件、コメント 1 件、予約 1 件など）は、その役で 1 件だけ作る。
4. **記録を書く。** `/workspace/research/lab-setup.md` に、有効にした機能、作った object と公開 URL、既定から変えた option、作れなかった object とその理由を書く。探索 Lab で `POST /reset` した後は、この記録どおりに作り直す。
5. **検証でも同じ形を使う。** `wbh-verify` の前提作りは、この記録の形で `steps.md` に前提を書く。同じ plugin の次の Trial や検証は、前の Trial の `lab-setup.md`（Private Evidence）を人間かスキルが持ち込める形になる。これは後の項目「plugin ごとの事実の DB」の最初の file になる。

### 2.3 Harness の変更

無し。記録は研究 directory の封印で残る。campaign 設定の `discovery.skills` に `wbh-setup-v1` を足すだけ（設定 1 行、ADR 0045 の「設定で外せる」に合う）。台帳の欄は足さない。将来 `lab-setup.md` の digest を `discovery-run-finished` に載せるかは、数字が出てから決める。

### 2.4 測る数字

- 探索 Lab: Trial あたりの site への要求数（いま 41 / 6 ≈ 7）、`labObservations` が空でない Finding / Lead の数、`observe` の使用回数（いま 0）。
- 検証: handoff attempt のうち `precondition-unavailable` で終わる割合（いま 365 件中理由 `precondition` が 135 件。分母は handoff 経路に限って取り直す）。
- スキル単体テスト（設計書の決まり「スキル 1 本に単体テスト 1 つ」）: bench30 v3 の plugin 5 件で Lab を立て、`lab-setup.md` が挙げた公開 URL を Harness の `observe` で開いて HTTP 200 と object の描画を数える。探索を丸ごと回さずに採点できる。
- 単一の分母（Lab-fire / Codex 時間）は変えない。

### 2.5 消し方

スキル directory `src/profiles/wordpress/prompts/skills/wbh-setup-v1/` を消し、campaign 設定の `discovery.skills` から外す。`lab-setup.md` が残る過去の Trial は読み続ける。

## 3. やらないこと

- Harness にシナリオ一覧や plugin 別アダプタを戻すこと（#353 の削除を覆さない）。
- 実行時に wp.org や plugin の公式 docs を取りに行くこと（sandbox に internet は無く、不変条件 1 の入力を増やさない）。Screenshots の画像も使わない。
- 外部サービス連携 plugin の account 登録（次の項目。ソースだけの探索のまま、有望なら人間が後から）。
- 第 1 Trial に Lab を付けること（ADR 0044: 16 分で閉じる段階では使われない）。
- 目的文と契約 v4 の文言変更（ADR 0045 の凍結 5 項目）。

## 4. 大きさ

SKILL.md 1 本（80 行前後）、単体テストの script 1 本、campaign 設定 1 行、ADR 0035 と 0044 への追記。Harness の TypeScript は変えない。

## 5. 所有者に確かめたいこと

1. 既定から変えた option を「禁止」ではなく「`configurationPrecondition` に書けば可」とする。これは 2026-10-26 の「探索は広く出し、落とすのはレビュー側」に合わせた。よいか。
2. 低権限者や訪問者が作るデータ（送信 1 件、コメント 1 件）を通常利用の一部として作る。#718 の「作者無しの記事」の教訓は、作者を持つ形で作ることで守る。よいか。
3. ADR 0045 の「設計変更は月 1 回」との関係。これはスキル列（#682）への 1 本の追加で、mode やプロンプト版の変更ではないと数えてよいか。
