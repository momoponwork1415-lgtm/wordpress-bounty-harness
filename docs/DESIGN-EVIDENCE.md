# 設計判断の根拠（何が観測され、何が未証明か）

目的: 「なんとなく良さそう」で進めないために、主要な判断ごとに、公開された一次資料で観測された事実、その事実が示さないこと、この設計でどう測るか、退けた代替案を並べる。出典の詳細は旧リポジトリ `research/design-references` ブランチの `docs/knowledge/*-2026-10-08.md`（調査日2026-10-08）。数値は各社の自己申告で、WordPressでの再現率を直接示すものではない。

凡例: **観測** = 一次資料で確認した事実。**示さないこと** = その事実から言えないこと。**測る** = この設計で検証する方法。

## 1. 探索と確認を分け、確認は決定論的な判定器だけが出す

- **観測**: Anthropicは、探索と検証を同じagentにさせると真陽性まで自己検閲すると報告し、新しいcontainerの反証役verifierで「悪用できないfindingの率がおよそ半分」、PoC要求で「偽陽性がほぼ0」になったと述べる（Using LLMs to secure source code、2026-05-27）。XBOWは非AIの決定論的validator（headless browserでのXSS実行、canary回収）だけを「no false positives」と呼ぶ（Assessment Guidance、2026-03-12）。Refute-or-Promote（arXiv 2604.19049、2026-04-21）では、LLMレビュアー10体が一致して存在しないBleichenbacher oracleを支持し、退けたのは1つの実証テストだった。Cloudflareは候補20,799件の約42%を検証で落とした（2026-06-18）。
- **示さないこと**: 削減率を出す資料はどれも、同時に失った真陽性（recall損失）を出していない。Anthropicの数値はC/C++中心で、logic bugでは同等の判定ができないと本文が認める。
- **測る**: SPEC第10節のablation「Verifier有無」「判定器有無」で、held-out 9件に対するtarget-hit率と偽警報数を同じcase・同じ試行の対で比べる。修正版での負の対照で誤警報を数える。
- **退けた代替**: エージェントの自己申告（旧リポジトリのRecipe自己報告3条件）を確認にする案。Refute-or-Promoteの例が示すとおり、LLMの合議は誤りに収束しうる。

## 2. 自動の実行時検証を人間レビューの前に置く

- **観測**: Anthropic（Mythos Preview 2026-04-07、Glasswing 2026-05-22）、Cloudflare、XBOW、Codex Security、Big Sleepは、実行時の証拠を人間より前に作る。例外はMandiant AVDH（人間がPoCを動的再現）だけ。Anthropicでは候補29,439件に対し人間がレビューしたのは6,123件で、人手が開示の律速段階だった（CVD dashboard、2026-10-02時点）。IMDA MGF v1.5（2026-05-20）は「低い覆し率はrubber-stampingの兆候」とし、覆し率をゲートを下げる指標でなく監視信号とする。
- **示さないこと**: 開示前の人間ゲートを完全に外した例はない。人間の判断が「影響が意味を持つか」で正確になるという直接の証拠はない（curlの事例では「確認済み」5件中3件が意図どおりの動作だった。二次資料、低信頼）。
- **測る**: レビュー列に出た件数、判断までの時間、覆し率、提出転帰（triaged / duplicate / rejected）を台帳に記録し、月ごとに見る。
- **退けた代替**: 旧設計の「人間が未検証候補を採否し、採用分だけ検証」。利用者自身が「低品質な手動承認」と認めており、人間に最も難しい「本物か」の判断をさせていた。

## 3. 検証の失敗を `incomplete` にし、棄却に丸めない

- **観測**: Anthropic「failure to produce a working PoC is not proof of a false positive」。Mantis READMEも「failure to automatically reproduce … does not definitively mean it is a false positive」と明記し、snapshotを固定できない時は `VERIFICATION_INCOMPLETE` に留める（google/mantis 2b3bbdc、2026-10-06）。Chromeは「Not Reproducible」で閉じたbugを評価caseに再利用する（FAQ、2026-04）。
- **示さないこと**: `incomplete` をどれだけ人間が処理できるかの運用数値はない。
- **測る**: `incomplete` の理由コード別件数と、再検証後にconfirmedへ転じた割合。
- **退けた代替**: AVDH型（動的試験を通らない候補を破棄）。再現率を落とす。

## 4. 短い目的prompt＋独立Trial（管理指示変種とLead継続を測る）

