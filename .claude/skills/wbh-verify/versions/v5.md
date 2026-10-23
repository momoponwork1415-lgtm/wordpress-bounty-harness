---
name: wbh-verify
description: scope 内 Finding 1 件を、Harness が `verify next --handoff <dir>` で立てた Lab 上で再現する。review export と setup 用 `lab.json` を読み、通常機能の前提を作って `setup-done` を置く。`observation-ready` 後に攻撃用 `attack.json` を読み、種別ごとの手順に従って攻撃者位置だけで route を実行し、6 ファイルを書く。判定はしない。
---

# wbh-verify

## 入力と境界

新しい `<dir>` を 1 attempt 専用に使う。`lab.json` の `reviewExport` が指す JSON から `finding` の主張・`impact`・`attackerPosition`・`configurationPrecondition` を読む。`lab.json` の `host.url` は Lab への接続先で、HTTP リクエストには `host.hostHeader` を Host header として使う。`lab.json` の `administrator` は前提作り専用である。攻撃者の資格と attempt 専用の `canary` は `lab.json` に含まれず、基線を取り直した後に `lab.json` の `files.attack` が指す `attack.json` で渡される。資格、ペイロード、HTTP 本文を Git や PR・Issue に書かない。

## 手順

- Finding の前提を通常機能の範囲で作る。管理者資格を使えるのはここまで。前提が作れないときは具体的な理由を `<dir>/precondition` に書いてから、`<dir>/abort` に `precondition-unavailable` とだけ書いて終える。
- 前提作りでは、Harness が播種した canary（SQL の table、canary ファイル、canary 管理者、canary user）と攻撃者 account の role に触れない。`setup-done` の時点で SQL か canary ファイルが播種時から変わっていると、Harness は `attack.json` を出さずに `incomplete` にする。
- 管理者の操作がすべて終わったら `<dir>/setup-done` を置く。Harness はここで設定管理者・canary 管理者・canary user のセッションと application password を破棄し、password を変える。前提作りで得た cookie は以後通らないので使わない。Harness が HTTP 捕捉と Lab 状態の基線を取り直して `<dir>/observation-ready` を置くまで、攻撃者の操作を始めない。合図の後に `attack.json` が現れるまで待ち、`runId`・`findingId`・`snapshotDigest` が `lab.json` と一致することを確認する。`attack.json` の `accounts` は Finding の `attackerPosition`（`unauthenticated` / `subscriber` / `customer`）に限る。
- `setup-done` 以後に Lab へ送る要求は、すべて Harness が捕捉する。攻撃者位置の account と、攻撃で得た canary principal 以外のセッションが 1 つでも混ざると、どの判定器も確認しない。
- 攻撃者の HTTP 手順を、次節の種別ごとの手順に従って実行する。`attack.json` に `canary` があれば Finding の経路に置く。`route.json` や `http.json` に canary を書くだけでは観測にならない。被害者側の操作は行わず、画面と必要な操作を `route.json` の `victim` に記す。Harness の Lab browser が観測する。
- 被害者画面で通常の操作が必要なら、`victim.paths` の各 path に `actions` を付ける。型は `click`（`selector`）、`click-text`（`text` と `exact`）、`fill`（`selector` と `value`）で、1 path あたり 5 操作まで。どの画面をどう操作するかは Finding と固定ソースから決める。
- `route.json` の各 HTTP step は実行した method・path・headers と一致させる。本文を送ったときは、実際に送信した wire body を `body` に正確に記録する。本文が空のときだけ `body` を省略できる。
- `<dir>` に次の 6 ファイルを内容まで書き終える。各ファイルは同じディレクトリの一時ファイルに全内容を書き、rename で確定する。`precondition` を最後に確定すると Harness が読む。途中で続行できなくなれば、具体的な理由を `<dir>/precondition` に書いてから `<dir>/abort` に理由コードを 1 行だけ書く。コードは `precondition-unavailable`、`route-unavailable`、`observer-unavailable`、`handoff-interrupted` のいずれかにする。

