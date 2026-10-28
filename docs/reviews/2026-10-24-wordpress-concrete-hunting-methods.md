# WordPress プラグイン探索の具体的な公開手法（2026-10-24）

「手法を公開している研究者は誰か」という問いへの調査記録。研究者本人の技術記事・論文・講演と、その人が公開したコード・プロンプトを優先する。公開度は、**実行可能なコードと指示文がある**、**検索式や処理順がある**、**構成の説明だけ**に分ける。件数は各著者の報告であり、分母・対象・受理条件が異なるため検出率として並べない。

## 発表時期

| 資料 | 発表日 |
| --- | --- |
| Sebastian Neef の論文 | [2026-09-15](https://arxiv.org/abs/2609.17164) |
| Muhan Luo の記事 | [2026-05-17](https://infosecwriteups.com/hunting-cves-in-wordpress-plugins-using-claude-semgrep-1f0c82453356) |
| Night-Wolf Team の記事 | [2026-05-26](https://blogs.night-wolf.io/ai-powered-vulnerability-hunting-in-wordpress-plugins-themes)（ページでは Updated） |
| Dutafi の記事 | [2026-06-10](https://medium.com/@ductai126/how-i-structure-my-wordpress-vulnerability-hunting-workflow-0a236760096f) |
| Austin Ginder の記事 | [2026-08-21](https://anchor.host/elementor-pro-rce-ai-direction/) |
| Ananda Dhakal と Rafie Muhammad の講演 | [2025-09-26、BSides Canberra](https://pretalx.com/bsides-canberra-2025/speaker/99JYVA/)。DeepSec のスライドは 2025 年の講演に属する。 |
| Eddie Zhang の記事 | [2024-08-27](https://projectblack.io/blog/cve-hunting-at-scale/) |
| Sanjay Das の記事 | [2024-01-11](https://p3n7a90n.github.io/blogs/wp-plugins-research/) |
| Brandon Roldan の記事 | [2023-11-01](https://noob3xploiter.medium.com/automating-csrf-detection-in-wordpress-plugins-with-semgrep-52ece2c212b7) |
| Shreya Pohekar と Syed Sheeraz Ali の講演 | [2022-09-09〜10、Nullcon Goa](https://nullcon.net/talk/raining-cves-on-wordpress-plugins-with-semgrep/) |
| Luke Stephens の記事 | [2022-04-04](https://blog.wpsec.com/discovering-vulnerabilities-in-wordpress-plugins-at-scale) |
| Krzysztof Zając の記事 / `wpgarlic` 公開 | [2022-02-03 / 2022-02-26](https://kazet.cc/2022/02/03/fuzzing-wordpress-plugins.html) |

講演資料の URL に含まれるアップロード年月は研究発表日ではない。公開コードは後日更新されうるため、以下の手法説明は当時の論文・記事・講演を基準にしている。

## 固定ソース診断に近く、実物がある

| 研究者と一次資料 | 公開された具体物・処理順 | 読む際の限界 |
| --- | --- | --- |
| **Sebastian Neef**、[Plug ’n’ Pray 論文](https://arxiv.org/html/2609.17164v1)・[全コード](https://github.com/gehaxelt/Agentic-Detection-of-Potential-Log-File-Exposures-in-CMS) | WordPress.org から対象を並べ、[Python coordinator](https://github.com/gehaxelt/Agentic-Detection-of-Potential-Log-File-Exposures-in-CMS/blob/main/01-analysis_coordinator.py)が 1 プラグインずつ新しい Claude Code 実行と使い捨て WordPress を起動。[PROMPT.md](https://github.com/gehaxelt/Agentic-Detection-of-Potential-Log-File-Exposures-in-CMS/blob/main/PROMPT.md)と[CLAUDE.md](https://github.com/gehaxelt/Agentic-Detection-of-Potential-Log-File-Exposures-in-CMS/blob/main/CLAUDE.md)に「静的に書込み経路を探す→保護を評価→Lab で動的確認」を記載。論文の付録にも起動プロンプトがある。 | **WordPress プラグインの AI 探索ハーネスをコードと指示文まで公開した最も直接的な例**。対象はログファイル露出の 1 種だけ。300 プラグインで 81 候補のうち 79 の現象を手で再現したが、すべてが bounty 対象の未知・重大脆弱性ではない。公開 repo の Findings は CVD 終了後に提供する予定。論文の Lab は Docker で、本リポジトリの gVisor 境界とは異なる。 |
| **Muhan Luo**、[本人記事](https://infosecwriteups.com/hunting-cves-in-wordpress-plugins-using-claude-semgrep-1f0c82453356)・[WP 専用 Semgrep 規則](https://github.com/muhanLuo/wordpress-plugin-semgrep-rules)・[Semgrep→Claude スクリプト](https://gist.github.com/muhanLuo/8c888dc2764a55724eeadf035b830e98)・[対象収集スクリプト](https://gist.github.com/muhanLuo/28dc4874f1f29fb785ca89f47a62153a) | 上位 1 万プラグインを収集→Semgrep join mode で AJAX callback の権限確認不足候補→Claude Opus 4.6 が snippet を 1–5 点で評価→SARIF Explorer で人が確認→ローカル WordPress で再現。**規則、AI 指示文、実行スクリプトを公開**。 | 著者報告では約 11,000 候補を約 1,400 に圧縮し、Opus 費用は約 $120。低スコアから 100 件を見て問題なしだったという確認であり、全件の recall 証明ではない。規則は nonce 関連関数を欠落判定の除外条件に含め、join mode は多数対象を一括実行するとメモリ不足になったと本人が記す。中心の missing-auth は現行 Programme Boundary では park 対象。 |
| **Eddie Zhang**、[本人記事](https://projectblack.io/blog/cve-hunting-at-scale/)・[収集/解析コード](https://github.com/prjblk/wordpress-audit-automation) | WordPress.org API から更新のあったプラグインを取得→Semgrep PHP 規則を走査→候補と導入数を SQL DB に保存→種類・導入数で照会→短時間の人手 triage とローカル再現。repo に起動コマンドと SQL 例もある。 | **AI を使わない広域静的探索の基準**。本人は 14 CVE を列挙する。コードとデータの取得は公開されるが、個々の判断は人間が行う。 |
| **Brandon Roldan**、[本人記事](https://noob3xploiter.medium.com/automating-csrf-detection-in-wordpress-plugins-with-semgrep-52ece2c212b7)・[Semgrep 改変コード](https://github.com/tomorroisnew/Semgrep-Rules/blob/main/join_rule.py) | 記事に Semgrep join mode の規則全文を掲載。AJAX hook の登録と callback の呼出し関係をつなぎ、nonce 検証に届かない経路を候補化。導入数 1 万以上の 2,524 プラグインを横断し、人が結果を調べた。 | 2023 年当時の Semgrep の **独自改変**が必要な方式。著者は 55 提出・43 受理と報告するが、CSRF 中心で現行 Programme Boundary には基本的に直接合わない。 |
| **Sanjay Das / p3n7a90n**、[本人の手動診断記事](https://p3n7a90n.github.io/blogs/wp-plugins-research/)・[報告例](https://github.com/p3n7a90n/WPPluginsVulnerabilitiesReported) | WordPress と Xdebug の準備から、AJAX/REST 入口、権限、SQL・データフロー、機能操作からの逆引き、PHPCS と Semgrep の補助検索まで順序立てて説明。使ったコマンドと報告例も公開。 | **深掘り source review の具体的教材**。自動的な大量配車・モデル分担のコードではない。 |
| **hakluke / Luke Stephens**、[本人記事](https://blog.wpsec.com/discovering-vulnerabilities-in-wordpress-plugins-at-scale) | 人気プラグイン 958 件の取得コマンド、`ripgrep` と正規表現による横断検索、ノイズ除去を記事内で示し、残ったコードの文脈とローカル WordPress を確認する。 | 記事中の 7 件は**候補行**で、確認済み脆弱性の数ではない。手軽な再現教材だが、単純な規則が拾えない連鎖を評価できない。 |

## 手順は具体的だが、完全な実装は確認できない

| 研究者と一次資料 | 公開範囲 |
| --- | --- |
| **Ananda Dhakal**、[2025 年の講演スライド](https://dhakal-ananda.com.np/assets/talks/deepsec-2025-slides.pdf) | WordPress SVN の revision を保持し、新規変更から導入数 5,000 以上のプラグインの `trunk` にある PHP 追加行だけを調べ、人に通知する処理順と閾値が明記される。スライドは偽陽性・キーワード依存を課題として SAST＋AI を将来案に挙げる。完全な監視コードは確認できない。 |
| **Shreya Pohekar と Syed Sheeraz Ali**、[Nullcon Goa 2022 発表](https://nullcon.net/talk/raining-cves-on-wordpress-plugins-with-semgrep/)・[スライド](https://nullcon.net/wp-content/uploads/2026/05/raining-CVEs-on-wordpress-plugins-Goa22.pptx)・[動画](https://www.youtube.com/watch?v=RvKLn2ofMAo) | 8 万プラグインに独自 Semgrep 規則→偽陽性を減らすため規則を改良→XSS 候補を別の検証器へ、という手順を講演とスライドで公開。スライドに規則例があり、参考文献で[CodeVigilant の公開規則集](https://github.com/CodeVigilant/codevigilant_semgrep_rules)を明示する。ただし現在の repo が 2022 年当時と同じ版かは未確認。CVE 件数は講演概要の 47 件とスライドの 48 件で食い違うため、比較用の確定値には使わない。 |
| **Night-Wolf Team**、[本人たちの記事](https://blogs.night-wolf.io/ai-powered-vulnerability-hunting-in-wordpress-plugins-themes) | 10 種の静的 scanner→8 並列・10 tool call 上限の短命 Claude 子 agent→JSON と source 引用→Lab→scanner 規則へのフィードバック。子 agent の frontmatter・出力 schema・判定木の抜粋がある。完全な scanner コードと agent 指示文の公開 repo は確認できない。親子とも Opus 4.x と記す。 |
| **Dutafi / Bùi Đức Tài**、[本人記事](https://medium.com/@ductai126/how-i-structure-my-wordpress-vulnerability-hunting-workflow-0a236760096f) | Semgrep→規則整理・重複排除→軽い AI grouped triage→文脈を広げた深い AI→Claude Code のローカル確認という工程と偽陽性・見逃し例がある。完全な scanner 規則、プロンプト、runner コードと、Sonnet/Opus のモデル名は公開されていない。 |
| **Austin Ginder**、[本人記事](https://anchor.host/elementor-pro-rce-ai-direction/) | `/wp-registry-scan-chain` の実行記録、93 Lead から複数の連鎖仮説を並行して調べた流れ、Opus 4.8 と使い捨て WordPress による確認を記載。スキル全文と registry/runner のコードは公開されていない。報奨金は受領したが、本人が先行報告の重複と明記する。 |

## 実装まである隣接方式（動的ファジング）

- **Krzysztof Zając** の[技術記事](https://kazet.cc/2022/02/03/fuzzing-wordpress-plugins.html)と[完全な `wpgarlic` コード](https://github.com/kazet/wpgarlic)は、プラグインの入口を列挙し、計測を入れた WordPress で入力を変えながら反応と危険な操作を観測する。README は起動、結果閲覧、手動テスト、拡張箇所まで示す。著者自身が偽陽性の多さと、陰性を安全の証明にできないことを強調する。現在の固定ソースのみを読む探索とは別方式。
- **Sebastian Neef ほか**の[PHUZZ 論文](https://arxiv.org/abs/2406.06261)と[実装](https://github.com/gehaxelt/phuzz)は、PHP のカバレッジを使った動的ファジングを WordPress プラグイン 115 件の 1,000 超の API 入口へ適用した研究。現在の source-only Trial へ直接移す根拠ではない。

## 本リポジトリとの関係

最も近い**実物の AI ハーネス**は Sebastian Neef の repo である。Python runner が対象の順番・新しいセッション・時間・保存を制御し、探索の具体的な読み方を `PROMPT.md` と `CLAUDE.md` に置く。これは本リポジトリの「Harness は制御、探索は agent」という所有境界と比較しやすい。ただし論文は 1 種の現象、Docker Lab、1 対象あたり短い実行であり、広い影響を狙う `wp2shell-bounty-v8` と同一条件の優劣にはならない。

Muhan Luo と Eddie Zhang は、**大量対象から候補を作る入口**をコードとして公開している。彼らの Semgrep 規則や閾値をそのまま現行の判定・Programme Boundary に入れる根拠はない。比較実験では、候補と保留の保存、固定 Snapshot、独立した Lab 判定を [SPEC](../SPEC.md)に合わせ、v8 の Finding 件数を同じ分母へ混ぜない。
