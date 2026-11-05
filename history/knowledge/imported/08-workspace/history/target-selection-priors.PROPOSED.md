<!-- provenance: /home/dev/wp-bounty-workspace/history/target-selection-priors.PROPOSED.md, mtime 2026-08-13, imported 2026-10-13, generation 08-workspace -->

# Target selection priors

このreferenceは、Wordfence向けWordPress plugin portfolioをexpected-valueで選ぶための補助である。Targetを0〜10で採点せず、既知の答えを植え付けない。**Target Selectionで期待severityへ寄せても、Discoveryの探索classは限定しない。**

## Expected value の分解

Selectionは次の積を最大化する。**因子は掛け算であり、どれか一つがゼロなら他が満点でも価値はゼロになる。**

```text
EV = 規模 × P(存在) × P(新規) × P(High以上が付く) × P(scopeを通る) ÷ 検証コスト
```

各因子は別々のsignalで測る。合成scoreは順序付けの補助であって判定ではない。

### 因子ごとの担当レイヤ

Historyが決めてよいのは**配分**だけである。**発見**には渡さない。

| History / DBが決める | Sourceだけが決める |
| --- | --- |
| どのTargetか | 脆弱性が現在あるか |
| 予算をいくら割くか | どこにあるか |
| Duplicate riskの価格付け | 到達可能か |
| いつ止めるか | 終端効果が何か |
| 書けた場合の期待severity | |

DBのrecordは全て**patch済みの脆弱性**である。現在のcodeについて直接の情報を持たない。予測力があるのは、instanceがpatchされてもarchitecture、vendorのprocess品質、feature velocityが持続するためである。したがって見るのは**current vulnerability existenceではなくcurrent vulnerability-producing structure**である。

## Severity band

Wordfenceのtier counterは**CVSS 3.1標準帯と1段ずれている**。7.2のStored XSSがCriticalとして計上された観測に基づく。

| Wordfence帯 | CVSS |
| --- | --- |
| Critical | 7.0以上 |
| High | 6.0〜6.9 |

到達性がscoreを決める構造は次のとおり。impact triadより**PRとUIのほうが支配的**である。

| 構成 | score | 帯 |
| --- | --- | --- |
| `PR:N` + `UI:N` + `C:H` | 7.5 | Critical |
| `PR:N` + `UI:N` + `S:C` + `C:L/I:L` | 7.2 | Critical |
| `PR:L` + `C:H/I:H/A:H` | 8.8 | Critical |
| `PR:L` + `C:H` のみ | 6.5 | High |
| `PR:N` + `UI:R` + `S:C` | 6.1 | High |

読み取れる規則:

- `PR:N`は`PR:L`より約1.0高い。**subscriber級で`C:H`だけでは7.0に届かない。**書き込み（`I:H`）まで到達して初めて8.8になる。
- `UI:N`は`UI:R`より約1.1高い。自動発火するStored XSSはCritical帯、click必要なReflected XSSはHigh帯に落ちる。
- unauth SQLiは読み出しのみでも7.5でCritical帯に入る。`I:H/A:H`まで示せば9.8。

## Stage A1 — Reach ceiling と規模の事前足切り

Candidate Catalogのpublic metadataとhistory projectionだけで大きく絞る。sourceは読まない。

適用順は安い順とする。

1. **Active installs** が下限以上。既定は50,000。上限は置かない。数百万規模でもsignalがあれば候補に残す。
2. **低権限×High以上の既往が2件以上。** 低権限はunauthenticatedまたはSubscriber/Customer相当。判定はWordfence titleのattacker表記を優先し、明示がない場合だけCVSS `PR`をfallbackに使う。
3. **直近90日の公開件数**が少ない。
4. **Repeat well兆候** — 3件以上を単独で取得したresearcherが複数居るか。

Pre-shortlistは最大50件まで。`score_severity_candidates.py`がこの4つを計算する。

### Duplicate pressureの盲点

**Submissionから公開までのlagは中央値68日、最大149日である。**したがって「直近90日は静か」というsignalは実質「68日前の時点で静かだった」でしかなく、**その盲点の幅はconcurrent duplicateが発生する窓と一致する。**

事前公開ゼロのTargetで重複が起きるのはこの構造による。DB分析の精度では解消できない。手当てはSelectionではなくDiscoveryの性質側で行う（Stage B参照）。

## Stage A2 — Recurrence、diversity、competitor pressure

Gate通過後はraw report countを単純なrank multiplierにしない。ただしbinary化して情報を捨てすぎない。

見るもの:

- 低権限×Critical帯（7.0以上）と低権限×High帯（6.0〜6.9）を**別々に**数える。tierへの寄与が違う。
- `published_year_count` — recurrenceが複数年にまたがるか。
- `primitive_classes` / `terminal_outcomes` — mechanism diversity。
- 直近90日の公開件数と、そのうち**大量掃引型researcherによるものの割合**。

Interpretation:

- 低権限×Critical帯が複数年に再発しているTargetは強いpositive prior。
- 大量掃引型が直近に入っているTargetはduplicate pressureを上げる。ただし別familyが豊富なら自動除外しない。
- 件数の多さ自体を「より脆弱」とは扱わない。recurrence、diversity、recent pressureを別々に判断する。

## Stage B — Bounded structural reconnaissance

Gate通過後の最上位だけ、official latest stable sourceを`prepare_candidate_recon.py`でprivate workspaceへ展開して読む。通常は5〜12件程度に抑える。

目的は**current vulnerability existenceではなくcurrent vulnerability-producing structureの確認**である。

### B1 — Reach ceiling の確認

