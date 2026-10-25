# WordPress プラグインの上位研究者は、どう脆弱性を見つけているか（公開資料の調査）

調査日: 2026-10-25。Web 検索と公開ページの取得だけで調べた。リポジトリのファイルは読んでいない。ペイロード、PoC、再現手順は集めていない。

表記の約束:

- 「本人の記述」は、その研究者や組織が自分で書いた、または話した内容である。
- 「推測」は、公開資料から私が推し量った内容である。根拠は付けるが、本人の言葉ではない。
- 出典は [S番号] で示す。一覧は末尾にある。
- wordfence.com は直接取得すると WAF の確認画面が返る。そのため一部は r.jina.ai 経由で本文を取得し、一部は malware.news の転載で読んだ。転載で読んだものは出典一覧に明記した。

---

## 1. 研究者ごとの公開手法

依頼にあった 20 名について、手法を語った一次資料を探した。手法を自分の言葉で語った資料が見つかったのは、Ananda Dhakal と João Pedro Soares de Alcântara（Kinorth）の 2 名だけである。残りの多くは、Wordfence / Patchstack のプロフィールと、CVE のクレジットしか見つからなかった。

### daroo（177 件）

- **公開資料なし。** Wordfence のプロフィールは `researchers/daroo-2` にある。bio、所属、外部リンクは空欄である [S10]。
- プロフィールから読める数字は次のとおり（2026-10-25 時点）[S10]。
  - 通算 360 件、通算順位 20 位。
  - 直近 90 日に公開された提出が 45 件。最終公開は 2026-10-22。
  - 1 ページ目の 20 件のうち 14 件が Stored XSS である。
- 2026 年 6 月の Wordfence 月報では、範囲内の提出数で 1 位（9 件）、報酬額で 2 位（USD 4,858）だった [S8]。
- 推測: 1 本のプラグインあたりの件数が少なく（177 件で 137 プラグイン）、Stored XSS に偏っている。これは、少数の型を多くのプラグインに当てて回る広さ優先の進め方と整合する。ただし、本人はそう述べていない。

### Nguyen Ba Khanh（63 件）

- **公開資料なし。** Wordfence には同名のプロフィールが 3 つある（無印、`-2`、HPT Vietnam Corporation）。同一人物かどうかは確認できない。そのうち 1 つの bio は「ベトナム拠点で、責任ある開示と WordPress プラグインのセキュリティに関心がある」程度の内容である。

### dutafi（63 件）

- **公開資料なし。** Wordfence のプロフィールに bio もリンクもない。1 ページ目の 20 件のうち 14 件が、未認証の Stored XSS である [S9]。

### Phat RiO（61 件）

- **公開資料なし。** Wordfence のプロフィールだけが見つかった。最近の掲載は、Missing Authorization と CSRF が中心である。

### Jakub Herman（58 件）

- **公開資料なし。** Wordfence と Patchstack にプロフィールがある（Patchstack では 66 件、Lvl 5）。Patchstack のページには Website / GitHub / X の欄があるが、取得した本文にはリンク先が含まれていなかった [S9]。

### Wordfence PRISM（46 件 / 全 355 件）

- 第 2 節で扱う。

### Rafie Muhammad（42 件）

- **手法の公開資料なし。** 公開プロフィールでは、2022 年 11 月から Patchstack の Lead Security Researcher とされている（theorg.com）。一方で、Wordfence のプロフィールの所属は Awesome Motive, Inc. になっていて、食い違う。
- 2026 年 4 月の Wordfence 月報では、範囲内の提出数と報酬額の上位 5 名に入っている [S8]。
- 推測: Patchstack の社内研究者であれば、Patchstack 経由のクレジットの一部は業務としての調査かもしれない。

### Nabil Irawan（42 件）

- **公開資料なし。** 検索では同名の研究者が見つからなかった。

### 0xd4rk5id3（42 件）

- **手法の公開資料なし。**
- Patchstack のプロフィールにはサイト、X、GitHub のリンクがある。数字は 305 件、Lvl 7、20 位である [S35]。
- サイトにあるのは CTF の解説（TryHackMe、HTB など）だけである。GitHub に WordPress 用のスキャナや semgrep ルールは無い。
- GitHub の自己紹介には「WordPress のエコシステムで 300 件超の検証済み報告」とある [S35]。
- 掲載 100 件ほどの内訳は、アクセス制御、XSS、SQLi、権限昇格、ファイル削除・取得、アップロード、PHP オブジェクトインジェクションが並ぶ。特定の型には偏っていない。

### Ananda Dhakal（39 件）— 手法を語った数少ない一人

本人の記述:

- 2026-08-23 の「More Criticals, Less Dopamine」[S12] で、Claude と Codex を名指しして、AI にコード解析の大半を任せていると書いている。
  - 手作業の深いコードレビューは「何か月も」していない。
  - 半分の場合はコードを読む必要すらない。
  - 自分の主な仕事は、モデルが「ずる（cheat）をしていないか」を確かめることだという。
  - 進め方は、AI に有望な経路を示させる → PoC を出させる → 外側から試して確定する、というものである。
  - 「ハッキングは今や『どこを、何を』の問いで、確かめるのは自分だ」という趣旨を述べている。
  - この数か月で、WordPress の脆弱性調査を自動化するツールを作り、論文を書いたとも述べている（ツールと論文の所在は確認できなかった）。
  - 対象の選び方、件数、時間は書いていない。
- 2026-04-24 の「The Silent Death of Open-Source Bug Bounty」[S13] で、Patchstack の社員として Patchstack の月次の受理数を公開している。
  - 2025 年 11 月から 2026 年 3 月にかけて、提出は 1,124 → 2,141（2 月、過去最多）と増えた。
  - 受理率は 66.5% → 13.5%（3 月）と落ちた。3 月は重複が 429 件だった。
  - 2 月の急増は Opus 4.6 の公開と結び付けている。3 月については「LLM が同じバグを見つけた。重複祭りだ」と書いている。
  - Patchstack は、対象を高い影響のものに絞り、毎月基準を上げて対応した。

公開されている数字:

- Wordfence の過去 30 日ランキング（2026-09-25 以降の集計）で 1 位、157 件である（2 位は PRISM の 74 件）[S9]。
- プロフィールは通算 554 件、通算 11 位である。一方で「直近 90 日の公開提出 0」とも表示されている [S11]。

推測:

- Wordfence への直接提出ではなく、Patchstack 側で CVE になったものが Wordfence に取り込まれ、そこでクレジットされている可能性が高い。
- 自作ツールによる大量の監査を、Patchstack の業務として回している可能性がある。

### Supakiad S.（m3ez）（37 件）

- **公開資料なし。** Wordfence の過去 30 日ランキングで 19 位（17 件）[S9]。

### h0xilo（35 件）

- **公開資料なし。** 2026 年 4 月の月報で、範囲内の提出数 5 位、報酬額 1 位だった [S8]。2026-06-23 に 25 件がまとめて掲載されている。

### Athiwat Tiprasaharn（Jitlada）（33 件）

- **公開資料なし。** 通算 225 件。認証済みの XSS とファイル操作系が多い。

### hhhai（28 件）

- **公開資料なし。**

### João Pedro Soares de Alcântara（Kinorth）（25 件）— 大量監査を自分で語った例

本人の記述（Patchstack のインタビュー、2025-03-05 [S16]）:

- 2024 年 10 月の Patchstack 特別イベント（新規追加プラグインが対象）で、「まず WordPress の SVN リポジトリから入手できる全プラグインをダウンロードした」と述べている。
  - 月例の競技で既に扱われたプラグインは除き、新しく追加されたものだけを残した。
- 最初に見るのは WordPress の hook の誤用である。特に、利用者を確かめずにリクエストを受ける AJAX hook をよく見つけるという。
  - `admin_enqueue_scripts`、`admin_notices`、`is_admin()` のように、名前のせいで「管理者専用」と誤解されやすいものを挙げている。
- 中心の道具は正規表現（regex）で、「最短時間で最大の件数」を狙ったという。
  - バグを 1 件確かめるたびに、その型専用の正規表現を書き、似たコードを全体から探す。同じ型が繰り返し現れるからである。
- 重複を避けるために、「明らかに脆弱なコード」から先に当たる。最初に見つけた人が勝つからである。
- 結果として 10 月だけで 275 件を報告した（本文では「数日で」とある）。種別は、最終的に XSS と SQLi に集中したという。
- semgrep や AI の使用には触れていない。

ほかに分かること:

- Wordfence の過去 30 日ランキングで 3 位（51 件、表記は「João Pedro S Alcântara」）[S9]。
- 推測: 2024 年は AI なしの正規表現による一斉検索だった。2026 年の手法は公開されていない。

### Erwan LR（24 件）

- **手法の公開資料なし。** WordPress.org のプロフィールでは、Automattic / Jetpack / WPScan の Security Engineer である。WPScan の社員としての調査とみられる（推測）。

### kr0d（23 件）

- **公開資料なし。**

### VanTastic（20 件）

- **公開資料なし。** Patchstack のプロフィールはベトナム、36 件、Lvl 4。SQLi、POI、XSS、アクセス制御が並ぶ [S9]。

### João Ramos Maciel（20 件）

- **公開資料なし。** Wordfence のプロフィールだけが見つかった。

### Drew Webber（mcdruid）（19 件）

- **WordPress の手法についての公開資料は見つからなかった。** Wordfence のプロフィールには、未認証の Stored XSS、PHP オブジェクトインジェクション、Missing Authorization が並ぶ。

