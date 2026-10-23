# 依存境界と未参照候補の静的検査

ソースの参照関係を調べる開発用の検査である。アプリケーションや対象のコードは実行せず、本番ランナーや保存済みの台帳にもアクセスしない。境界の正本は ADR 0011 のままである。

## コマンド

| コマンド | 用途 | 品質ゲート |
| --- | --- | --- |
| `pnpm check:architecture` | ソース全件の解析、禁止依存、固有語、解析設定の回帰を検査する | `pnpm check` の `pnpm test` からも実行される |
| `pnpm analyze:dependencies` | 禁止依存と実行時循環の診断を表示する | 禁止依存は error、循環は warn。全件解析の保証は上のテストが担う |
| `pnpm analyze:unused` | テスト・補助スクリプトも含めた未参照候補 | 診断のみ。候補があれば終了コード 1 |
| `pnpm analyze:unused:production` | テストを入口にしない未参照候補 | 診断のみ。候補があれば終了コード 1 |

Knip は既存の未参照 export を報告するため `pnpm check` に入れない。大量の ignore や件数の上限で候補を隠さず、通常の非ゼロ終了を保持する。自動修正・自動削除は行わない。

## dependency-cruiser の責任

`.dependency-cruiser.json` が、既存テストにあった汎用モジュールから `profiles` / `cli` への禁止依存を宣言する。型 import、再 export、静的文字列の dynamic import も含む。実行時循環の診断では、型のみの辺を含む循環を除く。固有語は依存図では検査できないため、従来のテキスト検査を維持する。

`tests/architecture/module-boundary.test.ts` は解析されたファイル集合を実際の `src/**/*.ts` と照合する。解析対象が 0 件でも成功扱いになる事故を防ぐ。合成した小さなソースで、禁止された型 import・再 export・dynamic import の検出と、実行時循環と型のみ／型混在の循環の区別を確認する。

### TypeScript の互換性

ビルド・型検査は既存の TypeScript 7.0.2 のままである。dependency-cruiser 18.7.0 は旧 compiler API の TypeScript `<7` を必要とするため、`package.json` の `pnpm.packageExtensions` で **dependency-cruiser にだけ解析用 TypeScript 6.0.3** を追加している。新規の直接 devDependency は dependency-cruiser と Knip の 2 つだが、解析用 compiler も間接依存として増える。

これが無い場合、18.7.0 は `missing-tsc-transpiler` を警告し、TypeScript を 0 件解析して成功終了する。警告だけを無視して運用しない。dependency-cruiser の更新時に TS7 対応を再確認し、不要になった互換依存を外す。TS7 固有の新構文を使う場合も、TS6 の解析が追従できるか確認する。Node 22.22.2 / pnpm 10.33.0 で検証した。

## Knip の入口と対象

`knip.jsonc` と `--tsConfig tsconfig.build.json` を組み合わせて、ビルド後の入口をソースへ対応させる。

- 公開 CLI は `src/cli/main.ts`。配布先は `dist/cli/main.js`。
- import ではなく別プロセスのファイル名として使う `src/lab/recorder/cli.ts` と `src/discovery/provider-credential-proxy-cli.ts` を入口に含める。
- `scripts/*.mjs` は独立した操作・ビルド用の入口にする。`../dist/*` の import は `./src/*` に対応させ、ビルド前でも補助スクリプトの参照を追う。
- 通常モードでは Vitest の `tests/**/*.test.ts` も入口。production モードはテストを含めず、配布ソースと補助スクリプトを対象にする。
- `src` の Markdown / JSON は `copy-assets.mjs` が列挙して配布する資産であり、Knip のコード未参照判定の対象に入れない。Python、シェル、手順書からの動的呼出も、この検査で網羅したとは扱わない。
- 唯一の `ignoreBinaries` は `php`。既存テストが利用可能性を確認して不足時に skip する OS の実行ファイルで、npm パッケージの不足ではない。

`dist` は生成物として解析対象に加えず、元のソースを調べる。未参照ファイルや export を広く ignore する設定は置かない。

## 結果の読み方

| 観測 | 判断できること | 追加で必要な確認 |
| --- | --- | --- |
| 通常モードでも未参照 | 設定された入口から参照を確認できない | 動的利用、別プロセス、互換契約を確認する |
| production だけで未参照 | テスト等が参照を支えている可能性 | テスト専用の公開点か、配布から外せる実装かを区別する |
| export が未参照 | 公開している名前の利用を確認できない | 関数本体が内部で使われていることがある。機能全体の不要判定ではない |
| どちらでも到達可能 | 少なくともコード上の参照がある | 利用実績や機能の必要性は別途判断する |

TypeScript の `noUnusedLocals` / `noUnusedParameters` は引き続き使う。Knip の結果は削除の承認や、全機能が必要だという証明にはしない。

公式資料: [dependency-cruiser の TypeScript 依存](https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md#tsprecompilationdeps)、[ルール](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)、[Knip の入口・対象](https://knip.dev/guides/configuring-project-files)、[production モード](https://knip.dev/features/production-mode)、[生成物とソースの対応](https://knip.dev/features/source-mapping)。
