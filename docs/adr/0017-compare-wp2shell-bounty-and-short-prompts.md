---
status: accepted
---
# 短い管理promptとWP2Shell式報奨promptを同条件で比較する

## 決定

Root＋最大3子の既定探索promptを、pilotで使ったv2からStored XSSのサイト全体制限を除き、情報読み取りより優先させた `short-objective-managed-v4` とする。WP2Shell由来の多様な仮説、waveごとの統合と反証、経路の連鎖を報奨探索向けに改訂した `wp2shell-bounty-v2` を版付きの比較armとして追加する。両promptの影響優先順位は揃え、Wordfenceで対象となる特定ページのStored XSSも含める。旧WP2Shellの「脆弱性は必ずある」「最低6時間」や特定の正解経路は持ち込まない。

最初の比較ではprompt以外のmodel・effort・Root＋3構成・Target Snapshot・Lab設定・Programme Boundary・wall上限・判定器を揃える。TranslatePress 3.2.6（Stored XSS）と3.3.1（アカウント乗っ取り）は公開済み経路に対する開発セットとして扱い、探索者へ答えを渡さない。3.2.6のLabは二次言語、翻訳対象、発火先を揃えてから実行する。各Trialは独立させ、同じ版を複数回試す場合は順序を交互または無作為にする。旧Trialと新Trialを同じ比較の分母に混ぜない。

Finding数だけでなく、独立判定器による同一経路の `runtime-confirmed`、XSS候補の有無と失われた段階、Lead、source coverage、run wall、provider使用量、子の結果保存、検証の `incomplete` 理由を分けて記録する。公開事例だけで優劣を決めず、最新版での報奨対象かつ非重複の確認数と費用を最終的な選択指標にする。1組のTrialからpromptの優劣を断定しない。

両promptとも現状はStored XSSを影響の優先順位の後方に置く。この共通条件でXSSを見落とした場合、短いprompt固有の欠点とは扱わない。優先順位やLab条件を変える実験はprompt構成の比較とは別に設計する。

## 理由

短い管理promptによるTranslatePress 3.3.1の協調Trialは、Rootと子が同じアカウント乗っ取り経路を出し、独立判定器で確認した。一方、3.2.6の完了TrialにはStored XSSのFindingが記録されなかった。そこでは二次言語のLab条件も不足しており、版と欠陥も3.3.1とは異なる。さらに旧prompt・判定器・Wordfence向けscope判定は、特定ページだけで発火するStored XSSを過度に除外していた。比較前にこの共通の欠陥を修正する。これだけで短いpromptの脆弱性種別ごとの強弱は判定できない。完了Trialの探索時間が短いことも、WP2Shell式が改善するかどうかを示さない。

範囲を直した短いv3のRoot＋3診断Trialでも、3.2.6ではStored XSSが0件で、情報読み取りのFindingが3件だった。v3は報奨対象のStored XSSより情報読み取りを先に並べていたため、v4ではこの順番を修正した。長いWP2Shell armを測る際は、brokerの400要求上限も比較途中の打ち切り要因となり得る。Root＋3の要求上限を1,600へ拡張し、wall・転送件数・上限到達を記録する。

最初のWP2Shell arm v1は3.2.6でFinding候補3件とLead候補3件を出したが、`sourceTrace` の型違いなどで全件がschema棄却された。候補はPrivate Evidenceに保持され、Stored XSSは含まれなかった。v1は優先Findingがあると30分より前に終了できる指示だったため、Rootは約5分で終えた。v2は出力契約を明示し、最初のFinding後も別のapproach familyを調べる指示に変える。v1の結果をv2や短いv4との正式比較に混ぜない。

v2の約35分の再試行では、最終JSONの候補は正しい `sourceTrace` 形式で残ったが、Rootが使い捨て領域に仮説メモを書いた `file_change` イベントをHarnessが未登録として扱い、正式なFindingには進めなかった。固定sourceは読取専用で、メモは隔離コンテナの一時領域に限られるため、このイベントを許容する。処理境界の失敗は探索0件と数えない。

同じ最終JSONのprofile schema監査では、WordPress coreの既知mountを `../wordpress/` と書いたFinding 2件もfile pathで棄却されることが分かった。固定mountだけを `@wordpress/` に正規化し、それ以外の親ディレクトリ参照は拒否する。これは候補の内容や有効性の判断ではなく、sourceの同一場所を表す構文の受理である。

承認済みコメントを共通のLab条件にした3.2.6の1組では、短いv4は約4分でStored XSS候補0件、長いv2は約38分で翻訳メモリのStored XSS候補1件を正式記録した。ただし後者は新Labでmachine translationと管理者画面操作の前提が再現できず `incomplete` で、両armとも `runtime-confirmed` は0件だった。長いv2の非cache入力は短いv4の約4.8倍、出力は約10倍。1組の診断だけで既定を長いv2へ切り替えない。次の設計焦点は、プラグインの通常機能をLabで再現するシナリオと、遠隔攻撃者のstepを新Labへ再実行できる検証recipeである。任意の管理者権限付与を「通常機能」として黙って追加しない。

## 既存決定との関係

ADR 0013の旧既定 `short-objective-v2` を、Root＋3の出力契約を明示した `short-objective-managed-v4` に更新する。ADR 0016の協調構成、安全境界、独立検証は維持する。prompt本文の版とdigestを記録し、変更時は新しい版を追加する。WP2Shell式を既定に切り替える判断は比較結果を見て別途記録する。
