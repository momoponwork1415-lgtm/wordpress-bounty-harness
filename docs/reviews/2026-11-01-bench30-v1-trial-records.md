# bench30 v1（v19-wide、48 Trial）の記録から見た探索の改善点（2026-11-01）

調べて報告の成果物（正本ではない）。読み取り元は bench30 v1 の台帳と Private Evidence の件数・時刻・digest だけで、Finding / Lead の本文、答えのファイル名と関数名は載せていない。集計 script は作成セッションの scratchpad にあり、repo には入れない。


対象は state `~/.local/state/wordpress-bounty-harness-bench30`（台帳は `node:sqlite` の `readOnly` で開いた）、各 run の receipt と `read-paths`、Root と子の rollout、Trial ノートの archive。本文、payload、答えの file 名と関数名は載せない。数字はすべて台帳と Private Evidence から数えた。

## 0. 前提の訂正と定義

- 走った Trial は 49 本ではなく **48 本**だった。`b30v19-profile-builder-v1` は freeze の段で `target-skipped`（reason `deferred`、診断 `main-plugin-file-ambiguous`）になり、探索は走っていない。内訳は v1 が 29、v2 が 19。v2 が走らなかった 11 件は C 型 10 件と schema-and-structured-data-for-wp。このため **C 型は全件 k=1、A 型は全件 k=2、B 型は 9 件が k=2** になっている。v3 と f1 は 0 本。
- 48 本の構成はすべて同じだった。`wp2shell-bounty-v19-wide`、`gpt-6-sol`（effort high）、`maxChildren 8`、wall 120 分、`minimumActiveMinutes 0`、Lab なし、スキルは wbh-recon-v1 と wbh-tools-v1。選んだ版は 48/48 で答えの脆弱版と一致した。
- **hit** は scorer と同じ照合で数えた。Finding の `sourceTrace` にある file が答えの file と一致すれば hit とする。function だけが一致した Finding は 0 件なので、file 単位と scorer の判定は同じ結果になる。
- **読んだ** は `read-paths`（コマンド行に現れた source 相対パス）で判定した。これは下限値である。ディレクトリを丸ごと `rg` した場合の個々の file は数えず、逆に `rg` で名指ししただけの file は読んだ側に数える。

## 1. Trial と case の数字

48 本すべてが `outcome completed` で、`reason` と `reasonDetail` は空だった。どの Trial も、Root が最初の最終報告を出した 5〜10 秒後に終わっている（wide は最初の最終報告で終わる）。再開区間は 0、Root の turn はすべて 1、最初の最終報告の後に出た候補は 0 だった。

