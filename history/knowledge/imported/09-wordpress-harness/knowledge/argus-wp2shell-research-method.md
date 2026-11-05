<!-- provenance: /home/dev/wordpress-harness/docs/knowledge/argus-wp2shell-research-method.md, mtime 2026-10-08, imported 2026-10-13, generation 09-wordpress-harness -->

# 調査資料: Argusの10動詞とwp2shellの探索方式

状態: 一次資料に基づく調査、2026-09-10確認

## 結論

Argusの10動詞は、Research loopを評価するための有用な原則であり、10個のproduction subsystemを作る指示ではない。Wordfenceはこの10動詞を一文で示した直後に、prompt、model、harnessの設計詳細は公開できないと明記している（[Wordfence Argus](https://www.wordfence.com/blog/2026/08/wordfence-argus-moving-beyond-human-research-capability/)）。個々の動詞に特定のschema、role、stageまたはalgorithmを対応させる根拠はない。

wp2shellはArgusのpromptではない。Searchlight CyberがOpenAIの[Cycle Double Cover Prompt](https://cdn.openai.com/pdf/04d1d1e4-bc75-476a-97cf-49055cd98d31/cdc_prompt.pdf)をWordPress向けに適応した一成功例である（[wp2shell exact prompt](https://www.slcyber.io/research/exploit-brokers-pay-500000-for-a-wordpress-rce-i-found-one-with-gpt5-6#the-story-of-wp2shell)）。このrepositoryはwp2shell promptの研究手法をすべて採用する。除外するのはtask固有のpositive oracle、RCE / `/flag`到達の強制と最低6時間の指定だけである。provider機能の再実装はprompt要素ではなく、採用方法に対する禁止事項である。

## 証拠の境界

「Observed」は一次資料が述べた事実、「Operational interpretation」はこのrepositoryへの適用案である。Argusの内部promptとarchitectureは非公開である。公開された成功例からprospective recall、miss、run varianceまたは各手法の因果効果は推定しない。

WordfenceによればArgusは、広く短いpathを追うPRISMとは別に、一つのtargetで各linkが前のlinkへ依存する長いpathを保持するdepth側の仕組みである。Avadaでは六つのweaknessをつないだchainを発見し、isolated targetでend-to-endに確認した（[Argus Avada report](https://www.wordfence.com/blog/2026/08/wordfence-argus-finds-complex-6-step-critical-rce-in-avada-theme-with-1-million-sales/#breadth-and-depth)）。一方、Argus overviewが公開する実装情報は、prompts、models、harnesses、orchestration、deterministic programmingを組み合わせ、capabilityとpriceを見ながらmodelを切り替えるという範囲に留まる。

## 10動詞の運用上の解釈

以下はArgus内部の再現ではない。公開された10動詞を、Argusのdepth説明とwp2shell / CDC promptに照らしてこのrepository用に定義したものである。

| 原則 | このrepositoryでの運用上の解釈 |
| --- | --- |
| **confine** | Target、source world、tool、authority、environmentをCampaign境界内へ隔離し、研究対象と実行権限のscope driftを防ぐ。 |
| **constrain** | attacker proximity、通常構成、eligible impact、oracle禁止、時間と同時実行上限を明示する。Prompt上のacceptance conditionとRuntime上の強制を混同しない。 |
| **focus** | 一つのTargetと具体的なbroken security semanticsを深く追い、複数linkが必要なpathを見失わない。RCEへ伸びないeligible Candidateまで捨てる意味にはしない。 |
| **motivate** | mission、impact、終了時に必要なevidence、粘り強く試す期待を明確にする。prospective Campaignでは「脆弱性が存在する」と教えず、source-boundな次手で継続を動機づける。 |
| **parallelize** | Rootが上限内で、互いに異なる仮説を持つnative subagentを動的に使う。agent数、role、担当領域を固定配分しない。 |
| **hypothesize** | approach family、具体的mechanism、中間primitive、missing linkを仮説として立て、code evidenceとcounterevidenceで更新する。 |
| **verify** | concrete Candidateをadversarialに反証し、Researchとは独立したsource Validationと、その後のfresh isolated runtime verificationへ渡す。 |
| **record** | evidence、counterevidence、試したfamily、blocked理由、remaining gap、next action、Checkpointを後続runが利用できる形で残す。 |
| **prioritize** | impactとsource edgeを基準にattentionを配る一方、魅力的な一経路への早期収束を防ぎ、underexploredな異種routeを残す。固定scoreやrankを要求しない。 |
| **iterate hard and fast** | Rootがsynthesize、challenge、redirectし、具体的な新機構またはactionable frontierがある限り新しいroundを回す。現在のrouteが失敗しただけでは全探索の終了にしない。 |

wp2shellとCDC promptは、固定assignmentを避けること、初期roundではfavored approachを多くのagentへ共有しないこと、approach familyの収束を検知してredirectすること、新機構なしにblocked routeを反復しないこと、incompatible routeを複数round維持すること、concrete resultをadversarialに確認すること、Rootが繰り返し統合して次roundを起動することを明示する。これは上表の `parallelize` から `iterate` を具体化するprompt techniqueであって、Harness-owned state machineの仕様ではない。

## 開発上の境界

直接採用する設計原則は次の責務分担である。

- **Research Prompt / Root AI:** goal、現実的precondition、異種仮説、読む順序、subagentの動的利用、synthesis、challenge、priority、continue / stop判断を持つ。
- **Provider-native runtime:** 既に提供するplanning、native subagent orchestration、message routing、session / context、tool lifecycle、result synthesisを使う。
- **Harness:** Target / Prompt / Runtime / Permission / Budget binding、isolation、versioned handoff、append-only evidence、Human Candidate Review、fresh dynamic verification、external action gateだけを強制する。

したがって、Claude Code、Codex等がnativeに提供するagent管理、session continuationまたはtool executionをprovider-neutralな模倣層として再実装しない。wp2shellは既存のmultiagent機能をPromptから利用し、元のCDC promptも既存の `multiagent v2` を動的に使うよう指示している。どちらの資料も独自のagent scheduler、message bus、context managerまたはtool protocolを実装するよう求めていない。

## Anthropicの参考ハーネスとの比較

状態: 未採用のreference / comparison input。現行設計の根拠ではない。

Anthropicの[Best Practices（fixed commit）](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md)はClaude Mythos Previewを使ったdefensive security全般のfield practiceであり、WordPressのoracle-free source research仕様ではない。以下は将来の比較・ablation候補であって、採用済みbehaviorではない。

| 参照資料の原則 | このrepositoryで検討できる形 |
| --- | --- |
| system mapからtrust boundaryを把握し、最後にcomponentをまたぐchainを確認する（[lines 18-24](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L18-L24)） | Rootのnavigationと仮説生成を助ける入力として試す。固定Recon stage、partitionまたはcompletion proofにはしない。 |
| noisyなdiscoveryとadversarial verificationを分離し、Finderとfilesystem / environment / conversationを共有しないclean sandboxでgradeする（[lines 47-69](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L47-L69)） | 現行のfresh Independent Validationと比較可能な独立原則。executable witnessは後段Human OSで扱い、source-only Research / Validationへruntimeを混ぜない。 |
| severityをclass名ではなく具体的preconditionから導出し、model評価をground truthにしない（[lines 84-99](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L84-L99)） | Candidateのattacker proximity、ordinary configuration、reachability、impactを先に記録する方法を評価する。CVSS数値計算が必要ならdeterministic toolへ分離する。 |
| 同じPromptでもrun varianceがあるため複数runのunionを見る（[lines 114-118](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L114-L118)） | 凍結した公開evaluation corpusでsingle-run、union、再現率を分けて測る候補。production CampaignのFindingを支持数で採否しない。 |
| partial chainのmissing primitiveを一つのagentに言語化させ、fresh sessionへ具体的gapとして渡す（[lines 135-142](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L135-L142)） | 同一Checkpointを継続する方式とのablation候補。通常CampaignではRootのsource-bound next actionをexact Checkpointへbindして自動継続する。 |
| dependencyを全mountせず、agentのwishlistをreviewして必要分だけ渡す（[lines 183-184](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L183-L184)） | 人間が承認してpinしたread-only dependency snapshotを次Grantへ追加するseamとして検討できる。run中の任意downloadは許可しない。 |
| model出力をreportではなくleadとして扱い、specific release、実interface、source位置を確認し、unfixed issueはprivateに報告する（[lines 218-249](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L218-L249)） | Candidate、Independent Validation、fresh runtime / human verification、external action authorizationという現行境界と比較する。AI関与と人間が確認した範囲を最終Draftに明記する案は将来検討とする。 |

### そのまま移植しないもの

- precise sliceをReconが各Finderへ割り当てる方式、finder / critic / judge、vulnerability category別routerを固定orchestrationにしない。Reference自身のtask分解であり、Rootの研究判断をHarnessへ移す（[partition](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L26-L33)、[judge](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L71-L78)）。
- git history、internal portal、production logを「全てcontextへ渡す」助言はoracle-free prospective Campaignへ適用しない（[lines 36-41](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L36-L41)）。公開前のTarget、Finding、PoC、payload、transcript、private log、credentialをGitまたはagentのambient contextへ入れない。Reference実装自身も `results/`、per-run state、Finding、triage、patch、incident / response artifactを追跡対象外にしている（[official `.gitignore`](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/.gitignore#L8-L35)）。これはstorage boundaryの比較材料であり、`.gitignore`だけをpublication authorizationにはしない。
- sanitizer、crash、`reproduces 3/3`、live app、black-box traffic、find-fix-find、PoC regression testはmemory-safety、patching、runtime harness向けである（[verification examples](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L54-L75)、[iteration examples](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L118-L147)）。immutable third-party sourceを扱うResearch / Independent Validationでtargetをbuild、execute、patchしない。PoCはGit上のregression fixtureではなくPrivate Evidence Bundleに隔離する。
- transcriptから自動生成する `CHEATSHEET.md` / `LESSONS.md` flywheelを導入しない（[lines 149-153](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L149-L153)）。private Findingの漏えい、過去oracleの混入、既知classへの過適合を招く。再利用するなら公開済み事実だけを人間がsanitization reviewした集計に限定する。
- file vulnerability score、transcriptのLOC、test coverage、static ruleをsemantic researchのcoverage closureにしない。Reference自身もstatic ruleはsubtleなcross-file bugを逃すcheap floorだと限定する（[lines 120-124](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L120-L124)、[lines 163-181](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L163-L181)）。
- setup phaseの任意network、attack phaseの `--dangerously-skip-permissions`、supervisorの`$/finding` gateを採用しない。Referenceもこの二つのinfrastructure patternは必須ではないとする（[lines 187-212](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L187-L212)）。
- private disclosure guidanceを「Harnessが自動送信してよい」と読まない。外部行動はAIがproposalを作るまでに留め、人間がexact Draftとdestinationを承認する。ReferenceのD&R節もirreversible actionは提案だけに留める（[lines 351-358](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/best-practices.md#L351-L358)）。

## 資料からは正当化できないこと

- Argusの10動詞を固定role、Wave、stage、queue、score、rank、schemaまたはagent数へ一対一対応させない。内部設計は非公開である。
- 「model agnostic」をprovider-neutral tool DSLの根拠にしない。記事はmodel切替の内部実現方法を説明していない。
- wp2shell task固有のpositive oracle、pre-auth RCE / `/flag`到達の強制と最低6時間は採用しない。元のCDC promptの肯定解と最低8時間も採用しない。wp2shellの最大4 agentはこのrepositoryでもresource ceilingとして採用するが、最適agent数の一般的証明とは扱わず、固定assignmentにも使わない。
- wp2shellを単一promptで完了した無人runとして扱わない。著者は途中のSQLiをstock installで確認した後、RCEへ昇格できるかを追加で質問し、最終chainを人間が解読してreportを作った（[experiment narrative](https://www.slcyber.io/research/exploit-brokers-pay-500000-for-a-wordpress-rce-i-found-one-with-gpt5-6#the-story-of-wp2shell)）。
- 一成功例からrecall、precision、cost effectiveness、最適agent数または最適継続時間を一般化しない。著者自身も一般的主張はしないと限定している（[author's limit](https://www.slcyber.io/research/exploit-brokers-pay-500000-for-a-wordpress-rce-i-found-one-with-gpt5-6#is-gpt56-sol-superhuman)）。
- wp2shellのdependency-source調査は採用する。run中のcloneは同じ研究意図を事前pinしたread-only Dependency Snapshotで満たし、任意network、host上のruntime attackまたはAIによる外部提出は許可しない。Prompt techniqueはsecurity boundaryやexternal authorizationを保証しない。
