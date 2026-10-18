# システム図解（2026-10-16 版）

> **2026-10-19 時点で図と違う点**（図は描いた日の記録。正本は SPEC と ADR）: (1) 探索は既定で Lab を付けず（`discovery.lab: none`、PR #365）、検証は後から Finding 単位に Lab を立てて `verify next`（Codex Verifier）か `verify next --handoff`（skill `wbh-verify`、ADR 0035）で行う。(2) 新規探索は `wp2shell-bounty-v8` だけで、Root＋最大 4 子、wall 120 分・最低 60 分。`provider-cyber-policy` で止まった Root は操作者の `campaign resume` で同じ Trial の segment として再開する（ADR 0033、0036）。(3) 選定は主帯 100k–1M を mirror の paying class 件数・最終記録の新しさ・install で順位付けし、尽きたら cascade 50k → 30k → ≥1M（ADR 0037）。(4) Programme Boundary 外と判別の付きにくい 5 分類は `finding-parked`（ADR 0032）。(5) 入口索引と coverage は削除（ADR 0034）。(6) `owner-approved` は委任済みの AI が付ける（ADR 0032 の 2026-10-18 節）。

正本は [SPEC](SPEC.md) と [ADR](adr/)。食い違えば正本が勝つ。この文書は規則を足さない。所有者が全体と細部の動きを図で追えるように、3 段のズームで描く。流れ図は [ARCHITECTURE](ARCHITECTURE.md)、境界と統治は [DESIGN-DIAGRAMS](DESIGN-DIAGRAMS.md)、開発ループは [FACTORY](FACTORY.md) にあり、ここでは重ねない。

- 第 1 段: 全体 1 枚
- 第 2 段: 部品ごとの動き（シーケンス図 6 枚）
- 第 3 段: データと状態（4 枚）
- 配置図: コンテナとネットワーク 1 枚

各図の下の「根拠」は、描くときに読んだ正本の節とコードの場所。用語は [GLOSSARY](../GLOSSARY.md) と同じ。

## 第 1 段: 全体 1 枚

```mermaid
flowchart LR
  subgraph outside[外の世界]
    WPORG[WordPress.org<br/>plugin 一覧と ZIP]
    PROV[provider API<br/>Codex]
    WF[Wordfence<br/>Programme と提出先]
  end
  subgraph harness[Harness（ホスト上の CLI）]
    SEL[1 選定<br/>select]
    SNAP[2 Snapshot<br/>digest で固定]
    LAB[3 Lab<br/>gVisor の使い捨て WordPress]
    DISC[Discovery<br/>Root + 子 4 の協調 Trial]
    NORM[5 正規化<br/>受理 / 保留 / parked]
    VER[6 Verification<br/>新しい Lab + Verifier + 判定器]
    REV[7 Review<br/>export → skill → decide]
    LED[(台帳 SQLite<br/>digest 参照だけ)]
    PE[(Private Evidence<br/>本文と証拠)]
  end
  H1{{人間 1<br/>提出前レビュー}}
  H2{{人間 2<br/>外部行動の承認}}

  WPORG -->|一覧・ZIP| SEL --> SNAP --> LAB --> DISC
  DISC -->|最終 JSON| NORM -->|Finding| VER --> REV
  PROV <-->|broker 経由のみ| DISC
  PROV <-->|broker 経由のみ| VER
  REV --> H1 --> H2 -->|人が送る| WF
  SEL & SNAP & LAB & DISC & NORM & VER & REV -.->|event| LED
  DISC & NORM & VER & REV -.->|本文| PE
```

読み方: 実線は対象と候補が進む道、点線は記録。外へ出る線は「broker 経由の provider」と「人が送る提出」の 2 本だけ。Harness 自身は何も送らない。

根拠: SPEC §2（不変条件 1・2・7・8）、§3（流れ）、§4（モジュール境界）。

## 第 2 段: 部品ごとの動き

### 2.1 対象 1 件の `campaign run`