| case | 型 | 走った Trial | hit Trial | F（+parked） | L | wall 平均（分） | 子の数 平均 | 読んだ file の和集合 平均 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| wp-marketing-automations | A | 2 | 1 | 6 | 24 | 19.1 | 13.5 | 162 |
| ajax-search-lite | A | 2 | 0 | 0 | 4 | 9.7 | 6.0 | 115 |
| link-library | A | 2 | 2 | 19 | 12 | 10.7 | 5.0 | 55 |
| tenweb-speed-optimizer | A | 2 | 0 | 0 | 31 | 14.2 | 7.5 | 89 |
| form-maker | A | 2 | 1 | 2 | 6 | 6.9 | 4.0 | 59 |
| latepoint | A | 2 | 0 | 0 | 8 | 10.7 | 6.0 | 125 |
| geodirectory | A | 2 | 0 | 10 | 21 | 21.3 | 12.5 | 140 |
| nextgen-gallery | A | 2 | 0 | 0 | 12 | 14.9 | 12.5 | 141 |
| wpdiscuz | A | 2 | 0 | 0 | 12 | 12.0 | 10.5 | 70 |
| masterstudy-lms-learning-management-system | A | 2 | 0 | 2（+2） | 10 | 16.0 | 13.0 | 217 |
| thirstyaffiliates | B | 2 | 0 | 0 | 10 | 13.6 | 11.5 | 86 |
| publishpress-authors | B | 2 | 1 | 2 | 0 | 8.3 | 4.5 | 68 |
| wp-simple-firewall | B | 2 | 0 | 2 | 10 | 13.4 | 8.5 | 285 |
| post-carousel | B | 2 | 1 | 2 | 13 | 13.8 | 6.0 | 99 |
| ninja-forms | B | 2 | 1 | 1 | 15 | 12.6 | 4.5 | 135 |
| debug-log-manager | B | 2 | 2 | 4 | 6 | 6.0 | 4.0 | 38 |
| ultimate-member | B | 2 | 0 | 0 | 14 | 15.3 | 8.5 | 123 |
| cleantalk-spam-protect | B | 2 | 2 | 7 | 9 | 23.2 | 11.5 | 158 |
| strong-testimonials | B | 2 | 0 | 0 | 6 | 11.8 | 10.0 | 85 |
| schema-and-structured-data-for-wp | B | 1 | 0 | 0 | 8 | 21.3 | 7.0 | 71 |
| uncanny-learndash-toolkit | C | 1 | 0 | 0 | 12 | 17.8 | 15.0 | 102 |
| wp-user-frontend | C | 1 | 0 | 0 | 6 | 12.1 | 8.0 | 135 |
| users-customers-import-export-for-wp-woocommerce | C | 1 | 0 | 0 | 6 | 8.8 | 7.0 | 63 |
| ai-engine | C | 1 | 0 | 0 | 4 | 7.2 | 4.0 | 52 |
| profile-builder | C | 0（freeze で deferred） | - | - | - | - | - | - |
| mailoptin | C | 1 | 0 | 0 | 6 | 6.3 | 4.0 | 68 |
| bit-integrations | C | 1 | 0 | 2 | 8 | 6.8 | 4.0 | 113 |
| wp-event-solution | C | 1 | 0 | 0 | 5 | 12.8 | 11.0 | 165 |
| essential-addons-for-elementor-lite | C | 1 | 0 | 0 | 4 | 7.8 | 4.0 | 58 |
| easy-login-woocommerce | C | 1 | 1 | 4 | 2 | 6.6 | 4.0 | 56 |

合計は次のとおり。

- 子: 387 体（Trial あたり 4〜17。ちょうど 4 体が 14 本、9 体以上が 17 本）。上限 8 は同時に生きる子の数だけを縛るので、これは設計どおりである。
- filesRead: Root が延べ 2,714、子が延べ 18,575。
- Finding: 63 件、parked 2 件（masterstudy-v1、`outside-programme-boundary`）、Lead 284 件。
- 候補: 正規化した 349 件はすべて受理され、棄却は 0 だった。そのうち 174 件は文字列の JSON を decode して受理した（`json-decoded`）。

case 単位では 9/30 が hit した。内訳は A 3/10、B 5/10、C 1/10 である。Trial 単位では 12/48 になる。v1 だけの pass@1 は A 2/10、B 5/10、C 1/9 だった。

Trial ごとの表は付録 A に置く。

## 2. 外した case の分類（21 件）

| 分類 | 件数 | case |
|---|---:|---|
| 走っていない | 1 | profile-builder |
| (a) 答えの file を誰も読んでいない | **0** | - |
| (b) 読んだが、それを名指す Finding も Lead も無い | **8** | ajax-search-lite, geodirectory, wp-simple-firewall, strong-testimonials, ai-engine, bit-integrations, wp-event-solution, essential-addons-for-elementor-lite |
| (c) Lead だけが名指している | **12** | tenweb-speed-optimizer, latepoint, nextgen-gallery, wpdiscuz, masterstudy-lms, thirstyaffiliates, ultimate-member, schema-and-structured-data-for-wp, uncanny-learndash-toolkit, wp-user-frontend, users-customers-import-export, mailoptin |
| (d) Finding が file を名指すが function が違う | 0（外した case の定義上 0） | - |