### 参考: 上位 20 名ではないが、手法を公開している人

- **Denver Jackson**（Patchstack のインタビュー、2025-05-06 [S17]）
  - インストール数が多いのに、コードが単純か古いプラグインから当たる。
  - 最近の changelog や patch notes を先に読み、「何が直され、何が見落とされたか」を考える。
  - そのうえで PHP を手で読む。見る場所は、未認証の AJAX ハンドラ、REST ルート、壊れた nonce / capability の検査である。
  - 最初の 0-day は、既に修正された報告を自分で再現し、その周辺の認証処理を掘って見つけた（10 万インストール超）。
- **Kévin Mosbahi（Mika）**（2025-01-21 [S18]）
  - 初めはプラグインを「ランダムか、テーマ別に」選んでいた。
  - ブラックボックスからホワイトボックスへ移った。
  - 知っている危険な関数やパターンを探して読む。手作業が中心で、自動化はほとんど使わない。
  - 主な狙いはアクセス制御の不備と権限昇格。報告は約 630〜700 件である。
- **Dhabaleshwar Das**（2025-02-14 [S19]）
  - パラメータから入り、挙動を崩して観察する。
  - 主な狙いは CSRF、アクセス制御、SSRF、XSS。道具の話は無い。
- **Mat Rollings（stealthcopter）**（2024-07-22 [S34]）
  - 2024 年上半期に、Wordfence へ約 180 件（USD 23,000）、Patchstack へ約 100 件を報告した。
  - 「独自の自動化」で低労力・低報酬の報告を大量に出し、そのせいで平均報酬が下がったと書いている。
  - 範囲内の母集団を「1,000 インストール以上のプラグイン約 8,300 本」と見積もっている。

---

## 2. Wordfence PRISM とは何か

### 本人（Wordfence）の記述

- **正体。** Wordfence 社内の AI 脆弱性研究プロジェクトで、「自律型 AI 脆弱性インテリジェンス・エージェント」と呼ばれている [S2][S3]。
- **始まり。** 2026-07-23 の記事に「3 か月前に公開した」とある。そこから逆算すると 2026 年 4 月ごろになる [S2]。
- **プロフィールの説明 [S1]。** 研究者プロフィールの bio は次の内容である。
  - 「専門エージェントがそれぞれ脆弱性スペクトルの別の帯域を分析する」。
  - 対象の種別は「XSS から deserialization まで」。
  - 「WordPress のグラウンドトゥルースに導かれ」ている。
  - 「経験的な PoC の実行で検証される」。
  - つまり、脆弱性の種別ごとに専門のエージェントを置き、PoC を実際に動かして確かめる構成だと自ら説明している。
- **規模の推移。**
  - 2026-07-23 時点: 通算 202 件、直近 30 日で 88 件（1 日平均 2.8 件）、「純粋に自律的に」見つけたという。過去 30 日の 1 位でもあった [S2]。
  - 2026-08 の Argus の記事: 「300 件超」、直近 30 日の 1 位、「最も多産な研究者」[S4]。
  - 2026-10-25 時点のプロフィール: 通算 355 件、通算 21 位。直近 20 件の内訳は、XSS 7、POI 3、認可不備 5、権限昇格 2、SQLi / パストラバーサル / ファイルアップロード 各 1 [S1]。過去 30 日では 2 位（74 件）[S9]。
- **位置付け（Argus との対比）[S4]。**
  - 「PRISM は幅優先の半分」で、「あらゆる脆弱性種別と脅威モデルにわたる膨大な面を、自分だけで一日中掃く」。
  - 1 件の発見は、欠陥 1〜数個か、1〜2 段の短い経路が普通だという。
  - 深さ優先の Argus は、1 つの対象に張り付いて長い連鎖を探す。Avada の 6 段の連鎖を約 2 時間で見つけ、PoC まで書いたとされる。
- **設計の非公開 [S5]。** Maunder は Argus について、モデル、プロンプト、ハーネスの設計を明かさないと書いている。理由は「脅威アクターとの競争だから」である。
  - 着想は「confine, constrain, focus, motivate, parallelize, hypothesize, verify, record, prioritize」を速く回すことだという。
  - モデルには依存しない作りで、新しいモデルが出たら差し替えて能力を測る。
  - 効いているのは「プロンプト設計、ハーネス設計、タスク別のモデル選び、従来型の決定論的なプログラム」だとしている。
- **バックドアの検出 [S3]（2026-07-28）。**
  - ARVE（約 2 万インストール）に悪意あるコードが入ってから約 1 時間 51 分後に、PRISM が報告を出した。
  - その 10 分後に、Wordfence 側が PoC を確かめた。
  - PRISM が何を監視しているか（全プラグインの更新か、コミットか）は書かれていない。
