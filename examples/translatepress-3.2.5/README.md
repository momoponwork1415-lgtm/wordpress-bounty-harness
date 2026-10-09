# TranslatePress 3.2.5 開発セットの A/B

`campaign-luna-ab.json` は prompt × Trial 内継続の 2×2 を各 cell 3 Trial で測る。探索の wall time は 90 分、継続は 30 分を最大 2 本とし、日次上限は探索 Trial 6 本。Lab と source pack、入口の分担は全 cell で同じにする。

`campaign-luna-ab-time-control.json` は、継続なし cell を 150 分で測る別 campaign 用。prompt の両 arm を各 3 Trial 実行する。前者の継続あり cell（最大 90 + 30 × 2 分）と比較し、構成一定と時間一定の表を別々に作る。

どちらも `selection-luna-40.json` で 3.2.5 を固定する。host 設定の runtime profile は `gpt-6-luna` / high、WordPress image は 6.8.3 に固定する。実行前に `pnpm build` と `harness runtime check --config <campaign file>` を通す。設定上の日次上限に達した場合は、自動 retry せず、別の UTC 日に同じ campaign ID で再開する。

答えの鍵、認証情報、候補本文、payload、transcript、採点の私的詳細は Git 外に置く。公開する結果は、既に公開された事例に対応する集計だけとする。