```mermaid
sequenceDiagram
  autonumber
  participant CLI as campaign run
  participant L as 台帳
  participant S as Snapshot
  participant Lab as Lab
  participant D as Discovery
  participant N as 正規化
  participant V as Verification

  CLI->>L: target-selected（選定記録の digest）
  CLI->>S: 固定済み Snapshot を digest で読む
  S-->>CLI: source manifest / 依存（core）
  CLI->>L: snapshot-frozen（sourceDigest, dependencyDigests）
  CLI->>Lab: provision（scenario 付き）→ seedCanaries → probe
  alt Lab ready
    CLI->>L: lab-provisioned（status ready）
    CLI->>D: 協調 Trial 1 回（2.2 へ）
    D->>N: 最終 JSON（2.3 へ）
    N->>L: finding-recorded / finding-parked / lead-recorded
    D->>L: discovery-run-finished → discovery-concluded
    loop 受理した Finding ごと
      CLI->>V: verify（2.4 へ、新しい Lab）
      V->>L: verification-finished（status, reason）
      CLI->>CLI: 理由別の自動再試行を判断
    end
  else Lab failed
    CLI->>L: lab-provisioned（status failed, failureStage）
    Note over CLI: 対象は setup-failed か incomplete(precondition)
  end
  CLI->>Lab: teardown（残骸があれば campaign-stopped）
```

根拠: SPEC §3、§6、§7。`src/cli/pipeline.ts` 400〜770 行。

### 2.2 協調 Trial の中身（Root + 子 4）

```mermaid
sequenceDiagram
  autonumber
  participant H as Harness
  participant B as broker container
  participant C as codex-agent container
  participant R as Root（Codex CLI）
  participant K as 子 1〜4（CLI の multi_agent）
  participant Lab as Lab（wp）

  H->>H: prompt を組む（目的文 + 出力契約 + Trust boundary + Programme Boundary + Lab）
  H->>B: grant を発行（要求数・byte 上限・期限）
  H->>C: 起動（source を読み取り専用で mount、network は Lab の内部 net だけ）
  H->>R: prompt を stdin で渡す（wall 120 分の timer 開始）
  R->>C: /workspace/main の source を読む
  R->>Lab: 無害な HTTP で挙動を見る（直接、記録なし）
  R->>K: 子を起こす（max_threads 4, depth 1）
  K->>C: source を読む
  K-->>R: 子の最終報告
  R->>B: モデル呼び出し（provider へ中継）
  K->>B: モデル呼び出し
  R-->>H: 最終 JSON（stdout の最後の agent_message）
  Note over H: wall 超過なら SIGTERM → SIGKILL（timed-out）
  H->>C: rollout（Root と子の記録）と receipt を回収
  H->>B: metrics を読んで停止
  Note over H: 子の有効な報告は Root と独立に保存する（ADR 0029）
```

読み方: 子は Harness が起こすのではなく、Codex CLI の `multi_agent` が起こす。Harness は後から各ラウンドの子の rollout を読み、有効な報告をすべて個別に保存する。Root が wall で止まっても子の報告は残る。rollout が保存上限を超えた場合は、保存できた報告を残して Trial を `incomplete(evidence)` にする。

根拠: SPEC §6、ADR 0029。`src/discovery/codex-native-agent-runtime.ts` 1039〜1457 行、`src/infrastructure/native-model-process.ts` 63〜80 行、`src/discovery/recover-agent-reports.ts`。

### 2.3 候補の正規化（受理・保留・parked）

```mermaid
sequenceDiagram
  autonumber
  participant D as Discovery の最終 JSON
  participant N as record-discovery-report
  participant P as profile（WordPress）
  participant PE as Private Evidence
  participant L as 台帳

  D->>N: 候補（finding / lead）を 1 件ずつ
  N->>PE: candidate.json を保存
  N->>P: normalize → candidate-normalized
  N->>P: admit（schema と identity）
  alt admit が失敗 / run・snapshot の identity 不一致
    N->>L: candidate-held（分類と issue path だけ）
  else Finding で impact が Programme Boundary の外
    N->>L: finding-parked（outside-programme-boundary）
  else Finding
    N->>PE: finding.json
    N->>L: finding-recorded → 検証 queue へ
  else Lead
    N->>PE: lead.json
    N->>L: lead-recorded（検証しない）
  end
```

