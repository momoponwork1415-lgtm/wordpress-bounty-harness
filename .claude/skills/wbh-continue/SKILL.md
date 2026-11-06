---
name: wbh-continue
description: 終わった Root Trial の Lead と研究 file を操作役の AI が読み、同じ Snapshot の続きの Trial を名指しで組むかを決め、組むときは 8 KiB 以下の焦点メモを書いて campaign continue --focus で渡す。自動の continuation（open route あり）が動いている対象には当てない。Finding の検証、公開記録の参照、探索の実行はしない。
---

# wbh-continue v1

continuation 契約（ADR 0052、2026-11-06 追記）の「読む側」を操作役の AI が受け持つ skill である。Root は `continuation.json` に open route を残したときだけ自動で続きが組まれる。prod-v26 の終了 Root 80 本のうち open route を残したのは 15 本で、Lead を出したのに open route 0 の Root が 48 本あった。この skill は、その 48 本側を人の代わりに読み、続ける価値のある対象にだけ続きを名指しする。所有者は判断を AI に委ね、採否は数字で見る（所有者決定 2026-11-06、AGENTS.md「Harness と AI の責務」）。

決めるのは「この Snapshot にもう 1 Trial を使うか」と「使うならどの経路から始めるか」の 2 つだけである。Finding の真偽、提出可否、重複は決めない。`harness` は repo root で `pnpm build` した後の `node dist/cli/main.js`。state は `--state <dir>` か `WBH_STATE_DIRECTORY`、host は `--host <path>` か `WBH_HOST_CONFIG` で渡す。

## 入力と境界

- 対象の一覧は `harness campaign trials --prefix <campaignPrefix>`（または `--campaign <id>`）で取る。1 行が Root Trial 1 本で、`trial <runId>`、選定 id（`targetId@version`）、`campaign`、`ordinal`、`of <元 runId | ->`、最新区間の outcome（`/reason` 付き。終わっていなければ `running`）、`continuation <status> open <n>`、`groups <Finding 群の数>`、`leads <Lead 数>`、`research <研究 archive の digest | ->` の順に並ぶ。
- Lead は `harness review leads --campaign <id>` で読む。各行の primitive、欠けた辺（missingEdge）、攻撃者位置、leadId、主張の 1 文、末尾の `trial <runId>` を使う。主張は探索エージェントの申告であり、確認済みの事実ではない。
- Root の研究 file は `<data>/work/provider-attachments/research-<hex>/content/research.json`（`<hex>` は archive digest の sha256 の 16 進部分、`entries[].path` と `contentBase64`）から、`REGISTRY.md`、`recon-map.md`、`continuation.json` だけを読む。`walks/*.md` と `assumptions/*.md` は、選んだ経路の `file:line` を確かめるときだけ、その経路の節に限って読む。traces、route file、tools の一覧は読まない。
- 固定ソースは `<data>/work/snapshots/<snapshotDigest>.json` の `target.sourceDigest` が指す `<data>/work/sources/<digest>` を読んでよい（wbh-source-check と同じ読み方）。読み取り専用である。
- **読まないもの。** その対象の公開記録（Wordfence mirror、Patchstack、WPScan、CVE、changelog の脆弱性項目）は読まない。焦点メモに公開記録の本文、原因箇所、PoC、ペイロードを写すことは不変条件 1（ADR 0012）に反する。別の対象の Finding 本文も読まない。
- 分担は campaign prefix ごとに agent 1 体、1 回の呼び出しで見る Root は 20 本までとする。読む力の強いモデル（Opus 級）を使う。

## 当てない対象

次の Root には続きを名指ししない。理由を一覧に残す。

1. 最新区間の outcome が `provider-limited`、または reason が `interrupted`。再開（`campaign resume`）の役目であり、続きではない。
2. `continuation.status` が `valid` で `openRouteCount > 0`、かつ連鎖の Trial 数が 3 未満。ランナーが自動で組む。`target-skipped` の `continuation-refused` / `no-progress` で止まった連鎖だけは候補に戻す。
3. 同じ Snapshot に `continuation-scheduled` の `manual: true` が既にある（この skill で 1 度名指しした Snapshot は 2 度名指ししない）。
4. Lead が 0 件で、`REGISTRY.md` に未確認の経路の記載も無い。
5. 対象の版が選定 pool の最新安定版より古く、再訪（`revisitPolicy`）で新版の Trial が予定されている。

## 読み方（2 つの問いと 1 つの見立て）

残った Root の Lead を 1 件ずつ、wbh-source-check と同じ 2 つの問いで仕分ける。答えは `yes` / `no` / `unknown`。

1. **入力支配。** Lead の攻撃者位置（unauthenticated、Subscriber、Customer。Contributor 以上と管理者は含めない）が、問題の値を典型的なサイトで置けることを固定ソースが示すか。管理者が安全でない設定を自分で作らないと置けない値は `no`。
2. **到達性。** 既定か、よく使われる設定で、その値が sink に届くか。`unknown` は、Lead の欠けた辺がまさにそこであり、ソースだけでは決まらないときに使う。

