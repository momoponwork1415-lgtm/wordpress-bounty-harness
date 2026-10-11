# 公開ハーネスとの比較と、作り込みの過不足（2026-10-11）

問い: 「現在の設計は、Anthropic（Mythos scaffold）、Cloudflare、Mozilla、Google Mantis、XBOW、OpenAI Aardvark と比べて、どこが厚く、どこが薄いか。収益装置として過剰に作り込んだ部分はどこか」。

調べ方: `origin/main`（`d83c2ad`）の SPEC v0.18、ADR 0001〜0027、DESIGN-EVIDENCE、`src/` の行数と構造を読み、各社の一次資料（下記出典）を当日取得して照合した。実機は動かしていない。正本ではない報告であり、ここから所有者が選んだものだけが Issue / PR / ADR になる。

## 1. 結論

**「確認の規律」は公開事例と同じ水準で、削るべきではない。「確認の前後」に積んだ装置が、成果が出る前に厚くなりすぎている。**

公開事例が共通して投資しているのは4つだけである。

1. **独立で安い探索run を多数**回す（Anthropic: 1,000 run / 2万ドル未満、Cloudflare: 約50 hunter 同時、Mozilla: 使い捨てVMをfile別に並列）。
2. **モデルの外にある判定の物差し**（Anthropic / Mozilla: AddressSanitizer、XBOW: 非AIのvalidator と canary、Mantis: Tier 3 sandbox 再現だけが `reproduced`）。
3. **同根の重複を畳む**（Cloudflare: Dedupe 段、Anthropic: file 別に分けて重複を予防、Mantis: `mantis-dedupe`）。
4. **人間が最後に見る**（全社）。

本設計は 2 と 4 を持ち、**1 と 3 が薄い**。一方で、公開事例に対応物がないか、あってもずっと軽い部分が多い。

| 領域 | 本設計 | 公開事例の最も近いもの | 評価 |
| --- | --- | --- | --- |
| 判定器（nonce canary、HTTP 捕捉、headless browser） | 8 分類の決定論的判定器、`incomplete` の理由コード 7 種 | XBOW の validator、Mantis の Tier 3 + `not_attempted`、Anthropic の ASan | **同等。維持** |
| 隔離 | gVisor、RO source、broker 経由の egress のみ | Anthropic「Internet から隔離した container」、Mantis「ISOLATED, RESTRICTED ENVIRONMENTS」 | 同等。維持 |
| 探索の並列度 | 対象ごとに 1 Trial を逐次。Root＋3 は Codex CLI の `multi_agent` に委任 | Anthropic: file 別 agent を並列、Cloudflare: 攻撃分類×scope の task を約 50 並列、Mozilla: file 別の使い捨て VM | **薄い。最大の差** |
| 探索の中身 | 一段目 screening → 条件付き二段目 deep-dive → Harness 継続（ADR 0025） | Anthropic: 1 段落の prompt、Cloudflare: Recon → Hunt → Validate → Gapfill | 段構えは Cloudflare 並み。ただし Cloudflare は並列を前提にした段で、逐次ではない |
| 独立 Verifier | 新コンテナの反証 agent + 判定器 | Cloudflare の Validate（別 prompt、新 Finding を出せない）、Anthropic の確認 agent | 同等 |
| 重複 | Wordfence mirror との照合のみ。自分の Finding 同士の dedupe は無い | Cloudflare Dedupe 段、Mantis `mantis-dedupe` | **薄い** |
| 台帳 | 23 種の型付き event、digest gating、Private Evidence の content-addressed store | Mantis: finding ごとの JSON と `history` 配列、Cloudflare: schema 付き report を ingest API へ、Mozilla: bucket に書く | **厚い**。中身は Mantis の finding state と同じことをしている |
| 候補の救済 | `candidate-held` / `candidate-normalized` / `child-report-recovered` / `discovery-report-recovered`（ADR 0018） | 無し。schema 失敗は修正させるか落とす（Cloudflare: 自分で schema エラーを直す） | **厚い**。Codex `multi_agent` の不安定さへの対処が設計に昇格している |
| 評価 | 盲検 rubric、Wilson 区間、Answer Key registry、A/B arm、prompt 20 版の digest pin | Anthropic / Mozilla: 発見数を数える。Mantis: `mantis-calibrate` の rubric | **厚い**。自分の DESIGN-EVIDENCE §9 が「9 件では大きな差しか検出できない」と認めている |
| review | scope 評価、Draft 版管理、External Action Authorization、Submission Candidate | Mantis: 「security expert が手で確認」、Cloudflare: 既存の脆弱性管理プロセスへ | **厚い**。提出 0 件の段階で承認ワークフローを型にしている |
| 認証ブローカー | 約 1,800 行（broker、proxy、TLS grant、CLI） | 公開事例は記述なし（API 鍵をどこに置くか書いていない） | 厚いが、購読認証情報を対象コードと同居させる以上は必要。削らない |
| profile 分離（ADR 0011） | 汎用 8 モジュール + `profiles/wordpress/` | Mantis: 言語非依存の skill 群。他は自社コード専用 | 2 つ目の profile が無い段階では費用だけ |

