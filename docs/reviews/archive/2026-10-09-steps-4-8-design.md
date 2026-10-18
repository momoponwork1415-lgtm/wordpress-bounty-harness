# 実装順 4〜8 の設計（2026-10-09）

位置づけ: [探索アーキテクチャのレビュー](2026-10-09-discovery-architecture-review.md) 第 5 節「実装順」の 4〜8 を、Codex が実装できる粒度まで詰めたもの。1〜3 は [別紙](2026-10-09-steps-1-3-design.md)。到達点の全体像は [最終設計](2026-10-09-target-architecture.md)。正本（SPEC.md / ADR）ではなく、食い違えば正本が勝つ。ただし本設計は正本の改訂（SPEC 第 4・6・7・9・10 節、AGENTS.md、ADR 0013〜0015）を前提にしており、その改訂案は最終設計の第 11 節にある。

前提: 1〜3 が `pnpm check` を通っていること。4 は 1〜3 と独立に始められるが、A/B（7）は 1〜3 と 4〜6 の全部が要る。

| 段 | 内容 | 依存 | 消せるか |
| --- | --- | --- | --- |
| 4 | Trial 化（単位、停止規則、wall time、同時数、日次 cap、深さの観測） | なし | 既定値の変更と台帳項目。消す対象ではない |
| 5 | 索引の拡張（保存先 key、producer / consumer、core 交差、連結成分で分担） | なし（4 と並行可） | `assignment` ブロックと profile の 2 file |
| 6 | A/B 軸（prompt 変種、Trial 内継続と Lead 型） | 4、5（継続の近傍に索引を使う） | `ablation.axes`、`continuation` ブロック、profile の 1 file |
| 7 | 開発セットで 2×2 を回し既定を決める | 1〜6 | 設定 file のみ |
| 8 | Harness 捕捉 proxy（再生 replayer は confirmed が出てから） | 1 | Lab の 1 container と judges の分岐 |

## 4. Trial 化

### 4.1 定義

- **Trial** = 1 つの分担 scope に対する独立試行。探索 run 1 本（`runKind: "explore"`）と、6 で足す継続 run 0〜2 本（`runKind: "continue"`）から成る。Trial 同士は何も共有しない。
- 6 を入れるまで Trial = 探索 run 1 本。したがって 4 の実装は「台帳に Trial の識別を書く」「停止と cap の単位を Trial にする」「既定値を深さに合わせる」「読んだ深さを Harness が数える」の 4 点で、campaign の制御構造は変えない。

### 4.2 契約

`CampaignInputV1.stopRules`（`src/discovery/campaign.ts`）は名前を変えず意味を Trial にする。digest 互換のため schema は足さない。

| field | 意味（4 以降） |
| --- | --- |
| `maxRuns` | 対象あたりの Trial 上限 T_max。既定 6（campaign 設定、selection の `runBudget` との小さい方） |
| `noFindingRuns` | 新規 Finding も新規 Lead も出ない Trial が連続した回数 k_t。既定 3 |

campaign 設定（`src/cli/wordpress.ts`）の既定値:

| field | 現在 | 変更後 |
| --- | --- | --- |
| `stopRules` | `{ maxRuns: 40, noFindingRuns: 4 }` | `{ maxRuns: 6, noFindingRuns: 3 }`、`maxRuns` の上限 40 は維持 |
| `runWallTimeMinutes` | 30 | 90（上限 240 は維持） |
| `resources.maxConcurrentRuns` | 4 | 2（上限 4 は維持） |
| `dailyRunCap` | run 数 | **探索 run（= Trial）だけを数える**。継続 run は数えない。名前は変えず、docs で「Trial 数」と明記 |

台帳（`src/ledger/index.ts`）:

| event | 追加 field | 値 |
| --- | --- | --- |
| `discovery-run-started` | `trialId: id` | Trial の識別。探索 run の `runId` と同じ値でよい（継続 run は親の値） |
| `discovery-run-started` | `trialOrdinal: int ≥ 0` | 対象内の Trial 通し番号（pass@k の k） |
| `discovery-run-started` | `runKind: "explore" \| "continue"` | 6 で `continue` を使う。4 では常に `explore` |
| `discovery-run-started.configuration` | `promptDigest: digest` | その run に渡した目的 prompt の digest（CampaignInput の値と同じ。6 で run ごとに変わる） |
| `discovery-run-started.configuration` | `trustBoundaryVersion: id` | `trust-boundary-v1` 等 |
| `discovery-run-started.configuration` | `sourcePack: { dependency: "mounted" \| "none" }` | core を mount したか |
| `discovery-run-finished` | `observed?: { toolCalls, filesRead, uniqueFilesRead, labRequests, dbQueries }`（各 int ≥ 0） | 4.4 |
| `discovery-run-finished` | `sandboxExitCode?: int`、`diagnosticArtifactDigest?: digest` | receipt から昇格（1〜3 の `reason` と同じ扱い） |

すべて optional にして既存 event を読めるままにする。

### 4.3 停止規則と cap（`runDiscoveryCampaign`）

- `noNewFindings` の加算対象を「探索 run の完了」だけにし、`foundNew` は Finding 署名（既存）に加えて Lead 署名（6）も見る。
- `spent`（再開時に消費済みとして数える run）は `runKind === "explore"` の finished だけを数える。
- `dailyRunCap` の `startedToday` は `runKind === "explore"` の started だけを数える（台帳の読み出しで `runKind` が無い旧 event は `explore` として数える）。
- `limit = min(maxRuns, plannedRuns.length)` は Trial 数。plannedRuns は 6 以降「Trial の計画」になる（4.5）。
- `discovery-concluded.stoppedBy` の値は変えない（`no-new-finding` / `max-runs` / `plans-exhausted`）。

### 4.4 読んだ深さの観測（Harness が数える。agent の自己申告ではない）

`src/discovery/codex-native-agent-runtime.ts` は `codex exec --json` の event 列を既に読んでいる。`item.completed` のうち `command_execution` 型の `command` 文字列から次を数え、receipt に `observed` として入れる（schema は `native-run-receipts.ts` に optional で追加）。campaign はそれを `discovery-run-finished.observed` へ昇格する。

| 項目 | 数え方 |
| --- | --- |
| `toolCalls` | `command_execution` item の数 |
| `filesRead` | command 中に現れる `/workspace/main/...` と `/workspace/wordpress/...` の path の出現数（正規表現 `/workspace/(?:main\|wordpress)/[^\s'"\`;&\|)]+`） |
| `uniqueFilesRead` | 同じ path の重複を除いた数 |
| `labRequests` | command 中に Lab endpoint の host 名（`wordpress`）を含む HTTP client 呼び出しの数（`curl`、`wget`、`python`、`php` のいずれかの語と host 名の両方を含む command） |
| `dbQueries` | command 中に DB host 名（`database`）と `mysql` / `mariadb` の語を含む command の数 |

これは下限の近似で、agent が script file に書いた呼び出しは数えない。台帳の docs にそう書く。目的は「2 分で終えた run」と「90 分使った run」を同じ `completed` にしないことで、精密さは要らない。

### 4.5 plannedRuns から Trial 計画へ

`PlannedDiscoveryRun` を次に広げる（6 で継続が付く）。

```ts
type PlannedTrial = {
  readonly trialId: string;
  readonly trialOrdinal: number;
  readonly explore: PlannedDiscoveryRun;            // 既存の run + configuration
  readonly continuation?: {                           // 6 で使う。無ければ継続なし
    readonly maxRuns: number;                         // ≤ 2
    readonly wallTimeMs: number;
    readonly plan: (lead: AdmittedLead) => PlannedDiscoveryRun;  // Lead から継続 run を組む（profile が与える）
  };
};
```

