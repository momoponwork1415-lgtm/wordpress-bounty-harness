# Wordfence Argus と PRISM の公開情報（2026-10-25 時点）

調べた範囲は、Wordfence のブログ、研究者プロフィール、脆弱性の詳細ページ、X の記事、2026 年の第三者の報道である。wordfence.com は直接取得すると WAF に止められるので、r.jina.ai 経由で読んだ。件数は、ローカルの Wordfence 履歴 mirror（`/home/dev/wp-bounty-workspace/intelligence/history.sqlite`、読み取り専用、最新レコード 2026-10-23 21:31）でも数え直した。方法と事例の水準にとどめ、ペイロードと再現手順は書かない。

本文では、Wordfence 自身の記述に「【本人】」、こちらの推測に「【推測】」を付ける。

---

## 1. Argus の公開事例一覧

研究者プロフィール（出典 [3]）には 9 件ある。ほかに、WordPress 以外のライブラリで 2 件を公表している（libheif、Ghostscript）。WordPress の 9 件はどれも人間との共同クレジットで、Alex Thomas が 5 件、Chloe Chamberland が 4 件である。

| 公開日 | 対象（種類、規模） | 種別 | CVSS | 連鎖の段数（記事の書き方） | 発見日 | 記事 URL |
|---|---|---|---|---|---|---|
| 2026-08-25 | Avada テーマ 7.16 + Fusion Builder 3.16（テーマ、販売 100 万超） | 未認証 RCE（任意ファイル書き込み） | 9.8 | **6 段**と明記。6 つの弱点は、どれ単独でもコード実行に届かない。管理者が書いた特定のコンテンツがあることが前提 | 07-30 | [2] |
| 2026-08-27 | WPMU DEV Dashboard ≤5.0.1（プラグイン、35 万） | 未認証の認証回避で管理者になる（Hub SSO 有効時） | 9.8 | 段数は書いていない。SSO の 2 つの手順のあいだで、署名する文面の区切りが曖昧なことを使う。管理者のコード編集機能があれば RCE に進む | 08-19 | [4] |
| 2026-09-01 | Gravity Forms ≤3.0.2（プラグイン、100 万超） | 未認証の任意ファイルアップロード（State/Chunk hash confusion） | 8.1（AC:H） | 段数は書いていない。一部のサーバー構成で RCE になりうる | 08-09 | [5] |
| 2026-09-11 | The Events Calendar ≤6.17.4（プラグイン、60 万） | 未認証 PHP Object Injection から RCE | 9.8 | 「2 本の独立した連鎖」の 1 本目。コメントをブロックとして処理する経路、モデレーション前のプレビュー、整合性ハッシュの偽造、デシリアライズの gadget を順につなぐ（段数は数えていない） | 08-21 | [6] |
| 2026-09-11 | The Events Calendar ≤6.17.3 | 未認証コード注入から RCE（callable の呼び出し） | 9.8 | 2 本目。1 本目と同じ入口から、オブジェクト検査を迂回して任意の callable に届き、管理者パスワードの再設定を経て乗っ取る | 08-22〜23 | [6] |
| 2026-09-11 | Tutor LMS ≤4.0.7（プラグイン、10 万） | Subscriber+ の PHP Object Injection から RCE | 8.8 | 段数は書いていない。修正は「4 つの独立した点」に入ったと書く（権限検査、直列化の長さずれの原因、キーの注入、メソッド検証） | 08-23 | [7] |
| 2026-10-08 | Ocean Pro Demos ≤1.5.4 / Ocean eComm Treasure Box ≤1.8.0（有料プラグイン） | 未認証 Stored XSS | 7.2 | 解説記事なし。有料ライセンス、特定モジュール、公開済みポップアップが前提 | 不明 | [3][19] |
| 2026-10-09 | Avada (Fusion) Builder ≤3.16.1 | 未認証で任意の WordPress action hook を呼べる | 9.1 | 解説記事なし。**Avada の修正版 3.16.1 にも残っていた**別の経路。未認証の要求 1 回で、ゴミ箱の投稿を恒久削除できることを確かめたと記録にある | 不明 | [3][20] |
| 2026-10-20 | Duplicator ≤1.5.17 / Duplicator Pro ≤4.6.10（プラグイン、100 万超） | 未認証 PHP Object Injection（二次的に発火） | 8.8（UI:R） | 二次的（second-order）な連鎖。コメントに値を置き、管理者が後で移行を実行したときに発火する。Free 版はコマンド実行まで、Pro 版はファイル削除から乗っ取りまで | 08-30 | [8] |
| 2026-09-01（修正版の公開） | libheif 1.18.0〜1.23.2（OS ライブラリ。WordPress の画像アップロードの下層） | ヒープバッファオーバーフロー | 9.8（保守者の採点。GHSA-x8r2-mggj-j6wr） | Author 権限のアップロードから、Imagick を経てライブラリに届く。特定の構成 1 つで、保護されたファイルの読み出しとコード実行を示した | 08-28 頃 | [9] |
| 2026-09-08（修正版の公開） | Ghostscript 9.21〜10.07.1（PDF のサムネイル生成の下層） | ヒープバッファオーバーフロー（CVE-2026-39919） | 9.8 | アップロードから Imagick、ImageMagick、Ghostscript、JPEG 2000 デコーダへと下る。特定の構成 1 つで、`-dSAFER` を有効にしたまま未認証のコード実行を示した | 08-23 | [10] |

