<!-- provenance: /home/dev/legacy-codex-satoki-deep-campaign-refactor-2026-07-26/uncommitted/docs/codexidea-thin-harness-risk-audit-2026-07-24.md, mtime 2026-07-24, imported 2026-10-13, generation 07-bug-bountgy -->

# CodexIdea: Thin Harness の証拠・権限・探索効率を再設計する

Status: Claude への設計レビュー用提案  
Observed: 2026-07-24  
Current implementation: Thin Harness v0.3.0  
Scope: 現行Campaign、Agent sandbox、WordPress Lab、Lead promotion、Human Gate、outcome feedback

## 1. 結論

現行Harnessの主な問題はAIの探索能力ではない。AIが見つけた候補を、信頼できる
技術証拠へ変換する境界が弱いことである。

現在は一つのAI Attemptが、次の権限と責務を同時に持つ。

- subscription credentialを利用するProvider process
- untrusted plugin sourceを読むresearcher
- 外部networkへ到達可能なshell
- 管理者WP-CLIを使うLab setup actor
- 低権限攻撃を行うattacker
- DB、log、traceを読むobserver
- Negative Controlとreport readinessを宣言するjudge

この責務集中により、Promptに従う正常なAIでは有用な成果を出せる一方、Prompt
injection、誤操作、証拠汚染、自己評価の誤りをhard boundaryで防げない。

最優先案は、現行の自由なAI Attemptを`Exploration`として残しつつ、Human Gateの前に
credential-free、network-denied、actor-separated、pristine-sourceのFormal Trialを
追加することである。AIの文章だけではCandidateをpromotionしない。

## 2. 現行フロー

```text
Pinned Target × Strategy
        |
        v
fresh AI Attempt
  source + rg/Semgrep/PHP/Python/curl
  subscription credential
  shared external network
  arbitrary local WP-CLI through labctl
        |
        v
AI-authored structured Lead
        |
        +-- trial_worthy=false --> knowledge / saturation
        |
        v
Inner refinement Attempt
        |
        v
AI says report-ready
  + source reference exists
  + reproduction text exists
  + >=1 Negative Control says passed
  + blockers is empty
        |
        v
Human Gate
```

Current executable architecture is documented in
[`architecture.md`](./architecture.md). The implementation is primarily
[`agent_runtime_lib.py`](../harness/scripts/agent_runtime_lib.py),
[`agent_lab_lib.py`](../harness/scripts/agent_lab_lib.py), and
[`thin_campaign_lib.py`](../harness/scripts/thin_campaign_lib.py).

## 3. 現状データ

2026-07-24時点の`artifacts/runs/*/campaign-state.json`とAttempt artifactの集計:

| Observation | Count |
|---|---:|
| Campaign runs | 39 |
| Attempts | 66 |
| Completed Attempts | 33 |
| Failed / incomplete / infrastructure-failed Attempts | 33 |
| `operator-attention-required` Campaigns | 25 |
| Yielded Outer arms | 15 |
| Human Queue entries | 6 |
| Recorded accepted / paid outcomes | 0 / 0 |
| Reported processed tokens | 431,761,445 |
| Attempts with a non-empty `/workspace/evidence` | 13 / 66 |
| Current `artifacts/runs` size | about 1.3 GB |

`processed tokens`は費用ではない。また後述のとおり、cached inputを二重計上している
可能性がある。

## 4. P0: 直ちに塞ぐべき境界

### P0-1. Subscription credentialとuntrusted research shellが同じsandboxにある

`SubscriptionAgent`はCodexまたはClaudeの再利用可能なcredential fileを
`/home/agent/...`へread-only mountする。同じBubblewrap内でAgentはshell toolを実行し、
Codexは`--dangerously-bypass-approvals-and-sandbox`で起動される。

Read-onlyは改変を防ぐだけで、読取・表示・network送信を防がない。plugin sourceは
untrusted dataであり、Prompt injectionに成功したsourceや誤動作したAgentがcredential
を読む余地がある。

さらにBubblewrap invocationには`--unshare-net`がなく、`/etc/resolv.conf`もmountされる。
Provider API通信に必要なnetworkと、Agentが使う`curl`等のtool networkが同じnamespace
である。公開targetへ接続しないという制約はSystem Promptにあるが、technical
enforcementではない。