`runDiscoveryCampaign` の `plannedRuns` は `plannedTrials` に置き換える。既存テストは「Trial = 探索 run 1 本」で読み替える。

### 4.6 受け入れ条件

- 既定値の変更で `examples/translatepress-3.2.5/*.json` の campaign 設定を更新する（`campaign-luna-40*.json` は 40 run の記録用なので値を明示して残す）。
- `discovery-run-started` に `trialId` / `trialOrdinal` / `runKind` が出る。再開時に `spent` が探索 run だけを数える。`dailyRunCap` が継続 run を数えない（6 のテストで確認）。
- `observed` が fake の event 列から期待どおりに数えられる。
- `ledger usage` と `funnel` は変更不要。`eval compare` は分母を「探索 run」にする（`runKind` のない旧 event は探索 run）。

## 5. 索引の拡張

### 5.1 置き場と原則

`src/profiles/wordpress/discovery/entry-points.ts`（入口の列挙と分担、既存）に加えて `src/profiles/wordpress/discovery/storage-index.ts`（新規）。どちらも**判断をしない text 走査**で、結果は決定論的、digest を記録する。索引は scope と近傍を供給するだけで、agent の探索を制限しない（`file-assignment-v1` 第 3 項と同じ立場）。汎用モジュールは索引の型を import しない。

### 5.2 型

```ts
export type WordPressStorageKind =
  | "option" | "post-meta" | "user-meta" | "transient" | "db-table" | "file";

export interface WordPressStorageRef {
  readonly kind: WordPressStorageKind;
  readonly key: string | "dynamic";    // 第一引数（table は $wpdb->prefix . 'x' の 'x'）が文字列定数なら key、変数なら dynamic
  readonly access: "write" | "read" | "delete";
  readonly file: string; readonly line: number;
  readonly function: string;           // 走査で囲んでいた function / method 名。見つからなければ "(top-level)"
}

export interface WordPressCoreCrossing {
  readonly kind: "core-hook-callback" | "core-api-call";
  readonly name: string;               // hook 名または core 関数名
  readonly file: string; readonly line: number;
}

export interface WordPressIndexedEntry extends WordPressEntryPoint {
  readonly callback: string | null;    // 解決できた callback 名（関数名、Class::method）
  readonly reach: readonly string[];   // 同一 file と include 先（1 hop）
  readonly storage: readonly WordPressStorageRef[];   // callback 本体と reach 内で見つけた参照
  readonly crossings: readonly WordPressCoreCrossing[];
}

export interface WordPressComponent {
  readonly id: string;                 // 成分内の key を sort して digest
  readonly keys: readonly string[];    // `option:foo` 形式
  readonly entries: readonly string[]; // entryKey
  readonly producers: readonly string[]; // write を持つ entryKey
  readonly consumers: readonly string[]; // read を持つ entryKey
  readonly files: readonly string[];
}

export interface WordPressSourceIndex {
  readonly schemaVersion: 1;
  readonly entries: readonly WordPressIndexedEntry[];
  readonly dynamicStorage: readonly WordPressStorageRef[]; // key が dynamic のもの（成分に入れない）
  readonly components: readonly WordPressComponent[];
  readonly settingsKeys: readonly string[];               // get_option で読む plugin 設定 key（5.6）
  readonly digest: string;                                // 上記の canonical digest
}
```

### 5.3 走査規則（すべて正規表現と brace 対応。PHP parser は入れない）