補足:
- 発見日と公開日の差は 2〜7 週ある。プロフィールの集計は、2026-10-25 に取得した時点で「All Time Ranking 525、All Time Discoveries 9、90 Day Published Submissions 4、Last Published 9 Oct '26」だった（出典 [3]）。Duplicator（10-20 公開）が表にあるのに「最終公開 10-09」になっており、プロフィールの数字は完全には揃っていない。
- WordPress の 9 件のうち 8 件が CVSS 8.1 以上で、8 件が未認証である（例外は Subscriber+ の Tutor LMS）。XSS は 1 件だけ、SQLi は 0 件である。PRISM の分布とは正反対になっている（第 5 節）。

---

## 2. Wordfence が語る Argus の方法

### 2.1 本人の記述（引用・要約）

**位置付けと名前**
- 【本人】Argus は「積極的な脆弱性探索のために作った社内アプリケーション」である。「AI か、harness か、agent かを議論したが、どれも当たらない。harness、プロンプト、モデル、オーケストレーションなどを含むからだ」（Maunder、出典 [1]）。
- 【本人】記事によって呼び方が違う。「autonomous AI agent」（[1]）、「agentic framework, code named Argus」（[2]）、「AI research agent specializing in complex vulnerability chains」（[7]）、「agentic adversarial testing framework」（[9]）、「AI-assisted security testing / research system」（[8][10]）。8 月は「自律」を強調していたが、10 月は「AI 支援」の書き方に移っている。
- 【本人】プロフィールの自己紹介（[3]）:「ARGUS は対象をあらゆる角度から調べ、自明なところで止まらない。WordPress の ground truth に導かれ、経験的な PoC の実行で検証される。ARGUS の指令は 1 つ: [REDACTED]」。

**設計の原則として公表した語**
- 【本人】「confine, constrain, focus, motivate, parallelize, hypothesize, verify, record, prioritize, and then iterate hard and fast」（[1]）。
- 【本人】「脆弱性研究の革新は、プロンプトエンジニアリング、harness の設計、タスクごとのモデル選択、そして従来の決定論的なプログラムから生まれる」（[1]）。
- 【本人】モデルに依存しない作りで、能力と価格の釣り合いを見ながら、新しいモデルが出ると「すぐに切り替えて評価できる」（[1]）。
- 【本人】使っているモデルについて言及があるのは次の 3 か所だけである。「Mythos と、サイバー能力のある OpenAI と Anthropic のモデルで作業を続けている」（2026-10-08、[11]）。「OpenAI、Anthropic、Google の組み合わせで cognitive architecture を作っている」（2026-04-10、[12]）。「harness の工夫で、パラメータ数が控えめなモデルでも安いコストで目覚ましい結果が出る。自社の研究でもそれを見た」（2026-07-23、[13]）。

**探索の仕方**
- 【本人】「PRISM も Argus も、研究者なら誰でもやるやり方で狩る。危険な操作から逆向きにたどり、信頼できないものが届くかを見る。あるいは、信頼できない入力から順向きにたどり、何に触れられるかを見る。違うのは、その追跡をどこまで深く押すかだ」（[2]）。
- 【本人】Argus は「幅を捨てて 1 つの対象にとどまり、長い多段の経路を視野に保つ。悪用が数段先にしか存在せず、各段が前の段に依存する種類のもの」（[2]）。
- 【本人】ライブラリの 2 件では「アップロードされたファイルを、それを受け取った PHP コードの先まで追った」「データを最後まで下まで追う」（[9][10]）。
- 【本人】Duplicator では「チームが研究を指揮し、Argus は攻撃者が制御するデータを、それを保存したリクエストの先、後で管理者が行う移行処理まで追う手助けをした」。さらに「エンドポイントごとのテストでは見落としやすい関係」を、アプリケーションのワークフロー全体でたどる例だとしている（[8]）。

