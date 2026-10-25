---
status: accepted
date: 2026-10-25
amends: 0029（新規探索の唯一の mode）, 0033（最低 60 分は deep だけ）, 0036（wide の再開段落は停止規則の段落）
---

# 探索に deep と wide の 2 つの mode を置く（#518）

## 背景

新規探索の目的文は `wp2shell-bounty-v8` だけで、Root と最大 4 子の協調 Trial を、最低 60 分・wall 上限 120 分で回してきた（ADR 0029、0033）。2026-10-25 の分解の報告（`docs/reviews/2026-10-25-discovery-prompt-decomposition.md` 第 7〜10 節）は、v8 の本文を要素ごとに出典対照表の行へ分け、1 対象に 60 分以上を使う形のほかに、短い Trial で多くの対象を流す形が要ると整理した。

所有者は 2026-10-25 に「それでいこう」と決めた（親 Issue #518）。決めた内容は次のとおりである。

- v8 は置き換えない。`deep` mode としてそのまま残す。本文も digest も変えない。
- 大量探索向きの `wide` mode を足す。長い裾の対象を短く一巡する用途に使う。目的文は新版で、出典対照表の行だけで組む。
- mode の切り替えは Google Mantis に倣う。agent が途中で方式を選ぶのではなく、外側の設定値、構造化された数、前段が書いた file で決める。Trial の途中では mode を変えない。

所有者決定 2026-10-25（同日の追加）で、上の 1 点目を次のとおり改めた。

- `deep` の目的文は v8 から `wp2shell-bounty-v10`（#522）に替える。v8 の本文と digest は `archived` の行として残す。
- `wide` の 3 要素（子のツール呼び出し 80 回の上限と引き継ぎ、`/workspace/research/<family>.md` と `REGISTRY.md` への書き出し、2 hop の成功条件）は v10 にも入れる。`wide` の目的文は v10 から作る `wp2shell-bounty-v10-wide` とし、先に作った v9-wide は merge も実行もしていないので消す。
- v8 は実績のある方法である。「これらの変更がうまくいかなかったら v8 に戻す」。v10 と `wide` は本番の対象で試し、所有者が結果の手応えで採否を決める。

## 決定

| mode | 目的文 | 最低時間 | 既定の wall | 再開段落 |
| --- | --- | --- | --- | --- |
| `deep` | `wp2shell-bounty-v10`（#522） | 60 分 | 120 分（60 分を超え 120 分以下） | 「Before giving up,」で始まる最後の段落 |
| `wide` | `wp2shell-bounty-v10-wide`（新規） | なし | 20 分（120 分以下） | 「Stop when」で始まる最後の段落 |

2 つの mode の違いは、早く終えるか、粘って探すかの違いだけである。`wp2shell-bounty-v10-wide` は v10 と段落単位で次の 2 か所だけが違い、ほかの段落はバイト単位で同じである（`tests/profiles/wordpress/discovery-prompts.test.ts` で確かめる）。

1. v10 の「Do not return merely because current approaches fail or agents report no findings.」で始まる粘りの段落を外した。
2. v10 の最後の段落「Before giving up, use at least one hour for active exploration. …」を、「Stop when two consecutive waves produce no new approach family and no new candidate, or when the Trial wall is reached, whichever comes first. …」で始まる停止規則の段落に替えた。