- **観測**: Anthropicは「discovery promptは目的とcontextを与え、方法をmodelに任せる。長いchecklistは新規bugを減らす」と述べる（2026-05-27）。Mythos scaffoldはほぼ「find a security vulnerability」だけのpromptで、file別agentを並列に走らせた（2026-04-07）。Naptimeは「一つのtrajectoryで複数の仮説を扱うのは非効率なので独立trajectoryを複数sampleする」（2024-06）。Semgrepは同じpromptを同じappで繰り返すと指摘が毎回変わり（3→6→11件）部分的にしか重ならないと報告（2025-09-02）。run間の安定性は0.63–1.0（Semgrep 2026-07-17）。XBOWは永続coordinatorが多数の短命agentを指揮する（2026-03-02）。
- **示さないこと**: 「短いpromptが長いpromptより当たる」のAnthropicの観察は数値なし。本人のwp2shell promptで50万ドル級の発見があった事実と直接比較した資料はない。pass@kの独立性の保証（provider側cacheの排除等）を示した資料はない。#73の開発セットでも4 cellすべて公開2事例のsource候補0/3で、変種や継続の優劣は分からなかった。
- **測る**: 版とdigestを固定した管理指示変種、Lead継続の有無をopt-in本番A/B軸にし、独立Trialを分母としてsource候補・完全経路・費用を分けて数える。#73では150分の時間対照も回したが、実wallは設定上限より短く、実時間一定の比較にはならなかった。既定は短い目的promptと継続なしに残し、本番の前向き評価と提出転帰を見る。
- **退けた代替**: wp2shell由来の固定手順・checklistを既定にする案。元のCycle Double Cover型promptは「解が必ず存在し費用無制限」の前提で、空の対象を安く見切る必要があるバグバウンティと合わない（判断者の判断、2026-10-08）。管理指示だけの変種は捨てず、A/Bで測る。

## 5. Trial上限6、k_t = 3、同時2の初期値

- **観測**: Codex Securityのdeep scanが停止規則を設定で持つ（docs、2026-10-08取得）。Naptime、Chrome、XBOWは「複数run」「多数の短命agent」としか書かない。
- **示さないこと**: 6、3、2がWordPressプラグインで最適だという根拠はない。#73のLuna開発セットではsource候補が0件で、適切なTrial上限を推定できない。**これは初期値であって結論ではない。**
- **測る**: `ledger usage` とprovider limitの停止回数、何Trial目で初めて当たるかを本番で追い、上限とkを見直す。日付による追加のrun上限は設けない。
- **退けた代替**: 失敗した準備試行まで数えて翌UTC日を待つ日次上限。providerの実際のquotaとは別であり、#73の補充を妨げた。

## 6. gVisorでの隔離と、エージェントに認証情報を渡さない

- **観測**: Anthropic Mythos scaffoldはinternet隔離containerで動かし、Cloudflare、Codex Securityも隔離環境で検証する。Anthropicの後継reference harnessはgVisor / microVMを使う。Patchstackは「clearly not tested against the actual plugin」の報告を即時1週間BAN、Bugcrowdは無効10件でBAN、Google OSS VRPは2026-10-01に自動提出の氾濫で受付停止。
- **示さないこと**: gVisorが通常のDockerより安全だという定量比較はこの調査には含まれない（gVisorの設計上の理由はDESIGN-WALKTHROUGH第8節）。
- **測る**: 隔離はablationの対象にしない（安全上の不変条件）。spikeで性能とheadless browserの可否だけ測る。
- **退けた代替**: 通常のDockerへのfallback。対象コードがホストカーネルに触れる。

## 7. 既知脆弱性は評価では時点で切り、本番では対象の公開履歴を渡す（ADR 0012、0001を置き換え）

- **観測**: Anthropic（threat modelの初期化に過去の脆弱性とgit historyを使う、2026-05-27）、Big Sleep（修正commitをseedにしたvariant analysis、2024-10）、Mantis（`mantis-history`、2026-10-06）、Chrome（全CVEとgit historyのknowledge base、2026-07-30）は、対象の履歴を探索の入力に使う。WordfenceとPatchstackは修正の回避を新規として受理する。一方、CWE-Trace（2026-06-18）は汚染sampleの84%に使える記憶信号がないと報告し、Aikidoでは96 trace中95で旧CVEを記憶から検討していた。
- **示さないこと**: 履歴を渡すとWordPressプラグインで当たり率が上がるという数値はない。錨付け（履歴に引きずられて新しい場所を読まない）の有無も未測定。
- **理由**: 本番対象は最新版なので既知は修正済みで、履歴から見つかるのは「修正の回避」と「変種」であり、どちらも提出できる新規。評価の汚染は、held-outの公開日で履歴を切れば防げる。
- **測る**: ablation「履歴有無」をrunの分担で行い、target-hitと当たり1件あたりの費用を比べる。評価側のテストで、評価runの履歴にheld-out公開日以降の記録が含まれないことを検査する。鍵に公開日とmodel cutoffを記録し、cutoff前後で表示を分ける。
- **退けた代替**: 全面禁止（ADR 0001）は本番の当たり率を落とす。時点を切らない受け渡しは評価を壊す。PoCまで渡すのは答えのなぞりになる。

## 8. 人間が書くtrust境界宣言

- **観測**: Anthropic「Name what is trusted」、ChromeのSECURITY.md、Codex Securityの編集できるthreat model、AVDHの人間承認付きthreat model。全設計が何らかの形で「何を信頼するか」を人間が与える。
- **示さないこと**: 宣言の有無が当たり率に与える差の数値はない。
- **測る**: 当面はablationに含めない（WordPressでは宣言がほぼ定型のため）。Findingの攻撃者位置がcontributor以上に偏ったら宣言の効き目を疑う。

