---
status: accepted
---
# strict TypeScriptのモジュラーモノリスと薄いCLI

`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`useUnknownInCatchVariables` を維持し、selection / snapshot / lab / discovery / verification / ledger / review / evaluation を公開インターフェースと所有記録だけで接続する。受け渡し契約は版付きのZod schemaで実行時検査し、`any` や未検査のassertionを入力検査の代用にしない。CLIは構成だけを持つ薄いadapterとする。旧リポジトリADR 0054 / 0055 / 0084を引き継ぐ。対象のPHP・WordPress起動処理をホストで実行しない。