- 保存先の呼び出し（`access` の対応）:
  - option: `update_option` / `add_option`（write）、`get_option`（read）、`delete_option`（delete）。`pre_option_*` / `option_*` filter は crossing（5.4）。
  - post-meta / user-meta: `update_*_meta` / `add_*_meta`（write）、`get_*_meta`（read）、`delete_*_meta`（delete）。key は第 2 引数。
  - transient: `set_transient` / `set_site_transient`（write）、`get_*transient`（read）、`delete_*transient`（delete）。
  - db-table: `$wpdb->insert` / `update` / `replace` / `query`（write。`query` は文字列中に `INSERT|UPDATE|DELETE` があれば write、`SELECT` なら read）、`$wpdb->get_var|get_row|get_results|get_col|prepare`（read）。table 名は引数または SQL 文字列の `{$wpdb->prefix}x` / `$wpdb->prefix . 'x'` / `$wpdb->x` を `x` に正規化。
  - file: `file_put_contents` / `fwrite` / `wp_upload_bits` / `move_uploaded_file` / `copy` / `rename`（write）、`file_get_contents` / `readfile` / `fopen` / `include` / `require`（read）、`unlink` / `wp_delete_file`（delete）。key は第一引数が文字列定数なら定数、それ以外は `dynamic`。
- callback の解決: `add_action|add_filter|register_rest_route|add_shortcode` の callback 引数を `'name'`、`[ $this, 'm' ]`、`array( $this, 'm' )`、`array( __CLASS__, 'm' )`、`'Class::m'`、closure（その場）に分けて、同一 file 内の `function name(` を探す。見つからなければ `callback: null` で、storage は file 全体から拾う（過剰集合）。
- reach: 同一 file と、file 内の `include|require(_once)?` で literal path（`__DIR__ . '/x.php'`、`plugin_dir_path( __FILE__ ) . 'x.php'`、`dirname( __FILE__ ) . '/x.php'`）が解決できるもの。1 hop だけ。
- 上限: file 20,000、1 file 2 MiB、component 内 key 200。超えたら索引を `incomplete` として scope 文に「索引は部分的」と書く（throw しない）。

### 5.4 core 交差

- `core-hook-callback`: plugin が `add_action|add_filter` する hook 名が次の集合に入るもの。既存 `REQUEST_HOOKS` を包含する: `retrieve_password_message`、`retrieve_password_title`、`wp_mail`、`wp_mail_from`、`authenticate`、`wp_login`、`wp_logout`、`user_register`、`register_new_user`、`lostpassword_post`、`password_reset`、`after_password_reset`、`wp_insert_post_data`、`wp_insert_user`、`profile_update`、`set_user_role`、`pre_option_*`、`option_*`、`pre_user_*`、`rest_pre_dispatch`、`rest_request_before_callbacks`、`determine_current_user`、`auth_cookie_valid`、`send_auth_cookies`、`init`、`template_redirect`、`admin_init`。
- `core-api-call`: plugin が呼ぶ `get_password_reset_key`、`check_password_reset_key`、`wp_generate_password`、`wp_set_auth_cookie`、`wp_set_current_user`、`wp_create_nonce`、`wp_verify_nonce`、`wp_mail`、`wp_update_user`、`wp_insert_user`、`wp_signon`、`wp_hash_password`、`wp_check_password`、`current_user_can`、`check_ajax_referer`。
- 集合は profile の定数として 1 箇所に置く。意味の説明は書かない（判断は agent）。scope 文には「この入口は core の X hook に掛かる」「この関数は core の Y を呼ぶ」の事実だけ。

### 5.5 連結成分と分担

- 頂点 = 入口。辺 = 同じ `kind:key` を 2 つの入口が参照する（一方が write、他方が read、または両方 write）。`dynamic` は辺にしない。
- 成分の順序: 成分内で最も到達しやすい入口の `KIND_ORDER`（既存）で並べる。
- 分担: `entriesPerRun` を上限に成分を順に詰める。成分が上限を超えるときだけ key 単位で分割し、分割境界の key を両側の scope 文に「boundary keys」として書く。
- `planDigest` は索引 digest と分割を含めて計算する。`WordPressEntryAssignment` に `indexDigest`、`componentIds`、`boundaryKeys` を足す。
- 台帳 `configuration.assignment` に `indexDigest` と `componentDigest`（成分 id 群の digest）を足す。key 名そのものは台帳に書かない（未公開候補の手掛かりになりうる）。

