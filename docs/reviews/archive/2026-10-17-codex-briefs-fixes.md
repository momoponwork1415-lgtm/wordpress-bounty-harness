# Codex brief 4 本: wall 修正、検証の前提分類、探索深度の記録、探索だけの mode（2026-10-17）

所有者が Codex に貼る用。1 brief = 1 worktree = 1 PR。順番は A → D → B → C。v6 の組み立ては別 brief（[2026-10-17-codex-brief-prompt-v6.md](2026-10-17-codex-brief-prompt-v6.md)）。本番 runner は停止中で、どの brief も `~/.local/state/` と本番 checkout に触れない。PR 本文は日本語 5 項目（問い、変えたこと、変えなかったこと、測った数字、消し方）。`pnpm check` を通す。commit は repo の identity（Codex）で行う。

worktree は用意済み（いずれも main d99fc41、依存は入れてある）:

| brief | worktree | branch |
|---|---|---|
| A | `/home/dev/wordpress-bounty-harness-fix312` | `fix/312-wall-enforcement` |
| D | `/home/dev/wordpress-bounty-harness-explore-only` | `feat/297-explore-only` |
| B | `/home/dev/wordpress-bounty-harness-verify-precondition` | `feat/precondition-class` |
| C | `/home/dev/wordpress-bounty-harness-depth-record` | `feat/275-depth-record` |
| v6 | `/home/dev/wordpress-bounty-harness-v6` | `feat/prompt-v6-thorough-search` |

---

## A. #312 探索 run が wall を越えて止まり続ける

### 貼り付け用

あなたは `wordpress-bounty-harness` の worktree にいる。Issue #312 を読む。本番で explore run 2 件が `runWallTimeMinutes=60` を越えて 5 時間 49 分生き続け、台帳に event が出なかった。agent コンテナは provider との websocket 接続で 426 を受けた後、無出力のまま待ち続けていた。runner プロセスは `docker run` 子プロセス 2 つを抱えて生存し、SIGTERM で止まらず SIGKILL が必要だった。

調べる場所:
- `src/infrastructure/native-model-process.ts`: `timeoutMs` で SIGTERM → SIGKILL を process tree に送る。`docker run` の client を殺してもコンテナは dockerd 側で動き続ける。
- `src/cli/wordpress-host.ts` 150〜170 行と 265 行: `runDocker` に `(runWallTimeMinutes) × 60_000` を渡す。
- `src/discovery/provider-credential-egress-broker.ts` 495〜530 行: broker 用の `runDocker` wrapper。explore run の経路でどの `timeoutMs` が実際に使われるかを追う。
- `src/discovery/codex-gvisor-sandbox.ts`: `GvisorCodexSandbox` の `timeoutMs` と、協調 run（Root＋子）の docker 呼び出し。`docker wait` / `docker exec` のように timeout を受けない呼び出しが無いか。
- `src/discovery/campaign.ts` 520〜600 行: `executor.execute` を await する箇所。外側の timer は無い。

やること:
1. 再現テスト: 終わらない `docker run` を模した `runDocker` を注入し、`timeoutMs` 経過後に (a) client process が終了し、(b) コンテナ名で `docker stop` が呼ばれ、(c) run の receipt が `terminal: "incomplete"` と wall の reason（既存の reason 名に合わせる）になることを assert する。現状で落ちるテストを先に書く。
2. 修正: sandbox が起動した全コンテナ（agent、broker。Lab は別）を名前で記録し、wall 到達時に `docker stop -t 10` → 必要なら `docker kill` を呼ぶ。client process の kill だけに頼らない。`docker stop` 自体にも短い timeout を置く。
3. 台帳: wall 到達は ADR 0029 どおり理由付き `incomplete` で `discovery-run-finished` を書き、Lab と broker の片付けに進む。既存の `recoverChildAgentReports` は走らせる（子の成果は残す）。
4. runner の SIGTERM: `continuous run` が SIGTERM を受けたら、進行中の run に wall と同じ停止を掛けてから `stopped reason=operator` を書いて終了する。SIGKILL が要らないこと。
5. broker の log: broker コンテナが 0 行だった。接続エラーと upstream の status を stderr に 1 行ずつ出す（payload と token は出さない）。
6. `docs/OPERATIONS.md` の該当節に「wall 到達時の挙動」と「SIGTERM で止まる」を 2 行足す。