**検証と所要時間**
- 【本人】Avada の連鎖は「無人で約 2 時間」で見つかった。Argus は続けて、対象サーバーで PHP を実行する PoC を最初から最後まで書いた。PoC を書く作業は「研究者なら通常それだけで数日かかる部分」だという（[2]）。
- 【本人】Avada は「隔離した対象に対して検証し、端から端までの PoC を確認した」。発見と同じ日に、有料顧客向けのファイアウォール規則を出した（[2]）。
- 【本人】ほかの事例では「Argus が見つけ、Threat Intelligence チームが検証した」「チームが PoC を確認して開示した」という形が定型になっている（[4][5][6][7]）。Tutor LMS は「報告を受け取り、同じ日に検証した」（[7]）。これは Argus が報告を出し、人間がそれを受け取る流れを示している。
- 【本人】ライブラリの 2 件では、人間側の検証が詳しく書かれている。sanitizer を入れたビルドと、対照用のファイルで再現した。別のビルドでも確かめた。入力ファイルを最小化した（Ghostscript は 1,029 バイトの PDF）。素の WordPress で影響を示した。Ghostscript では、作った 2 つの PoC を 10 種の Linux パッケージ環境で計 10,240 回走らせ、一致するビルドの外では 1 度も成功しないことを確かめた。報告には根本原因の分析と修正案を添えた（[9][10]）。
- 【本人】Duplicator では、Pro 版のファイル削除の足がかりを「Argus の助けを借りて」チームが乗っ取りと PHP 実行にまで育てた。検証には使い捨ての WordPress を使った（[8]）。

**人間がしたこと**
- 【本人】WordPress 7.1 の評価は Alex Thomas が「主導し、検証した」。この評価の中で、libheif、Ghostscript、Duplicator が見つかった（[8][9][10]）。
- 【本人】ベンダーへの開示、修正前の版の確認、ファイアウォール規則の作成、修正後の分析（Duplicator では追加の規則）は、人間のチームが行っている（各事例の時系列）。
- 【本人】Maunder は「その画期的な発見はあまりに難しく、説明のブログ記事を Argus 自身に書かせる必要があった」と書いている（[1]）。

**公開しないと明言していること**
- 【本人】「設計の詳細、使っているモデル、プロンプトの構造、harness の設計は話せない。最も危険な脆弱性を脅威アクターより先に見つける競争をしているからだ」（[1]）。
- 【本人】「Argus をどう作ったかは公開しない。テコは個々のモデルではなく、harness とプロンプトエンジニアリングにある。同じ手法は、我々と同じだけ攻撃者の役にも立つ」（[2]）。
- 【本人】Avada の技術的な詳細は「意図して伏せている」。6 段は抽象的な一覧でだけ示した（[2]）。
- 【本人】自己紹介の「指令」は [REDACTED] と伏せている（[3]）。

### 2.2 推測（根拠付き）

- 【推測】**対象の選び方は書かれていない。ただ、結果の偏りは明らかである。** 9 件中 7 件が 10 万以上の導入数か販売数を持つ製品で、Avada、Gravity Forms、Duplicator は 100 万規模である。報酬の出る深い連鎖が成り立つ規模の、大きく複雑な製品を 1 つずつ選んでいると読める。
- 【推測】**同じ対象を再び調べている。** 2026-10-09 の Fusion Builder ≤3.16.1 の件は、Avada の修正版にも残っていた別の経路である。修正の後に同じ対象を掘り直したと考えられる。
- 【推測】**「評価キャンペーン」の単位で動かしている。** 8 月末から 9 月の 3 件は「WordPress 7.1 security assessment」という 1 つの評価の中で見つかった。本体の新しい版を起点に、アップロードのようなデータの流れを下流まで追う運用がある。
- 【推測】**「WordPress ground truth」**という語は PRISM の自己紹介にも同じ形で出てくる。WordPress 本体の挙動を正解として参照する仕組みを共有していると考えられる。具体的には、権限、nonce、フック、REST、コメントのモデレーション、移行処理などの実際の挙動である。実物の WordPress Lab で確かめる方法か、本体の意味論の知識ベースかは、書かれていない。ライブラリの件では、実 WordPress と公式 Docker イメージでの実演を重く扱っている。
- 【推測】**1 回の実行時間について数字は Avada の約 2 時間しかない。** ほかの事例も、発見から検証・開示までが同じ日か翌日である（WPMU DEV、Tutor LMS、Events Calendar）。人間の確認が数時間で済む程度にまで、PoC と報告がそろった状態で出てくると考えられる。Events Calendar の 2 本の連鎖は 1〜2 日の間をおいて見つかった。同じ対象で続けて実行したか、長く走らせたかのどちらかだろう。
- 【推測】**自律の度合いは、事例によって違う。** Avada は「無人」と書かれている。WordPress 7.1 の評価の 3 件は「チームが指揮した」と書かれ、人間が向きを決める対話型の使い方に読める。