### 5.6 設定変更時の経路（今回は列挙まで）

索引は `get_option` で読まれる plugin の設定 key（plugin の slug または prefix で始まる option 名）を `settingsKeys` に列挙し、scope 文に「この plugin が読む設定 key」として出す。**別設定の Lab を Trial の一部に割り当てる案は今回入れない**。理由: pipeline が 1 対象 1 Lab を前提にしており、設定差のある第 2 Lab は provision 経路と Lab Setup digest の扱いを変える。これは 7 の結果を見てから別紙で詰める。

### 5.7 scope 文（`renderWordPressEntryAssignment` の拡張。手順は書かない）

```
## Assigned entry points (partition i of n)
Source root: /workspace/main. WordPress core: /workspace/wordpress (read-only).
- <kind> `<name>` — file:line  [calls core: X, Y] [hooks core: Z]
...
Storage keys in scope:
- option `foo` — written by <entry A> (file:line), read by <entry B> (file:line)
- db-table `bar` — written by <entry C>; no reader found in this partition
Boundary keys shared with partition j: option `baz`
Settings keys this plugin reads: ...
Index: partial (limit reached) | complete
```

既存の 2 文（「読み切る」「他の入口は他の run」）はそのまま。新しい文は事実の列挙だけ。

### 5.8 受け入れ条件（tests）

- fixture plugin（tests 配下に小さな PHP file 群を置く。実在 plugin は使わない）で、option の write / read を持つ 2 入口が同じ成分になる、`dynamic` は成分にならない、include 先の storage が reach で拾える、core crossing が出る、成分が上限を超えたときの boundary keys が両側に出る、digest が入力順に依らない。
- 既存の `partitionWordPressEntryPoints` のテストは、成分が全部 singleton のとき結果が変わらないことで保つ。
- `cli.test.ts`: `## Assigned entry points` に storage 行が出る。台帳に `indexDigest` が出る。

## 6. A/B 軸: prompt 変種と Trial 内継続

### 6.1 campaign 設定

```ts
ablation: z.strictObject({
  axes: z.array(z.discriminatedUnion("axis", [
    z.strictObject({ axis: z.literal("history"), armBFraction }),
    z.strictObject({ axis: z.literal("prompt"), armBFraction, armBPromptId: z.enum(WORDPRESS_DISCOVERY_PROMPT_IDS) }),
    z.strictObject({ axis: z.literal("continuation"), armBFraction }),
  ])).min(1).max(3),
}).optional()
continuation: z.strictObject({
  maxRunsPerTrial: z.number().int().min(1).max(2).default(2),
  runWallTimeMinutes: z.number().positive().max(120).default(30),
}).optional()
```

- 旧形式 `ablation: { axis: "history", armBFraction }` は `axes: [{...}]` に正規化して読む（既存の設定 file を壊さない）。
- `continuation` ブロックが無ければ継続は一切起きない。`continuation` 軸を `axes` に入れるには `continuation` ブロックが必須（arm b のときだけ継続する）。`continuation` ブロックがあり軸に入れなければ全 Trial で継続する。
- arm の割当: 軸 i（0 始まり）の arm は `allocateArm(Math.floor(trialOrdinal / 2 ** i), armBFraction_i)`。全軸の `armBFraction` が 0.5 のとき 4 Trial で 2×2 の各 cell が 1 回ずつ出る。軸が 1 本なら現行と同じ。
- `trialOrdinal` は対象内の通し番号で、再開時も続きから振る（`spent`）。

### 6.2 台帳

- `discovery-run-started.configuration.arms?: { history?: "a"|"b", prompt?: "a"|"b", continuation?: "a"|"b" }`。既存の `axis` / `arm` は旧 event のため残し、新規 event では書かない。
- `funnel.byArm` は `arms` の各軸を `<axis>:<arm>` で数え、2 軸以上のときは cell key `prompt:b+continuation:a` も出す。分母は探索 run。
- `eval compare --axis prompt|continuation|history`。cell 比較は `--cell` で後から足す（7 では台帳を直接読む方が早い）。

