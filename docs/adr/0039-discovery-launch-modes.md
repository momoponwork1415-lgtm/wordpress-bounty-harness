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

## 2026-10-25 追記 2: `wide` の目的文を v12-wide にする（PRISM の記事と公開記録、所有者決定）

所有者は 2026-10-25 に「記事から探索手法が読み取れるならそっちに寄せて」と決めた。根拠は、Wordfence の PRISM / Argus の記事 14 本と詳細ページ 75 件を読んだ報告（`docs/reviews/2026-10-25-wordfence-prism-argus-method-and-cases.md`）である。記事から読める PRISM の手法 6 点のうち、v11-wide に無かったのは「到達先から逆向きにもたどる」で、公開記録からは「毎 request で走る早期 hook の入口」と「繰り返し出る 6 つの形」が読める。この 3 点を出典対照表の第 2.1 節に PRISM-e〜l の行として足し、その行だけで v11-wide に 1 句、1 文、1 段落を足した（[本文と出典対照](../reviews/2026-10-25-wp2shell-bounty-v12-wide.md)）。ほかの段落は 1 バイトも変えない（`tests/profiles/wordpress/discovery-prompts.test.ts` の v12-wide の test）。

- `wide` の現行の目的文は `wp2shell-bounty-v12-wide`（`sha256:9a79a3b20fdba7af54f32464d868ab00806335c526781aba026e76ce9290c3c3`）とする。
- `wp2shell-bounty-v11-wide` は本番で走っていないが、版を上げた旧版として `archived` で残す。
- `deep` は v10 のまま変えない。4 体の専門エージェント、1〜2 hop、停止規則、再開段落、最低時間、既定の wall は追記 1 のまま変えない。
- 測った数字は、所有者の 2026-10-25 の決定（#521 のコメント）どおり本番の対象で取る。参考として、v10-wide は本番 `prod-20261025-1`〜`-3` の 24 対象で Finding 0、Lead 17 だった（v11-wide、v12-wide はまだ走っていない）。
- 戻すときは v12-wide → v11-wide → v10-wide → v8 の順に戻す。手順は v12-wide の文書の第 5 節にある。

## 2026-10-25 追記 3: 子の上限・最低時間・Lab 予算を設定値にし、`wide` の既定 wall を 120 分にする（所有者決定、Phase C1）

所有者は 2026-10-25 に、Harness が強制するのは子の最大数、時間、Lab の予算の 3 つだけと決めた（`docs/reviews/2026-10-25-exploration-architecture-redesign.md` 第 7 節、第 12 節 Q3・Q7・追加「最低 60 分」）。同じ対話で、`wide` は時間を気にせず、入口の一巡が終わるまで走らせ、終わりは停止規則の段落に任せると決めた。上の決定の表にある `wide` の「既定の wall 20 分」を、この追記で次のとおり改める。表の行は当時の記録として残す。

- `wide` の最低時間は 0 のまま。既定の wall は 120 分（ADR 0029 の上限）にする。`runWallTimeMinutes` を明示した campaign はその値のまま走る。`examples/campaign-wide-20.json` は 20 分を明示しているので変わらない。
- `deep` の既定（最低 60 分、wall 120 分）は変えない。最低時間は `discovery.minimumActiveMinutes`（0〜119）で上書きできる。0 より大きいときは wall がそれを超えなければならない。
- 子の上限は `discovery.maxChildren`（1〜8、既定 4）にする。Codex は `agents.max_threads`、Claude は PreToolUse hook がこの値で同時に生きる子を止める。実際に何体使うかは Root が決める。
- `discovery.lab` は `{ mode: "none" | "attached", maxResets }`（`maxResets` は 0〜5、既定 2）にし、文字列の `"none"` も同じ形に直して受け付ける。探索 Lab は Phase D1 で供給するので、それまで `attached` は設定検査で拒否する。
- 同じ値を Harness が生成する `## Run parameters` 節で Root にも伝え（ADR 0019 と同じ形）、台帳の `configuration` に `wallMinutes`、`minimumActiveMinutes`、`maxChildren`、`lab`、`model`、`effort` として残す。2026-10-25 より前の event には無い。
- 目的文の本文と digest は変えない。本文の数値文（「80 tool calls」、「at least one hour」、「120-minute wall cap」など）は C2 の版上げで外す。生成節が増えたので `inputDigest` は変わる。
- 消し方: `discovery.maxChildren`、`discovery.minimumActiveMinutes`、`discovery.lab` の object 形と `## Run parameters` 節を外し、`agents.max_threads=4`、hook の 4、mode ごとの定数（`wide` の wall 20 分を含む）に戻す。台帳の追加 field は読み取り専用で残す。

## 2026-10-25 追記 4: 目的文の次の版（`deep` は v11、`wide` は v13-wide）。子の寿命の段落と数値の文を外す（所有者決定、Phase C2）

所有者は 2026-10-25 に、子のツール呼び出し 80 回の段落（「Keep every agent short. …」）には根拠が無いので、`deep` と `wide` の両方の次の版から外すと決めた。80 という数はどこにも移さない。同じ対話で、Harness が強制して `## Run parameters` 節で伝える数（wall、最低時間、子の数）は、本文に重ねて持たないと決めた（`docs/reviews/2026-10-25-exploration-architecture-redesign.md` 第 7 節、第 12 節 Q7）。Root は Run parameters の上限の中で、何体の子を使うかを決める。

同じ日の訂正で、Codex と Claude のどちらの runtime でも、Root と到達先の種別ごとに 1 体の専門エージェントの形を保つと決めた。1 体のエージェントが種別を順に掃く形の目的文と、協調の形を選ぶ設定は作らない。

- `deep` の現行の目的文は `wp2shell-bounty-v11`（~~`sha256:03d87941138ba92f7e5ab41e716de9b115cc63509a43739cb766e8dad7a37481`~~。2026-10-26 に `sha256:0ce13a617484c0e0b7ff3af6a55b4b821ea106189a897ed573040e9d5ad16ae9` へ置き換えた。下の 2026-10-26 の段落）とする。v10 から寿命の段落を外し、「You may spawn up to 4 agents at any one time.」の 1 文を外し、最後の段落の「one hour」を「the minimum active exploration time stated in the Run parameters」に替えて「The Trial has a 120-minute wall cap.」を外した。最後の段落は「Before giving up,」で始まるので、再開段落の規則は変わらない（[本文と出典対照](../reviews/2026-10-25-wp2shell-bounty-v11.md)）。
- `wide` の現行の目的文は `wp2shell-bounty-v13-wide`（~~`sha256:4be7c360dac8f3e9651a1174dab462e4aec1f32bcb623dfe0180fda63637efbc`~~。2026-10-26 に `sha256:0dd2072b4c6a544d47ebb6df94c7981f2fbb758b4dee82e063896ff91f892bb8` へ置き換えた。下の 2026-10-26 の段落）とする。v12-wide から寿命の段落を外し、「Use four specialist agents, one per sink class,」を「Use one specialist agent per sink class,」に、「The root agent assigns the four sinks,」を「The root agent assigns one sink class to each specialist,」に替えた。4 つの到達先の種別はそのまま並ぶので、専門エージェントの数は種別から決まる。最後の段落は「Stop when」のまま（[本文と出典対照](../reviews/2026-10-25-wp2shell-bounty-v13-wide.md)）。
- `wp2shell-bounty-v10` と `wp2shell-bounty-v12-wide` は `archived` にする。本文、digest、fragments の行は残し、走った Trial の目的文、digest、節の digest を照合できるようにする。`archived` の行は `mode` を持たないので、新規の campaign では選べない。
- どちらの新版も、出典対照表の既存の行（第 2 節の #14、#17、#20、第 2.1 節の PRISM-a）だけで組み、新しい行は足していない（2026-10-26 に #29、#30 を足した。下の段落）。ほかの段落は 1 バイトも変えていない（`tests/profiles/wordpress/discovery-prompts.test.ts` の v11 と v13-wide の test）。
- `src/profiles/wordpress/policy/campaign.json` の `promptId` と `src/profiles/wordpress/policy/selection.json` の `promptVariant` は v11、`examples/campaign-wide-20.json` の `promptId` は v13-wide にする。本番の選定方針の revisit は `version-increased` なので、`promptVariant` の版上げで再訪の対象は変わらない。
- 測った数字: 数字待ち（本番で取る。所有者の 2026-10-25 の決定）。Trial は回していない。
- 戻すときは、`deep` は v11 → v10 → v8、`wide` は v13-wide → v12-wide → v11-wide → v10-wide → v8 の順に戻す。手順は各版の文書の第 5 節にある。

