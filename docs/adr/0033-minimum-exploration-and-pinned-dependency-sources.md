---
status: accepted
date: 2026-10-18
supersedes: 0029 minimum-duration decision for new discovery Trials
---

# 最低1時間の探索と依存sourceの固定

## 決定

所有者が観測した Root の早期終了を受け、新規探索の唯一の目的promptを `wp2shell-bounty-v8` に改版する。対象ごとの単一協調Trial、Root＋最大4子、wall上限120分は維持する。Rootは少なくとも60分、固定sourceに基づく探索、仮説の反証、方向転換と新しいラウンドを続ける。Harnessも60分未満の最終報告を正常完了として受理せず、同じ隔離環境と同じ協調セッションで探索を継続させる。Harnessが機械的に保証する下限は経過時間であり、能動性はsource読取・子の活動・ラウンド・provider使用量で事後に評価する。provider、broker、schema、隔離環境の失敗または120分のwall上限では理由付き `incomplete` とし、観測済みの子のFindingとLeadを保存する。継続できない早期終了も正常な候補0件にしない。

Target Snapshotに、対象pluginと同じWordPress実行imageのPHPソースを版とdigestで固定する。対象の `Requires Plugins` ヘッダに宣言されたWordPress.org plugin依存を取得し、版とdigestで固定する。ヘッダがない実依存は対象slugに結び付いた選定方針の明示指定で補う。自動選定の本番対象は依存slugを指定してfreeze時点の公式stable版を観測し、手動の開発・歴史的評価対象は依存版を明示的にpinする。どちらも取得した版とsource digestをSnapshotに固定する。取得・検査・固定に失敗した依存は黙って省略せず、対象の準備失敗として扱う。探索には対象 `/workspace/main`、WordPress本体 `/workspace/wordpress`、PHP `/workspace/php`、必要なplugin `/workspace/dependencies/<slug>` を同じSnapshot由来の読み取り専用sourceとして渡す。Labは固定したplugin依存を供給して通常利用の前提を満たす。探索者に過去の脆弱性の答え、PoC、payload、再現手順は渡さない。

v7以前のprompt本文、digest、実験結果、台帳eventは履歴照合用に残し、新規探索には使わない。探索手法はWP2Shell記事由来の多様な仮説と協調ラウンドを維持し、時間と参照できる依存sourceだけを更新する。

## 理由

現行のv7は最低時間なしと明記し、Rootの早い最終JSONをHarnessが `completed` として受理していた。旧Trialで短いwallと候補0件が続いても、十分な深さの探索が行われたとは言えない。単にpromptへ長時間指示を加えるだけでは、早期最終報告を正常完了として受理する経路が残るため、同一セッションの継続と完了判定も更新する。60分の下限は所有者の運用判断であり、発見率の改善を証明した値ではない。開発Trialと本番のwall、Finding、Lead、usage、停止理由で評価する。

v7のsource packは対象とWordPress本体だけだった。PHPの型、標準関数や拡張、依存pluginのフックとデータの流れを実際の固定sourceで確認できないと、探索者は記憶に頼るか経路を未解決として止める。WordPress.orgの `Requires Plugins` は依存slugを宣言する公式ヘッダだが、未宣言のElementor依存も現にある。現行本番と歴史的評価に同じ古い依存版を強制しないため、両者の指定方式を分ける。取得した依存をTarget Snapshotに含めることで、探索とLabの前提を同じ版に結び付けられる。

## 帰結

- 2026-10-19（[ADR 0036](0036-operator-resume-after-provider-refusal.md)）: 最低 60 分の同一セッション継続は、provider の拒否後に操作者が再開した segment をまたいで数える。再開 segment の最低時間は 60 分 − 消費済み wall、wall は 120 分 − 消費済み wall。
- 旧v7とv8のTrialはpromptとsource pack、停止条件が異なるため、同じ比較分母に混ぜない。
- 60分未満の正常完了は認めない。途中の環境・provider失敗は既存の `incomplete` 規則に従う。
- 経過時間だけでは思考や分析を分単位で証明できない。実Trialでは読取・子の活動・ラウンドの観測値とwallを併記する。
- PHPと依存pluginのsourceはgVisor内でのみ探索者に読ませる。対象コードをホストで実行せず、LabとVerifierのcanary判定境界は維持する。
- 選定時の依存指定は対象slugと依存slugを明記し、手動評価では版も明記する。freezeで得たSnapshot digestが後の探索・検証結果を拘束する。
- agent入力とruntime、選定を変えるため、[DEVELOPMENT.md](../DEVELOPMENT.md) 第5節の開発Trialの数字を得るまでmergeしない。
