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
- 目的文・Snapshot・runtime profile・Lab 予算が違えば拒否する規則（`prompt-version-differs` など）は変えない。
- 消し方: この節と #548 の差分を戻す。再開はまた今の設定から組み直す。

## 2026-10-26 追記 7: 本番の既定を `wide` にする（所有者決定）

「帰結」の「本番の `src/profiles/wordpress/policy/campaign.json` は `deep` のまま」を改める。所有者は 2026-10-26 に、本番の既定を `wide` の `wp2shell-bounty-v14-wide` にすると決めた（ADR 0032 の 2026-10-26 追記 4、[監査](../reviews/2026-10-26-system-audit.md) 第 C.3 節と第 F.2 節）。

- `campaign.json` は `discovery.mode: "wide"` と `promptId: "wp2shell-bounty-v14-wide"` にし、ほかの値（wall 120 分、`lab: none`、同時対象 1、Programme Boundary、WordPress の版）は変えない。最低時間は `wide` の既定の 0 になる。
- `deep` の `wp2shell-bounty-v11` は名指しの Trial でだけ使う。campaign 設定の `discovery.mode` を `deep` にして回す。`discovery.mode` を省いたときの schema の既定は `deep` のままにする。
- 選定方針の `promptVariant`（v11）は変えない。どちらの mode の現行 id でもよい（「決定」の節）。
- 消し方: `campaign.json` の 2 つの値を `deep` と v11 に戻し、この節を消す。
