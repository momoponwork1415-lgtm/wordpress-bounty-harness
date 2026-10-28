# 新設計を基準にした構造レビューと管理一覧テストの整理

2026-10-28。基点は PR #643 を統合した `a172283e5e8e7b46a8470a843efaac080b2545d7`。Issue #644。設計の正本を変更する文書ではない。

問いは「Lead・parked Finding・held candidate の一覧テストを、探索を起動せず記録済みの台帳から検証できるか」の1つとした。作業場所は `/home/dev/worktree/codex-architecture-cleanup`。本番 checkout `prod26`、runner 設定、台帳、Private Evidence は変更していない。

## 基準と範囲

区画分配型の採用設計、ADR 0042、最新の SPEC・ADR を基準に読んだ。①列挙・②形の検査・③区画ごとの追跡・④保存で無人探索を終え、⑤読み直し・⑥Lab と人間の観測を別の流れにする。確定の根拠は ADR 0040 に従う。採用設計の説明メモに残る判定器・canary の旧表現は基準にしない。

所有者が今回指定した範囲は、Harness のバグ修正と削除、優先順は2026-10-26の候補4→1→2→11、9は後。各番号は今回の3つの設計候補とは別の番号である。エージェントへの文、ADR・SPEC、PR #643 の対象ファイルは変更対象にしなかった。

