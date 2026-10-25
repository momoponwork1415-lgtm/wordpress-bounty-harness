---
name: wbh-verify
description: scope 内 Finding 1 件を、Harness が `verify next --handoff` で立てた Lab 上で再現する。review export と setup 用 `lab.json` を読み、通常機能の前提を作って `setup-done` を置く。`observation-ready` 後に攻撃用 `attack.json` を読み、種別ごとの手順に従って攻撃者位置だけで route を実行し、6 ファイルを書く。判定はしない。
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
| `route.json` | `{"role":"unauthenticated","account":"none","defaultSettings":true,"configurationChanges":[],"steps":[{"kind":"http","method":"POST","path":"/<path>","expected":"<observation>"}],"victim":{"role":"administrator","paths":["/<path>"]}}`。`role`・`account`・`defaultSettings`・`configurationChanges`・`steps` は必ず書く。`role` は Finding の `attackerPosition` と一致させ、`account` は攻撃者 account の username をそのまま（`unauthenticated` なら `none`）にする。`steps` は実行した HTTP 手順だけにする。`victim` は必要なときだけ入れる。数値 alert を観測させるときだけ `victim.dialogMarker` に 10〜15 桁のマーカーを文字列で加える。 |
| `http.json` | 実際の通信を `{"exchanges":[{"request":{"path":"/…","method":"…"},"response":{"body":"…"}}]}` として記す。少なくとも 1 件必要。これはエージェントの記録であり証明ではない。 |
| `session.json` | 別主体の有効な logged-in cookie を得たときだけ `{"cookie":"…"}`。`cookie` には `wordpress_logged_in_` cookie の値だけを入れ、名前と `=` は含めない。無ければ空ファイル。 |
| `steps.md` | 実際に行った手順と観測。空にしない。書き方は次節の最後にある。 |
| `refutation.md` | 成立しなかったときの観測。無ければ空ファイル。 |
| `precondition` | 満たせない前提の具体的な理由。すべて満たしたら空ファイル。 |

前提や観測が不足した場合は、その不足を記録する。反証や `contradicted` を自己申告しない。対象固有の手順は Finding とその固定ソースから判断し、このスキル本文に固定しない。

## 判定器が照合すること

判定器は `src/profiles/wordpress/verification/judges.ts` と `src/profiles/wordpress/lab/lab-observation.ts` にある。書く前に読める。下は、そこで照合される条件である。

- **形を試す要求は前提作りの段で送る。** 捕捉は `setup-done` の後に始まるので、その前の要求は照合に混ざらない。
- **canary を含む要求は 1 本だけにする。** 判定器は `http.json` のやり取りのうち canary を含むものを 1 件ずつ見て、そのすべてが完了した route step と一致することを求める。2 本送って 1 本しか書かなければ、残りが一致せず `incomplete` になる。送る本文は最初の 1 本の前に決める。
- **応答が完了していること。** 2xx、または `Location` が同じ host で `/wp-login.php` でない 301・302・303・307・308 を完了とみなす。本文が JSON で `success` が偽なら、状態が 200 でも失敗とみなす。
- **本文は 1 バイトも違わないこと。** 一致は method・path・本文で見る。`body` を省いた step は空の本文と照合される。送った wire body をそのまま書く。
- **`headers` は書かなければ照合されない。** 書いた名前の値はすべて一致が要るので、必要がなければ書かない。
- **canary を含む要求が 1 本も無ければ `incomplete`。** `route.json` や `http.json` に canary の token を書くだけでは数えない。
- **`unauthenticated` の攻撃者位置では、`x-wp-nonce` を付けた要求と、どのセッションか決まらない cookie を送ると棄却される。** `unauthenticated` 以外では、canary を含む要求に攻撃者のセッションが確認できることが要る。
- **被害者の画面と入力に canary の token を書かない。** `steps` の path か `victim` に token が現れると、Lab 観測器は観測そのものを棄却する（`observer-canary-input`）。数値マーカーも Lab browser の訪問 path（route の観測用 path と `victim.paths`）や被害者の操作値に入れず、攻撃者の要求だけに載せる。
- **攻撃者 account の role を変えない。** 攻撃者 account が宣言した低い権限だけを持つ状態でなくなると `incomplete` になる。

