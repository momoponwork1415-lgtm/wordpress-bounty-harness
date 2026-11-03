---
status: accepted
supersedes: 0020 for scenario selection priority and victim-side operations
superseded-in-part-by: 0035 for the administrator boundary of a handoff Verifier run
superseded-in-part-by: 0040 for the observer verdict
---

# 検証 Lab は汎用 scenario を主とし、Verifier にブラウザを渡さない

## 決定

WordPress profile の版・digest付き通常機能 scenario catalogue に、plugin に依存しない利用状態を優先して追加する。`incomplete(precondition)` の理由コードを台帳から、次の手の本文をdigestで参照するPrivate Evidenceから集計し、頻出する前提を2〜3件ずつ実装してから同じ Finding を再検証する。scenario は通常機能の有効化と無害なデータ投入だけを行い、対象固有の関数名、option名、URL、画面名、既知経路を含めない。（2026-10-26 改訂: scenario catalogue、precondition 文からの選択、plugin 別 adapter は #353（PR #577）で削除した。下の 2026-10-26 追記。）

被害者側のブラウザ操作は Harness 所有の Lab 観測器が、型で制限した手順として実行する。Verifier にブラウザ、管理者セッション、scenario の編集権限を渡さない（2026-10-18 改訂: handoff の skill には前提作りのためだけに Lab の設定管理者を渡し、`setup-done` 以後は攻撃者位置のみ。[ADR 0035](0035-verification-as-a-skill.md)。Codex Verifier とブラウザについては本文のまま）。観測器は Finding が宣言した被害者ロールと画面の文脈で canary を観測し、結果を Private Evidence に保存する。必要な操作を catalogue と手順型で表せない場合は `incomplete(precondition)` または `incomplete(observation)` を理由と次の手付きで残す。

## 理由

検証の多数が判定器なし、または Lab の通常利用状態の不足で `incomplete` になった。対象ごとの特別な setup を増やすと探索への答えが混ざり、Verifier に管理者操作を任せると権限境界と判定の独立性を失う。汎用 scenario と Harness 観測器なら、同じ前提を複数対象で使える。

根拠: [完成度レビュー](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-harness-completeness-review.md) 第4.3節、[prompt 下書き](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-two-stage-prompts-draft.md)。

## 採らなかった選択肢

- Verifier の image にブラウザを入れて被害者を操作させる: 低権限の攻撃手順と被害者の観測が混ざる。
- 公開事例ごとの専用 scenario を増やす: 評価対象の答えを Lab 前提に埋め込む。

## 既存決定との関係と帰結

- [ADR 0020](0020-versioned-feature-scenarios-for-lab.md) の scenario ID、digest、Finding の前提照合、再試行時の Lab Setup 変更条件を維持し、catalogue の追加順と被害者操作の所有者を更新する。過去の対象向け scenario は履歴として残す。
- [ADR 0021](0021-stored-script-judge-victim-context.md) の被害者ロールと画面の宣言、[ADR 0004](0004-harness-owned-judges-decide-runtime-confirmed.md) の nonce 判定は維持する。
- `incomplete` の集計に payload、HTTP本文、recipe を台帳へ持ち込まない。台帳は理由と digest 参照だけを持つ。

## 2026-10-25 注記（#525、所有者決定 2026-10-25）

「観測器は Finding が宣言した被害者ロールと画面の文脈で canary を観測し」は、[ADR 0040](0040-human-lab-observation-replaces-judges.md) で「宣言した画面を開き、数値マーカーの dialog と画面を記録する」に改めた。canary は播種しない。観測器は記録だけを残し、成立を判定しない。「ADR 0004 の nonce 判定は維持する」は ADR 0040 で置き換えた。被害者側の操作を Harness 所有の Lab 観測器が型付きの手順で行うことと、Verifier にブラウザを渡さないことは変えない。

## 2026-10-26 追記: scenario の仕組みの削除（#353、PR #577）

決定の第 1 段落（版・digest 付きの通常機能 scenario catalogue と、`incomplete(precondition)` の集計から scenario を足す運用）は削除した。#352 は 2026-10-26 に close され、前提は ADR 0035 のとおり handoff の skill が Lab の通常機能で作る。

- 削除したもの: `src/profiles/wordpress/lab/scenarios.ts`（catalogue と `nextWordPressScenario`）、plugin 別 adapter 8 file、Lab 初期化の scenario 分岐、precondition 分類の scenario 選択（`nextScenarioId` と `common-usage-scenario-missing`）、scenario 変更による `review reverify` の再試行。
- campaign 設定の `lab.scenarioId` と、scenario を名指しする Lab Setup は、Lab を立てる前に拒否する。暗黙に scenario なしの Lab へ切り替えない。
- 読み続けるもの: 台帳の `lab-provisioned.scenario` と `verification-finished.result.nextScenarioId`、review export の scenario、対象範囲の評価が過去の Lab の scenario を照合するための digest pin（`retired-scenarios.ts`）。
- 第 2 段落（被害者側の操作は Harness 所有の Lab 観測器が行い、Verifier にブラウザを渡さない）は変えない。
- 削除前の状態は tag `archive/pre-353-deletion` に残る。戻すときは PR #577 を revert する。

