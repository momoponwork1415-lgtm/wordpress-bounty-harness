# #651 の一発 Verifier 入力の対照

## Harness が生成する節の全文

`src/profiles/wordpress/verification/one-shot-verifier.ts` の `ONE_SHOT_VERIFY_SECTION` をそのまま記す。既存の `wbh-verify/v11` 本文は変更しない。

```text
## Harness one-shot Lab paths and phases

Use the supplied wbh-verify/v11 skill for this one Finding. In that skill, <dir> means /workspace/output. Read /workspace/input/lab.json during setup only; its files paths below are authoritative. Read /workspace/input/review-export.json for the Finding. The fixed target source is read-only under /workspace/source; fixed dependencies are read-only at their mounted paths.

The skill's setup-done marker is /workspace/output/setup-done.json: write {} as valid JSON after all administrator setup ends. The Harness then revokes the administrator, restarts the HTTP capture and Lab baseline, removes lab.json, and publishes /workspace/input/attack.json. Its publication is the skill's observation-ready signal. Wait for attack.json; compare its runId, findingId and snapshotDigest with /workspace/input/binding.json. Write /workspace/output/observation-ready.json as {} only after that comparison succeeds. Never reuse administrator credentials after setup-done.json.

Write the six skill files under /workspace/output with their specified names; complete each by atomic rename, with precondition last. If the skill requires abort, write its allowed reason code in /workspace/output/abort.json and its detail in /workspace/output/precondition. Do not call review observe or review decide. The Harness records evidence for a human to judge.
```

## 和訳

### Harness の一発 Lab の経路と段階

供給した `wbh-verify/v11` スキルをこの Finding 1 件に使う。スキルの `<dir>` は `/workspace/output` とする。準備中だけ `/workspace/input/lab.json` を読み、その `files` の経路に従う。Finding は `/workspace/input/review-export.json` から読む。固定した対象ソースは `/workspace/source` で、固定した依存ソースは各マウント経路で読み取り専用である。

スキルの `setup-done` 合図は `/workspace/output/setup-done.json` で、管理者による準備がすべて終わった後に有効な JSON の `{}` を書く。Harness はその後に管理者資格を失効させ、HTTP 捕捉と Lab の基線を取り直し、`lab.json` を除去して `/workspace/input/attack.json` を公開する。この公開をスキルの `observation-ready` 合図とする。`attack.json` を待ち、その `runId`、`findingId`、`snapshotDigest` を `/workspace/input/binding.json` と照合する。照合できた後にだけ `/workspace/output/observation-ready.json` に `{}` を書く。`setup-done.json` 後は管理者資格を使い直さない。

スキル指定の 6 ファイルをその名前で `/workspace/output` に書き、各ファイルは rename で確定し、`precondition` を最後にする。スキルが中断を求める場合、許された理由コードを `/workspace/output/abort.json` に、詳細を `/workspace/output/precondition` に書く。`review observe` と `review decide` は実行しない。Harness は人間の判断のための証拠を記録する。

## 要素と出典

| 生成節の要素 | 出典 | 実装上の対応 |
| --- | --- | --- |
| Finding 1 件、skill v11、review export、setup 用 lab.json | Issue #651「振る舞い」・受入条件 1、2、既存 `.claude/skills/wbh-verify/SKILL.md`「入力と境界」 | 本文を版と digest で receipt に結ぶ。 |
| 固定ソースの読み取り専用マウント | SPEC §2.1、§2.2、既存 OneShotRun 契約 | Snapshot に一致する source pack を渡す。 |
| `<dir>` と setup-done の JSON 経路 | 既存 skill「手順」、OneShotLab の `setup-done.json` 契約 | 準備段階を既存 watcher に渡す経路対応だけを足す。 |
| 管理者失効、捕捉と基線の再開、attack.json | 既存 skill「手順」、AGENTS.md「検証 Lab の前提」、既存 `WordPressVerifierRun.restartObservation()` | watcher が `closeSetup()` を呼んだ時だけ資格を失効させる。 |
| 3 ID の照合と binding.json | 既存 skill「手順」の `lab.json` と `attack.json` の一致、OneShotLab の `lab.json` 除去契約 | 除去後にも同じ 3 ID を照合できる読み取り専用ファイルを供給する。 |
| observation-ready の JSON 合図 | 既存 skill「手順」、OneShotLab の `attack.json` 公開・`observation-ready.json` 契約 | 公開後の ACK として扱い、6 ファイルの受領前に要求する。 |
| 6 ファイル、atomic rename、precondition 最後、abort コード | Issue #651 受入条件 3、既存 skill「手順」 | 全 6 ファイルを Private Evidence の一つの artifact に保存する。 |
| 人間の判断を行わない | SPEC §2.3、ADR 0040、既存 skill「しないこと」 | agent に `review observe` と `review decide` を実行させない。 |

ここにある実行時経路の対応以外の検証手順、対象固有の名前、判定基準は生成節に加えていない。
