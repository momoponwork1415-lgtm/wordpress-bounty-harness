---
status: accepted
---
# 自動の実行時検証を人間レビューの前に置く

Finding は独立Verifierと決定論的判定器を通ってから人間に見せる。人間は `runtime-confirmed` と次手付きの `incomplete` を見て、影響の意味・重複・提出先・文案を判断する。未検証の候補を人間が採否する順序（旧リポジトリADR 0135、Human Candidate Review）は採らない。理由は、判断者がホワイトボックス診断の経験が浅く「本物か」の判断を人間に置くと品質が担保できないこと、公開事例（Anthropic、Cloudflare、XBOW、Codex Security、Big Sleep、Mantis）がすべて検証を先に置くこと。

## Consequences

- `incomplete` を黙って落とすと再現率が下がるので、別列で必ず表示する。
- 人間ゲートは「提出前のレビュー」と「外部行動の承認」の2つになる。