数字で見ると、リポジトリは 2026-10-08 開始の 3 日で、`src/` 22,629 行、tests 17,498 行、ADR 27 本、文書 1,613 行。未知脆弱性の `runtime-confirmed` は 0、提出 0。Anthropic は「1 段落の prompt + container」で数十件を出し、人間 triager に送った。**本設計の重さは、成果が出てから必要になる種類の重さである。**

## 2. 各ハーネスの要点（一次資料から）

### Anthropic（Mythos Preview、2026-04）

- scaffold: 「Internet と他システムから隔離した container で対象とソースを動かし、Claude Code を 1 段落の prompt で起動する。prompt は実質 "Please find a security vulnerability in this program"」。
- 多様性: 事前に file を 1〜5 で順位付けし、agent ごとに別 file を担当させる。「同じバグを何百回も見つける確率を下げる」ため。
- 判定: memory safety は ASan が「本物と幻覚を完全に分離する」。logic bug では「正しさをほぼ完全に検証する能力を失う」と明記。
- 後処理: 最後の agent に「この報告は本物で interesting か」を聞く。高重大度は「professional human triagers」へ。契約者が「全報告を手で検証」。
- 費用: OpenBSD で 1,000 run 2 万ドル未満、FFmpeg 数百 run で約 1 万ドル。
- 無いもの: dedupe、自動 triage、patch 生成の記述は無い。

### Cloudflare（Glasswing、2026-06）

- 8 段: Recon → Hunt（約 50 並列、各 hunter が subagent を数本）→ Validate（別 prompt の agent、新 Finding を出せない）→ Gapfill → Dedupe（同根を 1 件に）→ Trace → Feedback → Report（schema 付き、ingest API へ）。
- 原則: 「"Find vulnerabilities in this repository" より、architecture doc と過去 coverage を添えた狭い問いが勝つ」「"バグか" と "攻撃者が届くか" を分けて問う」「網羅する 1 agent より、狭い agent を多数 + 後で dedupe」。
- 「意図的に over-report に調整し、noise は後段で落とす」。候補 20,799 件の約 42% を検証で落とした。
- 人間の段は harness の中に無く、既存の脆弱性管理プロセスに流す。

### Mozilla（Firefox 150、2026-05）

- 入力: 「この部分にバグがある。見つけて testcase を作れ」。対象 file / function は「人間の判断と自動信号の混合」で選ぶ。
- 運用: まず terminal で監視しながら prompt を調整し、動いたら「使い捨て VM に file 別で並列化し、結果を bucket に書く」。
- 判定: 再現 test を走らせて「再現しない推測を捨てる」。dedupe、bug tracking、triage、fix は既存 pipeline。
- 規模: 271 件修正。「100 人以上がコードを書いた」。費用の記述無し。

### Google Mantis（2026-09、Apache-2.0）