- **走った 48/48 の Trial で、答えの file が少なくとも 1 本は read-paths に現れた。** したがって、外した原因は「その file に届いていない」ことではない。
- (b) の 8 件では、8/8 で子が答えの file を読んでいた。Root も読んでいたのは 3/8 だった。
- (c) の 12 件には、答えの file を名指す Lead の event が 47 件ある。`missingEdge` の内訳は `producer` 28、`precondition` 7、`auth-use` 6、`reachability` 5、`consumer` 1 だった。経路は見つけているが、攻撃者がその値を置けることを示せず、Lead のまま止まった例が最も多い。
- hit した 9 case にも (d) に当たるものが 3 件ある（form-maker、publishpress-authors、wp-marketing-automations）。file は一致したが function が一致しなかった。さらに、そのうち 2 件（form-maker、wp-marketing-automations）は Finding の分類も答えと違う（答えは sqli、Finding は stored-xss と lfi）。link-library も v1 は分類が違い、v2 だけが sqli で一致した。分類と function の両方が一致した case は 6/30 である（link-library、post-carousel、ninja-forms、debug-log-manager、cleantalk-spam-protect、easy-login-woocommerce）。

## 3. hit した Trial で最初の hit が出た時刻

時刻は、その Finding を出した run の receipt の `completedAt` から Root の `startedAt` を引いて近似した。台帳の `occurredAt` は全 event が Trial の終了時刻を持っているので使えない。

| Trial | 最初の hit（分） | 出した側 | wall（分） |
|---|---:|---|---:|
| debug-log-manager-v2 | 4.5 | 子 | 5.4 |
| easy-login-woocommerce-v1 | 5.4 | 子 | 6.6 |
| debug-log-manager-v1 | 5.5 | 子 | 6.6 |
| link-library-v1 | 6.0 | 子 | 8.7 |
| link-library-v2 | 6.2 | 子 | 12.8 |
| form-maker-v1 | 6.4 | 子 | 7.4 |
| ninja-forms-v1 | 7.1 | 子 | 13.2 |
| cleantalk-spam-protect-v2 | 9.3 | 子 | 16.1 |
| publishpress-authors-v1 | 9.8 | Root（最終報告） | 9.8 |
| cleantalk-spam-protect-v1 | 11.6 | 子 | 30.3 |
| post-carousel-v1 | 13.0 | 子 | 15.8 |
| wp-marketing-automations-v2 | 22.0 | 子 | 23.6 |

- 12 本のうち 11 本は子が最初に出した。中央値は 6.75 分である。
- hit した Finding は、どれも Root の最終報告で同じものが重ねて記録されている。Finding 65 件は group にすると 22 件で、そのうち 19 group は Root と子の両方が出していた。答えの file を名指す group は 12 件。

## 4. wall と hit の関係

- wall の分布（48 本）は、最小 5.4、四分位 7.8 / 12.1 / 16.1、最大 30.3 分、平均 12.8 分だった。区間別では 5〜10 分が 18、10〜15 分が 15、15〜20 分が 11、20〜30 分が 3、30 分以上が 1 で、**120 分の wall に届いた Trial は 0**。どの Trial も、wall の 25% を使う前に Root 自身が閉じている。
- wall と hit の相関（point-biserial）は r=0.02 だった。wall で 3 等分すると hit は 5/16、3/16、4/16 で、差は見えない。wall は子の数と強く相関する（r=0.80）。
- **plugin の大きさのほうが効いている。** sinks.tsv に載った file 数で半分に分けると（110 本以下か）、小さい側は 9/24、大きい側は 3/24 が hit した。
- 閉じた理由の記録: 48/48 の REGISTRY.md が 4 つの sink class すべてで「残り行 0」と書いていた。一方、観測した被覆は次のとおりで、自己申告と一致しない。
  - hooks.tsv に載った file のうち read-paths に現れた割合: 中央値 0.71、全体 0.49、最小 0.10。0.5 未満が 16/48 本。
  - sinks.tsv に載った file のうち read-paths に現れた割合: 中央値 0.38、全体 0.25、0.5 未満が 32/48 本。