測った数字（PR に書く）: テストで wall 到達から全コンテナ停止までの秒数、`pnpm check` の結果。本番再現は runner 停止中なのでしない。

---

## D. #297 探索だけの mode（Lab なし）と Finding 単位の検証

### 背景

所有者の方針（2026-10-18）: 「各 run に Lab を付属する必要はない。探索側を複数回して、検証側は Finding を 1 個ずつ検証でもいい。探索だけ回しておくでもいい」。本番 130 枠のうち 15 枠が探索用 Lab の供給失敗で消え（依存 plugin 不足 12、外部 API 1、plugin 自身の fatal 1、他 1）、依存 plugin を持つ対象は探索自体ができなかった。検証側には `lab up --for-review --campaign <id> --finding <id>` と有界の再検証 queue（#209、#210）が既にある。

### 貼り付け用

あなたは `wordpress-bounty-harness` の worktree にいる。Issue #297、ADR 0029、ADR 0026、`docs/OPERATIONS.md` を読む。

やること:
1. campaign.json に `discovery.lab: "attached" | "none"` を足す（既定は `attached` のまま。切替は所有者が campaign.json を変える PR で行う）。`none` のとき `campaign run` と `continuous run` は探索用 Lab を供給せず、Snapshot と source、trust 境界、Programme Boundary、入口索引だけで Trial を起動する。`lab-provisioned` event は書かない。
2. agent に渡る節: Lab なしのとき、Harness 生成の Lab 節（endpoint、attacker account）を出さず、代わりに「この Trial に Lab は無い。実行の確認は検証側で行う」の 1 文を出す。この 1 文は agent に渡る文章なので、全文と日本語訳を PR 本文に貼る。prompt 本文（v5 / v6）は変えない。v5 本文の「disposable Lab」の語は v6 の対照表（#310）で扱う。
3. 検証の独立経路: `verify next --campaign <id>` を足し、review queue と再検証 queue から Finding を 1 件取り、その Finding のためだけに Lab を立て、Verifier と判定器を回し、片付ける。`continuous run` に `--verify-concurrency <n>`（既定 1）を足し、探索 batch と並行して 1 件ずつ消化する。Lab の同時数は `resources.maxConcurrentTargets` と別に数える。
4. 同じ Snapshot への複数回探索: `campaign run --repeat <n>`（既定 1）で、同じ Snapshot に独立した Trial を n 回起動し、それぞれを別の `trialId` で記録する。本番の既定は 1 のまま（ADR 0029）。開発セットの 3 回反復がこれで 1 コマンドになる。
5. 台帳と funnel: Lab なしの Trial を `discovery-run-started` に `labAttached: false` で記録し、funnel で Lab あり／なしを分けて数える（比較分母を混ぜない）。探索側の `lab-failed` は 0 になるので、検証側の Lab 失敗を `verification-lab-failed` として別に数える。
6. 選定: Lab なしのとき #308 の `lab-provision-failed` 除外は探索側では効かなくなる。検証側の Lab 失敗を同じ reason で除外に写すかは、Issue #309 と合わせて別 PR にする。この PR では触らない。
7. テスト: `lab: "none"` で Trial が Lab なしで開始・完了すること、`verify next` が Finding 1 件に Lab を立てて判定器を回し片付けること、`--repeat 3` が 3 つの trialId を作ること、funnel が Lab あり／なしを分けること。
8. 文書: `docs/OPERATIONS.md` に「探索だけ回す」「検証を 1 件ずつ回す」の手順を 1 節。ADR 0029 に「2026-10-18: 探索用 Lab は任意。検証は Finding 単位」と 3 行追記（所有者の `owner-approved`）。SPEC 第 6 節の「Lab」を「Lab（任意）」に。

