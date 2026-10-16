# ChatGPT への文書作成依頼文 4 本（2026-10-16）

所有者が ChatGPT に貼って、人が Harness を回すための派生文書を 4 本作る。正本は [SPEC](../SPEC.md) と [ADR](../adr/)。ここで作る文書は派生であり、規則を足さない。agent に渡る文章（prompt、skill、trust 境界宣言、Programme Boundary）は対象外。

おすすめの順: 1 所有者の手順書 → 2 故障カタログ → 3 設定ファイルの説明 → 4 用語集の拡張。1 本ずつ別の会話で作る。

## 使い方

1. 下の「共通の前置き」と、作る文書の依頼文を 1 つ、ChatGPT に貼る。
2. 「渡す file」に挙げた file を全文貼る（長いものは分割して貼る。貼り切れない file は依頼文から外し、「未確認」で書かせる）。
3. 出てきた Markdown を指定の path に置き、branch `docs/<文書名>` で PR を出す。PR 本文は 5 項目（問い / 変えたこと / 変えなかったこと / 測った数字 / 消し方）。「測った数字」は「本文の各節が参照する正本の file と節番号の数」で足りる。
4. AI（Claude の委任セッション）が材料との整合を見て merge する。正本と食い違う行は AI が直すか、PR comment で返す。

## 共通の前置き（4 本とも先頭に付ける）

```text
あなたは WordPress plugin の脆弱性探索 Harness（wordpress-bounty-harness）の文書を書く。読者は所有者 1 人（開発者。Harness の設計者ではなく運用者として読む）。言語は日本語。

守ること:
- 正本は docs/SPEC.md と docs/adr/。文書の先頭に「正本は SPEC と ADR。食い違えば正本が勝つ。この文書は規則を足さない」と書く。
- 渡した材料に書いてあることだけを書く。材料に無いこと、推測、一般論、他製品の慣行は書かない。分からない箇所は本文に「未確認」と書いて空けておく。
- 各節の末尾に、根拠にした材料の file 名と節番号を 1 行で書く（例: 根拠: docs/OPERATIONS.md 第 2 節、docs/SPEC.md 第 7 節）。
- 新しい規則、手順、閾値、命名、用語を作らない。材料にある語をそのまま使う。
- 探索 agent に渡す文章（prompt、skill、trust 境界宣言、Programme Boundary）の本文は引用も改変もしない。
- 脆弱性の payload、再現手順、公開前の発見、認証情報、対象 plugin の関数名・option 名・URL は書かない。
- 文は短く。表と番号付き手順を優先する。1 文書は 300 行以内。
出力は Markdown 1 本。前置きや謝辞は書かない。
```

## 1. 所有者の手順書 → `docs/OWNER-RUNBOOK.md`

```text
作る文書: docs/OWNER-RUNBOOK.md「所有者の手順書」

目的: 所有者が毎日 10 分と週末 1 時間で何を見て、何を決め、何をしないかを 1 枚で分かるようにする。今は docs/OPERATIONS.md、docs/DEVELOPMENT.md、docs/FACTORY.md、docs/reviews/2026-10-14-final-design.md 第 7〜8 節に分かれている内容を、所有者の時間軸で並べ直す。内容は足さない。

構成:
1. 役割分担の表（所有者 / Codex / Claude の委任セッション）: 誰が決め、誰が実装し、誰がレビュー・計測・merge・triage するか。材料: docs/FACTORY.md 第 1・3 節、docs/DEVELOPMENT.md 第 4〜5 節。
2. 毎日 10 分の確認（番号付き手順、各手順に見る場所と「異常なら誰に回すか」）。材料: docs/OPERATIONS.md 第 2 節と第 4 節、final-design 第 7 節。
3. 週末 1 時間の手順: review export → skill 3 本 → decide → 提出。人間の判断点は「提出前のレビュー」と「外部行動の承認」の 2 つだけであること（SPEC 第 2 節 6〜7）を冒頭に書く。材料: docs/OPERATIONS.md 第 3 節、docs/DEVELOPMENT.md 第 7 節。
4. 所有者だけができる操作の一覧: owner-approved ラベルの付与と対象 path、起動・停止の判断、権限・対象範囲の拡張の承認、外部送信の承認。材料: docs/DEVELOPMENT.md 第 5〜6 節、docs/FACTORY.md 第 4 節、SPEC 第 2 節。
5. Codex に作業を渡す手順: Issue の選び方（ready-for-agent）、依頼文の貼り方、open PR が 3 本を超えたら新しい実装 PR を出さない規則、PR 本文 5 項目の確認。材料: docs/DEVELOPMENT.md 第 5 節、docs/FACTORY.md 第 2・5 節、docs/agents/triage-labels.md。
6. 「人手介入に数えない保守」と「数える介入」の区別。材料: final-design 第 7〜8 節。
7. しないことの一覧（Harness 自身は送信しない、Lab 外で対象を実行しない、未検証候補の採否を人が決めない など）。材料: SPEC 第 2 節、docs/OPERATIONS.md 第 7 節。

渡す file: docs/SPEC.md 第 2 節と第 8 節、docs/DEVELOPMENT.md 全文、docs/OPERATIONS.md 第 1〜5 節と第 7 節、docs/FACTORY.md 全文、docs/reviews/2026-10-14-final-design.md 第 7・8・10 節、docs/agents/triage-labels.md、GitHub Issue #238 の本文。
```