---

## 3. PRISM / Eclipse との関係と数字

### 3.1 関係（本人の記述）
- 【本人】「AI 研究を 2 つの方向で考え、両方を作っている。**BREADTH for coverage**: PRISM は幅優先の半分である。あらゆるバグ種別と脅威モデルにわたる広大な面を、ひとりで一日中掃く。**DEPTH for complexity**: Argus は深さ優先の半分である」（[2]）。
- 【本人】Eclipse は、バグバウンティの量に対応するために作った「AI 支援のトリアージツール」である。人間の研究者からの投稿と PRISM の出力をトリアージする（[13]）。社内の脅威インテリジェンスチームは、受け付けのトリアージに「multi-agentic pipeline」を使っている（[12]）。
- 【本人】Argus の出力も Eclipse を通るかどうかは、書かれていない。Argus の事例は、Alex Thomas や Chloe Chamberland が検証したと書かれている（[4]〜[10]）。

### 3.2 Argus の数字
- 【本人】Avada は約 2 時間で発見と PoC まで進んだ（[2]）。
- 【本人】プロフィールには 9 件が載っている（[3]）。WordPress 以外に 2 件を公表した（[9][10]）。
- 【本人】件数、1 件あたりの時間（Avada 以外）、コスト、実行回数、外れの率は、公表していない。

---

## 4. 第三者の分析（2026 年）

- **The Repository**（2026-08-26、出典 [14]）: Avada の件。Alex Thomas（Senior Web Application Vulnerability Researcher）の発言として、次の点を伝える。「人間の関与なしに約 2 時間で PoC まで」「熟練者でも数週から数か月、6 つの環を全部つなげるとは限らない」「作り方は公開しない」。対比として「PRISM は多数のプラグインとテーマを走査し、たいていは 1〜2 段の欠陥を見つける。Argus は 1 つの対象に集中し、複数の弱点を組み合わせる長い連鎖を探す」と書く。WP2Shell は 1 人の研究者のプロンプト実験だったが、Argus は「企業が継続運用の一部として専用の AI エージェントを作るもの」で、性格が違うと位置付けている。ThemeFusion 側の告知によると、最後の段は Fusion Patcher（パッチ適用の部品）だった。
- **The Repository**（Rae Morey、2026-07-31、[15]）: PRISM が ARVE のバックドアを見つけた件。WordPress.org の「Protect the Shire」は配布前に新しい版を保留する仕組みで、その保留の時間内に、WordPress.org 自身の AI レビュー（Gandalf）ではなく、外部の PRISM が見つけた。侵害から配布停止まで 3 時間未満だった。
- **iThome**（2026-08-27、[16]）と **Daily CyberSecurity / securityexpress**（Mastodon、2026-08-27、[17]）: Avada の件の紹介。独自の分析はない。
- **BleepingComputer**（Bill Toulas、2026-10-13、[18]）と **Korben**（2026-10-15、[21]）: Ghostscript の件の紹介。PoC が特定のビルドに依存することを記事どおりに伝えている。
- **83creative**（2026-09-04、[22]）: Gravity Forms の件を、Wordfence の無料版への保護が 30 日遅れることの問題として論じた。CVSS が AC:H であることにも触れ、緊急度の読み方を書いている。Argus の方法そのものは論じていない。
- **securitewp.com**（2026-09-18、[23]）: 9 月の総括の中で「AI エージェントが見つけた重大な連鎖」（Events Calendar、Tutor LMS）として触れる。
- **wordsec.net**（[24]）: プロフィールの集計を写したもの（9 件、3,866 人中 520 位）。
- **Patchstack** による Argus や PRISM の論評、研究者による手法の分析、ポッドキャストやインタビューは、見つからなかった（第 6 節）。

---

## 5. PRISM の設計思想（追加の節）