### 6.3 Lead 型（profile、`src/profiles/wordpress/discovery/lead.ts`、新規 1 file）

```ts
export const wordpressLeadClaimSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
  attackerPosition: z.enum(["unauthenticated", "subscriber", "customer"]),
  primitive: z.enum(["read", "write", "delete", "auth-material", "partial-execution"]),
  storage: z.strictObject({ kind: storageKind, key: z.string().min(1).max(200) }).nullable(),
  missingEdge: z.enum(["producer", "consumer", "auth-use", "reachability", "precondition"]),
  sourceTrace: z.array(z.strictObject({ file: relativeFile, function, line })).min(1),
  labObservations: z.string().min(1).max(4000),
});
export type WordPressLead = claim & { leadId; discoveryRunId; trialId; snapshotDigest; recipeRef };
export function admitWordPressLead(candidate, context): WordPressLead  // Finding と同じ形
```

- Lead は Finding ではない。Verifier へは行かない。採点（`eval score`）では Finding と同じ `location-overlap` で「source Candidate」として数えるが、別の列に出す。
- 署名 = `canonicalDigest({ primitive, storage, missingEdge, sourceTrace の file 集合 })`。

### 6.4 探索報告の形式

`src/discovery/codex-native-agent-runtime.ts` の報告 schema（strict structured output）に `leads: unknown[]` を足し `required` に入れる。`providerReportSchema`（campaign.ts）も同じ。既存の prompt 6 本は出力形式の段落に Lead の 1 文を足して **v2 にする**（digest が変わるため。`WORDPRESS_DISCOVERY_PROMPT_IDS` は `*-v2` を足し v1 は残す）。足す文は出力形式だけ:

> Report a Lead for a source-grounded read, write, delete, authentication-material or partial-execution primitive whose path to an effect is missing one edge (producer, consumer, authentication use, reachability or precondition). A Lead is not a Finding.

prompt テストの禁止語に触れない語で書く。

### 6.5 継続 run

- 発火: 探索 run が `completed` で、admitted Lead が 1 件以上、かつその Trial の continuation arm が b（または軸に無く `continuation` ブロックがある）。
- 選択: Lead を `missingEdge` の順（`auth-use` > `consumer` > `producer` > `reachability` > `precondition`）、同順なら `sourceTrace[0].file` の辞書順で並べ、先頭から `maxRunsPerTrial` 件。1 Lead につき継続 run 1 本。同じ worker が探索 run の直後に順に回す（同時数は Trial 単位で守られる）。
- 入力（新しい container、同じ Lab、同じ source pack）: 目的 prompt（探索 run と同じ変種）、trust 境界、Programme Boundary、`## Lab`、`## Lead`（Lead 記録の全 field）、`## Neighbourhood`（索引から: その `storage.kind:key` を参照する入口、その file、交差する core hook / API。`storage` が null なら `sourceTrace` の file を含む成分）。渡さないもの: 探索 run の transcript、他の Lead、Finding、examined / unexamined。
- 出力: 探索 run と同じ報告形式（Finding と Lead）。継続 run の Lead からさらに継続はしない（1 hop）。
- 台帳: `runKind: "continue"`、`continuationOf: leadId`、`trialId` は親。Finding は親 Trial の成果（`finding-recorded.runId` は継続 run、`trialId` は台帳の run-started から辿る）。
- `lead-recorded` event（新規）: `{ leadId, runId, trialId, missingEdge, primitive, storageKind | "none" }` と artifact `{ kind: "lead", digest }`。key 名は書かない。
- 失敗: 継続 run の失敗は Trial を失敗にしない。`discovery-run-finished` に `reason` を書いて次へ。

### 6.6 campaign.ts の変更点