- 時間の使い方: 最初の子が始まるまでが中央値 2.0 分、最後の子が終わってから Root が閉じるまでが中央値 1.1 分。子の wall は中央値 2.8 分（p90 4.5、最大 16.9）、子 1 体が読む file は中央値 18 本。子の延べ時間 1,160 分に対して Trial の延べ時間は 615 分で、平均の並列度は約 1.9 だった。

## 5. Trial あたりの Finding

- Trial あたりの件数の分布は次のとおり（parked を含む）。48 本のうち 30 本が 0 件だった。

  | 件数 | 0 | 1 | 2 | 3 | 4 | 6 | 8 | 11 |
  |---|---:|---:|---:|---:|---:|---:|---:|---:|
  | Trial 数 | 30 | 1 | 8 | 1 | 5 | 1 | 1 | 1 |

  平均は event で 1.35 件、group で 0.46 件。
- 答えの file を名指したもの: Finding は 36 件、それ以外は 29 件（group では 12 と 10）。Lead は 78/284 件。答え以外の 29 件が本物かどうかはここでは判定しない。
- 分類別の Finding: stored-xss 43、arbitrary-file-delete 12、sqli 4、account-takeover 2、lfi 2、other 2。
- 子の sink class 別の産出:

  | sink class | 子の数 | F | L |
  |---|---:|---:|---:|
  | html | 115 | 23 | 48 |
  | files | 96 | 8 | 39 |
  | sql | 88 | 2 | 24 |
  | identity | 88 | 1 | 30 |

  identity の子は平均 2.4 分で返っており、4 class の中で最も短い。

## 6. v1 と v2 の一致（両方走った 19 case）

- Finding の hit で比べると、両方 hit が 3、片方だけが 5、どちらも外れが 11 だった。一致率は 14/19 だが、hit の側で一致したのは 3/8 にとどまる。片方だけ hit したのは wp-marketing-automations（v2）、form-maker、publishpress-authors、post-carousel、ninja-forms（いずれも v1）。
- B 型は v1 が 5/10、v2 が 2/9 で、同じ設定でも Trial ごとのばらつきが大きい。
- Finding か Lead のどちらかが答えの file を名指したかで比べると、両方 11、片方 4、どちらも無し 4 になる。

## 7. ほかに目立った点

- 子が file を 1 本も読まなかった run は 0/387。provider のエラー、スキーマの棄却、sandbox の失敗はいずれも 0。broker の relay 失敗が 1 件あった（cleantalk-v1）が、上流のエラーは 0。0 以外で終わったコマンドは、Root が 37 件（21 本）、子が 108/12,676 件（0.9%）。
- スキルは読まれていた。48/48 の Root が SKILL.md を読み、2 つの列挙 script を実行し、recon-map.md、REGISTRY.md、tools/hooks.tsv、tools/sinks.tsv、tools/README.md を残した。子が SKILL.md を自分で読んだのは 30/387。semgrep と psalm の実行は 0（sandbox に入っているかどうかは記録から判らない）。
- 列挙 script の出力に答えの file が載っていたのは、hooks.tsv で 41/48 本、sinks.tsv で 45/48 本。wp-simple-firewall では 2 本とも、どちらの出力にも載っていなかった。
- 子の rollout は Root の会話履歴を引き継いで始まる。入力 token は合計 11.8 億（キャッシュが 95.3%）、Trial あたり約 2,460 万で、そのうち 79% が子の分だった。
- `followup_task` は 0 回で、子への追依頼は無かった。プロンプトの「返った子に追加の仕事を送らない」に沿っている。
- read-paths には、版番号のような path でない語が 13 件、file として混ざっていた。下限の数字としてはほぼ影響しない。
- scorer の `vulnTrials` 列は、走っていない campaign も含めて全 case を 3 と表示する。`fixedTrials` も全 case 1 と表示するが、f1 は 1 本も走っていない。
- 49 本で止まった理由は台帳からは判らない。

