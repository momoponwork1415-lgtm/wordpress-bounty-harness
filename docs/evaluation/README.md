# 公開sourceのpin

[`public-source-pins.json`](public-source-pins.json) は、終了したIssue #10で集めた公開plugin sourceと、共通のWordPress coreの取得元・digestを記録する過去資料。現在の初期受入は [TranslatePressベンチマーク](../TRANSLATEPRESS-BENCHMARK.md) に絞る。答えの鍵、原因箇所、advisory本文、payloadは含めない。このファイルを探索runへ渡さない。探索には固定したsource packだけを渡す。

6件のpluginはWordPress.orgの版付きzipを取得し、転送されたarchive bytesのSHA-256とbyte数を記録した。zipはGit外に保存した。Unlimited Elements 2.0.16の版付きzipとSVN tagは無かったため、WordPress.orgのSVN trunk `r3628543` をexportした。このrevisionのlogは2.0.16への更新と記し、plugin headerも `Version: 2.0.16`。`sourceTreeDigest` はexport後のcanonical source tree digestであり、zipのdigestとは異なる。

coreは開発セットで使ったdigest固定の公式WordPress imageから、未起動containerを通じて取り出した。`wp-includes/version.php` は6.8.3で、`sourceDigest` はDependency Snapshot用のcanonical manifest digest。各caseでのpluginの起動、追加依存、設定、core 6.8.3との互換性はこの旧資料だけでは確認できない。#127の実行可否と結果は下記カタログと日付付き評価に記録する。

## #127 再発見カタログ

[`rediscovery-catalog-pins.json`](rediscovery-catalog-pins.json) には、Git 外のmanifestのSHA-256と各caseの脆弱版・修正版だけを置く。7つの対象版に対して8件の公開記録を別々に照合する。修正版ZIPのbytesとdigest、公開記録IDと日付はGit外のmanifestにあり、探索入力には使わない。

`scripts/build-rediscovery-catalog.mjs` は、Git外のcase入力（`schemaVersion: 1`、`cases` の各項目は `caseId` / `slug` / `vulnerableVersion` / `cve`）、Wordfence mirror DBとstate、`public-source-pins.json`、Git外の出力先、Git側のpin出力先を `--cases` / `--mirror` / `--mirror-state` / `--source-pins` / `--private-dir` / `--pin-output` で受け取る。WordPress.orgの版一覧と実際に取得できるZIPを照合し、修正版archiveをGit外に保存する。

`scripts/report-rediscovery-cases.mjs --state <Git外のstate> --campaign <id>` は台帳から探索の完了・候補・検証理由・修正版対照・人間が個別に開いたFinding数を集計する。`review` の一覧表示は「開いた」に数えず、`review inspect --campaign <id> --finding <id>` の記録だけを数える。過去にファイルを直接開いた操作は遡及して数えられない。

この集計は campaign 内の観測であり、個別の公開記録との経路一致を判定しない。`publicRecordMatch: unassessed` のまま既知事例の再発見に数えず、評価時に公開記録ごとに人間が照合する。source 読取数は Root と全 agent の下限を別々に出し、子だけが読んだ case を「読まずに終了」と扱わない。

provider 起動前に通常利用の前提が成立しない case は、実測後に `harness eval case-blocked --campaign <id> --case <id> --snapshot <Snapshot または選定記録の digest> --stage source|dependency|lab --reason <code>` で台帳へ追記する。Snapshot 前は既存の `target-skipped` と同じく固定した選定記録の digest を使う。source 取得不能、依存 Snapshot 不在、外部サービス不通などの理由コードだけを記録し、private な調査本文は含めない。
