# 検証から提出までの流れ: 自動実行を基本にし、人間の確認を軽くする（2026-10-26）

調べて報告の成果物で、正本ではない（正本は [SPEC](../SPEC.md) と [ADR](../adr/)）。所有者の問い（2026-10-26）は次のとおり。「検証回りもちょっとフローは考えたい。自動実行を基本にしつつ、結果に偽りがないかどうやって楽に確認するか。今の発見速度に提出速度が追い付いてない。」

事実（第 A・B 節）、選択肢（第 C・D 節）、推奨（第 E 節）、未確認の仮定（第 F 節）を分けて書く。Finding の本文、経路、payload は書かない。

- リポジトリ: origin/main `231bda6`（#580 の後）。不変条件は ADR 0040 で改めた後の AGENTS.md を基準にする。
- 台帳: 本番 `ledger.sqlite` を scratchpad に複写して、読み取り専用で読んだ。最後の event は 2026-10-26T10:31Z。
- 集計の範囲: 2026-10-19T00:00Z 以後に記録された scope 内の Finding（`finding-recorded`）。本番の campaign（`prod*`、`opus-prod*`）と、本番の対象で v14-wide を回した campaign（`rr14-*`、`rerun-v14-*`）を合わせた。監査の報告（[2026-10-26-system-audit.md](2026-10-26-system-audit.md)）は `prod*` だけを数えているので、件数が少し違う。

## A. 現状の流れと数字

### A.1 段ごとの件数（2026-10-19 以後）

| 段 | 誰が回すか | 件数 | 滞留 |
| --- | --- | --- | --- |
| Finding（scope 内） | 探索 | 227 件（本番 151、本番対象での v14-wide 76）。group は 115。impact は stored-xss 193、privesc-to-admin 7、lfi 7、php-file-write 5、account-takeover 4、arbitrary-file-read 4、sqli 3、ほか 4 | — |
| 段 1 screen | AI（skill） | 台帳には記録が無い。結果は Git 外の報告にだけある | 数えられない |
| 段 3 検証 | 自動（〜10-21）と handoff | 検証まで進んだ Finding は 78 件（試行 159 回）。うち自動の `verifier-v8` が 88 回、handoff が 71 回（31 件） | **未検証 149 件（37 group、27 campaign）**。v14-wide の 76 件は 1 件も検証していない |
| 検証の結果（最新） | — | `incomplete(precondition)` 46、`runtime-confirmed` 13（通算 15、すべて handoff）、`incomplete(provider)` 8、`incomplete(observation)` 5、`incomplete(recipe)` 4、`incomplete(evidence)` 2 | `awaiting-human-observation` は 0 件。最後の検証は 10-25T17:05Z で、#541（判定器の削除）の merge の後は検証が 1 回も走っていない |
| review decide | AI と人間 | 判断のある Finding は 24 件（最新が accept 1、reject 12、defer 11） | `runtime-confirmed` 15 件のうち 10 件は判断が無い |
| review scope | AI | `scope-assessed` 38 件。**すべて `ambiguous`**（Wordfence 19、Patchstack 19） | #578 が直るまで、どの Finding も `in-scope` にならない |
| 人間の観測と再現 | 人間 | `manual-observation-lab-ready` 1（10-24）。`manual-observation-recorded` 0、`human-reproduction-recorded` 0 | — |
| 文案、承認、提出、転帰 | AI → 人間 | `draft-saved`、`submission-*` はすべて 0 | — |

台帳の外では、所有者が 10-25 に対話型のセッションで 1 件を提出した（[2026-10-25-post-discovery-skill-flow-review.md](2026-10-25-post-discovery-skill-flow-review.md) の「観測した事実」）。この件は台帳に `submission-recorded` を持たない（監査の第 E 節 13 行と同じ指摘）。

### A.2 1 件あたりの時間

