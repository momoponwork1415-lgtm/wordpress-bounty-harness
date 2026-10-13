# このハーネスに関係する新しい公開情報（2026-10-13）

問い: 直近の公開物に、WordPress バグバウンティ Harness の現行 Step 1 に役立つものはあるか。

調べ方: 2026-10-13 に公開一次資料を検索し、[2026-10-11 の公開ハーネス比較](2026-10-11-comparison-with-public-harnesses.md)、[SPEC](../SPEC.md)、[DEVELOPMENT](../DEVELOPMENT.md)、[LESSONS](../LESSONS.md)、[PARKING](../PARKING.md) と照合した。公開日と今回の確認日を区別する。実機試験や版間差分の検証はしていない。この文書は判断材料であり、仕様変更を決めない。

## 要約

10月11日の比較以降に公表された、主経路を変えるほどの新しいハーネスは確認できなかった。一方、最近の一次資料には現行の判断を裏付ける具体例がある。**今週は Step 1 の自律ループとレビュー export を優先**し、外部資料を理由に探索 prompt、判定器、モジュール境界を変えないのが妥当。

## 事実と、このリポジトリへの関係

| 優先 | 一次資料・公開日 | 確認できた事実 | このリポジトリへの関係 |
| --- | --- | --- | --- |
| 高 | [Patchstack 2026年版規則](https://patchstack.com/articles/bug-bounty-guidelines-rules/)、10月1日更新適用 | 報告には導入から成立までの手順、raw HTTP、正確な payload を求める。実物で未検証、AI が作った誤った前提を含む報告には、即時1週間の停止規則がある。 | `review export` と人間の手動 Lab 再現で、提出前に材料が揃うか確認する理由になる。10月8日保存済みの scope 写しとの差分は未照合。Patchstack を第2提出先にする作業は現行 [PARKING](../PARKING.md) のまま。 |
| 高 | [Visa VVAH 1.4.0 changelog](https://github.com/visa/visa-vulnerability-agentic-harness/blob/main/CHANGELOG.md)、9月11日 | 任意の実 HTTP 検証を追加。API collection を持つ localhost 対象に限定し、**確認できた事実だけを加算**する。検証できなかった Finding は落とさない。修正後の同一攻撃 replay も用意する。 | `incomplete` を陰性にせず、scope 内 Finding を人間へ届ける [ADR 0031](../adr/0031-review-report-dedupe-as-skills.md) と同方向。HTTP 捕捉や負の対照の設計を見直す必要を示す資料ではない。 |
| 中 | [HarnessSecurity-Bench](https://arxiv.org/abs/2610.07639)、10月6日提出のプレプリント | 6種類の coding-agent harness の2,500試行で、auto-approve 条件は攻撃成功率を29.2%から95.6%へ上げたと報告。許可したコマンドから別経路で禁止操作に達する例も報告する。 | `runsc`、broker、ホストで対象を実行しない境界を、設定値だけでなく実効動作で preflight する根拠。数値は論文の条件下の結果で、この repo のリスク確率ではない。 |
| 中 | [Wordfence Argus](https://www.wordfence.com/blog/2026/08/wordfence-argus-moving-beyond-human-research-capability/)、8月27日 | Wordfence は自社の自律探索 Argus による WordPress 脆弱性発見を公表。ただしモデル、prompt、harness の詳細は非公開。 | WordPress 分野でも自律探索が実運用されているという競争環境の情報。公開内容から再現可能な設計改善や収益率は導けない。 |
| 低 | [Mandiant AVDH](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)、8月18日 | 軽量モデルで入口を列挙し、入口ごとに文脈を集め、access control と data flow の仮説を分け、人間が最後に動的検証するパイプラインを公開。成果件数は自社報告。 | 入口索引と独立検証の比較材料になる。ただし多数の段と人間の途中確認は、現在の単一協調 Trial と Step 1 の人手0ループにはそのまま載らない。 |

## 推奨

1. **Step 1 の順序は変えない。** `review export` が実際の Finding から、使用した Snapshot、HTTP 捕捉、再現手順、正確な payload への Private Evidence 参照を人間に渡せるかを、既存の縦断確認で測る。Patchstack の規則を理由に提出先を今増やす必要はない。
2. **隔離の実効確認を既存 preflight で観測する。** `runsc` 登録、fallback なし、対象コードのホスト実行なし、provider 以外への egress 不可を、現在の実装と実行記録で確認する。新たな安全機構を設計する提案ではない。
3. **Visa と Mandiant は後の比較資料に留める。** Visa の「検証成功のみを足す」は現行の候補保持方針の独立した支持材料。Mandiant の分割方式は、現行 Trial の実測が探索構造の問題を示した場合だけ比較する。

## 未確認の仮定と限界

- 10月11日から13日までの全公開物を網羅したとはいえない。上記の多くはそれ以前に公開され、今回新たに見つけた参考資料である。
- Patchstack 10月1日規則と、repo にある10月8日付の報告フォーム写しの**差分は未照合**。規則ページ自体は2022年からの更新ページであり、個々の条項が10月1日に初めて加わったとは断定しない。
- Visa の HTTP 検証は API/localhost 向けベータであり、WordPress の browser・role・canary 判定器を置き換えられるとは確認していない。
- Argus と AVDH の成果件数は各社の自己報告で、この Harness の未知脆弱性発見率を予測しない。