- mode は campaign 設定の `discovery.mode` に書く。省略すると `deep` になる。`promptId` を書く場合は、その mode の現行の目的文でなければならない。省略すると mode の現行の目的文になる。`runWallTimeMinutes` も省略すると mode の既定値になる。
- mode は Trial の属性で、台帳の `discovery-run-started` の `configuration.mode` に記録する。2026-10-25 より前の event には無い。無い event は mode を置く前の Trial である。
- `wide` は、Root と最大 4 子の協調 Trial、出力契約 v4、trust 境界、Programme Boundary、source と研究 notes の場所の節を `deep` と同じ形で渡す。違うのは目的文の上の 2 段落と時間だけである。Harness は最低時間を 0 として runner に渡し、runner は最初の turn だけを行う。Root の最初の最終報告が Trial の終わりになる。
- `deep` の時間の規則は変えない。最低 60 分、早い最終報告の同一セッション継続、wall 上限 120 分はそのまま。
- 再開（ADR 0036）は、目的文の最後の段落を固定の指示として渡す規則を mode ごとに読む。`deep` は「Before giving up,」、`wide` は停止規則の「Stop when」で始まる段落を要求する。再開 segment の最低時間と wall は、その mode の値から消費済み wall を引いて決める。再開は目的文の digest が元の run と同じことを要求するので、mode は再開をまたいでも変わらない。
- 選定は両 mode で同じ方針を使う。選定方針の `promptVariant` は、どちらかの mode の現行の目的文であればよい。
- `wide` で残った対象を `deep` の再訪列に入れる規則は、この ADR では決めない。Issue #519 で扱う。判定器が確認した後に操作者が回す `sweep` skill も Issue #520 で扱い、この ADR には含めない。

## 理由

- v8 の本文と digest を `archived` の行として残すので、既存の Trial は v8 の目的文と digest で照合でき、v8 に戻すときも本文を作り直さずに済む。
- 時間の下限と目的文を mode という 1 つの設定値に結び付けると、Harness は値を読んで渡すだけで済む。どこを読むか、どう分けるかの判断は目的文と Root に残る（AGENTS.md「Harness と AI の責務」）。
- Mantis と同じく、切り替えを設定値と台帳の数で決めると、比較の分母を mode ごとに分けられる。agent が途中で方式を変えると、どちらの mode の結果かが決まらない。
- `wide` の目的文は v10 から 1 段落を外し、1 段落を出典対照表の行（#20、#25、W1）の停止規則に替えただけで、要素を足していない（[本文と出典対照](../reviews/2026-10-25-wp2shell-bounty-v10-wide.md)）。2 つの目的文の差を 2 段落に限ると、mode の比較で違いが出たとき、その原因を「早く終えるか、粘るか」だけに絞れる。

## 採らなかった選択肢

- `deep` を `wide` で置き換える。`deep` の分母と再発見の記録が途切れる。所有者も置き換えではなく追加を選んだ。
- `wide` の目的文を v10 とは別の本文（先に作った v9-wide）で組む。2 つの目的文の差が多いと、mode の比較で何が効いたかを分けられない。v9-wide は merge も実行もしていないので、digest を残す必要も無い。
- `wide` で候補 0 件の対象だけを `deep` に回す（`wide` の結果で `deep` の起動を絞る）。screening から条件付き deep-dive へ進む分岐を主経路に置かないと ADR 0029 で決めた。0 件は脆弱性なしを意味しない。
- Harness が対象の source を分割して子に割り当てる。分担と仮説は Root が決める。入口索引と分割は ADR 0034 で削除した。

## 帰結

- 2 つの mode は、quota 1 時間あたりの Finding・Lead・`runtime-confirmed` で比べる。funnel と実験記録の分母は mode ごとに分け、混ぜない。
- 本番の `src/profiles/wordpress/policy/campaign.json` は `deep` のまま。`wide` の設定例は `examples/campaign-wide-20.json` に置いた。
- `select` が直接読む選定方針と、campaign 設定が名指す選定方針の `promptVariant` は、どちらの mode の現行 id でも受け付ける。
- 所有者決定 2026-10-25 により、v10 と `wide` は本番の対象で試し、所有者が結果の手応えで採否を決める。開発セットの Trial は取らない（DEVELOPMENT.md 第 2 節）。

## 消し方

戻す先は v8 である。v8 は実績のある方法で、所有者決定 2026-10-25 は「これらの変更がうまくいかなかったら v8 に戻す」。