- **トリアージ側 [S2][S6]。**
  - 人の研究者からの提出も PRISM の提出も、AI 支援のトリアージ道具「Eclipse」で振り分けている。
  - 社内では OpenAI / Anthropic / Google のモデルを組み合わせ、探索、トリアージ、データ処理に使っている。

### 推測

- 「種別ごとの専門エージェント＋PoC 実行による検証」という説明と、1 件が短い経路で終わるという説明から、PRISM は脆弱性の型ごとに広く浅く当てて回る構成とみられる。
- 1 日約 3 件の公開件数は、人の上位研究者（daroo で月 10〜20 件程度）を大きく上回る。
- 更新を監視して差分を当たる運用もしているように見える。根拠はバックドアを 2 時間未満で見つけた事例だが、明言はない。

### Wordfence / Patchstack の、AI 研究者と AI 提出への方針（2025〜2026）

- **Wordfence の数字 [S6]（2026-04-10、Maunder）。**
  - 2025 年 11 月下旬から、提出フォームで AI の使用を自己申告させている。
  - AI 支援の報告は、最初の週の 16% から約 66% に増えた。2026 年 3〜4 月に、AI 支援の報告が非支援を上回った。
  - 報酬は AI の有無で変えないので、偽る動機は無い、と説明している。
  - 提出数は 2025 年 10 月から 453% 増えた。
- **Wordfence の利用規約 [S7]（2026-10-25 に取得）。**
  - AI の使用は提出フォームで正確に申告する（§4.10）。
  - AI が生成した報告は、提出前に本人が確かめる（§4.12）。
  - AI などの道具で報告を一括生成・一括提出することは禁止（§4.13）。
  - 自動化道具による一括の発見が疑われる場合、その人の報酬水準を制限できる（§4.1）。
  - 未検証の PoC や存在しない脆弱性は「hallucination」として扱い、30 日で 2 件なら 30 日の制限がかかる（§4.6）。
  - 保留できる件数に上限がある（New 15 / Standard 10 / Resourceful 25 / 1337 50）。
  - 重複は最初の提出者だけが対象である。同じコードベースを共有する脆弱性に追加の報酬は出ない。10 版以内のパッチ回避は満額にならない。
- **Patchstack の方針 [S14]（2026-05-29、Dave Jong）。**
  - 2026-06-01 から、contributor を対象外にした。
  - 種別ごとに条件を付けた（XSS は全サイトに及ぶものか reflected、設定変更は重要なオプションに限る、など）。
  - 月間報酬を上位 5 名に絞った。
  - 「誤った AI 生成の前提」を含む報告や、実物で試していない報告は、即座に 1 週間の停止になる。
  - 1 つの脆弱性に 20 件超の重複が来た例があると書いている。
- **Patchstack の規則（2026 年版）[S15]。**
  - 同じ種別の複数の発見は 1 本にまとめる。
  - 重複は、パラメータやエンドポイントが違っても、最初の有効な提出が勝つ。
  - 却下率が 50% 以上なら、1 か月ランキングから外す。
- **AI の研究者がランキング上位に入っている。**
  - Intrudify の AI は、2026 年 9 月の Patchstack で 71 件（月全体 445 件の 16%）を出し、1 位になったと自社で書いている [S28]。Wordfence の過去 30 日ランキングでも 4 位（43 件）である [S9]。
  - Patchstack 自身も Gemini 2.5 Pro を使う AI Code Reviewer を作っている [S22][S23]。Scanner がファイルを選び、Verifier が計画を立てて JSON で結論を出す 2 段の構成である。「自動では検出できなかった新しい CVE 約 10 件」を挙げている。

---

## 3. 大量監査・変種探しの公開手法

### 2025〜2026 の事例

- **Austin Ginder（anchor.host、2026-07-07）[S24]。**
  - 対象は wordpress.org の上位 5,000 本で、最新版だけを監査する。ファイルのハッシュで同一ビルドを 1 回にまとめる。
  - Claude Code のスラッシュコマンド 4 本で回す。
    1. 並列のサブエージェントが全 PHP ファイルを読み、未検証の候補を出す。
    2. 同じ版を新しいローカル WordPress に入れ、状況を作って発火を試す。発火しない候補は捨てる。
    3. 影響の大きいものを Patchstack / Wordfence へ出し、それ以外は vendor へ送る。
    4. 範囲外や重複を整理し、受理されたものを CVE まで追う。
  - 規模は、1 回 10 並列で約 100 本。7 日で 918 ビルド、1 日の最大は 396。50 万インストール以上は全数を終えた。
  - 2026 年 5 月の Patchstack の結果は、受理 10、重複 7、却下 5（約 USD 550）。Wordfence は受理 1、重複 6、範囲外 1。
  - 費用は Claude Max（月 USD 200）で、週約 1,000 本と見積もっている。
  - 公開ページからは、提出前に重複をどう照合しているかは読み取れない。
