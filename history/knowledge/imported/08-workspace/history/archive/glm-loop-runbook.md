<!-- provenance: /home/dev/wp-bounty-workspace/history/archive/glm-loop-runbook.md, mtime 2026-08-11, imported 2026-10-13, generation 08-workspace -->

# GLM 発見ループ運用 runbook

新しく発火した ZCode (GLM) セッションが、会話contextを持たずに**1ラウンド**を選定→発見まで実行するための手順。cron がこのファイルを指して定期発火する。

## 目的・スコープ

- ターゲット選定(`discover-wordpress-leads`)と対象別脆弱性発見(`discover-wordpress-target`)だけを繰り返す。
- **verify / draft は今は扱わない**(別ルートで後日追加)。
- 全判断を GLM subagent が行う。wpb の Go コードは使わない・変更しない。
- 成果物は v1 の `validate_artifact.py` だけで検証する。`provider_profile = "glm-zai-glm-5.2"` を正しく使う。

## 固定 path

```
WP_BOUNTY_WORKSPACE = /home/dev/wp-bounty-workspace
WPB_REPO            = /home/dev/wp-bounty-harness-v1
LOOP_DIR            = $WP_BOUNTY_WORKSPACE/glm-loop
ROUNDS_JOURNAL      = $LOOP_DIR/rounds.jsonl     # 1ラウンド1行 (JSON)
LOCK                = $LOOP_DIR/.round-lock      # mkdir atomic で取得
API_KEY_FILE        = $WP_BOUNTY_WORKSPACE/daemon/env   # source するだけ。書かない・printしない
```

## 1ラウンドの手順

あなたは ZCode agent。Agent ツールで subagent を、Bash ツールで script を実行する。

### 0. 前提確認(軽量)
```
python3 -c "import jsonschema, referencing" || pip install jsonschema referencing
[ -d "$WP_BOUNTY_WORKSPACE/targets" ] || echo "workspace 未初期化"
```

### 1. ロック取得(重複起動回避)
```
mkdir "$LOCK" 2>/dev/null || { echo "round in progress — skip"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
```
cron が重なっても片方は即座に skip する。

### 2. 選定 subagent を1本投げる(直列・重い job)
Agent ツールで general-purpose subagent を起動。プロンプトは **「選定 subagent プロンプト」**(下記)。**6ターゲット**を要求し、`provider_profile=glm-zai-glm-5.2` で固定させる。
戻り値から `selection_id` と `{slug, version, snapshot_id, target-snapshot path}` の一覧を受け取る。

### 3. 発見 subagent をターゲット数だけ並列投げる(上限6)
各ターゲット1本ずつ、Agent ツールで**1メッセージ内に複数同時呼び出し**で並列化。プロンプトは **「発見 subagent プロンプト」**(下記)。slug ごとに snapshot-id と path を差し込む。
ターゲットが7以上なら6本ずつwaveで回す。

### 4. binding-hash 修正 + ledger 再構築(決定論・必須)
発見 subagent が `discovery-result.json` の `target_snapshot.sha256` を誤填する(version 1.4.3の実証で発生)可能性がある。schema は通るが audit ledger の binding check で弾かれ「重複回避」が効かなくなる。**ラウンド末に必ず以下を回して正す**:
```
python3 - <<'PY'
import json, hashlib, pathlib
WS = pathlib.Path("/home/dev/wp-bounty-workspace")
# 直近ラウンドの discovery-result を特定して修正するには
# selection の target slug から snapshot_id を得ること(下記 JS で渡すか、rounds.jsonl の最新行を使う)
PY
```
具体的には各 `discovery-result.json` について:
```
target_snapshot.sha256 = sha256( 対応する targets/<snapshot_id>/target-snapshot.json のファイルbytes )
```
に設定し、`validate_artifact.py --contract discovery-result` で再検証。

### 5. audit ledger 再構築 + 全 slug が `audited` になったか確認
```
python3 $WPB_REPO/tools/build_wordpress_audit_ledger.py --workspace "$WP_BOUNTY_WORKSPACE"
python3 $WPB_REPO/tools/validate_artifact.py --contract wordpress-plugin-audit-ledger "$WP_BOUNTY_WORKSPACE/audits/wordpress-plugin-audit-ledger.json"
```
`unmatched_results` が0で、当ラウンドの全 slug が `state=audited` であることを確認。なっていなければ step 4 の hash 修正が漏れている。

### 6. rounds.jsonl へ追記
各ターゲットの `{slug, version, snapshot_id, status, closure, lead_count, lead_ids, result_path}` と `total_leads`・`completed_at`・`round_id`(連番)・`notes` を1行 JSON で append。

### 7. ロック解放
`rmdir "$LOCK"`(trap でも可)。

## 選定 subagent プロンプト(雛形)