- **AI の検証。** handoff の Lab が ready になってから `verification-finished` までの時間は、10-19 以後の 83 回で中央値 3.5 分（四分位 1.7〜7.5 分）。判定器が確認した 21 回の中央値は 7.2 分だった。供給は 1 台 18〜20 秒、4 台同時でも 22 秒（PR #546 の実機測定）。
- **AI の処理量の実績。** 一番多かった 10-23 は、14 時間（03:17〜17:13Z）に 32 回だった。1 host 1 枠の直列で、Opus の操作役が回した。約 2.3 回/時である。
- **人間の時間は、ほぼ測れていない。** `human-effort-recorded` は 72 件で、すべて `read`、合計 26 分（10-22〜10-25）。`review-decided` の `humanElapsedSeconds` は 28 件で、27 件が 0、1 件が 600 秒だった。再現（`reproduce`）、提出（`submit`）の記録は 0 件である。
- **運用文書の見積り。** 1 件あたり「reverify 30 分、手での再現 40 分、skill 30 分」で、1 回の batch は 3 件まで（[OPERATIONS](../OPERATIONS.md) 191 行）。人間の分は手での再現 40 分に、文案の査読とフォーム入力が加わる。

### A.3 どこで人の手が要るか（現行の規則）

[OPERATIONS](../OPERATIONS.md) 第 3 節の表（178〜189 行）で、所有者の行は 6〜8 の 3 つである。

1. `lab up --for-review` で新しい review Lab を立て、自分で手順を試し、`review observe` と `review decide --reproduced` を記録する（6 行目）。
2. 暫定文案を査読し、`review draft --prepared-by human` で最終版を保存し、`review decide --decision accept` を記録する（7 行目）。
3. `review authorize` を記録し、拡張機能でフォームに入力して送信し、`review submitted` と `review outcome` を打つ（8 行目）。

ほかに、表に無い人の手が 2 つある。1 つは、検証の操作役（Codex）を所有者が自分の Codex アプリで起動していること（所有者決定 2026-10-26「診断は Codex メイン」）。もう 1 つは、`wbh-submit` が原因グループごとに、前提について人間と議論し、進めるかどうかを尋ねる作りになっていること（[wbh-submit](../../.claude/skills/wbh-submit/SKILL.md) 20・23 行）。

## B. 無人で回せる段と、回せない段

### B.1 規則から見た線

不変条件 6 が置く人間の判断点は「提出前のレビュー」と「外部行動の承認」の 2 つだけである。ADR 0038 の追記 10 は、人間の手動再現を「提出前のレビュー」に含めた。ADR 0040 は、確定の根拠を「名指しした人間が新しい review Lab で記録した `review observe` の match と `review decide --reproduced match`」に限った。AI が打った観測は根拠にしない。したがって、無人にできないのは次の 5 つで、ほかはすべて AI 操作役が無人で回してよい。

| 人間に残るもの | 根拠 |
| --- | --- |
| review Lab での観測と `review observe` | 不変条件 3、ADR 0040。CLI も `--by ai` などを拒む（`src/review/manual-observation.ts:250-252`） |
| `review decide --reproduced` | 同上（`src/review/index.ts:106-111`） |
| 最終版の文案（`--prepared-by human`）と最終の `accept` | ADR 0038 の追記 4、OPERATIONS 215 行 |
| `review authorize` | 不変条件 7 |
| フォームへの送信 | 不変条件 7（Harness は送信しない） |

### B.2 段ごとの無人化の可否と障害

