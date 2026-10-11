# Issue #119 の実機受入条件と victim 操作の依存

## 確認したこと

- #118 の PR は screenshot 証拠を Lab 観測から判定器へ渡す。単体試験では、beacon が発火した browser 手順が `runtime-confirmed` になり、PNG が Private Evidence に保存される。
- TranslatePress 3.2.6 の本人記述経路を使い、使い捨て gVisor Lab で Subscriber の投稿、管理者の承認、管理者ブラウザのドロップダウン操作を行うと、発行した canary の beacon を 1 件回収した。
- 同じ Lab の Harness 自動観測は、このドロップダウン操作を行わない。操作前の beacon は 0 件で、`verification-finished` は `incomplete(observation)` になった。確認用ブラウザの名前解決を Harness と揃えてから再測定した。payload、recipe、画面画像は Private Evidence に保持している。

## 分からないこと

#119 の受入条件と実装計画は「#118 と同じ既知経路で confirmed を維持」とする。一方、#118 の実機結果は理由付き `incomplete` で、victim 操作は計画上 #125 の範囲である。#119 だけで自動判定を confirmed にする方法は確認できていない。既知経路の成立と、Harness がその操作を再現できることは別の条件である。

追加の読み取り確認では、`src/profiles/wordpress/lab/index.ts` の観測器はログイン後のページ訪問と screenshot に限られ、ドロップダウン操作を表す入力を受け取らない。#125 の Issue と実装計画も scenario と前提条件の照合を指定するだけで、被害者の操作手順型は明記していない。Lab 観測器の外で手動操作を重ねた beacon は、観測器が訪問前後に測る差分の帰属を崩すため、Harness 所有の `runtime-confirmed` の代用にできない。従って #125 を待つだけでも解消するとは確認できない。

## 選択肢

1. #119 より前に、#125 の victim 操作のうち既知経路に必要な汎用機構を ADR と実装順の変更として先行させる。その後、#119 の実機受入条件を測る。
2. #119 のコードは予定どおり実装するが、実機 confirmed の受入条件を満たすまで PR 提出を保留する。#125 を予定の順で待つと、系列 A 完了前に #125 を行えないため循環が残る。
3. 本人記述経路と同じ脆弱性で、現行の自動訪問だけで発火する別の手順を調査する。現時点でその手順の根拠はない。

Issue の受入条件は変更しない。#119 のコードはこの判断が決まるまで変更しない。
