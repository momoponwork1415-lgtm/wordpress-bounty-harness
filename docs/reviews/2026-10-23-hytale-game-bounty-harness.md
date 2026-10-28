# Hytale 型ゲームのバグバウンティと最小ハーネスの調査（2026-10-23）

「調べて報告」の記録。2026-10-23 に確認した運営者とプラットフォームの一次資料を使う。正本ではなく、対象への試験、アカウント作成、報告はしていない。バウンティの範囲と条件は変わるため、着手時に最新のプログラム本文を読み直す。

## 事実: Hytale は Java サーバーを明示的に含む

| 項目 | 確認した内容 |
| --- | --- |
| 制度と窓口 | Hypixel Studios は公開バグバウンティを [Bugcrowd](https://bugcrowd.com/engagements/hypixel-studios-mbb-og) で運営し、脆弱性報告とその後のやりとりを同プログラムへ送るよう指定する。[Hytale Security](https://hytale.com/security) |
| 対象 | `Hytale Game Server (Java)` は「公式サーバーソフトウェアとホストされたサーバー」として明記される。ほかに `Game Client (C#)`、`Launcher (Go/Vue)`、指定 Web サイト、Hypixel の公開 API などが対象。[Hytale Security: Scope](https://hytale.com/security) |
| 対象外 | コミュニティ運営サーバーは、欠陥が Hytale の基本サーバー自体にある場合を除いて対象外。UGC、mod、サーバーセキュリティに影響しないチート・ゲーム exploit、ゲームバランスの問題も対象外。[Hytale Security: Exclusions / Scope](https://hytale.com/security) |
| 報奨 | P1 は $4,500–25,000、P2 は $3,500–7,500、P3 は $1,000–2,500、P4 は $300–600、P5 は報奨なし。18 歳以上のみ報奨を受け取れる。[Hytale Security: Ratings / Rules](https://hytale.com/security) |
| 運営状況 | [Bugcrowd のプログラム表示](https://bugcrowd.com/engagements/hypixel-studios-mbb-og/hall_of_fames)の検索可能な公開表示は、2026-02-24 開始、調査時点で `In progress` と示す。Hytale は 2026-07 のクライアント側の報告に $20,000 を支払ったと[公式更新記事](https://hytale.com/news/2026/5/hotfixes-update-5)で公表した。後者は一例で、Java サーバー調査の期待報奨や発見率を表さない。 |

報告には明確な再現手順、影響、必要最小限の PoC を求める。プログラムは低労力または AI 生成コンテンツを受け付けず、独自の分析と具体的な理解を要求する。したがって、AI が候補を探しても、提出前には人間が根拠と再現を確認し、人間の分析として報告内容を仕上げる必要がある。[Hytale Security: How to structure your report](https://hytale.com/security)

### Java と通信について既に公開されている技術情報

[公式 Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)（2026-10-12 更新）は、Java 25、最小 RAM 4 GB、自前の dedicated server の取得手段（Launcher からコピー、Downloader CLI、JAR からの bootstrap）、サーバー認証を説明する。クライアントとサーバーの通信は UDP 上の QUIC。packet の定義は `HytaleServer.jar` の `com.hypixel.hytale.protocol.packets` にあり、公式マニュアル自身が proxy 作成時の decode、inspect、modify、forward への利用を案内する。通信仕様を全てブラインドで推測する必要はない。[Hytale Server Manual: Server Setup / Building a Proxy](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)

protocol hash が一致しない client と server は接続を拒否される。[Update 6 の公式記録](https://hytale.com/news/2026/8/update-6-patch-notes)では `hytale/2` から `hytale/3` に変わり、packet の wire layout も更新された。[Update 8 の pre-release 記録](https://hytale.com/news/2026/10/pre-release-patch-notes-update-8)には dedicated server の transport が Netty から quiche へ変わったとある。従って、実験結果には client、server、asset、protocol の版と digest を固定して残す必要がある。後二文からの固定要件は設計上の推論である。[Hytale Server Manual: Protocol Updates](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)

### Shared Source の守秘条件

Hytale の server source と C# protocol files は「公開 GitHub のオープンソース」ではない。[Shared Source Agreement](https://hytale.com/shared-source-license)（2026-07-21 発効）は、有効なゲームアカウント、GitHub 連携、契約同意を経て私有 repository へアクセスすると定める。§6.1 は licensed materials を機密とし、有効アカウントと同契約を持たない相手への開示・利用可能化、および公開 repository への掲載を禁じる。§7.4 は契約上の用途に必要な範囲以外でのコピー・外部保存を制限する。[Shared Source Agreement §§2, 6, 7](https://hytale.com/shared-source-license)

契約本文には外部 AI provider へこの gated source を送ることの許可条件が明記されていない。クラウド AI にサーバー全ソースを投入する構想は、この守秘条件との整合を [Bugcrowd で事前に確認](https://hytale.com/security)するまでは未確定とする。これは文面からの慎重な推論であり、特定のサービス利用が必ず契約違反になると判断したものではない。[Shared Source Agreement §§3, 6, 7](https://hytale.com/shared-source-license)

## 事実: 通信解析と自動化の許可境界

- Hytale の公開規則は、自分のアカウントのみでの試験、他人のデータを扱わないこと、本番環境の安定性・完全性を損なわないことを求める。DoS、レート制限回避・スロットリング関連、ブルートフォースは報奨対象外。破壊的な後続行動につながり得ると分かった時点で、試験を止めて報告する。[Hytale Security: Program Rules / Exclusions](https://hytale.com/security)
- 一般向け [EULA §4](https://hytale.com/eula) と [ToS §4](https://hytale.com/terms-of-service) にはリバースエンジニアリング、bot、技術的保護の回避への制限がある。一方、[Security policy の Safe Harbor](https://hytale.com/security) は、その policy に沿うセキュリティ研究について、妨げとなる ToS 上の制限や DMCA 上の請求を限定的に免除すると記す。これをあらゆる通信解析・改変送信への包括的な許可とは読めない。
- 公開 Security ページには、パケット観測、プロトコル再実装、ファジング、自動スキャンの個別の上限や許可は書かれていない。解釈が必要な試験は、ページが案内するように [Bugcrowd 上で先に問い合わせる](https://hytale.com/security)。[Bugcrowd の研究者向け案内](https://docs.bugcrowd.com/researchers/participating-in-program/finding-program/)も、各プログラムの brief を試験前に読むよう求める。

ここからの実務上の推論は、最初の実験を自分が立てた非公開のローカル Hytale サーバーと自分のクライアント・アカウントに閉じることである。本番サービス、他人のコミュニティサーバー、他人のアカウントへ試験トラフィックを向ける必要が出たら、その行為の対象範囲と方法を再確認する。[Hytale Security](https://hytale.com/security)

## 比較候補

| 制度 | 一次資料で確認できる範囲 | Java サーバー研究への適合 |
| --- | --- | --- |
| **Hytale / Bugcrowd** | 公式 Java サーバーを明示して報奨対象に含める。[公式 Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)は自前サーバーの設置手順を公開する。[Hytale Security](https://hytale.com/security) | **最も直接的。** 対象と報奨が公開され、クライアント・サーバーの信頼境界を研究できる。ただし mod 固有の欠陥やチート単体では報奨にならず、共有ソースの守秘義務に注意が要る。 |
| **Riot Games** | 公式の[脆弱性報告ページ](https://www.riotgames.com/en/reporting-a-security-vulnerability)は、インターネットから利用できる Riot のサービスと自社製ソフトウェア、Web、サーバー、ゲームを広く対象とする。ただし金銭報奨の HackerOne プログラムは招待制で、最新範囲は同ページの HackerOne を参照するよう案内する。 | ゲーム通信やサーバーの研究に近いが、最初の公開・金銭報奨対象としては Hytale より条件が読みづらい。Java の対象が明記されているわけでもない。 |
| **Epic Games** | [公式 Security ページ](https://www.epicgames.com/site/security?lang=en-US)はサイト・製品の脆弱性をメールまたは HackerOne の報奨プログラムで受け付け、プログラム policy の確認を求める。 | ゲーム製品という点では近いが、当該ページだけでは個別ゲーム、クライアント、サーバーの報奨適格性と試験方法を確定できない。着手前に HackerOne の最新 scope が必要。 |
| **Scopely** | [HackerOne の公式更新](https://hackerone.com/scopely/updates?type=team)は 2026-09-09 のプログラム再開・scope 改訂、2026-01-13 の origin IP とゲーム内 UserID の申告、試験 HTTP ヘッダーを案内する。 | ゲーム backend と通信研究の比較先。ただし個別タイトル・報奨 tier・通信試験の条件は現行 policy を読むまで確定できず、Java サーバーを狙えると確認できていない。 |

**対象選びの判断:** 最初にゲームのクライアント・サーバー研究を試すなら、Java サーバーが明示された Hytale の、基本サーバーに起因するセキュリティ境界を選ぶ。報奨を目的とするなら、単なる通信仕様の解明やチートの発見ではなく、運営が規定する実際のセキュリティ影響を人間が再現できることを採否基準にする。[Hytale Security: Scope / Exclusions / Report requirements](https://hytale.com/security)

## 推論: Java サーバー研究の最小ハーネス

最初の境界は「自分が操作する通常クライアントから公式 Java サーバーへ」とする。観測したいのは QUIC 自体の脆弱性に限らず、接続・認証・world 参加の各状態で、クライアント由来の値がどの `ToServerPacket` と handler を通り、誰の権限で状態を変えるかである。公式の [Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual) と [Java API](https://docs.hytale.com/api/com/hypixel/hytale/protocol/ToServerPacket)を入口にする。以下は研究設計の提案であり、Hytale 運営が指定する試験方法ではない。

| 部品 | 最初の縦断実験に必要な仕事 |
| --- | --- |
| Programme Boundary と Snapshot | 現行の Bugcrowd brief と対象版を記録し、公式 `HytaleServer.jar`、`Assets.zip`、クライアント、Java 実行環境、protocol hash を digest で固定する。自動更新で実験途中の版が変わらないようにする。 |
| Lab | 使い捨ての隔離環境に公式サーバーを起動し、自分のテスト用アカウントだけを使う。セットアップ管理者、通常プレイヤー、状態を読む観測者の権限を分ける。通常の認証を調べる実験では、権限の異なる offline mode を同等の代替として扱わない。 |
| 通信ドライバ | 同じ版の正常接続を 1 本記録し、パケットの方向・順序・接続状態・主体を対応づける。公式 packet 定義で意味のある 1 フィールドまたは 1 状態遷移を限定して変える。送信量と時間を固定する。 |
| 判定と証拠 | 許可済み操作の正の対照、許可されない操作の負の対照を同条件で実行し、管理者 API や agent 自己申告から独立した世界・権限・保存状態の差、または nonce 付き canary を観測する。起動失敗、接続失敗、証拠不足は `incomplete` とする。crash だけでセキュリティ影響と判定しない。 |
| 記録と提出 | packet trace、ログ、認証情報、未公開の候補は Private Evidence に置き、台帳には digest 参照だけを残す。報告は人間が影響と再現性を確認した後に Bugcrowd へ提出する。[Hytale Security](https://hytale.com/security) |

クライアントを攻撃対象にする「悪意あるサーバー → C# クライアント」は別の信頼境界で、上の最初の縦断実験には混ぜない。網羅的な protocol fuzzer や独自 QUIC 実装は、正常接続と 1 件の判定可能な実験が通ってから評価する。旧世代の[方法論](../knowledge/imported/07-satoki/methodology.md)と[証拠境界の監査](../knowledge/imported/07-satoki/codexidea-thin-harness-risk-audit-2026-07-24.md)も、探索候補と独立した実行証拠を分ける必要を記録している。

## 現行 WordPress ランナーへの適用条件

[DEVELOPMENT.md 第 2 節](../DEVELOPMENT.md)は WordPress の Step 1 と検証・提出の整備を進行中とし、[PARKING.md](../PARKING.md) は第 2 Target Profile を WordPress の縦断ループ安定と固有要件の確認まで保留する。[ADR 0011](../adr/0011-target-specific-code-lives-in-a-profile.md)も第 2 profile ができる前の先回りした汎用化を避ける。従って今の本番ランナーに Hytale を追加せず、過去の [Hytale 専用試作](/home/dev/harness/game-bugbounty/README.md)を読み取り専用で棚卸しし、分離した小さな実験で固有要件を確認するのが筋である。

旧試作には JAR と Assets の固定、Java fixture、対照実験、headless client の実験がある。しかし、現存しない CLI への参照があり、通常の Docker を使う部分や fixture の自己報告に依存した判定もある。現行の [SPEC 第 2 節](../SPEC.md)が求める gVisor・外向き通信制限・独立判定器を満たすものとして、そのまま昇格できない。特に公式サーバーの認証には Hytale サービスとの通信が必要だが、現行 SPEC は外向きを provider API に限定する。この衝突と、gVisor 内の Java 25 / UDP・QUIC 動作、共有ソースを AI provider へ渡せるかが、新 profile の先行検証事項となる。権限・対象範囲を広げる決定は現行の [SPEC 第 2 節](../SPEC.md)に従って扱う。

### 追記: この PC の Windows / WSL の役割（2026-10-23）

[Hytale の公式案内](https://support.hytale.com/hc/en-us/articles/45305997507739-How-to-Download-and-Play-Hytale)はクライアントを Windows と Linux の双方に提供する。この PC では Windows 側に公式クライアントとサーバー配布物があり、WSL2 側に Docker Engine と登録済み `runsc` がある。Linux 側のソース閲覧・ビルド・Lab 管理には WSL の `/home/dev` を使い、GUI での通常操作と挙動把握には Windows クライアントを使うのが実務的である。Microsoft も Linux で使うファイルを WSL のファイルシステムに置くよう[推奨](https://learn.microsoft.com/en-us/windows/wsl/filesystems/)している。

この PC の WSL は NAT モードである。無害な UDP 疎通試験では Windows から WSL の `127.0.0.1` と WSL の private IPv4 のいずれへ送っても、WSL の受信器に datagram が届かなかった。これは Hytale / QUIC の接続試験ではなく、この環境の現在の経路についての観測である。[Microsoft の WSL 技術資料](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/localhost.md)も NAT モードの localhost 自動転送を TCP port について説明する。したがって旧試作の「Windows クライアント → WSL 内サーバーへ `localhost:UDP`」という経路は、現設定で動く前提にできない。Windows 11 の [mirrored networking](https://learn.microsoft.com/en-us/windows/wsl/networking)などを検討する場合も、既存ランナーへの影響と firewall 設定を踏まえ、変更後に正常接続を実測する。

現行 [SPEC 第 2 節](../SPEC.md)は対象を gVisor 内でのみ実行するので、Windows ホスト上のサーバー実行はこのリポジトリの Trial の代替にできない。WSL 側でサーバーと headless client を隔離ネットワーク内に置く構成なら Windows–WSL 間の UDP 経路を避けられるが、旧[試作スクリプト](/home/dev/harness/game-bugbounty/harness/spikes/hytale-headless-client/run.sh)は通常の Docker と異なる認証モードを使う。Java 25 と Hytale の QUIC が `runsc` 内で動くこと、公式認証の権限モデルを保てること、独立した判定が取れることはまだ確認していない。

## 未確認の仮定と既存知見

- Bugcrowd の [Hytale engagement](https://bugcrowd.com/engagements/hypixel-studios-mbb-og) はブラウザから全文を取得できず、この調査では Hytale 運営の [Security ページ](https://hytale.com/security)を詳細ルールの正本として読んだ。着手直前に Bugcrowd ログイン後の brief、更新履歴、試験上限を再確認する。
- Riot、Epic、Scopely の HackerOne 詳細 scope は JavaScript またはログインを要し、この調査では個別 asset の報奨適格性まで確認していない。上の比較は運営側が公開した記述の範囲に限る。[Riot](https://www.riotgames.com/en/reporting-a-security-vulnerability)、[Epic](https://www.epicgames.com/site/security?lang=en-US)、[Scopely](https://hackerone.com/scopely/updates?type=team)
- このリポジトリには過去の Hytale 専用世代の [Satoki-derived 方法論](../knowledge/imported/07-satoki/methodology.md) と [thin harness risk audit](../knowledge/imported/07-satoki/codexidea-thin-harness-risk-audit-2026-07-24.md) が保存されている。新しいゲーム用ハーネスを設計する前に、当時の試行数・失敗と証拠の境界を読み直す必要がある。この文書は新ハーネスの仕様を決めない。