読み方: 出力境界で候補を捨てない。通らないものは保留として本文を残す（ADR 0018）。parked は台帳と Private Evidence に残るが、検証と review には行かない。

根拠: ADR 0018、ADR 0019、AGENTS.md「受理した Finding のうち impact が Programme Boundary の外」。`src/discovery/record-discovery-report.ts` 78〜299 行、`src/profiles/wordpress/discovery/programme-impacts.ts`。

### 2.4 検証 1 回（新しい Lab、Verifier、判定器）

```mermaid
sequenceDiagram
  autonumber
  participant V as Verification
  participant Lab as 新しい Lab（wp / db / proxy / canary）
  participant O as Lab 観測器
  participant Ver as Verifier container
  participant J as 判定器（決定論）
  participant L as 台帳

  V->>V: Finding と Snapshot の digest を照合（不一致 → incomplete(digest-mismatch)）
  V->>Lab: provision（purpose verification、scenario 付き）
  V->>Lab: seedCanaries（impact に応じた nonce 付き canary）
  V->>O: Lab 状態 before を記録
  V->>Ver: Finding + source + Lab endpoint（proxy 経由）+ 低権限 account + canary
  Ver->>Lab: HTTP 手順を実行（proxy が capture.jsonl に記録）
  Ver-->>V: http.json / steps.md / route.json / session.json / refutation.md / precondition
  alt precondition が埋まっている
    V->>L: verification-finished incomplete(precondition, nextScenarioId)
  else
    V->>O: Lab 状態 after を記録（差分は review 用）
    V->>J: Harness が捕捉した HTTP + canary の観測 + route
    J-->>V: observed / not-observed / 判定不能
    V->>L: verification-finished（runtime-confirmed / contradicted / incomplete(reason)）
  end
  V->>Lab: teardown（残骸 → incomplete(cleanup)）
```

読み方: 証明は canary の回収だけ。Verifier の自己申告や画面は証明にしない。`contradicted` は修正版の負の対照が揃ったときだけで、それ以外の不一致は `incomplete(observation)`。再試行は理由ごとに回数が決まる。

根拠: SPEC §2（不変条件 3〜5）、§7、ADR 0022、ADR 0026。`src/verification/index.ts` 258〜619 行、`src/profiles/wordpress/verification/codex-verifier.ts`、`judges.ts` 1355〜1412 行、`src/cli/pipeline.ts` 125〜149 行。

### 2.5 `continuous run` の 1 周

```mermaid
sequenceDiagram
  autonumber
  participant R as runner
  participant F as 前検査
  participant S as select
  participant C as campaign run
  participant Lab as Lab 掃除
  participant M as continuous.json（メモ）

  R->>F: 停止要求 / Programme 写しの鮮度 / disk / login
  alt どれかが NG
    R->>M: holding-* または waiting-login（until 付き）
    Note over R: 時間が来たら 1 へ戻る
  end
  R->>S: 方針で batch を選ぶ（minimum 1）
  alt 候補なし
    R->>M: sleeping（empty / listing-unavailable）
    Note over R: 空が 3 日続けば stopped(exhausted)
  end
  R->>C: campaign run（対象ごとに 2.1）
  C-->>R: stopped = なし / provider-limit / incomplete
  R->>Lab: cleanupLeftovers
  alt incomplete
    R->>C: 同じ campaign ID で再開
  else provider-limit
    R->>M: backoff（rate-limit 5→60 分、quota 30→60→360 分）
  else 完了
    R->>R: 全対象が provider 拒否 → 60 分 hold して 1 対象だけ試す
    R->>R: completed 0 が続く → hold、さらに続けば stopped(no-progress)
  end
  Note over R,M: 状態の正本は台帳。メモは作業用で、消えても作り直す
```

停止理由は 6 つ: `operator`、`errors`、`no-progress`、`programme-stale`、`exhausted`、`legacy-history-missing`（`missing-floor-policy` は方針の `cascade` に置き換えて削除、ADR 0037 追記）。保守（Lab 掃除、再起動）は人手介入に数えない。

