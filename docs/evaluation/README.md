# 公開sourceのpin

[`public-source-pins.json`](public-source-pins.json) は、終了したIssue #10で集めた公開plugin sourceと、共通のWordPress coreの取得元・digestを記録する過去資料。現在の初期受入は [TranslatePressベンチマーク](../TRANSLATEPRESS-BENCHMARK.md) に絞る。答えの鍵、原因箇所、advisory本文、payloadは含めない。このファイルを探索runへ渡さない。探索には固定したsource packだけを渡す。

6件のpluginはWordPress.orgの版付きzipを取得し、転送されたarchive bytesのSHA-256とbyte数を記録した。zipはGit外に保存した。Unlimited Elements 2.0.16の版付きzipとSVN tagは無かったため、WordPress.orgのSVN trunk `r3628543` をexportした。このrevisionのlogは2.0.16への更新と記し、plugin headerも `Version: 2.0.16`。`sourceTreeDigest` はexport後のcanonical source tree digestであり、zipのdigestとは異なる。

coreは開発セットで使ったdigest固定の公式WordPress imageから、未起動containerを通じて取り出した。`wp-includes/version.php` は6.8.3で、`sourceDigest` はDependency Snapshot用のcanonical manifest digest。各caseでのpluginの起動、追加依存、設定、core 6.8.3との互換性は未確認。TranslatePressの2ケースは実行前に完全なsource/setup pinを作る。他のcaseのheld-out実行は予定しない。
