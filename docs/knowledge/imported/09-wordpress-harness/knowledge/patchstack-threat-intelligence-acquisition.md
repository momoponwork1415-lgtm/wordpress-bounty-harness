<!-- provenance: /home/dev/wordpress-harness/docs/knowledge/patchstack-threat-intelligence-acquisition.md, mtime 2026-09-19, imported 2026-10-13, generation 09-wordpress-harness -->

# 調査資料: 既知重複を確認する情報源

状態: 一次資料に基づく調査、2026-09-05
取得日: 2026-09-05

## 結論

Issue #102では **Patchstack Threat Intelligence APIもpublic databaseの自動取得も採用しない**。Known Duplicate確認のIntelligence Sourceは、Issue #94のWordfence Intelligence v3 Production snapshotだけに固定する。

この変更は「Wordfenceにrecordがなければ未知」とするものではない。結果はversionedな `known-duplicate / not-observed / conflicting / unavailable` のいずれかとし、空結果、取得失敗、古いsnapshotをfalse-clearへ丸めない。

## 決定の境界

### 採用する

- Wordfence Intelligence v3 Production snapshotをprimary structured sourceにする。
- Finding成立後だけ、Wordfence exact recordをKnown Duplicate照合へ開示する。
- Wordfence snapshotの取得と判定provenanceを残す。
- Oracleを含むrecordと比較根拠はHuman OSのPrivate Evidence Bundleへ置く。

### 採用しない

- Patchstack API、Patchstack public database HTML、非公開endpointの自動取得。
- Patchstack pageをKnown Duplicate判定のauthorityにすること。
- Web検索、別vulnerability database、advisory aggregatorをrequired duplicate sourceにすること。
- known recordをTarget Intake、Selection Receipt、Research inputへ渡すこと。
- 「recordなし」をduplicateなしの保証にすること。

## Wordfence Intelligenceを第一の情報源にできる理由