2026-10-26 の補い（所有者）: 所有者は 2026-10-26 に、外した 80 回の段落の代わりを示した。規則は固定の回数ではなく、Claude runtime がすでにしているように、切りのいいところで子を替えることである（「80 回という固定値ではなく、Claude のように切りのいいところで子を替える」）。子には仕事を 1 つ渡し、子はその仕事が終わったら返る。Root は返った子に次の仕事を送らず、次の仕事には新しい子を立てる。観測した根拠は PR #535 の本番 10 Trial で、Claude runtime の子 78 体は同一スレッドの追依頼が 0（one-shot）で、子由来の Finding は 3/3 だった。Codex の子 47 体は追依頼 147 で、子由来の Finding は 0/0 だった。v11 と v13-wide はまだ main に入っておらず、どの run も使っていないので、同じ id のまま本文を改めた。

- 共有の fragment `coordination/handover-v11` を足し、v11 では `persistence/research-v10` の直後、v13-wide では `persistence/research-v11` の直後に置いた。回数の上限は本文にも Harness にも置かない。
- v13-wide だけ、`coordination/fixed-v13` の「and does not launch further rounds」の文を「the only new specialists it starts are the ones that continue a sink whose entry points remain」に替え、停止規則を `coordination/stop-wide-v13` にして最初の文を「Stop when the registry shows that the entry points of every sink have been worked through, …」に替えた。子が到達先の途中で返るので、新しく立てる専門エージェントと止める判断を registry に合わせた。v11-wide と v12-wide は `coordination/stop-wide-v11` のまま。
- 新しい digest は、`wp2shell-bounty-v11` が `sha256:0ce13a617484c0e0b7ff3af6a55b4b821ea106189a897ed573040e9d5ad16ae9`、`wp2shell-bounty-v13-wide` が `sha256:0dd2072b4c6a544d47ebb6df94c7981f2fbb758b4dee82e063896ff91f892bb8` である。上の箇条の旧 digest は打ち消し線で残した。
- 出典対照表 第 2 節に #29（子の交代）と #30（v13-wide の Root の 1 文と停止規則の最初の文）を足した。出典は所有者の指示 2026-10-26 と PR #535 の観測で、AI が足した要素は無い。
- 測った数字: 数字待ちのまま。Trial は回していない。

## 2026-10-26 追記 5: `wide` の目的文を v14-wide にする（所有者決定）

所有者は 2026-10-26 に、入口や経路の書き方を命令ではなく例に寄せること、探索 AI は脆弱性探索に集中させて後段の人間レビューで多少の偽陽性を許容すること、hop 数を経路の上限として指定しないことを決めた。根拠と変更要素は [v14-wide の出典対照表](../reviews/2026-10-26-wp2shell-bounty-v14-wide-source-table.md) に置く。

- `wide` の現行の目的文は `wp2shell-bounty-v14-wide`（`sha256:42ec734364d93492bf9b936e415b94796da21fb154d3b29033cafbd58596229d`）とする。`wp2shell-bounty-v13-wide` は本文・fragment 構成・digest を変えず `archived` にする。`deep` の `wp2shell-bounty-v11` は変えない。
- v13-wide から替える fragment は `strategy/sinks-v13` → `strategy/sinks-v14` と `coordination/fixed-v13` → `coordination/fixed-v14` の 2 つだけである。ほかの fragment は同じ file 名を同じ順で再利用し、本文もバイト単位で同じにする。
- `sinks-v14` は、入口順を観測頻度の例にし、短い経路を必須単位にせず source が全 hop を支える長い chain を許容する。第三者 service から取り込む内容を例示付きで attacker-placeable input とし、query・path・markup を組み立てる共有 helper は helper 側で引数の配列・想定外型まで一度確かめて到達する caller を列挙する。
- `fixed-v14` は、source に根拠のある chain に不確かさが残っても明記して報告し、後段の人間レビューは多少の偽陽性を許容し、見落としをより高い費用として扱う。専門 agent の割当、残った入口を続ける子、最後の runtime confirmation の文は変えない。
- 測った数字は merge 前に同じ 6 件で再計測して PR に貼る。この変更を作る作業では Trial を起動しない。
- 戻すときは v14-wide を `archived` にして mode を外し、v13-wide を `current`・`mode: "wide"` に戻す。両版の本文、fragment と digest は履歴照合のため残す。

## 2026-10-26 追記 6: 再開 segment は Trial が記録した Run parameters で走る（#548）

PR #537 のレビューで、再開（ADR 0036）が子の上限・最低時間・wall を今の campaign 設定から組み直していると分かった。一方、再開 segment の `configuration` は最初の区間の値を写す。区間の間に設定を変えると、台帳の値と実際に強制した値が食い違っていた。

- 再開 segment は、元の run の `configuration` にある `maxChildren`、`minimumActiveMinutes`、`wallMinutes` を強制し、`## Run parameters` 節も同じ値で組む。今の設定は使わない。
- 追記 3 より前の run には記録が無い。子の上限は当時の固定値 4 を使い、最低時間と wall は従来どおり今の設定から取る。
- 目的文・Snapshot・runtime profile・Lab 予算が違えば拒否する規則（`prompt-version-differs` など）は変えない。※ 目的文は 2026-10-27 に、記録した版で組むよう改めた（ADR 0036 の 2026-10-27 追記）。
- 消し方: この節と #548 の差分を戻す。再開はまた今の設定から組み直す。

## 2026-10-26 追記 7: 本番の既定を `wide` にする（所有者決定）

「帰結」の「本番の `src/profiles/wordpress/policy/campaign.json` は `deep` のまま」を改める。所有者は 2026-10-26 に、本番の既定を `wide` の `wp2shell-bounty-v14-wide` にすると決めた（ADR 0032 の 2026-10-26 追記 4、[監査](../reviews/2026-10-26-system-audit.md) 第 C.3 節と第 F.2 節）。

