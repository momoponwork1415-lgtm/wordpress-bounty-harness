<!-- 2026-10-13 作成。所有者の提出台帳（wp-bounty-workspace/history、/mnt/d/wordfence/history）を分析した 8 文書の要約。原本は件別の plugin 名・版・分類・報酬額を含むため Git に入れない（SPEC.md 第 2 節 8、docs/DEVELOPMENT.md 第 5 節）。ここには集計と結論だけを残す。 -->

# 所有者の提出台帳の分析（2026-08-13〜08-20）— 集計と結論だけ

原本（Git 外、WSL）: `/home/dev/wp-bounty-workspace/history/payout-decision-rule.md`、`self-profile-and-loss-modes.md`、`whitespace-analysis.md`、`/home/dev/wp-bounty-workspace/selection/target-pool.md`、`TARGET-QUEUE.md`、`2026-08-16-structure-first-candidates.md`、`2026-08-16-band-300k-500k-elements.md`、`superseded-20260820/SELECTION.md`、`history/target-selection-doctrine-v2.PROPOSED.md`（G0〜G7 の gate ladder 提案。未採用）。Windows 側の複製は `/mnt/d/wordfence/history/`。

分母: 2026-02-20〜2026-08-20 の提出 50 件、決着 47〜51 件、累計報酬 3,098 USD（2026-08-20 時点）。その後の提出を含めた 2026-10-13 時点の累計は 21 件 / 18 件有償 / 4,076 USD（docs/reviews/2026-10-13-prompt-source-comparison.md 第 6 節）。

## 結論（当時の所有者の分析。現行方針での扱いは右列）

| # | 結論 | 現行方針 |
| --- | --- | --- |
| 1 | install 帯は唯一「測れた」レバー。300k〜999k 帯が累計報酬の 71%、30k 未満は 1 提出あたり 1 桁ドル | ADR 0032 Q4: 下限 100,000（公式 6 月報の帯別平均で裏付け） |
| 2 | 同じ plugin を 2〜3 回再訪すると有償率が 2.6% → 20% に上がる。「次の release を引き金に再訪」が効いた唯一の対象側シグナル | ADR 0032 Q6: 条件付き追加 Trial（#184）。plugin 別の順位付けには使わない（ADR 0030） |
| 3 | 対象側の 6 シグナル（低権限記録比率、unauth 比率、構造指標など）は backtest で全部効かず | ADR 0030 を維持 |
| 4 | 認可系（MissingAuthz / IDOR / PrivEsc）20 件は報酬の 1% 未満。「論理バグ」「nonce 未漏洩」「意図的に公開」で却下されやすい | Programme Boundary の impact 分類（#185）。`missing-authz` / `idor` は Lead に落とす |
| 5 | 未認証が報酬の 84〜90%。認証必須は CVSS に関係なく 1 桁〜2 桁ドルに張り付く | trust 境界: contributor 以上は内側（AGENTS.md） |
| 6 | Wordfence の tier（Critical / High / In-Scope / Other / Cut）は install 帯より強い変数。Critical は決着 4 件すべて有償 | Programme Boundary の impact gating、Verifier は「発火したか」だけを見る |
| 7 | 直近 180 日に 3 件以上の公開記録がある plugin（crowded）は有償率がほぼ 0。例外 1 件は 2026-08-14 の規則変更前 | selection: 公開履歴はカタログとして渡す（ADR 0012）。順位には使わない |
| 8 | 累計の 99% は「自明な impact」の提出から。「議論の余地がある impact」23 件は合計 1 桁ドル | 人間レビューの契約（#185/#186）: scope 内の Finding だけ人間に届ける |
| 9 | 競合研究者の縄張り（booking、form builder の旗艦、backup / migration）に入った提出は 0 ドル | タグ別有償率はミラーから機械的に出す（ADR 0032 Q3）。縄張りは測っていない |
| 10 | doctrine v2（2026-08-13）は crowding 帯 × 自明 class の gate で提出を 47 → 15 件に絞り有償率 23% → 53% を見込んだが、3 日後の帯別再集計と矛盾し採用されなかった | 選定は install 帯とタグ族だけ。gate は増やさない（ADR 0030 / 0032） |
| 11 | ある「構造が良い」低 install 対象 5 件は、構造だけで見ると強かったが帯の単価が埋まらない | 下限 100,000 で切る |

## 使い方

- 新しい選定案は、まず上の表と docs/reviews/2026-10-13-selection-data.md の数字に反していないかを見る。
- 件別の確認が必要なときだけ原本を開く。原本の内容を Issue、PR、docs に貼らない。