### 5.1 本人の記述

**構成**
- 【本人】プロフィールの自己紹介（[25]）:「プリズムは光を全スペクトルに分解し、肉眼では見えなかったものを見せる。PRISM はコードに同じことをする。**専門のエージェントが 1 体ずつ、脆弱性のスペクトルの別々の波長を分析する。XSS からデシリアライズまで。** WordPress の ground truth に導かれ、経験的な PoC の実行で検証される」。
- 【本人】PRISM の公開より前の 2026-04-10 に、Maunder は次のように書いた。「脆弱性の種類ごとを含め、さまざまな分野の『専門家』に頼るセキュリティ専用の cognitive architecture は、社内で目覚ましい結果を出した。agentic trajectories を使った LoRA fine-tune で専門家モデルを作り、architecture に足すことを実験している」。さらに「semantic routing（埋め込みで意味や複雑さを判定して振り分ける）は、コストを下げる multi-LLM の構成を可能にする」とも書いた（[12]）。
- 【本人】Chloe Chamberland が PRISM を「構想し、その構築を監督した」（[13]）。

**扱う範囲と、扱わないもの**
- 【本人】「あらゆるバグ種別と脅威モデルにわたる広大な面を、ひとりで一日中掃く。それがエコシステム全体を覆う方法であり、プラグインのリポジトリに入って 2 時間後にバックドアに気づく方法である」（[2]）。
- 【本人】「PRISM は広く行く。広大な面を覆うので、ふつう 1 件の発見は 1 つから数個の欠陥、あるいは 1〜2 段の短い跳躍になる。**それがまさに正しいトレードオフだ。重大な WordPress の脆弱性の大半はそういう形をしていて、そのすべてを捕まえたいからだ**」（[2]）。
- 【本人】Argus と対比して「Argus は**幅を捨てて**1 つの対象にとどまり、長い多段の経路を視野に保つ」（[2]）。裏返せば、PRISM は長い連鎖と 1 対象への長い滞在を狙わない。
- 【本人】「Argus は極めて深刻な脆弱性を見つけ続けている。そして PRISM は、プラグインとテーマのエコシステム全体に広い覆いを与え続けている」（[11]）。

**対象と再走査**
- 【本人】ARVE のバックドアは 08:42 に入り、10:33 に PRISM が見つけて報告を出した。10:43 には人間が報告を検証し、PoC を確認した（[26]）。配布前の版で見つかった（[26][15]）。
- 【本人】Burst Statistics の欠陥は、コードに入ってから 15 日後に PRISM が見つけた。「AI が攻撃者の窓を縮める」例として挙げている（[27]）。
- 【本人】The Repository は「WordPress プラグインのエコシステム全体の脅威を走査するために立ち上げた」と書いている（[15]。Wordfence の発言の引用ではなく、記者の要約）。

**検証と人間の位置**
- 【本人】どの事例でも「PRISM が発見して報告を出す → 人間が検証し、PoC を確認する → 開示とファイアウォール規則」の順になっている（[26][27]）。
- 【本人】Eclipse は PRISM の出力と人間の投稿の両方をトリアージする。研究者は Eclipse を使いながら、Eclipse 自体に pull request を出して改善している（Marco Wotschka の例）（[13]）。
- 【本人】「purely autonomously」に 30 日で 88 件を公開し、1 日平均 2.8 件である（2026-07-23、[13]）。

**数字**
- 【本人】2026-04 頃に立ち上げた（2026-07-23 の記事で「3 か月前」）。2026-07-23 時点で累計 202 件、過去 30 日で 88 件を公開し、30 日の順位は 1 位だった（[13]）。2026-08-25 時点で 300 件超、30 日の順位は 1 位（[2]）。
- 【本人】プロフィール（2026-10-25 取得）: All Time Ranking 21、All Time Discoveries 355、90 Day Published 246、最終公開 2026-10-23（[25]）。実績バッジは、最初の投稿と最初の SQLi が 04-16、1337 が 05-07、最初の XSS が 06-17、最初の LFI が 06-30、100 件が 07-23、300 件が 10-09。
- 【本人】1 件あたりの時間やコストは、公表していない。

### 5.2 mirror で数え直した PRISM の発見（2026-10-23 まで、355 件）

