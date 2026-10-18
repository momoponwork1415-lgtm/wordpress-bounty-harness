# 公開sourceのpin

[`public-source-pins.json`](public-source-pins.json) は、終了したIssue #10で集めた公開plugin sourceと、共通のWordPress coreの取得元・digestを記録する過去資料。現在の初期受入は [TranslatePressベンチマーク](../TRANSLATEPRESS-BENCHMARK.md) に絞る。答えの鍵、原因箇所、advisory本文、payloadは含めない。このファイルを探索runへ渡さない。探索には固定したsource packだけを渡す。

6件のpluginはWordPress.orgの版付きzipを取得し、転送されたarchive bytesのSHA-256とbyte数を記録した。zipはGit外に保存した。Unlimited Elements 2.0.16の版付きzipとSVN tagは無かったため、WordPress.orgのSVN trunk `r3628543` をexportした。このrevisionのlogは2.0.16への更新と記し、plugin headerも `Version: 2.0.16`。`sourceTreeDigest` はexport後のcanonical source tree digestであり、zipのdigestとは異なる。

coreは開発セットで使ったdigest固定の公式WordPress imageから、未起動containerを通じて取り出した。`wp-includes/version.php` は6.8.3で、`sourceDigest` はDependency Snapshot用のcanonical manifest digest。各caseでのpluginの起動、追加依存、設定、core 6.8.3との互換性はこの旧資料だけでは確認できない。#127の実行可否と結果は下記カタログと日付付き評価に記録する。

Unlimited Elements 2.0.16 だけは 2026-10-12 の後続確認で `pluginDependencies` に Elementor 4.2.0 の公式版付き ZIP と展開後の tree digest を追加した。全体の `observedAt` は旧資料の観測日で、この依存の観測日は項目内に記録した。対象のヘッダーは Elementor 4.2.0 までを tested up to と記し、Elementor 側のヘッダーは WordPress 6.8 以上を要求する。公式 SVN の指定 revision を export して対象・Elementor・Core の pin を照合していた静的 preflight の `scripts/preflight-unlimited-elements-sources.mjs` は 2026-10-19 に削除した（再開時は Git 履歴から戻す）。

## #127 再発見カタログ

[`rediscovery-catalog-pins.json`](rediscovery-catalog-pins.json) には、Git 外のmanifestのSHA-256と各caseの脆弱版・修正版だけを置く。2026-10-16 の所有者決定で、catalog は所有者が発見者の公開記録だけにした（16 の対象版、19 記録。一覧は [docs/agents/measurement.md](../agents/measurement.md) の開発セット）。修正版ZIPのbytesとdigest、公開記録IDと日付はGit外のmanifestにあり、探索入力には使わない。

このpinとmanifestを作った `scripts/build-rediscovery-catalog.mjs` は 2026-10-19 に削除した。catalog を作り直すときは Git 履歴から戻す。

`scripts/report-rediscovery-cases.mjs --state <Git外のstate> --campaign <id>` は台帳から探索の完了・候補・検証理由・修正版対照・人間が個別に開いたFinding数を集計する。`review` の一覧表示は「開いた」に数えず、台帳の `review-item-opened` event だけを数える。この event を書いていた `review inspect` は 2026-10-18 に削除したので、以後の campaign では 0 になる。

この集計は campaign 内の観測であり、個別の公開記録との経路一致を判定しない。`publicRecordMatch: unassessed` のまま既知事例の再発見に数えず、評価時に公開記録ごとに人間が照合する。source 読取数は Root と全 agent の下限を別々に出し、子だけが読んだ case を「読まずに終了」と扱わない。

provider 起動前に通常利用の前提が成立しない case は、理由コード（source 取得不能、依存 Snapshot 不在、外部サービス不通、通常利用の設定不能）を評価記録の文書に書く。これを台帳へ追記していた `eval case-blocked` は 2026-10-18 に削除した。過去の `evaluation-case-blocked` event は読み続ける。