- **Muhan Luo（Infosec Write-ups、2026-05-17）[S25]、ルール集 [S26]。**
  - 上位 10,000 本を相手に、semgrep の join で「`wp_ajax_` / `admin_post_` / `admin_action_` への登録」と「capability / nonce の検査が無いコールバック」を突き合わせる。
  - 約 11,000 件の候補を Claude（Opus 4.6）で 1〜5 点に採点した（約 USD 120）。1〜2 点の約 100 件を抜き取ると本物は 0 件だったので、確認対象を約 1,400 件に減らした。
  - 確かめは Docker の WordPress 環境で行う。成果は 7 件。
  - Claude は、WordPress 固有の保護（スーパーグローバルの自動エスケープなど）を見誤ることがあったという。
- **TrendAI / CHT Security（Ekoparty Miami、Help Net Security 2026-05-22）[S27]。**
  - AI による静的解析、Docker の自動構築、Chrome DevTools MCP での動的検証を組み合わせた。
  - 72 時間で重大な 0-day を 300 件超、約 2.22 億トークン、1 件あたり約 USD 20。
  - 動的検証で誤検知の 8 割超を落とした。
  - 人による確認は 1 件あたり 30〜60 分かかり、そこが詰まりどころだった。
  - 一次資料（講演資料）は取得できなかった。どのプラグインを選んだかは不明である。
- **Luke Herbrandson（Sucuri、2026-08-14）[S29]。**
  - Claude Opus 4.8 と Claude Code で、小規模なプラグイン数十本を読んだ。
  - 対象の選び方:
    - インストール数より更新の止まり具合を重く見る。
    - 不動産、イベント、インポート、予約、特殊な EC のように、注目されにくい分野を選ぶ。
    - 過去の CVE は「文脈であって証拠ではない」。
  - 進め方は、入口、データの流れ、重い操作を AI に洗い出させ、各権限で外から試し、検査が実際に何を強制しているかをソースで追う、というものである。
  - 候補は、クリーンなスナップショットからの再現だけを数えた。確認できたのは 16 件。
  - AI がもっともらしく間違えた例を挙げている（存在しない権限検査、実行時には成立しない SQLi、届かない gadget）。
- **Sebastian Neef ほか（arXiv、2026）。**
  - 6 つの LLM で WordPress プラグインの SQLi / Stored XSS / パストラバーサル / RCE を静的に検出させた [S30]。
    - 最良は Opus 4.6 の 63%。
    - 種別を絞ったプロンプトが、自由形のプロンプトより良かった。
    - 3 回の反復で、一貫して当てたモデルは無かった。
  - 別の論文 [S31] では、上位 300 本（有効インストールの 75%）を、静的と動的の両方の解析をするエージェントで調べ、ログファイルの露出に絞って 81 件を報告した（再現 79 件）。「1 つの型を上位プラグインに一斉に当てる」形の例である。
- **Ananda Dhakal [S12][S13]**（第 1 節）。自作ツールで自動化していると本人が述べている。過去 30 日で 157 件という数字は、この節の事例として最大規模である [S9]。

### 2025 年以前の背景（手法の型として）

- **全数取得＋正規表現。** Kinorth（2024 年 10 月）[S16]。SVN から全プラグインを取得し、確かめた 1 件ごとにその型の正規表現を書き、全体を検索した。
- **semgrep の一斉実行。** noob3xploiter（2023-11-01）[S33] は、1 万インストール以上の 2,524 本に CSRF のルールを当てた。510 本で候補が出て、報告 55 件、受理 43 件、誤検知 455 件だった。
- **ファジング。** kazet の wpgarlic [S32] は、計装した PHP の Docker 環境で、AJAX、REST、メニュー画面、パラメータに印付きの値を入れる。重い関数の呼び出しを記録し、300 件超を見つけた。1 万インストール以上は 2021〜2024 年に作者が確認済みなので、人気の低いものから始めるよう勧めている。

### 変種探し・CVE を起点にする手法

- **Patchstack Academy の「CVE Reversing」[S20]。**
  - データベースから脆弱な版と修正版を取り、plugins.trac の trunk log で 2 版の差分を見る。
  - 種別に応じて sink や wrapper を探し、追加された sanitize や capability 検査から元の弱点を特定し、入力源まで逆にたどる。
  - 変種探しの明示は無い。同じ sink に至る他の経路を探すのは、自然な延長だと私は考える（推測）。
- **Denver Jackson [S17]。** changelog と修正内容を読み、「見落とされた所」を探す。修正済みの報告を再現した先で 0-day を見つけた。
- **Kinorth [S16]。** 確かめた 1 件から、その型の正規表現を作って全体を検索する。これは変種探しそのものである。
- **規則上の制約。**
  - Wordfence: 同じコードベースを共有する脆弱性に追加の報酬は出ない。10 版以内のパッチ回避は満額にならない [S7]。
  - Patchstack: 開示済みの不完全な修正は、新しい攻撃経路を生まない限り新規と扱わない [S15]。
  - 変種探しで報酬が出るのは、別のプラグインにある同じ型か、新しい経路に限られる。