変えないこと: 検証は Lab で判定器が canary を回収する形のまま（SPEC 不変条件 3）。Verifier にブラウザや管理者セッションを渡さない（ADR 0026）。

測った数字: 開発セット 1 対象（TranslatePress 3.2.6）で `lab: "none"` の Trial 1 回と `verify next` 1 回を回し、ATO の Finding が runtime-confirmed になること。起動時間（Lab あり／なし）の差。

---

## B. 検証の前提を「既定／一般的な利用／管理者の特別な設定」に分けて出口を決める

### 背景

本番の対象範囲内 Finding 4 件は全て `incomplete(precondition)`。前提は「管理者が特定の block / slider を公開している」。受理側はこの種類を却下する（Patchstack 規約 4.1「管理者が設定しないと存在しない問題」、Wordfence「管理者の誤設定が前提は不可」、`src/profiles/wordpress/policy/programme-scope.md`）。一方「投稿に block を置く」「slider を 1 つ公開する」のような一般的な利用は Lab に作って判定器を回せる（ADR 0026、#244）。今の Verifier は `configurationPrecondition` を `nextWordPressScenario` に渡し、catalogue に無ければ `incomplete(precondition)` で止める（`src/profiles/wordpress/verification/codex-verifier.ts` 329 行と 555 行）。

### 貼り付け用

あなたは `wordpress-bounty-harness` の worktree にいる。`docs/reviews/2026-10-17-external-harness-practices.md` 第 2 節と第 5 節 1、`docs/adr/0026-*.md`、Issue #244 と #213 を読む。

やること:
1. 型: `src/profiles/wordpress/verification/` に `preconditionClass` を足す。値は `default`（既定設定で成立）、`common-usage`（Harness の型付き手順で作れる一般的な利用。例: 公開投稿に block を置く、widget を置く、公開 slider を 1 つ作る）、`admin-configuration`（管理者が特定の値や非既定の設定を選ぶことが前提）、`unknown`。
2. 判定の入力: Finding の `configurationPrecondition`（`src/profiles/wordpress/discovery/finding.ts` 66 行）と Verifier attachment の `precondition`。分類は Harness 所有の決定論的な規則で行う（scenario catalogue との照合、既定値との照合）。LLM に判定させない。規則で決められなければ `unknown`。
3. 出口:
   - `admin-configuration` → 検証を回さず、台帳に `finding-parked` を `reason: "admin-configuration-precondition"` で書く（`src/ledger/index.ts` 312 行の reason enum を拡張、既存の `outside-programme-boundary` は残す）。review queue に入れない。`review parked` で一覧できる。Private Evidence は残す。
   - `common-usage` → 対応する scenario id を `nextScenarioId` に入れて既存の再検証 queue（#209 の有界再検証）へ。catalogue に無い一般的な利用は、Issue #213 の集計対象として理由コードを残す。
   - `default` → 従来どおり検証。
   - `unknown` → 従来どおり `incomplete(precondition)` で review queue。
4. 集計: `review` の出力に preconditionClass 別の件数を足す（人間向け機能は増やさない。CLI は AI 用、ADR 0032 Q27）。
5. テスト: 本番 4 件に相当する合成 Finding（block の「パスワード保護」設定、slider の特定 placeholder 設定）が `admin-configuration` に落ちること、「公開投稿に block を置く」が `common-usage` になること、既存の TranslatePress 系 Finding が `default` のままであること。
6. 文書: `docs/SPEC.md` 第 7 節に 1 段、`docs/OPERATIONS.md` に `review parked` の reason が 2 種類になったことを書く。ADR は書かない（判定器の集合は変えない）。