| 以前の候補 | 最新実装で確認した状態 | 今回の扱い |
| --- | --- | --- |
| 4 管理操作のテストを記録済み台帳から始める | [PR #581](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/581)で既存の `recordedReviewState` を導入済み | 一覧テスト3本の取り残しを整理 |
| 1 確定の根拠を1 moduleにする | [PR #585](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/585)で `submission-basis.ts` に集約済み | 変更なし |
| 2 Review が一覧の行と注釈を組む | [PR #591](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/591)で `Review.listing` を導入済み | 変更なし |
| 11 Lab 要求の数え方を profile へ移す | [PR #580](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/580)で移動済み | 変更なし |
| 9 gVisor の container 入場をまとめる | [PR #583](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/pull/583)で実装済み、後始末は #588 | 後回しの指定を維持 |

## 変更したところ

`tests/cli/cli.test.ts` の Lead・parked・held の一覧テスト3本は、台帳を開くためだけに `campaign run synthetic-plugin` を各1回呼んでいた。表示用の記録は、その後で各テストが直接投入していた。

3本を `tests/cli/review-operations.test.ts` へ移し、既存の `recordedReviewState` を使った。この fixture は本物の Ledger と Private Evidence を使い、選定・探索・Lab の実行に到達するとテストを失敗させる。製品コードと fixture は変更していない。

```text
変更前: 探索の test harness → campaign run → 記録を投入 → 一覧 CLI
変更後: 記録済みの Ledger / Private Evidence → 一覧 CLI
                                          └ 実行系に届けば失敗
```

公開 interface は同じ一覧 CLI である。既存の fixture を seam として使い、表示 adapter の検証の locality を高めた。新しい module や interface は追加していない。既存 fixture の leverage を広げ、削除できたのは探索の前準備3回である。

- 表示、重複排除、park の理由、旧形式の issue path、必須引数、funnel/stops の確認を維持した。
- 移行前後の3つのテスト本文を、fixture 呼出し・台帳アクセス・前準備の除去だけ正規化して比較し、すべて一致することを確認した。
- テスト2ファイルの差分は179行追加・210行削除、純減31行。うち実コードの純減は30 LoC、コメントの純減は1行である。

## コードを変えず残すレビュー結果

### 1. 区画型 Trial の結果導出 — Strong、別の問いとして扱う

**Files:** `src/discovery/partitioned-trial.ts:632`、`src/discovery/campaign-progress.ts:122`、`src/ledger/index.ts:903`。

Trial の受理・成功・provider 上限の意味が、実行・進捗・funnel に重複している。同じ意味を扱う module の interface に導出を集めれば、呼び出す adapter から条件分岐を消せる。台帳を読む seam の depth と locality が増し、実行・進捗・計測に leverage がある。新しい保存先や workflow は不要である。

静的な確認で、失敗理由の差の候補も見つかった。1区画の初回が `wall`、再試行が `schema` で失敗した場合、実行側は再試行結果を採る一方、進捗の221行と funnel の940行は全試行の先頭の失敗を採る。既存の再試行テストは部分成功を含み、この全失敗の組合せでの一致は確認していない。再現テストも本番への影響測定も今回は実施していない。

これは集計結果を変える可能性があり、一覧テストの整理には含めない。先に公開 interface から差を再現し、採る理由の意味を確かめる。共通化はその後の選択肢であり、修正の前提ではない。

### 2. Finding / Lead の読み取り — Worth exploring、契約追加はしない

**Files:** `src/cli/index.ts:1372`、`src/review/export.ts:121`、`src/review/export.ts:815`、`src/profiles/wordpress/discovery/candidate-admission.ts:132`。

CLI は Lead のイベント抽出・重複排除・`lead.json` の部分 schema・欠落時の扱いを知る。Finding の export と Lead の表示には、保存済みの partition の来歴が出ない。読み取り module の interface に復元を集めれば、CLI adapter から保存知識を消し、読み取り seam の depth と locality を改善できる。⑤の入力準備にも leverage がある。

今回は一覧の出力契約を変えない。Finding と Lead の意味を揃えたり、Lead を検証列へ入れたりしない。Lead の群と組合せ役は ADR 0042 の段階2以降の計画で、未実装を不具合とは扱わない。

### 3. ⑤読み直しの入力と結果の結合 — Worth exploring、PR 3 の測定後

**Files:** `.claude/skills/wbh-source-check/SKILL.md:15`、`src/cli/pipeline.ts:792`、`src/discovery/one-shot-run.ts:84`。

現行の手順は、操作者が export と Snapshot の保存場所を読み、skill の JSON / Markdown の結果を扱う。自動化は採用設計の Q15 にあるが、PR 3 の測定後である。予定された実装の際に、入力固定・一発の実行・形の検査・記録を既存 module の interface に集める案を残す。既存 runner adapter を seam にすることで depth と locality を高め、runner の再利用に leverage がある。

今回は skill、生成節、結果契約を追加しない。入力支配と到達性の判断は AI に、人間の観測による確定は人間に残す。

### 4. 旧判定器の未使用関数 — 削除可能、別 PR に分ける

`src/profiles/wordpress/verification/request-secret.ts` の `requestContainsSecret` は、追跡ファイル内では定義以外の参照が無い。唯一の呼出元だった `judges.ts` の import と2呼出は、PR #541（`730996a`）で削除済み。動的な利用も見つからず、台帳の旧形式の読み取りを担わない。ADR 0040 の判定器・canary 照合の削除に沿って、22行の残りを削除できると判断した。

今回の1つの問いを保つため変更しなかった。Knip が同時に未参照とした `src/lab/control/cli.ts` は、`scripts/copy-assets.mjs:29` で配布し、`src/profiles/wordpress/lab/container-startup.ts:325` から別プロセスとして使うため削除対象ではない。未参照という診断だけで削除を決めない。

## 検証とコード量

- 関連2ファイル:96テスト成功。
- `env -u WBH_REAL_LAB_IMAGES pnpm check`:型検査・整形検査成功、132ファイル・1,313テスト成功、実 Lab の2ファイル・2テストは skip。実 Lab 用設定を渡さず、本番や対象ソースの実行はしていない。
- `git diff --check` 成功。PR #643 の11ファイル、`src/`、fixture、依存、設定に差分なし。
- Knip は診断として実行した。未参照ファイル2件のほか既存の未参照 export 等があるため終了コード1。品質ゲートへの追加や自動削除はしていない。

cloc 2.06で、Git 管理下の TypeScript を計測した。空行・コメント、依存、ビルド成果物、未追跡ファイルは除く。

| 対象 | 最新 main `a172283` | 今回の変更後 |
| --- | ---: | ---: |
| 実装 `src/**/*.ts`（150ファイル） | 43,732 | 43,732 |
| テスト `tests/**/*.ts`（135ファイル） | 55,864 | 55,834 |
| 合計 | 99,596 | 99,566 |

`scripts/` は別に2,501 LoC（10ファイル）。先に計測した `fa30e08` / `51dbdc8` の実装43,733・テスト55,868との差は、PR #643 の統合による。最初に開いていた旧ブランチ `cde675e` の実装40,505 LoCは、新設計の基準値には使わない。
