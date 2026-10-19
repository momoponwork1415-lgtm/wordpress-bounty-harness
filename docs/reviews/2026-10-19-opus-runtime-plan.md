# Claude Opus の探索・検証 runtime を戻す計画

日付: 2026-10-19。正本ではない。正本は [SPEC](../SPEC.md) と [ADR](../adr/) である。

## 発端

所有者は 2026-10-19 に「opus からの診断も実行できるようにしたい。これも oauth トークンで」と決めた。[PARKING](../PARKING.md) の Claude 系 runtime の行は、この日に再開が決まっている。範囲と条件は次のとおり。

- 範囲は探索（Trial）と検証の両方とする。
- 対象ごとに振り分ける。1 つの対象は Codex（gpt-6-sol）か Claude Opus のどちらか一方だけで走る。
- 認証には、`claude setup-token` で発行する購読の OAuth トークン（`CLAUDE_CODE_OAUTH_TOKEN`）を使う。トークンはホスト側の broker だけが持ち、エージェントのコンテナには入れない（不変条件 2）。
- PARKING の条件として、Claude 側の拒否分類を先に入れ、どちらで走らせるかを campaign 設定で明示する。

## 保全版と今の main の差

保全版は tag `archive/pr-225-claude-runtime`（commit `3478104`）にある。分岐元は `d214de09` で、2026-10-16 の時点である。その後の main では次のものが変わった。

| 項目 | 保全版 | 今の main |
| --- | --- | --- |
| 目的プロンプト | `wp2shell-bounty-v4` | `wp2shell-bounty-v8` と、固定した再開段落 |
| 子の数 | Root と子 3 体 | Root と子 4 体（SPEC 第 6 節） |
| 最低能動時間 | なし | 60 分。早い最終報告は同じセッションで続ける（ADR 0033） |
| 再開 | なし | 止まった理由を問わず Root を再開する（ADR 0036 と追記 2・3）。ホストが死んだ run は runner の再起動で自動再開する。receipt の `session` か、run の印と残骸が要る |
| broker | API キーと購読トークンの 2 方式 | ChatGPT 購読用の TLS 付き経路が加わった。Anthropic 経路はない |
| 判定・台帳 | 旧来の段付き Trial | `stopped` / `providerLimit`、run の印（#402） |

## 移すものと捨てるもの

移すもの（PR 1）:

- Agent SDK の `query()` を使う runner。runner は image に焼かず、Harness が読み取り専用で mount する。
- 購読トークン用の broker 経路。`/v1/messages` だけを通し、`oauth-2025-04-20` beta を足し、grant を本物のトークンに差し替える。
- `HEAD /api/hello` の疎通確認には 404 を返す。
- runsc 下では bubblewrap が動かないため、`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` を使う（所有者承認 2026-10-14）。
- SubagentStart / SubagentStop の hook で子の開始と終了を記録する。子の transcript から子の Finding を Root と独立に保存する。
- grant をコンテナ引数に載せず、docker client の環境変数として名前だけで渡す。保全版でも同じ扱いだった。

捨てるもの:

- API キー方式。今回は購読トークンだけを使う。
- `SendMessage` での子への続行、専用 worker の説明文。エージェントに渡る文章が増えるため外した。子は Claude Code 組み込みの汎用 Agent を使い、モデルは `CLAUDE_CODE_SUBAGENT_MODEL` で Opus に固定する。transcript のモデル名でそれを確かめる。
- 拒否された疎通確認の件数を数えるカウンタ。今の broker の metrics に合わせた。
- Claude 側の run の印と残骸の読み戻し（#402 相当）。PR 2 で扱う。

## PR の分け方

各 PR は問いを 1 つに絞る。

1. **PR 1（今回）**: 「Opus の Trial を Codex と同じ文章・同じ隔離で、対象ごとに振り分けて走らせられるか」。探索 runtime、OAuth トークンの broker、拒否と上限の分類、campaign 設定での振り分けを入れる。既定は全件 Codex で、本番は何も変わらない。追加は約 2,600 行（テスト約 1,000 行を含む）で、目安の 500 行を大きく超える。broker、sandbox、runtime の 3 つは片方だけ入れても動かないため、まとめた。レビューでは分割を求められる可能性がある。
2. **PR 2**: 「Claude の Trial を ADR 0036 の手順で再開できるか」。receipt に Claude のセッション ID と transcript の digest を記録し、`campaign resume --run` から `resume: sessionId` で続ける。今は Claude の run に `session` がないため、再開は `session-unrecorded` で断られる。終了 event の無い Claude の run も、run の印が無いので `session-evidence-missing` で断られ、runner は新しい Trial に戻る。PR 2 では run の印（#402）も Claude 側で書き、#403・#404 の自動再開に乗せる。
3. **PR 3**: 「Opus で handoff スキルを無人で回せるか」。`wbh-verify`（`verify next --handoff`）を、gVisor の中でヘッドレスの `claude -p` として走らせる。認証は同じ broker と OAuth トークンで行う。
4. **PR 4**: 「runtime 別に funnel と停止理由を読めるか」。`ledger funnel` / `ledger runtime` を `configuration.runtime` で分ける。