| 段 | 無人で回せるか | 障害（file:line） |
| --- | --- | --- |
| 段 1 screen | 回せる | 結果が台帳に残らないので、件数も滞留も数えられない（`.claude/skills/wbh-screen/SKILL.md:29`「このスキルは台帳を変更しない」）。同じ skill の 37 行は、もう無い判定器を前提にしている |
| 段 2 group | 回せる（Harness） | 10-26 より前の Finding 78 件には `group.id` が無い（監査の第 G 節） |
| 段 3 検証 | 回せる。ただし操作役の起動が人手 | (a) 主経路の Codex は、所有者が自分のアプリで起動している。headless の `codex exec` は所有者の求めがあるときだけ、という運用になっている。(b) Claude 系の操作役は、攻撃者の段で自動の安全分類器に止められたことがある（#425 の 2026-10-21 のコメント）。(c) `verify next --handoff` は `setup-done` を最大 30 分待つ前景のプロセスである（`docs/OPERATIONS.md:137`）。(d) 単一枠は #546 で外れたが、runner を新しい checkout で起動し直すのが並列の前提になっている（`docs/OPERATIONS.md:138`）。(e) 外部サービスとの接続、古い版から更新した跡、WordPress.org に無い有料の本体プラグインを要する前提は、Lab で作れない（ADR 0038 の追記 2、#467）。(f) `set-file` を skill がまだ案内していない（`.claude/skills/wbh-verify/SKILL.md:19`、#576） |
| 段 4 dedupe | 回せる | skill 本文は「記録は所有者が打つ」のまま（`.claude/skills/wbh-dedupe/SKILL.md:3,40`）。ADR 0038 の追記 4 は、AI が `--by ai` で打つ運用に変えた。mirror が古いと `unavailable` で止まる（同 23 行） |
| review scope | **今は回らない** | `defaultOrCommonSettings` を、#353 で消したシナリオの Lab からしか取れない（`src/profiles/wordpress/scope-facts.ts:143-153`、`scope-policy.ts:157-162`）。本番の 38 件はすべて `ambiguous` で、`review draft` に進めない（#578） |
| 段 5 destination | 回せる | 同じ Finding にメモがあれば、所有者の判断を待って止まる（`.claude/skills/wbh-destination/SKILL.md:52`）。131 行の「所有者が `review scope` を打つ」は、今は AI が打つ運用である |
| 段 6 暫定文案 | 根拠が揃えば回せる | 登録する暫定版は、`runtime-confirmed` か人間の `match` が要る（`.claude/skills/wbh-report/SKILL.md:31`）。それより前は、内部プレビュー（236〜243 行）だけを作れる |
| 人間の観測 | 人間 | `lab up --for-review` は前景で待つプロセスで、人間には Lab のネットワーク上の `docker run -it` のシェルが渡される（`src/cli/index.ts:729-790`、775〜778 行）。review Lab の接続先は内部の `http://wordpress` で（`src/profiles/wordpress/lab/index.ts:253`）、host のブラウザからは開けない。stored XSS（Finding の 85%）を自分の目で見るのに、GUI のブラウザが無い |
| 提出の記録 | 人間 | `review submitted` と `review outcome` は、端末で分数を尋ねる。分数を渡すフラグは無い（`src/cli/index.ts:1747-1748, 1791`） |

`wbh-review` の本文にも「`review decide` は所有者が打つ」が残っている（`.claude/skills/wbh-review/SKILL.md:37,43`）。運用（OPERATIONS 第 3 節の 0〜5 行目）とは食い違っている。無人で回すと、この文の通りに AI が止まる。

`docs/agents/production-monitoring.md` の観測項目（38〜44 行）は、探索側の 5 項目だけで、検証の列の滞留を見る項目が無い。

## C. 「結果に偽りがないか」を楽に確かめる方法

### C.1 偽りが入りうる経路

人間が見るものを、Harness が捕捉した事実に限るという前提に立つと、偽陽性が入る経路は次の 6 つである。agent の自己申告（`steps.md`、`agent-authored` の `http.json`）は、すでに根拠から外してある（SPEC 第 7 節、`wbh-report` 21 行）。

1. **前提作りの間に置いた値。** 管理者の資格は `setup-done` まで使える。HTTP の捕捉は `setup-done` の後に始まる。そのため、前提作りの間に保存した script が後で発火しても、捕捉の上では区別できない。Harness はこれを `requiresHumanPreexistingContentCheck: true` として記録している（`src/profiles/wordpress/verification/verifier-record.ts:67`）。
2. **被害者が攻撃者自身。** self-XSS の形。Lab browser の記録に `victimPrincipal: self|separate` がある（同 59 行）。
3. **通常の構成ではない。** Lab で作った前提が、公開サイトでは普通は使わない設定である。これは事実の捕捉では決まらず、人間の判断になる。
4. **版が違う。** 探索した版で成立しても、最新版では直っている。
5. **意図された動作。** 管理者だけが使う機能、`unfiltered_html` を持つ役割の操作など。
6. **dialog の取り違え。** marker と違う dialog、別 origin の frame での発火など。記録は marker、top-level の origin、frame の URL を持つ（同 41〜51 行）。

