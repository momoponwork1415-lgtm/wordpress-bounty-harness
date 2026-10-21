---
name: wbh-verify
description: scope 内 Finding 1 件を、Harness が `verify next --handoff <dir>` で立てた Lab 上で再現する。review export 1 件と `<dir>/lab.json` を読み、通常機能の前提を Lab の管理者で作って `setup-done` を置き、以後は攻撃者位置の資格だけで route を実行して 6 file を書く。判定はしない。
---

# wbh-verify

## 読む入力

review export 1 件（`lab.json` の `reviewExport` が指す JSON）と、`<dir>/lab.json`。`lab.json` には接続先、攻撃者位置の資格（subscriber / customer）、Lab の設定管理者の資格、canary の節、review export の path がある。

## 手順

- (a) Finding の `configurationPrecondition` を読み、通常機能の前提を Lab の管理者で作る（例: form を 1 つ置く。設定は既定のまま）。対象固有の名前はこの skill 本文に書かず、export の文から取る。
- (b) `<dir>/setup-done` を置く。前提作りだけ管理者を使い、`setup-done` 以後は攻撃者位置のみ。
- (c) 攻撃者位置の資格だけで route を実行し、`<dir>` に 6 file `route.json` `http.json` `session.json` `steps.md` `refutation.md` `precondition` を書く。route は HTTP step だけ（`standard-python-v1` が読む形）。victim の画面は `route.json` の `victim` に書き、Harness の Lab browser が開く。skill はブラウザを持たない。
- (d) 再現できなければ `refutation.md` に観測を書く。途中で止めるときは `<dir>/abort` を置く。

## しないこと

skill は判定しない。`runtime-confirmed` は Harness の判定器だけが出す。