`route.json` が schema に通らないと route が保存されず、攻撃者位置の誤りとして報告される。`role` が `finding.attackerPosition` と違うときも同じ文になる。書く前に上の表の形と見比べる。

## 種別ごとの手順

`finding.impact` で手順の形を選ぶ。どの入力面と画面を使うかは Finding と固定ソースから決める。

**`stored-xss`**

1. 攻撃者位置で届く入力面（コメントのような公開面への投稿や送信）に script canary を載せ、保存させる。`attack.json` の `canary.javascript` か `canary.loaderJavascript` を、**文字列として変えずに**実行させる。出口が element の中身の位置なら `canary.javascript` をそのまま script 要素の中に置ける。長さで切られるか、属性の位置で引用符が足りないときは `canary.loaderJavascript` を使う。これは同じ POST を送る短い module を読み込む。
   canary の受け口が記録するのは、`/b/<token>` への POST で、`X-WBH-Script-Canary` header の値が token と一致し、`Origin` が Lab の WordPress のものである要求だけである（`src/profiles/wordpress/lab/container-startup.ts`）。それ以外は 403 になる。だから、`beaconUrl` を使って自分で要求を組まない。header の無い `fetch`、`img` や stylesheet としての読み込み、`/b/` への GET では beacon は記録されない。どちらの形も実行できないときは、試したことを `refutation.md` に書く。canary の運び手を自分で発明しない。
   canary のコードがその出力面に収まらないなど、nonce beacon の回収が難しいときは、低い確度のブラウザ観測として数値 alert を試せる。その attempt だけで使う先頭が 0 でない 10〜15 桁の数字を選び、攻撃者の入力に `alert(<その数字>)` を載せる。`victim.dialogMarker` に同じ数字を文字列で宣言する。前提作り中にそのマーカーを置かず、`observation-ready` 後にマーカーを含む攻撃者 HTTP 要求を 1 本だけ送り、その method・path・送信した wire body と応答を route / http 記録に残す。canary のコードを数値 alert に置き換えた場合、nonce beacon の証明にはならない。
   `href` のように操作して初めて評価される出口では、固定ソースと前提作り中の Lab の HTTP 応答から出力形を確かめる。`target="_blank"` だけを根拠に `javascript:` を実行不能と決めて click を省かない。`rel` などの属性とブラウザ挙動で結果が変わる。通常の操作が必要なら手順 2 の `actions` に指定し、`setup-done` 後は管理者資格を再利用せず、Harness の Lab browser に観測させる。
2. 保存した値が描画される画面を、`route.json` の `victim.paths` に 1〜5 件書く。描画が読み込みだけで起きる画面を選ぶ。Lab browser は route と victim の前に `/`、`/wp-admin/`、`/wp-admin/edit.php` を自分で開くので、一覧画面は確かめやすい。画面側の JavaScript が組む経路（fragment で切り替わる画面）や新しいタブを開く link しか無いときは、`actions` を付けたうえで、その画面を選んだ理由を `steps.md` に書く。遷移できないと観測は `victim-page (victim-navigation)` で終わる。`victim.role` には、その画面を開く被害者を選ぶ。管理者なら `administrator`、ログインしていない訪問者なら `unauthenticated` にする。攻撃者自身の account で開く画面は被害者にならない。
   値がサニタイズで落ちて操作対象が無い場合は、無意味な click を作らない。入力から保存・描画までのどこで落ちたか、固定ソースのファイルと行、および Lab の観測を `refutation.md` に書く。他の出力経路も固定ソースで確認する。canary が届かないことだけを反証にしない。
3. Harness の Lab browser が、攻撃者とは別のセッションでその画面を開く。canary 経路では beacon の着信を観測する。数値 alert 経路では、宣言した被害者画面・操作中に Lab と同じ origin で一致した dialog を観測し、dismiss 後の画面とイベントを Private Evidence に残す。`steps.md` に使用した経路、数値 alert を選んだ理由、被害者の role、画面と操作、実際の観測を分けて書く。数値の一致と攻撃要求の捕捉があっても、既存コンテンツからの発火、因果関係、影響は人間が確認する。結果は `incomplete` の補助証拠で、`runtime-confirmed` や人間の手動再現ではない。

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
