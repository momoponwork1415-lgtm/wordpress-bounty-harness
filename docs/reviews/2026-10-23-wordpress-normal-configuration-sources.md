# WordPress.org で通常構成を確認する方法（2026-10-23）

## 問い

Wordfence 候補の検証前選別で、複数の管理者設定を要するというだけで通常構成から外すと、公式機能の組合せを見落とさないか。

## 公開資料で確認した例

| 製品 | WordPress.org と開発元が直接説明する機能 | その資料だけでは分からないこと |
| --- | --- | --- |
| [ACF Extended](https://wordpress.org/plugins/acf-extended/) | Forms と Taxonomy Terms を製品機能として紹介する。[Forms の説明](https://www.acf-extended.com/features/modules/forms)は管理画面の Form UI とフロントエンド表示を扱い、[0.8.5 の変更履歴](https://www.acf-extended.com/changelog/0-8-5)は Post Action による分類語の新規作成を明記する。[作者のサポート回答](https://wordpress.org/support/topic/showing-taxonomy-options-on-form/)には分類の選択に関する設定例がある。 | 個々のサイトの設定状態とその影響。 |
| [Pods](https://wordpress.org/plugins/pods/) | Pods Form と Single Item - List Fields を公式ブロックとして列挙する。[Pods Blocks の説明](https://docs.pods.io/displaying-pods/pods-blocks/)は表示方法を扱う。 | 個々のサイトの設定状態とその影響。 |

公式資料に機能が載っていることは、個々の Finding の成立や報奨の受理を証明しない。一方、機能を組み合わせた一体の実例が公式ページにないことも、珍しい設定や誤設定の証拠にならない。

## 選別時に分ける証拠

1. 対象版にその機能があり、通常の管理画面 UI で設定できるか。
2. 開発元がその機能の用途・既定値・権限をどう説明しているか。
3. Finding が必要とする設定の組合せと、その結果の主張が具体的か。
4. 実際の接続と別主体への影響が Lab で観測されたか。

1〜3を確認するときは WordPress.org の説明、FAQ、作者のサポート回答、開発元の公式資料を出典 URL・確認日・対象版との関係付きで残す。公開資料にない組合せは未確認と書く。4は Harness の判定器による検証であり、公開資料から推定しない。未公開 Finding の詳細と実行証拠は Git 外の Private Evidence に置く。