## 8. 改善の候補（凍結 5 点の範囲内）

1. **計測の変更（scorer）:** 分母を走った Trial に限り、arm ごとの pass@1 と、group 単位の件数を出す。hit を「file」「分類も一致」「function も一致」の 3 段に分ける。根拠: 表示は 3 Trial なのに実際は 1〜2 本、65 event が 22 group、hit 9 case のうち分類が一致したのは 7、function まで一致したのは 6。
2. **計測の変更（未走の arm）:** C 型の v2 10 本と schema の v2、v3 30 本、f1 30 本を走らせる。profile-builder は main file を名指しして固定する。根拠: C 型は k=1 で A・B（k=2）と比べられない。fixed 側の偽陽性は 0 本で測れていない。1/30 case は freeze で `main-plugin-file-ambiguous` のまま止まった。
3. **設定値:** wide の `discovery.minimumActiveMinutes`（例: 60）、または既存の `discovery.mode: deep`（v11、最低時間 60 分）を、v3 の arm として bench30 で 1 本ずつ回す。根拠: 48/48 が Root の最初の最終報告で閉じ（中央値 12.1 分、最大 30.3 分、120 分の 25% 未満）、48/48 のレジストリが残り 0 と書いたのに、観測した被覆は hooks で中央値 0.71、sinks で 0.38。大きい plugin では 3/24 しか hit していない。ただし、観測した範囲では wall と hit の相関が r=0.02 なので、時間を延ばして効くとは言えない。数字で確かめる。wide に最低時間を置かないのは ADR 0039 の決定なので、所有者の確認が要る。
4. **計測の変更（既存の #715 / ADR 0044 を使う）:** v3 を盲目的な繰り返しにせず、Lead だけで止まった 12 case について、前の Trial の Lead を名指しして 2 本目の入力にする arm を回す。根拠: 外した 20 case のうち 12 case は答えの file を名指す Lead を持っていた（event 47 件、`producer` 欠落が 28 件）。
5. **プロンプトの縮小:** 終了条件の段落（REGISTRY に行数を数えさせ、残りがあれば閉じさせない文）を外すか短くした版を候補にする。根拠: 48/48 で自己申告の「残り 0」と観測した被覆が一致せず、この文は終了を縛っていない。削るとさらに早く閉じる危険があるので、3 の設定値の arm と組み合わせて測る。
6. **計測の変更（観測の追加。舵取りではない）:** trial-timeline と scorer に「列挙出力に載った file のうち read-paths に現れた割合」と「Root の自己申告の残り行」を並べて出す。根拠: hooks 側で全体 0.49、0.5 未満が 16/48。sinks 側で全体 0.25、0.5 未満が 32/48。いまはこの差が記録に出ていない。
7. **計測の変更（sink class 別の産出）:** 子の sink class ごとの F / L と平均時間を週次で出し、identity と sql の子が Finding を出さない理由（Lead の `missingEdge`）を集計してから、スキル本文を変えるかどうかを決める。根拠: 子の Finding は html 23 に対し identity 1、sql 2。C 型で hit したのは 1/9 case、A 型で分類まで一致したのは 1/20 Trial。本文を変える場合も、出典対照表にある要素だけで書く。
8. **計測の変更（費用）:** 分母に「Codex 時間」を使うなら、子が引き継ぐ履歴の token を分けて記録する。根拠: Trial あたり入力 2,460 万 token のうち 79% が子の分で、子の中央値の wall は 2.8 分。引き継ぎを設定で変えられるかどうかは、記録からは判らない。

## 付録 A: Trial ごとの数字（48 本）

全 Trial が `completed` で、reason は無い。「答え F / L」は、答えの file を名指す Finding と Lead の数。

