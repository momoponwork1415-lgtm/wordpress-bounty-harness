# アーキテクチャ図

理解用。境界の詳細は [SPEC.md](SPEC.md) 第4節・第5節、流れの説明は [DESIGN-WALKTHROUGH.md](DESIGN-WALKTHROUGH.md)。図はGitHubがそのまま描く（Mermaid）。

## 図1. 実行時の構成（何がどこで動き、何と通信できるか）

```mermaid
flowchart TB
  subgraph HOST[ホスト（WSL2 / Linux）]
    CLI[cli]
    SEL[selection]
    SNAP[snapshot]
    LED[(ledger<br/>SQLite 追記専用)]
    PE[(Private Evidence<br/>Git外 content-addressed)]
    BRK[egress broker<br/>provider認証情報はここだけ]
    REV[review CLI]
    EVAL[evaluation]
  end
  subgraph RUN1[gVisor: discovery run #n（runごとに使い捨て）]
    AG1[agent container<br/>Codex CLI + 読み取り専用source<br/>prompt / trust境界 / 担当file / 履歴]
    LAB1[Lab container<br/>WordPress + MySQL + plugin<br/>canary / subscriber account]
    AG1 <-->|HTTP（internal networkのみ）| LAB1
  end
  subgraph RUN2[gVisor: verification（Findingごとに使い捨て）]
    VER[Verifier container<br/>Finding + source だけ]
    LAB2[新しいLab]
    JUDGE[判定器（Harnessのコード）<br/>canary回収を観測]
    VER <-->|HTTP| LAB2
    JUDGE -->|読む| LAB2
  end
  WPORG[(WordPress.org)] -->|zip取得| SNAP
  SEL --> SNAP --> RUN1
  AG1 -->|API呼び出し（認証なし）| BRK -->|認証付き| OAI[(provider API)]
  VER --> BRK
  RUN1 -->|Finding| RUN2
  RUN1 --> LED
  RUN2 --> LED
  RUN1 --> PE
  RUN2 --> PE
  LED --> REV
  PE --> REV
  LED -.読むだけ.-> EVAL
  HUMAN((人間)) <--> REV
  HUMAN -->|手で送信| PROG[(Wordfence / Patchstack)]
  PROG -.転帰を人間が記録.-> REV
```

- agentとLabは同じrunのinternal networkだけで通信する。agentから外へ出られるのはbroker経由のprovider APIだけ。
- agent / Verifierに渡る認証情報は未認証・subscriber・customerのLabアカウントだけ。管理者とcontributor以上は渡らない。
- 台帳はdigest参照だけを持ち、payloadや画面画像はPrivate Evidenceに置く。

## 図2. 契約の流れ（モジュール間で渡るもの）

```mermaid
flowchart LR
  P[/方針ファイル<br/>人間が編集/] --> SEL[selection]
  SEL -->|TargetSelection v1| SNAP[snapshot]
  TB[/trust境界宣言<br/>人間が書く/] --> SNAP
  HIST[(Wordfence履歴DB<br/>ローカルmirror)] -->|時点で切った履歴| SNAP
  SNAP -->|CampaignInput v1<br/>digest / 宣言 / 履歴 / prompt digest / 停止規則| DISC[discovery]
  DISC -->|Finding v1 × 0..n| VERI[verification]
  VERI -->|VerificationResult v1<br/>confirmed / contradicted / incomplete<br/>+ 再現パッケージref| LED[(ledger)]
  DISC --> LED
  LED -->|queue| REV[review]
  REV -->|ReviewDecision v1| LED
  REV -->|SubmissionCandidate v1| AUTH[External Action Authorization]
  AUTH --> LED
  LED -.read.-> EVAL[evaluation]
  KEY[/答えの鍵<br/>評価側だけ/] --> EVAL
```

## 図3. Campaignと探索runの中身

