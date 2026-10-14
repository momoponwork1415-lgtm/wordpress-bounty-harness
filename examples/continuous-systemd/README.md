# 継続運転の host timer 例（未有効化）

この2つの `.example` は #229 の `continuous supervise` を定期的に呼ぶための systemd user unit の雛形であり、リポジトリに置くだけでは登録・起動されない。1組を **1つの既存 parent run** 専用にする。複数 parent を監視する場合は別名の service / timer を作り、timer の `Unit=` も合わせる。

`supervise` が起こすのは、親が `RUNNING` で停止要求がなく、owner の死亡または不在と資源 claim がないことを確認した場合だけである。起床後の worker が長時間動く間、systemd は同じ service を重ねて起動しない。worker が終了して service が非アクティブになった5分後に次の判定を行う。即時再起動の設定はない。

## 後日有効化する前の条件

- #215 の旧履歴 coverage と、#229 の実 provider Trial を先に確認する。その後に制御された長時間試験として timer を使い、1週間の受入を測る。現時点ではいずれも未達であり、この unit を置いても無人本番運転の合格にはならない。
- `continuous start` で parent を明示的に作り、`continuous status --run <parent-id>` で状態を確認する。この timer は新しい parent を作らない。
- `pnpm build` を済ませ、同じホスト・同じ OS ユーザー・同じ `HOME` で、固定した `--host`、`--state`、`--config` を使う。host 共通の parent journal と owner は `HOME` 配下にある。host 設定内の認証ファイルの**パス**は維持し、credential 本文を unit に書かない。
- user service から Docker / `runsc` / provider broker を使えることを別途確認する。ログアウト後も動かすなら systemd user manager の linger も運用者が設定する。

## 設定と確認（現時点では実行しない）

1. 両 `.example` を `~/.config/systemd/user/` へ `.example` を外した名前でコピーする。service 内の `@NODE_ABS@`、`@REPOSITORY_ABS@`、`@HOST_CONFIG_ABS@`、`@STATE_DIRECTORY_ABS@`、`@PARENT_RUN_ID@`、`@CAMPAIGN_CONFIG_ABS@` を実値で置換する。すべてのパスは絶対パスとし、空白・`%` を含まないものを使う。`--state` は parent に固定された実パスと一致させる。
2. 未置換の `@...@` がないことを確認し、`systemd-analyze verify --user ~/.config/systemd/user/wbh-continuous-supervise.service ~/.config/systemd/user/wbh-continuous-supervise.timer` で構文を検査する。明示した parent と設定の組を再確認する。`OnStartupSec=1min` は user manager の起動時刻を基準とするため、その時刻から1分以上経っていれば有効化直後に最初の判定が始まり得る。
3. 運用受入後に限り `systemctl --user daemon-reload`、`systemctl --user enable --now wbh-continuous-supervise.timer` で timer だけを有効化する。service を直接 enable しない。

`systemctl --user status wbh-continuous-supervise.service` と `journalctl --user -u wbh-continuous-supervise.service` はプロセスの状態を見る。親・child の判断は Harness の `continuous status --run <parent-id>` と `resources status` で見る。`WAIT_QUOTA`、`WAIT_REVIEW`、`RECOVERING`、`STOPPED`、owner 不明、残存 claim は timer が解除しない。原因と証拠を確認した後の `continuous resume` は明示操作である。

通常停止は Harness の `continuous stop --run <parent-id>` で要求し、進行中 Trial の drain と `STOPPED` を確認する。その後 timer を `systemctl --user disable --now wbh-continuous-supervise.timer` で止める。service 自体への `systemctl stop` は worker を途中で終了させるため通常停止に使わない。既に始まった Trial の再投入や claim の解放を timer に任せない。