Relevant code:

- `harness/scripts/agent_runtime_lib.py`: `SubscriptionAgent.invocation`
- `harness/scripts/agent_runtime_lib.py`: `BubblewrapSandbox.invocation`
- credential `--ro-bind`
- absence of `--unshare-net`

Impact:

- reusable subscription credentialの漏えい
- public target、vendor、webhook等への意図しない通信
- target sourceによるPrompt injectionのblast radius拡大

Recommended design:

1. Provider control planeとtool execution planeを別process / namespaceにする。
2. Provider credentialはresearch tool namespaceへmountしない。
3. Providerは外側でmodel APIだけを呼び、tool requestをcredential-free brokerへ渡す。
4. Research tool planeはdefault network-deniedにし、loopback Lab socketだけを公開する。
5. 公開metadata取得が必要なら、別のread-only fetch brokerをdomain、method、size、
   content hash付きでallowlistする。
6. Credential fileをchild toolから隠せない構成はpromotion-capable environmentとして
   使用しない。

Acceptance criteria:

- Agent shellからcredential pathを`stat`または`cat`できない。
- Agent shellの`curl https://example.com`が失敗する。
- Provider API通信は継続できる。
- loopback Lab通信だけは成功する。
- malicious source fixtureを使ったcredential-read / egress testがCIで失敗閉鎖する。

### P0-2. Exploration、Setup、Attacker、Observer、Judgeが分離されていない

`labctl wp`は`--ssh`と`--http`を拒否するが、それ以外のWP-CLI argumentをほぼそのまま
受け付ける。Agentは`wp eval`、`wp db query`、user update、option update、fixture作成等を
同じAttempt内で実行できる。これは探索には便利だが、次を機械的に区別できない。

- setupとして行った管理者操作
- 攻撃者が実際に到達できるHTTP操作
- observerだけが見てよいDB値
- 攻撃成功後にAgentが補助的に変更した状態

AIは自分の実験を自分で採点するため、admin-only操作をattack resultへ混入させても
`_report_ready`は検出できない。

Recommended design:

- Exploration Labは現状の自由なWP-CLIを維持してよいが、出力は常にnon-authoritativeにする。
- Formal Trialを別fresh Labで実行する。
- Setup actorだけがWP-CLI / DB writeを持つ。
- Attacker actorは宣言済みHTTP/browser操作と最低攻撃者credentialだけを持つ。
- Victim actorは別cookie jar / browser contextを持つ。
- ObserverはHTTP/DB/DOM/filesystemを読めるが、その値をAttacker入力へ戻さない。
- Oracleは凍結済み条件だけを評価し、AI文章を入力にしない。

Acceptance criteria:

- Attacker phaseからWP-CLI、DB、admin cookie、victim cookieへ到達できない。
- operation logの各行にactor、phase、capability、trial identityが付く。
- Setup observationをattack successとして参照するとTrialがinvalidになる。

### P0-3. Modified sourceで得た結果をpristine sourceで再現する強制がない

PromptはAgentに`/workspace/source`の変更と`labctl sync`を許可している。これはdiagnostic
instrumentationに有用だが、`final_identity`は記録されるだけで、Human Gate判定へ
結合されていない。

そのため理論上は、Agentがsourceを変更した後の挙動を脆弱性再現として報告しても、
source evidence、reproduction text、passed control、empty blockersがあればpromotion
条件を満たし得る。

Recommended design:

- source mutationを使用したAttemptは`exploration-only`とする。
- promotion前に元のTarget Snapshot hashからfresh Labを作る。
- Formal Trial終了後にもsource tree hashを再計算する。
- initial hash、final hash、Target Snapshot hashの完全一致を必須にする。
- instrumentationが必要な場合は、plugin source外の固定MU-plugin / proxy / observerだけを
  使う。

### P0-4. AIの自己申告だけでHuman Gateへ進める

Current `_report_ready` conditions:

- `status == report-ready`
- `trial_worthy == true`
- source evidence listがnon-empty
- reproduction text listがnon-empty
- `passed`と書かれたNegative Controlが一つ以上
- blockers listがempty

これは「報告書の形」を確認するが、「試験が実行され、記載どおりの結果だった」ことを
確認しない。AIがblockerを省略することも、意味の弱いcontrolを`passed`にすることも
可能である。

Recommended design:

- AI LeadからHuman Queueへの直接遷移を廃止する。
- AI Leadは最大でも`candidate-supported`とする。
- Human Queueへ入れるのはFormal Trial resultをdeterministic verifierが検証した後だけにする。
- Negative Controlは説明文ではなく、同一Trial manifestの別profileとして実行する。
- minimum controlは少なくとも以下の二種類とする。
  - authorization/identity control
  - payload/object-binding/route discriminator
- SQLi、XSS、file、auth等のclass-specific oracleを登録する。

## 5. P1: 正確性、安全性、bounty yieldを大きく損なう問題

### P1-1. Raw evidenceがLead promotionへ結合されていない

66 Attempt中、non-emptyな`workspace/evidence`を持つのは13 Attemptだけである。
`experiments[].artifact_paths`は存在確認、hash確認、Attempt配下へのcontainment確認を
されない。実際のAttemptには`/tmp/...`をartifact pathとして返す例があり、説明は残るが
提出時に確認できるraw resultが残らない。

`_evidence_inventory`は存在するevidence fileをhash化するが、`_report_ready`はinventoryを
要求しない。

Recommended design:

- experiment artifact pathを`workspace/evidence`相対に限定する。
- path existence、regular file、size、SHA-256をAttempt終了時に検証する。
- Leadごとに使用したartifact hashを列挙する。
- request、response、DB delta、DOM observation、traceをtyped artifactにする。
- response body全体を保存できない場合も、必要部分、length、hash、status、timing、
  redaction metadataを残す。
- missing artifactは`incomplete`ではなく`candidate-unverified`として安全に降格する。

### P1-2. Scope factsとstanding authorizationのruntime enforcementが不足する

Campaign loaderはscope facts fileを読み、snapshot ID、closed状態、明示out-of-scope程度を
確認する。しかしscope facts自体はAgent promptへstageされず、program briefはoptionalで
ある。

またConfigに`authorization.standing_authorization`があっても、loaderはそのpath、
content、hash、対象data classを検証しない。実際にrunを許可する主要条件は
`external_ai == approved`である。

不足しているgate:

- observation dateのfreshness / TTL
- program statusとVDP availability
- install threshold
- vulnerability-class-specific eligibility
- duplicate / exclusivity policy
- authorization artifactの存在、内容、hash binding

Impact:

- source-level program gateより先に高価なLab / AI Attemptを実行する
- stale scopeで調査する
- Config上のauthorization表示と実際のenforcementが一致しない

Recommended design:

- authorization artifactをCampaign identityへhash-bindする。
- scope factsをAgentへread-only dataとしてstageする。
- `observed_at`とclass-specific TTLを必須にする。
- runtime前のcheap program gateと、submission前のlive human refreshを分ける。
- missing/stale factsではruntimeを開始せず`scope-refresh-required`にする。

### P1-3. Lab operation logがsecretや不要なraw dataを保持し得る

`LabBroker`はcommand、全args、stdout、stderr、errorを
`lab-operations.jsonl`へ記録する。WP-CLI argumentにはpassword、token、SQL、nonce等が
入り得る。stdoutにはuser table、option、hash、private fixture dataが入り得る。

Prompt、provider stdout/stderrもそのまま保存され、Promptにはdisposable admin passwordが
含まれる。

Recommended design:

- command-specific redaction schemaを使う。
- `--user_pass`、cookie、Authorization、nonce、token、raw SQL resultを標準でredactする。
- operation artifactにはvalue hash、expected-match、row countを優先する。
- raw secretが必要な場合は短命のprivate vaultへ分離し、report bundleへ入れない。
- artifact scannerでcredential patternを検査する。

### P1-4. Failure率が高く、失敗がyield budgetを消費する

