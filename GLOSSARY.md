# 用語集

[SPEC.md](docs/SPEC.md) 第 15 節と同じ語は SPEC が正である。ここには、AGENTS.md と運用の文書が引く語と、文書の表記の決め事を置く。

## 表記の決め事

文書と Issue は、日本の技術者が書く自然な日本語で書く（所有者決定 2026-10-19）。

### 英語のまま残す語

- この用語集と SPEC 第 15 節の固有名: Harness、Lab、Finding、Lead、Trial、Campaign、Target Snapshot、Discovery run、VerificationResult、Reproduction Package、Submission Candidate、Private Evidence、Programme Boundary、Root
- 製品・技術名: WordPress、Wordfence、Patchstack、gVisor、runsc、Docker、Codex、provider、broker、slug、CVE、JSON、SQLite
- バッククォートの中: CLI 名、イベント名、状態値、フィールド名
- digest: スキーマのフィールド名と対で使うので、地の文でも digest と書く

### 日本語に戻す語（地の文）

- ファイルとコード: file → ファイル、path → パス、test → テスト、code → コード、source → ソース、module → モジュール、schema → スキーマ、config → 設定
- エージェントへの入力: prompt → プロンプト、skill → スキル、recipe → 手順、handoff → 受け渡し、agent → エージェント、subagent → 子
- 実行環境: host → ホスト、container → コンテナ、sandbox → サンドボックス、image → イメージ、session → セッション、runner → ランナー、mode → モード
- 記録と運用: event → イベント、batch → バッチ、queue → 列（レビュー列、検証列。SPEC 第 8 節の語）、mirror → ミラー、token → トークン、payload → ペイロード、policy → 方針、label → ラベル、comment → コメント、branch → ブランチ、merge → マージ
- 選定と範囲: scope → 対象範囲、band → 帯、plugin → プラグイン、install → インストール数、profile → プロファイル
- 時間と再開: wall → 制限時間（上限の意味のとき）、経過時間（観測の意味のとき）、segment → 再開区間
- 人: operator → 操作者、owner → 所有者、admin → 管理者

### 書き方

- バッククォートの中は英語、地の文は日本語で書く。
- 和文と英数字の間には半角スペースを 1 つ入れる。
- 数には助数詞を付ける（ファイル 6 本、Trial 3 回、テスト 20 本）。
- 1 文は 80 字以内を目安にする。
- 責務は「〜を持つ」でなく、「〜が受け持つ」「〜しか持たない」と書く。

## 用語

