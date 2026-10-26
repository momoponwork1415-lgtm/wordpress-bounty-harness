<!-- 5項目すべてを日本語で、各3行以内。分からない行があれば所有者は merge しない。規則は docs/DEVELOPMENT.md -->

## 問い

この PR が答える「今週の問い」（Issue 番号）。docs/knowledge/experiments.md に同じ問いが無いことを確認した、または該当行。

## 変えたこと

何を、なぜ。

## 変えなかったこと

関係しそうで触っていないもの。既存の振る舞いが変わらない理由。

## 測った数字

探索に触る PR は、同じ 6 case・同じ版で次の 3 つを出す（出し方は docs/reviews/2026-10-26-system-history-and-metrics.md 第 4 節）。
M1 開発セットの OK 率（scope 内 Finding が 1 件以上の case 数 / 6、公開経路一致の数を併記）、M2 Trial あたりの scope 内 Finding（Trial 数 / completed / Finding / Lead / wall 中央値 / 失敗理由を含む）、M3 common-usage の割合。
検証・レビュー・提出に触る PR は M4 確認数 / M5 提出数 / M6 報酬のどれが動くかを書く。触らない PR は「なし」。

## 消し方

実験軸や opt-in の機能なら、消すときに削除するファイルと設定の名前。それ以外は「該当なし」。
