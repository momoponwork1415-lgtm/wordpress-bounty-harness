# 所有者優先度 gate の出力契約 v3（2026-10-13）

- 対象: `wordpress-discovery-contract-v3`、digest `sha256:15415c1738e0d7ec21ae87f44f9730e7290c8907c05d9486e64230429a6dbae1`。
- v4目的promptの本文・digestは変更しない。v1/v2契約の全文・digestも維持する。v4の新しいTrialだけv3契約を使う。
- 分類は候補の未検証の主張であり、Harnessの `runtime-confirmed` や公式Programme Boundaryの判定ではない。既存の台帳eventは書き換えない。

## Agent に渡る英語全文

```text
## Finding and Lead output contract (wordpress-discovery-contract-v3)

As Root, include this complete contract in every child spawn assignment. In every follow-up to a child, require that child's latest final message to be one JSON object with exactly `findings`, `leads`, `examined`, and `unexamined`, even when there are no claims. Use empty arrays and the two strings for an empty report. A later prose reply must not replace the child's report.

Return `findings`, `leads`, `examined`, and `unexamined`. The last two are strings. A child reports direct Finding and Lead objects. In Root's final report, encode each Finding and Lead object as one JSON string in its array, as required by the transport schema.

Each claim object must follow its schema below. Fields of type string are single strings, not arrays. `sourceTrace` is an array of objects with `file`, `function`, and positive integer `line`. Use target-relative paths; prefix WordPress core paths with `@wordpress/`.

For each Finding, classify the complete claimed effect in `impactScope`. Use `minor-ui-setting-only` only for a cosmetic or prompt-dismissal setting with no other effect; `non-sensitive-enumeration-only` only for labels, IDs, or titles without protected data; `protected-content-only` only for protected post content or its post password without any separate authentication or critical-data effect; `private-media-reference-only` only for a private attachment URL or metadata without arbitrary file control or another critical effect. If effects are mixed, a critical effect is claimed, or the effect is uncertain, use `other-or-uncertain`. This classification is an unverified claim, not a severity verdict.

Finding schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,"properties":{"attackerPosition":{"enum":["unauthenticated","subscriber","customer"],"type":"string"},"brokenProperty":{"maxLength":1000,"minLength":1,"type":"string"},"claim":{"maxLength":4000,"minLength":1,"type":"string"},"configurationPrecondition":{"maxLength":1000,"minLength":1,"type":"string"},"existingControls":{"maxLength":4000,"minLength":1,"type":"string"},"historyRecordId":{"maxLength":128,"minLength":1,"type":"string"},"impact":{"enum":["rce","php-file-write","arbitrary-file-read","arbitrary-file-delete","arbitrary-file-download","lfi","rfi","sqli","options-update","privesc-to-admin","auth-bypass-to-admin","account-takeover","privesc-to-contributor+","auth-bypass-non-admin","sensitive-object-access","content-deletion","stored-xss","reflected-xss","csrf-to-write","missing-authz","idor","other"],"type":"string"},"impactScope":{"enum":["minor-ui-setting-only","non-sensitive-enumeration-only","protected-content-only","private-media-reference-only","other-or-uncertain"],"type":"string"},"labObservations":{"maxLength":4000,"minLength":1,"type":"string"},"privateRecipeReference":{"maxLength":4000,"minLength":1,"type":"string"},"sourceTrace":{"items":{"additionalProperties":false,"properties":{"file":{"minLength":1,"type":"string"},"function":{"maxLength":256,"minLength":1,"type":"string"},"line":{"exclusiveMinimum":0,"maximum":9007199254740991,"type":"integer"}},"required":["file","function","line"],"type":"object"},"minItems":1,"type":"array"}},"required":["claim","attackerPosition","impact","configurationPrecondition","brokenProperty","sourceTrace","existingControls","labObservations","impactScope"],"type":"object"}

Lead schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,"properties":{"attackerPosition":{"enum":["unauthenticated","subscriber","customer"],"type":"string"},"labObservations":{"maxLength":4000,"minLength":1,"type":"string"},"missingEdge":{"enum":["producer","consumer","auth-use","reachability","precondition"],"type":"string"},"primitive":{"enum":["read","write","delete","auth-material","partial-execution"],"type":"string"},"sourceTrace":{"items":{"additionalProperties":false,"properties":{"file":{"minLength":1,"type":"string"},"function":{"maxLength":256,"minLength":1,"type":"string"},"line":{"exclusiveMinimum":0,"maximum":9007199254740991,"type":"integer"}},"required":["file","function","line"],"type":"object"},"minItems":1,"type":"array"},"storage":{"anyOf":[{"additionalProperties":false,"properties":{"key":{"maxLength":200,"minLength":1,"type":"string"},"kind":{"enum":["option","post-meta","user-meta","transient","db-table","file"],"type":"string"}},"required":["kind","key"],"type":"object"},{"type":"null"}]},"summary":{"maxLength":2000,"minLength":1,"type":"string"}},"required":["summary","attackerPosition","primitive","storage","missingEdge","sourceTrace","labObservations"],"type":"object"}
```

## 日本語訳（JSON Schema の技術識別子は英語のまま）