| ファイル | 内容 |
| --- | --- |
| `route.json` | `{"role":"unauthenticated","defaultSettings":true,"steps":[{"kind":"http","method":"POST","path":"/<path>","expected":"<observation>"}],"victim":{"role":"administrator","paths":["/<path>"]}}`。`role` は Finding と一致させ、`steps` は実行した HTTP 手順だけにする。`victim` は必要なときだけ入れる。 |
| `http.json` | 実際の通信を `{"exchanges":[{"request":{"path":"/…","method":"…"},"response":{"body":"…"}}]}` として記す。少なくとも 1 件必要。これはエージェントの記録であり証明ではない。 |
| `session.json` | 別主体の有効な logged-in cookie を得たときだけ `{"cookie":"…"}`。`cookie` には `wordpress_logged_in_` cookie の値だけを入れ、名前と `=` は含めない。無ければ空ファイル。 |
| `steps.md` | 実際に行った手順と観測。空にしない。書き方は次節の最後にある。 |
| `refutation.md` | 成立しなかったときの観測。無ければ空ファイル。 |
| `precondition` | 満たせない前提の具体的な理由。すべて満たしたら空ファイル。 |

前提や観測が不足した場合は、その不足を記録する。反証や `contradicted` を自己申告しない。対象固有の手順は Finding とその固定ソースから判断し、このスキル本文に固定しない。

## 種別ごとの手順

`finding.impact` で手順の形を選ぶ。どの入力面と画面を使うかは Finding と固定ソースから決める。

**`stored-xss`**

1. 攻撃者位置で届く入力面（コメントのような公開面への投稿や送信）に script canary を載せ、保存させる。直接の nonce 付き POST には `canary.javascript` を使う。入力面が長いコードを切り詰めるなら、`canary.loaderJavascript` を実行させる。これは同じ POST を送る短い module を読み込む。module の URL を画像や stylesheet として読み込んでも beacon は記録されない。
2. 保存した値が描画される画面を、`route.json` の `victim.paths` に 1〜5 件書く。`victim.role` には、その画面を開く被害者を選ぶ。管理者なら `administrator`、ログインしていない訪問者なら `unauthenticated` にする。攻撃者自身の account で開く画面は被害者にならない。
3. Harness の Lab browser が、攻撃者とは別のセッションでその画面を開き、beacon の着信を観測する。

**`rce`、`php-file-write`**

1. `canary.php` を変えずに、route が攻撃者に置かせる場所へ置く。ほかのコードは書かない。
2. 置いたコードを実行させる要求まで攻撃者位置で送り、`route.json` の `steps` に含める。
3. Harness は Lab 内で canary が実行された印を観測する。置いただけで実行されないコードは数えない。

**`sqli`**

1. `canary.table` は Harness が Lab に置いた table で、行の値は渡されない。Finding の経路の HTTP 要求で、その行を応答に返させるか、行を変える。
2. `attack.json` の DB account は読み取り専用である。そこで読んだ値を要求に入れても数えない。要求に含まれない値が応答に出たときだけ観測になる。時間差は数えない。

**`arbitrary-file-read`、`arbitrary-file-download`、`lfi`**

1. Harness は Lab に canary ファイルを 2 本置く。web root の外の 1 本と、web root の PHP ファイル 1 本で、場所は `src/profiles/wordpress/lab/canary-placement.ts` にある。
2. 攻撃者位置の要求で、その中身を応答に返させる。2 本とも読めれば、パスと拡張子を選べたことの記録になる。Harness は応答本文に canary の値が出たかを観測する。

**`arbitrary-file-delete`**

1. 同じ canary ファイルを攻撃者位置の要求で消させる。ほかのファイルは消さない。Harness は Lab 内でファイルが消えたかを観測する。

**`privesc-to-admin`、`auth-bypass-to-admin`、`account-takeover`**

1. 攻撃者 account を `administrator` にするか、`canary.username` の account を標的にして、その account の認証済みセッションまで route を進める。得たセッションの cookie 値は `session.json` に書く。
2. password 再設定の cookie、redirect、設定管理者のセッションは効果の成立にならない。canary account の password は渡されないので使わない。Harness は攻撃者 account の role の変化と、`session.json` のセッションの持ち主を観測する。

上に無い impact は、Finding が主張する効果を攻撃者位置の HTTP で起こし、観測したことを `steps.md` に書く。

**`steps.md` の書き方。** `steps.md` は Private Evidence に残り、所有者が手で再現するときの手順になる。実行した順に、攻撃者位置、各要求の method と path、`victim` に書いた画面と操作、観測した応答や画面を書く。

## しないこと

スキルは判定しない。`runtime-confirmed` と `contradicted` は Harness の判定器だけが出す。