### C.2 選択肢

「人の時間」は 1 件あたりの推定である（第 F 節）。

| 案 | 中身 | 人の時間 | Harness に足す code | 不変条件との整合 | 偽陽性を見逃す経路 |
| --- | --- | --- | --- | --- | --- |
| (1) 1 画面の確認票 | `review export --version 2` の事実だけを、決まった順に 1 画面に並べる: Snapshot と版、攻撃者の位置と account、捕捉した攻撃要求の method と path、marker の一致と順序、被害者の role と `self/separate`、dialog の origin、Lab 状態の差分、画面、未確認の点。`wbh-review` の出力 1（35 行）を確認票の形に改める | 読むのに 2〜3 分 | 0（skill の版を上げるだけ） | 合う。確認票は確定の根拠にならず、観測の前の下読みにとどまる | 3、5 は事実の欄に出ない。1 は「未確認」と出るだけ |
| (2) 動画と画面の自動添付 | handoff を常に `WBH_RECORD_VIDEO=1` で走らせる。訪問ごとの WebM と、dialog を閉じた後の画面が Private Evidence に残る（`docs/OPERATIONS.md:140`、#549） | 動画を見るのに 1〜2 分 | 0（環境変数を設定するだけ） | 合う。動画は観測の補助で、確定ではない（ADR 0040） | 1（動画には発火しか写らない）。3、5 |
| (3) 別の操作役による 2 回目の独立再現 | 別のモデル（Codex と Opus など）が、新しい Lab と新しい marker で同じ Finding をもう一度通す。両方に marker の一致した dialog があれば、人間の列で先に並べる | 0（AI の時間と token が 2 倍） | 0（`verify next --finding` を 2 回呼ぶ）。一致を読む集計は skill で書ける | 合う。一致は列の順番を決める合図に使い、確定の根拠にはしない（不変条件 3） | 1 は、2 回とも前提作りで同じ値を置けば残る。3、5 は両方が同じ Finding の主張を信じるので残る。Claude 側は攻撃者の段で止まる危険がある |
| (4) 提出前チェックリストの自動生成 | `wbh-report` の「書く前の確認」（29〜39 行）と Wordfence の除外行（58〜81 行）を、Finding ごとの Yes/No/未確認の表にして、確認票の下に付ける。「未確認」の行だけを人間が見る | 査読が 5〜10 分短くなる | 0（skill の版を上げるだけ） | 合う。表の値は Harness の事実か公開資料から取り、agent の申告で埋めない | 表の外にある前提。表を読み飛ばすこと |
| (5) 基線に marker が無いことの記録 | `setup-done` の時点の DB と uploads の写しを Private Evidence に置き、検証の後で marker の文字列がそこに無いことを事実として記録する | 経路 1 の確認（約 5 分）が要らなくなる | 中（Lab 状態の取得に写しと検索を足す。100〜200 行と test） | 合う。ただし事実の記録で、成立の判定ではない。判定器を戻すものではないが、所有者の「判定や canary の論理を足さない」（10-25）に近いので判断が要る | 符号化した marker（base64 など）。DB と uploads の外に置いた値 |
| (6) review Lab を host のブラウザで開けるようにする | handoff の Lab と同じ `exposeToHost` を `lab up --for-review` にも使い、`127.0.0.1:<port>` と Host header を表示する。人間は、AI が用意した 1 本のコマンド（捕捉した攻撃要求そのもの）を自分で打ち、自分のブラウザで被害者の画面を開いて alert を見る | 観測が 40 分（運用の見積り）から 5〜10 分に | 小（既存の `exposeToHost` と `withdrawFromHost` を review Lab の経路から呼ぶ。50〜100 行と test） | 合う。新しい review Lab で人間が自分の目で見て記録するので、ADR 0040 の根拠の形を変えない | 1 は、前提作りを AI がやり直さない限り review Lab には入らない。review Lab は package から作り直すので、人間が見るのは清潔な Lab である |

