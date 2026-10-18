# ソースコード診断とローカル再現に向くバグバウンティ調査

調査日: 2026-10-16（公開情報を確認。募集範囲・報酬は着手時と提出直前に再確認する）

## 問いと結論

WordPress 以外で、公開ソースを読んで脆弱性を見つけ、手元に対象を立てて再現できる継続的な有償プログラムは何か。また、実際にどの種類の脆弱性が公開されているか。

現状の最有力は **Vercel の統合公開バグバウンティの OSS 枠**。Next.js など多数の公開リポジトリを含み、OSS の PoC はローカルで再現するよう明示している。2026-09-24 に従来の OSS 専用プログラムはメインの Vercel プログラムへ統合されたため、報告先は [HackerOne の Vercel](https://hackerone.com/vercel?type=team) である。[Vercel の統合告知](https://vercel.com/blog/the-vercel-bug-bounty-program-is-now-publicly-available)

大規模な対象群という点では [Immunefi の一覧](https://immunefi.com/bug-bounty/) が Wordfence / Patchstack に最も近い。ただし対象は主に Web3 の個別契約・プロトコルで、報奨可否は各プログラムのデプロイ済み資産、影響、PoC 条件で決まる。Vercel は単一所有者の OSS 群で、WordPress プラグイン市場と同じ仕組みではない。

本調査は公開資料の照合であり、候補の Lab を gVisor `runsc` で起動して検証していない。現行 Harness の設計を変更したり、第二 profile を実装したりする提案ではない。[ADR 0011](../adr/0011-target-specific-code-lives-in-a-profile.md) は、WordPress 版の完成後に第二対象で共通部分を抽出する順序を定めている。

## 公開された脆弱性の実例

以下は Vercel 関連の公開アドバイザリと公式事後報告で確認できた事例。**公開アドバイザリの存在だけでは、その事例が現行の Vercel OSS 報奨制度で受理・支払済みとは言えない。** 報奨支払いまで一次資料で確認できる例は最初の行である。

| 脆弱性と一次資料 | 公開された影響・成立条件 | 報奨について確認できること |
| --- | --- | --- |
| [Next.js Middleware 認証回避、CVE-2025-29927](https://vercel.com/blog/postmortem-on-next-js-middleware-bypass) | 内部ヘッダーの扱いによって Middleware の認可処理を迂回できた。`next start` と standalone の自己ホスト構成が影響し、Vercel ホスト環境は影響しなかった。 | Vercel の事後報告は研究者への報奨支払いを明記。ただし 2025 年の報告で、現行の統合 OSS 枠より前。 |
| [Next.js rewrite における SSRF、GHSA-p9j2-gv94-2wf4](https://github.com/vercel/next.js/security/advisories/GHSA-p9j2-gv94-2wf4) | 外部宛先のホスト名をリクエスト由来の値で組み立てる設定で、意図しないホストへのサーバー側リクエストを生む。redirect では open redirect も起こる。 | アドバイザリは確認。個別の報奨支払いは未確認。 |
| [Next.js Server Actions の SSRF、GHSA-89xv-2m56-2m9x](https://github.com/vercel/next.js/security/advisories/GHSA-89xv-2m56-2m9x) | Host 系ヘッダーを攻撃者が制御できる custom server 等の構成で、転送先を悪意あるホストに向けられる。一部では認可を弱める内部値にも影響する。 | 同上。通常の管理ホスティングと一部の `next start` 構成は影響しないと記載。 |
| [Next.js Middleware / Proxy 認証回避、GHSA-6gpp-xcg3-4w24](https://github.com/vercel/next.js/security/advisories/GHSA-6gpp-xcg3-4w24) | App Router、Turbopack、単一 locale という条件下で認証を迂回できた。 | アドバイザリは確認。個別の報奨支払いは未確認。 |
| [Next.js キャッシュ混同、GHSA-68g3-v927-f742](https://github.com/vercel/next.js/security/advisories/GHSA-68g3-v927-f742) | 特定の `fetch` の呼び方で異なる POST の応答本文が取り違えられ、機密情報が別の要求に漏れる可能性。Pages Router は対象外。 | 同上。 |
| [Next.js Server Actions の CSRF 検証回避、GHSA-mq59-m269-xvcx](https://github.com/vercel/next.js/security/advisories/GHSA-mq59-m269-xvcx) | `Origin: null` を欠落扱いしたことで、被害者ブラウザーから状態変更を誘発できる可能性。 | 同上。 |
| [Next.js CSP nonce と共有キャッシュに関わる Stored XSS、GHSA-ffhc-5mcf-pf4q](https://github.com/vercel/next.js/security/advisories/GHSA-ffhc-5mcf-pf4q) | App Router が CSP nonce を使い、共有キャッシュの背後で動く構成で、応答汚染によるスクリプト実行が可能。 | 同上。 |
| [Turborepo VS Code 拡張のコマンド注入、GHSA-5xc8-49mv-x4mm](https://github.com/vercel/turborepo/security/advisories/GHSA-5xc8-49mv-x4mm) | 悪意あるワークスペースの設定やタスク名がシェル実行に混入し、拡張を使う開発者の権限でコマンドが走る。 | 同上。現行規約はローカル開発環境への攻撃を原則除外し、合理的な遠隔経路の実証を求めるため、報奨対象とは断定できない。 |

この一覧から、Next.js では **認証・認可の境界、外向き通信先、キャッシュのキーと内容、ブラウザー由来の状態変更、HTML への値の埋め込み**に関する欠陥が公開されていると分かる。各行の成立条件を満たす公式の動作形態と、実際の影響の確認が必要である。2026 年の個別事例について「有償だった」という資料は見つからなかった。

依存ライブラリ由来の [AVIF 画像処理の RCE](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4) や [ImageResponse の RCE](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j) も公開されている。ただし [現行 Vercel 規約](https://hackerone.com/vercel?type=team) は第三者依存の問題を原則除外し、Vercel 側の使い方に問題がある場合などに限って検討する。アドバイザリをそのまま新規報奨機会の一覧として扱えない。

### 他の対象で報告された例

- GitLab は [2026-09-10 の公式修正一覧](https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-3-2-released/) で、認証なしの任意ファイル読み取り（CVE-2026-85706）、GraphQL の不安全なデシリアライズによる機密設定の取得、Git プロジェクト import 時のバッファオーバーフローによる RCE、開発者権限から保護された CI/CD 変数へのアクセス、Markdown レンダラーの XSS などを公開した。各項目には HackerOne プログラムから報告した研究者への謝辞がある。個々の支払額は記載されていない。
- GitLab の [2026-09-23 の公式修正一覧](https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-4-1-released/) では、CI/CD 設定の正規表現処理における double free と整数オーバーフローからのサーバー RCE、マージリクエスト diff 表示の XSS、権限不足の API 経由での非公開 issue や CI/CD job trace の読み取りが挙がっている。外部報告と社内発見の両方が混在するので、謝辞欄を確認して区別する。
- [YesWeHack の 2026 年次報告](https://choose.yeswehack.com/hubfs/YWH%20Report/YesWeHack_2026_Report.pdf) は、OpenPGP.js の署名検証偽装（CVE-2025-47934）に対する **€7,500 の支払い**を記録している。公開コードの論理的な信頼境界に関する有償事例であるが、そのプログラムが現在も募集しているかは個別に確認が必要。
- [Kubernetes の公式説明](https://kubernetes.io/blog/2026/04/24/kubernetes-v1-36-fine-grained-kubelet-authorization-ga/) は `nodes/proxy GET` 権限だけで pod 内のコマンド実行に至る研究を紹介する。これは「read-only に見える権限の境界」が主題であり、当該研究への報奨支払いは確認していない。

## 現行プログラムの比較

「ソース公開」「ローカルに対象を立てられる」「報奨規約が確認できる」の三点を優先した。評価欄は本調査の判断であり、報奨の保証ではない。

| 候補 | 公開コードとローカル環境 | 現行の報奨範囲・主な制約 | この条件への適合 |
| --- | --- | --- | --- |
| [Vercel OSS 枠](https://hackerone.com/vercel?type=team) | Next.js、Nuxt、Svelte、Turborepo、AI SDK 等の公開リポジトリ。OSS は公式手順・安定版でのローカル再現を要求。 | フレームワーク・ライブラリ自体に影響がある欠陥。テンプレート、アプリ側の脆弱なコード、依存ライブラリだけの指摘、通常の開発時だけの問題等は除外。Tier 1 は High $5,000 / Critical $10,000、Tier 2 は High $2,500 / Critical $5,000 の掲載値。[報酬表](https://hackerone.com/vercel/scope_and_rewards_versions) | **最優先**。単一の窓口で複数 OSS を選べ、ローカル再現が明確。 |
| [Microsoft Open Source Bounty](https://www.microsoft.com/en-us/msrc/opensourcebountyprogram) | Azure SDK 各言語、TypeScript、VS Code、PowerShell 7、Fluent UI、Monaco、MsQuic、Agent Framework など公開リポジトリ。 | $750–$15,000。最新の保守ブランチで Critical / Important と直接の影響を示す。サービスへの影響が求められる範囲があり、純粋なローカル影響の除外条件はリポジトリごとに要確認。 | **次点**。言語選択の自由度は高いが、対象ごとに必要な影響証明が違う。 |
| [GitLab Bug Bounty](https://about.gitlab.com/blog/gitlab-bug-bounty-program-policy-updates/) | 公開ソースと GitLab Development Kit によるローカルテスト。GitLab 自身が多くの調査で GDK を推奨。 | GitLab.com 固有のアーキテクチャが必要な場合は本番上の自分のテストアカウントが必要。範囲は [HackerOne 規約](https://hackerone.com/gitlab?type=team) で対象ごとに確認。 | **有力**。自己ホスト可能だが対象が大きく、Lab の資源・構築時間は要測定。 |
| [Kubernetes Bug Bounty](https://hackerone.com/kubernetes?type=team) | 公開ソース。ローカルクラスタで構成要素の再現が可能。 | RBAC、認証、kubelet/API server の RCE、etcd への不正アクセス、サプライチェーンなどが対象。対応する安定版・構成条件を守る。 | 高度な候補。クラスタの再現が重く、現行 gVisor Lab と併用可能か未検証。 |
| [Elastic](https://www.elastic.co/product-security/) | Elasticsearch / Kibana の中核コードは公開され、自己ホスト可能。[公開性の説明](https://www.elastic.co/about/open-source/) | 報奨希望なら HackerOne 経由。個別資産・影響の範囲は [プログラム](https://hackerone.com/elastic?type=team) で確認。 | 大規模な自己ホスト製品として有望。資源量・報奨範囲を追加確認。 |
| [Mattermost](https://mattermost.com/company/responsible-disclosure/) | 公開コード。公式の [Docker プレビュー](https://docs.mattermost.com/deployment-guide/quick-start-evaluation/docker-preview) がある。 | 公式資料は Bugcrowd 報奨制度を案内するが、現在の報奨対象・金額を公開ページから十分確認できなかった。 | 軽い Lab の候補。規約確認後に評価。 |
| [Zabbix](https://www.zabbix.com/pr/pr439) | [公開ソース](https://www.zabbix.com/documentation/current/en/manual/installation/getting_zabbix)と公式コンテナー。 | 公式発表で HackerOne の公開プログラムを確認。個別の現行対象・報酬を要確認。 | 自己ホスト製品として候補。 |
| [Immunefi](https://immunefi.com/bug-bounty/) | Web3 の多数の公開コード。ローカルチェーン等での検証は対象により可能。 | 2026-10-15 時点で一覧は 170 プログラム。各プログラムで資産・デプロイ版・影響・PoC・KYC を別々に定める。[Cosmos の例](https://immunefi.com/bug-bounty/cosmos/information/)はソース資産を明示する。 | **規模は最大級**。既存の Web アプリ向け判定器や Lab からは大きく離れる。 |
| [YesWeHack の OSS プログラム群](https://choose.yeswehack.com/hubfs/YWH%20Report/YesWeHack_2026_Report.pdf) | EU・Sovereign Tech Agency の支援で Jenkins、Nextcloud、Log4j、systemd 等の公開コードを扱った。 | 2026 年の年次資料は複数の公開プログラムを挙げるが、個別の募集は期間や状態が変わる。**現在の個別ページを確認できたものだけ**対象にできる。 | 幅広い探索先の発見に有用。固定の継続対象群としては扱わない。 |

### 現在は主候補にしないもの

- [Huntr の公式 FAQ](https://blog.huntr.com/huntr-2-0-faq) は従来の一般 OSS 脆弱性報告を 2026-06-30 に終了したと明記。現在の中心は AI 攻撃のチャレンジ。
- [Google OSS VRP の規則](https://github.com/google/bughunters/blob/main/bughunters/articles/about/rules/open-source/google-open-source-software-vulnerability-reward-program-rules.md) は、製品の脆弱性を 2026-10-01 からこの窓口で受け付けていないと明記。サプライチェーン等は別扱い。
- HackerOne の Internet Bug Bounty は 2026 年に新規受付停止と報じられているが、現行ページの機械可読な一次情報を本調査では取得できなかった。少なくとも現時点で主軸として予定しない。

## Vercel を選ぶなら確認する境界

[Vercel の現行規約](https://hackerone.com/vercel?type=team) に基づく。

1. 対象リポジトリと `SECURITY.md`、安定版の対象範囲を確認する。Canary / RC のみの問題は原則対象外。
2. 公式のローカル手順で、配布されたフレームワークやライブラリの欠陥を再現する。OSS の PoC を Vercel 本番、顧客デプロイ、Vercel 管理の CI 等へ向けない。
3. 実際に読めた・書けた・実行できたなどの影響まで示す。静的解析の指摘、AI 出力、依存 CVE の存在だけでは受理されない。
4. 報告には影響版、該当コード行への GitHub permalink、第三者が再現できる PoC の zip が求められる。提出文書と evidence は現行リポジトリの規則どおり Git 外で扱う。
5. 同じコードでも Vercel 固有のホスティングに依存する欠陥は Platform 枠となる。第二 profile を考える際は OSS コード自体への影響に絞る。

現行 Harness との適合では、Next.js の Linux 上の通常のサーバー動作は検討しやすい。一方、[Windows ホスト固有の Next.js RCE](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) のような事例は Linux `runsc` Lab だけでは同等の再現ができない。対象を選ぶ前に、公式動作形態、必要なリソース、gVisor 内での起動可否を小さな試験で確認する必要がある。

## 判断

WordPress 完成後の第二対象を選ぶときは、まず Vercel OSS 枠から **Next.js の安定版・自己ホスト可能な通常のサーバー機能**を候補にする。報告実績として認証回避、SSRF、キャッシュによる情報漏えい、XSS が公開されており、規約もローカル再現を要求している。次に Microsoft の対象リポジトリから、ローカルで影響を実証できるものを比べる。広い多数の個別対象を回したいなら Immunefi があるが、現行 Harness から必要なドメインモデルと検証器の変更は大きい。

この判断は公開規約と事例に基づく候補選定であり、未知脆弱性の発見率や報酬率を示す実験ではない。現行開発セットに他プラットフォームを混ぜず、第二 profile を始める場合は別の問い・別の評価分母を置く。
