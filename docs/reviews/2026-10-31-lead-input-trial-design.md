# Lead を入力にした第 2 Trial の設計案（#715）

日付: 2026-10-31。これは設計の下書きで、正本ではない。SPEC、AGENTS.md、ADR はこの PR では変えない。第 4 節の文面は、所有者が正本へ自分でコミットするための案である。コードは、その追記が通ってから別の PR で書く。

## 0. 何を解くか

探索は Trial ごとに Lead を出すが、Lead を Finding まで詰める段がどこにも無い。2026-10-31 の `prod-v18-20261031-*`（35 Trial、35 Snapshot、`wp2shell-bounty-v18-wide`、Lab なし）では、Lead 134 件が 24 Snapshot に出た。`scripts/lead-groups.mjs` で端点ごとに束ねると 71 群になる（Snapshot あたり 1〜10 群、中央値 2）。2 件以上を含む群は 54 ある。第 2 Trial は、この群の代表を同じ Snapshot の新しい Trial に入力として渡し、探索 Lab を付けて走らせる。目的文は変えない。

Harness が新しく持つのは次の 3 つで、どれも判断を含まない。

- 名指しされた Lead の読み出し
- 決まった形の節の生成
- 台帳への記録

どの群を渡すかは、AI 操作役が `scripts/lead-groups.mjs` の出力を見て決め、campaign 設定に書く（AGENTS.md「Harness と AI の責務」）。

## 1. campaign の設定

`discovery` に任意の設定ブロックを 1 つ足す。このブロックが無い campaign は、今と同じに動く。

```jsonc
{
  "discovery": {
    "mode": "wide",
    "lab": "attached",
    "priorLeads": {
      // 群の代表。1 件ずつ campaignId と leadId で名指しする。
      "representatives": [
        { "campaignId": "prod-v18-20261031-4", "leadId": "sha256:..." },
      ],
    },
  },
}
```

- 名指しした Lead を Snapshot digest ごとにまとめ、Snapshot ごとに Trial を 1 回計画する。対象の選定は回さない。この campaign の対象は、名指しした Lead の Snapshot だけである。
- Snapshot は凍結し直さない。台帳に `snapshot-frozen` がある digest を `loadSnapshot` で読み戻す（#692 の再検証と同じ経路）。読み戻せない、または digest が一致しない場合は、Lab を立てる前に `prior-leads-snapshot-unavailable` で拒否する。
- 次の場合も、起動前に設定エラーにする。
  - 名指しした Lead が台帳に無い
  - `lead-recorded` の Private Evidence が読めない
  - 1 Snapshot あたり上限（案: 8 群）を超える
- 同じ Snapshot に、同じ群の組で第 2 Trial を走らせたことがあれば拒否する（`prior-leads-already-run`）。照合には、台帳の `configuration.priorLeads.representativesDigest` を使う。Issue の受入条件 6「同じ版・同じ入力の再走はしない」を Harness の形の検査として持つ。
- `promptId` と `mode` は既存の規則のとおり campaign 設定で決める。目的文は変えない。

## 2. Harness が生成する `## Prior leads` 節

ADR 0019 の形にならう。`## Run parameters` の後、`## Trust boundary` の前に置く。中身は、名指しした代表 1 件ごとに次の 2 つだけである。

1. 固定ソースの file と関数の名前。代表の `sourceTrace` の行を順に並べる。行番号は落とし、同じ file と関数の重複は 1 行にする。依存側の行（`@wordpress/`、`@php/`、`@dependencies/`）も、固定ソースの場所なので残す。
2. 代表の Lead が書いた「残っている隙間」の文。

### 渡さないもの

次のものは節に入れない。

- `labObservations`。要求、path、値を含みうる。
- `storage.key`
- 群の件数と Trial の数
- 公開記録の答え。advisory、CVE、修正版との差分。
- PoC、payload、URL、HTTP の要求の写し

### 隙間の文の扱い

今の Lead schema には「隙間の文」という専用の欄が無い。案 A を採る。

- **案 A（採る）**: `summary` の最初の文を使う。Harness は次の形の検査だけをする。
  - 300 字以内
  - URL（`://`）を含まない
  - HTTP メソッドで始まる path を含まない
  - backtick と引用符で囲んだ 20 字超の文字列を含まない
  - `<` と `>` を含まない

  1 つでも当たれば、その代表の隙間の文は `(withheld)` と書き、file と関数の名前だけを渡す。検査は文字の形だけを見て、意味は読まない。withheld の件数は台帳に残す。