(6) は、経路 1 の偽陽性も消す。review Lab は検証の package（Snapshot、Lab Setup、route）から新しく作られ、前提作りの間の操作はそこに入らない。したがって、そこで人間が攻撃者の要求だけを送って alert を見れば、その発火は攻撃者の要求から来たものである。ただし、前提（設定）を作る手順も人間が review Lab で踏むことになる。その手順は `steps.md` から AI が書き起こせる。

## D. 提出速度を発見速度に追い付かせる

### D.1 どれだけ追い付けばよいか

- 発見の速度は、10-19〜10-26 の 8 日で Finding 227 件、group 115 である（約 14 group/日）。v14-wide は 10-26 の 1.3 時間で、15 対象から 76 件（22 group）を出した。
- handoff に渡した Finding のうち、判定器が確認したのは 31 件中 15 件（48%）だった。この率を当てると、人間の列に届くのは約 7 group/日になる。
- 所有者の目標は月 USD 1,000 以上で、過去の Wordfence の実績は 21 件の提出で 18 件が支払われ、合計 USD 4,076 だった（1 件あたり約 USD 226）。この比率なら、目標には**月に約 6 件の提出**で届く。
- つまり、全件に追い付く必要はない。毎日、列の上から 1〜3 件を提出まで通せば、目標を十分に超える。追い付かない分は「低い順に古びていく」と割り切り、順番の付け方の方が効く。

### D.2 列の順番の付け方（AI が付ける。除外はしない）

段 1 は除外を明示除外に限るので（ADR 0038 の追記 6）、ここで付けるのは順番だけである。上から順に比べる。

1. **人間の確認にすぐ回せるか。** Harness の捕捉と、marker の一致した dialog（`separate` の被害者）が既にある。今これに当たるのは、判断の無い `runtime-confirmed` 10 件と `incomplete(observation)` 5 件である。
2. **Wordfence の閾値を満たすか。** stored XSS と SQLi は有効インストール 500 以上、High Threat の 6 種は 25 以上（`wbh-report` 55 行）。export の `target.activeInstallations` で比べる。
3. **前提の軽さ。** `preconditionClass` が `common-usage` のもの（未検証 149 件中 81 件）を、`unknown`（66 件）より先にする。
4. **影響の種類。** stored XSS 以外（rce、php-file-write、sqli、privesc-to-admin、ファイルの読み取りなど。未検証に 24 件）を stored XSS より先にする。
5. **重複の先例。** 同じ slug の直近の公開が、Snapshot の版を含むか 1 つ下で終わるものは後ろに回す。mirror の件数は段 1 の除外には使わず（追記 6）、順番にだけ使う。
6. **group の代表。** 同じ group は代表 1 件だけを先に通す。

### D.3 検証の並列化

- #546 で検証 Lab の台数制限が無くなった。1 台は待機時に約 380 MiB で、host の memory（約 47 GB）は上限にならない。上限になるのは、操作役の同時数と provider の制限である。
- Codex の同時数を 3〜5 とし、1 件を 10〜15 分（Lab の供給、前提作り、攻撃、片付け）とみると、AI の検証は 12〜30 件/時になる。1 日 2 時間回せば、未検証の 37 group の代表は 1 日で通せる。
- 並列にする前に、runner を新しい checkout で起動し直す（`docs/OPERATIONS.md:138`）。

### D.4 人間の確認を batch にする

- 1 日 1 回、決まった時間に、AI が上位 3 件の確認票、動画、チェックリスト、暫定文案のプレビューを揃えておく。人間は 3 件を続けて見る。
- review Lab は、AI が 3 台を先に立てておく（台数制限は無い）。人間は表示された URL を順に開く。
- 1 件ごとの判断は、「観測 match / mismatch / unavailable」と「進める / 止める」の 2 つだけにする。前提の議論が要る Finding（`wbh-submit` 20 行の型）は、その日の batch から外し、週 1 回の議論の枠に回す。