| 観点 | 数 |
|---|---|
| 月別の公開数 | 4 月 1、5 月 1、6 月 23、7 月 132、8 月 64、9 月 60、10 月（23 日まで）74 |
| CWE の上位 | XSS 127（36%。うち Stored 114、Reflected 13）、SQLi 83（23%）、Missing Authorization 62（17%）、Path Traversal 20、Privilege Management 20、LFI 10、Deserialization 6、Improper Authentication 5、CSRF 5、Code Injection 4、ファイルアップロード 2、悪意あるコード 1 |
| 必要な権限（タイトルから） | Contributor+ 121（34%）、Subscriber+ 51、Administrator+ 50、未認証 42（12%）、Author+ 16、Editor+ 11、プラグイン独自のロール 44、表記なし 20 |
| 深刻度 | Medium 284（80%）、High 62、Critical 7、Low 2 |
| 対象の種類 | すべてプラグイン（テーマ 0） |
| 共同クレジット | 単独 332、共同 23（うち Chloe Chamberland が 19） |
| 「この版から入った」と範囲が限られる記録 | 4/355（1.1%）。同時期のほかの研究者の記録では 284/5,848（4.9%） |

Argus との対比: Argus の WordPress の 9 件は、未認証が 8 件、CVSS 8.1 以上が 8 件、XSS が 1 件、SQLi が 0 件である。PRISM は Medium が 80% で、XSS、SQLi、Missing Authorization の 3 種で 76% を占める。

### 5.3 推測（根拠付き）

- 【推測】**種別ごとの専門エージェントを横に並べ、それぞれが同じ対象群を掃く構成。** 根拠は、自己紹介の「専門のエージェントが 1 体ずつ別の波長を」、4 月の記事の「脆弱性の種類ごとの『専門家』」、実績バッジの順序（SQLi 04-16 → XSS 06-17 → LFI 06-30）である。種別の担当が段階的に増えたように見える。6 月から 7 月に件数が跳ねている（23 → 132）のも、担当の追加か走査範囲の拡大と合う。semantic routing で振り分けているかどうかは、書かれていない。
- 【推測】**「WordPress ground truth」** は Argus と同じ語である（第 2.2 節）。種別の専門エージェントが、それぞれ WordPress 本体の権限、nonce、エスケープ、`$wpdb` の意味を正解として参照して判断する作りだと考えられる。Contributor+ と Administrator+ の発見が多く、権限と unfiltered_html のような WordPress 固有の境界を機械的に扱えていることをうかがわせる。
- 【推測】**連鎖と長い滞在を狙わない。** 本人が「1〜2 段の短い跳躍」「それが正しいトレードオフ」と書き、数字もそれに合う（Medium が 80%、Deserialization は 6 件だけ）。
- 【推測】**対象の選び方と再走査。** 走査の主力は、既存のコードを掃くことである。「この版から入った」記録は 1.1% で、ほかの研究者（4.9%）より低い。一方で、ARVE のバックドアを、入って 2 時間以内、配布前に見つけている。リポジトリの変更（コミットか新しい版）を見張る経路も別にあるはずである。ARVE の件が「悪意あるコード」という種別だったことから、バックドア検出の専門エージェントが変更の監視に乗っていると考えられる。対象の導入数の基準、再走査の間隔は書かれていない。
- 【推測】**検証は 2 段。** 第 1 段は、PRISM 自身が PoC を実行する（「経験的な PoC の実行で検証される」）。第 2 段は、人間が報告を受けて PoC を確かめる。ARVE では、報告から 10 分で人間の確認が終わっている。PoC と報告の質が、人間がすぐ確認できる水準にあることを示す。Eclipse は、この人間の確認の手前で、量をさばくために置かれている。
- 【推測】**なぜ 1 つの仕組みにしないのか。** 本人が理由として書いているのは次の 2 点だけである。(a) 追跡を「どこまで深く押すか」が違う。(b) 幅は「大半の重大な脆弱性」を全部捕まえるため、深さは「数段先にしか存在しない」ものを捕まえるため、と目的が違う。Argus は「幅を捨てて」1 対象にとどまる。両者は探索の時間配分の仕方が逆で、1 つの仕組みに混ぜると、どちらかの時間配分が崩れる。これが分けている理由だと読める。ただし、「混ぜると失敗した」という実験の報告は、公開されていない。

### 5.4 幅と深さを分ける理由が明文で書かれた箇所（全件）

