---
name: wbh-dedupe
description: Finding 1 件について、ローカル Wordfence 履歴 mirror と Patchstack / WPScan の公開情報を slug と正確な版で照合し、possible-match / no-match / unavailable の 3 値と根拠を出す。Web 検索だけで、gVisor も対象の実行も要らない。
---

# wbh-dedupe

対象: review queue の Finding 1 件。`harness` は repo root で `pnpm build` した後の `node dist/cli/main.js`。台帳の場所は `--state <dir>` か `WBH_STATE_DIRECTORY`。

## 読む入力

`harness review export --campaign <id> --finding <id>` の JSON から、`target.targetId`（slug）、`target.versions.explored`、`target.versions.latestKnown`、`finding.impact`、`finding.attackerPosition`、`finding.claim` の 1 文。それ以外の Private Evidence は読まなくてよい。台帳の sqlite を直接読まない。

## 手順

1. **同定。** slug、正確な版、照合した時刻（UTC）を最初に書く。版が違えば別の記録として扱う。
2. **ローカル mirror。** `harness review dedupe --campaign <id> --finding <id>` を実行する。結果は `unavailable` / `no-match` / `possible-match:<ref>` の 3 値。mirror が stale なら `harness history status` を見て、その事実を根拠に書く。
3. **公開情報。** Patchstack の脆弱性 database と WPScan の database を、slug と版、そして種別（`finding.impact` に対応する種別名）で検索する。見つかった記録は、公開日、影響版、修正版、種別、攻撃者位置だけを書く。記録の本文、PoC、原因箇所は読んでも写さない。
4. **除外 vendor。** 対象の作者が Wordfence の除外一覧（WordPress Core、Automattic、Facebook、Google、SiteGround、Yoast）に当たらないかを確認する。選定で除外済みのはずだが、ここで再確認する。
5. **一致の判断。** 同じ slug、影響版に `target.versions.explored` を含み、同じ種別と攻撃者位置の公開記録があれば `possible-match` とし、`<ref>` に公開記録の ID（CVE か各 database の ID）を置く。似ているが種別や攻撃者位置が違うなら `no-match` とし、違いを 1〜3 文で書く。これが報告書の差別化段落の元になる。
6. **推測しない。** 他の研究者の pending な報告は知り得ない。公開されていないものを理由に `possible-match` にしない。検索ができなかった、database が応答しなかったときは `unavailable` とし、理由を書く。
7. **事実として扱う。** 確認できた重複は事実であり、risk や確率として重み付けしない。直近の公開件数（混雑）は統計であって gate ではないので、判断に使わない。
8. **どちらでも記録する。** 一致があっても無くても、見た database、検索語、時刻、結果を書く。
9. **提出の直前。** 提出の直前にもう一度 `harness history status` を打ち、stale なら旧環境で mirror を更新してから 2 をやり直すよう所有者に伝える。

## 出力

1. 3 値 1 つ: `possible-match:<ref>` / `no-match` / `unavailable`。
2. 根拠: 見た database と検索語、該当した公開記録の ID・公開日・影響版・修正版・種別、`no-match` のときは差別化の 1〜3 文。
3. 記録は wbh-review の `harness review decide ... --duplicate <3 値>` に渡す。この skill は台帳に直接書かない。
4. 非公開 note を Private Evidence の Finding ディレクトリ（export の `privateEvidence.directory`）に Markdown 1 本で置く。公開情報だけを書く。

## しないこと

- 照合結果、公開記録の本文、PoC を探索の入力に渡さない。探索へ渡る公開履歴は Harness がカタログ情報として別に扱う。
- Finding の本文、payload、対象の未公開の中身を会話や Git に書かない。
- 対象の PHP を実行しない。Lab を建てない。
- 提出は一方向で、同じ Finding を 2 つのプログラムに出さない。この skill は提出しないし、提出先を決めない。