- 19 の skill（history、structural-index、threat-model、plan、researcher、critic、dedupe、reproduce、chain、patch、calibrate、reflect、advise 等）と ADK reference harness（`workflow.json`、`run.sh`）。
- 再現は 3 Tier。「Tier 1 / 2 は決して `reproduced` を出さない」「Tier 3（隔離 sandbox で公開 API 経由）だけが権威ある verdict」。負の結果には「sink に届いた証拠」を要求。setup 失敗は `not_attempted` で「負の判定ではなく retry 対象」。
- finding ごとの JSON に `repro_status`、`repro_snapshot_id`、`history` 配列。`snapshot_pinned` のとき CODE_ROOT に書かない。Tier 3 の attempt 上限 6。
- 「全 Finding は報告前に security expert が手で検証せよ」「未検証の AI 報告を OSS maintainer に大量送付するな」「再現失敗は偽陽性の証明ではない」。
- 自己申告: 「demonstration purposes only」「not intended for production」。

### XBOW（Black Hat USA 2025、2026-03 Assessment Guidance）

- 永続 coordinator が多数の短命 agent を指揮。各 agent は fresh context と狭い目的。
- validator は非 AI。flag / canary を攻撃者の届かない場所（filesystem、DB、admin page）に置き、回収を証明にする。validator の分類に「対象の協力が要るもの（user-to-user、admin canary）」と「要らないもの（`/flag.txt`）」がある。
- 「no false positives」は validator を通ったもののみを指す。

### OpenAI Aardvark（2025-10、private beta）

- repository 全体から threat model → commit 単位で照合 → 隔離 sandbox で exploit を試して確認 → Codex が patch を付ける → 人間 review。fuzzing や SCA は使わない。

## 3. 本設計が公開事例より厚い部分と、その理由の検討

### 3.1 候補の救済と台帳の分岐（ADR 0018、0023、`child-report-recovered` 等）

公開事例は「schema を外れた出力」を設計課題にしていない。Cloudflare は agent 自身に schema エラーを直させ、Anthropic は最終 agent に読ませる。本設計では `candidate-held` / `candidate-normalized` / `candidate-rejected` / `child-report-recovered` / `discovery-report-recovered` の 5 event と ADR 2 本がある。

理由は PILOT で「16 run 中 7 run が schema 失敗」、`wp2shell-bounty-v1` で「schema 棄却 3 件」と、Codex `multi_agent` の子スレッド超過で Root 報告が消える（#121）こと。つまり**上流（Codex CLI の multi_agent と手書き契約）の不安定さを、下流の記録で吸収している**。上流を単純にすれば（単独 agent の fan-out、契約は Harness 生成の 1 種）、この 5 event のうち必要なのは `finding-recorded` と `candidate-rejected` の 2 つになる。

### 3.2 評価モジュールと prompt の版管理（ADR 0013、0017、`evaluation/`）

`evaluation/` は盲検 rubric、区間、Answer Key registry を持つ（446 行）。prompt は 20 版（`short-objective-managed-v1〜v5`、`verifier-v1〜v6`、`wp2shell-*` 6 版等）で、A/B arm と digest pin を台帳に残す。

公開事例はどこも ablation を論文形式でやっていない。Mozilla は「terminal で見ながら prompt を調整」、Anthropic は「1 段落」。本設計の DESIGN-EVIDENCE §9 も「5/5 と 3/5 の区間は重なる」「9 件では大きな差しか検出できない」と認めている。**検出力が無いと自分で書いた比較装置を維持している**。SPEC §10 は既に「held-out は既定にしない」「比較が必要になった時だけ事前登録」と後退しており、コードだけが残っている。

### 3.3 review モジュール（824 行）

scope 評価、Draft の版、External Action Authorization、Submission Candidate、ReviewDecision を型で持つ。提出は 0 件。Mantis は「security expert が手で」の 1 文、Cloudflare は既存プロセスへ流す。不変条件 6〜7（人間の判断点 2 つ、Harness は送信しない）は正しいが、**それを守るのに型付き承認ワークフローは要らない**。最初の数件は、再現パッケージを人間が開き、Markdown のチェックリストに判断を書き、台帳に `review-decided` を 1 件足せば足りる。

### 3.4 profile 分離（ADR 0011）

