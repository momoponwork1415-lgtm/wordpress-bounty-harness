# 用語集

[SPEC.md](docs/SPEC.md) 第 15 節と同じ語は SPEC が正である。ここには、AGENTS.md と運用の文書が引く語と、文書の表記の決め事を置く。

## 表記の決め事

文書と Issue は、日本の技術者が書く自然な日本語で書く（所有者決定 2026-10-19）。

### 英語のまま残す語

- この用語集と SPEC 第 15 節の固有名: Harness、Lab、Finding、Lead、Trial、Campaign、Target Snapshot、Discovery run、VerificationResult、Reproduction Package、Submission Candidate、Private Evidence、Programme Boundary、Verifier、Root、canary、Answer Key
- 製品・技術名: WordPress、Wordfence、Patchstack、gVisor、runsc、Docker、Codex、provider、broker、slug、CVE、JSON、SQLite
- バッククォートの中: CLI 名、イベント名、状態値、フィールド名
- digest: スキーマのフィールド名と対で使うので、地の文でも digest と書く

### 日本語に戻す語（地の文）

- ファイルとコード: file → ファイル、path → パス、test → テスト、code → コード、source → ソース、module → モジュール、schema → スキーマ、config → 設定
- エージェントへの入力: prompt → プロンプト、skill → スキル、recipe → 手順、handoff → 受け渡し、agent → エージェント、subagent → 子
- 実行環境: host → ホスト、container → コンテナ、sandbox → サンドボックス、image → イメージ、session → セッション、runner → ランナー、mode → モード、preflight → 事前点検
- 記録と運用: event → イベント、batch → バッチ、queue → 列（レビュー列、検証列。SPEC 第 8 節の語）、mirror → ミラー、token → トークン、payload → ペイロード、policy → 方針、label → ラベル、comment → コメント、branch → ブランチ、merge → マージ
- 選定と範囲: scope → 対象範囲、cascade → 段、plugin → プラグイン、install → インストール数、profile → プロファイル、scenario → シナリオ
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
| Trial | Campaign 内の独立した探索試行。現行の探索では、Root と子（4 体まで）が 1 つの Trial を構成する。 |
| Root / 子 | 協調 Trial の親エージェントが Root、Root が起動する subagent が子。子は 4 体まで（SPEC 第 4 節、ADR 0029）。 |
| 区画分配型（partitioned） | Root を置かず、Harness が役ごとに AI を起こす Trial。列挙役 1 体が入口と出口の一覧（inventory）と区画の案を出し、Harness が形と上限を検査して、区画ごとに追跡役 1 体を起こす。`discovery.mode: "partitioned"`（ADR 0042）。 |
| 列挙役（enumerator） | 区画分配型で対象ごとに 1 体。サンドボックスに置かれた列挙の script を自分で走らせて点検し、script が拾えない行を足し、行 id 付きの inventory と区画の案を返す。定義は `prompts/agents/enumerator-v<n>.md`。 |
| 追跡役（tracer） | 区画分配型で区画ごとに 1 体。自分の区画の行から入口と出口をたどり、契約 v4（solo）の形で Finding / Lead を返す。子を起こさない。定義は `prompts/agents/tracer-v<n>.md`。 |
| 区画（partition） | 列挙役が機能のまとまりで切った inventory の行の集合。Harness は schema、重複、上限（1 区画の行数、区画数）だけを検査し、超えた案は切り分けずに差し戻す（`maxResubmits` まで）。`partition-assigned` に行数と digest が残り、Finding / Lead に `partition` が付く。 |
| Discovery run | モデル実行の記録単位。Trial の中で何回モデルを呼んだかと区別する。 |
| Finding | 攻撃者の立場、入口から影響までのソース上の経路、観測を備えた未確認の主張。 |
| Lead | ソースに根拠があり、影響までに未解決の辺が残る手がかり。Finding でも検証結果でもない。 |
| canary | 判定器があった時期に Lab へ播種した nonce 付きの値。既存の `runtime-confirmed` は canary の回収で出た。2026-10-25 以降の新しい検証は canary を播種せず、確定の根拠は人間の `review observe` の match と `review decide --reproduced match` だけである（SPEC 第 2 節の不変条件 3、ADR 0040）。 |
| VerificationResult | 新しい Lab での検証 attempt の結果。2026-10-25 以降の新しい検証は `incomplete` だけを出し、Harness の捕捉が残ったものは `incomplete(awaiting-human-observation)` として人間の観測を待つ。判定器があった時期の `runtime-confirmed` / `contradicted` は記録として読み続ける（ADR 0040）。 |
| Reproduction Package | 人間が Lab を再構築し、遠隔攻撃者の手順で同じ結果を確かめるための証拠と手順。 |
| Submission Candidate | 最新版で確認済みの脆弱性、提出先、文案の版を結び付けたレビュー対象。 |
| Private Evidence | HTTP 記録、ペイロード、画像、認証情報、未公開の発見を置く Git 外の保管先。 |
| Programme Boundary | Harness が探索に付ける節で、報奨プログラムの対象内とする影響を書く。外にある impact の Finding は `finding-parked` に回す（SPEC 第 8a 節・第 8b 節）。 |
| レビュー列 | 人間のレビューを待つ Finding の列（review queue）。対象範囲内の Finding は、検証の結果に関係なく全件が出る（SPEC 第 8 節、ADR 0031）。 |
| 保留候補（candidate-held） | 探索 run の最終 JSON から抽出したが、正規化後も出力契約を通らない Finding / Lead 候補。分類と issue path だけを台帳に残し、本文は Private Evidence に置く。Finding でも検証対象でもない（ADR 0018）。 |
| finding-parked | Programme Boundary 外の impact と、判別の付きにくい 5 分類の Finding。エージェントが申告欄で管理者の脆弱な設定、攻撃者が書けないデータ（ベンダー、サイト自身、管理者だけが書く）、時間窓か競合に頼る発火を選んだ Finding も含む（reason `declared-precondition`、ADR 0038 追記 13）。台帳と Private Evidence に残し、検証・レビュー列・funnel の raw に入れない。一覧は `review parked` で見る（ADR 0032）。 |
| 段（cascade） | 選定の主帯（インストール数 100k–1M）が尽きたときだけ、順に試す段。順は 50k → 30k → ≥1M かつ paying class 記録 ≥2。`target-selected` に `cascadeStep` が残る（ADR 0037）。 |
| 再開区間（segment） | 止まった Root のスレッド（理由は問わない。`completed` は除く）を、操作者が `campaign resume` で新しいサンドボックスに再開した続き。同じ Trial に数え、`resumesRun` / `resumeSegment` が記録される（ADR 0036）。 |
| 中断した run（interrupted） | ホストの電源断などで持ち主のプロセスが死に、終了イベントが無いまま残った run。`campaign resume` が残骸を封じて `reason: interrupted` の終了イベントを追記してから再開する。死んだかどうかは、サンドボックスが書く印の boot id と pid で決める（ADR 0036 の 2026-10-19 追記 2）。再起動した `continuous run` も、新しい Trial より先に同じ経路で自動再開する（追記 3）。 |
| 受け渡し（handoff） | `verify next --handoff <dir>` で Harness が Finding 単位の Lab を立て、スキル `wbh-verify` が前提作りと再現を行う検証の経路。Harness は捕捉と Lab browser の記録を残すだけで成立を判定せず、確定は人間が review Lab で記録する（ADR 0035、ADR 0040）。 |
| 通常機能シナリオ | プロファイルが版と digest で管理する、対象プラグインの通常の利用状態の定義。Lab Setup に含め、Finding の前提と照合する。権限の付与や危険設定は含まない（ADR 0020）。 |