1. 「We think about AI research two ways, and we build for both.」（[2]）
2. 「BREADTH for coverage: PRISM is the breadth-first half. It sweeps an enormous surface across every bug class and threat model, on its own, all day.」（[2]）
3. 「DEPTH for complexity: Argus is the depth-first half … Both agents hunt the way every researcher does … What differs is how far down that trace they push.」（[2]）
4. 「PRISM goes wide … each finding is anywhere from one to a few flaws or a short hop of a step or two, and that's exactly the right trade-off, because most serious WordPress vulnerabilities look like that and you want to catch every one of them. Argus goes deep instead. It gives up the breadth to stay on one target and hold a long, multi-step path in view, the kind where the exploit only exists several links in and every link depends on the one before it.」（[2]）
5. 「Wordfence Argus continues to find extremely severe vulnerabilities … And Wordfence PRISM continues to give us broad coverage across the plugin and theme ecosystem.」（[11]）
6. 「Wordfence Argus is one of the tools, along with others like Wordfence PRISM」（[1]。並べて挙げるだけで、理由は書いていない）
7. 第三者の要約:「It scans large numbers of plugins and themes but typically finds one or two-step flaws. Argus focuses on a single target and looks for longer chains」（The Repository、[14]）

---

## 6. 見つからなかったこと

- Argus と PRISM の対象の選び方（導入数の下限、更新の監視、優先順位の付け方）。どちらも明文はない。
- 1 回の実行時間（Avada の約 2 時間を除く）、並列の数、1 件あたりのコスト、外れの率、人間が棄却した件数。
- Argus の出力も Eclipse を通るかどうか。
- 「WordPress ground truth」の中身。
- 使っているモデルの具体名（「Mythos と OpenAI / Anthropic のサイバー能力のあるモデル」という言及だけ）。
- Ocean Pro Demos と Fusion Builder ≤3.16.1 の解説記事（データベースの記録だけがある）。
- 「WordPress 7.1 security assessment」そのものを説明した記事。
- Patchstack による Argus や PRISM の論評。研究者による手法の分析。Argus を主題にしたポッドキャストやインタビュー。Maunder の X の投稿のうち、ブログの転載でないもの。Wordfence の X の記事は [1] の転載だった。
- hashe.com の記事は取得できなかった（本文 288 バイト）。The Events Calendar ≤6.17.4 の詳細ページは CloudFront の 403 で取得できなかった。内容はブログ [6] と mirror で補った。
- バグバウンティの月次報告（5〜6 月）には PRISM と Argus の記述がない。7〜8 月分は、推測した URL では見つからなかった。

---

## 7. 出典一覧