- **案 B（採らない）**: Lead schema に `remainingGap` 欄を足す。これは出力契約の変更になる。2026-10-27 の契約 v5 で Finding が崩れた（契約の文が探索を縮めた）ことを考えると、この Issue の問いと交絡する。

### 節の文面案

agent に渡る文章なので、この雛形を入れる PR は DEVELOPMENT.md 第 5 節の手順に従う。全文と日本語訳を PR に貼り、`owner-approved` を付ける。

```text
## Prior leads

An earlier Trial on this same Snapshot reported the leads below. Each lists places in the frozen source, in the order that Trial traced them, and the sentence in which it stated what it had not shown. They are unconfirmed and may be wrong. Report Findings and Leads under the same output contract as any other Trial.

### Prior lead 1
- Places: `<file>` `<function>`; `<file>` `<function>`; ...
- Not shown: <sentence or (withheld)>

### Prior lead 2
...
```

雛形は、場所と「示せなかったこと」を伝えるだけにする。「ここから始めよ」「これを確かめよ」のような手順は書かない（ADR 0019、SPEC 第 6 節）。最後の文は、出力契約が同じであることだけを言う。

### 台帳への記録

`discovery-run-started.configuration` に `priorLeads` を足す（追加のみ）。

```jsonc
"priorLeads": {
  "representatives": 3,                 // 渡した代表の数
  "representativesDigest": "sha256:…",  // campaignId と leadId の組を並べ替えた digest
  "leadIds": ["sha256:…"],              // 代表の leadId（digest なので台帳に置ける）
  "gapWithheld": 1,                     // 隙間の文を withheld にした数
  "sectionDigest": "sha256:…"           // 生成した節の digest
}
```

`inputDigest` は今と同じく全文を覆う。Lead の本文、file の名前、関数の名前は台帳に置かない。節の全文は、Trial の Private Evidence にある入力の写しにだけ残る（不変条件 8）。

## 3. Lab

第 2 Trial は `discovery.lab: attached` で走らせる。

- 新しい仕組みは足さない。既存の探索 Lab を使う（ADR 0003 の 2026-10-25 追記）。Trial ごとに 1 台立て、`POST /reset` と `POST /observe` を予算の中で使えるようにし、HTTP の捕捉と状態の差分を封じる。生成される `## Lab` 節も今のままである。
- Harness は判定しない。canary は置かない。agent は Lab の観測を `labObservations` に書く。確定は従来どおり、名指しした人間の `review observe` の match と `review decide --reproduced match` だけである（不変条件 3、ADR 0040）。
- 第 2 Trial から出た Finding も、通常の Finding と同じ流れに乗る。具体的には park、段 1（wbh-screen）、段 1b（wbh-source-check）、検証 Lab である。探索 Lab での観測は、検証の根拠にしない。
- `priorLeads` と `lab: none` の組も設定としては受ける。ただし、計測の最初の 20 Trial は Lab ありだけで回す（Issue の受入条件 5）。Lab なしとの比較は次の問いにする。

## 4. 不変条件 1 の追記案（所有者がコミットする）

この PR では SPEC、AGENTS.md、ADR を編集しない。以下は提案する文面である。

### SPEC.md 第 2 節 1 項の末尾に足す文

> 例外として、campaign 設定で名指ししたときに限り、同じ Target Snapshot に対する自分たちの過去 Trial の Lead（群の代表）を、Harness が生成する `## Prior leads` 節で渡してよい。節に入れるのは、固定 source の file と関数の名前と、その Lead が書いた「示せなかったこと」の一文だけである。`labObservations`、storage の key、payload、URL、HTTP の要求、公開記録の答え（advisory 本文、原因箇所、修正差分）、PoC は渡さない。評価 run では、held-out の公開日以降に始まった Trial の Lead を渡さない（[ADR 00xx](adr/00xx-prior-leads-input.md)）。

### AGENTS.md「不変条件」1 項の末尾に足す文

> 例外: campaign 設定で名指ししたときだけ、同じ Snapshot に対する過去 Trial の Lead の代表を、Harness 生成の `## Prior leads` 節で渡せる。中身は固定ソースの file と関数の名前と、Lead 自身が書いた隙間の一文に限る（ADR 00xx）。