- `runOne(trial)`: 探索 run → 報告から Finding と Lead を admit → Lead を `lead-recorded` → 継続条件を満たせば `trial.continuation.plan(lead)` で run を組み順に実行 → Trial の `foundNew` は探索と継続の全 run で見る。
- `noNewFindings` は Trial 完了時に 1 回だけ更新する。
- `expiresAt` の再刻印は継続 run に `continuation.wallTimeMs` を使う。

### 6.7 消せる形

- `continuation` ブロックを消すと継続は起きず、`lead.ts` と campaign.ts の分岐を消しても型が通る。`lead-recorded` の schema は残す（台帳は追記専用）。
- prompt 軸は `ablation.axes` から `prompt` を消せば終わり。

### 6.8 受け入れ条件（tests）

- 割当: 2 軸 0.5 で ordinal 0..3 が 4 cell を一巡する。1 軸は現行と同じ列。
- Lead の admit と署名。不正な Lead は run 全体を落とさず、その Lead だけ捨てて `reason: "schema"` を記録しない（Finding と同じ扱い。現状 Finding の 1 件不正は run 失敗なので、同じにする）。
- 継続: Lead 3 件で 2 本だけ走る、順序が規則どおり、`continuationOf` が付く、継続 run の Finding が新規なら Trial の `foundNew` が true、継続 run の失敗で Trial は失敗にならない、`dailyRunCap` が継続を数えない、`continuation` ブロックなしでは走らない。
- 継続 prompt に `## Lead` と `## Neighbourhood` が出て、transcript や他 Lead の文字列が出ない。

## 7. 開発セットでの 2×2

設定（`examples/translatepress-3.2.5/campaign-luna-ab.json`。値はレビュー第 6 節のとおり）:

```json
{
  "schemaVersion": 1,
  "selectionPolicyPath": "examples/translatepress-3.2.5/selection-luna-40.json",
  "promptId": "short-objective-v2",
  "programmeBoundary": { "...": "campaign-luna-40.json と同じ" },
  "stopRules": { "maxRuns": 12, "noFindingRuns": 12 },
  "runWallTimeMinutes": 90,
  "resources": { "maxConcurrentRuns": 2, "memoryBudgetMiB": 10240 },
  "dailyRunCap": 6,
  "ablation": {
    "axes": [
      { "axis": "prompt", "armBFraction": 0.5, "armBPromptId": "wp2shell-single-http-v2" },
      { "axis": "continuation", "armBFraction": 0.5 }
    ]
  },
  "continuation": { "maxRunsPerTrial": 2, "runWallTimeMinutes": 30 },
  "assignment": { "unit": "entry-point", "entriesPerRun": 8 },
  "wordpressVersion": "6.8.3",
  "lab": { "siteTitle": "Harness Lab", "initialPosts": ["Welcome", "Sample page for translation"], "customerRole": false, "databaseAccess": "read-only" }
}
```

- `noFindingRuns` を `maxRuns` と同じにして早期終了を切る（A/B では cell を埋め切る）。12 Trial = 4 cell × 3。
- `lab-provisioned.reachability.http` が `failed` の Lab の run は分母に入れない（pipeline が ready にしないので自然に外れる）。
- 採点: `eval score --keys <開発セットの鍵>` を Finding と Lead の両方に掛け、cell 別に「ATO 完全経路の Trial 数 / 3」「Stored XSS の source Candidate の Trial 数 / 3」を出す。判定規則はレビュー第 6 節の事前登録どおり。
- 記録する表は 2 枚: 「構成一定（90 + 継続）」と「時間一定（継続なし cell は 150 分）」。後者は `runWallTimeMinutes: 150` の別 campaign を回す。
- 結果の公開はレビュー第 8 節の規則（公開 CVE に対応する結果だけ）。

## 8. Harness 捕捉 proxy

### 8.1 目的

読出し系の判定器（SQL 読出し、file 読出し / LFI）が頼る HTTP 記録を、Verifier の自己申告（`http.json`）から Harness の捕捉に替える。`runtime-confirmed` の証明を「nonce の秘匿」だけに頼らない。