66 Attempt中33だけがcompletedで、25/39 Campaignが`operator-attention-required`である。
8件のincompleteはsandbox path形式とvalidatorの不一致だった。現行HEADには
`/workspace/source/` prefix対応があるが、既存Campaign stateは自動回復していない。
9件の`failed`はAttempt artifactに人間がすぐ理解できるfailure reasonを埋め込んでいない。

Recommended design:

- provider failure、schema failure、source-reference failure、Lab failure、operator interruptを
  typed taxonomyにする。
- retryable failureとsemantic no-yieldを完全に分ける。
- validation errorの場合はProviderのstructured resultをquarantine保存する。
- known mechanical normalizationは再課金なしでlocal repairする。
- `doctor`に実Provider schema round-trip smoke testを追加する。
- failure-rate SLOを設定し、閾値超過時はCampaign追加投入を止める。

### P1-5. 一つのLeadが残りの探索を止める

Outer armは一つでもpromising Leadを返すと`yielded`になり、同じstrategy内の残余探索へ
戻らない。後でLeadがrefuted、parked、not-submittedになってもarmは再開されない。

さらにHuman Queueが一件でもあるとCampaign全体が`human-review-required`で停止する。
最初に見つかったMedium Leadが、後続strategyのHigh/Critical探索を止める場合がある。

これは「報告可能なbounty yieldを最大化する」という目的と衝突し得る。

Recommended design:

- `yielded`と`exhausted`を別状態にする。
- Lead発見後もresidual exploration budgetを保持する。
- Leadがrefuted / ineligible / duplicateならsource armを自動再開する。
- Human Queueはsubmission actionだけを止め、独立したread-only discovery armは継続可能にする。
- lead priorityをimpact、eligibility、confidence、cost-to-proofで計算し、単純なfirst-foundを避ける。

### P1-6. Continuous modeにglobal resource ceilingがない

Attemptごとのtimeoutはあるが、Campaign全体のtoken、Attempt、wall-clock上限がない。
Codex profileにはprovider cost limitもない。

Lead fingerprintが少しずつ変わると`stale_steps`がresetされるため、Inner Loopは表面的な
noveltyを出し続けて長時間走れる。

Recommended design:

- hard safety ceilingとsoft yield budgetを分ける。
- Campaign max attempts、max processed input、max wall timeを必須にする。
- per-root-cause refinement ceilingを持つ。
- ceiling到達は脆弱性否定ではなく`budget-exhausted`にする。
- resumeには人間の明示budget追加を要求する。

### P1-7. Outcome state machineがacceptedからpaidへの後続更新を表現できない

`record_human_outcome`はHuman Queueに存在するRoot Causeだけを更新し、outcome記録後に
Queueから削除する。そのため先に`accepted`を記録すると、後日同じRoot Causeへ`paid`を
記録できない。現在のtestは最初から`paid`を記録し、acceptedとpaidを同時加算する経路だけを
検証している。

Recommended design:

```text
human-review
  -> not-submitted | rejected | duplicate
  -> submitted
  -> accepted
  -> paid
```

各transitionをappend-only eventとして保存し、同じFindingのlifecycleとrewardを追跡する。

### P1-8. 現行Architectureと旧設計文書が矛盾する

[`system-overview.md`](./system-overview.md)と
[`accepted-system-design.md`](./accepted-system-design.md)はfull AST、Typed Trial、
actor separation、3+3 promotion等を「Implemented」と記載する。一方、現行
[`architecture.md`](./architecture.md)はv0.2でそれらを削除したと明記する。

この差は、操作者やreviewerが実際より強い検証を通っていると誤認する原因になる。

Recommended design:

- current docsの正本を一つにする。
- 旧設計は`legacy/`へ移し、各文書先頭にnon-current bannerを付ける。
- capability matrixをCIで実装から生成する。

## 6. P2: 品質と効率を継続的に下げる問題

### P2-1. Privilege gateが自由文の正規表現に依存する

`_privilege_exit_reason`は`attacker_role`文字列からrole/capabilityを推測する。
先頭が`Contributor`等なら停止するが、曖昧な表現、複合条件、誤分類されたcustom role、
本文に埋め込まれたcapabilityを完全には扱えない。

Recommended schema:

```json
{
  "authentication": "unauthenticated|authenticated",
  "default_role": "none|subscriber|customer|contributor|author|editor|administrator|other",
  "required_capabilities": [],
  "plugin_granted_role": null,
  "how_role_is_obtained": "default-registration|checkout|admin-assigned|unknown"
}
```

Machine gateはこの構造だけを使い、自由文は説明用にする。

### P2-2. Source evidenceはpath存在しか強く検証していない

Provider schemaはlineを要求するが、post-validatorは`{"path","reason"}`も受理する。
lineがfile length内か、記載したsymbolやsnippetがその行に存在するかは確認しない。

Recommended design:

- source tree hash、path、line range、snippet hash、symbol identityをEvidence Refにする。
- modified working copyではなくpinned original sourceからresolveする。
- unresolved referenceが一件でもあればpromotionしない。

### P2-3. Post-validatorがResult Schemaを完全には再検証しない

`_validate_result`は`experiments`がlistであることは見るが、各experimentのshape、
artifact path、文字列長等を再検証しない。Provider-side JSON Schemaに依存している。

Recommended design:

- 一つのJSON Schema validatorをProvider前後で共用する。
- semantic validationを別layerで行う。
- Claude、Codex、fixtureの全adapterへ同じcontract testを実行する。

### P2-4. Lead fingerprintとstaleness判定が不安定

Fingerprintには説明文、evidence順序、reproduction等が入り、表現を少し変えるだけで
novelty扱いになる。一方、`attacker_role`、`next_experiment`、confidenceは含まれず、
重要な権限変更がstale扱いになる場合がある。

また既存Leadの`trial_worthy`とconfidenceは過去値とのOR / maxで保持されるため、後の
Attemptが評価を下げてもscheduler上の優先度が残りやすい。

Recommended design:

- semantic root cause identityとevidence revisionを分離する。
- noveltyは新しいsource edge、runtime observation、control result、impact end-stateだけで増やす。
- confidenceは履歴を残しつつcurrent valueを更新する。
- prose changeでbudgetを延長しない。

### P2-5. `root_cause_id`をAIへ完全に委ねている

同一root causeでもAgentごとに別IDを付ければ重複Leadになり、異なるroot causeへ同じIDを
付ければ上書きされる。exact string match以外のmerge/refutation relationがない。

Recommended design:

- entrypoint、guard、sink、persistent storage、impact objectからstable fingerprintを作る。
- AI IDはaliasとして残す。
- `same-root`、`sibling`、`chain-component`、`independent` relationを持つ。

### P2-6. Stale threshold 1のCampaignが多く、偽陰性を増やす

調査したConfig群では`outer_stale_attempts_before_rotate == 1`が32件、
`inner_stale_steps_before_park == 1`が28件あった。一回のno-yieldまたは一回のselected
Lead omissionでarm / Leadを止める構成である。

`saturated`は安全性の証明ではないが、運用上は次targetへ進むため、探索漏れが見えにくい。

Recommended design:

- target size、surface count、strategy breadth、model varianceからminimum coverage budgetを決める。
- saturationには未探索surfaceとlimitationを必須にする。
- high-value targetは少なくとも独立二視点を要求する。

### P2-7. Token metricがcached inputを二重計上している可能性がある

`_normalize_tokens`は`input_tokens`、`cached_input_tokens`、
`cache_creation_input_tokens`、`output_tokens`をすべて加算する。Providerでcached inputが
input tokensの内数なら、`total_processed_tokens`は過大になる。

Recommended design:

- Providerごとのusage semanticsを明示する。
- billed-equivalent、logical input、cache read、outputを別metricとして保持する。
- cross-provider比較に未検証の合算値を使わない。

### P2-8. ArtifactがAttemptごとにsource全体を複製する

現時点で`artifacts/runs`は約1.3 GBであり、各Attemptはsource copy、provider log、
Lab operation log等を保持する。再現性には有用だが、同一sourceの重複が大きい。

Recommended design:

- pinned sourceをcontent-addressed storeに一度だけ保存する。
- Attemptはsource hashと差分だけを持つ。
- diagnostic mutationはpatch artifactにする。
- retention policyはverified lead、failed infrastructure、no-yieldで分ける。
- deletionは明示ledgerとrecoverable archiveを使う。