- `campaign.json` は `discovery.mode: "wide"` と `promptId: "wp2shell-bounty-v14-wide"` にし、ほかの値（wall 120 分、`lab: none`、同時対象 1、Programme Boundary、WordPress の版）は変えない。最低時間は `wide` の既定の 0 になる。
- `deep` の `wp2shell-bounty-v11` は名指しの Trial でだけ使う。campaign 設定の `discovery.mode` を `deep` にして回す。`discovery.mode` を省いたときの schema の既定は `deep` のままにする。
- 選定方針の `promptVariant`（v11）は変えない。どちらの mode の現行 id でもよい（「決定」の節）。
- 消し方: `campaign.json` の 2 つの値を `deep` と v11 に戻し、この節を消す。

## 2026-10-26 追記 8: `wide` の比較候補 v15-wide（#599、#555、所有者決定）

2026-10-26 の Lab arm（開発セット 6 Trial、v14-wide、`discovery.lab: attached`）は、Lab が `ready` になったのに Root も子も Lab に要求を 1 回も送らなかった。Harness の `## Lab` 節は Root にだけ渡り、子は Root の Agent tool から起動されるので、Root が写さない限り Lab を知らない（#599）。所有者は 2026-10-26 に、#599 の (a)、目的文に「Lab の節は子にも渡す」の 1 文を足して版を上げる案を選んだ。

- `wp2shell-bounty-v15-wide`（`sha256:3e82116ebdd32e4e863d7daacf7a87d90c43f6c4e73efe49333668883fcf680d`）を足す。v14-wide から替える fragment は `objective/task-v10` → `objective/task-v15` と `coordination/fixed-v14` → `coordination/fixed-v15` の 2 つだけである。
- `fixed-v15` は Root の段落に「When the Trial has a Lab, the root agent copies the `## Lab` section supplied by the Harness, unchanged, into the instructions of every agent it starts.」の 1 文を足す。Lab で何を試すかは書かない（AGENTS.md「Harness と AI の責務」）。最後の段落は「Stop when」のまま。
- 同じ版で、判定器を現行として書いた 2 文（#555）を「確定は、名指しした人間が review Lab で記録した観測だけで行う」の意味に替える（出典: ADR 0040）。`task-v15` は 1 文目の判定器と canary の文、`fixed-v15` は Root の段落の最後の文である。ほかのバイトは v14-wide と同じ（`tests/profiles/wordpress/discovery-prompts.test.ts` の v15-wide の test）。`deep` の v11 は変えない。
- 本番で v14-wide と交互に回して比べる（DEVELOPMENT 第 5 節）。そのため prompt 表に `candidate` の状態を足した。`candidate` の行は `mode` を持ち、campaign 設定の `promptId` で名指ししたときだけ起動する。`promptId` を省いた campaign は従来どおり mode の `current` を使う。`wide` の `current` は v14-wide のままで、`src/profiles/wordpress/policy/campaign.json` は変えない。採否が決まったら、採る版を `current`、もう一方を `archived` にし、`candidate` の行を残さない。
- 測った数字: なし。本番で取る（受け入れは #599 のとおり、本番の Lab arm で Trial ごとの Lab 要求数が 0 でないこと）。
- 消し方: v15-wide の行と 2 つの fragment を消す（Trial が走った後なら `archived` にして残す）。`candidate` の状態は、ほかに `candidate` の行が無ければ外す。

## 2026-10-26 追記 9: `wide` の目的文を v16-wide にする（所有者指示）

2026-10-26 の本番で、ベンダーだけが書く内容（セキュリティスキャナの結果、脆弱性データベース、WAF や API の応答本文、マーケティングサービスとの連携）を攻撃者入力として扱う Finding が 9 件出た。根拠は v14-wide の `sinks-v14` にある、第三者のサービスから取り込む内容を一律に攻撃者が置ける入力とする文だった。所有者は同日、この文を「置ける者がベンダーだけなら攻撃者ではない」に直すよう指示した。その前に「外部サービスでもいいが、SNS など書き込めればいい」とも言っている。本文、差分、出典対照表は [v16-wide の文書](../reviews/2026-10-26-wp2shell-bounty-v16-wide.md) に置く。

- `wp2shell-bounty-v16-wide`（`sha256:1ffb15f4f3f7ad6de70e330e10fd24c31513e41d250c8e0d6885b760a0a5c1f3`）を `wide` の `current` にする。v14-wide から替える fragment は `strategy/sinks-v14` → `strategy/sinks-v16` の 1 つだけで、替えるのはその中の 1 文だけである。ほかのバイトは v14-wide と同じ（`tests/profiles/wordpress/discovery-prompts.test.ts` の v16-wide の test）。
- `wp2shell-bounty-v14-wide` は本文・fragment 構成・digest を変えず `archived` にする。`src/profiles/wordpress/policy/campaign.json` と `examples/campaign-wide-20.json` の `promptId` を v16-wide にする。ほかの値は変えない。
- 比較候補の v15-wide は `candidate` のまま変えない。`sinks-v14` を使うので、この文の修正は入っていない。`deep` の v11 も変えない。
- 測った数字: なし。本番で、同じ選定帯の切り替え前（v14-wide）と切り替え後（v16-wide）の窓を比べる（DEVELOPMENT 第 5 節）。
- 消し方: v16-wide を `archived` にして mode を外し、v14-wide を `current`・`mode: "wide"` に戻し、2 つの campaign 設定の `promptId` を v14-wide に戻す。v16-wide の本文、`sinks-v16` と digest は、Trial が走った後なら履歴照合のため残す。

## 2026-10-27 追記 10: `wide` の目的文を v17-wide にする（所有者決定、迷ったら Lead）

所有者は、新しい Finding 85 件を screen-out した。46 件は攻撃者が入力を制御できないもので、17 件は管理者が危険な設定を作らないと成り立たないものだった。これを受けて所有者は 2026-10-27 に「迷ったら報告はやめようか」と言い、AskUserQuestion の回答で「迷ったら Lead にする」を選んだ。本文、差分、出典対照表は [v17-wide の文書](../reviews/2026-10-27-wp2shell-bounty-v17-wide.md) に、日本語訳は [v17-wide 日本語訳](../reviews/2026-10-27-wp2shell-bounty-v17-wide-japanese.md) に置く。

この決定は、追記 5 の「後段の人間レビューで多少の偽陽性を許容する」（2026-10-26 の「広く報告して review で落とす」。ADR 0038 の 2026-10-26 追記 13 の「変えないもの」でも引いている）を `wide` の現行の目的文について上書きする。追記 5 の本文は書き換えない。