| 観点 | 確認できた事実 | Harnessへの含意 |
| --- | --- | --- |
| Access | v3はProductionとScannerの二つを提供し、両endpointとも追加parameterなしでcomplete feedを返す。ProductionはWordfence teamがfully analyzedした詳細recordで、Bearer API keyを要求する（[v3 documentation](https://www.wordfence.com/help/wordfence-intelligence/v3-accessing-and-consuming-the-vulnerability-data-feed/)）。 | #94どおりProduction responseをatomic snapshot化し、point search endpointを仮定しない。credentialはSecretRefから注入する。 |
| Schema | rootはWordfence UUIDをkeyにしたJSON objectで、software type/name/slug、affected version interval、patched state/version、published/updated、reference、CVE、CWE、CVSS、copyright metadataを持つ（[v3 data format](https://www.wordfence.com/help/wordfence-intelligence/v3-accessing-and-consuming-the-vulnerability-data-feed/#data-format)）。 | Plugin Identityとverified versionをslugだけへ縮退せず、validated schemaとversion range parserで照合できる。schema driftやrange parse失敗はtyped failureにする。 |
| Change tracking | Webhookはrecordのcreated、replaced、deletedを通知し、raw payloadはHMAC-SHA-256で検証できる（[Webhook documentation](https://www.wordfence.com/help/wordfence-intelligence/wordfence-intelligence-webhook-notifications/)）。 | Webhookはrefresh hintにできるが、missed deliveryを考慮してcomplete snapshotをcanonical stateとする。署名未検証eventでcurrent pointerを変えない。 |
| License | 2026-01-26版Wordfence Intelligence TermsはServiceを無償提供し、契約条件の下でreproduction、derivative works、display、sublicense、distributionのperpetualなlicenseを与える。ただしcopyにはDefiantのcopyright designation、license、開示されたlicensor licenseの再掲が必要である（[Wordfence Intelligence Terms §§1–3](https://www.wordfence.com/wordfence-intelligence-terms-and-conditions/)）。 | local snapshotと派生indexは利用可能だが、recordごとのcopyright objectを捨てない。外部表示またはcopyにはrecord linkと該当notice/licenseを引き継ぐ。 |
| Credentials / quota | API利用にはactive accountと秘密のAPI keyが必要で、Wordfenceはrate limit、quota、throttling、suspensionを課せる（[Wordfence Intelligence Terms §§2–3](https://www.wordfence.com/wordfence-intelligence-terms-and-conditions/)）。 | keyをartifact、log、error、Gitへ残さない。auth、429、quota、revocationは`unavailable`側へ倒し、前回snapshotをsilentにfresh扱いしない。 |
| Availability / completeness | Wordfenceはendpointがcomplete feedを返しdatabaseを継続更新すると説明する一方、一般Terms of ServiceはService availabilityを保証しない（[v3 documentation](https://www.wordfence.com/help/wordfence-intelligence/v3-accessing-and-consuming-the-vulnerability-data-feed/)、[Terms of Service: availability](https://www.wordfence.com/terms-of-service/)）。 | 「feed全体を取得した」と「世界中の既知情報を完全に含む」を区別する。fresh snapshotのno-matchも`not-observed`でありnegative proofではない。 |

## 安全な契約

### 1. 入口の判定

Exact Known Duplicate確認を開始できるのは、Human OSが所有するversioned verified-Finding handoffをTarget Intelligenceのpublic seamで真正性確認できた後だけとする。

最低限、gateは次を満たす。

- immutable handoff referenceとschema versionを受け取る。
- Human OSが発行したdurable recordをpublic seam越しにresolveし、Finding identity、Target binding、verification stateを検証する。
- callerが渡したboolean、任意の`verifiedFindingRef`文字列、Finding payloadの自己申告だけでは通さない。
- Plugin Identity、verified version、Canonical File Manifest digestがFindingのTarget bindingと一致しなければ`conflicting`にする。
- handoff payloadをTarget Intelligence内部stateやResearch storageから直接読む実装にしない。

gate前にconsumerへ公開できるWordfence情報は、Issue #94が定めるoracle隔離済みVulnerability History Aggregateだけである。Target Intelligenceはexact recordをowned indexへ取り込めるが、CVE、affected version、patched version、CWE、advisory narrative、reference URLをTarget Intake、Candidate selection、Researchへ到達させない。

### 2. 第一の構造化確認

gate通過後、次の手順でWordfence snapshotを確認する。

1. v3 Production complete responseを取得し、取得時刻、response digest、endpoint version、schema/parser versionへ固定する。
2. 全recordとcopyright objectのruntime validation成功後だけsnapshotをcurrentにする。
3. Plugin Identity、distribution provenance、verified versionをWordfenceのsoftware slugとaffected intervalへ対応付ける。premium/free衝突、alias、未知version構文をsilentに同一視しない。
4. 候補recordをFindingのsecurity semantics、root cause、affected code、必要条件と比較する。同一plugin/versionだけではduplicateとしない。
5. matching record UUID、published/updated、snapshot identity、比較結果をprivate evidenceへ固定する。

Webhookは早期refreshのtriggerに使えるが、created/replaced/deleted eventの順序や完全配送だけへ依存しない。duplicate check直前にはfreshness policyを満たすcomplete snapshotが必要である。

### 3. 既知重複の扱い

public contractは次のclosed unionにする。status名はnegative proofを表現しない。

| 状態 | 条件 | 禁止する読み替え |
| --- | --- | --- |
| `known-duplicate` | freshなWordfence exact recordが、同じTargetと実質的に同じbroken security semantics/root causeを既に公開している。 | 同じpluginの別脆弱性、類似CWE、同じversionだけではduplicateにしない。 |
| `not-observed` | requiredなWordfence refreshとidentity/range/semantics照合がすべて成功したが、checked-at時点で一致を観測しなかった。 | `novel`、`safe`、`not known anywhere`、自動submit許可を意味しない。 |
| `conflicting` | Target binding、software identity、affected interval、root causeまたはpublication stateを一意に固定できない。 | 推測で同一性を確定しない。human reviewを要求する。 |
| `unavailable` | auth/quota/429、network、stale snapshot、partial response、schema drift、parser failure等によりrequired checkを完了できない。 | no-matchまたは`not-observed`へ丸めない。 |

`known-duplicate`は外部programmeへの自動actionではない。`not-observed`もsubmission許可ではない。どのstatusもResearchのcandidate、Validation conclusion、Finding成立過程を書き換えない。

### 4. 出所と保存

Known Duplicate DispositionはHuman OSだけが受け取る、exact vulnerability detailsを含まない最小projectionにする。Target IntakeやResearchへ再公開しない。

```text
KnownDuplicateDispositionV1
  findingHandoffRef
  targetBindingDigest
  status: known-duplicate | not-observed | conflicting | unavailable
  checkedAt
  checkerPolicyVersion
  wordfenceSnapshotRef | failureRef
  privateEvidenceBundleRef
```

このprojectionにCVE、record title、affected/patched version、CWE、Finding narrative、reference URL、patch、known routeを埋め込まない。

Target IntelligenceのWordfence snapshot/indexは以下を保持する。

- retrieval start/end、HTTP outcome、v3 endpoint、response digest。
- schema/parser version、validation outcome、snapshot generation、current pointer history。
- record UUID、normalized software/range、published/updated、reference、copyright object。
- SecretRef identityは保持してもsecret valueは保持しない。

Human OSのPrivate Evidence Bundleは以下を保持する。

- verified-Finding handoffのresolved identityとTarget binding。
- exact Wordfence record projection、照合したrange、record link、copyright/license metadata。
- statusを選んだ人間またはauthorized process、policy version、uncertainty、再確認期限。

Wordfence dataのcopyにはrecordが持つDefiant/MITRE等のnotice、license、record hyperlinkを一緒に保持する。Private Evidence Bundleの内容をGit、通常log、Research Record、Target Intake Packetへ出さない。

## Patchstackを採用しない理由

Patchstack Threat Intelligence APIは技術的にはsingle product/version lookup、batch、latest、advisory detailを提供するが、custom pricingかつrequest-based activationで、rate limitは契約ごとに設定される（[API overview](https://docs.patchstack.com/api-solutions/threat-intelligence-api/overview/)、[Extended guide](https://docs.patchstack.com/api-solutions/threat-intelligence-api/extended/)）。complete `/all`とcursor paginationはselected partners向けsurfaceにあり、通常のExtended surfaceからfull snapshot entitlementを推定できない（[NPM features](https://docs.patchstack.com/api-reference/threat-intelligence-npm/)）。

また公開規約だけでは、第三者pluginのprospective researchを目的としたraw responseの永続保存、派生aggregate、agent/providerへの提示、契約終了後のreplayを許可されたとは判断できない（[Patchstack Terms](https://patchstack.com/terms-and-conditions/)、[Patchstack MSA](https://patchstack.com/master-solution-agreement/)）。public database HTMLにもversioned machine schema、bulk export contract、completeness SLAを確認できない。

Wordfenceが無償のcomplete v3 feed、explicit license、record単位のcopyright metadataを提供し、#94でoracle-separated local indexを所有する以上、Patchstackを二つ目のstructured sourceとして追加する利益は、credential・license・identity conflict・parser drift・false-clear riskを上回らない。従って次を固定する。

- Patchstack API Adapter Issueは作らない。
- Patchstack public HTML Adapterも作らない。
- Patchstack API keyを取得・保存しない。
- Patchstackのknown recordをduplicate判定、selection、Research inputに使わない。
- 将来、Wordfenceでは得られない必須coverageが実測され、個別契約が保存・派生利用・replayを明示許諾した場合だけ、新しいdecision issueで再評価する。

この判断はKnown Duplicate確認だけを対象とし、programme directoryやDisclosure Route Observationを扱う別Issueのsource decisionを変更しない。

## 次の実装Issueの受入シナリオ

1. authenticated/versioned verified-Finding handoffなしではexact Wordfence queryを拒否する。
2. callerが任意のFinding refやbooleanを渡してもgateを通れない。
3. fresh Production snapshotに同一security semanticsのrecordがあれば`known-duplicate`となり、exact evidenceはPrivate Evidence Bundleにだけ残る。
4. complete refreshと照合が成功して一致がなければ`not-observed`となり、「duplicateなし」へ読み替えられない。
5. Target binding、software identity、affected rangeまたはroot causeを一意に固定できなければ`conflicting`となる。
6. auth、429、partial response、schema drift、stale snapshotは`unavailable`となる。
7. record、CVE、advisory、reference、known routeがTarget Intake、Selection、Research inputへ現れない。
8. replay時に同じsnapshot、Finding binding、policy versionから同じDispositionを再構成でき、再実行は新しいchecked-atを持つ不変recordとして追加される。

## 残る判断

- verified-Finding handoffの発行者真正性を、署名envelope、durable receipt resolver、別のversioned mechanismのどれで保証するかは、Target IntelligenceとHuman OSのDesign Gateで決める。caller自己申告は候補にしない。
- Wordfence Terms変更を検知した時は新snapshot ingestionを停止し、license review完了まで前回snapshotをfresh扱いしない。
- `conflicting`と`unavailable`からの再確認、Programme Assignment、Submission Draft承認はHuman OSの別seamであり、このdecisionでは自動化しない。