### ADR（新規、または ADR 0029 の追記）に書く要点

- ADR 0029 の「対象ごとに 1 回」と「同一対象の自動追加 Trial はしない」との関係を書く。第 2 Trial は名指しでだけ走る、入力の違う Trial であり、自動の追加 Trial でも pass@k の重ね掛けでもない。台帳では `configuration.priorLeads` の有無で分ける。v14-wide、v18-wide の Trial と同じ比較の分母に混ぜない。
- 同じ Snapshot に同じ代表の組で 2 回目は走らせない。
- 渡してよい Lead は、それを出した Trial の入力が不変条件 1 の範囲にあったものに限る。v8 以降の Trial なら満たす。ADR 0012 の時点カタログを受けた旧 Trial の Lead は、その入力の範囲で渡してよいかを ADR に明記する。案は「渡さない」。
- 消し方は次のとおり。`discovery.priorLeads` のブロック、節の生成関数、`configuration.priorLeads` の書き込みを削除する。台帳の既存 event は消さない。

## 5. 計測

Issue の受入条件 5 と 6 に従う。

- **対象**: Lead 群が 1 件以上ある Snapshot から 20 件を選ぶ。2026-10-31 時点では、`prod-v18-20261031-*` に 24 Snapshot ある。どの群を代表にするかは AI 操作役が決め、選び方の規則を Issue のコメントに残す。案は、Snapshot あたり 2 件以上の群を優先し、最大 8 群とすること。同じ版・同じ入力の再走はしない。
- **構成**: 第 1 Trial と同じ `promptId`（今は `wp2shell-bounty-v18-wide`）と mode にし、`discovery.lab: attached` を付ける。campaign ID には `lead2` と版を入れる（例 `prod-lead2-v18-20261101-1`）。
- **主な数字**
  1. Lead→Finding の変換率 = 第 2 Trial の Finding が入力した群に入った群の数 / 入力した群の数。「群に入った」は `scripts/lead-groups.mjs --snapshot <digest>` の既定規則（overlap）で、Finding と入力した代表が同じ群になることとする。`pair` 規則での数も並べる。
  2. 段 1b（wbh-source-check）を通った Finding の数。入力した群に入ったものと、入らなかったもの（新しい場所）に分けて数える。
  3. Trial あたりの Finding 数と、Finding が 1 件以上出た Trial の割合（M1）。第 1 Trial の数と並べる。ただし対になった比較ではないこと（入力と Lab の 2 軸が違う）を明記する。
- **併記する数字**
  - completed / incomplete の理由
  - wall
  - Lab の `labObserved`（要求数、reset、observe の回数）
  - `gapWithheld` の件数
  - 人間の観測の match（出たときだけ）
- **読み方**: 第 1 Trial は Lab なし、第 2 Trial は Lab ありなので、変換率が上がっても「Lead を渡した効果」と「Lab を付けた効果」は分けられない。Issue のとおり、まず Lab ありで 20 Trial を取る。変換が出たら、次の問いで Lab なしの第 2 Trial を同じ帯で取って分ける。
- **やめる条件（案）**: 20 Trial で次の 2 つがどちらも 0 なら、この経路を止めて PARKING に送る。
  - 変換した群
  - 段 1b を通った Finding

## 6. 未決の問い

1. 隙間の文を `summary` の最初の文にする案 A でよいか。それとも、enum の `missingEdge`（producer / consumer / auth-use / reachability / precondition）も添えるか。Issue の文面（「file と関数の名前と、残っている隙間の文だけ」）に従うなら、enum は添えない。
2. 群の作り方の既定は `overlap`（#424 と同じ）でよいか。本番の v18 では、`overlap` で 71 群（2 件以上の群は 54）、`pair` で 88 群（同 49）になる。`overlap` は、同じ入口関数を共有する別の弱点を 1 群にまとめやすい。
3. ADR 0029 の「対象ごとに 1 回」への追記を新しい ADR にするか、0029 の追記にするか。
4. 第 2 Trial の制限時間と子の上限は、第 1 Trial の campaign と同じ値（wide、120 分、同じ `maxChildren`）でよいか。
5. 探索 Lab を Trial ごとに 1 台立てるので、ホストのメモリ予算（`memoryBudgetMiB`）の中で同時に何 Trial 走らせるか。