根拠: 最終設計（2026-10-14）§3.1〜3.2、§7。`src/cli/continuous.ts`（PR #262〜#269 で修正中の部分を含む）。

### 2.6 週末のレビューと提出

```mermaid
sequenceDiagram
  autonumber
  actor H as 所有者
  participant CLI as review CLI
  participant SK as skill 3 本
  participant L as 台帳
  participant WF as Wordfence（外）

  H->>CLI: review export
  CLI-->>H: export JSON（対象範囲内の Finding 全件、上限 3 件の batch）
  H->>SK: wbh-review（要約と提案。decide は打たない）
  H->>SK: wbh-dedupe（公開記録との照合 → possible-match / no-match / unavailable）
  H->>CLI: review reverify（最新版で再検証）
  H->>CLI: review scope（in-scope / out-of-scope / ambiguous）
  H->>CLI: lab up --for-review → 手で再現
  rect rgb(255, 245, 230)
    Note over H: 人間の判断点 1: 提出前のレビュー
    H->>CLI: review decide（accept / reject / defer、--reproduced、--minutes）
    CLI->>L: human-reproduction-recorded + review-decided + human-effort-recorded
  end
  H->>SK: wbh-report（英文の報告を書き、review draft を打つ）
  CLI->>L: draft-saved（candidateId, revisionDigest）
  rect rgb(255, 245, 230)
    Note over H: 人間の判断点 2: 外部行動の承認
    H->>CLI: review authorize（正確な draft と送信先に結ぶ）
    CLI->>L: external-action-authorized
  end
  H->>WF: 人が送る（Harness は送らない）
  H->>CLI: review submitted → review outcome
  CLI->>L: submission-recorded → submission-outcome（rewardUsd）
```

根拠: SPEC §2（不変条件 6・7）、§8、OPERATIONS §3。`src/review/index.ts`、`.claude/skills/wbh-review` / `wbh-dedupe` / `wbh-report`。

## 第 3 段: データと状態

### 3.1 データの置き場

```mermaid
flowchart TB
  subgraph git[Git（公開してよいもの）]
    SPEC[docs/SPEC.md, ADR]
    POL[profiles/wordpress/policy<br/>campaign.json, selection.json,<br/>programme-scope.md]
    PINS[docs/evaluation/*-pins.json<br/>digest と版だけ]
    PROMPT[prompts, skills<br/>owner-approved]
  end
  subgraph state[state dir（Git 外）]
    LED[(ledger.sqlite<br/>表 1 つ: ledger_events)]
    PE[(private-evidence/&lt;digest&gt;/<br/>manifest.json + content/)]
  end
  subgraph work[作業 dir（Git 外、作り直せる）]
    WO[wordpress-org/ 取得した ZIP の原本]
    SN[snapshots/&lt;digest&gt;.json]
    SRC[sources/ 展開した source]
    CORE[wordpress-core/]
    PRG[programme/ Programme 写し]
    SCR[codex-scratch, broker-scratch,<br/>provider-attachments]
  end
  subgraph lab[Lab（使い捨て container）]
    DB[(MariaDB<br/>wp_* と wbh_canary)]
    CAP[proxy の capture.jsonl]
    BEA[canary の beacon log]
  end

  LED -->|artifacts digest| PE
  LED -->|snapshotDigest| SN
  SN -->|sourceDigest| SRC
  POL -->|policyDigest| LED
  PRG -->|programmeRef| LED
  CAP -->|検証時に tail して保存| PE
  BEA -->|観測して保存| PE
  DB -.->|teardown で消える| lab
```

台帳に入るのは分類、理由、digest だけ。本文（候補、HTTP 記録、画面、認証情報、未公開の発見）は Private Evidence に置き、Git には入れない。Lab の中身は検証のたびに消える。

根拠: SPEC §2（不変条件 8）、§9。`src/ledger/index.ts` 684〜730 行、`src/infrastructure/private-artifact-store.ts`、`src/cli/wordpress-host.ts` 171〜180 行。