```text
## Finding と Lead の出力契約（wordpress-discovery-contract-v3）

Root は、子を起動する各依頼にこの契約全文を含める。子への各フォローアップでは、Finding や Lead が0件でも、子の最後のメッセージを `findings`、`leads`、`examined`、`unexamined` の4項目だけを持つJSONオブジェクトにするよう求める。空の報告には空配列2つと文字列2つを使う。後続の文章回答で子の報告を置き換えてはならない。

`findings`、`leads`、`examined`、`unexamined` を返す。最後の2項目は文字列。子は Finding と Lead のオブジェクトを直接報告する。Root の最終報告では、転送schemaの要求どおり、Finding と Lead の各オブジェクトを配列内のJSON文字列1件として符号化する。

各候補オブジェクトは次のschemaに従う。文字列型の項目は配列ではなく単一の文字列。`sourceTrace` は `file`、`function`、正の整数の `line` を持つオブジェクトの配列。対象sourceからの相対pathを使い、WordPress coreのpathには `@wordpress/` を付ける。

各Findingについて、主張する到達効果全体を `impactScope` で分類する。`minor-ui-setting-only` は見た目や案内の非表示設定だけで他の効果がない場合、`non-sensitive-enumeration-only` は保護されたデータを伴わないラベル・ID・タイトルの列挙だけの場合、`protected-content-only` は別の認証効果や重大データの露出を伴わない保護記事本文またはその記事パスワードだけの場合、`private-media-reference-only` は任意ファイルの制御や別の重大な効果を伴わない私有添付のURLまたはメタデータだけの場合に使う。効果が混在する、重大な効果を主張する、または効果が不明な場合は `other-or-uncertain` を使う。この分類は未検証の主張であり、重大性の判定ではない。

Finding schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,"properties":{"attackerPosition":{"enum":["unauthenticated","subscriber","customer"],"type":"string"},"brokenProperty":{"maxLength":1000,"minLength":1,"type":"string"},"claim":{"maxLength":4000,"minLength":1,"type":"string"},"configurationPrecondition":{"maxLength":1000,"minLength":1,"type":"string"},"existingControls":{"maxLength":4000,"minLength":1,"type":"string"},"historyRecordId":{"maxLength":128,"minLength":1,"type":"string"},"impact":{"enum":["rce","php-file-write","arbitrary-file-read","arbitrary-file-delete","arbitrary-file-download","lfi","rfi","sqli","options-update","privesc-to-admin","auth-bypass-to-admin","account-takeover","privesc-to-contributor+","auth-bypass-non-admin","sensitive-object-access","content-deletion","stored-xss","reflected-xss","csrf-to-write","missing-authz","idor","other"],"type":"string"},"impactScope":{"enum":["minor-ui-setting-only","non-sensitive-enumeration-only","protected-content-only","private-media-reference-only","other-or-uncertain"],"type":"string"},"labObservations":{"maxLength":4000,"minLength":1,"type":"string"},"privateRecipeReference":{"maxLength":4000,"minLength":1,"type":"string"},"sourceTrace":{"items":{"additionalProperties":false,"properties":{"file":{"minLength":1,"type":"string"},"function":{"maxLength":256,"minLength":1,"type":"string"},"line":{"exclusiveMinimum":0,"maximum":9007199254740991,"type":"integer"}},"required":["file","function","line"],"type":"object"},"minItems":1,"type":"array"}},"required":["claim","attackerPosition","impact","configurationPrecondition","brokenProperty","sourceTrace","existingControls","labObservations","impactScope"],"type":"object"}

Lead schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,"properties":{"attackerPosition":{"enum":["unauthenticated","subscriber","customer"],"type":"string"},"labObservations":{"maxLength":4000,"minLength":1,"type":"string"},"missingEdge":{"enum":["producer","consumer","auth-use","reachability","precondition"],"type":"string"},"primitive":{"enum":["read","write","delete","auth-material","partial-execution"],"type":"string"},"sourceTrace":{"items":{"additionalProperties":false,"properties":{"file":{"minLength":1,"type":"string"},"function":{"maxLength":256,"minLength":1,"type":"string"},"line":{"exclusiveMinimum":0,"maximum":9007199254740991,"type":"integer"}},"required":["file","function","line"],"type":"object"},"minItems":1,"type":"array"},"storage":{"anyOf":[{"additionalProperties":false,"properties":{"key":{"maxLength":200,"minLength":1,"type":"string"},"kind":{"enum":["option","post-meta","user-meta","transient","db-table","file"],"type":"string"}},"required":["kind","key"],"type":"object"},{"type":"null"}]},"summary":{"maxLength":2000,"minLength":1,"type":"string"}},"required":["summary","attackerPosition","primitive","storage","missingEdge","sourceTrace","labObservations"],"type":"object"}
```

## 出典対照

| 追加要素 | 出典と採用範囲 |
| --- | --- |
| 4つの低価値効果 | 所有者が実対象の候補を確認し、軽微な表示設定・非機微な列挙・保護記事や記事パスワード・私有メディア参照だけの候補を検証と人間レビュー前に止めると指示した。対象固有のroute、option名、payloadは契約に含めない |
| `other-or-uncertain` と混合効果を通す規則 | 所有者は `options-update` / `sensitive-object-access` を一律除外せず、Critical／High の具体的効果なら対象とした。曖昧な候補を `incomplete` や棄却に読み替えない不変条件4と ADR 0018 にも従う |
| schema生成と契約の版・digest | ADR 0019。旧版を残し、契約本文をschemaから生成して固定する |
| `finding-parked` とPrivate Evidence | 既存 #185 の Programme Boundary park経路を使い、所有者の新しい優先度理由を追加する。未公開の詳細はGit外に残す |

## 検証と残る条件

`pnpm check` と build で旧contract digestの維持、低価値のみのpark、重大・不明候補の通常経路、復旧候補の同じ扱いを確認する。実対象での新契約Trialの測定はまだない。探索に触るPRの品質ゲートに従い、異なる未実施slugの初回 Trial 3件で件数と終了理由を測り、PRに追記するまでmergeしない。同一slugの2回目以降は人間の1 Trialごとの承認を要する。
