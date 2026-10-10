# アーキテクチャ図

目標構成を示す。実装済みとの差は [実装計画](IMPLEMENTATION-PLAN.md)、規則は [SPEC](SPEC.md) と [ADR 0016](adr/0016-root-plus-three-first-vertical-slice.md)。本番へ進む条件は [TranslatePressベンチマーク](TRANSLATEPRESS-BENCHMARK.md)。

## 0. 開発から本番への切り替え

```mermaid
flowchart LR
  START([開始]) --> BENCH[TranslatePress 3.2.6 / 3.3.1<br/>Root＋3を各1 Trial]
  BENCH --> GATE{1件を新Labで確認し<br/>修正版で同じ経路が不成立?}
  GATE -->|いいえ| FIX[故障箇所を診断して必要分だけ再試行]
  GATE -->|はい| PILOT[自動選定した最新版3対象<br/>本番探索パイロット]
  PILOT -->|実Finding| SUBMIT[最新版確認・重複照合・証拠<br/>人間Lab再現の後に提出]
  PILOT --> METRICS[費用と歩留まりから次を決める]
```

ベンチマークは配線の確認であり、発見率の証明ではない。レポートの完全自動化は本番探索開始の条件ではなく、実Findingが出たら提出前に完成させる。

## 1. どこから始まるか

```mermaid
flowchart LR
  START([開始]) --> CHOOSE{対象の種類}
  CHOOSE -->|開発・検証| PIN[人間が公開済みのslugと版を指定]
  CHOOSE -->|実運用| SEL[方針と公開データから自動選定]
  PIN & SEL --> SNAP[plugin・WordPress core・必要な依存を固定]
  SNAP --> LAB[gVisor Labを起動]
  LAB --> DISC[Root＋最大3 subagentで探索]
  DISC -->|Finding| VERIFY[別Labで独立検証]
  VERIFY -->|confirmed| LATEST[公開中の最新版で再検証]
  LATEST --> DEDUPE[重複・scope照合]
  DEDUPE --> REPORT[証拠付き英語レポートJSON]
  REPORT --> HUMAN[人間がLabで手動再現・査読]
  HUMAN --> APPROVE[人間が外部送信を承認・実行]
  DISC -->|Lead| NEXT[次の探索の問いとして保存]
  VERIFY -->|incomplete| RETRY[理由付きで再検証候補に保存]
```

開発対象では選定を待たない。報告候補は最新版で成立し、証拠と人間の手動再現を備えたものだけ。

## 2. 1つの協調Trial

```mermaid
flowchart TB
  INPUT[固定source・短い目的prompt・trust境界・Lab] --> ROOT[Root agent<br/>問いを立て分担し統合]
  ROOT --> A[subagent 1]
  ROOT --> B[subagent 2]
  ROOT --> C[subagent 3]
  A & B & C --> RESULTS[Finding / Lead / coverageを個別保存]
  ROOT --> RESULTS
  RESULTS --> LEDGER[(台帳にはdigestだけ)]
  RESULTS --> PRIVATE[(Private Evidenceに本文)]
  ROOT --> FINAL[最終JSON]
  FINAL -.整形失敗でも個別成果は残す.-> RESULTS
```

Harnessは人数上限、隔離、時間、記録、停止を管理する。Rootが調べ方を決め、Harnessのpromptに固定役割や探索手順を埋め込まない。同じ版の別Trialを回す外側のループは残すが、回数と停止値は実測後に決める。

## 3. 実行境界

```mermaid
flowchart LR
  subgraph HOST[ホスト]
    CLI[薄いCLI]
    BROKER[認証ブローカー]
    LEDGER[(追記専用台帳)]
    PRIVATE[(Git外のPrivate Evidence)]
  end
  subgraph DISC[gVisor使い捨て探索環境]
    AGENTS[Root＋最大3 subagent]
    LAB1[WordPress＋MySQL Lab]
    SOURCE[読み取り専用source]
    AGENTS <-->|内部HTTP| LAB1
    SOURCE --> AGENTS
  end
  subgraph VERIFY[gVisor使い捨て検証環境]
    VERIFIER[独立Verifier]
    PROXY[Harness HTTP捕捉proxy]
    LAB2[新しいWordPress Labとcanary]
    VERIFIER --> PROXY --> LAB2
  end
  CLI --> DISC
  CLI --> VERIFY
  AGENTS -->|認証情報なしのAPI要求| BROKER
  VERIFIER --> BROKER
  BROKER --> PROVIDER[(provider API)]
  DISC & VERIFY --> LEDGER
  DISC & VERIFY --> PRIVATE
```

対象コードはホストで実行しない。エージェントに渡すLab資格情報は未認証・subscriber・customerの範囲だけ。provider以外の外向き通信は認めない。

## 4. 「発見」と「確認」と「提出」

```mermaid
stateDiagram-v2
  [*] --> Finding: Rootまたは子がsource上の経路を主張
  Finding --> Incomplete: Lab・手順・証拠・digestの不足
  Finding --> Contradicted: 手順完走後に反証
  Finding --> Confirmed: Harness判定器がnonce canaryを回収
  Incomplete --> Finding: 別Labで再試行
  Confirmed --> Latest: 公開中の最新版で再検証
  Latest --> Review: scope・重複・英語文案と証拠
  Review --> HumanReproduced: 人間がLabで同じ手順を再現
  HumanReproduced --> Authorized: 版と送信先を指定して承認
  Authorized --> Submitted: 人間が送信
```

`Finding` は主張、`runtime-confirmed` は技術的確認、`Submission Candidate` は提出先の条件を満たした文案付きの候補で、それぞれ別の記録として扱う。
