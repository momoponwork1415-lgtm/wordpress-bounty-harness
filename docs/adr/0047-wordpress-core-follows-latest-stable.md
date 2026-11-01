---
status: accepted
date: 2026-11-01
amends: 0037 の「WordPress core 版は `wordpressVersion` で固定する」運用、SPEC §6 の Snapshot の本体の版の決め方
---

# WordPress 本体は常に最新の安定版に追随し、方針に版を書かない

## 背景

Snapshot と Lab の WordPress 本体は、`selection.json` と campaign 設定の `wordpressVersion`、host 設定の `images.wordpress`、`containers/wordpress-lab/Dockerfile` の base image の 4 か所で同じ版を固定していた。2026-11-01 時点で image は 7.1.3、WordPress.org の最新は 7.1.4 だった。所有者は 2026-11-01 に「WordPress のバージョンは常に最新版を使う」と指示した（#741）。

## 決定

1. 自動選定の方針と campaign 設定の `wordpressVersion` は任意にする。書いてあれば固定（開発・歴史的評価用）、無ければ Lab image の版を本体の版とする。出荷する `selection.json` と `campaign.json` からは消す。
2. `select` は WordPress.org の `core/version-check/1.7` から最新の安定版を読み、image の版と比べる。同じなら image の版で Snapshot を作り、選定レポートに `core: { status, source, version, latest }` を残す。違えば何も凍結せず `core-image-outdated` を返す。version-check が読めなければ `core-release-unavailable` を返す。どちらも正常な候補 0 件ではなく、ランナーは一覧取得失敗と同じ間隔で待って選定し直す。
3. image の更新は運用 script `containers/wordpress-lab/refresh-image.sh` が行う（最新版の取得、公式 image の pull、digest の表示、`--write` で host 設定の書き換え）。判断の要らない処理なので Harness のコードには置かない。`runtime check` は `wordpress-core` の行で同じ比較を出す。
4. 探索の `/workspace/wordpress`、検証 Lab、review Lab は同じ Snapshot の本体を使うので、変更はこの 3 点で足りる。

## 理由

版を Git に書くと、WordPress のリリースごとに方針 PR が要り、その間は旧版で探索と検証が進む。image を正本にして最新版との差を select で検査すれば、遅れは「何も凍結しない」として見え、黙って旧版に落ちることが無い。固定したい開発と歴史的評価は、従来どおり `wordpressVersion` を書く。

## 採らなかった選択肢

- host 設定の `images.wordpress` を「版 → digest」の表にして自動で選ぶ: image を揃える作業は結局 script で行うので、表は増えた設定の分だけ複雑になる。
- 最新版でなくても旧 image で続ける: 所有者の指示に反する。
- select を止めずに警告だけ出す: 無人運転では誰も読まない。

## 帰結

- 本番の campaign 設定（Git 外）にはまだ `wordpressVersion: "7.1.3"` が書かれており、消すまでは固定のまま動く。ランナー再起動時に script で image を 7.1.4 に更新し、設定から版を消す。
- `target-selected` の型は変えない。本体の版は Snapshot の依存に残り、選定レポートの `core` でも読める。

## 消し方

`wordpressVersion` を方針と設定に戻して必須にし、`resolveSelectionCore` と `coreRelease` / `coreImageVersion` の boundaries、script を消す。記録済みの選定レポートの `core` 欄は読み続ける。