最初に、7.0を超えうる面が存在するかだけを確認する。無ければ以降を読まない。

- `wp_ajax_nopriv_*` の登録。
- `permission_callback`が`__return_true`または実質無条件のREST route。
- frontendで描画されるshortcode。
- comment、form、search等の匿名入力経路。

これらが無いpluginは、どれだけ脆弱でも構造的にHigh帯止まりになる。

### B2 — 共有helperのfan-outを数える

**1 pluginから複数のFindingが出るかは、多数のfeature面から呼ばれる共有helperが在るかで決まる。**(researcher, plugin)組で3件以上に達するのは全体の約3%であり、達した場所には共通してこの構造がある。

数えるもの:

- 独自のquery builder / data access layerと、その呼び出し箇所数。
- 共有renderer / output helperと、それを使うwidget・block・template数。
- REST controller基底クラスと、継承するcontroller数。
- capability wrapper / nonce helperと、それを経由するendpoint数。
- output横取り層（翻訳、cache、optimizer等）が触るsinkの広さ。

**fan-outが大きいほど期待取得件数が大きい。**単一featureに閉じた実装は1件で終わる。

### B3 — 同時発見されにくさ

68日の盲点は測れないので、性質で回避する。

- 単一のsource-to-sinkは掃引で当たるため、盲点の中に競合が居る確率が高い。
- **設定依存、状態依存、subsystem跨ぎのchain**は同時発見されにくい。chainを示すrecordはDB全体の3.3%しかなく、平均CVSSは7.85、8.0以上が56%を占める。

### やらないもの

- Source-to-sinkの脆弱性trace。
- 「このparameterはSQLi」等の具体的hypothesis。
- Nonce/capability bypassの成立判定。
- Payload、PoC、exact endpoint、known routeの再構築。
- Git history、patched version、patch diff、known report検索。

Reconは脆弱性探索ではない。十分なproduct-level構造が分かったら停止する。同じfunctionを深追いしてDiscoveryを先食いしない。

## Scope survival — 終端効果の自明性

Wordfenceは**論理バグ、code品質問題、条件付き影響**を範囲外として扱う。Selectionの段階で、そのTargetの低権限面が到達しうる終端効果を確認する。

| 通る | 通らない |
| --- | --- |
| DBの内容が返る | actionが実行された |
| 別principalのsessionでscriptが動く | 権限checkが無い |
| 任意fileが読める・書ける・消える | 情報が返るが機密でない |
| 金額・所有権・認証状態が変わる | 想定外だが境界を越えない |

右側しか到達できない面しか持たないTargetは、technical chainが完全でもscoreにならない。

さらに次のpreconditionは、chainが成立していても却下される:

- site ownerの後片付け失敗に依存する（migration installer等の残置）。
- 既定でない構成を必要とし、その構成がpluginの売られ方から見て考えにくい。
- 最新安定版で既にpatch済み。

## Qualitative selection priors

最終候補は0〜10 scoreではなく次の軸で表す。

- `severity_ceiling`: `medium / high / critical` — 低権限面が到達しうるWordfence帯。
- `historical_recurrence`: `low / medium / high`
- `mechanism_diversity`: `narrow / mixed / broad`
- `low_priv_surface`: `thin / moderate / rich`
- `helper_fan_out`: `single / moderate / wide` — 共有helperの呼び出し広がり。
- `duplicate_pressure`: `low / medium / high`
- `scope_survivability`: `weak / moderate / strong` — 終端効果の自明性。
- `verification_cost`: `cheap / moderate / expensive`

特に優先する組合せ:

```text
severity_ceilingがcritical（PR:N × UI:N の面がある）
    +
helper_fan_outがwide
    +
scope_survivabilityがstrong
    +
duplicate_pressureが許容範囲
    +
active installsが大きい
    +
verification costが現実的
```

## 停止規則

Discoveryを無限に続けない。次のいずれかで打ち切り、次のTargetへ移る。

- Stage B1でPR:N × UI:Nの面が見つからない。
- Stage B2でfan-outが単一featureに閉じている。
- 割当予算を消化して、scope survivabilityがstrongな終端効果に一つも到達していない。
- 探索中に同一pluginの新規公開recordが現れ、duplicate pressureが跳ね上がった。

停止はfailureではない。基準率が分かっている以上、期待値が閾値を下回った時点で撤退するのが正しい。

## Counterarguments

- Admin-only productで低権限featureが薄い。
- WordPress Core APIの薄いwrapperで独自処理が少ない。
- 直近に共通基盤を全面rewriteし、historical recurrenceの構造的意味が弱い。
- 巨大codebaseで限られたbudgetでは深く読めない。
- 直近30〜90日に同一pluginへ公開reportが集中し、novelty probabilityが低い。
- 外部SaaS、特殊server設定、premium addon等がないと主要featureを確認できない。
- Human verification/report costが期待報酬に比べて高い。

Counterargumentは除外規則ではない。

## Selection output

新しいSelectionでは各Targetへ次を書く。

- Active installsとmaintenance。
- 低権限×Critical帯 / High帯の既往件数。
- 8つのqualitative selection priors。
- Bounded recon package ID / tree SHA-256とproduct-level observations。
- 共有helperのfan-out観測。
- 低権限product featureの概要。
- Duplicate pressureと、直近90日に入っているresearcherの型。
- Counterarguments。
- Expected-value hypothesisと割当予算、停止条件。

Exact endpoint、file、line、symbol、parameter、payload、known route、patch、PoCを含めない。Reconの具体的source notesをDiscoveryへhandoffしない。