- `wp2shell-bounty-v17-wide`（`sha256:9a32ddcf2083c8e82952907742823bfaa29f8068d346132206b87cf412165bc9`）を `wide` の `current` にする。v16-wide から替える fragment は `strategy/sinks-v16` → `strategy/sinks-v17` と `coordination/fixed-v14` → `coordination/fixed-v17` の 2 つで、替えるのは 3 文である。ほかのバイトは v16-wide と同じ（`tests/profiles/wordpress/discovery-prompts.test.ts` の v17-wide の test）。
- `sinks-v17` は、管理者が有効にできる設定の文に「管理者が安全でない形で作らなければならないフィールド、列、query の条件、テンプレート、スニペット、設定は、もっともらしい設定ではない」を足す。`fixed-v17` は、Root が chain を Finding か Lead のどちらかで必ず報告し、攻撃者が入力を置けることと典型的なサイトで sink に届くことの両方をソースが示すときだけ Finding にし、どちらかが不確かなら不確かさを明記した Lead にする。誤検知を許容する文は消える。
- `wp2shell-bounty-v16-wide` は本文・fragment 構成・digest・契約 v5 を変えず `archived` にする。`src/profiles/wordpress/policy/campaign.json` と `examples/campaign-wide-20.json` の `promptId` を v17-wide にする。ほかの値は変えない。
- 比較候補の v15-wide は `candidate` のまま変えない（`sinks-v14` と `fixed-v15` を使う）。`deep` の v11 も変えない。ADR 0038 の 2026-10-26 追記 13 の出口の park（申告欄の値による `declared-precondition`）は 2 つ目の線として残す。Lead の型と保存も変えない。
- 測った数字: なし。本番で、同じ選定帯の切り替え前（v16-wide）と切り替え後（v17-wide）の窓を比べる（DEVELOPMENT 第 5 節）。見る数字は Trial あたりの Finding と Lead、人間が reject した Finding の割合、`declared-precondition` の park の件数である。
- 消し方: v17-wide を `archived` にして mode を外し、v16-wide を `current`・`mode: "wide"` に戻し、2 つの campaign 設定の `promptId` を v16-wide に戻す。v17-wide の本文、`sinks-v17`、`fixed-v17` と digest は、Trial が走った後なら履歴照合のため残す。

## 2026-10-27 追記 11: `wide` の目的文を v16-wide に戻す（所有者決定、数字で戻す）

追記 10 の v17-wide を本番で走らせた結果、Trial あたりの出力が分類の変化ではなく量として減った。2026-10-24 以降の本番 Trial で、Codex は v14-wide の 21 Trial で Finding 3.6・Lead 3.7（計 7.3）/Trial だったものが、v17-wide の 34 Trial で Finding 0・Lead 1.0（計 1.0）/Trial になり、Root の時間は 15 分から 7 分に、Root が読む固有 file は 30 から 17 に減った。Claude は v14-wide の 36 Trial で計 5.2/Trial、v17-wide の 21 Trial で計 2.0/Trial だった。「迷ったら Lead」の 2 文（`sinks-v17` の「管理者が安全でない形で作る設定はもっともらしくない」と `fixed-v17` の「両方をソースが示すときだけ Finding」）は、Lead への格下げではなく chain を書かない方向に効いた。

同日、v14 系の Finding 162 件をソースだけで読み直す段（入力支配と到達性の 2 つの問い）を試したところ、成立 88・不成立 67・未決 7 で、人間の選別と 2 つの問いについて 159 / 162 で一致した。人間が外した層（ベンダー feed、管理者の危険設定）は、目的文で絞らなくても後段で落とせる。所有者は 2026-10-27 に「文 1（ベンダーだけが置ける内容は攻撃者入力ではない。`sinks-v16`）は残し、文 2 と文 3 は v14 に戻す」を選んだ。これは v16-wide の本文そのものなので、新しい版は作らない。

- `wp2shell-bounty-v16-wide`（`sha256:1ffb15f4f3f7ad6de70e330e10fd24c31513e41d250c8e0d6885b760a0a5c1f3`、契約 v5）を `wide` の `current` に戻す。本文、fragment、digest は変えない。
- `wp2shell-bounty-v17-wide` は本文・`sinks-v17`・`fixed-v17`・digest・契約 v5 を変えず `archived` にする（Trial が走ったので照合用に残す）。`src/profiles/wordpress/policy/campaign.json` と `examples/campaign-wide-20.json` の `promptId` を v16-wide に戻す。
- 追記 5 の「後段の人間レビューで多少の偽陽性を許容する」は、`wide` の現行の目的文について再び有効になる。偽陽性はソース読み直しの段で落とす（ADR 0038 に別途書く）。
- 比較候補の v15-wide は `candidate` のまま変えない。`deep` の v11 も変えない。
- 測った数字: 上の Trial あたりの Finding と Lead、Root の時間と読み、ソース読み直しの一致率。
- 消し方: 追記 10 の手順をもう一度行う（v17-wide を `current`・`mode: "wide"` に、v16-wide を `archived` に、2 つの campaign 設定の `promptId` を v17-wide に）。

## 2026-10-27 追記 12: `wide` の目的文を v14-wide に戻す（所有者決定、数字で戻す）

追記 11 の v16-wide を本番と pass@3 の実験で走らせた結果、Finding の出方は v14-wide ではなく v17-wide に近かった。Root 単位の台帳の数字（2026-10-26 と 2026-10-27 の本番、子の上限は 10-26 が 4、10-27 が 8）:

| 日 | 目的文 | runtime | Trial | Finding/Trial | Lead/Trial | Root の分 |
|---|---|---|---|---|---|---|
| 10-26 | v14-wide | Codex | 21 | 3.6 | 3.7 | 14.6 |
| 10-26 | v17-wide | Codex | 31 | 0.0 | 0.8 | 6.8 |
| 10-27 | v16-wide | Codex | 42 | 0.3 | 3.5 | 9.2 |
| 10-26 | v14-wide | Claude | 36 | 0.4 | 4.8 | 11.6 |
| 10-27 | v16-wide | Claude | 5 | 0.6 | 10.2 | 14.8 |

Lead は v14-wide の水準に戻ったが、Finding は戻らなかった。10-26 に v14-wide で Finding を出した 19 対象を v16-wide で 2 回ずつ走らせた pass@3 では、38 Trial のうち Finding が 1 件以上出たのは 5 対象の 6 Trial だった。v16-wide の文 1（ベンダーだけが置ける内容は攻撃者入力ではない）が Finding を書く手前で止める方向に効いているか、同時に変えた子の上限 8 が Root の動きを変えているかは、この数字では分けられない。ベンダー由来の層は段 1b の `wbh-source-check`（ADR 0038 追記 14）で落とせる（不成立 67 件のうち入力支配 no が 51 件）ので、目的文で絞る必要はない。

- `wp2shell-bounty-v14-wide`（`sha256:42ec734364d93492bf9b936e415b94796da21fb154d3b29033cafbd58596229d`）を `wide` の `current` に戻す。本文、fragment、digest は変えない。契約は、新しい Trial を起こせる行の規則（ADR 0038 追記 13）に従って v5 を受け取る。契約節は Harness が生成する節なので、目的文の digest は変わらない。（同日の ADR 0038 追記 15 で v4 に戻した。）
- `wp2shell-bounty-v16-wide` は本文・`sinks-v16`・digest・契約 v5 を変えず `archived` にする（Trial が走ったので照合用に残す）。`src/profiles/wordpress/policy/campaign.json` と `examples/campaign-wide-20.json` の `promptId` を v14-wide に戻す。
- 子の上限は変えない（本番は `discovery.maxChildren: 8` のまま）。目的文だけを戻すので、次の 10 Trial で Finding/Trial が 3 前後に戻れば文 1 が原因、戻らなければ子の上限 8 が原因と分けられる。
- 比較候補の v15-wide は `candidate` のまま変えない。`deep` の v11 も変えない。
- 測った数字: 上の表と pass@3 の 6 / 38。
- 消し方: 追記 11 の手順をもう一度行う（v16-wide を `current`・`mode: "wide"` に、v14-wide を `archived`・契約 v4 に、2 つの campaign 設定の `promptId` を v16-wide に）。