| Trial | 型 | wall 分 | 子 | Root files/uniq | 子 files/uniq 合計 | 和集合 uniq | F | P | L | 答え F / L |
|---|---|---:|---:|---|---|---:|---:|---:|---:|---|
| ai-engine-v1 | C | 7.2 | 4 | 24/15 | 187/68 | 52 | 0 | 0 | 4 | 0 / 0 |
| ajax-search-lite-v1 | A | 8.8 | 6 | 36/24 | 285/179 | 116 | 0 | 0 | 4 | 0 / 0 |
| ajax-search-lite-v2 | A | 10.7 | 6 | 35/27 | 300/177 | 114 | 0 | 0 | 0 | 0 / 0 |
| bit-integrations-v1 | C | 6.8 | 4 | 47/31 | 216/106 | 113 | 2 | 0 | 8 | 0 / 0 |
| cleantalk-spam-protect-v1 | B | 30.3 | 16 | 91/39 | 756/350 | 169 | 3 | 0 | 7 | 2 / 1 |
| cleantalk-spam-protect-v2 | B | 16.1 | 7 | 109/44 | 469/176 | 147 | 4 | 0 | 2 | 2 / 0 |
| debug-log-manager-v1 | B | 6.6 | 4 | 33/15 | 113/50 | 41 | 2 | 0 | 4 | 2 / 4 |
| debug-log-manager-v2 | B | 5.4 | 4 | 31/11 | 106/46 | 34 | 2 | 0 | 2 | 2 / 2 |
| easy-login-woocommerce-v1 | C | 6.6 | 4 | 65/27 | 237/75 | 56 | 4 | 0 | 2 | 2 / 0 |
| essential-addons-for-element-v1 | C | 7.8 | 4 | 35/17 | 171/56 | 58 | 0 | 0 | 4 | 0 / 0 |
| form-maker-v1 | A | 7.4 | 4 | 32/16 | 169/52 | 52 | 2 | 0 | 2 | 2 / 2 |
| form-maker-v2 | A | 6.5 | 4 | 37/18 | 194/74 | 65 | 0 | 0 | 4 | 0 / 4 |
| geodirectory-v1 | A | 15.3 | 9 | 52/22 | 716/192 | 126 | 6 | 0 | 8 | 0 / 0 |
| geodirectory-v2 | A | 27.4 | 16 | 87/27 | 753/235 | 154 | 4 | 0 | 13 | 0 / 0 |
| latepoint-v1 | A | 13.2 | 7 | 48/18 | 429/174 | 139 | 0 | 0 | 4 | 0 / 2 |
| latepoint-v2 | A | 8.3 | 5 | 57/23 | 302/134 | 110 | 0 | 0 | 4 | 0 / 0 |
| link-library-v1 | A | 8.7 | 4 | 51/17 | 178/58 | 55 | 8 | 0 | 6 | 8 / 2 |
| link-library-v2 | A | 12.8 | 6 | 73/27 | 239/83 | 54 | 11 | 0 | 6 | 10 / 2 |
| mailoptin-v1 | C | 6.3 | 4 | 33/20 | 157/72 | 68 | 0 | 0 | 6 | 0 / 2 |
| masterstudy-lms-learning-man-v1 | A | 19.0 | 16 | 86/48 | 643/314 | 223 | 2 | 2 | 6 | 0 / 2 |
| masterstudy-lms-learning-man-v2 | A | 12.9 | 10 | 57/41 | 502/232 | 210 | 0 | 0 | 4 | 0 / 0 |
| nextgen-gallery-v1 | A | 17.2 | 16 | 37/13 | 870/377 | 158 | 0 | 0 | 5 | 0 / 3 |
| nextgen-gallery-v2 | A | 12.6 | 9 | 46/12 | 529/193 | 123 | 0 | 0 | 7 | 0 / 3 |
| ninja-forms-v1 | B | 13.2 | 5 | 125/50 | 354/135 | 125 | 1 | 0 | 6 | 1 / 2 |
| ninja-forms-v2 | B | 11.9 | 4 | 114/38 | 310/137 | 145 | 0 | 0 | 9 | 0 / 5 |
| post-carousel-v1 | B | 15.8 | 5 | 109/33 | 329/121 | 106 | 2 | 0 | 4 | 2 / 0 |
| post-carousel-v2 | B | 11.8 | 7 | 54/26 | 193/95 | 91 | 0 | 0 | 9 | 0 / 3 |
| publishpress-authors-v1 | B | 9.8 | 4 | 57/25 | 249/85 | 80 | 2 | 0 | 0 | 1 / 0 |
| publishpress-authors-v2 | B | 6.8 | 5 | 38/15 | 186/75 | 55 | 0 | 0 | 0 | 0 / 0 |
| schema-and-structured-data-f-v1 | B | 21.3 | 7 | 38/14 | 281/115 | 71 | 0 | 0 | 8 | 0 / 4 |
| strong-testimonials-v1 | B | 7.5 | 4 | 13/7 | 145/69 | 58 | 0 | 0 | 4 | 0 / 0 |
| strong-testimonials-v2 | B | 16.1 | 16 | 28/16 | 451/283 | 111 | 0 | 0 | 2 | 0 / 0 |
| tenweb-speed-optimizer-v1 | A | 16.7 | 9 | 48/19 | 382/171 | 93 | 0 | 0 | 20 | 0 / 4 |
| tenweb-speed-optimizer-v2 | A | 11.6 | 6 | 94/36 | 388/161 | 85 | 0 | 0 | 11 | 0 / 5 |
| thirstyaffiliates-v1 | B | 12.8 | 7 | 66/29 | 358/124 | 77 | 0 | 0 | 2 | 0 / 0 |
| thirstyaffiliates-v2 | B | 14.5 | 16 | 29/15 | 578/214 | 95 | 0 | 0 | 8 | 0 / 4 |
| ultimate-member-v1 | B | 18.5 | 12 | 37/18 | 616/229 | 123 | 0 | 0 | 6 | 0 / 2 |
| ultimate-member-v2 | B | 12.1 | 5 | 44/19 | 434/126 | 122 | 0 | 0 | 8 | 0 / 2 |
| uncanny-learndash-toolkit-v1 | C | 17.8 | 15 | 16/6 | 331/162 | 102 | 0 | 0 | 12 | 0 / 6 |
| users-customers-import-expor-v1 | C | 8.8 | 7 | 55/31 | 296/121 | 63 | 0 | 0 | 6 | 0 / 2 |
| wp-event-solution-v1 | C | 12.8 | 11 | 40/24 | 504/230 | 165 | 0 | 0 | 5 | 0 / 0 |
| wp-marketing-automations-v1 | A | 14.7 | 11 | 56/22 | 485/181 | 126 | 2 | 0 | 16 | 0 / 2 |
| wp-marketing-automations-v2 | A | 23.6 | 16 | 202/49 | 872/305 | 198 | 4 | 0 | 8 | 2 / 2 |
| wp-simple-firewall-v1 | B | 18.5 | 12 | 120/58 | 711/442 | 389 | 2 | 0 | 7 | 0 / 0 |
| wp-simple-firewall-v2 | B | 8.4 | 5 | 51/24 | 230/132 | 181 | 0 | 0 | 3 | 0 / 0 |
| wp-user-frontend-v1 | C | 12.1 | 8 | 28/18 | 389/218 | 135 | 0 | 0 | 6 | 0 / 2 |
| wpdiscuz-v1 | A | 7.0 | 4 | 19/10 | 215/59 | 53 | 0 | 0 | 6 | 0 / 2 |
| wpdiscuz-v2 | A | 17.0 | 17 | 31/14 | 767/210 | 86 | 0 | 0 | 6 | 0 / 2 |

集計に使った読取 script（読むだけで、数字しか出さない）は `（作成セッションの scratchpad）` の `analyze.cjs`、`rollouts.cjs`、`coverage.cjs`。
