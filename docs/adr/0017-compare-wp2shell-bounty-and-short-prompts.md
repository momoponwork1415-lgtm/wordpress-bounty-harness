---
status: accepted
---
# 短い管理promptとWP2Shell式報奨promptを同条件で比較する

## 決定

Root＋最大3子の既定探索promptを、pilotで使ったv2からStored XSSのサイト全体制限を除いた `short-objective-managed-v3` とする。WP2Shell由来の多様な仮説、waveごとの統合と反証、経路の連鎖を報奨探索向けに改訂した `wp2shell-bounty-v1` を版付きの比較armとして追加する。両promptの影響優先順位は揃え、Wordfenceで対象となる特定ページのStored XSSも含める。旧WP2Shellの「脆弱性は必ずある」「最低6時間」や特定の正解経路は持ち込まない。

最初の比較ではprompt以外のmodel・effort・Root＋3構成・Target Snapshot・Lab設定・Programme Boundary・wall上限・判定器を揃える。TranslatePress 3.2.6（Stored XSS）と3.3.1（アカウント乗っ取り）は公開済み経路に対する開発セットとして扱い、探索者へ答えを渡さない。3.2.6のLabは二次言語、翻訳対象、発火先を揃えてから実行する。各Trialは独立させ、同じ版を複数回試す場合は順序を交互または無作為にする。旧Trialと新Trialを同じ比較の分母に混ぜない。

Finding数だけでなく、独立判定器による同一経路の `runtime-confirmed`、XSS候補の有無と失われた段階、Lead、source coverage、run wall、provider使用量、子の結果保存、検証の `incomplete` 理由を分けて記録する。公開事例だけで優劣を決めず、最新版での報奨対象かつ非重複の確認数と費用を最終的な選択指標にする。1組のTrialからpromptの優劣を断定しない。

両promptとも現状はStored XSSを影響の優先順位の後方に置く。この共通条件でXSSを見落とした場合、短いprompt固有の欠点とは扱わない。優先順位やLab条件を変える実験はprompt構成の比較とは別に設計する。

## 理由

短い管理promptによるTranslatePress 3.3.1の協調Trialは、Rootと子が同じアカウント乗っ取り経路を出し、独立判定器で確認した。一方、3.2.6の完了TrialにはStored XSSのFindingが記録されなかった。そこでは二次言語のLab条件も不足しており、版と欠陥も3.3.1とは異なる。さらに旧prompt・判定器・Wordfence向けscope判定は、特定ページだけで発火するStored XSSを過度に除外していた。比較前にこの共通の欠陥を修正する。これだけで短いpromptの脆弱性種別ごとの強弱は判定できない。完了Trialの探索時間が短いことも、WP2Shell式が改善するかどうかを示さない。

## 既存決定との関係

ADR 0013の旧既定 `short-objective-v2` を、Root＋3の出力契約を明示した `short-objective-managed-v3` に更新する。ADR 0016の協調構成、安全境界、独立検証は維持する。prompt本文の版とdigestを記録し、変更時は新しい版を追加する。WP2Shell式を既定に切り替える判断は比較結果を見て別途記録する。