## 9. 答えの鍵、盲検rubric、区間、負の対照

- **観測**: HoF-Bench（95 CVE）はWilson区間を付け、文脈の効果+2.2ptの区間が0を含むので主張しない。Bowyer et al.（ICML 2025）は数百件未満でCLT区間を使うと不確実性を大きく過小評価すると示す。RealVulnは場所の重なりを機械採点、HoF-Benchは盲検LLM judgeを使う。VLBは修正版で何かを出せば偽陽性とする。Mythos-Linked Rediscoveryは6 task × 3回を記述統計に留める。
- **示さないこと**: 9件×5試行で検出できる差は大きいものだけ。例えば5/5と3/5のClopper-Pearson区間は[0.48, 1.00]と[0.15, 0.95]で重なる。
- **測る**: 区間を必ず併記し、重なる差は「差なし」でなく「判定不能」と書く。本番で公開した発見をheld-outへ足して増やす。
- **退けた代替**: 区間なしの単一数値（Aikido、Neef et al.）。少数サンプルで誤った結論を出す。

## 10. 収益の見通し（KPIの現実性）

- **観測**: Wordfence月次（2026-04〜06）は提出1,066〜1,288件、in-scope 13.6〜17.4%、平均報奨$205〜231、最高$4,914〜6,436。上位研究者は月6〜14件、$1,665〜8,297。Patchstackは2026-06-01からcontributor除外、受理条件の列挙、却下率50%以上で1か月除外、誤ったAI前提は即時BAN。
- **示さないこと**: AIハーネスでこの上位帯に入った公開例はWordfence PRISM（組織、報奨N/A）だけ。上位の人間研究者でAI手順を公開した例は見つからなかった。
- **含意**: KPI「$250以上×月2.5件」は平均報奨（約$220）より上の帯を狙う設定で、High Threat（25件以上から対象）とCommon（500件以上）に寄せる選定方針が要る。却下率は収益に直接効くので、`runtime-confirmed` だけを提出する規律が経済的にも必要。
- **測る**: 台帳のfunnelと提出転帰。3か月でin-scope提出が月2件未満なら、選定方針（対象数×当たり率）を先に疑う。

## 11. 根拠が弱いまま進める項目（明示）

| 項目 | 状態 | いつ確かめるか |
| --- | --- | --- |
| Trial上限6、k_t = 3、同時2 | #73では公開2事例のsource候補0件で最適値は不明 | 本番のusage、provider limit、初回発見Trialを追う |
| 保存先成分での分担 | Mythosのfile別並列からの類推 | 本番のscope別候補率を見る |
| 探索agentへsubscriber認証情報だけ渡す | 両プログラムの規則からの演繹。探索への影響は未測定 | Findingの攻撃者位置の分布を見る |
| Sol（gpt-6.1-sol）のWordPressでの当たり率 | 公開数値なし | held-out評価 |
| 1 Trialの費用 | #73でtokenとwallを記録。金額はproviderが返さず `unavailable` | 本番のusageと提出転帰から見直す |
| 盲検rubricの採点者が本人1人 | 盲検の独立性が弱い | 採点記録を残し、後日再採点できるようにする |
| gVisor内headless browser | 2026-10-08のspikeで起動とLab応答を確認 | 実候補の検証で再確認 |

## 12. held-outを既定にしない（本番A/Bと前向き評価を主指標にする）

- **観測**: 旧N = 40で見積もったheld-out 9件×5試行の最大1,800 runは、現行のTrial上限6には当てはまらない。それでも評価caseを増やすと本番探索に使うTrialとprovider quotaを消費する。本人発見5件は2026年前半の公開で、gpt-6.1-solのcutoff（2026-04-30）以前の可能性が高い。5/5と3/5の区間は重なる（第9節）。公開資料で、探索対象を凍結して後日のadvisoryで採点する前向き評価の例は見つからなかったが、Chromeは「Not Reproducible」で閉じたbugを評価caseに再利用し、XBOWは提出転帰（resolved / triaged / duplicate / informative / N/A）を主要な公開指標にしている。
- **示さないこと**: 本番A/Bが対象ごとの差を同じcaseで比べるheld-outと同じ検出力を持つかは未確認。前向き評価は数か月遅れる。
- **理由**: runが独立なので、同じ対象でrunを構成A / Bに分担すれば、予算を本番に使いながら構成差を測れる。収益に直結するのは提出転帰で、held-outの当たり率ではない。
- **測る**: 本番A/Bは対象をまたいで対で集計し区間を付ける。前向き評価は四半期ごとに台帳を再採点する。held-outは大きな設計変更時に、cutoff後の補助4件を優先して予算内で回す。
- **退けた代替**: held-outを本番前の必須関門にする案。費用が本番と同等で、9件では大きな差しか検出できない。
