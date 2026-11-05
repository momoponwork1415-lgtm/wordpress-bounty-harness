<!-- provenance: /home/dev/wordpress-harness/docs/knowledge/deepseek-v4-1-agent-host-transport-2026-09-18.md, mtime 2026-09-19, imported 2026-10-13, generation 09-wordpress-harness -->

# 調査資料: DeepSeek V4.1 Flashのエージェント実行方式

状態: 一次資料に基づく調査、2026-09-18確認

## 結論

DeepSeek V4.1 Flashはraw chat APIしか提供されていないmodelではない。DeepSeek自身がopen-sourceのagent hostである[DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness)を公開し、公式release `v0.1.6-alpha.1`からheadless stdin、`--session-id`による継続、`--json`のNDJSON event streamを提供している。[公式release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1) [headless contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)

したがって第一候補は、Harness内にmodel loopを再実装するDirect API Adapterではなく、公式`@deepseek-ai/dsh`を外部processとして動かす`deepseek-harness-native/v1` transportである。DeepSeekが公式に案内する[Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)も、既存のCodex native transportを再利用できる比較候補になる。

ただし、どちらも現状のままproduction admissionしてはならない。主な理由は次の三点である。

- DeepSeekの公式API idは`deepseek-flash`で、2026-09-18時点ではDeepSeek-V4.1-Flashへrouteされるが、公式changelog自身がこれを「latest V4.1 Flash」を呼ぶ名前としている。immutableなdated snapshot idではない。[release note](https://api-docs.deepseek.com/news/news260910/) [changelog](https://api-docs.deepseek.com/updates/) [model list](https://api-docs.deepseek.com/api/list-models/)
- `dsh`のlocal credential storeは、公式文書がagent tool processに対するsecret boundaryではないと明記している。Codex向け公式手順もAPI keyを`experimental_bearer_token`としてconfigurationへ保存する。どちらも、このrepositoryの「Agentへprovider credentialを渡さない」というinvariantを単独では満たさない。[dsh credential boundary](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/credentials-local/README.md) [Codex configuration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
- DeepSeek Harnessはdeveloper previewでbreaking changeを予告し、公式Safety文書もsandboxをuntrusted workloadの唯一のsecurity controlにしないよう求める。[project status](https://github.com/deepseek-ai/deepseek-harness) [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)

production実装へ進む条件は、exact `dsh` package versionとcontainer image digestを固定し、host-privateなcredential-injecting proxyだけが本物のDeepSeek API keyを持ち、Agent Sandboxにはproxy専用のnon-secret tokenまたは無credential endpointだけを見せることである。これは上の一次資料から導くこのrepository側の設計勧告であり、DeepSeekが提供する機能ではない。

## モデルと課金の境界

| 項目 | 公式に確認できた境界 | Harnessでの扱い |
| --- | --- | --- |
| API model id | `deepseek-flash`。Models & Pricingは現在のmodel versionを`DeepSeek-V4.1-Flash`とする。[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) | Profileはrequested id `deepseek-flash`をbindする。ただしunderlying modelのimmutabilityは主張しない |
| reasoning effort | APIは`none / low / high / max`を受け、defaultは`high`。[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) | 最初のevaluation profileは`max`を明示し、暗黙defaultに依存しない |
| credential | DeepSeek APIはBearer API keyを要求する。[API specification](https://api-docs.deepseek.com/api/deepseek-api/) | raw keyはAgent Sandboxへmountしない。host-side proxyで付与する |
| billing | 料金はtoken単位でtop-up balanceまたはgranted balanceから差し引かれる。[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) | subscription reset windowとして扱わず、balance observationとして扱う |
| remaining allowance | `GET /user/balance`は`is_available`と通貨別のtotal / granted / topped-up balanceを返す。[Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/) | trusted control planeのread-only readiness probeに置き、Agentには実行させない |
| concurrency | `deepseek-flash`のaccount-level concurrency limitは2500で、超過はHTTP 429になる。[Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit/) | quota exhaustionとrate limitingを分け、429を残高不足へ読み替えない |

確認した公式surfaceはAPI keyとprepaid / granted balanceであり、consumer subscription OAuthのsessionやreset windowではない。よってClaude/Codex subscription用の「残りpercentとreset時刻」contractをDeepSeekへ流用しない。

## 第一候補: DeepSeek Harnessのヘッドレス実行

### プロセスの境界

公式CLI packageは`@deepseek-ai/dsh`、executableは`dsh`である。`dsh --profile headless`は一回のtaskを実行して終了し、`--json`では`session`、`status`、`text`、`thinking`、`tool_call`、`tool_result`、`final`をNDJSONで出す。completedのみexit 0で、aborted、error、turn不成立はexit 1になる。[CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md) [headless contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)

`v0.1.6-alpha.1`がheadless stdin、resume、JSON streamを導入し、2026-09-18時点の最新immutable releaseは`v0.1.6-alpha.2`、tag commitは`ddefc45`である。[v0.1.6-alpha.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1) [v0.1.6-alpha.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2)

最初のeligible imageは`@deepseek-ai/dsh@0.1.6-alpha.2`をexact versionとnpm lockfile integrityでinstallし、imageをdigest pinする。launch前のprobeはimage内の`dsh --version`がprofileの`executableVersion`と一致することを確認する。version tagだけでなくpackage integrityとimage digestをbindするのは、developer previewのbreaking-change予告から導くrepository側の要件である。

### セッションの作成と再開

session idを省略するとfreshな`session-<uuid>`を作り、opening `session` eventがidを返す。同じcwd、root session、compatible compositionという条件を満たすpersisted sessionは、次のprocessで`--session-id <id>`により継続できる。存在しないidはempty sessionを作らず失敗する。[headless session contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#choosing-the-session-identity)

このためinitial runはstdinでResearch Promptを渡し、Checkpoint continuationだけ同じnative session idをopaqueに保持してresumeする。Harnessはhistory、context compactionまたはturn loopを再構築しない。

### 標準ツールとサブエージェント

base-backed profileはmodel connection、file editing、shell、web search / fetch、subagents、task / goal tracking、durable sessionを含む。subagent serviceはfresh spawn、history-seeded fork、continuable child、follow-up、interrupt、child discoveryをnative capabilityとして持つ。[base bundle](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/README.md) [subagent contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/README.md)

baseのcontinuable child上限はdefault 8であり、このproductの「Root込み最大4体」と一致しない。[subagent capacity](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/README.md#continuable-capacity) 専用profileでは`maxActiveSubagents: 3`に下げ、one-shot forkや別のchild生成toolを無効化して、制限外経路が残らないことをcapability probeで確認する必要がある。

DeepSeek Harnessのsandbox policyはfile effectsを`read-only / workspace-write / danger-full-access`へ分類するが、networkとprocess policyは語彙の外である。[sandbox policy](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-policy/README.md) よって専用profileのtool制限はdefense in depthであり、outer gVisor sandbox、read-only Target Snapshot、isolated scratch、egress allowlistの代わりにならない。

### 構造化出力と使用量

headless `--json`はrun event envelopeであって、`final.text`のJSON Schemaを強制するoptionではない。公開されるheadless設定は`task`、`sessionId`、`json`の三つで、terminal `final` eventはlossless answer textを運ぶ。[headless settings](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#running-a-one-shot-task) [JSON projection source](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/json-stream.ts)

raw DeepSeek APIには`response_format: {"type":"json_object"}`があるが、JSONという指示をpromptにも含める必要があり、empty contentが返る場合もある。[JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 現在のnative `dsh` adapterはResponses protocolを実装せず、`tool_choice`もmappingしない。[dsh DeepSeek adapter limitations](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/README.md#known-limitations-and-deferred-work)

したがって最初のprofileは`reportProtocol: prompted-json`とし、Research Promptで最終reportをJSONに限定し、Harness側のversioned schemaで一度だけvalidateする。schema不一致は`invalid-output`としてprivate diagnosticを保持し、raw APIを呼ぶrepair loopは追加しない。

NDJSONの`step_end` statusは、全attemptがusageを報告した場合だけinput、output、total、cache read / write、reasoning tokenを含む。一つでもsampleが欠けるとpartial sumをexact totalに見せないためusageを省略する。[JSON projection usage source](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/json-stream.ts) Receiptはこのprovider-reported usageを観測値として保存し、省略をzeroへ変換しない。

### 失敗時の扱い

公式DeepSeek adapterはHTTP failureを`AUTH`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`、その他の`HTTP_<status>`へ正規化し、さらに`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`TRANSPORT`、`ABORTED`、`TIMEOUT`、`STREAM_CLOSED`、`MALFORMED_RESPONSE`、`EMPTY_RESPONSE`を区別する。[dsh adapter failures](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/README.md#failures-and-recovery) DeepSeek API自身は401をauthentication failure、402をinsufficient balance、429をrate limit、500 / 503をserver-side failureと定義する。[API Error Codes](https://api-docs.deepseek.com/quick_start/error_codes/)

`--json`では`turn_end.reason`にnative errorが残り、direct-driver failureは`error` event、stderr diagnostic、exit 1になる。completedでないrunもexit 1になる。[headless exit mapping](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#exit-mapping)

Adapterは少なくとも次のように写像する。

| 標準実行側の結果 | 探索側の結果 |
| --- | --- |
| `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` | resumable `provider-authentication-required` |
| `QUOTA` / HTTP 402 / balance unavailable | resumable `provider-quota-exhausted` |
| `RATE_LIMIT` | resumable provider rate limit。quota exhaustionと分ける |
| `TIMEOUT` / `TRANSPORT` / `SERVER` / HTTP 503 | resumable provider unavailable |
| outer deadline | 当時の1時間上限ではResearchが中断された。現行設計ではsealed Campaignの残りsafety allowanceを使い、provider timeoutと分ける |
| completed + report schema mismatch | terminal attempt `invalid-output`。Finding rejectionにしない |
| `MALFORMED_RESPONSE` / `STREAM_CLOSED` / `EMPTY_RESPONSE` after native retry policy | provider invalid output / unavailableとしてreceipt化する |

## 比較候補: Codex標準ホスト + DeepSeek Responses API

DeepSeekはCodex用のofficial setupを公開し、`deepseek-flash`をcustom model catalogへ登録し、`wire_api = "responses"`、API-key auth、DeepSeek endpointを設定する。catalog例はparallel tool callsと`multi_agent_version: "v2"`も宣言する。[Integrate with Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)

この経路の利点は、このrepositoryの既存`codex-native/v1` transportとsession / report parserを再利用し、#169のprofile追加だけでmodelをadmitできる可能性があることである。一方、DeepSeekのsetupはAPI keyをCodex configurationの`experimental_bearer_token`へ保存するため、credentialをAgentから隔離する性質は公式手順から確認できない。またDeepSeek APIのResponses endpointはserver-side conversationを保存せず、multi-turnではclientがhistoryを毎回送るstateless APIであるが、Codex processがそのloopを所有するのでHarnessが再実装する必要はない。[Responses API](https://api-docs.deepseek.com/api/create-response/)

| 観点 | DeepSeek Harness | Codex + DeepSeek |
| --- | --- | --- |
| hostの出所 | DeepSeek first-party agent host | DeepSeek公式support済みのOpenAI agent host |
| 現在の外部seam | headless stdin + NDJSON、native session resume | 既存Codex native adapterのprocess / session seam |
| native subagents | 公式base bundleがin-process spawn / fork / continuationを提供 | DeepSeek catalogがCodex multi-agent v2を宣言するが、実transport capabilityは固定Codex versionで再probeが必要 |
| report enforcement | prompted JSON + Harness validation | 既存Codex schema-constrained outputを使えるなら有利。DeepSeek Responses互換での実測probeが必要 |
| credential | dsh storeがagentへのsecret boundaryではない | 公式setupはconfigへAPI keyを直接保存 |
| 推奨 | provider-native第一候補 | credential proxyとcapability probeを通ればfallbackではなく同格のprofile experiment候補 |

どちらか一方へ自動fallbackしてはならない。別transportは別Agent Runtime Profile、別integrity digest、別eligibility receiptとしてablationする。

## Issue #170への実装勧告

まず`deepseek-harness-native/v1`を追加する。ただしAdapterを完成扱いにする前に、次の順で狭いvertical sliceを通す。

1. `@deepseek-ai/dsh@0.1.6-alpha.2`と専用profileを含むimageをdigest pinし、`dsh --version`、effective config、`deepseek-flash`、`max`、subagent ceiling、disabled tool rowsをprobeする。
2. host-private proxyがDeepSeek bearer keyを付与し、Agent Sandbox内にraw key、credential file、ambient secret environmentが存在しないことをadversarial capability testで確認する。
3. `dsh --profile <locked-profile> --json -`をouter gVisor sandboxで実行し、opening session id、usage、tool events、turn-end reason、final textをbounded parserでreceiptへ変換する。
4. fresh runと`--session-id` continuationをbehavior testにし、invalid NDJSON、truncated stream、nonzero exit、auth、balance、rate limit、timeout、completed-invalid-reportをtyped failureとして固定する。
5. 同一Target / Prompt / Runtime / Permission / Budgetでfreshな3 Campaignを上位のpass@3 modeが作る。DeepSeek Adapter自身はTrial union、Candidate merge、stop判断を所有しない。
6. Codex + DeepSeekは同じcredential proxyが使え、DeepSeek Responses互換でschema output、session、subagent、usage、error mappingのprobeが通った時だけ、既存`codex-native/v1`の第二profileとして比較する。

credential proxyを先に用意できない場合、#170はtransport shapeとfixturesまでで止め、production catalogへadmitしない。raw API loopをHarnessへ足すことは代替策にしない。
