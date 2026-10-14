# P4/P6 実機前統合（2026-10-15）

この記録は `codex/issue-240-p4p6-integration` の実機前確認であり、設計の正本を変更しない。開発 campaign には隔離された state で `--campaign-prefix dev-p4p6-integration` を使い、初回 ID を `dev-p4p6-integration-20261015-1` とする案。実 Trial は未実施。

## 出自

| 機能 | 出自 commit |
| --- | --- |
| 基底 main（#259 の EPIPE 修正を含む） | `a07efa7367ccff21e940676bbce038c8ef8356fc` |
| P4d: 自動検証の再試行枯渇後、無駄な Lab 再供給をしない | `023ca0d`、公開 head `e4e0aa9877fadb8a2ce47750ece17d75b6973ae6` |
| P4 cleanup: teardown 失敗時は Lab ID を台帳に残し、campaign 停止・同一 campaign 再開時に残骸を検査 | `eb62a81`、公開 head `54dbfdd4b10c2145085dd99047b62bf4c9da423a` |
| P6 durable stop: operator 停止を再起動後も保持 | `834b5ec`、公開 head `55cd204ce292c65d08b843d995588f61e5ab33ab` |
| P6 terminal stop: 期限・異常停止の理由を保持し、意図的停止を終了コード 0 にする | `c6df63ae93975d27f93805b7c103f2f517c0315b` |
| P6 wait: crash 後に quota 等の待機期限を引き継ぐ | `117abfa2d7357816db2a8a57e519109d87e8a80a` |
| P4/P6 connector: 自動再開と明示的 `--retry-incomplete` の分離、読取専用 Lab 残骸検査、`lab-cleanup` 停止 | `9821673` を競合解消して `a4a34a4d7a0da252d44d05598a173acaaf7bf572` |

## 統合時の判断

- `lab-cleanup` を P6 の停止理由一覧に追加した。理由付き stop marker、`continuous status` の理由表示、終了コード 0 を使う。
- quota/backoff 等の保存済み `until` を先に復元し、待機後に preflight と読取専用 Lab 検査をする。
- `continuous run` の再開では `retryIncompleteVerifications: false` とし、明示的な `campaign run --retry-incomplete` の意味を保つ。`incomplete` の Finding は review queue に残す。
- Lab teardown または残骸検査の失敗では campaign ID を保持して停止する。operator が残骸を確認・削除し、明示的に resume するまで次対象へ進まない。

## 確認と残件

- `pnpm check`、`pnpm build` を通す。合成試験は quota 待機中 crash → 残り待機 → 同一 campaign で再開 → cleanup 故障で停止 → marker が残る次回起動は無作業、を確認する。
- この4契約の静的・合成確認で、再現した未解決 P0 はない。過去の「停止後 systemd が再起動し探索を続ける」問題は理由 marker と終了コード 0 で解消した。
- 実環境の Docker/gVisor/provider、残骸削除の運用、3 Trial の開発セットは未検証（0/3）。この gate を通すまで無人の本番 campaign を始めない。