### 3.2 台帳 event の関係（これが「DB 図」）

表は `ledger_events` 1 つで、列は `sequence`、`identity`（一意）、`campaign_id`、`event_type`、`finding_id`、`input_digest`、`event_json`。関係は event の中の参照欄で表す。

```mermaid
flowchart LR
  TS[target-selected<br/>selectionId, promptVariant]
  SB[selection-batch-bound<br/>policyDigest, selectionIds]
  SF[snapshot-frozen<br/>sourceDigest, dependencyDigests]
  LP[lab-provisioned<br/>labId, scenario, status]
  RS[discovery-run-started<br/>runId, runKind explore/child,<br/>parentRunId, prompt/objective/contract digest]
  RF[discovery-run-finished<br/>runId, outcome, reason, usage, wallTimeMs]
  DC[discovery-concluded<br/>stoppedBy]
  CN[candidate-normalized / held<br/>runId, candidateKind, candidateIndex]
  FR[finding-recorded<br/>findingId, runId, derivedFromFindingId]
  FP[finding-parked<br/>findingId, reason]
  LR[lead-recorded<br/>leadId, runId, trialId]
  VR[verifier-run-finished<br/>findingId, runId, receiptDigest]
  VF[verification-finished<br/>verificationId, findingId, retryOf,<br/>result.status / reason, evidenceDigest,<br/>reproductionPackageDigest]
  RD[review-decided<br/>findingId, decision]
  SA[scope-assessed<br/>findingId, programmeId, status]
  DS[draft-saved<br/>candidateId, revisionDigest]
  EA[external-action-authorized<br/>candidateId, revisionDigest, destination]
  SR[submission-recorded<br/>findingId, candidateId]
  SO[submission-outcome<br/>candidateId, outcome, rewardUsd]
  TK[target-skipped<br/>selectionId, stage, reason]

  SB -->|selectionIds| TS
  TS -->|snapshotDigest| SF
  SF --> LP
  LP -->|labId| RS
  RS -->|runId| RF
  RS -->|parentRunId| RS
  RF --> DC
  RS -->|runId| CN
  CN --> FR
  CN --> FP
  CN --> LR
  FR -->|findingId| VR
  FR -->|findingId| VF
  VF -->|retryOf| VF
  VF --> RD
  VF --> SA
  SA --> DS
  DS -->|revisionDigest| EA
  EA -->|candidateId| SR
  SR --> SO
  TS -.->|freeze / discovery / verification で| TK
```

全 event が共通に持つのは `schemaVersion`、`identity`、`campaignId`、`snapshotDigest`、`occurredAt`、`artifacts[{kind, digest}]`。`artifacts` の digest は Private Evidence に実在しないと追記できない。同じ `identity` を同じ内容で追記すると無視、違う内容なら conflict。台帳は追記専用。

根拠: SPEC §9。`src/ledger/index.ts` 15〜460 行（event schema）、684〜730 行（表と追記規則）。

### 3.3 Finding の一生

```mermaid
stateDiagram-v2
  state "候補" as cand
  state "保留 candidate-held" as held
  state "parked" as parked
  state "受理 finding-recorded" as rec
  state "Lead" as lead
  state "検証中" as ver
  state "runtime-confirmed" as ok
  state "reproduced" as rep
  state "contradicted" as con
  state "incomplete 理由付き" as inc
  state "review queue" as rq
  state "decided" as dec
  state "in-scope" as sc
  state "draft" as dr
  state "authorized" as au
  state "submitted" as su
  state "outcome" as out

  [*] --> cand : 最終 JSON に到達
  cand --> held : admit 失敗か identity 不一致
  cand --> parked : impact が Programme Boundary の外
  cand --> rec : 受理
  cand --> lead : 検証しない
  rec --> ver : verifier run
  ver --> ok : canary を回収し nonce が一致
  ver --> rep : 判定器なし 別 Lab で経路を再生
  ver --> con : 修正版の負の対照が揃い not-observed
  ver --> inc : 10 種の理由のどれか
  inc --> ver : 理由別の自動再試行
  inc --> rq : 再試行を使い切り人間へ
  ok --> rq
  rep --> rq
  rq --> dec : review decide
  dec --> sc : scope-assessed in-scope
  sc --> dr : draft-saved
  dr --> au : external-action-authorized
  au --> su : 人が送り submission-recorded
  su --> out : submission-outcome
  con --> [*] : decide できない
  parked --> [*] : review parked で一覧のみ
```