- **Wordfence / Patchstack のデータを種リストに使う公開事例。** はっきり書いた一次資料は見つからなかった。
  - Muhan Luo のルール集は「主に Wordfence と Patchstack の資料」から作ったと書いている [S26]。
  - Sucuri の記事は、既知の脆弱性を対象選びの指標の 1 つに入れている [S29]。
  - Wordfence Intelligence のデータベースは API で無料で取れる、と公式が書いている（検索結果の要約から）。

---

## 4. 共通して見える手法の要約

1. **入口は WordPress の登録点から。** AJAX hook（`wp_ajax_` / `wp_ajax_nopriv_` / `admin_post_`）、REST ルートの permission_callback、nonce を権限検査と取り違えた箇所、`is_admin()` や `admin_*` hook の誤解を、最初に見る場所として挙げる人が多い。[S16][S17][S25][S26][S29]
2. **AI は候補出しと読み取りに使い、確定は実環境での再現だけで行う。** 「AI の出力は主張にすぎない」「クリーンな環境で再現できたものだけ数える」が共通の規則になっている。プラットフォーム側も、未検証の報告を停止処分の対象にした。[S12][S24][S25][S27][S29][S7][S14]
3. **安い絞り込みを前に、高い判断を後ろに置く。** regex / semgrep / 全ファイル読みで候補を広く出し、LLM で採点や読み取りをして、最後に Docker 上の動的検証と人の確認に回す。誤検知を落とすのは動的検証の段である。[S24][S25][S27][S33][S32]
4. **確かめた 1 件を型にして横に広げる。** 正規表現や semgrep のルールに落とし、全プラグインに当てる。PRISM も種別ごとの専門エージェントで「全種別を広く」掃いている。[S16][S1][S4][S31]
5. **対象の選び方は二通り。** 上位から全数を網羅する方法（上位 5,000 本や 10,000 本、50 万インストール以上は全数）と、注目の薄い所を狙う方法（コードが古い、更新が止まっている、ニッチな分野、新規追加）がある。[S24][S25][S17][S29][S16][S32]
6. **最新版だけを相手にする。** 同一ビルドはハッシュで 1 回にまとめ、更新が来たら差分を当たる。Patchstack も Wordfence も最新版でなければ受け付けない。[S24][S15][S7]
7. **修正差分と changelog を起点にする。** 2 版の diff から弱点を特定し、周辺や見落としを探す。ただし、同じコードベースの変種やパッチ回避は、報酬が減るか対象外になる。[S20][S17][S7][S15]
8. **重複は最大の損失要因になった。** 2026 年は LLM が同じバグを同時に見つけ、Patchstack では重複が月 429 件、1 件に 20 件超の重複が来た例もある。「明らかなものから先に、速く出す」ことが重複への対策として語られる。一方、提出前に公開履歴とどう照合しているかを書いた人はいなかった。[S13][S14][S16][S24]
9. **件数の多い人は、少数の高頻度の型に偏っている。** daroo、dutafi、Ananda Dhakal の直近は Stored XSS が過半で、Kinorth も最終的に XSS / SQLi に集中した。プラットフォームの範囲が狭まるのに合わせて、型も変わっている。[S10][S11][S16][S14]
10. **量の水準。** 人と AI の組み合わせで月数十〜150 件超、純粋な AI で 1 日 3 件前後。1 件の人手確認は 30〜60 分という報告がある。[S9][S2][S24][S27]

---

## 5. 見つからなかったこと

- daroo、Nguyen Ba Khanh、dutafi、Phat RiO、Jakub Herman、Nabil Irawan、m3ez、h0xilo、Jitlada、hhhai、kr0d、VanTastic、João Ramos Maciel、Drew Webber、Rafie Muhammad、0xd4rk5id3、Erwan LR について、手法を本人が語った一次資料（ブログ、講演、インタビュー、X のスレッド）は見つからなかった。件数上位の多くは、手法を公開していない。
- PRISM の内部構成。具体的には、使っているモデル、エージェントの数、何を監視しているか（全プラグインの更新か）、対象の選び方、人がどこまで確認しているか、である。Wordfence は「競争上の理由で明かさない」としている [S5]。
- Wordfence の 2026-04-10 の記事 [S6] の後半（AI 提出の質、重複率）。取得できた本文には書かれていなかった。
- 研究者が提出前に Wordfence / Patchstack の公開履歴をどう照合しているかの、具体的な手順。言及があるのは、プラットフォームが重複を記録したことだけである。
- Wordfence / Patchstack の API を種リストにして、1 つの型を repo 全体に当てる運用を明言した一次資料。
- 1 本のプラグインにかける時間の公開値。1 件の人手確認に 30〜60 分という報告は 1 件だけある [S27]。
- Ananda Dhakal が言う自動化ツールと論文の所在。
- TrendAI / CHT の Ekoparty の一次資料（講演資料、ブログ）。二次報道だけを読んだ。
- Patchstack の 2026 年白書にある AI 由来の提出の比率。検索結果の要約しか見ていない。

