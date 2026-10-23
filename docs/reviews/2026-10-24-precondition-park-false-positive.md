# 検証前に誤って park された Finding の確認（2026-10-24）

## 問い

本番の `finding-parked` に、SPEC 第 7 節の「明示された非既定の管理者設定」に当たらない Finding が混ざっていないか。

## 確認したこと

本番台帳にある管理者設定前提の park は 3 件だった。Private Evidence の `configurationPrecondition` を現在の分類器に通し、反応した文の位置だけを調べた。2 件は明示的な管理者設定を前提としていた。残る 1 件は、製品名とパスワード保護の否定表現が、`password-protected` という語だけを拾う正規表現に一致していた。設定の有効化は主張されていない。

後者の誤判定は、Finding が探索の出口で `finding-parked` となり、検証列とレビュー列に入らない原因になっていた。従来の `review decide --decision defer` は `finding-recorded` がないため使えない。また、後から `finding-recorded` だけを追記しても、各投影は歴史的な park を見て除外し続ける。

## 修正と確認

分類器はパスワード保護の単語だけで park せず、明示された visibility setting または肯定形の保護コンテンツを要求する。明示的な管理者設定の 2 件は引き続き `admin-configuration` になる。Private Evidence の 3 件を修正版で読み直すと、明示設定の 2 件は従来どおり、否定表現と製品名の 1 件だけが `unknown` になった。`unknown` は技術的な成立を意味せず、Lab で確認する対象である。

誤判定の復帰関数は、保存済み Finding の digest を再確認し、campaign・Finding ID・run・Snapshot・impact・Programme Boundary と現在の分類を照合する。合格したものにだけ `finding-recorded` と `finding-park-restored` を追記する。元の `finding-parked` は消さない。全投影で復帰イベントを有効にするには、対応する park と記録済み Finding の identity と Snapshot が一致する必要がある。途中で停止しても、再実行で残りの marker を記録できる。

操作前には `pnpm build` の後、`node scripts/restore-parked-finding.mjs --state <private-state-dir> --campaign <id> --finding <id>` で実台帳を読み取り専用で照合する。同じ引数に `--apply` を足した場合だけ追記する。適用後に `review parked`、`review export`、funnel、検証列を確認する。対象 ID と Private Evidence の本文は Git に書かない。

本番 runner が新しい `finding-park-restored` event schema を読める版へ切り替わったことを確認するまで、`--apply` は実行しない。旧版 reader の稼働中に新 event を追記すると、共有台帳の読み取りが失敗し得る。

合成 Finding による赤から緑へのテストと `pnpm check` で、新規受理、復帰後のレビュー列・funnel、履歴保持、二重実行、中断後の再実行、Programme Boundary の拒否を確認した。本番台帳への復帰イベントは、この報告時点ではまだ書いていない。

## 残る判断

通常機能を有効化する 2 件は、現在の SPEC 第 7 節と ADR 0038 の「明示された特別な管理者設定を park」に当たりうる。その扱いは所有者に確認中であり、この修正では復帰しない。検証結果の判定器や nonce canary の条件も変えない。