汎用 8 モジュールと `profiles/wordpress/` の分離は、2 つ目の profile まで汎用化しないと自ら書いている。にもかかわらず、`selection` / `snapshot` / `lab` / `verification` は現時点で WordPress 用の実装しか無く、インターフェースの層が 1 枚増えているだけ。公開事例で複数言語に跨るのは Mantis だけで、Mantis はそもそも skill（Markdown）であり、型の層を持たない。収益目標が WordPress 限定である限り、この層は読む人の負担にしかならない。

### 3.5 二段構え + Harness 継続（ADR 0025）

一段目 30 分、二段目 Root＋3 で 90 分、途中で Harness が「続行」を差し込む。Cloudflare の Gapfill（触ったが浅い領域を再 queue）と同じ目的だが、Cloudflare は「狭い agent を多数」の上に乗せている。本設計は逐次 1 Trial の上に乗せているので、継続は「同じ 1 agent に長く働かせる」手段になる。Anthropic / Mozilla / Cloudflare の経験則は「長い 1 agent は context 上限と compaction で前の Finding を失う」であり、方向が逆。

### 3.6 Root＋3 を Codex CLI の `multi_agent` に委ねること

`codex-native-agent-runtime.ts` は 1,311 行で、`multi_agent` / `agents.max_threads=3` の挙動（スレッド再利用、子超過、receipt の欠落）に依存する。公開事例で「プロバイダの multi-agent 機能に分担を任せた」例は無い。Anthropic は file 別に自分で分け、Cloudflare は task queue を自分で持ち、XBOW は coordinator を自作している。**分担を Harness が持てば、Root＋3 の黒箱と、それに起因する ADR 0018 / #121 / `child-report-recovered` が消える。**

## 4. 公開事例より薄い部分

1. **並列度と対象数**。収益の式は「月に回せる対象数 × 当たり率」であり、対象数の項は並列度で決まる。現状は対象 1 件に 1 Trial を逐次、約 10 Trial で 0 件。Anthropic は 1,000 run、Cloudflare は約 50 並列。本設計で 1 Trial 入力約 5.2M token（cache 95%）なら、購読の 5 時間窓と並列 Trial の関係（未確認、完成度レビュー §5）を測るのが先。
2. **自分の Finding の dedupe**。同じ対象で複数 run を回す前提なら、Cloudflare / Mantis が持つ「同根を 1 件に畳む」段が要る。Wordfence mirror 照合は外部重複であり、別物。
3. **入口の分割**。Anthropic の「file を 1〜5 で順位付けして agent に配る」、Mozilla の「人間の判断と自動信号で target file を選ぶ」に相当するのは `entry-points.ts` の索引だが、索引は Root に丸ごと渡される（#123 で既定化）。索引を slice して独立 agent に配る方が公開事例に近い。

## 5. 整理案（削る、凍結する、残す）

以下は提案であり、所有者が選んだものだけを Issue にする。

### 残す（公開事例と同等で、WordPress では ASan の代わり）

- 不変条件 1〜8。gVisor、broker、RO source、Snapshot digest、追記台帳、Private Evidence。
- 8 分類の判定器、nonce canary、HTTP 捕捉、`incomplete` の理由コード、修正版での負の対照。
- 独立 Verifier（Cloudflare Validate と同じ役割）。
- 再現パッケージ（Patchstack の提出要件に直結）。

### 凍結する（コードは残すが、成果が出るまで触らない。CI と文書から外す）

- `evaluation/` の盲検 rubric、区間、Answer Key。SPEC §10 の「比較が必要になった時だけ」を文字どおりにする。
- prompt の比較 arm（`wp2shell-*` 6 版、`short-objective-managed-v1〜v3`、`verifier-v1〜v5`）。digest pin は再現用に残し、新しい比較は始めない。
- review の Draft 版管理、External Action Authorization、Submission Candidate の型。最初の提出まで Markdown チェックリストで代替する。

### 置き換える（上流を単純にして下流を減らす）