### P2-9. 実際のbounty outcomeで戦略をまだ校正できていない

15 yielded armsと6 Human Queueがあるが、accepted / paid outcomeは0である。現時点では
`trial_worthy`やHuman Queue到達が真のbounty yieldを予測するか検証できない。

Recommended design:

- accepted、duplicate、rejected、paid、reward、time-to-triageをstrategy / model /
  vulnerability classへ結合する。
- enough outcomesが集まるまではconfidenceをbusiness metricとして扱わない。
- duplicateとprogram-ineligibleをtechnical refutationから分離する。

## 7. 推奨する実装順

### Phase 0: Credentialとegressを隔離する

1. Provider control planeとresearch tool planeを分離する。
2. credentialをtool planeから不可視にする。
3. tool planeをnetwork-deniedにする。
4. malicious source security testを追加する。

このPhaseが完了するまで、untrusted plugin sourceを読むAttemptへ再利用可能なcredentialを
直接mountする設計を安全と見なさない。

### Phase 1: PromotionをFormal Trialへ移す

1. AI LeadからHuman Queueへの直接遷移を止める。
2. typed Trial manifestを導入する。
3. Setup / Attacker / Victim / Observer / Oracleを分離する。
4. raw artifactとNegative ControlをTrial identityへhash-bindする。
5. pristine source replayを必須にする。

### Phase 2: Scope、reliability、state machineを直す

1. authorization artifactとscope factsをhash-bindしfreshnessを検証する。
2. mechanical output errorをlocal repair可能にする。
3. accepted -> paidを含むappend-only outcome lifecycleを導入する。
4. artifact redactionとsecret scannerを追加する。

### Phase 3: Bounty yieldを改善する

1. yielded armのresidual explorationを再開可能にする。
2. global / per-root resource ceilingを導入する。
3. structured privilege gateとsemantic root-cause identityを導入する。
4. accepted / paid outcomeでstrategyとmodelを校正する。
5. current documentationを一本化する。

## 8. 最小の新しいpromotion contract

```json
{
  "candidate_id": "stable-semantic-id",
  "target_snapshot_sha256": "...",
  "lab_environment_digest": "...",
  "trial_manifest_sha256": "...",
  "minimum_attacker": {
    "authentication": "unauthenticated",
    "default_role": "none",
    "required_capabilities": []
  },
  "profiles": {
    "vulnerable": {
      "actor_separation_verified": true,
      "pristine_source_verified": true,
      "oracle_passed": true,
      "observation_artifacts": ["sha256:..."]
    },
    "authorization_negative_control": {
      "oracle_passed": true,
      "observation_artifacts": ["sha256:..."]
    },
    "payload_or_object_negative_control": {
      "oracle_passed": true,
      "observation_artifacts": ["sha256:..."]
    }
  },
  "scope_gate": {
    "facts_sha256": "...",
    "observed_at": "...",
    "fresh": true
  },
  "promotion": "candidate-supported"
}
```

AIはこのmanifestを提案できるが、値を確定しない。Harnessがfresh Trialの実行結果から生成する。

## 9. Claudeへのレビュー依頼

Claudeには以下を依頼する。

1. P0-1のcredential / network分離案が、Codex CLIとClaude Code CLIの両方で実装可能か
   threat-model reviewする。
2. 自由なExplorationを失わず、Formal Trialだけをhard capability separationする最小構成を
   提案する。
3. 現行`thin_campaign_lib.py`から段階移行できるstate machineを設計する。
4. raw evidence、pristine replay、Negative Controlをpromotionへ結合する最小schemaをレビューする。
5. 既存のcandidate-specific Trialを再利用できるmigration pathを示す。
6. 変更量よりも、credential safety、evidence integrity、reportable bounty yieldを優先する。

## 10. Non-goals

- AIの探索を静的sink scannerだけへ戻すこと
- 公開targetに対するruntime test
- 自動submission
- 高権限Leadの深化
- Human Gateの廃止
- AI文章やconfidenceをtechnical verdictとして扱うこと