### 8.2 設計

- Lab に `wbh-<id>-proxy` container を 1 つ足す。image は egress broker と同じ pinned Node image、code は本リポジトリの `src/lab/recorder/`（新規、汎用）を broker と同じ bundle 手順で `dist/lab-recorder` に出す。
- 役割: Lab network 上で `:80` を listen し、`wordpress` container へそのまま転送する（Host header 維持、body 無加工、redirect は追わない）。request と response を JSON Lines で `/var/lib/wbh/capture.jsonl` に追記する。1 件あたり body は 1 MiB まで（超過は切って `truncated: true`）、総量 64 MiB で停止（以後は `dropped` を数える）。
- 配線: Verifier run の sandbox に渡す `--add-host=wordpress:<ip>` の ip を proxy の ip にする。endpoint 文字列（`http://wordpress`）は変えない。探索 run は現行どおり wp に直結（捕捉は検証にだけ要る。探索の記録は transcript で足りる）。
- 回収: judges の `recordEvidence` が Lab の `readCapture(handle, sinceMarker)` で proxy の記録を読み、`proxy-capture.jsonl` を private artifact に入れる。`confirmed-route.json.evidence` に `{ kind: "http", path: "proxy-capture.jsonl", capture: "harness-captured" }` を加える。`http.json` は人間向けの補助として残す。
- 判定: `returnedOnly(http, secret)` の入力を proxy 記録にする。request 側の検査は raw bytes に加えて URL decode、base64、hex の 3 変換後にも secret が無いことを見る。
- 台帳: `verification-finished` に `evidenceCapture?: "harness-captured" | "agent-authored"`（optional）。
- 境界: proxy は Lab の内側（`--internal` network）で、外向き通信は持たない。Lab の teardown と leftovers の patterns に `proxy` を足す。

### 8.3 再生 replayer（設計だけ。confirmed が出てから作る）

- `route.json.steps` を構造化 request 列（method、path、headers の許可集合、body、使う principal の cookie 参照）にし、Harness の決定論的 replayer が新しい Lab で順に送って判定器を回す。
- 再現パッケージの Python script はこの列から機械生成する。
- `runtime-confirmed` の定義を「Harness の再生で canary 回収」に寄せるのは ADR 0004 の改訂になるので、別 ADR にする。

### 8.4 受け入れ条件

- recorder の単体テスト（node:http のローカル往復）で request / response が記録され、上限で切れる。
- Lab の fake docker テストで proxy container が起動し、Verifier sandbox の `--add-host` が proxy の ip になる。
- judges のテストで、proxy 記録に secret が応答にだけあるとき `observed`、request にもあるとき `not-observed`、記録が無いとき `http.json` に fallback して `evidenceCapture: "agent-authored"`。

## 9. 推測と未検証（4〜8）

- wall time 90 分で model が実際に時間を使うか（現行 2 分で終えるのが prompt の性質か model の性質か未分離）。7 で分かる。
- 継続 run が独立 Trial の追加より quota 効率が良いか。7 で分かる。
- 保存先 key の text 走査が TranslatePress 以外でも producer / consumer を結ぶか（動的 key、class 経由の間接呼び出しは取りこぼす）。
- 4.4 の `observed` の近似が model の command の書き方に依存する（heredoc で script を書いて実行する癖があると過少になる）。
- ChatGPT プランの 5 時間窓で同時 2 Trial × 90 分が収まるか。`ledger usage` と provider-limit 停止回数で見る。
- proxy 経由で WordPress の挙動が変わらないか（`HTTP_X_FORWARDED_*` は付けない。`REMOTE_ADDR` が proxy の ip になるのは、Lab 内でどの run も同じなので判定に影響しない。推測）。

## 10. 公開制限

本文書と実装に、未公開候補、payload、transcript、Lab の実手順を含めない。Lead の `storage.key` は Private Evidence にだけ置き、台帳には種別と digest だけを書く。