| 番号 | 著者 | 日付 | URL | 取得方法 |
|---|---|---|---|---|
| 1 | Mark Maunder | 2026-08-27 | https://www.wordfence.com/blog/2026/08/wordfence-argus-moving-beyond-human-research-capability/ （X の転載 https://x.com/wordfence/article/2093077424493707361 ） | r.jina.ai |
| 2 | Wordfence（著者名は取得できず） | 2026-08-25 | https://www.wordfence.com/blog/2026/08/wordfence-argus-finds-complex-6-step-critical-rce-in-avada-theme-with-1-million-sales/ | r.jina.ai |
| 3 | Wordfence Intelligence | 2026-10-25 取得 | https://www.wordfence.com/threat-intel/vulnerabilities/researchers/argus | r.jina.ai |
| 4 | Wordfence（一人称の研究者。記録上は Alex Thomas と Argus） | 2026-08-27 | https://www.wordfence.com/blog/2026/08/wordfence-argus-finds-critical-authentication-bypass-in-wpmu-dev-dashboard-plugin/ | r.jina.ai |
| 5 | Wordfence | 2026-09-01 | https://www.wordfence.com/blog/2026/09/wordfence-argus-finds-unauthenticated-arbitrary-file-upload-vulnerability-in-gravity-forms/ | r.jina.ai |
| 6 | Wordfence | 2026-09-14 | https://www.wordfence.com/blog/2026/09/wordfence-argus-identifies-two-critical-unauthenticated-vulnerability-chains-leading-to-remote-code-execution-in-the-events-calendar-plugin/ | r.jina.ai |
| 7 | Wordfence | 2026-09-17 | https://www.wordfence.com/blog/2026/09/100000-wordpress-sites-exposed-to-remote-code-execution-via-php-object-injection-vulnerability-found-by-wordfence-argus-in-tutor-lms/ | r.jina.ai |
| 8 | Wordfence | 2026-10-20 | https://www.wordfence.com/blog/2026/10/wordfence-argus-discovers-high-severity-unauthenticated-php-object-injection-in-duplicator/ | r.jina.ai |
| 9 | Wordfence | 2026-09-18 | https://www.wordfence.com/blog/2026/09/wordfence-argus-discovers-critical-vulnerability-in-libheif-the-library-that-opens-iphone-photos-on-your-server/ | r.jina.ai |
| 10 | Wordfence | 2026-10-12 | https://www.wordfence.com/blog/2026/10/wordfence-argus-discovers-critical-vulnerability-in-ghostscript-the-program-that-turns-uploaded-pdfs-into-thumbnails-on-your-server/ | r.jina.ai |
| 11 | Mark Maunder | 2026-10-08 | https://www.wordfence.com/blog/2026/10/cybersecurity-imperatives-will-demand-ai-math/ | r.jina.ai |
| 12 | Mark Maunder | 2026-04-10 | https://www.wordfence.com/blog/2026/04/the-increasing-role-of-ai-in-vulnerability-research/ | r.jina.ai |
| 13 | Mark Maunder | 2026-07-23 | https://www.wordfence.com/blog/2026/07/a-new-threat-landscape-meets-a-new-kind-of-defender/ | r.jina.ai |
| 14 | The Repository（著者名は取得できず） | 2026-08-26 | https://www.therepository.email/wordfences-new-ai-agent-chains-six-flaws-into-a-critical-unauthenticated-rce-in-popular-avada-theme | r.jina.ai |
| 15 | Rae Morey（The Repository） | 2026-07-31 | https://www.therepository.email/protect-the-shire-scores-first-win-as-wordfence-ai-agent-catches-plugin-backdoor-before-it-reaches-users | r.jina.ai |
| 16 | iThome | 2026-08-27 | https://www.ithome.com.tw/news/178488 | r.jina.ai |
| 17 | Daily CyberSecurity（Mastodon） | 2026-08-27 | https://infosec.exchange/@DailyCyberSecurity/117167838417575388 | r.jina.ai |
| 18 | Bill Toulas（BleepingComputer） | 2026-10-13 | https://www.bleepingcomputer.com/news/security/ghostscript-flaw-lets-hackers-hijack-servers-via-pdf-uploads/ | r.jina.ai |
| 19 | Wordfence Intelligence | 2026-10-08 | https://www.wordfence.com/threat-intel/vulnerabilities/detail/ocean-pro-demos-154-and-ocean-ecomm-treasure-box-180-unauthenticated-stored-cross-site-scripting-via-content-parameter | r.jina.ai |
| 20 | Wordfence Intelligence | 2026-10-09 | https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-plugins/fusion-builder/avada-fusion-builder-7161-unauthenticated-arbitrary-wordpress-action-invocation-via-action-hook-dynamic-data-token-in-form-field | r.jina.ai |
| 21 | Korben | 2026-10-15 | https://korben.info/en/ghostscript-pdf-previews-can-wreck-your-server.html | r.jina.ai |
| 22 | 83creative | 2026-09-04 | https://83creative.com/strategy/gravity-forms-patch-wordfence-free-tier-gap/ | r.jina.ai |
| 23 | securitewp.com | 2026-09-18 | https://www.securitewp.com/blog/securite-wordpress/failles-wordpress-septembre-2026-vulnerabilites-critiques/ | r.jina.ai |
| 24 | wordsec.net | 取得日 2026-10-25 | https://wordsec.net/vulnerabilities/researchers/wordfence-argus | r.jina.ai |
| 25 | Wordfence Intelligence | 2026-10-25 取得 | https://www.wordfence.com/threat-intel/vulnerabilities/researchers/prism | r.jina.ai |
| 26 | Wordfence | 2026-07-28 | https://www.wordfence.com/blog/2026/07/wordfence-prism-detected-backdoored-wordpress-plugin-within-two-hours-of-it-being-introduced/ | r.jina.ai |
| 27 | Wordfence | 2026-05-13 | https://www.wordfence.com/blog/2026/05/200000-wordpress-sites-at-risk-from-critical-authentication-bypass-vulnerability-in-burst-statistics-plugin/ | r.jina.ai |
| 28 | ローカル Wordfence 履歴 mirror | 最新レコード 2026-10-23 | `/home/dev/wp-bounty-workspace/intelligence/history.sqlite`（researchers に「Wordfence Argus」「Wordfence PRISM」を含む記録） | 読み取り専用の SQLite クエリ |
| 29 | Wordfence 各脆弱性の詳細ページ（Avada、Duplicator、Gravity Forms、Tutor LMS、Events Calendar ≤6.17.3、WPMU DEV） | 各公開日 | 出典 [3] の表のリンク先 | r.jina.ai（共同クレジットの確認に使用） |