### D.5 推定の処理能力

| 段 | 現状 | 推奨の後（推定） |
| --- | --- | --- |
| 発見 | 約 14 group/日 | 変えない |
| 段 1 screen | AI。台帳に残らない | AI。毎日全件。順番付きの表を Private Evidence に置く |
| 検証（AI） | 1 枠の直列。最多の日で 32 回/14 時間。10-25 以後は 0 | Codex 3〜5 並列で、上位の group 代表を毎日 15〜25 件 |
| 人間の観測 | 0 件（運用の見積りは 1 件 40 分） | 1 件 5〜10 分 |
| 人間の査読と送信 | 0 件 | 1 件 10〜15 分 |
| 提出 | 台帳で 0 件、台帳の外で 1 件 | **1 日 2 件**（人の時間で 30〜50 分）から始め、1 週間測ってから 3 件に上げる |

1 日 2 件を 20 日続けると、月に 40 件になる。目標の 6 件に対して大きな余裕がある。そのぶん、順番の上位だけを出すことで、Wordfence の受理率を保つ方に使える。

## E. 推奨する流れ

### E.1 1 つの流れ

毎日、次の順で回す。1〜5 は AI 操作役が無人で回し、6〜8 だけを人間が行う。

1. **列を作る（AI、毎朝）。** 新しい Finding に `wbh-screen` v4 を当てる。明示除外を分け、残りに第 D.2 節の順番を付けた表を Private Evidence に置く。
2. **上位を検証する（AI）。** 上位の group 代表を `verify next --handoff` で 3〜5 並列に通す。`WBH_RECORD_VIDEO=1` を常に付ける（案 (2)）。結果は `incomplete(awaiting-human-observation)` か、理由付きの `incomplete` になる。
3. **ふるいにかける（AI）。** marker の一致した dialog が `separate` の被害者で記録された Finding だけを、人間の列に送る。それ以外は理由を残し、次の手（前提の不足、操作役の失敗）に回す。成立しなかったものを `reject` にはしない（不変条件 4）。
4. **事務を済ませる（AI）。** 人間の列の Finding に、最新版の確認（`review reverify`）、`wbh-dedupe`、`wbh-destination`、`wbh-report` の内部プレビューを先に済ませる。`possible-match` のものは列から外す。
5. **確認票を作る（AI）。** 上位 2〜3 件に、確認票（案 (1)）とチェックリスト（案 (4)）を作り、review Lab を立てておく。
6. **観測する（人間、1 件 5〜10 分）。** 確認票を読み、AI が用意した攻撃者の要求 1 本を自分で送り、自分のブラウザで被害者の画面を開いて alert を見る（案 (6)）。`review observe` と `review decide --reproduced` を打つ。
7. **査読する（人間、1 件 10〜15 分）。** `match` になった Finding で、AI が登録する暫定版を作る。人間はチェックリストの「未確認」の行と文案を見て、最終版を保存し、`accept` と `authorize` を打つ。
8. **送る（人間）。** 拡張機能で送信し、`review submitted` を打つ。

この流れのために要る変更は、#578（人間の `match` から scope の事実を取る）、案 (6) の review Lab の host 公開、skill 本文の改訂（`wbh-review` の確認票、`wbh-dedupe` と `wbh-review` の「所有者が打つ」、`wbh-screen` 37 行の判定器の文）、`production-monitoring.md` に検証の列の滞留を足すことである。#578 が無いと、7 の `review draft` で止まる。skill 本文は agent に渡る文章なので、`owner-approved` のラベルと出典対照表が要る。

最初の 1 週間は、すでに捕捉のある 15 件（判断の無い `runtime-confirmed` 10 件と `incomplete(observation)` 5 件）から上位を取る。新しい検証を待たずに、6 以降を試せる。

### E.2 所有者の判断が要る点