- `deep` の目的文だけを戻すときは、`src/profiles/wordpress/prompts/index.ts` で v8 を `current`・`mode: "deep"` にし、v10 を `archived` にして `mode` を外す（手順は `docs/reviews/2026-10-25-wp2shell-bounty-v10.md` 第 5 節）。
- `wide` を消すときは、`src/profiles/wordpress/prompts/index.ts` の v10-wide の行を `archived` にして `mode` を外す（走った Trial の目的文と digest を照合するため、本文と行は残す）。下の手順で mode の仕組みも外す。
- `index.ts` の `WORDPRESS_DISCOVERY_MODES`、`WORDPRESS_CURRENT_DISCOVERY_PROMPT_IDS`、`wordPressDiscoveryModeOf` と、行の `mode` を消し、`WORDPRESS_CURRENT_DISCOVERY_PROMPT_ID` を表から直接求める形に戻す。
- `src/cli/wordpress-session.ts` の `discovery.mode`、`WORDPRESS_WIDE_DEFAULT_WALL_MINUTES` と、mode ごとの既定値の transform を消し、`promptId` と `runWallTimeMinutes` を `deep` の現行の目的文（v8 に戻した後なら v8）の literal と `gt(60)` に戻す。
- `src/cli/wordpress.ts` の `wordPressMinimumActiveMs` と mode ごとの再開段落を消し、60 分の定数と「Before giving up,」に戻す。runner が 0 の下限を受け付ける変更は残してよい。
- 台帳の `configuration.mode` は、記録済みの event を読むために読み取り専用で残す。
- `examples/campaign-wide-20.json` を消し、本 ADR を `superseded` にして、SPEC、AGENTS.md、DEVELOPMENT.md の該当文を戻す。

## 2026-10-25 追記: `wide` の目的文を v11-wide にする（PRISM の方針、所有者決定）

所有者は 2026-10-25 に、`wide` の目的文を「PRISM の方針に近づける」と決めた。根拠は、Wordfence が PRISM について本人の言葉で書いた記述（`docs/reviews/2026-10-25-wordfence-argus-and-prism.md` 第 5 節）である。PRISM は脆弱性の種別ごとに専門のエージェントを 1 体ずつ置き、1〜2 段の短い経路を狙い、WordPress の ground truth に導かれる。この記述を出典対照表の第 2.1 節に PRISM-a〜d の行として足し、その行と既存の行だけで新しい目的文を組んだ（[本文と出典対照](../reviews/2026-10-25-wp2shell-bounty-v11-wide.md)）。

- `wide` の現行の目的文は `wp2shell-bounty-v11-wide`（`sha256:e7c46f4b5289731f7d780640f009b58a305f99099e2ba10148fb2c1b6b4f676b`）とする。到達先の種別ごとに 4 体の専門エージェントを固定で置き（HTML 出力、SQL、ファイル・パス・include・アップロード・unserialize、本人確認と認証）、各エージェントが担当の入口を一通り終えたら止める。
- `wp2shell-bounty-v10-wide` は本番 campaign `prod-20261025-1` で 1 回分を回したので、本文と行を `archived` で残す。走った Trial の目的文と digest を照合するためである。
- `deep` は v10 のまま変えない。
- これで、上の決定にある「2 つの mode の違いは、早く終えるか、粘って探すかの違いだけである」は成り立たなくなる。v11-wide からの違いは、「早く終え、種別ごとの専門エージェントを固定で置く」（`wide`）と「粘り、多様な着眼点の組を Root が動かす」（`deep`）の違いである。v11-wide は、v8 から続く「固定配分をしない」規則（出典対照表 1 の #17）を、所有者決定によって外した。mode の比較で違いが出ても、原因を時間配分だけに絞ることはできない。
- v11-wide でも最後の段落は「Stop when」で始まる。再開段落の規則と、最低時間・既定の wall はこの ADR の決定のまま変えない。
- 戻すときは v11-wide → v10-wide → v8 の順に戻す。手順は v11-wide の文書の第 5 節にある。
