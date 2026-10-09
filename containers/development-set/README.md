# 開発セットの実行 image

`codex/Dockerfile` は Codex CLI 0.161.0 と source 読み取り・Lab 観測用の client を、digest 固定の Node image 上に置く。`browser/Dockerfile` は同じ版の Playwright package と browser を揃える。Dockerfile の build 時に対象 plugin は実行しない。

両 image は build 後にローカル registry へ push し、得られた `name@sha256:<digest>` を Git 外の host 設定に記す。元の host 設定は上書きせず、開発セット専用の複製を使う。Codex CLI 版と、host 設定の `codex.bundledCatalogPath` の sha256 を `runtimeProfile` と照合する。`harness runtime check` が通るまで実 run を開始しない。

Lab と探索対象の実行は引き続き `runsc` に限る。registry は image 配布用で、対象 source と認証情報を mount しない。鍵、credential file の内容、採点結果の私的詳細は image に含めない。
