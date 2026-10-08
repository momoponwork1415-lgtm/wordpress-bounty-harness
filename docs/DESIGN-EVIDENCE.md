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

## 4. 短い目的prompt＋短命runの多数独立実行（長い1セッションでなく）

- **観測**: Anthropicは「discovery promptは目的とcontextを与え、方法をmodelに任せる。長いchecklistは新規bugを減らす」と述べる（2026-05-27）。Mythos scaffoldはほぼ「find a security vulnerability」だけのpromptで、file別agentを並列に走らせた（2026-04-07）。Naptimeは「一つのtrajectoryで複数の仮説を扱うのは非効率なので独立trajectoryを複数sampleする」（2024-06）。Semgrepは同じpromptを同じappで繰り返すと指摘が毎回変わり（3→6→11件）部分的にしか重ならないと報告（2025-09-02）。run間の安定性は0.63–1.0（Semgrep 2026-07-17）。XBOWは永続coordinatorが多数の短命agentを指揮する（2026-03-02）。
- **示さないこと**: 「短いpromptが長いpromptより当たる」のAnthropicの観察は数値なし。本人のwp2shell promptで50万ドル級の発見があった事実と直接比較した資料はない。pass@kの独立性の保証（provider側cacheの排除等）を示した資料はない。
- **測る**: SPEC第6節のprompt比較。wp2shell由来と短い目的promptを、同じheld-out、同じmodel、同じHarnessで5試行ずつ回し、union@5とpass^5（全回成功）の両方を区間付きで出す。片方だけを報告しない。
- **退けた代替**: wp2shell promptを唯一の既定にする案。退けたのではなく「評価で選ぶ変数」にした。

## 5. N = 40、k = 4、同時4の初期値

- **観測**: Codex Securityのdeep scanが停止規則を設定で持つ（docs、2026-10-08取得）。Naptime、Chrome、XBOWは「複数run」「多数の短命agent」としか書かない。
- **示さないこと**: 40と4がWordPressプラグインで最適だという根拠はない。**これは初期値であって結論ではない。**
- **測る**: SPEC第14節のspikeで1 runの費用と時間を測り、held-outでの「何回目で初めて当たるか」の分布から上限とkを決め直す。
- **退けた代替**: なし。費用の実測前に固定しない。

## 6. gVisorでの隔離と、エージェントに認証情報を渡さない

- **観測**: Anthropic Mythos scaffoldはinternet隔離containerで動かし、Cloudflare、Codex Securityも隔離環境で検証する。Anthropicの後継reference harnessはgVisor / microVMを使う。Patchstackは「clearly not tested against the actual plugin」の報告を即時1週間BAN、Bugcrowdは無効10件でBAN、Google OSS VRPは2026-10-01に自動提出の氾濫で受付停止。
- **示さないこと**: gVisorが通常のDockerより安全だという定量比較はこの調査には含まれない（gVisorの設計上の理由はDESIGN-WALKTHROUGH第8節）。
- **測る**: 隔離はablationの対象にしない（安全上の不変条件）。spikeで性能とheadless browserの可否だけ測る。
- **退けた代替**: 通常のDockerへのfallback。対象コードがホストカーネルに触れる。

## 7. 既知脆弱性を探索に渡さない（oracle-free）

- **観測**: Anthropic、Mantis（`mantis-history`）、Chrome（全CVEのknowledge base）、Big Sleep（修正commitをseedにしたvariant analysis）は、過去の脆弱性を探索の入力に使う。つまり**大手の設計とは逆**である。一方、CWE-Trace（2026-06-18）は汚染sampleの84%に使える記憶信号がないと報告し、VentiVul（2026-08-17）は新しい脆弱性で性能が大きく落ちると報告。Aikidoでは96 trace中95で旧CVEを記憶から検討していた。
- **示さないこと**: oracle-freeが当たり率を上げるという証拠はない。むしろ既知情報を使えば既知の再発見は増える。
- **理由**: 目的が「未知の脆弱性で報奨を得る」ことなので、既知情報を使うと「見つけた」と「知っていた」を区別できず、Harnessの改善を測れない。本番では既知脆弱性は提出できない（duplicate）ので、再発見の能力は収益に寄与しない。
- **測る**: 答えの鍵に公開日とmodel cutoffを記録し、cutoff前後で当たり率を分けて表示する。前向き評価（本番台帳を後日のadvisoryで採点）を最終的な数字にする。
- **退けた代替**: 過去advisoryでthreat modelを初期化する案。本番の収益には効かず、評価を汚す。

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
| N = 40、k = 4、同時4 | 他社既定の流用 | spikeと最初の縦断スライス |
| 入口単位のfile分担 | Mythosのfile別並列からの類推 | ablation「分担有無」 |
| 探索agentへsubscriber認証情報だけ渡す | 両プログラムの規則からの演繹。探索への影響は未測定 | Findingの攻撃者位置の分布を見る |
| Sol（gpt-6.1-sol）のWordPressでの当たり率 | 公開数値なし | held-out評価 |
| 1 runの費用 | 未測定 | spike |
| 盲検rubricの採点者が本人1人 | 盲検の独立性が弱い | 採点記録を残し、後日再採点できるようにする |
| gVisor内headless browser | 未確認 | spike |