## 振り分けの規則

- campaign 設定の `discovery.runtimeShare: { codex, claude }` で比率を書く。どちらも 0〜100 の整数で、合計は正とする。書かなければ全件 Codex である。
- 対象の振り分けは `sha256(target identity)` の先頭 8 桁を、2 つの比率の合計で割った余りで決める。同じ対象は何度計画しても同じ側に入る。乱数も、過去の結果も使わない。
- `runtimeShare` があるときだけ、台帳の `configuration.runtime` に `codex-native/v1` か `claude-code/v1` を書く。runtime profile の digest は従来どおり `modelProfileDigest` に入る。
- Claude の比率が正なのに host 設定に `claude` がなければ、campaign は何も起動せずに止まる。image の版、トークンのファイル（種類、所有者、権限 600、空でないこと）、CLI の版は起動前に確かめる。トークンの中身は読まない。
- 振り分けは制御だけで、エージェントの舵取りはしない。Codex と Claude の比較は、同じ分母に混ぜない（同じ campaign の中でも `configuration.runtime` で分けて読む）。

## 拒否・上限・満杯の対応

Claude Code の出力を、既存の型付き理由に当てはめる。本文の文字列を見るのは、`<synthetic>` モデルのメッセージ、`error` 付きのメッセージ、失敗した result だけとする。エージェントが本文で「rate limit」と書いても誤判定しない。

| Claude 側の事象 | 判定 | 台帳 | その後 |
| --- | --- | --- | --- |
| `stop_reason: "refusal"`、または使用ポリシーの文言 | 拒否 | `incomplete(provider)`、`provider-refusal`、`providerLimit` なし | 対象は `target-skipped(provider-refused)`。報告済みの候補は残す。Codex の `provider-cyber-policy` と同じ扱い |
| `billing_error`、購読の使用上限の文言 | 上限 | `incomplete(provider)`、`providerLimit: quota` | runner が待ってからやり直す。Trial に数えない |
| `rate_limit`、429、529（満杯） | 混雑 | `incomplete(provider)`、`providerLimit: rate-limit` | 同上 |
| `authentication_failed`、401、ログイン要求 | 認証 | `incomplete(provider)`、`provider-authentication`、`providerLimit` なし | Codex の認証切れと同じく `provider-refused` に入る。所有者がトークンを入れ直す |

満杯（529）を rate-limit に入れるのは、Codex の `server_overloaded` の扱い（#400）に合わせた。

## 再開と最低能動時間

- runner は、最初の `query()` の後、経過が 60 分に満たなければ、同じセッションに再開段落を送って続ける（`resume: sessionId`、つまり `claude -p --resume` と同じ）。再開段落は v8 プロンプトの最後の段落そのもので、Codex と同じ文字列である。
- 各回の構造化出力はすべて保存し、Codex と同じ関数で Root の報告にまとめる。
- 最低時間に届かないまま終わった Trial は `incomplete(policy)`、`early-final-before-minimum` とする。
- 操作者の名指しによる再開（ADR 0036）は PR 2 で入れる。新しい使い捨てサンドボックスに、前回の transcript を読み取り専用で戻し、同じ Snapshot、同じ再開段落、残りの制限時間で続ける。

## Opus での検証（PR 3 の案）

本番の Finding 13 件は、すべて `incomplete(precondition)` で終わっている。前提作りは handoff スキルの仕事である（ADR 0035）。PR 3 では次の形にする。

- `verify next --handoff` が出す handoff を、gVisor の中のヘッドレス `claude -p` に渡し、`wbh-verify` スキルを無人で回す。
- 認証は PR 1 と同じ broker と OAuth トークンで行う。トークンはコンテナに入れない。
- 管理者セッションは `setup-done` までの前提作りに限る。それ以後は攻撃者の位置に限る（ADR 0035）。ブラウザは渡さない。
- `runtime-confirmed` を出すのは判定器だけである。スキルの自己申告は証明にしない。

## エージェントに渡る文章の対照

Claude の経路で、エージェントに渡る文章は次のとおり。新しく書いた要素はない。

| 文章 | 出典 | 扱い |
| --- | --- | --- |
| 目的プロンプト（`wp2shell-bounty-v8`）とスキーマから生成する節 | Codex の経路と同じ値 | 変えない。テストで一致を確かめる |
| 再開段落 | v8 の最後の段落（ADR 0033） | 変えない |
| 出力スキーマ（Finding / Lead の説明文を含む） | Codex の `reportJsonSchema` | 同じオブジェクトを使う |
| 許可外ツールの拒否「Tool is outside the Trial surface.」 | 不変条件 2、SPEC 第 6 節 | hook の拒否文。Codex ではサンドボックスが同じ制限をかける |
| 5 体目の子の拒否「At most four children can run at once in this Trial.」 | SPEC 第 6 節「Root＋最大 4 子」、Codex の `agents.max_threads=4` | hook の拒否文 |
| Claude Code 本体のシステムプロンプトと組み込みツールの説明 | 提供元の文章 | Codex CLI 本体の文章と同じ扱い。Harness は書かない |