| 用語 | 意味 |
| --- | --- |
| Harness | 本リポジトリのプログラム。制御だけを受け持ち、探索と検証の中身はプロンプトとスキルに任せる（AGENTS.md「Harness と AI の責務」）。 |
| Target Snapshot | 調べる対象と、必要な依存ソースを版と digest で固定したもの。 |
| Snapshot digest | Target Snapshot を固定した digest。判定は、Finding と検証結果でこれが一致するときだけ行う（SPEC 第 2 節の不変条件 5）。 |
| Campaign | 台帳の `campaignId` の単位。本番では選定バッチ 1 つの探索と記録のまとまりで、Target Snapshot は `maximumTargets` 件まで入る。検証は後から Finding 単位に同じ campaign へ記録する。開発で手動実行するときは 1 対象でもよい。 |
| Trial | Campaign 内の独立した探索試行。Root と子（`discovery.maxChildren` 体まで、既定 4）が 1 つの Trial を構成する。再開した続きも同じ Trial に数える。 |
| Root / 子 | 協調 Trial の親エージェントが Root、Root が起動する subagent が子。同時に生きる子の上限は設定値 `discovery.maxChildren`（1〜8）で、何体使うかは Root が決める（ADR 0029、ADR 0039）。 |
| 探索スキル（discovery skill） | 探索の手順 1 つを書いた `SKILL.md`。campaign 設定 `discovery.skills` で id を名指しすると、Harness が digest を検証してサンドボックスの CLI home に置き、CLI が name と description を Root と子に一覧する。目的文は変えない。registry は `prompts/skills.ts`、本文は `prompts/skills/<id>/SKILL.md`。同じディレクトリの script や参照文も digest で固定して一緒に置く（ADR 0043）。 |
| Discovery run | モデル実行の記録単位。Trial の中で何回モデルを呼んだかと区別する。 |
| Finding | 攻撃者の立場、入口から影響までのソース上の経路、観測を備えた未確認の主張。 |
| Lead | ソースに根拠があり、影響までに未解決の辺が残る手がかり。Finding でも検証結果でもない。`review leads` で人間が全件を見る。 |
| VerificationResult | Lab での検証 attempt の結果。新しい検証は `incomplete` だけを出し、Harness の捕捉が残ったものは `incomplete(awaiting-human-observation)` として人間の観測を待つ（ADR 0040）。 |
| Lab 観測（`review observe`） | 人間が review Lab か検証 Lab で見た結果を `match` / `mismatch` / `unavailable` で記録するもの。`review decide --reproduced match` と揃って初めて確定の根拠になる（不変条件 3）。所有者が会話で結果を明言したときは AI 操作役が所有者の名前で代行記録し、attestation を Private Evidence に残す（ADR 0040 追記 3）。 |
| 保存先の観測器（lookup） | 探索 Lab の制御口の `POST /find`（植えた印がどの table / column / file に入ったか）、`POST /sql`（読み取り専用ユーザーで SELECT 1 文）、`POST /trace`（1 リクエストの plugin 内の関数呼び出し列）。3 つで 1 つの予算 `discovery.lab.maxLookups` を使う。答えは観測で、Harness は読まず判定しない（ADR 0049）。 |
| Reproduction Package | 人間が Lab を再構築し、遠隔攻撃者の手順で同じ結果を確かめるための証拠と手順。 |
| Submission Candidate | 最新版で確認済みの脆弱性、提出先、文案の版を結び付けたレビュー対象。 |
| Private Evidence | HTTP 記録、ペイロード、画像、認証情報、未公開の発見を置く Git 外の保管先。 |
| Programme Boundary | Harness が探索に付ける節で、報奨プログラムの対象内とする影響を書く。外にある impact の Finding は `finding-parked` に回す（SPEC 第 8a 節・第 8b 節）。 |
| レビュー列 | 人間のレビューを待つ Finding の列（review queue）。対象範囲内の Finding は、検証の結果に関係なく全件が出る（SPEC 第 8 節、ADR 0031）。 |
| 保留候補（candidate-held） | 探索 run の最終 JSON から抽出したが、正規化後も出力契約を通らない Finding / Lead 候補。分類と issue path だけを台帳に残し、本文は Private Evidence に置く（ADR 0018）。 |
| finding-parked | Programme Boundary 外の impact と、判別の付きにくい 5 分類の Finding。旧契約の申告欄で管理者の脆弱な設定などを選んだ Finding も含む（reason `declared-precondition`、ADR 0038 追記 13）。台帳と Private Evidence に残し、検証・レビュー列・funnel の raw に入れない。一覧は `review parked` で見る（ADR 0032）。 |
| 帯（`orderingBands`） | 選定の順序でインストール数を区切る境界（既定 100 万 / 10 万 / 1 万）。`install-band-then-published` は高い帯を先に、帯の中は stable 版の公開日が新しい順に並べる（ADR 0037 追記 4）。 |
| 探索済みの印（previously-selected） | 台帳に数えた Trial が同じ版か上位の版を調べていることを示す選定の除外理由。版が上がれば戻す（ADR 0037）。 |
| `countTrialsFrom` | 選定方針 `revisitPolicy` の任意の時刻。それより前に始まった Trial は探索済みに数えない。探索の方法を変えて再開したとき、操作者が再開時刻を入れる（ADR 0037 追記 6）。 |
| 再開区間（segment） | 止まった Root のスレッド（`completed` 以外）を、新しいサンドボックスに再開した続き。同じ Trial に数え、`resumesRun` / `resumeSegment` が記録される（ADR 0036）。 |
| 中断した run（interrupted） | ホストの電源断などで持ち主のプロセスが死に、終了イベントが無いまま残った run。残骸を封じて `reason: interrupted` の終了イベントを追記してから再開する。再起動したランナーも、新しい Trial より先に自動で再開する（ADR 0036 追記 2・3）。 |
| 受け渡し（handoff） | `verify next --handoff <dir>` で Harness が Finding 単位の Lab を立て、スキル `wbh-verify` が前提作りと再現を行う検証の経路。Harness は捕捉と Lab browser の記録を残すだけで成立を判定しない（ADR 0035、ADR 0040）。 |
| 出口の計画（egress plan） | 外部サービス接続が前提の検証で、`verify next --egress-plan <json>` に渡す宛先の一覧。Harness は宛先ごとに中継器を置き、`setup-done` 直後に止めて Lab の中から届かないことを確かめる。公開入口と資格情報は Harness の外（ADR 0046 追記 1）。 |

## 過去の語（台帳の古いイベントを読むときだけ）

| 用語 | 意味 |
| --- | --- |
| 判定器 | 2026-10-25（ADR 0040）まで Harness が持っていた、Lab の観測から `runtime-confirmed` / `contradicted` を機械的に決める部品。削除済み。 |
| canary | 判定器があった時期に Lab へ播種した nonce 付きの値。既存の `runtime-confirmed` は canary の回収で出た。新しい検証は播種しない。 |
| `runtime-confirmed` / `contradicted` | 判定器が出した検証結果。記録として読み続けるが、新しい検証は出さない。 |
| Verifier | 旧 Codex Verifier。検証の手順を実行していたエージェント。2026-10-23 に退役し、検証はスキル `wbh-verify` が受け持つ（ADR 0035）。 |
| 段（cascade） | 旧選定で主帯が尽きたときに試した帯。2026-10-28 に削除し、過去の `target-selected.cascadeStep` だけを読み続ける（ADR 0037）。 |
| 通常機能シナリオ | プロファイルが版と digest で管理していた、対象プラグインの通常の利用状態の定義。#353 で削除し、前提はスキルが Lab の通常機能で作る（ADR 0026 追記）。 |
| Answer Key | 旧評価 CLI が照合に使った既知事例の答え。2026-10-18 に CLI ごと削除した。 |