- incomplete の理由 10 種: provision、precondition、recipe、provider、sandbox、observation、evidence、cleanup、digest-mismatch、no-judge。
- 自動再試行: recipe と observation は同じ Lab Setup で合計 3 回まで。provision と provider は 2 回まで。precondition は scenario が変わったときだけ。他は人間へ。
- decide は accept / reject / defer。outcome は triaged / resolved / duplicate / informative / not-applicable / rejected。

`ledger funnel` の数字との対応: 最終JSON到達＝候補、受理＝受理＋Lead、保留＝保留、parked＝parked、raw＝受理（Finding のみ）、verifier通過＝検証に 1 回以上届いた、confirmed / reproduced / contradicted / incomplete＝最新の検証結果、reviewed＝decided、in-scope、submitted、outcome。`incomplete` は陰性ではない（不変条件 4）。

根拠: SPEC §2（不変条件 3・4）、§7、§8、ADR 0018、ADR 0022、ADR 0031。`src/verification/reproduction-package.ts` 30〜85 行、`src/cli/pipeline.ts` 125〜149 行、`src/review/index.ts`、`src/cli/index.ts` 455〜509 行（funnel）。

### 3.4 対象と run の一生

```mermaid
stateDiagram-v2
  state "候補" as cand
  state "不適格 report にだけ残る" as inel
  state "選定 target-selected" as sel
  state "skipped freeze" as skf
  state "固定 snapshot-frozen" as frz
  state "Lab failed" as lf
  state "Lab ready" as lr
  state "run" as run
  state "数えない run" as nt
  state "Trial" as tr
  state "completed" as comp
  state "incomplete run" as ir
  state "skipped discovery" as skd
  state "concluded" as conc
  state "検証へ" as ver

  [*] --> cand : WordPress.org の一覧
  cand --> inel : install 下限 更新の古さ Programme 外 既往照合
  cand --> sel : rank 上位 maximumTargets まで
  sel --> skf : ZIP 取得失敗
  sel --> frz
  frz --> lf : setup-failed か incomplete precondition
  frz --> lr
  lr --> run : discovery-run-started explore
  state run {
    [*] --> nt : source 0 子 0 broker 転送 1 以下
    [*] --> tr : それ以外 途中で止まっても Trial
  }
  nt --> cand : 次の選定で戻る
  run --> comp : 最終 JSON 回収
  run --> ir : provider schema sandbox policy evidence
  ir --> skd : provider-refused か run-failed
  comp --> conc : discovery-concluded
  conc --> ver : 受理 Finding があれば 3.3 へ
  ver --> [*]
  skf --> [*]
  skd --> [*]
  lf --> [*]
```

- `discovery-concluded` の stoppedBy: no-new-finding / max-runs / output-boundary / plans-exhausted。provider-limit と incomplete は concluded にせず、再開できる。
- 「数えない run」は Root が source を 1 件も読まず、子を起こさず、broker 転送が 1 以下で終わった run。その対象だけが次の選定で戻る。

`revisitPolicy: never` では、Trial に数えた対象は二度と選ばない。数えない run の対象だけが戻る。現行方針（ADR 0037 の 2026-10-19 追記）は `version-increased` ＋ `minimumDaysSinceTrial: 90` で、版が上がり 90 日経った対象も戻る。

根拠: SPEC §6、最終設計 D2 / P5、ADR 0029。`src/profiles/wordpress/selection/ledger-exclusions.ts` 103〜117 行、`src/discovery/campaign.ts` 623〜693 行、`src/cli/pipeline.ts` 732〜745 行。

## 配置図: コンテナとネットワーク

