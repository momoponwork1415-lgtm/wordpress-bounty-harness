# 開発セット: TranslatePress 3.3.1（SPEC 第12節の縦断スライス）

現行の単独Trial runtimeを使う設定例。新しいRoot＋3の[TranslatePressベンチマーク](../../docs/TRANSLATEPRESS-BENCHMARK.md)にはそのまま使えない。当たり率の主張には使わず、この公開旧版を提出しない。

このディレクトリには、鍵、認証情報、答えの鍵、PoC、payloadを置かない。

`campaign-cooperative.json` は [TranslatePressベンチマーク](../../docs/TRANSLATEPRESS-BENCHMARK.md) のTP-ATO用Root＋3設定。3.2.6で完了した診断用の管理prompt変種を使い、履歴なし・1 Trial・90分上限にする。Labは公開済み二次言語 `fr_FR` と、その言語を使う管理者を設定する。修正版3.3.2は評価側で公式archiveのdigestをGit外にpinし、探索sourceへ渡さない。Findingが独立確認されたときだけ `review reverify --version 3.3.2` で同一経路を試す。

`campaign-short-managed-v4.json` と `campaign-wp2shell-bounty-v2.json` はADR 0017の比較用Root＋3設定。prompt以外の条件を揃え、それぞれ別のcampaign IDで結果を記録する。旧 `campaign-cooperative.json` はmanaged-v1の履歴用に残す。

| ファイル | Git | 中身 | 実行前にすること |
| --- | --- | --- | --- |
| `campaign.json` | 管理する | campaign設定。discovery 1run、同時1run、WordPress 6.8.3、Lab初期データ | `wordpressVersion` を、`images.wordpress` に固定したimageのWordPress版と合わせる |
| `selection.json` | 管理する | 選定方針。`translatepress-multilingual` だけを候補にし、3.3.1を手動pinする | なし |
| `campaign-luna-40.json` / `selection-luna-40.json` | 管理する | 同じ固定版で、`gpt-6-luna` の40 run試行。同時4run、新規Findingなし4回で停止 | host設定のruntime profileを `gpt-6-luna` にする |
| `host.example.json` | 雛形だけ | host設定の形。`<...>` はすべて埋める前提で、このままでは起動しない | Git外へ複製して埋める |
| `wordfence-programme.example.json` | 雛形だけ | 2026-10-08の公式ページの写し（`policy/wordfence-scope-2026-10-08.md`）から書いたProgramme page document | Git外へ複製し、`pending-submission-cap` を公式ページで確かめて `limits` に書く。書くまで選定は止まる |

## 中身の要点

- **固定版**: 3.3.1は安定版ではないので、`https://downloads.wordpress.org/plugin/translatepress-multilingual.3.3.1.zip` から取得する。主plugin fileの版が3.3.1でなければ止まる。
- **Lab初期データ**: サイト名、投稿2件、Subscriber（攻撃者役）。TranslatePressはWooCommerceを要らないので、Customerは作らない。
- **arm**: pinした版は公開日時が分からないため、履歴なし（arm a）だけで回る。`ablation` は書かない。
- **採点**: 新しい本番開始ゲートでは手入力のAnswer Keyを使わない。Findingの独立確認と修正版の同一経路対照を見る。

## 実行コマンド

以下は旧単独Trialを調査するときのコマンド。Root＋3の受入試験として扱わない。リポジトリのルートから実行する（`selectionPolicyPath` はルートからの相対パス）。

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