## 2026-10-28 追記 13: `wide` の比較候補 v18-wide（v16-wide の本文を契約 v4 で測る、#639）

追記 12 で v14-wide に戻した後、同日の ADR 0038 追記 15 で Finding の減りは契約 v5 に帰した。v16-wide は契約 v5 の下でしか走っていないので、所有者が 2026-10-26 に指示した文 1（ベンダーだけが置ける内容は攻撃者入力ではない。`strategy/sinks-v16`）を、それだけで測った記録は無い。2026-10-28 02:34〜04:21 の Codex v14-wide（契約 v4、同時 1 対象、`prod-20261027-14`〜`17`）は 12 Trial で Finding 12 件、Lead 27 件だったが、Finding 12 件のうち 9 件（wp-carousel-free 2、insert-php 1、login-customizer 4、koko-analytics 2）はベンダーだけが書く配信（pattern library、snippet library、Freemius API、ニュース feed）を攻撃者入力とする前提に乗っていた。段 1 の `wbh-screen` は 12 件のうち 11 件を提出不可にし、残る 1 件（wp-ulike、Subscriber の表示名）だけを Lab に回した。

- `wp2shell-bounty-v18-wide` を `wide` の `candidate` として足す。本文は v16-wide とバイト単位で同じ（同じ fragment、同じ digest `sha256:1ffb15f4f3f7ad6de70e330e10fd24c31513e41d250c8e0d6885b760a0a5c1f3`）で、契約だけが v4 である。契約節は Harness が生成する節なので、目的文の digest は変わらない（ADR 0019）。
- v16-wide の行を書き換えずに別の id にするのは、台帳の `configuration.promptVariant` で契約 v5 の v16-wide の Trial と分け、比較の分母に混ぜないためである。v16-wide は `archived`・契約 v5 のまま残す。
- `wide` の `current` は v14-wide のまま変えない。ADR 0038 追記 15 の 20 Codex Trial（契約 v4 の v14-wide）を先に満たし、その後に runner の `promptId` を v18-wide に替えて、同じ選定帯・同じ子の上限 8・同じ契約 v4 で 20 Codex Trial を回す。`campaign.json` と `examples/campaign-wide-20.json` は変えない。
- 比較候補の v15-wide は `candidate` のまま変えない（`sinks-v14` を使う）。`deep` の v11 も変えない。
- 測った数字: 上の 12 Trial の内訳（Finding 12 件のうちベンダー配信の前提が 9 件、`wbh-screen` で提出不可 11 件）。v18-wide の数字は #639 に書く。比べるのは、Trial あたりの scope 内 Finding、Finding が 1 件以上出た Trial の割合、Finding のうちベンダーだけが書く内容を前提にする割合、Trial あたりの Lead、Root の分と読んだ file 数。
- 消し方: v18-wide の行と `wp2shell-bounty-v18-wide.md` を消す（Trial が走った後なら `archived` にして残す）。採る版が決まったら、採る版を `current`、もう一方を `archived` にし、`candidate` の行を残さない（追記 8）。

## 2026-10-28 追記 14: v18-wide は採らず `archived` にする（#639、数字で決める）

追記 13 の計測が 2026-10-28 15:13 JST に 20 Codex Trial（`prod-20261028-4`〜`7`）に到達した。比較の分母は直前の v14-wide / 契約 v4 の 21 Codex Trial（`prod-20261027-14`〜`17`、`prod-20261028-1`〜`3`）。どちらも gpt-6-sol、maxChildren 8、Lab なし、契約 digest は同じ。

| 指標 | v14-wide / v4 | v18-wide / v4 |
| --- | --- | --- |
| Trial | 21 | 20 |
| Finding（群） | 16（9） | 4（2） |
| Finding が 1 件以上出た Trial | 7 / 21 | 2 / 20 |
| Finding / Trial | 0.76 | 0.20 |
| Lead / Trial | 3.0 | 4.5 |
| 子 / Trial | 6.0 | 6.8 |
| Root の分（中央値） | 5 | 8 |
| Root の filesRead（中央値） | 37 | 34 |
| ベンダーだけが書く内容を前提にする Finding | 13 / 16 | 0 / 4 |
| ベンダー由来でない Finding | 3 | 2〜4 |

文 1 はベンダー由来の Finding を出さなくしたが、Finding の総数を約 4 分の 1 にし、Lead を 1.5 倍にした。契約 v5 の下で v16-wide / v17-wide が見せた「Finding の代わりに Lead」の形と同じで、契約を v4 に戻しても起きるので、原因は文の方にある。ベンダー由来でない Finding の数は両者で差が付かない。ベンダー由来の Finding は段 1b の `wbh-source-check` が出口で落とせる（`prod-20261028-3` の 4 件は 4 件とも不成立）。

- `wp2shell-bounty-v18-wide` を `archived` にする。本文、fragment、digest、契約 v4 は変えない（20 Trial の照合用に残す）。`candidate` の行は残さない（追記 8）。
- `wide` の `current` は v14-wide のまま。比較候補の v15-wide は `candidate` のまま変えない。`deep` の v11 も変えない。
- 本番 runner の `promptId` / `promptVariant` は v14-wide に戻す（runner の操作は Codex。#639）。ベンダー由来の層は目的文ではなく段 1b で落とす。
- 測った数字: 上の表。採否の判断は所有者委任の AI が行った（ADR 0032 の 2026-10-18 節）。
- 消し方: v18-wide の行を `candidate`・`mode: "wide"` に戻し、campaign 設定の `promptId` で名指しする（追記 13 の手順）。

## 2026-10-31 追記 15: v18-wide を `candidate` に戻し、段 1 を通る Finding で測り直す（#639）

追記 14 で v18-wide を `archived` にした根拠は、Finding の総数（0.20 対 0.76 / Trial）だった。ベンダー由来の Finding は段 1b で落とせるので、目的文で絞る必要はないと読んだ。2026-10-31 の本番再開の数字は、この読みを支えない。

- 2026-10-28 の 20 Trial 計測（追記 14）: v18-wide は Finding 4 件（ベンダー feed 前提 0 / 4）、v14-wide は 16 件（13 / 16 がベンダー feed 前提）。ベンダー feed 以外の Finding は同数（2〜4 対 3）。Lead は 4.5 / Trial 対 3.0 / Trial。
- 2026-10-31 の本番再開（Codex 5 並列、v14-wide と探索スキル recon / tools）: 最初の 14 Trial で Finding 15 件、Lead 52 件。段 1（`wbh-screen` v5、ADR 0038 追記 16）は 15 件すべてを `external-not-writable`（ベンダーが供給する内容を攻撃者が置ける、という前提）で除外した。要検証は 0 件。
- 所有者は 2026-10-31 に、検証側は無人で Lab まで進め、人間は観測と提出だけを受け持つと決めた。段 1 で全件落ちる Finding を出し続けると、探索の計算資源と段 1 の手間を無駄に使う。比べるべきは Finding の総数ではなく、段 1 を通った Finding の数である。

