# 開発セット: TranslatePress 3.3.1（SPEC 第12節の縦断スライス）

`campaign-production-v1.json` は開発セットの設定。新規探索で使える唯一の目的 prompt `wp2shell-bounty-v10` で、Root＋最大4子、120分上限、入口索引なしの協調Trialを1回走らせる。旧 `campaign.json` と比較用設定は過去Trialの構成照合用で、新規探索には使えない。この公開旧版を提出しない。

このディレクトリには、鍵、認証情報、答えの鍵、PoC、payloadを置かない。

Labは公開済み二次言語 `fr_FR` と、その言語を使う管理者を設定する。修正版3.3.2は評価側で公式archiveのdigestをGit外にpinし、探索sourceへ渡さない（[TranslatePressベンチマーク](../../docs/TRANSLATEPRESS-BENCHMARK.md)）。

`campaign-short-managed-v4.json` と `campaign-wp2shell-bounty-v2.json` はADR 0017の過去比較用Root＋3設定。新規探索では起動できない。managed-v1 の `campaign-cooperative.json` と旧 `campaign-wp2shell-bounty.json`、`selection-luna-40.json` は 2026-10-19 に削除し、Git 履歴にだけ残る。

| ファイル | Git | 中身 | 実行前にすること |
| --- | --- | --- | --- |
| `campaign.json` | 管理する | 過去Trialの構成照合用。WordPress 6.8.3。schemaが拒むので起動できない | なし |
| `campaign-production-v1.json` | 管理する | `wp2shell-bounty-v10`、入口索引なし、Root＋最大4子、1 Trial、wall上限120分、WordPress 7.1.3 | 協調subagentを使えるhost profileと固定imageを用意する。`wordpressVersion` を `images.wordpress` のWordPress版と合わせる |
| `selection.json` | 管理する | 選定方針。`translatepress-multilingual` だけを候補にし、3.3.1を手動pinする | なし |
| `campaign-luna-40.json` | 管理する | 過去の `gpt-6-luna` 40 run試行の構成照合用。schemaが拒むので起動できない。指す `selection-luna-40.json` は削除済み | なし |
| `host.example.json` | 雛形だけ | host設定の形。`<...>` はすべて埋める前提で、このままでは起動しない | Git外へ複製して埋める |
| `wordfence-programme.example.json` | 雛形だけ | 2026-10-08の公式ページの写し（`policy/wordfence-scope-2026-10-08.md`）から書いたProgramme page document | Git外へ複製し、`pending-submission-cap` を公式ページで確かめて `limits` に書く。書くまで選定は止まる |

## 中身の要点

- **固定版**: 3.3.1は安定版ではないので、`https://downloads.wordpress.org/plugin/translatepress-multilingual.3.3.1.zip` から取得する。主plugin fileの版が3.3.1でなければ止まる。
- **Lab初期データ**: サイト名、投稿2件、Subscriber（攻撃者役）。TranslatePressはWooCommerceを要らないので、Customerは作らない。
- **採点**: 新しい本番開始ゲートでは手入力のAnswer Keyを使わない。Findingの独立確認と修正版の同一経路対照を見る。

## 実行コマンド

以下は新しい協調Trialの開発セット用コマンド。リポジトリのルートから実行する（`selectionPolicyPath` はルートからの相対パス）。各反復には別のcampaign IDを使う。

```bash
pnpm install && pnpm build
```

```bash
export WBH_HOST_CONFIG="$HOME/.config/wordpress-bounty-harness/host-prompt-comparison.json"
```

```bash
node dist/cli/main.js runtime check --config examples/translatepress-3.3.1/campaign-production-v1.json
```

```bash
node dist/cli/main.js select --config examples/translatepress-3.3.1/campaign-production-v1.json
```

```bash
node dist/cli/main.js campaign run translatepress-multilingual --campaign dev-translatepress-331-001 --config examples/translatepress-3.3.1/campaign-production-v1.json
```

```bash
node dist/cli/main.js ledger funnel --campaign dev-translatepress-331-001
```