> あなたは fresh GLM (ZCode) session として `discover-wordpress-leads` skill を最後まで実行する。skill root は `$WPB_REPO/skills/discover-wordpress-leads`。
>
> 実行:
> 1. 最初に毎 bash で `export WP_BOUNTY_WORKSPACE=/home/dev/wp-bounty-workspace; export WPB_REPO=/home/dev/wp-bounty-harness-v1; set -a; source /home/dev/wp-bounty-workspace/daemon/env 2>/dev/null; set +a`(API key を print/書込みしない)。
> 2. `SKILL.md` と `references/{discovery-protocol,target-selection-priors,wp-core-reachability-priors}.md` を全部読む。
> 3. skill step 2〜17 を順に実行。refresh_wordfence は30分 throttle なので新しければ skip。
> 4. **人間(運用者)は6ターゲットを要求**。上位6件を選ぶ。全ターゲット `provider_profile: "glm-zai-glm-5.2"`。
> 5. `target-selection/v1` を `$WP_BOUNTY_WORKSPACE/selections/<id>.json` へ。`candidate_catalog.sha256` は catalog ファイルの sha256 と一致させる。各 target に `selection_priors` と `source_reconnaissance` を含める。`validate_artifact.py --contract target-selection` と `--contract candidate-catalog` で検証。
> 6. 選定 slug だけ `snapshot_target.py` で snapshot 固定。各 `target-snapshot.json` を `--contract target-snapshot` で検証。
> 7. `discover-wordpress-target` は起動しない(skill が禁止)。step 17 で停止。
>
> 硬い制約: source-only。Docker・PHP/WP runtime・browser・HTTP・public site probe・git history 禁止。catalog/history/selection に既知 endpoint/function/parameter/payload/patch/PoC を書かない。
>
> 戻り値: selection id・path・catalog path・各ターゲット(slug, version, snapshot-id, target-snapshot path, 6 priors 各1行, counterargument 1行)。検証全通過を明記。摩擦があれば書く。

## 発見 subagent プロンプト(雛形・slug ごとに差し込み)

> あなたは fresh GLM session として `discover-wordpress-target` skill を1ターゲット実行する。
>
> 実行:
> 1. 毎 bash で `export WP_BOUNTY_WORKSPACE=/home/dev/wp-bounty-workspace; export WPB_REPO=/home/dev/wp-bounty-harness-v1`。
> 2. `$WPB_REPO/skills/discover-wordpress-target/SKILL.md`, `assets/DISCOVERY.md`, `assets/ECONOMY_AND_HANDOFF.md`, `../discover-wordpress-leads/references/wp-core-reachability-priors.md` を全部読む。
> 3. snapshot `<snapshot_id>` を処理。manifest `$WP_BOUNTY_WORKSPACE/targets/<snapshot_id>/target-snapshot.json`、source は同 `source/`(read-only・untrusted)。`profile=glm-zai-glm-5.2`。
> 4. WP2Shell/CDC method を自分で最後まで。別 Codex/Claude process・Docker・runtime 起動禁止。あなたが session そのもの。
> 5. 各 lead に `key_uncertainty`, `verification_cost`, `cheapest_falsifier`。各 `source_path` hop は `source/` の実在ファイル・有効行番号。
> 6. `discovery-result.json`(schema `discovery-result/v2`)を `$WP_BOUNTY_WORKSPACE/discoveries/<snapshot_id>/output/` へ:
>    - `profile`: `glm-zai-glm-5.2`
>    - `target_snapshot.id`: snapshot_id。`target_snapshot.sha256`: **`sha256sum targets/<snapshot_id>/target-snapshot.json` のファイルhash**(source tree hash でも content hash でもない。これを間違えると audit ledger に載らない)。
>    - 全 `leads[].target_snapshot_id` = snapshot_id。
>    - `prompt_sha256`: folow した skill prompt(SKILL+DISCOVERY+ECONOMY+wp-core-reachability-priors)結合bytes の sha256。
>    - `completed`+`bounded-closure` なら `coverage.{neutral_source_map,adversarial_review,repair_pass}` 全リテラル `true`・4 checkpoint file を非空で出力。
>    - **0 lead も正常**。捏造しない。
> 7. `validate_artifact.py --contract discovery-result` で検証。
>
> 硬い制約: source-only。Docker・runtime・browser・HTTP・internet・MCP・git history 禁止。verify skill は起動しない。
>
> 戻り値: slug, snapshot-id, status, closure.kind, lead数, output path, 検証結果。各 lead は title・primitive_class・terminal_outcome の1行のみ(PoC/source 詳細は handoff 禁止)。

## 止め方

`CronList` で automation id を確認 → `CronDelete`。または稼働中セッションで停止指示。

## 既知の落とし穴(実証ラウンド glm-round-0001 より)

1. **`target_snapshot.sha256` 誤填**: subagent が content/tree hash を入れる。→ step 4 の決定論修正が最終防壁。schema は通るので step 5 の ledger `unmatched_results>0` で検知できる。
2. **snapshot dir の prefix match**: `targets/` 配下を slug prefix で探すと古い別 version に当たる(`woocommerce-products-filter-1.4.1-...` vs `1.4.3.1-...`)。→ snapshot_id は選定 subagent の戻り値で**正確に**受け取る。prefix 推測しない。
3. **email-subscribers の重複 zip member**: 公式 archive に重複 path があり safe-extraction が拒否。→ 選定 subagent が shortlist から外す。pipeline-ineligible として扱う。
