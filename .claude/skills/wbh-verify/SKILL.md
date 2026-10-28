---
name: wbh-verify
description: scope 内 Finding 1 件を、Harness が `verify next --handoff` で立てた Lab 上で再現する。review export と setup 用 `lab.json` を読み、通常機能の前提を作って `setup-done` を置く。`observation-ready` 後に攻撃用 `attack.json` を読み、種別ごとの手順に従って攻撃者位置だけで route を実行し、6 ファイルを書く。判定はしない。
---

# wbh-verify

## 入力と境界

新しい `<dir>` を 1 attempt 専用に使う。`lab.json` の `reviewExport` が指す JSON から `finding` の主張・`impact`・`attackerPosition`・`configurationPrecondition` を読む。`lab.json` の `host.url` は Lab への接続先で、HTTP リクエストには `host.hostHeader` を Host header として使う。`lab.json` の `administrator` は前提作り専用である。攻撃者の資格は `lab.json` に含まれず、基線を取り直した後に `lab.json` の `files.attack` が指す `attack.json` で渡される。資格、ペイロード、HTTP 本文を Git や PR・Issue に書かない。

## 手順

- Finding の前提を通常機能の範囲で作る。管理者資格を使えるのはここまで。前提が作れないときは具体的な理由を `<dir>/precondition` に書いてから、`<dir>/abort` に `precondition-unavailable` とだけ書いて終える。
- 前提作りでは、攻撃者 account の role に触れない。
- 管理者の操作がすべて終わったら `<dir>/setup-done` を置く。Harness はここで設定管理者のセッションと application password を破棄し、password を変える。前提作りで得た cookie は以後通らないので使わない。Harness が HTTP 捕捉と Lab 状態の基線を取り直して `<dir>/observation-ready` を置くまで、攻撃者の操作を始めない。合図の後に `attack.json` が現れるまで待ち、`runId`・`findingId`・`snapshotDigest` が `lab.json` と一致することを確認する。`attack.json` の `accounts` は Finding の `attackerPosition`（`unauthenticated` / `subscriber` / `customer`）に限る。
- `setup-done` 以後に Lab へ送る要求は、すべて Harness が捕捉する。形を試す要求は前提作りの段で送る。捕捉は `setup-done` の後に始まるので、その前の要求は記録に混ざらない。
- 攻撃者の HTTP 手順を、次節の種別ごとの手順に従って実行する。被害者側の操作は行わず、画面と必要な操作を `route.json` の `victim` に記す。Harness の Lab browser が観測する。
- 被害者画面で通常の操作が必要なら、`victim.paths` の各 path に `actions` を付ける。型は `click`（`selector`）、`click-text`（`text` と `exact`）、`fill`（`selector` と `value`）、`set-file`（`selector`、`fixture`、省略できる `fileName`）で、1 path あたり 5 操作まで。どの画面をどう操作するかは Finding と固定ソースから決める。数値マーカーは Lab browser の訪問 path（`victim.paths`）や被害者の操作値に入れず、攻撃者の要求だけに載せる。入れると Lab 観測器は観測を棄却する（`observer-marker-input`）。
- `set-file` の `fixture` は Harness が持つ `image-png`、`image-jpeg`、`text-plain` の 3 種で、中身は route から渡せない。`fileName` を指定するときの拡張子は `image-png` は `.png`、`image-jpeg` は `.jpg`、`text-plain` は `.txt` に限る。
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

`route.json` が schema に通らないと route が保存されず、攻撃者位置の誤りとして報告される。`role` が `finding.attackerPosition` と違うときも同じ文になる。書く前に上の表の形と見比べる。

## 種別ごとの手順

`finding.impact` で手順の形を選ぶ。どの入力面と画面を使うかは Finding と固定ソースから決める。

**`stored-xss`**