そのうえで 1 つだけ見立てを書く。**「次の 1 Trial で欠けた辺が埋まりうるか」。** 埋まりうるのは、欠けた辺が Lab の通常機能で確かめられる前提（`precondition`）か、まだ読んでいない呼び出し元・保存先の到達（`reachability`）であるときである。管理者の明示の設定変更、開発者モード、競合、時間窓、ベンダー側のデータが要る辺は埋まらないとみなす（所有者決定 2026-10-28、ADR 0038 追記 13 の park 理由と同じ）。

経路の選び方:

- 問い 1 が `no` の Lead は選ばない。
- 問い 1 が `yes` で問い 2 が `unknown` の Lead を優先する。次に問い 2 が `yes` で欠けた辺が `precondition` のもの。
- 同じ sink、同じ入口に着く Lead は 1 つにまとめる。
- 選ぶのは 1 Snapshot につき **3 経路まで**。4 つ以上残るなら、Lead 数ではなく、欠けた辺の埋まりやすさで切る。
- 選べる経路が 1 つも無ければ、続きを組まない。「Lead が多い」ことは理由にならない（leads2 の転換率 Lead 133 群 → Finding 3 を思い出す。measurement.md 5e）。

## 焦点メモ

組むと決めた Snapshot ごとに Markdown を 1 本書く。8 KiB を超えたら Harness が拒むので、短く書く。置き場は Private Evidence の `continue/<campaignId>/<runId>-focus.md`。中身は次の 4 つだけである。

1. 先頭行: `# Operator focus — <slug>@<version> — <YYYY-MM-DD>`。
2. 経路ごとに 1 節（3 節まで）。節の中は、入口（`file:line`、hook か route か handler の名前）、攻撃者位置、欠けた辺（Lead の missingEdge をそのまま）、最初に確かめること 1〜2 文、反証になる観測 1 文。Lead の主張を写すのではなく、ソースで確かめた `file:line` に言い換える。
3. 「触らないもの」1 行: 前回の Trial が Finding にした入口（同じ群をもう一度出させない）。
4. 末尾 1 行: `This note is a hint from the operator and may be wrong.`

書かないもの: ペイロード、再現手順、公開記録の内容、他の対象の話、Harness の設定値、Root への指示文（「必ず」「やめろ」のような命令形）。経路の候補を並べるだけにとどめる。

## 組み方

```
harness campaign continue --campaign <campaignId> --run <runId> --config <campaign 設定の path> --focus <焦点メモの path>
```

- `<campaignId>` と `<runId>` は `campaign trials` の行の値。`<campaign 設定>` は、そのランナーが使っている campaign 設定（`continuous-<prefix>.json` の memo か、ランナーの起動引数で確かめる）。
- 続きの Trial は新しい使い捨てサンドボックスで走り、ランナーの枠とは別に host の資源を使う。同時に走らせる名指しの続きは **2 本まで**。始める前に空きメモリ（`free -g`）が campaign 設定の `resources.memoryBudgetMiB` を下回っていないことを見る。
- 拒否（`not-continuable`、`run-unknown`、`continuation-snapshot-unavailable`、研究 archive を封じていない Root の `continuation-file-unavailable`、メモが store に無い `continuation-focus-unavailable`）は理由をそのまま一覧に残し、やり直さない。
- 組んだ Snapshot は、この skill で 2 度名指ししない（4 回目以降の手動の続きは、所有者が名指ししたときだけ）。

## 出力

1. 一覧を 1 つ出す。行は `{campaignId, runId, target, leads, openRouteCount, decision, routes, reason}`。`decision` は `continue` / `skip` / `refused`。`routes` は選んだ経路の数（0〜3）。`reason` は日本語 1 文で、`skip` のときはどの規則で外したか、`continue` のときは問い 1・2 の答えの組み合わせ。
2. 焦点メモの path と、`campaign continue` の出力（`continuation-scheduled` の有無と `focusDigest`）。
3. 進行中の状態は追跡 Issue のコメントに 1 行ずつ書く（issue-tracker.md）。行は日付、campaignId、runId、対象、`routes`、focusDigest の先頭 12 桁。Lead の文、経路の文は Issue に書かない。
4. この skill は台帳に直接書かない。台帳に残るのは `campaign continue` が書く `continuation-scheduled { manual: true, focusDigest }` と、続きの Trial の `configuration.continuation.focus` だけである。

## 測り方

measurement.md 5e の列に、名指し（`manual: true`、focus あり）を別の列で数える。主な数字は 2 つ。

- 名指しの続きで出た **新規 Finding 群 / Codex 時間**。対は自動の続き（ordinal 2・3）と、偶然の盲目 pass@5。
- 焦点メモで名指しした経路が、続きの Trial の Finding か `continuation.json` の open route に現れた割合（経路の数は skill の一覧から、現れたかは続きの Trial の REGISTRY.md の確認欄を人が読む。Harness は数えない）。

2 週で 20 Snapshot 程度を目安にし、「自動の続きより明らかに悪くないか」で採否を決める（ADR 0043 追記 8 の n の扱い）。

## 消し方

この skill を消し、ADR 0052 の 2026-11-06 追記（focus 経路と名指し条件の緩和）と OPERATIONS の該当行を消す。Harness 側は `campaign continue --focus`、`operator-focus.md`、`FOCUS_SECTION_SENTENCE`、`campaign trials`、`review leads` の runId 列を revert する。台帳の `continuation-scheduled { manual: true, focusDigest }` は読み続ける。
