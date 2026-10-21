---
name: wbh-verify
description: scope 内 Finding 1 件を、Harness が `verify next --handoff <dir>` で立てた Lab 上で再現する。review export と setup 用 `lab.json` を読み、通常機能の前提を作って `setup-done` を置く。`observation-ready` 後に攻撃用 `attack.json` を読み、攻撃者位置だけで route を実行して 6 file を書く。判定はしない。
---

# wbh-verify

## 入力と境界

新しい `<dir>` を 1 attempt 専用に使う。`lab.json` の `reviewExport` が指す JSON から `finding` の主張・`attackerPosition`・`configurationPrecondition` を読む。`lab.json` の `host.url` は Lab への接続先で、HTTP リクエストには `host.hostHeader` を Host header として使う。`lab.json` の `administrator` は前提作り専用である。攻撃者の資格と attempt 専用の `canary` は `lab.json` に含まれず、基線を取り直した後に `lab.json` の `files.attack` が指す `attack.json` で渡される。資格、payload、HTTP 本文を Git や PR・Issue に書かない。

## 手順

- Finding の前提を通常機能の範囲で作る。管理者資格を使えるのはここまで。前提が作れないときは具体的な理由を `<dir>/precondition` に書いてから、`<dir>/abort` に `precondition-unavailable` とだけ書いて終える。
- 管理者の操作がすべて終わったら `<dir>/setup-done` を置く。以後は管理者の資格・cookie・session を使わない。Harness が HTTP 捕捉と Lab 状態の基線を取り直して `<dir>/observation-ready` を置くまで、攻撃者の操作を始めない。合図の後に `attack.json` が現れるまで待ち、`runId`・`findingId`・`snapshotDigest` が `lab.json` と一致することを確認する。`attack.json` の `accounts` は Finding の `attackerPosition`（`unauthenticated` / `subscriber` / `customer`）に限る。
- 攻撃者の HTTP 手順を実行する。`attack.json` に `canary` があれば Finding の経路に置く。被害者側の操作は行わず、画面と必要な操作を `route.json` の `victim` に記す。Harness の Lab browser が観測する。
- 被害者画面で通常の操作が必要なら、`victim.paths` の各 path に `actions` を付ける。型は `click`（`selector`）、`click-text`（`text` と `exact`）、`fill`（`selector` と `value`）で、1 path あたり 5 操作まで。どの画面をどう操作するかは Finding と固定 source から決める。
- `route.json` の各 HTTP step は実行した method・path・headers と一致させる。本文を送ったときは、実際に送信した wire body を `body` に正確に記録する。本文が空のときだけ `body` を省略できる。
- `<dir>` に次の 6 file を内容まで書き終える。各 file は同じディレクトリの一時 file に全内容を書き、rename で確定する。`precondition` を最後に確定すると Harness が読む。途中で続行できなくなれば、具体的な理由を `<dir>/precondition` に書いてから `<dir>/abort` に理由コードを 1 行だけ書く。コードは `precondition-unavailable`、`route-unavailable`、`observer-unavailable`、`handoff-interrupted` のいずれかにする。

| file | 内容 |
| --- | --- |
| `route.json` | `{"role":"unauthenticated","defaultSettings":true,"steps":[{"kind":"http","method":"POST","path":"/<path>","expected":"<observation>"}],"victim":{"role":"administrator","paths":["/<path>"]}}`。`role` は Finding と一致させ、`steps` は実行した HTTP 手順だけにする。`victim` は必要なときだけ入れる。 |
| `http.json` | 実際の通信を `{"exchanges":[{"request":{"path":"/…","method":"…"},"response":{"body":"…"}}]}` として記す。少なくとも 1 件必要。これは agent の記録であり証明ではない。 |
| `session.json` | 別主体の有効な logged-in cookie を得たときだけ `{"cookie":"…"}`。`cookie` には `wordpress_logged_in_` cookie の値だけを入れ、名前と `=` は含めない。無ければ空 file。 |
| `steps.md` | 実際に行った手順と観測。空にしない。 |
| `refutation.md` | 成立しなかったときの観測。無ければ空 file。 |
| `precondition` | 満たせない前提の具体的な理由。すべて満たしたら空 file。 |

前提や観測が不足した場合は、その不足を記録する。反証や `contradicted` を自己申告しない。対象固有の手順は Finding とその固定 source から判断し、この skill 本文に固定しない。

## しないこと

skill は判定しない。`runtime-confirmed` と `contradicted` は Harness の判定器だけが出す。