```mermaid
flowchart TB
  subgraph host[ホスト（WSL2 / Docker、runtime は runsc）]
    CLI[Harness CLI<br/>campaign run / continuous run]
    STATE[(state dir<br/>台帳 + Private Evidence)]
    subgraph labnet[Lab 内部 network wbh-&lt;id&gt;-net（--internal）]
      WP[wbh-&lt;id&gt;-wp<br/>WordPress + plugin]
      DB[(wbh-&lt;id&gt;-db<br/>MariaDB)]
      PX[wbh-&lt;id&gt;-proxy<br/>HTTP recorder → capture.jsonl]
      CA[wbh-&lt;id&gt;-canary<br/>beacon 受信]
      AG[codex-agent-&lt;uuid&gt;<br/>Root + 子（read-only source）]
      BR[provider-egress-broker-&lt;grant&gt;<br/>認証と上限]
      OB[観測器 / reproducer<br/>短命 container]
    end
    BRIDGE[bridge network]
  end
  PROV[provider API]

  CLI -->|docker| labnet
  CLI --> STATE
  AG -->|探索: 直接| WP
  AG -->|検証: proxy 経由| PX --> WP
  WP --> DB
  WP -.->|script canary の beacon| CA
  OB --> PX
  AG -->|モデル呼び出し| BR
  BR --- BRIDGE -->|唯一の外向き| PROV
  PX -.->|検証後に tail| STATE
```

- 各 container は `--runtime=runsc`、`--read-only`、`--cap-drop=ALL`、`--pull=never`。image は 6 種とも digest で固定。
- Lab の network は `--internal`。外へ出られるのは broker だけで、broker は `bridge` にも繋がる。agent の base URL は broker 固定、web 検索は無効。
- ホストへの port 公開は無し。`lab up` で手で見るときだけ `wbh-<id>-host` が 127.0.0.1 に公開する。
- 探索の agent は wp に直接届く（記録なし）。検証の Verifier は proxy を通り、HTTP が記録される。判定器が読むのはこの記録だけ。

根拠: SPEC §2（不変条件 2）、§6、§7。`src/profiles/wordpress/lab/container-startup.ts`、`src/discovery/codex-gvisor-sandbox.ts` 560〜782 行、`src/discovery/provider-credential-egress-broker.ts` 423〜839 行。

## 図に出る言葉を平易に

正式な定義は [GLOSSARY](../GLOSSARY.md) と SPEC §15。ここでは「何のためにあるか」を一言で書く。

