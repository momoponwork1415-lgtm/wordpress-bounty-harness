---
status: accepted
---

# Verifier の incomplete を理由ごとの再試行方針で前へ進める

## 決定

検証の `incomplete` は理由コードごとに Harness が次の扱いを決め、台帳に attempt 番号と理由を残す。

| 理由 | 扱い |
| --- | --- |
| `recipe`、`observation` | 同じ Lab Setup で最大 2 回まで自動再試行する。上限到達で `incomplete` のまま人間へ回す |
| `precondition` | シナリオ ID（ADR 0020）が変わったときだけ再試行する |
| `provision` | Lab の再供給を 1 回試す |
| `evidence`、`cleanup`、`digest-mismatch`、`no-judge` | 自動再試行しない。人間へ回す |

- 自動再試行は同じ Finding、同じ Snapshot digest、同じ Verifier prompt 版で行い、attempt ごとに新しい Lab を立てる。
- `verification-finished` event に `attempt` と `retryOf`（前の verificationId）を持つ。無限再試行はしない。
- `--retry-incomplete` は残し、人間が上限を越えて再試行するときに使う。

## 理由

不変条件 4 は検証の失敗を `incomplete` にするが、誰がいつ再試行するかは設計に無い。2026-10-10 の 3.3.1 ゲート（benchmark-tp331-root-three-20261010-001）は `runtime-confirmed` まで Verifier を 6 回動かし、内訳は Lab の前提不足 1 回、`http.json` / `route.json` の形式不備による `recipe` 3 回、`observation` 1 回だった。すべて人手で `--retry-incomplete` と Lab 変更を行い、約 1 時間を要した。`recipe` の失敗は Verifier の出力形式の問題で脆弱性の有無と無関係なのに、人間の判断を待っている。現行の pipeline は Lab Setup digest が変わらない限り再検証しないため、同じ Lab での再試行もできない。

## 採らなかった選択肢

- すべての `incomplete` を自動再試行する: `precondition` は Lab を変えなければ同じ結果になり、費用だけ増える。
- Verifier に形式の自己修正を促す prompt を足す: 形式の問題は Harness 側で検査・再試行する方が決定論的で安い。

## 既存決定との関係

- SPEC 第7節「結果」に再試行方針を追加する。不変条件 4 と ADR 0004 は変えない。
- ADR 0020 のシナリオ ID が `precondition` 再試行の条件になる。

## 帰結

- 受入条件: 3.3.1 のゲートと同等の Finding で、確定までの attempt 数と wall を記録し、6 回・約 1 時間と比較する。
- `ledger funnel`（ADR 0023）は Finding ごとの attempt 数を読めるようにする。