## 2. 故障カタログ → `docs/TROUBLESHOOTING.md`

```text
作る文書: docs/TROUBLESHOOTING.md「故障カタログ」

目的: Harness が止まった・結果が出ないときに、所有者が症状から原因と対処を引けるようにする。「症状 → 見る場所 → 原因 → 対処 → 誰がやるか（所有者 / Codex / Claude）」の表を中心にする。

構成:
1. incomplete の理由コード 7 種（provision、precondition、recipe、observation、evidence、cleanup、digest-mismatch）と no-judge。各コードについて、意味、自動再試行の有無と回数、人間へ回る条件。incomplete は陰性ではないことを先頭に書く。材料: docs/SPEC.md 第 7 節、docs/adr/0022、docs/adr/0026。
2. 探索 run の終了理由（wall、provider の上限、broker、schema 失敗、Trial に数えない run）。材料: docs/SPEC.md 第 6 節、docs/OPERATIONS.md 第 2 節と第 5 節「子の最終JSONがschemaで失敗したとき」。
3. runner（continuous run）の停止理由 6 種と、それぞれの再開方法。材料: GitHub Issue #238 の本文「止まるのは…6 種だけ」、GitHub Issue #242 の本文、docs/reviews/2026-10-14-final-design.md 第 3・7 節。
4. 対象が黙って飛ばされる場合（target-skipped、evaluation-case-blocked）。材料: docs/evaluation/README.md、GitHub Issue #281 の本文、GitHub Issue #282・#283 の本文。
5. Lab の前提が崩れる場合: WordPress image の拡張不足、Lab / broker の残骸、履歴 mirror の鮮度。材料: docs/OPERATIONS.md 第 1 節と第 5 節「Lab / brokerの残骸」「履歴mirrorの更新」、GitHub Issue #281 の本文。
6. 終了コードの一覧（0 / 1 / 3 の意味）。材料: docs/OPERATIONS.md 全文から終了コードに触れる行だけを拾う。
7. 見つけた異常を誰に回すかの判断表（設定の誤り → 所有者、コードの欠陥 → Issue を起票して Codex、判定の疑義 → Claude の委任セッションでレビュー）。材料: docs/FACTORY.md 第 2〜3 節。

書かないこと: 具体的な対処コマンドの新規考案。材料にあるコマンドだけを引く。

渡す file: docs/SPEC.md 第 6〜7 節、docs/OPERATIONS.md 全文、docs/adr/0022-*.md、docs/adr/0026-*.md、docs/evaluation/README.md、docs/evaluation/2026-10-12-rediscovery-benchmark.md、docs/reviews/2026-10-14-final-design.md 第 3・7 節、GitHub Issue #238・#242・#281・#282・#283 の本文。
```

## 3. 設定ファイルの説明 → `docs/CONFIG.md`