---

## 出典一覧

| 番号 | 著者・発信元 | 日付 | URL | 取得方法 |
|---|---|---|---|---|
| S1 | Wordfence（PRISM の研究者プロフィール） | 2026-10-25 取得 | https://www.wordfence.com/threat-intel/vulnerabilities/researchers/prism | r.jina.ai 経由 |
| S2 | Mark Maunder「A New Threat Landscape Meets A New Kind of Defender」 | 2026-07-23 | https://www.wordfence.com/blog/2026/07/a-new-threat-landscape-meets-a-new-kind-of-defender/ | r.jina.ai 経由 |
| S3 | Wordfence「Wordfence PRISM Detected Backdoored WordPress Plugin within Two Hours…」 | 2026-07-28 | https://www.wordfence.com/blog/2026/07/wordfence-prism-detected-backdoored-wordpress-plugin-within-two-hours-of-it-being-introduced/ | r.jina.ai 経由 |
| S4 | Wordfence「Wordfence Argus Finds Complex 6 Step Critical RCE in Avada Theme…」 | 2026-08 | https://www.wordfence.com/blog/2026/08/wordfence-argus-finds-complex-6-step-critical-rce-in-avada-theme-with-1-million-sales/ | 転載 https://malware.news/t/wordfence-argus-finds-complex-6-step-critical-rce-in-avada-theme-with-1-million-sales/125075 で読んだ |
| S5 | Mark Maunder「Wordfence Argus: Moving Beyond Human Research Capability」 | 2026-08 | https://www.wordfence.com/blog/2026/08/wordfence-argus-moving-beyond-human-research-capability/ | 転載 https://malware.news/t/wordfence-argus-moving-beyond-human-research-capability/125152 で読んだ |
| S6 | Mark Maunder「The Increasing Role of AI in Vulnerability Research」 | 2026-04-10 | https://www.wordfence.com/blog/2026/04/the-increasing-role-of-ai-in-vulnerability-research/ | r.jina.ai 経由 |
| S7 | Wordfence Bug Bounty Program Terms and Conditions | 2026-10-25 取得 | https://www.wordfence.com/threat-intel/bug-bounty-program/terms-and-conditions/ | r.jina.ai 経由 |
| S8 | Wordfence Bug Bounty Program Monthly Report（2026 年 4 月分、6 月分） | 転載 2026-07-31、2026-09-25 | https://malware.news/t/wordfence-bug-bounty-program-monthly-report-april-2026/124416 、https://malware.news/t/wordfence-bug-bounty-program-monthly-report-june-2026/125903 | 転載 |
| S9 | Wordfence Vulnerability Researcher Hall of Fame（過去 30 日）と各プロフィール、Patchstack の研究者プロフィール（Jakub Herman、VanTastic） | 2026-10-25 取得 | https://www.wordfence.com/threat-intel/vulnerabilities/researchers/ （dutafi、jakub-herman-2 など）、https://patchstack.com/database/researchers/4648835f-72f5-47c7-a9a7-de3b22b17fa3 、https://patchstack.com/database/researchers/3e8288b4-f897-44d4-9173-3599a3e0521d | r.jina.ai 経由／直接 |
| S10 | Wordfence（daroo のプロフィール） | 2026-10-25 取得 | https://www.wordfence.com/threat-intel/vulnerabilities/researchers/daroo-2 | r.jina.ai 経由 |
| S11 | Wordfence（Ananda Dhakal のプロフィール） | 2026-10-25 取得 | https://www.wordfence.com/threat-intel/vulnerabilities/researchers/ananda-dhakal | r.jina.ai 経由 |
| S12 | Ananda Dhakal「More Criticals, Less Dopamine」 | 2026-08-23 | https://dhakal-ananda.com.np/misc/more-criticals-less-dopamine/ | 直接 |
| S13 | Ananda Dhakal「The Silent Death of Open-Source Bug Bounty」 | 2026-04-24 | https://dhakal-ananda.com.np/misc/silent-death-of-oss-bb/ | 直接 |
| S14 | Dave Jong（Patchstack）「The future of the Patchstack bug bounty program」 | 2026-05-29 | https://www.patchstack.com/articles/the-future-of-the-patchstack-bug-bounty-program/ | 直接 |
| S15 | Patchstack Bug Bounty Guidelines & Rules（2026 年版） | 2026-10-25 取得 | https://patchstack.com/articles/bug-bounty-guidelines-rules/ | 直接 |
| S16 | Maciek Palmowski（Patchstack）「Meet João Pedro Soares de Alcântara AKA Kinorth」 | 2025-03-05 | https://patchstack.com/articles/meet-joao-pedro-soares-de-alcantara-aka-kinorth/ | 直接 |
| S17 | Patchstack「Interview with Denver Jackson」 | 2025-05-06 | https://patchstack.com/articles/interview-with-denver-jackson/ | 直接 |
| S18 | Patchstack「Interview with Kévin Mosbahi AKA Mika」 | 2025-01-21 | https://patchstack.com/articles/interview-with-kevin-mosbahi-aka-mika/ | 直接 |
| S19 | Patchstack「Interview with Dhabaleshwar Das」 | 2025-02-14 | https://patchstack.com/articles/interview-with-dhabaleshwar-das/ | 直接 |
| S20 | Patchstack Academy「WordPress CVE Reversing」 | 日付なし | https://patchstack.com/academy/wordpress/getting-started/cve-reversing/ | 直接 |
| S21 | （欠番） | | | |
| S22 | Oliver Sild（Patchstack）「Patchstack AI code review tool and Security Suite」 | 2025-06-05 | https://patchstack.com/articles/patchstack-ai-code-review-mvdp-release/ | 直接 |
| S23 | Google for Startups の Patchstack 事例 | 日付なし（2025 年半ば以降と推定） | https://startup.google.com/alumni/stories/patchstack-gemini-integration/ | 直接 |
| S24 | Austin Ginder「My AI Security Pipeline for WordPress Plugins」 | 2026-07-07 | https://anchor.host/anyone-can-audit-wordpress/ | 直接 |
| S25 | Muhan Luo「Hunting CVEs in WordPress Plugins using Claude + Semgrep」 | 2026-05-17 | https://infosecwriteups.com/hunting-cves-in-wordpress-plugins-using-claude-semgrep-1f0c82453356 | r.jina.ai 経由 |
| S26 | muhanLuo「wordpress-plugin-semgrep-rules」 | 2026 | https://github.com/muhanLuo/wordpress-plugin-semgrep-rules | 直接 |
| S27 | Mirko Zorz（Help Net Security）「$20 per zero-day is already the WordPress plugin reality」 | 2026-05-22 | https://www.helpnetsecurity.com/2026/05/22/ai-wordpress-plugin-vulnerabilities/ | 直接 |
| S28 | Marc Balasescu（Intrudify）「The #1 WordPress Hacker This Month Wasn't Human」 | 2026-10-08 | https://intrudify.com/blog/patchstack-number-1-ai-wordpress-vulnerabilities/ | 直接 |
| S29 | Luke Herbrandson（Sucuri）「The Illusion of a Lock…」 | 2026-08-14 | https://blog.sucuri.net/2026/08/the-illusion-of-a-lock-how-ai-is-changing-the-speed-and-scale-of-hands-on-wordpress-vulnerability-research.html | 直接 |
| S30 | Sebastian Neef ほか「Evaluating LLMs for Real-World Web Vulnerability Detection」 | 2026-06-19 | https://arxiv.org/abs/2606.21397 | 直接 |
| S31 | Sebastian Neef「Plug 'n' Pray: Agentic LLM-based Detection of Potential Log File Exposures…」 | 2026-09-15 | https://arxiv.org/abs/2609.17164 | 直接 |
| S32 | kazet「wpgarlic」 | 2022〜2024 | https://github.com/kazet/wpgarlic | 直接 |
| S33 | Brandon Roldan（noob3xploiter）「Automating CSRF Detection in WordPress Plugins with Semgrep」 | 2023-11-01 | https://noob3xploiter.medium.com/automating-csrf-detection-in-wordpress-plugins-with-semgrep-52ece2c212b7 | r.jina.ai 経由 |
| S34 | Mat Rollings（stealthcopter）「Splashing around in the shallow end」 | 2024-07-22 | https://sec.stealthcopter.com/splashing-around-in-the-shallow-end/ | 直接 |
| S35 | Patchstack（0xd4rk5id3 のプロフィール）、同人の GitHub とサイト | 2026-10-25 取得 | https://patchstack.com/database/researchers/4e4561e4-5f79-419b-9832-33d7fd94c5a4 、https://github.com/d4rk5id3r 、https://0xd4rk5id3.github.io | 直接 |

出典に入れなかった参考資料:

- arXiv 2609.05335「The History Is the Detector」（2026-09-04）は、CVE の修正履歴を検出ルールに変え、安い段から高い段へ絞る funnel で回す研究である。WordPress には限らないので、出典から外した。
- Rafie Muhammad の所属（theorg.com）、Erwan LR（profiles.wordpress.org/erwanlr）、Patchstack の 2026 年白書は、検索結果の要約から引いた。本文は取得していない。