## 2026-11-03 追記: Lab のメールを内部で捕捉し、攻撃者には自分宛てだけを渡す（#805、所有者依頼 2026-11-03）

これまで Lab にはメールの受け口がなかった。購読の確認、パスワード再設定、通知のリンクのように、攻撃者が自分宛てのメールで受け取る値が経路に入る Finding では、操作役が読み取り専用の DB から値を読んでリンクを組み立てるしかなかった。これは実サイトの手順と違い、証拠にも数えられない。

- **捕捉先。** 検証 Lab（`lab up --for-review` の review Lab と、`verify next --handoff` が残す Lab を含む）に、メールの捕捉用コンテナ（Mailpit）を 1 つ置く。イメージは host 設定の `images.mail` で digest を固定する（最初の版は v1.31.6、`axllent/mailpit@sha256:23fe39e81bde596a918000b3135c0f85dc8bb4c9ea6be274b051143f3e300387`）。`images.mail` の無い host では、Lab は従来どおりメールの受け口を持たない。探索 Lab には置かない。
- **隔離。** 捕捉先は他の Lab コンテナと同じく `runsc` で動かし、Lab の internal network だけにつなぐ。`--read-only`、`--cap-drop=ALL`、`no-new-privileges`、uid 65534 で動かし、メールは tmpfs に置く。bridge にはつながず、host へ port を出さない。外向きの経路は増えない（不変条件 2、ADR 0046）。
- **WordPress 側。** Harness が置く must-use plugin（`wp-content/mu-plugins/wbh-lab-mail.php`）が、`phpmailer_init` で `wp_mail()` の送り先を捕捉先の SMTP に向ける。WordPress と WP-CLI のコンテナは、捕捉先の Lab 内アドレスを `mailpit` という名前で引く。既定の送信元 `wordpress@wordpress` は WordPress 自身のアドレス検査を通らないので、その値のときだけ `wordpress@wordpress.invalid` に替える。plugin が決めた送信元はそのまま使う。
- **攻撃者に渡すもの。** `observation-ready` の後、`attack.json` の `mail.mailbox` が `<dir>/mailbox.json` を指す。Harness は route の間に約 5 秒ごとに捕捉先を読み直し、このファイルを書き換える。渡すのは、To・Cc・Bcc のどれかが攻撃者のアドレスであるメールだけである。攻撃者のアドレスは次の 2 つとする。
  - ログインする位置では、その攻撃者 account のアドレス（`attack.json` の `mail.addresses`）。
  - どの位置でも、`@attacker.invalid` の任意のアドレス（`mail.domain`）。未認証の攻撃者は、購読や guest 注文のフォームにこのドメインのアドレスを入れれば、そこへ届いたメールを読める。Lab の account はすべて `example.invalid` を使うので、管理者や被害者のアドレスと重ならない。

  Bcc は攻撃者自身のアドレスだけを残す。メールの生のソースは渡さない（捕捉先は Received や Bcc の行に他の宛先を書く）。絞り込みは Harness が行い、操作役には捕捉先の API も画面も渡さない。
- **人間に見せるもの。** review Lab と残した検証 Lab では、捕捉先の画面を host loopback の空き port に出し、Lab の案内に `captured mail (every recipient, review only):` の行で示す。全宛先のメールが見える。攻撃者位置の入口（`deniedPaths` 付きの公開）には出さず、handoff の途中にも出さない。
- **証拠。** attempt の観測の最後に、捕捉した全メールを `lab-mail.json` として HTTP 捕捉と同じ Private Evidence の束に置く。台帳には evidence digest だけが残る。メールの本文は Git にも台帳にも入れない（不変条件 8）。
- **setupDigest。** 捕捉先のイメージは Lab の setupDigest に含めない。捕捉先を足す前に封じた review package からも、同じ digest の Lab を立て直せるようにするためである。
- **採らなかった選択肢。** 未認証の攻撃者が使ったアドレスを宣言するファイルを置く案は採らなかった。決まったドメインなら新しい入力が要らず、管理者のアドレスを宣言して他人のメールを読む余地も生まれない。捕捉先の API や画面を攻撃者側へ出す案も採らなかった。全宛先のメールが見えてしまうからである。
- **まだ変えていないもの。** `wbh-verify` の本文には `mail` をまだ書いていない。エージェントに渡る文章なので、`owner-approved` を経た別の PR で足す。
- **消し方。** host 設定から `images.mail` を外せば、Lab は捕捉先を置かず、`attack.json` は `mail` を持たず、`lab-mail.json` も作らない。コードを戻すときは #805 の PR を revert する。