```mermaid
flowchart TB
  subgraph CAMPAIGN[Campaign（対象1つ）]
    direction TB
    PART[profileが入口単位で<br/>file分担を作る] --> Q[run待ち行列<br/>最大N=40]
    Q --> R1[run 1] & R2[run 2] & R3[run 3] & R4[run 4]
    R1 & R2 & R3 & R4 --> STOP{新規Findingなしが<br/>k=4回連続?}
    STOP -->|いいえ| Q
    STOP -->|はい| END[停止・台帳へ]
  end
  subgraph ONERUN[run 1つの中（agentの裁量。Harnessは手順を指定しない）]
    direction TB
    IN[受け取る: prompt / trust境界 /<br/>担当file / Lab + subscriber認証 / 履歴] --> E1[入口を列挙<br/>wp_ajax_nopriv / REST / shortcode / $_GET]
    E1 --> E2[誰が叩けるか<br/>nonce? capability? login?]
    E2 -->|subscriber以下で届く| E3[危険な到達点まで追う<br/>SQL / file / option / role / 出力]
    E3 --> E4[途中のcheckを評価<br/>prepare / sanitize / esc / path検査]
    E4 --> E5{欠けている?}
    E5 -->|仮説あり| E6[Labに実際に送る<br/>canaryが動いたか自分で見る]
    E6 -->|成立| F[Findingを書く<br/>攻撃者位置 / 分類 / 経路 / 観測]
    E6 -->|不成立| E4
    E5 -->|なし| NX[次の入口]
    NX --> E2
    F --> OUT[出力: Finding[] + 読んだ範囲 / 読まなかった範囲]
    NX -.全部見た.-> OUT
  end
  R1 -.-> ONERUN
```

- runは互いを知らない。同じ場所を複数のrunが独立に指せば、それが確度の根拠になる。
- 1回で見つかる確率 p のとき、k 回で1度でも見つかる確率は 1 − (1 − p)^k。

## 図4. 検証: Verifierと判定器の分業

```mermaid
flowchart LR
  F[Finding] --> NL[新しいLab供給<br/>同じsnapshot digest / 既定設定 / canary再配置]
  NL --> V[Verifier（LLM、新しいコンテナ）<br/>会話履歴なし<br/>役割: 手順を整える・反証する<br/>再探索はしない]
  V --> EX[手順を実行<br/>subscriber以下の認証だけ]
  EX --> J[判定器（コード）<br/>分類ごとの成功条件]
  J -->|nonce回収あり| C[runtime-confirmed<br/>+ 観測した条件<br/>+ 再現パッケージ生成]
  J -->|手順完走・条件なし・反証あり| X[contradicted]
  J -->|環境 / 前提 / 観測 / 証拠 / digest不一致 / 判定器なし| I[incomplete<br/>+ 理由コード + 次の手]
  C & X & I --> LED[(ledger<br/>digest一致時のみ有効)]
```

## 図5. 対象範囲を効かせる4か所

```mermaid
flowchart LR
  S[selection<br/>除外リスト・閾値<br/>機械的] --> L[lab<br/>subscriber以下の認証だけ<br/>既定設定<br/>機械的] --> D[discovery<br/>promptで分類と報奨順を誘導<br/>誘導のみ] --> VJ[verification<br/>判定器の条件=受理条件<br/>機械的] --> RS[review<br/>scope評価は観測と規則から<br/>Wordfence / Patchstack別<br/>機械的]
```

## 図6. Funnel（台帳から読む）

```mermaid
flowchart LR
  A[raw Finding] --> B[verifier通過] --> C{判定}
  C --> C1[runtime-confirmed]
  C --> C2[contradicted]
  C --> C3[incomplete]
  C1 --> D[人間レビュー済]
  C3 -->|再検証| C
  D --> E{scope}
  E --> E1[Wordfence in-scope]
  E --> E2[Patchstack in-scope]
  E --> E3[out / ambiguous]
  E1 & E2 --> G[submitted] --> H[outcome<br/>triaged / resolved / duplicate / informative / N/A / rejected]
```

## 図7. 評価は本番の中で行う

```mermaid
flowchart TB
  T[本番対象] --> A[runの半分: 構成A<br/>例: 短い目的prompt / 履歴あり]
  T --> B[runの半分: 構成B<br/>例: wp2shell由来 / 履歴なし]
  A & B --> V[検証 → 台帳（runごとの構成を記録）]
  V --> SUB[どちらが見つけても提出]
  V --> CMP[対象をまたいで対で集計<br/>当たり率と費用、区間付き]
  V -.数か月後.-> PRO[前向き評価<br/>公開されたadvisoryで再採点<br/>見逃しを数える]
  V --> OUT[提出転帰<br/>収益の式の各項]
```