1. 攻撃者位置で届く入力面（コメントのような公開面への投稿や送信）に数値 alert を載せ、保存させる。その attempt だけで使う先頭が 0 でない 10〜15 桁の数字を選び、攻撃者の入力に `alert(<その数字>)` を載せる。`victim.dialogMarker` に同じ数字を文字列で宣言する。前提作り中にそのマーカーを置かず、`observation-ready` 後にマーカーを含む攻撃者 HTTP 要求を 1 本だけ送り、その method・path・送信した wire body と応答を route / http 記録に残す。
   `href` のように操作して初めて評価される出口では、固定ソースと前提作り中の Lab の HTTP 応答から出力形を確かめる。`target="_blank"` だけを根拠に `javascript:` を実行不能と決めて click を省かない。`rel` などの属性とブラウザ挙動で結果が変わる。通常の操作が必要なら手順 2 の `actions` に指定し、`setup-done` 後は管理者資格を再利用せず、Harness の Lab browser に観測させる。
2. 保存した値が描画される画面を、`route.json` の `victim.paths` に 1〜5 件書く。描画が読み込みだけで起きる画面を選ぶ。Lab browser は `victim.paths` だけを開く。画面側の JavaScript が組む経路（fragment で切り替わる画面）や新しいタブを開く link しか無いときは、`actions` を付けたうえで、その画面を選んだ理由を `steps.md` に書く。遷移できないと観測は `victim-page (victim-navigation)` で終わる。`victim.role` には、その画面を開く被害者を選ぶ。管理者なら `administrator`、ログインしていない訪問者なら `unauthenticated` にする。攻撃者自身の account で開く画面は被害者にならない。
   値がサニタイズで落ちて操作対象が無い場合は、無意味な click を作らない。入力から保存・描画までのどこで落ちたか、固定ソースのファイルと行、および Lab の観測を `refutation.md` に書く。他の出力経路も固定ソースで確認する。dialog が出ないことだけを反証にしない。
3. Harness の Lab browser が、攻撃者とは別のセッションでその画面を開く。宣言した被害者画面・操作中に一致した dialog を記録し、dismiss 後の画面とイベントを Private Evidence に残す。`steps.md` に被害者の role、画面と操作、実際の観測を分けて書く。数値の一致と攻撃要求の捕捉があっても、既存コンテンツからの発火、因果関係、影響は人間が確認する。結果は `incomplete` で、人間の手動再現ではない。

**`rce`、`php-file-write`**

1. route が攻撃者に置かせる場所へコードを置く。
2. 置いたコードを実行させる要求まで攻撃者位置で送り、`route.json` の `steps` に含める。置いただけで実行されないコードは数えない。

**`sqli`**

1. Finding の経路の HTTP 要求で、行を応答に返させるか、行を変える。
2. `attack.json` の DB account は読み取り専用である。そこで読んだ値を要求に入れても数えない。要求に含まれない値が応答に出たときだけ観測になる。時間差は数えない。

**`arbitrary-file-read`、`arbitrary-file-download`、`lfi`**

1. 攻撃者位置の要求で、ファイルの中身を応答に返させる。

**`arbitrary-file-delete`**

1. 攻撃者位置の要求でファイルを消させる。

**`privesc-to-admin`、`auth-bypass-to-admin`、`account-takeover`**

1. 攻撃者 account を `administrator` にするか、別主体の認証済みセッションまで route を進める。得たセッションの cookie 値は `session.json` に書く。
2. password 再設定の cookie、redirect、設定管理者のセッションは効果の成立にならない。

上に無い impact は、Finding が主張する効果を攻撃者位置の HTTP で起こし、観測したことを `steps.md` に書く。

**`steps.md` の書き方。** `steps.md` は Private Evidence に残り、所有者が手で再現するときの手順になる。実行した順に、攻撃者位置、各要求の method と path、`victim` に書いた画面と操作、観測した応答や画面を書く。

## しないこと

スキルは判定しない。確定は、人間が Lab の dialog、観測記録、捕捉を読んで行う。

6 ファイルを確定した後は、Lab に要求を送らない。Harness は attempt を記録した後、捕捉と review Lab package があれば、人間が観測するために同じ Lab を残す（ADR 0038 の追記 12）。そのとき出力に出る管理者の account（`review administrator:`）は、人間が被害者側の操作に使うものなので使わない。`review observe` と `review decide --reproduced` も打たない。