決定:

- `wp2shell-bounty-v18-wide` を `wide` の `candidate`（`mode: "wide"`）に戻す。campaign 設定の `promptId` で名指ししたときだけ走る。
- `wide` の `current` は v14-wide のまま変えない。`src/profiles/wordpress/policy/campaign.json` と `examples/campaign-wide-20.json` も変えない。比較候補の v15-wide は `candidate` のまま、`deep` の v11 も変えない。
- 変えないもの: v18-wide の本文、fragment、digest（`sha256:1ffb15f4f3f7ad6de70e330e10fd24c31513e41d250c8e0d6885b760a0a5c1f3`）、契約 v4。v14-wide の行。追記 14 の 20 Trial の記録は消さず、照合に使い続ける。
- 測り方: 現行の v14-wide と探索スキルの腕が 20 Trial に達した後、runner の campaign 設定の `promptId`（selection 設定の `promptVariant`）を v18-wide に替え、同じ選定帯・同じ子の上限・同じ契約 v4・同じ探索スキルで 20 Trial を回す。台帳の `configuration.promptVariant` で分け、段 1 を通った Finding の数（Trial あたりと、1 件以上出た Trial の割合）と Lead / Trial で比べる。runner の操作は Codex が行う。採否はその数字で決め、採る版を `current`、もう一方を `archived` にして `candidate` の行を残さない（追記 8）。
- 測った数字: 上の 2 つ。採否の判断は所有者委任の AI が行う（ADR 0032 の 2026-10-18 節）。
- 消し方: v18-wide の行を `archived` に戻し、`mode` を外す（追記 14 の状態）。

## 2026-10-31 追記 16: `wide` の比較候補 v19-wide（停止条件を tools の一覧に結び付ける、#714）

wide の Trial は、Root が登録簿に「全 sink の対象エントリ群を消化」と書いた時点で閉じる（`coordination/stop-wide-v13`）。2026-10-31 の本番 30 Trial では、Root の分は中央値で約 16 分だった。子は 1 体あたり 2〜4 分で 15〜30 file を読み、PHP 230 file のプラグインで実際に開いた固有 file は 2 割程度だった。制限時間 120 分のうち 100 分以上が毎回使われていない。この形は 2026-10-26 の v14-wide から変わっていない（数字の出典は [2026-10-31 の構造調査](../reviews/2026-10-31-exploration-structure-investigation.md)、#714）。探索スキル `wbh-tools` が保存する hook 登録の一覧（`/workspace/research/tools/hooks.tsv`、同じプラグインで 169 行）は、終了の根拠に使われていない。終わり方を決めるのは停止文で、「消化した」は Root の自己申告のままである。

決定:

- `wp2shell-bounty-v19-wide` を `wide` の `candidate`（`mode: "wide"`）として足す。campaign 設定の `promptId` で名指ししたときだけ走る。本文は v18-wide とバイト単位で同じで、最後の fragment だけを `coordination/stop-wide-v13` から `coordination/stop-wide-v14` に替える。digest は `sha256:a8a73ba7ed5def43d6a0abd0a6f8ff9738ac9b2b84d1b7fa00cbeee06cb5e119`、契約は v4。
- `stop-wide-v14` は、登録簿に sink 種別ごとに「tools の一覧のうち読んだ行の数と残りの行の数」を書かせ、残りがある間は閉じないことを求める。制限時間に達したら従来どおり正常に閉じる。最後の 2 文（経過時間を作らない、候補 0 件も正常な終わり）は v13 のまま。制限時間と子の数は書かない（追記 4）。対象固有の名前も書かない。
- v19-wide を名指しする campaign 設定は、`discovery.skills` に `wbh-recon-v1` と `wbh-tools-v1` の両方を名指ししなければならない。（2026-11-01: `wbh-recon-v1` は archived になり、現行は `wbh-recon-v2`。ADR 0043 追記 3）
- Harness は変えない。制限時間と子の数の強制だけが Harness の仕事で、終了の判断はプロンプト側に置く（AGENTS.md「Harness と AI の責務」）。一覧の行数を Harness が数えて止めることもしない。
- 変えないもの: v18-wide の行、本文、digest。`wide` の `current`（v14-wide）、比較候補の v15-wide、`deep` の v11、`src/profiles/wordpress/policy/campaign.json`、`examples/campaign-wide-20.json`、`stop-wide-v13`、探索スキルの本文。
- 測り方: 本番の同じ選定帯で、v18-wide と v19-wide を交互に 20 Trial ずつ回す。子の上限、契約 v4、探索スキル（`wbh-recon` と `wbh-tools`）は両方で同じにする。台帳の `configuration.promptVariant` で分け、次の 4 つを並べる（DEVELOPMENT 第 5 節の 6 段）。
  - Root の分（中央値）
  - 固有 file 数 / プラグインの PHP file 数
  - 段 1 を通った Finding / Trial
  - Lead の 5 項目を通った数 / Trial
- 採否はこの 4 つの数字で決め、採る版を `current`、もう一方を `archived` にして `candidate` の行を残さない（追記 8）。
- 測った数字: 上の 30 Trial の構造だけ（[構造調査](../reviews/2026-10-31-exploration-structure-investigation.md)）。v19-wide の数字は 20 Trial の後に #714 に書く。採否の判断は所有者委任の AI が行う（ADR 0032 の 2026-10-18 節）。agent に渡る文章なので `owner-approved` が要る。
- 消し方: Trial が走る前なら、v19-wide の行、`wp2shell-bounty-v19-wide.md`、`sections/coordination/stop-wide-v14.md` を消す。走った後なら、v19-wide の行を `archived` にして `mode` を外し、本文と fragment は照合用に残す。

## 2026-11-01 追記 17: v19-wide の停止段落を分ける（#731）

追記 16 の `coordination/stop-wide-v14` は、登録簿の数え方の文と停止文を 1 つの段落に書いていた。Harness は目的文の最後の段落を再開の指示として読み、`wide` ではそれが「Stop when」で始まることを求める（`wordPressResumeParagraph`）。v19-wide の最後の段落は「Keep in the registry」で始まるため、v19-wide を名指しした Trial はすべて `Versioned minimum exploration directive is missing` で対象を skip していた（2026-11-01 の bench30 と prod-v19 の起動で判明。v19-wide の Trial は 0 件）。

- `stop-wide-v14` と `wp2shell-bounty-v19-wide.md` の同じ箇所に段落の区切りを 1 つ入れる。語は変えない。digest は `sha256:a8a73ba7ed5def43d6a0abd0a6f8ff9738ac9b2b84d1b7fa00cbeee06cb5e119` になる。Trial が 0 件なので版は上げない。
- 起動できる行（`current` と `candidate`）のすべてについて、最後の段落が mode の接頭辞で始まることをテストで守る。

消し方: この追記の PR を revert する。v19-wide は再び起動できなくなる。


