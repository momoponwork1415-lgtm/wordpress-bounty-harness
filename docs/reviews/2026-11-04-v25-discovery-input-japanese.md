# v25-wide 探索入力の日本語訳と読書順

Issue #812。ここには、新規の `wp2shell-bounty-v25-wide` Trial で repository が管理する agent 向け文章の日本語訳を、実際の入力順に集める。英語原文と digest が実行時の正本であり、この訳文は agent に渡さない。`<...>` は Trial ごとに Harness が埋める値であり、URL、資格情報、未公開の候補をこの文書に書かない。

Codex CLI と provider が内部で持つ system prompt、Root が実行中に書く子への割当文、固定ソースそのものは repository に版付きの全文がないため、この文書の翻訳対象ではない。子へ渡すべき契約は後述の v6 契約に含まれる。停止した Trial の再開では固定の再開段落と新しい Lab 情報を渡し、残り時間は Harness が実行上限として強制する。

## 1. Root 入力の順序と、既存の全文訳

[組立コード](../../src/cli/wordpress.ts) は次の順で Root の stdin を作る。スキル本文はここへ連結されず、sandbox の CLI home に配置される。

| 順序 | 英語原文 | 日本語訳 |
| --- | --- | --- |
| 1 目的文 | [`wp2shell-bounty-v25-wide.md`](../../src/profiles/wordpress/prompts/experimental/wp2shell-bounty-v25-wide.md) | [v25 目的文の全文訳](2026-11-04-cloudflare-audit-objective-v25.md#L19) |
| 2 Finding / Lead / check の出力契約 v6 | [`output-contract.ts`](../../src/profiles/wordpress/discovery/output-contract.ts) の `wordPressDiscoveryOutputContractV6` | [契約全文と schema の訳](2026-11-04-cloudflare-audit-gate-v2.md#L443)。field 名と enum は英語のまま使う |
| 3 実行値 | [`run-parameters.ts`](../../src/discovery/run-parameters.ts) | 下の第 3 節 |
| 4 任意の過去 Lead / 過去研究 | [`prior-leads.ts`](../../src/discovery/prior-leads.ts)、[`prior-research.ts`](../../src/discovery/prior-research.ts) | 下の第 4 節。入力を設定しなければ節ごと無い |
| 5 trust 境界 | [`trust-boundary-v2.md`](../../src/profiles/wordpress/prompts/trust-boundary-v2.md) | 下の第 5 節 |
| 6 Programme Boundary | campaign 設定の `programmeBoundary.text` | 下の第 6 節は repository 同梱の `wordfence-2026-10-26` の訳 |
| 7 Lab と固定ソース | [`wordPressLabSection`](../../src/cli/wordpress.ts)、`wordPressDiscoveryPromptText` | 下の第 7・8 節。v25 は attached Lab が必須 |

## 2. 配置される必須スキルの全文訳

`discovery.skills` の ID と、CLI に表示される front matter の名前を区別する。配置だけでスキルの読了や手順の遂行は保証されない。v25 目的文は計画と子の起動より先に `wbh-audit` を読むよう指示し、Lab 節は最初の Lab コマンドより先に `wbh-lab` を読むよう指示する。

| 設定 ID / 表示名 | 英語原文 | 全文の日本語訳 |
| --- | --- | --- |
| `wbh-audit-v2` / `wbh-audit` | [`SKILL.md`](../../src/profiles/wordpress/prompts/skills/experimental/wbh-audit-v2/SKILL.md) | [境界、depth、六段階](2026-11-04-cloudflare-audit-gate-v2.md#L230) |
| 同スキルの偵察 | [`reconnaissance.md`](../../src/profiles/wordpress/prompts/skills/experimental/wbh-audit-v2/reconnaissance.md) | [偵察と REGISTRY](2026-11-04-cloudflare-audit-gate-v2.md#L270) |
| 同スキルの探索 | [`hunting.md`](../../src/profiles/wordpress/prompts/skills/experimental/wbh-audit-v2/hunting.md) | [hunter と漏れ点検](2026-11-04-cloudflare-audit-gate-v2.md#L308) |
| 同スキルの WordPress 類型 | [`wordpress-classes.md`](../../src/profiles/wordpress/prompts/skills/experimental/wbh-audit-v2/wordpress-classes.md) | [保存後の出力、SQL、その他の類型](2026-11-04-cloudflare-audit-gate-v2.md#L349) |
| 同スキルの点検・報告 | [`validation-and-reporting.md`](../../src/profiles/wordpress/prompts/skills/experimental/wbh-audit-v2/validation-and-reporting.md) | [反証、草稿、最終点検、報告](2026-11-04-cloudflare-audit-gate-v2.md#L385) |
| `wbh-setup-v1` / `wbh-setup` | [`SKILL.md`](../../src/profiles/wordpress/prompts/skills/wbh-setup-v1/SKILL.md) | [通常利用の Lab setup の全文訳](2026-11-01-exploration-skills-wbh-setup-v1.md#L56) |
| `wbh-lab-v1` / `wbh-lab` | [`SKILL.md`](../../src/profiles/wordpress/prompts/skills/wbh-lab-v1/SKILL.md) | [marker、Find / Query / Trace / Observe の全文訳](2026-11-02-exploration-skills-wbh-lab-v1.md#L68) |

任意の `wbh-tools-v1` を追加する Trial の全文訳は [wbh-tools-v1 の記録](2026-10-30-exploration-skills-wbh-tools-v1.md) にある。`wbh-recon-v3` は v25 と同居を拒否するため、この入力一式に含めない。`upstream-license.txt` はライセンス表示で監査手順ではない。原文と参照用の訳は [gate v2 の記録](2026-11-04-cloudflare-audit-gate-v2.md#L477) にある。

## 3. `## Run parameters` の日本語訳

以下は [`runParametersSection`](../../src/discovery/run-parameters.ts) が生成する文の訳。数値は設定と Trial の runtime profile から埋まる。

> ## 実行条件
>
> Harness は、この Trial に次の値を設定し、強制する。
>
> - 実行環境: `<transportKind>`、モデル `<model>`、effort `<effort>`。
> - 制限時間: `<wallMinutes>` 分。
> - 最低限の能動的な探索時間: `<minimumActiveMinutes>` 分。0 分なら最低時間はない。
> - 同時に動く子 agent の最大数: `<maxChildren>`。
> - Lab: attached。reset は最大 `<maxResets>` 回。

Lab が `none` の別版では最後の行は「Lab: なし。」となる。v25 は設定検査で attached を要求する。Observe と Find / Query / Trace の予算は、次の `## Lab` 節で伝える。

## 4. 任意の過去入力の日本語訳

### `## Prior leads`

同じ Snapshot の第 2 Trial など、許可された代表 Lead を入力にしたときだけ付く。`<n>`、入口と効果の file/function、欠けた辺は実行時に埋まる。

> ## 過去の Lead
>
> 同じ Snapshot の以前の Trial が、以下の Lead を報告した。それぞれ、固定ソース上で経路が入った場所と終わった場所を file と function で示し、何をまだ示していなかったかを述べた文を添える。これらは未確認で、誤っている可能性がある。今回の Trial でも、他の Trial と同じ出力契約に従って Finding と Lead を報告する。
>
> ### 過去の Lead `<n>`
> - 入口: `<file> <function>`
> - 効果: `<file> <function>`
> - 示せていないこと: `<欠けた辺の文、または (withheld)>`

### `## Prior research`

`discovery.priorResearch: same-target` で許可された、同じ対象の別 Snapshot の以前の Trial からの研究 file があるときだけ付く。現行の許可 file は `recon-map.md`、`lab-setup.md`、`REGISTRY.md`、`stores.json`、`assumptions/*.md`、`walks/*.md` で、上限は計 2 MiB・64 file。旧 Finding / Lead の全件を渡す節ではない。

> ## 過去の研究
>
> 同じプラグインの版 `<priorVersion>` に対する以前の Trial は、当時固定したソースから、同じスキルを使って次の file を書いた。今回の Trial が読むのは版 `<currentVersion>` である。これらの file が記述するのは以前の版であり、今回の版では変更された部分の挙動が異なる可能性がある。そこに書かれたことは何も確定していない。今回の Trial 自身の file は、スキルの指示どおり `/workspace/research` に書く。過去の file は配置された場所に残す。
>
> - `/workspace/research/prior/recon-map.md`: `wbh-recon` が書いたプラグインの地図（`<bytes>` bytes）。
> - `/workspace/research/prior/lab-setup.md`: `wbh-setup` が書いた Lab の通常利用の記録（`<bytes>` bytes）。
> - `/workspace/research/prior/<other permitted file>`（`<bytes>` bytes）。
> - 容量のため渡さず、配置していない file: `<names>`。この行は該当時だけ付く。

file 行は実際に渡す file ごとに作られる。`REGISTRY.md` 等には説明文が付かず、パスと byte 数だけが載る。

原文の「同じスキルを使って」はそのまま訳した。現行の過去 Trial 選択は同じ対象と別 Snapshot 等で絞るが、スキル ID の一致までは保証しない。`recon-map.md` の説明も旧スキル `wbh-recon` の名前を固定している。v22 から v25、または v25 から次の版へ渡す場合に説明が事実とずれ得るため、過去研究を有効にする前に生成文を版付きで直す必要がある。最初の v25 単発 Trial で過去研究を付けなければ、この節は出ない。

## 5. `## Trust boundary` v2 の日本語訳

原文は [`trust-boundary-v2.md`](../../src/profiles/wordpress/prompts/trust-boundary-v2.md)。v25 の新規 Trial は v2 を受け取り、既定 v22・deep・v23 の新規 Trial は v1 を使う。再開時は台帳に記録した版を使い、版が無い旧記録は v1 にする。旧 v1 の本文と digest は変えない。

### 変更後の英語全文

```text
# WordPress trust boundary template v2

This human-authored declaration fixes the attacker and trusted positions for the pinned target. Add target-specific roles or settings only when supported by the frozen source and intended deployment.

- Attacker positions: unauthenticated visitor and a normal subscriber; customer is equivalent when that role exists in the Lab. Do not grant capabilities beyond these roles.
- Trusted positions: contributor, author, editor, administrator, shop manager, and any role with `unfiltered_html`. Administrator-only paths and permissions deliberately granted by an administrator are inside the trust boundary.
- Configuration: use defaults or ordinary setup recorded in the Lab Setup digest. State every deviation exactly; do not silently assume unsafe settings.
- Assets: the frozen target and dependency source and the disposable Lab. The target claim must arise from target behavior; dependency code may explain a reached path.
- Observation: Lab HTTP, read-only database inspection, and browser observations may support a claim. Only a named human's matching observation in a retained verification Lab or a new review Lab, recorded as `review observe` and paired with `review decide --reproduced match`, confirms a vulnerability. An agent's check or Lab observation is not confirmation.
```

### 日本語訳

> # WordPress の trust 境界テンプレート v2
>
> この人間が書いた宣言は、版を固定した対象の攻撃者側と信頼する側の立場を定める。対象固有の役割や設定は、固定したソースと想定する通常の運用が裏付ける場合にだけ加える。
>
> - 攻撃者の立場: 未認証の訪問者と通常の Subscriber。Lab に Customer の役割があるときは同等とする。これらの役割を超える権限を与えない。
> - 信頼する立場: Contributor、Author、Editor、Administrator、Shop Manager、および `unfiltered_html` を持つすべての役割。管理者だけが到達できる経路と、管理者が意図して付与する権限は trust 境界の内側にある。
> - 設定: 既定値、または Lab Setup digest に記録された通常の設定を使う。逸脱はすべて正確に述べ、安全でない設定を黙って仮定しない。
> - 保護対象: 固定した対象と依存のソース、および使い捨て Lab。対象についての主張は対象の挙動から生じなければならない。依存コードは到達した経路の説明に使える。
> - 観測: Lab の HTTP、読み取り専用のデータベース調査、browser 観測は主張を補強できる。脆弱性の確定は、記録後も残した検証 Lab または新しい review Lab で名指しされた人間が一致を観測し、`review observe` と `review decide --reproduced match` の組で記録したときだけ行う。agent の点検や Lab 観測は確定ではない。

### 出典対照

| v1 からの変更 | 根拠 |
| --- | --- |
| 冒頭の件ごとの人間の読了・版上げを示唆する文を、版付きの宣言が固定する立場の説明へ変える | [SPEC 第 2 節](../SPEC.md) の人間の判断点は提出前 review と外部行動の承認。trust 境界の宣言は維持する |
| 旧 canary と independent judge による確定を削り、探索 Lab の HTTP・DB・browser は主張の材料、人間が残した検証 Lab または新しい review Lab で記録した `review observe` と `review decide --reproduced match` の組だけを確定根拠にする | [SPEC 第 2・7 節](../SPEC.md)、[ADR 0040](../adr/0040-human-lab-observation-replaces-judges.md) |

## 6. `## Programme Boundary` の日本語訳

次は repository 同梱の [`campaign.json`](../../src/profiles/wordpress/policy/campaign.json) にある `wordfence-2026-10-26` の全文訳。別の campaign が異なる `programmeBoundary.text` を指定した場合は、その実際の文を別途訳す。

> ## Programme Boundary (`wordfence-2026-10-26`)
>
> Wordfence Bug Bounty Program の、この campaign に対する対象範囲は 2026-10-26 に改訂された。対象内は、未認証の訪問者、Subscriber、Customer から到達できる影響である。特に価値の高い影響は、任意の PHP file の upload または読み取り、任意の PHP file の削除、遠隔コード実行、管理者への認証 bypass、管理者への権限昇格である。account takeover、Stored XSS、SQL injection、任意 file の読み取り・download・削除、local/remote file inclusion、directory traversal も対象内である。
>
> この campaign では、機微情報の開示、private・draft・password-protected content へのアクセス、基本的な情報開示、任意 content の削除、任意 option の更新、管理者未満で止まる権限昇格または認証 bypass、Reflected XSS、CSRF、missing authorization、IDOR、DoS、business logic のみの影響は対象外とする。Contributor、Author、Editor、Shop Manager、Administrator の権限、または管理者が明示的に付与した権限を必要とする経路も対象外である。管理者が有効化できる plugin 設定は、典型的な site でも有効にし得る場合、それだけでは除外理由にならない。Finding にはその設定を前提として記す。

## 7. attached `## Lab` 節の日本語訳

原文は [`wordPressLabSection`](../../src/cli/wordpress.ts)。以下の `<...>` は実行時の endpoint、認証情報、role、予算、再開済みの使用回数を示す。実際の資格情報を翻訳文書に写さない。再開区間では site と account は新しく供給され、前の Lab で変更した状態は引き継がれない。

> ## Lab
>
> この Trial には制限時間全体で専用の Lab が 1 台ある。固定した対象と依存 plugin を WordPress 上の gVisor 内で動かす。sandbox からは HTTP だけで Lab に到達でき、Lab は internet に接続できない。再開区間では新しい sandbox と Lab を同じ setup から供給し直す。前の Lab の変更は残らず、以下の account が前の account に代わる。
>
> - site: `<Lab endpoint>/`
> - Administrator account: `<username> / <password>`
> - 攻撃者側の role ごとの account: `<role>: <username> / <password>`
> - Reset: `POST http://<control host>/reset` は site を消し、同じ setup から供給し直す。上記の account は変わらない。Trial 全体で最大 `<maxResets>` 回 reset でき、応答に使用回数が出る。site endpoint へのその他の要求は計数するが回数制限はしない。再開区間では以前の使用回数も表示する。
>
> Observe: `POST http://<control host>/observe` に JSON body `{"role": ..., "path": "/..."}` を送ると、Lab 内の Harness の headless browser が site の 1 ページを開き、見た内容を返す。role は visitor（未ログイン）、供給された低権限 role、または administrator。browser は選んだ account でログインする。path は `/` 1 つで始まり、空白と backslash を含まず、2048 文字以下。page 読み込み後に順番に行う `actions` を 1〜5 個付けられる。各 action は `click` と selector、`click-text` と text・exact、または `fill` と selector・value。selector は 1〜200 文字で許可文字は英数字、空白、`# . _ [ ] = " ' ( ) : > + ~ * , -`。text と fill の value は 1〜120 文字で、exact は boolean。`dialogMarker` を付けるなら、先頭が 0 でない 10〜15 桁の数字の文字列とする。他の field は受け付けず、不正な body は `invalid-request` と最初に失敗した field 名を返す。制御口は 1 回に 1 command だけ受け、処理中の要求は 409 `busy` を返す。応答には path の HTTP status、dialog が開いたか、marker を指定したときにその文字列と完全一致する alert が開いたか、console error の件数、Harness が保管する screenshot の digest が出る。Trial 全体で最大 `<maxObservations>` 回 Observe でき、応答に使用回数が出る。答えは観測であり確定ではない。見たことを `labObservations` に書く。
>
> Find: `POST http://<control host>/find` に JSON body `{"marker": "..."}` を送る。marker は先頭が 0 でない 10〜15 桁の数字の文字列とする。site の database と `wp-content` 以下の file から完全一致する文字列を探す。応答には、見つかった各 database table と column、table ごとに最大 20 件の key 値、文字列を含む file path を最大 50 件載せる。上限で結果が切れたときは `truncated` が示す。見つからなかったという答えはこの検索での不在であり、保存されていない証明ではない。
>
> Query: `POST http://<control host>/sql` に JSON body `{"select": "..."}` を送ると、読み取り専用 account で SELECT 文 1 つを実行し、column 名と最大 200 行を返す。さらに行があるときは `truncated` が示す。単一 SELECT でない文や database が拒否した文は、database の message を伴う `sql-error` になる。Find と Query は同じ予算を使い、Trace も共有する。Trial 全体の上限は `<maxLookups>` 回で、応答に使用回数が出る。
>
> Trace: `POST http://<control host>/trace` に `{"method": "GET" または "POST", "path": "/...", "cookie": "...", "contentType": "...", "body": "..."}` を送る。Lab 内からその 1 要求を site に送って PHP function trace を取り、HTTP status と plugin directory 内で実行された function を呼出順に返す。各項目には深さ、file、line が付き、最大 2000 件で、全件数は `entryCount`、打ち切りは `truncated` が示す。path は Observe と同じ規則。cookie、contentType、body は任意で、contentType は `application/x-www-form-urlencoded`、`application/json`、`text/plain` のいずれか。body は POST のときだけ、8192 文字以下。trace が示すのは送った 1 要求で走った処理だけで、別の要求や account の挙動は示さない。Trace は Find・Query と同じ予算を使う。
>
> インストール済みの `wbh-lab` スキルは、研究 file を見て Find、Query、Trace、Observe をいつ使うかと、それぞれの答えの記録方法を説明する。最初の command より先に読む。
>
> Harness は site endpoint を通る HTTP traffic と、reset 前後の site 状態を記録する。この Lab での観測はいずれも確定ではない。管理者として変更した設定は構成上の前提なので `configurationPrecondition` に記す。Finding または Lead の `labObservations` には、Lab で試した内容と見た結果を書く。

## 8. ソースと研究場所の案内の日本語訳

WordPress core と依存の mount があるとき、最後に次の文が続く。`<path>` は実際に配置された読み取り専用の path。依存ごとに 1 行を作る。

> WordPress core のソース（読み取り専用）: `<path>`。Lab が動かすものと同じ版。
>
> 依存のソース（読み取り専用）: `<path>`。
>
> 書き込み可能なメモの directory: `/workspace/research`。
>
> ## 割り当てられた file
>
> `/workspace/main` 以下のすべての file。

Lab を付けない別版では「この Trial に Lab はない。実行時の確定は後段の検証で行う。」という文に置き換わる。v25 の新規 Trial にはこの分岐を使えない。

## 9. 訳と実行の境界

- 英語の目的文、スキル、生成節が Trial の実入力であり、日本語訳を英語と差し替えて実行しない。過去 Trial の prompt/skill/contract digest は保持する。
- `REGISTRY.md` の網羅性、子によるスキル読了、Lab の問いの質はスキルの指示である。Harness が強制するのは実際の子 run・同じ Trial/Snapshot・claim digest を使った `checked/v1` の受理条件など、仕様で定めた制御である。
- `verified` の AI check、探索 Lab の HTTP/DB/browser 観測、過去研究は脆弱性の確定ではない。確定には、記録後も残した検証 Lab または新しい review Lab での人間の観測記録が必要である。
