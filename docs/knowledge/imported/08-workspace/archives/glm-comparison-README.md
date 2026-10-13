<!-- provenance: /home/dev/wp-bounty-workspace/archives/glm-discarded-20260813/glm-comparison/README.md, mtime 2026-08-12, imported 2026-10-13, generation 08-workspace. 取り込み時に対象 3 slug・版・per-target の脆弱性別一致表（file 名・行番号を含む）を除き、結論とパターンだけ残した -->

# GLM vs Codex — provider独立性比較 (同一 snapshot blind 探索)

実施日: 2026-08-12
対象: Codex が `verification-package` で `reproduced`(Docker PoC 済み)とした3 slug・7 vuln と**同一 snapshot** を GLM に source-only で独立探索させ、Codex の成果物は見せずに一致度を測った。

## 結論(ヘッドライン)

- GLM が Codex の PoC確認済み vuln を source-only で先行検知できた割合: **3/7 clean一致 + 1/7 部分一致 = 約 50%**
- GLM が取り逃がした 3件は **reflected XSS ×2 + CSRF ×1**。いずれも source-apparent(未エスケープ出力・nonce欠落)なので「runtime でしか判らない」ではなく GLM の検出ギャップ。
- 中規模(約 290 php)の対象では **2/2 完全一致**(BOLA + 未認証開示)。小規模(41 php)の対象でも stored-XSS/SQLi/path-traversal で合意。BOLA・stored-XSS・missing-auth 系は GLM 強い。
- 大規模(381 php)の対象では GLM 1件(低confidence) vs Codex 5件(2 reproduced)。**大規模 codebase へのスケール劣位**。

## per-target 詳細

[件別の表は Git 外: /home/dev/wp-bounty-workspace/archives/glm-discarded-20260813/glm-comparison/README.md の該当節]

token 使用量だけ残す: 大規模(381 php)11.2M tokens、小規模(41 php)2.2M tokens(network error で1再実行)、中規模(293 php)4.3M tokens。

## パターン

- **GLM が強い**: broken-access-control / BOLA / missing-authorization / stored-XSS。source 読みの線で Codex と完全收斂。
- **GLM が弱い**: reflected XSS(transient・属性注入)・CSRF nonce 欠落のフレーミング・大規模 codebase での網羅。
- **token 効率**: 小規模(41 php)では 2.2M/4件と効率的。大規模(381 php)では 11.2M で 1件・低conf と費用対効果低下。

## 注意(方法論)

- GLM は source-only(Codex の reproduced は Docker PoC)。GLM が source で拾えば「安価な前置検知」の価値がある。今回 GLM が拾えなかった reflected XSS 2件は source でも同定可能なので、純粋な GLM 検出ギャップ。
- matching は title/primitive_class の keyword overlap で機械判定 + 人手補正。部分一致の扱いに任意性あり。
- 1 対象は GLM API の network error で1再実行(一時的)。安定性は要監視。

## 成果物 path

- GLM: `glm-comparison/<snapshot-id>/output/discovery-result.json` ×3(Git 外)
- Codex(参照): `queues/runs/round-2026-08-11t060936z/...`・`verification-runs/verify-2026-08-11T*`(Git 外)
