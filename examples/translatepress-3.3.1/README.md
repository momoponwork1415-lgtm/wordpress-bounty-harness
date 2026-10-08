# 開発セット: TranslatePress 3.3.1（SPEC 第12節の縦断スライス）

答えを知っていてよい開発セット1件で、Harnessが実際の境界で端から端まで動くことを1試行で確かめるための設定例。当たり率の主張には使わない。提出しない。held-outは使わない。

このディレクトリには、鍵、認証情報、答えの鍵、PoC、payloadを置かない。

| ファイル | Git | 中身 | 実行前にすること |
| --- | --- | --- | --- |
| `campaign.json` | 管理する | campaign設定。discovery 1run、同時1run、日次上限2、WordPress 6.8.3、Lab初期データ | `wordpressVersion` を、`images.wordpress` に固定したimageのWordPress版と合わせる |
| `selection.json` | 管理する | 選定方針。`translatepress-multilingual` だけを候補にし、3.3.1を手動pinする | なし |
| `host.example.json` | 雛形だけ | host設定の形。`<...>` はすべて埋める前提で、このままでは起動しない | Git外へ複製して埋める |
| `wordfence-programme.example.json` | 雛形だけ | 2026-10-08の公式ページの写し（`policy/wordfence-scope-2026-10-08.md`）から書いたProgramme page document | Git外へ複製し、`pending-submission-cap` を公式ページで確かめて `limits` に書く。書くまで選定は止まる |

## 中身の要点

- **固定版**: 3.3.1は安定版ではないので、`https://downloads.wordpress.org/plugin/translatepress-multilingual.3.3.1.zip` から取得する。主plugin fileの版が3.3.1でなければ止まる。
- **Lab初期データ**: サイト名、投稿2件、Subscriber（攻撃者役）。TranslatePressはWooCommerceを要らないので、Customerは作らない。
- **arm**: pinした版は公開日時が分からないため、履歴なし（arm a）だけで回る。`ablation` は書かない。
- **鍵**: `eval score` に使う開発セットの鍵は、Git外のファイルとして `--keys` に渡す。

## 実行コマンド

実行は人間だけが行う。リポジトリのルートから実行する（`selectionPolicyPath` はルートからの相対パス）。

```bash
pnpm install && pnpm build
```

```bash
export WBH_HOST_CONFIG="$HOME/.config/wordpress-bounty-harness/host.json"
```

```bash
node dist/cli/main.js runtime check --config examples/translatepress-3.3.1/campaign.json
```

```bash
node dist/cli/main.js select --config examples/translatepress-3.3.1/campaign.json
```

```bash
node dist/cli/main.js campaign run translatepress-multilingual --campaign dev-translatepress-331-001 --config examples/translatepress-3.3.1/campaign.json
```

```bash
node dist/cli/main.js ledger funnel --campaign dev-translatepress-331-001
```

```bash
node dist/cli/main.js eval score --campaign dev-translatepress-331-001 --keys <Git外の開発セット鍵> --case <case id>
```
