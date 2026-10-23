# WordPress Lab の自己 HTTP 要求の DNS 失敗

日付: 2026-10-24。対象: 本番 Check Email handoff で観測された、WordPress コンテナからの `wp_safe_remote_get(home_url())` 失敗。これは原因と修正の調査記録であり、設計の正本ではない。

## 問いと原因

使い捨ての gVisor Lab 内で、WordPress が自サイトの `http://wordpress/` に HTTP 要求を送れるか。従来の `startWordPress` は Docker の `--network-alias wordpress` だけを設定していた。gVisor コンテナ内ではこの alias の DNS 解決が安定しないことが SPEC 第 14 節の実機記録にも残っている。他の Lab peer は `--add-host` で `wordpress` を明示的に解決しているが、WordPress 本体には設定されていなかった。

固定した無害な fixture plugin の Snapshot を新規 Lab に供給し、WordPress コンテナ内で `wp_safe_remote_get(home_url('/'))` を実行した。修正前は `cURL error 6: Could not resolve host: wordpress`。同じテストで WordPress 本体に限って `--add-host=wordpress:127.0.0.1` を付けると HTTP 200 になった。Apache は同じコンテナの loopback で応答し、WordPress の safe HTTP API もこの URL を拒まなかった。

## 実測と境界

| 実測 | 修正前 | 修正後 |
| --- | --- | --- |
| WordPress 内 `wp_safe_remote_get(home_url('/'))` | `cURL error 6` | HTTP 200 |
| 別の runsc peer → recorder → WordPress | 未測定 | HTTP 200、recorder に `/?wbh_probe=peer` の交換 1 件以上、drop 0、欠陥 0 |
| Lab teardown | 実行 | 実行。新規 Lab の container・network・volume は残らない |

再現テストは `tests/profiles/wordpress/lab-self-request.integration.test.ts`。`pnpm build` 後、`WBH_REAL_LAB_IMAGES` にローカルの固定 image digest 群を渡して個別実行した。テストの Docker runner は Vitest が TS source を読む際の recorder 資産 mount だけを `dist/lab-recorder` へ向ける。Lab 本体は実際の `runsc`、`--internal` network、Snapshot と WordPress 初期化を使う。修正前の赤と修正後の緑を同一テストで確認した。

今回の `/etc/hosts` は WordPress コンテナ自身にだけ加える。攻撃者側 peer は従来どおり recorder の IP に `wordpress` を割り当てるため、その HTTP は捕捉された。WordPress が自分で行う内部 HTTP は recorder を経由しない。これは内部 follow-up の全 HTTP を捕捉する変更ではない。判定器は引き続き Harness が捕捉した攻撃者経路と nonce canary に基づいて判断するため、内部 follow-up の詳細が証拠に必要な Finding は、この修正だけでは確認済みにしない。

対象 Snapshot、Lab Setup digest、canary 播種、判定器、gVisor 設定、外向き通信の経路には変更を加えていない。WordPress の loopback への自己接続だけが新たに成立する。