```text
作る文書: docs/CONFIG.md「設定ファイルの説明」

目的: 所有者が手で触る 3 つの設定 file（host.json、campaign.json、selection.json）の各項目について、意味、必須か任意か、既定値、変えてよい条件、古い値を使い回したときに起きる事故を表にする。正本は Zod schema（TypeScript）なので、schema の file と行番号を根拠に書く。

構成:
1. 3 つの file の役割と、どの CLI コマンドがどれを読むか。材料: docs/OPERATIONS.md 第 1〜2 節、docs/reviews/2026-10-14-final-design.md 第 6 節「設定の正本」。
2. host.json の項目表。材料: src/cli/wordpress-host.ts の wordpressHostConfigSchema、examples/translatepress-3.3.1/host.example.json。
3. campaign.json の項目表。材料: src/cli/wordpress.ts の campaign 設定 schema、examples/translatepress-3.3.1/campaign.json と campaign-cooperative.json。
4. selection.json の項目表。材料: src/profiles/wordpress/selection/contracts.ts の wordPressSelectionPolicySchema、examples/translatepress-3.3.1/selection.json。
5. 「所有者が owner-approved で守る path」に入る設定（policy/campaign.json、policy/programme-scope.md）と、本文書が扱う運用設定の区別。材料: docs/DEVELOPMENT.md 第 5 節。
6. 既知の事故 2 件: campaign ID が長すぎて対象が黙って skip される（Issue #281）、WordPress image に pdo_mysql が無く Lab が incomplete(precondition) になる。材料: GitHub Issue #281 の本文、docs/OPERATIONS.md 第 1 節。

表の列: 項目 / 型 / 必須 / 既定値 / 意味 / 変えてよい条件 / 根拠（file:行）。schema に無い項目は書かない。schema にあって意味が読み取れない項目は「未確認」。

渡す file: src/cli/wordpress-host.ts、src/cli/wordpress.ts（schema の定義部分。長ければ z.object / z.strictObject を含む箇所の前後 40 行ずつ）、src/profiles/wordpress/selection/contracts.ts、examples/translatepress-3.3.1/ の host.example.json・campaign.json・campaign-cooperative.json・selection.json、docs/OPERATIONS.md 第 1〜2 節、docs/DEVELOPMENT.md 第 5 節、docs/reviews/2026-10-14-final-design.md 第 6 節、GitHub Issue #281 の本文。
```

## 4. 用語集の拡張 → `GLOSSARY.md`（既存に追記）

```text
作る文書: GLOSSARY.md の追記分（既存 12 語は変えない。新しい行だけを出す）

目的: 文書と Issue に出てくるが GLOSSARY.md に無い用語を、正本の定義で 1 行ずつ足す。意味を新しく作らない。正本に定義が無い語は「未確認」の行として出し、所有者が消すか残すかを決める。

足す候補（材料に定義があるものだけ）: 入口索引、Programme Boundary、parked（finding-parked）、Trial に数えない run、Root と子（subagent）、wave、入口索引を渡す catalog、Lab Setup、Lab 観測器、canary、判定器（judge）、no-judge、negative control、Reproduction Package と review export、legacy JSON（legacy-history）、reconsider、continuous run の状態（selected / frozen / lab ready / discovery started / discovery finished / verification / done）、runner の停止理由、target-skipped、evaluation-case-blocked、owner-approved、ready-for-agent / ready-for-human、back-pressure（逆圧）、charter（憲章）、wbh-tune。

書き方: 既存 GLOSSARY.md と同じ 2 列の表（用語 / 意味）。意味の末尾に根拠（SPEC 第 n 節、ADR 番号、file 名）を括弧で付ける。既存の 12 行と重複する語は出さない。

渡す file: GLOSSARY.md、docs/SPEC.md 第 6・7・8a・9・15 節、docs/adr/0018-*.md、docs/adr/0019-*.md、docs/adr/0026-*.md、docs/adr/0029-*.md、docs/adr/0031-*.md、docs/adr/0032-*.md、docs/FACTORY.md 全文、docs/DEVELOPMENT.md 第 5 節、docs/reviews/2026-10-14-final-design.md 第 3 節、docs/agents/triage-labels.md。
```

## 確認（AI が merge 前に見るもの）

- 先頭の「正本が勝つ / 規則を足さない」の 1 行がある。
- 各節の根拠行が、実在する file と節番号を指す。
- 材料に無い規則・閾値・コマンドが無い。「未確認」が残っていれば所有者に戻す。
- payload、再現手順、対象固有の関数名・option 名・URL が無い。
- agent に渡る文章の引用が無い。
