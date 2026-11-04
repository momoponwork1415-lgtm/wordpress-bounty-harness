---
status: accepted
date: 2026-11-04
amends: 0043（探索スキルの主従）、0045（2026-11-03 の recon-v4 限定）、0048（過去研究の次の入力契約）
---

# Cloudflare の監査スキルを WordPress 探索の派生元にする

## 背景

所有者は 2026-11-04 に、[Cloudflare の公開 `security-audit-skill`](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit) の全体に探索を寄せる案を聞き、「その方向で行きましょう」と決めた。これに先立ち、保存・読み戻し型の経路を記録して次の仮説と Lab の観測へつなぐこと、同じ対象を再訪するときに自分たちの Finding と Lead も使うこと、複数段の連鎖より先に Stored XSS と SQLi の探索を安定させることを求めた。2026-11-03 の `wbh-recon-v4` の小さな追加だけでは、探索から独立検証、次回の再開までを一巡させない。

Cloudflare は公開 repo を単一 repo 用の *skill* と説明し、永続化・再開・複数 repo を扱う Harness は後から別に作ったと述べる（[README](https://github.com/cloudflare/security-audit-skill)、[開発記事](https://blog.cloudflare.com/build-your-own-vulnerability-harness)）。本リポジトリには Snapshot、gVisor、Lab、台帳、Private Evidence、人間の観測が既にある。これらを作り直す代わりに、公開 skill の監査手順を WordPress profile の探索スキルへ移す。派生元の版と MIT の表示を残す。

現行との段ごとの対照と、固定4 sink 担当を外す理由は[比較報告](../reviews/2026-11-04-current-harness-vs-cloudflare-audit-skill.md)に記録する。所有者は 2026-11-04 に「固定割り当てがよくない」「基本的に Audit Skill に寄せる」と確認した。

## 決定

探索の手順の正本を、版と digest を固定した WordPress 用の上位 `wbh-audit` スキルに置く。Cloudflare の六段階を次のように写す。これは完成時の目標形であり、各段の実装が入るまでは既存の v22-wide とスキルを本番の主経路として使う。

| 段 | WordPress Trial 内の仕事 | 残すもの |
| --- | --- | --- |
| 1 偵察 | 固定 source と許可された過去記録から、入口、権限境界、通常利用の前提、保存と読み戻し、HTML・SQL・identity 等の効果を地図にする | source 行付きの構造の地図と、未読・未解決を含む作業の登録簿 |
| 2 探索と漏れ点検 | Root が source に基づく作業単位を子へ割り当てる。子は担当範囲の経路と内部候補を返す。別の子が source と記録を比べ、漏れた入口・並行経路・過去の gap を開く。Root は wall まで必要な調査を続ける | 担当、読んだ source、入口から効果までの辺、残る辺、次の調査を結ぶ研究 file |
| 3 候補の独立検証 | 発見者以外が経路と防御を固定 source から読み直す。Lab で答えられる問いは、入口・role・入力値を source で特定してから通常利用の Lab で観測する | source の反証と Lab の回答を元の経路へ返した記録 |
| 4 構造化記録 | Root が独立検証後の候補を研究 file に構造化し、型と参照の整合を点検する。この時点では Harness の Finding / Lead として出さない | 最終点検へ渡す source と Lab の根拠付き内部記録 |
| 5 最終記録の独立点検 | 別の子が構造化した候補の source 行、残る条件、Lab 事実への参照と出力の整合を再点検し、結果を scratch の点検記録に返す。子の Finding / Lead 配列は空にする | 訂正、反証、または理由付き未完 |
| 6 報告と次回 | 点検済みの記録から Root だけが既存の版付き契約で Finding / Lead を出す。Root は未読・未解決・予算で持ち越す作業を名指す。後の Trial は現在の source を照合して続ける | Finding / Lead、次の探索で読める研究記録、既存の台帳 event |

作業単位は、入口の種類、trust 境界、サブシステム、適用する攻撃類型を組み合わせ、必要なときは通常利用の段階を分ける。Root の研究 file には、ソース由来の参照の組合せと、経路の根本原因を再訪するための fingerprint を残す。どちらも新 Snapshot のソースと突き合わせる手掛かりであり、版をまたぐ成立の判定ではない。漏れ点検には類型に縛られない fallback 等と、低権限入口から明白な効果までの経路も含める。Root は探索へ使える時間と子の回数を漏れ点検と独立検証にも残してから担当を割り当てる。期限や provider のために処理できなかった単位は、作業済みとせず、理由を付けて次に残す。攻撃類型は読む視点であり、Programme Boundary と人間が書いた trust 境界の拡張には使わない。

作業単位の意味と優先順位、漏れの判断、仮説、検証の問いは Root とスキルが持つ。Harness は Snapshot と時点、実行枠、子の上限、Lab と観測器、研究 file と出力の保存、出力契約、digest、Programme Boundary の park、台帳を持つ。機械的な形式検査を加えても、source の読了、網羅、脆弱性の成立を Harness が判定しない（ADR 0034、0040）。共通の研究記録は Root が管理し、子は担当の scratch と型付き返答で引き継ぐ。探索担当の子には内部候補を研究記録に返し、出力契約の `findings` / `leads` を空配列にするようスキルが求める。独立点検を経た候補には、その点検記録への参照を残して最終出力する。ただし現行 Harness は、子が途中で出した有効な Finding / Lead も Root の報告とは独立に全件保存し、対象範囲内の Finding を全件レビュー列へ出す（ADR 0029、0031）。スキルだけで独立点検を昇格の必須 gate にはできない。今回の変更で隠れた park や自動棄却を足さない。強制 gate が必要なら、raw 候補を保全する別の Candidate → Review 受け渡し契約を ADR と PR で定める。

Cloudflare の `confirmed` を本リポジトリの確定へ写さない。agent の source 点検と探索 Lab の観測は Finding を支える資料だが、確定の根拠は人間の review Lab の `review observe match` と `review decide --reproduced match` だけである。経路に source 上の辺が足りなければ、足りない辺と次の観測を名指す Lead として残す。実行・環境・観測の失敗は理由付き `incomplete` とし、agent の `rejected` が人間の観測の代わりに判定しない。別 Snapshot の人間確認済み Finding も、新しい Snapshot では再確認する（SPEC 不変条件 3〜5）。

同じ対象を再訪するときは、互換な自分たちの過去 Trial の研究記録、Finding、Lead の索引を現在の作業の手掛かりにする。最新 1 Trial や代表 8 Lead だけに限らず、適格な過去版の未解決と source 変更箇所を拾える入力を設ける。索引の候補は旧記録の ID・版・source の位置と、型に応じた impact / primitive / missing edge / admission に絞る。境界の自由記述やレビュー全履歴まで輸送するとはここで決めない。候補本文、route file、Lab・HTTP 記録を無検査で丸ごと渡さない。payload、PoC、再現手順、認証情報、他人の公開記録の答えは渡さず、元 Trial の入力も SPEC 不変条件 1 の範囲にあったものに限る。評価では held-out の公開日以降に始まった Trial とそこから作った索引を渡さない。渡した記録は現在の source と条件を Root が開き直すための手掛かりであり、旧版の結論は継承しない。Harness は許可・時点・容量・digest の検査と輸送だけを行い、どの経路が今も成立するかは選ばない。具体的な索引 schema と設定名は別 PR の入力契約で固定する。それまでは SPEC 第 2 節の現行の二つの例外を越えて過去記録を渡さない。

既存の `wbh-tools` は文字列の列挙、`wbh-setup` は Lab の通常利用状態、`wbh-lab` は観測の手順として、上位スキルから必要な段で参照する。`wbh-recon` の地図と終了の役割は上位スキルへ統合し、目的文の固定した子の分配と手順の重複を整理する。旧目的文と旧スキルは過去 Trial の digest を照合するため残す。#724 の掃き出し・新版差分・名指しの深掘りは、同じ監査手順に作業を供給する入口として接続し、別々の Finding 判定法を作らない。複数段の連鎖の拡張は Stored XSS と SQLi の経路、Lab 観測、独立点検が安定してから扱う。

`wp2shell-bounty-v23-wide` を起動するときは `discovery.lab: attached` と `wbh-audit-v1`、`wbh-setup-v1`、`wbh-lab-v1` の同時指定を必要とし、重複する `wbh-recon-v3` は同居させない。これは agent が具体的な問いを Lab で試せるようにする起動条件であり、観測の成否や候補の真偽を Harness が決める条件ではない。`wbh-tools-v1` は補助で、起動条件にはしない。旧 v22-wide との比較では旧版側にも attached Lab と setup / lab skill を付け、Lab の有無を比較の差にしない。現行の本番 campaign 設定は v22-wide / `lab: none` のまま残し、候補 v23 への切替はこの採否の後に行う。

## 旧決定との関係

- ADR 0045 の凍結 5 項目のうち、人間の Lab 観測、Harness の制御だけ、追記専用の台帳、採否の分母は維持する。所有者の今回の決定により、同 ADR の 2026-11-03 追記 4 の「まず recon-v4 に限定」「前版 Finding / Lead の入力拡張を含めない」と、第 5 項の「目的文は消す方向だけ」は、この移行に限って改める。11 月の設計変更はこの移行と #724 を一まとまりとして扱う。目的と trust 境界を短く伝え、監査スキルを名指す版 `wp2shell-bounty-v23-wide` を作り、v22-wide の本文と digest は過去 Trial の照合用に残す。探索の手順は新目的文へ重ねず、上位スキルへ移す。
- ADR 0043 の「スキル本文は手順だけで、型の一覧と判断基準は目的文・契約に置く」は、この上位スキルの攻撃類型の読み方と、各類型で確認する source 上の問いについて改める。`wordpress-classes.md` は WordPress の境界を調べる問いを持つ。許される attacker、impact、trust 境界と Finding / Lead の型は従来どおり Programme Boundary・trust 境界宣言・Harness 生成の出力契約が定め、スキルは上書きしない。対象固有の答え、再現手順、Harness が強制する実行値もスキルへ移さない。
- ADR 0048 の許可 file と最新 1 Trial の選択、ADR 0044 の同じ Snapshot の代表 Lead は、既存 Trial の入力契約として生きる。過去の Finding / Lead の新しい索引は、SPEC と入力契約を改訂し、旧入力と別の版として記録してから起動する。旧 Trial の入力 digest は変えない。
- Cloudflare の coverage ledger や validator をそのまま Harness の判定器にしない。使う場合は agent の研究 file と、その形式・参照の検査に限る。過去に削除した Harness の入口索引、dispatch、網羅率、`incomplete(depth)` を復活させない（ADR 0034、LESSONS 14）。

## 導入と採否

1. 派生元 commit と MIT 表示を固定し、上位スキルと WordPress 用の参照文を版付きで登録する。旧スキルとの二重指示を消し、agent に渡る全文と日本語訳、出典対照表を [2026-11-04 の review](../reviews/2026-11-04-cloudflare-wordpress-audit-skill.md) に残す（DEVELOPMENT 第 5 節）。
2. 研究記録と独立した点検の一巡を、既存の出力契約と attached gVisor Lab に接続する。v23 の起動条件に上記の三つの skill と attached Lab を固定する。旧 run の研究と候補は読み続ける。過去記録の新入力は別 PR の版付き契約として、時点制限と Private Evidence の境界を検査してから加える。
3. 本番で旧入力と新入力を区別して測る。v22 と v23 の比較では Lab の有無を揃える。採否に使う Lab 発火 / Codex 時間と Wordfence の転帰の操作的定義、比較方法、DEVELOPMENT 第 2・5 節と SPEC 第 10 節の食い違いを、探索変更の採否より先に揃える。Finding、Lead、lookup、漏れ点検で開いた経路は診断値で、確定件数と読み替えない。

## 採らなかった選択肢

- Cloudflare の GitHub repo を新しい主リポジトリにし、WordPress の runner と Lab を作り直す: 公開 repo は skill と schema / validator が中心で、現在動いている Snapshot、gVisor、Lab、台帳、review の代替ではない。
- `wbh-recon-v4` の Closing だけを増やして全面移行とみなす: 漏れの発見後に source の再読、Lab、候補の独立検証、次回への引き継ぎを閉じられない。
- 過去の Finding や route file を無条件に丸ごと渡す: 未公開の候補、payload、誤った旧版の結論、評価の答えが混ざり得る。

## 消し方

新しい上位スキルと入力版を本番設定から外し、旧目的文と旧スキルの版を使う。実装 PR は段ごとに戻せるよう分ける。追加した台帳 event と過去 Trial の digest は追記専用のまま読み続ける。

## 2026-11-04 追記: v24-wide の独立点検を出口で強制する

上の決定は v23-wide / `wbh-audit-v1` のスキルによる一巡を定めたが、スキルだけでは子の直接 Finding を止められない。所有者は Harness も Cloudflare の監査手順に寄せることを決めたため、同じ移行の次版として `wp2shell-bounty-v24-wide` と `wbh-audit-v2` に限り、版付きの受理契約 `checked/v1` を使う。v22-wide と v23-wide の `direct/v1`、過去の Finding / Lead、旧台帳イベントは従来どおり読み続ける。本番の既定は比較と採否まで v22-wide のままである。

v24 の Root 最終報告は従来の `findings`、`leads`、`examined`、`unexamined` の 4 キーとする。子の最終報告はこの 4 キーに `checks` を加えた 5 キーとし、各点検を `{kind, candidate, verdict, explanation}` とする。`kind` は `finding` / `lead`、`verdict` は `verified` / `replace` / `refuted` / `blocked` である。点検者は発見者とは別の子として固定ソースと必要な Lab 観測を読み直す。Root は点検済みの正確な候補を最終報告に出す。子が `findings` / `leads` に自発的に出した候補も失わない。

Harness はすべての生候補と点検本文を先に Private Evidence に封じ、台帳には digest と状態だけを追記する。`checked/v1` では、子の実 run が `completed` で Root と異なり、同じ Trial と Target Snapshot に属し、点検の Private Evidence が解決できることを確かめる。その子の `verified` 点検にある候補と Root 候補について、正規化後の claim の canonical digest が一致するときだけ、既存の admission に渡して `finding-recorded` / `lead-recorded`、または Programme Boundary による `finding-parked` へ進める。Root の文面や研究ファイルの自己申告だけでは点検の代わりにならない。

一致する点検が無い Root 候補と、子の自発候補は pending として digest・理由を残し、別の一覧で見られるようにする。`replace` / `refuted` / `blocked` は点検者の報告であり、Harness の成立判定でも人間の `contradicted` でもない。Root 候補の点検が足りない Trial は理由付き `incomplete` とし、正常な候補 0 件に数えない。スキーマ不適合は従来の `candidate-held` と区別する。昇格した対象範囲内の Finding は検証結果に関係なく全件をレビュー列に出す（ADR 0031）。pending 候補を隠れた park や棄却には使わない。

Harness が確かめるのは出力の形式、run と digest の結合、Private Evidence の存在だけである。ソース経路の成立、Lab の観測の意味、脆弱性の確定は判定しない。確定の根拠は引き続き名指しした人間の Lab 観測と再現の記録だけとする（SPEC 不変条件 3〜5）。以前の調査の入力はこの版では増やさず、過去 Finding / Lead の索引は上の決定どおり別の版付き入力契約で扱う。

点検者が発見者と別の子であることはスキルが求める。Harness は点検者の実 run が Root と別であること、さらに claim を子の自発候補として記録した子自身の点検を使わないことを確認する。scratch の経路を最初に発見した子の識別までは証明しない。後続の同じ子による反証または別の子との点検の食い違いは、昇格に使わず pending に残す。

完了した子の過去ターンを復旧したとき、昇格済み claim の独立点検条件が後から満たされなくなる場合がある。Harness は元の `finding-recorded` / `lead-recorded` と人間の観測を消さず、原因イベントへの digest 参照を持つ `audit-candidate-disputed` を追記する。`review audit-pending`、Finding のレビュー表示、funnel の `audit disputed` に出す。これは AI 点検の受理状態であり、脆弱性の成立・不成立の判定ではない。

採否は同じ選定帯と Lab 条件の本番比較で決める。pending・独立点検・lookup の件数は診断値とし、Finding の成立数や人間の `match` と読み替えない。戻すときは新規 Trial の v24 / `checked/v1` の指定を外し、旧版の受理経路を使う。追記済みの候補・点検イベントと Private Evidence の digest は削除せず読取を維持する。

## 2026-11-04 追記: v25-wide を比較用の目的文にする

マージ前の独立レビューで、v24-wide の「wbh-audit-v2 を読む」という指示と、CLI が表示するスキル名 `wbh-audit` が一致しないと分かった。また、効果まで裏付けた候補だけを報告する文が、同じスキルの「影響まで一辺残る Lead」を妨げ得た。既存の目的文と digest を書き換えず、v24-wide を起動前に archived とし、CLI に見える名前と Finding / Lead の境界を明記した v25-wide を候補にする。v25-wide も同じ `wbh-audit-v2`、生成契約 v6、`checked/v1`、attached Lab を使う。本番の既定は v22-wide のままにする。この節は上の v24 に限る指定を、今後の比較 Trial について v25 に置き換える。

同じレビューで、Claude の子が途中の報告に自発候補を出し、最後の報告で消して自分の点検を返した場合、途中候補の記録が欠けて自己点検の除外を迂回できることも分かった。点検を含む子の報告は読めた全ターンの候補を保持し、自己点検の由来を台帳に残す。過去の `direct/v1` の最終報告の扱いは変えない。