## 2026-11-01 追記 18: `wide` の目的文を 1 file の v20-wide にし、スキルへの routing を書く（所有者決定、計測なし）

所有者は 2026-11-01 に「分割方式はいらない。常に読む 1 枚に目的を置き、長くなるなら WordPress 固有知識やスキルへの routing を書く」と決め、同日夜に「トライアルがもういらなさそうで、いったんすべてが完成して私のチェックを通してから探索」と、v19-wide の 20 Trial の計測を取りやめた（[開発計画](../reviews/2026-11-01-development-plan.md) §2.2）。これは ADR 0045 の「設計の変更は月 1 回」「言い換えの新版は出さない」「v19 の 20 Trial を分母の基準線にする」を所有者自身が改めた決定で、ADR 0045 追記 1 に記録する。

決定:

- `wp2shell-bounty-v20-wide` を `wide` の `current` にする。本文は 1 file（`prompts/wp2shell-bounty-v20-wide.md`）で、fragment から組まない。digest は `sha256:4674ab42d8e64b2349045ef6b3622363dcf409d3782db1dae2fdd7d0b7b3356b`、契約は v4。
- 本文は v19-wide の 10 段落をそのまま保ち（語を足さず、消さない）、登録簿の数え方の段落の直前に 1 段落を足す。足した段落は、Trial に置かれた探索スキル `wbh-recon`、`wbh-tools`、`wbh-setup` をいつ読むかと、それぞれが書く file（`/workspace/research/recon-map.md`、`/workspace/research/tools`、`/workspace/research/lab-setup.md`）を、各スキルの description にある語だけで述べる。「末尾に足す」と計画に書いたが、Harness は最後の段落を再開の指示として読み、`wide` では「Stop when」で始まることを求める（追記 17、#731）ので、停止段落の前に置く。
- v14-wide、v15-wide、v18-wide、v19-wide は `archived` にして `mode` を外す。比較せずに下ろす。本文と fragment と digest は過去 Trial の照合用に残す。`wide` の起動できる版は v20-wide だけになり、`candidate` の行は無くなる。
- fragment の仕組み（`fragments`、`composeFragments`、`sections/`、`sectionDigests`）は消さない。v11（`deep` の current）と archived の版がそれで組まれ、過去 Trial の `configuration.sectionDigests` の照合に要る。v20 以降の版は 1 file で持ち、`sectionDigests` を記録しない。
- `src/profiles/wordpress/policy/campaign.json` と `examples/campaign-wide-20.json` の `promptId` を v20-wide にする。v20-wide の campaign 設定は、`discovery.skills` に `wbh-recon-v2`、`wbh-tools-v1`、`wbh-setup-v1` を名指しする（Lab を付けない Trial では `wbh-setup` は条件が成立せず読まれない）。Harness は名指しを強制しない（ADR 0043 の置き方）。
- Harness の code は変えない。v19-wide の stale な 2 文（Harness 所有の判定器と nonce canary。ADR 0040 と食い違う）は、この決定が「文を消さない」なので残す。消す PR は別に立てる（ADR 0045 は消す方向の変更を許す）。

測った数字: 無し。所有者の決定で、比較の Trial を置かない。v20-wide の Trial は、所有者のチェックの後に本番で始め、ADR 0045 の分母（Codex 1 時間あたりの Lab 発火数と Wordfence の結果）で読む。agent に渡る文章なので `owner-approved` が要る（本文と日本語訳と出典対照表は [review 文書](../reviews/2026-11-01-wp2shell-bounty-v20-wide.md)）。

消し方: v20-wide の行と file を消し、v14-wide の行を `current`（`mode: "wide"`）に戻し、2 つの campaign 設定の `promptId` を戻す。走った後なら v20-wide の行を `archived` にして本文を照合用に残す。

## 2026-11-01 追記 19: v20-wide の stale な 2 文を消した v21-wide を `wide` の current にする（消すだけ、計測なし）

v20-wide（追記 18）は v19-wide の文を消さずに保ったので、1 段落目の末尾「Runtime confirmation belongs only to the later, independent Harness-owned deterministic judge, which must observe the corresponding nonce canary outcome in a fresh Lab.」と 8 段落目の末尾「Runtime confirmation is decided later by the independent Harness judge, not by the discovery agents.」が残っていた。2 文とも Harness 所有の判定器と nonce canary を名指しするが、判定器と canary は ADR 0040 で削除し、確定の根拠は人間の `review observe` と `review decide --reproduced match` だけである（不変条件 3）。所有者は 2026-11-01 の確認文書（[owner-check](../reviews/2026-11-01-owner-check.md) §5）の推奨「消すだけの新版を出す」に「すべて推奨で」と答えた。

決定:

- `wp2shell-bounty-v21-wide` を `wide` の `current` にする。本文は 1 file（`prompts/wp2shell-bounty-v21-wide.md`）で、v20-wide から上の 2 文を消しただけである。語は足していない。digest は `sha256:211c22a613c5440946944d4590c3bde27bfe8e8665fb755b4ae8e7623d4d1398`、契約は v4、12 段落。全文と日本語訳は [review 文書](../reviews/2026-11-01-wp2shell-bounty-v21-wide.md) にある。
- v20-wide は `archived` にして `mode` を外す。本番の Trial を 1 つも走らせる前に下ろした。本文と digest は登録簿に残す。
- `src/profiles/wordpress/policy/campaign.json` と `examples/campaign-wide-20.json` の `promptId` を v21-wide にする。campaign 設定の `discovery.skills` の名指しは v20-wide と同じである。
- ADR 0045 の凍結 5 の第 5 項「消す方向にしか触らない」の範囲内の変更であり、追記 1 の「AI はこの追記を根拠に次の新版を提案しない」に反しない。追記 1 は「言い換えの新版」を 1 回に限って許したもので、本追記は言い換えではなく削除である。
- Harness の code は変えない。

測った数字: 無し。所有者の決定で、比較の Trial を置かない。v21-wide の本番 Trial を ADR 0045 の分母で数え始める。agent に渡る文章なので `owner-approved` が要る。

消し方: v21-wide の行と file を消し、v20-wide の行を `current`（`mode: "wide"`）に戻し、2 つの campaign 設定の `promptId` を戻す。走った後なら v21-wide の行を `archived` にして本文を照合用に残す。

## 2026-11-01 追記 20: `deep` の既定の最低時間を 0 にする（#686）

- 所有者の問い（2026-10-30、#686）「最低時間はいらないかも。終了判断は AI に判定できる形にする？」と、所有者の言葉（2026-11-01 夜）「deep の最低時間（#686）ができないと探索が浅いまま」。
- 数字（#686、2026-10-30 時点の本番台帳）: 床 60 分の v8 deep は 272 run で 0.10 Finding / run、床で終わった 59〜61 分の run は 0.13。床の無い v14 wide は 186 run で 0.51、中央値 9 分。床は成果を作っていない。
- 決定: `WORDPRESS_DEFAULT_MINIMUM_ACTIVE_MINUTES` を `deep` も 0 にする。`discovery.minimumActiveMinutes`（0〜119）で床を置く道は残し、1 以上なら従来どおり同一セッションで続ける。終了の判断は `wbh-recon-v3` の手順 9（ADR 0043 追記 4）が持ち、Harness は wall と子の数の強制と、wall・読んだ file 数の記録だけを行う。
- 床の runner（`minimum-active-runner.ts`、再開段落）は消さない。床 1 以上の設定と、台帳にある床付きの過去 Trial の再開のために残す。消すのは、床を使う設定が無いことを数字で見てから。
- `deep` と `wide` の差は目的文だけになった。mode を 1 つに畳むかは別の問い。
- 消し方: 定数を `deep: 60` に戻し、SPEC 第 6 節と AGENTS.md の該当文を戻す。