変えないこと: Verifier の prompt 本文（`verifier-v7.md`）。Verifier に渡す節の雛形を変える必要が出たら、変更後の全文と日本語訳を PR 本文に貼り、所有者の読了を待つ（DEVELOPMENT.md 第 5 節）。

測った数字: 本番台帳の Finding 4 件と parked 42 件を新しい分類に通した件数（`--state` を読み取り専用で指す。書き込みはしない）。

---

## C. #275 探索深度の typed record を Root の正常完了に要求する

### 背景

本番 111 Trial の Root wall 中央値 7 分、60 分到達 0。Lead 403 件のうち 224 件が「入口（producer）未発見」で止まっている（#314）。浅い終了が「候補 0 件の正常完了」として数えられており、探索の深さを測る物差しが無い。Root には `coverage` 種類の attachment があり（`src/discovery/provider-research-report.ts` の `kindSchema`）、入口索引は Harness が生成して渡している（`src/profiles/wordpress/discovery/entry-points.ts`）。

### 貼り付け用

あなたは `wordpress-bounty-harness` の worktree にいる。Issue #275、ADR 0019（出力契約は Harness が schema から生成）、ADR 0029 を読む。

やること:
1. schema: Root の最終報告に `coverage` record を要求する zod schema を `src/profiles/wordpress/discovery/` に置く。内容は、入口索引の各項目 id に対する `observed` / `blocked` / `unvisited` と、`blocked` の短い理由コード。索引の `incomplete` フラグも写す。自由文は入れない。
2. 生成節: ADR 0019 どおり、この schema から Harness が出力契約の節を生成する。節の雛形は agent に渡る文章なので、変更後の全文と日本語訳を PR 本文に貼る。prompt 本文（v5 / v6）は変えない。
3. 判定: `coverage` が無い、schema を満たさない、`unvisited` が索引の 20% 超（閾値は campaign.json に `coverage.maxUnvisitedRatio` として置き、既定 0.2）の正常終了は `incomplete(depth)` として `discovery-run-finished` に書く。候補 0 件の正常完了に数えない。既存の reason enum に `depth` を足し、funnel の集計で `incomplete(depth)` を別に出す。
4. 子 agent の報告はこの要求の対象外（`codex-native-agent-runtime.ts` 45 行のとおり子は構造化されない）。Root が子の結果を取り込んで coverage を書く。
5. テスト: coverage 無し → `incomplete(depth)`、全項目 observed/blocked → completed、unvisited 30% → `incomplete(depth)`、索引 `incomplete` のとき閾値を適用しない。
6. 文書: ADR 0029 に「2026-10-17: 深度の記録を正常完了の条件にする。網羅の要求ではなく記録の要求」と 3 行追記（ADR 変更なので所有者の `owner-approved`）。`docs/OPERATIONS.md` の funnel 説明に `incomplete(depth)` を足す。

変えないこと: Root の分担の自律、最低時間なし、wall 60 分。

測った数字: 開発セット 1 対象（TranslatePress 3.2.6）で 1 Trial 回し、coverage record が書かれて completed になること。本番の過去 Trial は coverage が無いので再分類しない（台帳は追記専用）。

---

## 所有者向けの注意

- A は policy / prompt / ADR を触らないので AI がラベルを付けて merge できる。D は ADR 0029 追記と agent に渡る 1 文を含むので所有者が読む。B は `docs/SPEC.md` を触るので所有者の `owner-approved`。C は ADR 0029 の追記と出力契約の節を含むので所有者が全文を読む。
- 4 本とも merge したら、v6 の測定（#310 第 6 節）と合わせて prod checkout を作り直す。それまで本番は止めたまま。
- #295（履歴 prior）と #314（Lead 追跡実験）は Issue の設計のとおり。brief はこの文書に含めない。