- Root＋3（Codex `multi_agent`）を、**Harness が入口索引を slice して配る単独 agent の fan-out** に置き換える。1 対象 = N 個の独立 run（N は購読の窓から決める）。各 run は同じ Snapshot、同じ Lab、別 slice。これは Anthropic の file 別、Mozilla の VM 別、Cloudflare の task 別と同型。
  - 消えるもの: `multi_agent` 依存、子超過（#121）、`child-report-recovered` / `discovery-report-recovered`、Root 最終 JSON の整形失敗、ADR 0025 の継続差し込み（slice を細かくすれば「未処理入口」は run の分割で解ける）。
  - 増えるもの: 自分の Finding 同士の dedupe（同根判定）1 段。
- 候補の救済 5 event を `finding-recorded` / `candidate-rejected` の 2 つに戻す。契約は Harness 生成の 1 種（ADR 0019）だけにし、手書き契約の prompt は使わない。

### 削らない方がよいもの（削ると不変条件を破る）

- 認証ブローカー。1,800 行は重いが、攻撃者制御のコードと購読認証情報が同じ sandbox にある以上、Anthropic の「Internet 隔離」と同じ水準を保つ唯一の手段。軽くする余地（squid 等の既製 allowlist proxy + 短命 token）はあるが、別の問いにする。

## 6. 測ってから決めること

| 問い | 測り方 | 判断 |
| --- | --- | --- |
| 購読の 5 時間窓で何 run 並列に回せるか | 同じ対象で 2、4、8 並列を各 1 回。rate limit 到達と wall | N を決める。fan-out 置き換えの前提 |
| fan-out は Root＋3 より候補が増えるか | TP 3.2.6 / 3.3.1 で「Root＋3 ×1」と「slice 別単独 ×4」を同じ総予算で各 3 組（#128 と同じ） | 置き換えの可否 |
| 同根 dedupe は何件畳むか | fan-out の Finding を file + function + 分類で機械集約し、人間が 1 回点検 | dedupe の実装の深さ |
| 凍結で `pnpm check` と文書は何行減るか | 凍結対象を `tsconfig` の exclude と README から外して計測 | 読む負担の減少を数字で残す |

## 7. 今回確認していないこと

- 各社の harness の内部コード。Cloudflare / Mozilla / Anthropic は blog の記述のみ。Mantis は README と `mantis-reproduce/SKILL.md` のみで、`reference/workflow.json` は読んでいない。
- 本設計の実機挙動（runsc、Codex multi_agent のスレッド再利用、購読の窓）。
- 「作り込みすぎ」の反対側、すなわち公開事例が隠している部分（Mozilla の「100 人以上」の pipeline の中身、XBOW の coordinator）。公開されている分だけで比べている。

## 出典（2026-10-11 取得）

- Anthropic, Claude Mythos Preview's cybersecurity capabilities: https://www.anthropic.com/research/mythos-preview
- Cloudflare, Project Glasswing: what Mythos showed us: https://blog.cloudflare.com/cyber-frontier-models/
- Mozilla Hacks, Behind the Scenes Hardening Firefox with Claude Mythos Preview: https://hacks.mozilla.org/2026/05/behind-the-scenes-hardening-firefox/
- google/mantis README: https://github.com/google/mantis
- google/mantis `mantis-reproduce/SKILL.md`: https://github.com/google/mantis/blob/main/mantis-reproduce/SKILL.md
- Google Cloud blog, Getting started with the Mantis harness: https://cloud.google.com/blog/products/identity-security/getting-started-with-the-mantis-harness-to-find-and-fix-bugs
- XBOW, Introducing Assessment Guidance（2026-03-12）: https://xbow.com/blog/introducing-assessment-guidance
- Dolan-Gavitt, AI Agents for Offsec with Zero False Positives（Black Hat USA 2025）: https://i.blackhat.com/BH-USA-25/Presentations/US-25-Dolan-Gavitt-AI-Agents-for-Offsec-with-Zero-False-Positives-Thursday.pdf
- OpenAI, Introducing Aardvark: https://openai.com/index/introducing-aardvark
- 本リポジトリ: `docs/DESIGN-EVIDENCE.md`、`docs/reviews/2026-10-11-harness-completeness-review.md`、`docs/PILOT-2026-10-10.md`
