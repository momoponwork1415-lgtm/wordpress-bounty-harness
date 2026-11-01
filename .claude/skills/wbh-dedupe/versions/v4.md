---
name: wbh-dedupe
description: 検証が終わった Finding 1 件について、ローカル Wordfence 履歴 mirror と Patchstack / WPScan の公開情報を slug と正確な版で照合し、possible-match / no-match / unavailable の 3 値と根拠を出す。記録は AI 操作役が review decide --duplicate --by ai で打つ。Web 検索だけで、gVisor も対象の実行も要らない。
---

# wbh-dedupe v4

段 4（ADR 0038）の skill である。対象は、段 3 の検証が終わった review queue の Finding 1 件である。`harness` は repo root で `pnpm build` した後の `node dist/cli/main.js` を指す。台帳の場所は `--state <dir>` か `WBH_STATE_DIRECTORY` で渡す。旧版は `versions/v1.md`、`versions/v2.md`、`versions/v3.md` に残してある。

## 読む入力

`harness review export --campaign <id> --finding <id>` の JSON から、次を読む。

- `target.targetId`（slug）、`target.versions.explored`、`target.versions.latestKnown`
- `finding.impact`、`finding.attackerPosition`、`finding.claim` の 1 文
- 前に記録した照合の結果 `review.duplicate` と、最後の判断 `review.decision`

それ以外の Private Evidence は読まなくてよい。台帳の sqlite を直接読まない。

## 手順

1. **同定。** slug、正確な版、照合した時刻（UTC）を最初に書く。版が違えば別の記録として扱う。
2. **ローカル mirror。** `harness review dedupe --campaign <id> --finding <id>` を実行する。結果は `unavailable` / `no-match` / `possible-match:<ref>` の 3 値。mirror が stale なら `harness history status` を見て、その事実を根拠に書く。
3. **公開情報。** Patchstack の脆弱性 database と WPScan の database を、slug と版、そして種別（`finding.impact` に対応する種別名）で検索する。見つかった記録は、公開日、影響版、修正版、種別、攻撃者位置だけを書く。記録の本文、PoC、原因箇所は読んでも写さない。
4. **除外 vendor。** 対象の作者が Wordfence の除外一覧（WordPress Core、Automattic、Facebook、Google、SiteGround、Yoast）に当たらないかを確認する。選定で除外済みのはずだが、ここで再確認する。
5. **一致の判断。** 同じ slug、影響版に `target.versions.explored` を含み、同じ種別と攻撃者位置の公開記録があれば `possible-match` とする。`<ref>` には公開記録の識別子（CVE、各 database の ID、または公開記録の URL）を置く。似ているが種別や攻撃者位置が違うなら `no-match` とし、違いを 1〜3 文で書く。これが報告書の差別化段落の元になる。
6. **推測しない。** 他の研究者の pending な報告は知り得ない。公開されていないものを理由に `possible-match` にしない。検索ができなかった、database が応答しなかったときは `unavailable` とし、理由を書く。
7. **事実として扱う。** 確認できた重複は事実であり、risk や確率として重み付けしない。直近の公開件数（混雑）は統計であって gate ではないので、判断に使わない。
8. **どちらでも記録する。** 一致があっても無くても、見た database、検索語、時刻、結果を書く。
9. **提出の直前。** 提出の直前にもう一度 `harness history status` を打ち、stale なら旧環境で mirror を更新してから 2 をやり直すよう所有者に伝える。

## 出力

1. 3 値を 1 つ出す。
   - `possible-match:<ref>`。`<ref>` が複数あればカンマで区切る。
   - `no-match`。
   - `unavailable:<理由>`。理由は、mirror が stale、database が応答しない、のように照合できなかった事情を短く書く。
2. 根拠を書く。見た database と検索語、照合した時刻、該当した公開記録の識別子・公開日・影響版・修正版・種別を書く。`no-match` のときは差別化の 1〜3 文も書く。
3. 非公開メモを Private Evidence の Finding ディレクトリ（export の `privateEvidence.directory`）に Markdown 1 本で置く。中身は 2 の根拠で、公開情報だけを書く。
4. AI 操作役が `review decide --by ai` で記録する。これは AI の中間記録で、提出前の人間の査読ではない。`--minutes` は付けず、人間の作業時間に混ぜない。

   ```
   harness review decide --campaign <id> --finding <id> --decision <判断> --reason <理由コード> --duplicate <1 の値> --duplicate-note <3 のメモの path> --by ai
   ```

   - `no-match` で、wbh-review も受理を提案しているときは、`--decision accept --reason preliminary-pass` にする。
   - `possible-match` と `unavailable` のときは、`--decision defer --reason duplicate-unresolved` にして止める。
   - `no-match` でも wbh-review が受理を提案していないときは、`<判断>` と `<理由コード>` に `review.decision` の値をそのまま写す。`review.decision` が null なら、wbh-review の判断と一緒に記録する。
   - 記録の後で export を打ち直し、`review.duplicate` に値、時刻、メモの path が出ていることを確かめる。
   - 後の判断（再現の記録など）で `--duplicate` を付けなければ、記録した結果がそのまま引き継がれる。

## 結果の扱い

- `no-match` の Finding だけが段 5（提出先の決定）に進む。wbh-report v8 は `review.duplicate.status` が `no-match` のときだけ書く。
- `possible-match` は提出候補にしない。照合先の識別子を `<ref>` に残し、`defer` を記録して止める。
- `unavailable` は落とさない。理由を残し、mirror の更新か外部の応答を待って再照合する。

## しないこと

- 照合結果、公開記録の本文、PoC を探索の入力に渡さない。探索へ渡る公開履歴は Harness がカタログ情報として別に扱う。
- Finding の本文、payload、対象の未公開の中身を会話や Git に書かない。
- 対象の PHP を実行しない。Lab を建てない。
- 提出は一方向で、同じ Finding を 2 つのプログラムに出さない。この skill は提出しないし、提出先を決めない。
