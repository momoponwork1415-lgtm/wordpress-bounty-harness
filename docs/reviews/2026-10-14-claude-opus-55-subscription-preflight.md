# Claude Opus 5.5 購読認証と並列 Trial の事前確認（2026-10-14）

## 問い

所有者の Claude 購読を Agent SDK の協調 Trial に利用し、実 OAuth token を探索 sandbox に渡さずに Opus 5.5 の対象 Trial を走らせられるか。今回の負荷試験では Opus 2対象と Codex 2対象の合計4対象を上限候補とする。

## 一次資料との照合

- [Claude Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) は 2026-10-07 更新で、Agent SDK と `claude -p` を引き続き購読上限で利用できると明記する。
- [Claude Code 認証資料](https://code.claude.com/docs/en/iam) は `claude setup-token` でブラウザ承認を経て1年の購読 token を発行し、`CLAUDE_CODE_OAUTH_TOKEN` を SDK と script で使えると説明する。`ANTHROPIC_AUTH_TOKEN` は gateway 用 Bearer credential で、保存済み購読 login より優先される。
- [gateway 資料](https://code.claude.com/docs/en/llm-gateway) は `ANTHROPIC_BASE_URL` だけなら保存済み購読 login が有効だが、gateway credential を置くとその login は送られず、購読上限も使われないと説明する。購読 OAuth を upstream に送る gateway は `anthropic-beta` の OAuth capability を維持する必要がある。[互換性資料](https://code.claude.com/docs/en/llm-gateway-protocol) は `/v1/messages?beta=true`、`anthropic-version` と `anthropic-beta` の転送、利用上限と retry header の転送を示す。
- [model 設定資料](https://code.claude.com/docs/en/model-config) は Opus 5.5 に Claude Code 2.1.280 以降を要求する。旧 image の 2.1.278 は要求 model を認識しなかった。
- [法務資料](https://code.claude.com/docs/en/legal-and-compliance) は、第三者の開発者が自社アプリに claude.ai login を提供したり、利用者の購読資格を代理で経由させたり、資格情報を収集・保存・中継したりすることを制限する。今回の経路は所有者本人のローカル Harness と本人の token に限定する。第三者向け認証機能として提供する判断は含めない。

## 実装と非秘密の試験

- broker は `anthropic-subscription-token` を host 所有・0600 の Git 外ファイルから読む。実 token は gVisor broker sidecar の secret mount にだけ置き、探索 sandbox は Trial 限定 Bearer grant を `ANTHROPIC_AUTH_TOKEN` として受け取る。broker は固定 `api.anthropic.com`、Opus 5.5、期限、要求数、request/response byte 上限を維持する。`oauth-2025-04-20` capability が無い購読要求は送信しない。
- Claude Code 2.1.296 と Agent SDK 0.3.296 の新 image を build し、`runsc` で `claude --version` が 2.1.296 を返すことを確認した。image digest は `sha256:bc75a5852e2507501adadace5aeb80030eed8dff98d6a061c37644b348f17f92`。
- 実 token・対象 source を使わない gVisor 内の内部 network probe で、Claude Code 2.1.296 が Trial 限定の偽 Bearer token を付けて `POST /v1/messages?beta=true` を送り、model `claude-opus-5-5` と `oauth-2025-04-20` を含む `anthropic-beta` を送ることを観測した。偽 upstream は 401 を返した。この probe 単独では実 provider の応答を測っていない。
- 所有者が発行した `setup-token` を本人所有・0600 の Git 外ファイルから broker だけが読み、対象 source を与えない無害な gVisor CLI smoke を2回行った。1回目は upstream への送信前に CLI が終了した。2回目は Opus 5.5 への1要求が成功し、upstream の4xx・5xxは0、CLI は正常終了した。これは認証経路とモデル応答の確認であり、購読への実際の計上、rate limit、対象 Trial の成功を示さない。token の値は記録・表示していない。
- Codex 側から受け取った公開 slug 833件の除外集合を Git 外の Opus 選定方針に置き、独立 state で既定の100,000インストール下限・候補500件を検査した。適格候補は1件だったが、最初の Opus host 設定に WordPress 6.8.3 の core image が残り、宣言された7.1.3と不一致だったため Snapshot 固定は0件で終了した。host image を本番の7.1.3へ揃え、同版の core source を取得できることを確認した。この時点の台帳の `target-selected` は0件。
- 所有者の明示承認後、既定8タグのページ深度を2→5にした新しい Git 外 policy ID・digest で再選定した。100,000インストール下限、候補上限500、作者・既往 slug 除外は維持した。固定可能な新規対象は1件で、当時の自動選定契約が要求する3件に届かず失敗した。その後、所有者が明示した場合だけ `maximumTargets: 1` を許す変更を承認し、通常の3件下限を維持したまま、この1件をSnapshot固定・選定バッチに予約した。Codexの選定対象との重複は0件。
- 833件の除外集合を台帳と照合すると、多数の slug に現行台帳の `target-selected` が見つからなかった。ただし先行監査の776件は、旧Target Snapshot、旧queue、private campaign、研究、archiveなどの保守的な和集合に由来する。全件を「探索完了」とも「未探索」とも扱わず、除外は維持する。現行Codexの追加5件も別の除外集合に反映済み。
- Opus専用の50,000インストール下限を別の Git 外 policy（`wordpress-selection-2026-10-14-opus-55-50k-v6`、digest `sha256:3c9a7ad2b810990c7d1189e92436a4001913b901df283c755d05b42e82bbb708`）で検査した。候補500件のうち固定可能な新規対象は0件で、選定イベントは増えていない。続いて所有者が許可した30,000下限を別policy（`wordpress-selection-2026-10-14-opus-55-30k-v7`、digest `sha256:eb4414f8a6c240043bb9eec500d6fd1e0b75789293b0645c655de0df0795e401`）で検査し、500候補から新規3件のSnapshotを固定した。Codex側の当時の予約839件との重複は0件。3件のslugはGit外に保管し、台帳にはdigest参照のみを残す。30,000下限の対象ではWordfenceの報奨適格性を効果ごとに判断する。
- `pnpm check` は89ファイル・679テストに合格した。追加テストは1件選定の明示設定、通常の3件下限、再訪除外、policy digest 不一致時の停止、campaign batch 結合を検査する。

## 初回実対象 Trial

100,000インストール以上の新規1対象について、同じ選定バッチに結び付けた初回 Trial を起動した。Snapshot固定・Lab供給・discovery run 開始までは成功したが、sandbox は約2.6秒で exit 1となり、`incomplete(sandbox)` で停止した。broker転送は0件、Rootと子の有効な報告は0件。候補0件の正常終了には数えない。診断 artifact は Git 外の Private Evidence に保存した。

Claude Code 2.1.296 が subprocess環境保護のために `bubblewrap` を要求することが原因だった。imageに追加した隔離probeでは、`runsc` 内のmount操作が `Operation not permitted` で失敗した。実購読tokenはhostのbrokerから出していない。所有者がOpusのgVisor内に限り `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` を明示承認したため、その設定を適用した。子プロセスはTrial限定grantを読めるが、実購読tokenは引き続きhost側のbrokerだけが持ち、gVisorとbrokerの宛先・model・期限・要求数・byte数制限は維持する。`pnpm check`（89ファイル・679テスト）と`pnpm build`に合格した。集計と受入条件は [#224](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/224) に記録した。

## 修正後の新規対象 Trial と追加診断

30,000インストール下限の選定バッチから新規1対象を別campaignで実行した。Root＋3子は約14分動作し、brokerはOpus 5.5への143要求を転送して、upstream成功143、4xx・5xx・relay失敗0だった。子3 runは `completed` で、Lead 1件を独立記録した。RootのCLIも正常終了したが、brokerの `unauthorizedRequests: 1` を保守的に `incomplete(policy, broker-grant-unauthorized)` とした。Findingは0件、候補保留1件。Rootの記録上の非cache入力は6,630 token、cache入力は8,875,279 token、出力は102,049 tokenで、子ごとのusageは取得できていない。CLIの成功と有効な子成果を保持しながら、Trial全体を正常0件に数えない。この1要求の発信元は現行の集計だけでは特定できないため、原因を確認するまでは新規Trialを増やさない。Opusが使った探索・brokerコンテナは終了時に削除され、Trial grantは利用できなくなった。以前から存在するCodex側のbrokerコンテナには触れていない。

同じ運用監視で、Trial限定grantが探索コンテナの `docker run` とbrokerの `docker create` の引数に載ることを確認した。実OAuth tokenは引数に出ていない。両起動でDocker子プロセスの環境からgrantを渡し、引数・通常ログから値を除く修正を実装した。関連する6テストと`pnpm check`（89ファイル・679テスト）、`pnpm build`に合格した。この修正は上記の実Trialが終了した後にbuildしたため、そのTrialの実測には含めない。

## 次に残る条件

1. brokerの無認証要求1件を分類し、`incomplete(policy)` の原因を診断する。保留候補とLeadはPrivate Evidenceに維持する。
2. 保守的な既往除外と現行Codex予約を維持する。30,000下限の別cohortと100,000下限のcohortは分母を分け、Programme Boundaryの適格性を効果ごとに照合する。既往slugの新版本を検討するときは旧Snapshotの版、公式stable、source digest、未公開Findingの有無を個別に照合する。
3. broker診断後に残る新規2対象の初回Trialを測る。実測を踏まえ `resources.maxConcurrentTargets: 2` の可否を判断する。`maxConcurrentRuns` は対象間の並列レバーではなく、`memoryBudgetMiB` も全campaignの予約ではない。Opus 2＋Codex 2の同時負荷は外側で監視する。

現在の実対象Trialは2件開始・completed 0件・incomplete 2件。修正後の1件では3子が完了し、Lead 1件が残った。3 Trialの開発ゲートと実効最大並列の判定は未達で、PRはDraftのままにする。