1. **人間の観測をどこまで軽くしてよいか。** 案 (6) の「AI が用意した要求 1 本を人間が送り、人間のブラウザで被害者の画面を見る」で、`review observe match` にしてよいか。前提の設定を作る手順まで人間が踏むか、それも AI が用意した手順を人間がなぞればよいか。
2. **検証の操作役を無人で起動してよいか。** Codex を headless の `codex exec` で、所有者のアプリを通さずに並列で回してよいか。だめなら、AI の検証は所有者がアプリを開いている時間に限られる。
3. **1 日の提出目標と列の上限。** 1 日 2 件から始めるか。人間の列が何日分を超えたら、探索を絞るか（監査の第 F.2 節 3 と同じ問い）。
4. **案 (5)（基線に marker が無いことの記録）を入れるか。** 判定はしない事実の記録だが、10-25 の「判定や canary の論理を足さない」に近い。(6) を採るなら要らない。
5. **案 (3)（2 回目の独立再現）に token を使うか。** 順番の合図にしか使えず、確定には使えない。
6. **列の順番に mirror の先例を使ってよいか。** ADR 0038 の追記 6 は、段 1 の除外に先例の件数を使うことを禁じた。順番に使うことは禁じていないが、同じ趣旨で避けるべきかを決める。

## F. 未確認の仮定

- 人間の時間（観測 5〜10 分、査読 10〜15 分）は推定で、測った値ではない。台帳の人間の時間は、ほぼ 0 か未記録である（第 A.2 節）。最初の 1 週間で `--reproduce-minutes` と `--minutes` を必ず付けて測る。
- 判定器の確認率 48%（15/31）を、人間の列に届く率として使った。handoff に渡したのは代表を選んだものなので、全体の率はこれより低いとみる。判定器が無くなった後の、marker の一致した dialog の率はまだ 0 回で、測れていない。
- 1 件あたり USD 226 と受理率 18/21 は、以前の harness の時期の Wordfence の実績である。AI が見つけた Finding で同じになるとは限らない。
- Codex の同時数 3〜5 と、1 件 10〜15 分は推定である。provider の制限で下がりうる。
- 案 (6) の host 公開は、WSL2 の loopback から Windows のブラウザで開ける前提に立つ。この host では確かめていない。
- review Lab が前提作りの操作を含まないこと（第 C.2 節の最後の段落）は、`openWordPressReviewLab` が package の Lab Setup から作り直すことから読んだ（`src/profiles/wordpress/lab/review-lab.ts:31-70`）。前提の設定が Lab Setup の側に入っているかどうかは、Finding ごとに違いうる。
- 10-25 に所有者が提出した 1 件は、文書からの事実で、台帳では確かめられない。
- 段 1 の結果は台帳に無いので、明示除外で何件落ちたかは数えていない。Git 外の報告は読んでいない。
- `group.id` の無い古い Finding は、1 件を 1 group として数えた。group の数は多めに出ている。

## 出典と問い合わせ

- 台帳: `finding-recorded`（2026-10-19 以後、`campaign_id` が `prod`、`opus-prod`、`rr14-`、`rerun-v14-` で始まるもの、`findingId` で重複を除いた）に、`verification-finished`（`promptVersion` が `verifier-v8` なら自動、`wbh-verify/*` なら handoff）、`review-decided`（Finding ごとの最新）、`scope-assessed`、`manual-observation-*`、`human-*`、`draft-saved`、`submission-*` を結んだ。handoff の所要時間は、`lab-provisioned`（`purpose: verification`、identity の verificationId）から `verification-finished` までの差である。
- 文書: AGENTS.md の不変条件 3〜7 と「Harness と AI の責務」、SPEC 第 7 節、ADR 0035（追記すべて）、ADR 0038（追記 1〜11）、ADR 0040、[監査の報告](2026-10-26-system-audit.md) の第 B.4・E・F 節、[探索後の skill の整理](2026-10-25-post-discovery-skill-flow-review.md)、[対話型の提出セッション](2026-10-25-conversational-submission-session.md)、`docs/OPERATIONS.md` 第 3 節、`docs/agents/production-monitoring.md`、6 つの skill の SKILL.md。
- Issue と PR: #441（6 段の親）、#425（handoff の運用記録）、#576（`set-file`）、#578（scope の basis）、PR #546（検証 Lab の単一枠の削除）。