| 言葉 | 平易に言うと |
| --- | --- |
| digest | ファイルや記録の内容から計算した指紋（SHA-256）。内容が 1 文字でも変わると別の値になるので、「同じものを見ているか」を確かめるのに使う |
| Snapshot | 調べる plugin の source を、版と digest で固定したもの。探索・検証・レビューが同じ中身を見るための「凍結した写し」 |
| Lab | gVisor で隔離した使い捨ての WordPress 環境。対象 plugin を実際に動かす場所で、終わったら消す |
| gVisor / runsc | Google 製の container 隔離技術。container とホスト OS の間に「見せかけの kernel」を置き、container から本物の kernel に直接触れさせない。runsc はその起動コマンド |
| broker | provider（モデル API）への通り道を 1 本に絞る中継 container。認証情報を持ち、要求数と byte 数の上限を数える。agent はここ以外に外へ出られない |
| Root / 子 | 協調 Trial で動く agent。Root が全体を見て、最大 4 つの子に分担を振る。どちらも同じ container の中で動く |
| Trial | 1 回の探索の試み。Root と最大 4 子で 1 Trial。source を読まずに終わった run は Trial に数えない |
| Finding | 「この入口からこの影響に至る」という、source 上の根拠付きの未確認の主張。検証して初めて結果になる |
| Lead | 根拠はあるが、影響までの道に未解決の部分が残る手がかり。検証はしない |
| 保留（held） | 出力の形が契約に合わず、受理できなかった候補。捨てずに本文を残す |
| parked | 受理したが、報奨 Programme の対象外の影響だった Finding。検証とレビューには進めない |
| Programme Boundary | 報奨 Programme（Wordfence）が「対象」と定める範囲を写した文章。版と digest で固定 |
| Trust boundary | 「誰の権限までを信頼の内側とするか」を人間が書いた宣言。contributor 以上の権限は内側 |
| 入口索引 | source から機械的に拾った「外から呼べる入口」の一覧。経路は指示しない。ADR 0034 で生成 code を削除し、旧 Trial の記録にだけ現れる |
| Verifier | Finding を実際の Lab で再現してみる agent。手順（recipe）を書き、HTTP を実行する。証明はしない |
| 判定器（judge） | Harness が持つ決定論の検査。Verifier の自己申告ではなく、Harness が捕捉した HTTP と canary の観測だけを見て結果を出す |
| canary / nonce | Lab にわざと置いておく目印（canary）。毎回違う使い捨ての値（nonce）を埋め、その値が外に出てきたり変わったりしたら「実際に届いた」と分かる。囮（おとり）と合い言葉の組み合わせ |
| proxy / recorder | 検証中の HTTP を記録する中継。Verifier の通信はここを通るので、判定器は「実際に送られたもの」を読める |
| 負の対照（negative control） | 修正版の plugin で同じ手順を再生し、効果が出ないことを確かめる作業。これが揃ったときだけ `contradicted` と言える |
| scenario（通常機能シナリオ） | 検証に必要な「ふだんの利用状態」を Lab に作る手順。版と digest で固定。足りないと `incomplete(precondition)` |
| runtime-confirmed / contradicted / incomplete | 検証結果の 3 値。確認できた / 反証できた / 判断に足る材料が無い。incomplete は陰性ではない |
| reproduced | 判定器が無い種類の Finding で、別の Lab で手順を再生できたときの結果。負の対照は未成立 |
| 台帳（ledger） | 追記専用の SQLite。何が起きたかの記録で、本文は持たず digest で指す |
| Private Evidence | 本文（候補、HTTP 記録、画面、認証情報、未公開の発見）を置く Git 外の保管先。台帳から digest で参照 |
| funnel | 台帳から出す「段ごとの件数」。候補 → 受理 → 検証 → 確認 → レビュー → 提出 → 結果と、各段で何件残ったかを 1 行で示す |
| review export | 人間がレビューする材料を 1 つの JSON にまとめた出力。skill はこれだけを読む |
| skill | 所有者または AI session が使う手順書付きの AI 補助。レビュー、重複照合、報告文、検証（`wbh-verify`）の 4 本。台帳を直接は書かない |
| continuous run | 選定から検証までを対象 5 件ずつ繰り返す無人運転。止まるのは決められた 6 つの理由だけ |
| owner-approved | agent に渡る文章と判定器などの重要 path に付ける印。これが無いと merge しない。2026-10-18 以降は委任済みの AI が差分を確認して付ける |

## 図と正本の対応

| 図 | 正本 | 用語（GLOSSARY） |
| --- | --- | --- |
| 第 1 段 | SPEC §2、§3、§4 | Campaign、Trial、Finding、Private Evidence |
| 2.1 | SPEC §3、§6、§7 | Target Snapshot、Lab、VerificationResult |
| 2.2 | SPEC §6、ADR 0029 | Trial、Discovery run |
| 2.3 | ADR 0018、0019 | 保留候補、Finding、Lead |
| 2.4 | SPEC §7、ADR 0022、0026 | 通常機能シナリオ、Reproduction Package |
| 2.5 | 最終設計 §3、§7 | — |
| 2.6 | SPEC §8、OPERATIONS §3 | Submission Candidate |
| 3.1 | SPEC §9 | Private Evidence |
| 3.2 | SPEC §9 | — |
| 3.3 | SPEC §7、§8、ADR 0031 | VerificationResult |
| 3.4 | SPEC §6、最終設計 D2 | Trial |
| 配置図 | SPEC §2 不変条件 2 | Lab |

コードの行番号は 2026-10-16 の main 時点。ずれたら file 名で探す。