## 2026-11-02 追記 21: v21-wide から行数で閉じる規則を消した v22-wide を `wide` の current にする（消すだけ、ADR 0049 決定 E）

v19-wide の追記 16 で入れた停止規則は、登録簿に sink 種ごとの `hooks.tsv` の読了行数と残り行数を保ち、行が残る間は閉じないというものだった。本番の v21-wide の Trial では、Root はこの規則を行を分類した時点で満たし、11〜47 分で閉じ、Lab の使用は 0〜3 回だった（ADR 0043 の 2026-11-01 の 10 Trial でも、どの登録簿も全行を「読了 / 残 0」と記録して中央値 16 分で閉じている）。行数は読んだ量ではなく分類した量を数えるので、早く閉じる癖を止めていない。所有者が 2026-11-02 に承認した [ADR 0049](0049-lab-resident-exploration.md) の決定 E は「目的文の手順段落の削除」を含む。終わってよいかの判断は、スキル `wbh-recon` v3 の手順 9（ADR 0043 追記 4）と Trial の wall に移っている。

決定:

- `wp2shell-bounty-v22-wide` を `wide` の `current` にする。本文は 1 file（`prompts/wp2shell-bounty-v22-wide.md`）で、v21-wide から次の 4 か所を消しただけである。語は足していない。digest は `sha256:678595d377ce7b238b82ad5201e57eed35c2a66b75dc10049b15df36615a4d7c`、契約は v4、11 段落。差分と日本語訳は [review 文書](../reviews/2026-11-02-objective-v22-wide.md) にある。
  1. 11 段落目の全体「Keep in the registry, for each sink class, how many rows of the hook listing at /workspace/research/tools/hooks.tsv its specialists have read and how many remain. Do not close while any sink class has rows remaining.」
  2. 10 段落目（スキルへの routing）の節「; the hook listing named below is the one it saves」。文は「/workspace/research/tools, and cross-checks them against the map.」で終わる。
  3. 最終段落の冒頭文のうち「no sink class has rows remaining, or when 」と「, whichever comes first」。冒頭文は「Stop when the Trial wall is reached.」になる。最終段落は引き続き「Stop when」で始まり、再開段落の規則（本 ADR の帰結、`src/cli/wordpress.ts` の `WORDPRESS_RESUME_PARAGRAPH_PREFIX`）を満たす。
  4. 最終段落の 3 文目の語「with those counts」（それらの数を含む）。1 で消した行数を指していた語で、文は「Reaching either bound is a normal ending: report the registry, every route that reached a sink with its exact remaining gap, and the rows and entry points left unread.」になる。「either bound」は残す。
- v21-wide は `archived` にして `mode` を外す。本番の Trial を走らせた版なので、本文と digest は登録簿に残し、台帳の `promptVariant` / `promptDigest` の照合にだけ使う。campaign 設定で `promptId: wp2shell-bounty-v21-wide` を名指すと、v15-wide などの旧版と同じく、設定の検査（`runnablePrompt` の enum）で拒否される。
- `src/profiles/wordpress/policy/campaign.json` と `examples/campaign-wide-20.json` の `promptId` を v22-wide にする。`discovery.skills` の名指しは変えない。
- ADR 0045 の凍結 5 の第 5 項「消す方向にしか触らない」の範囲内の変更である。11 月の設計変更としては ADR 0049 の 1 まとまりに入る。
- Harness の code は変えない。登録簿の行と設定 file の id だけを変える。

測った数字: 未計測。本番で v22-wide の Trial を v21-wide の Trial と並べる（[measurement.md](../agents/measurement.md) 5b）。削除のみなので bench は組まない。agent に渡る文章なので `owner-approved` が要る。

消し方: v22-wide の行と file を消し、v21-wide の行を `current`（`mode: "wide"`）に戻し、2 つの campaign 設定の `promptId` を戻す。走った後なら v22-wide の行を `archived` にして本文を照合用に残す。

## 2026-11-02 追記 22: 本番の wide に最低時間を置く案を検討し、置かなかった

- 事実（本番 2026-11-02、Lab 付き・スキル 3 本・v21-wide の 26 Trial）: Root の時間は中央値 18 分（0〜47 分、wall は 120 分）。子は 1 Trial に 13〜19 体で 1 体 3 分。Lab への要求は Trial あたり 6〜7 回、Find / Query / Trace は中央値 0 回（最多 3）、Observe は 1〜2 回。Finding 0、Lead 167。v21 の行数で閉じる規則は全 Trial が残 0 と書いて満たしていた。
- 検討した案（AI、2026-11-02 夜）: 終了条件を文で与えると Root はそれを満たしたと書いて閉じるので、Harness が握る「制限時間」で wide に `discovery.minimumActiveMinutes: 90` の床を置く。所有者はいったん「あなたの案で行きます」と答えた後、「SQLi と XSS は見つけられていたのだから、最低時間は問題ではないのでは」と問い直した。
- 確認した数字: 同じ v21-wide で構成だけが違う Trial を並べると、Lab 無し・recon-v2 の 20 Trial は Root 15 分で F 8 / L 68、Lab 無し・recon-v3 の 8 Trial は Root 31 分で F 2 / L 60、Lab 付き・recon-v3 の 19 Trial は Root 28〜31 分で F 0 / L 190。Root の時間が 2 倍になっても F は増えず Lead が増えた。直接 sink 型の Finding は短い Trial で出ている（v14 wide 中央値 9 分で 0.51 / run、bench h30 で既知 114 記録中 69）。Lab は使われておらず（要求 7、lookups 0、setup の記録 4 行）、Root の時間を食ってはいない。対象の大きさ（hooks.tsv の行数 154 → 245〜275）が混ざっている。
- 決定: 床は置かない。床は 1 対象あたりの時間を 18 分 → 90 分にして広さを 4〜5 分の 1 にする取引であり、深さが報酬になる証拠が無い（ADR 0045 の広さの方針、所有者の記録 32 件の 58% が SQLi と格納型 XSS）。深さは第 2 Trial（ADR 0049 決定 C）で Lead の残った対象にだけ足す。床を置くなら第 2 Trial だけに置く案を、転換率（leads2 の 4 / 14）を見てから判断する。
- 次に確かめること: recon-v3 の手順 9（閉じる手順）が Finding を Lead に変えていないかを、同じ対象で recon-v2 と v3 を交互に回して見る（変えるのは recon の版だけ）。今日の Lead の欠けた辺は 86% が producer で、`wbh-lab-v1`（ADR 0043 追記 7）の Find がちょうどそこに当たる。
- 既定（wide 0、deep 0）、wall 120 分、コード、目的文は変えていない。
