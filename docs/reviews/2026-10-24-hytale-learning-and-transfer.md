# Hytale Java サーバー研究の学習順序と WordPress 経験の移転（2026-10-24）

「調べて報告」の記録。2026-10-24 に確認した運営者・標準化団体の公開資料と、このリポジトリの既存記録を使う。正本や新 Target Profile の仕様ではない。実際の Hytale 試験、アカウント操作、報告はしていない。制度・技術資料は着手時に再確認する。前日の [対象範囲・ハーネス調査](2026-10-23-hytale-game-bounty-harness.md)を前提とする。

## 最初に理解する順序

1. **報奨対象となるセキュリティ影響。** [Hytale Security](https://hytale.com/security) は `Hytale Game Server (Java)` を対象に含める一方、サーバーのセキュリティに影響しないチート、ゲームバランス、mod 固有の問題、DoS を除外する。まず「誰が本来できない何をできるか」を、通常のゲーム挙動と区別できるようにする。自分のアカウントと自分が管理する環境に試験を限る。
2. **接続と権限の状態遷移。** 正常なクライアント接続が handshake → authentication → setup → game に移るとき、プレイヤーの身元がどこで確定し、権限とワールド参加状態がいつ使えるかを追う。公開 API の [HandshakeHandler](https://docs.hytale.com/api/com/hypixel/hytale/server/core/io/handlers/login/HandshakeHandler)、[SetupPacketHandler](https://docs.hytale.com/api/com/hypixel/hytale/server/core/io/handlers/SetupPacketHandler)、[GamePacketHandler](https://docs.hytale.com/api/com/hypixel/hytale/server/core/io/handlers/game/GamePacketHandler)を入口にする。[Server Provider Authentication Guide](https://support.hytale.com/hc/en-us/articles/45328341414043-Server-Provider-Authentication-Guide)にある**サーバー自身の認証**と、参加する**プレイヤーの認証**を混同しない。
3. **アプリケーションのパケットと処理。** [Packet](https://docs.hytale.com/api/com/hypixel/hytale/protocol/Packet) と [ToServerPacket](https://docs.hytale.com/api/com/hypixel/hytale/protocol/ToServerPacket) から方向・型・意味を読み、正常な 1 操作について `client → packet → handler → 権限判定 → 状態変更 → 応答` を手でたどる。[Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)は UDP/QUIC と `HytaleServer.jar` 内の packet 定義を説明し、proxy での decode/inspect を案内している。[QUIC の標準](https://www.rfc-editor.org/rfc/rfc9000.html)は通信層の背景として読む。最初から QUIC 実装や全パケットの解析を完了させる必要はない。
4. **Java サーバーの状態と実行条件。** Java 25、ワールドの状態、保存、スレッド境界、権限モジュールを、選んだ操作に必要な範囲で読む。通信上の値が「その接続の主体」に結びついているか、別のプレイヤーやサーバー権限の値を使えてしまうかを考える。版と protocol hash が変わるため、再現では client・server・asset・Java 実行環境を固定する。[Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)、[PermissionsModule](https://docs.hytale.com/api/com/hypixel/hytale/server/core/permissions/PermissionsModule)
5. **独立した観測と報告。** 許可される操作と許可されない操作を対照にし、別主体または保存状態から結果を読む。クラッシュやエージェントの自己申告だけで脆弱性としない。報告には再現手順、実際の影響、必要最小限の証拠を示す。[Hytale Security](https://hytale.com/security)

最初の練習は、公開資料と手元で正当に利用できる配布物を使って、**正常な 1 操作だけ**について主体・packet・handler・権限・効果を図示すること。この段階ではファザーも新ハーネスも要らない。コードを使う段階になったら、共有ソースの [守秘・コピー制限](https://hytale.com/shared-source-license)を確認する。公開 Javadoc と契約下の非公開ソースを同一視せず、後者を外部 AI へ渡す許可条件は未確認と扱う。

## WordPress の経験はどこまで役立つか

| 領域 | 移せる知識 | Hytale で改めて学ぶ・作るもの |
| --- | --- | --- |
| 脆弱性理解 | 非信頼入力、主体と権限、認可抜け、到達効果、対照実験という見方はそのまま使える。 | HTTP/PHP の endpoint と nonce の代わりに、接続状態、packet handler、プレイヤー権限、ワールド状態を追う。 |
| 探索の制御 | 対象範囲、Snapshot/digest、隔離、出力保存、`incomplete`、人間のレビューという境界は有効。 | Hytale の版取得、ライセンス確認、認証済み UDP/QUIC Lab、Java サーバー固有の観測器・判定器。 |
| 既存コード | [snapshot](../../src/snapshot/index.ts) と [verification](../../src/verification/index.ts) の profile 境界は参考になる。 | [lab](../../src/lab/index.ts)、[review export](../../src/review/export.ts) 等は HTTP・WordPress 前提を含み、そのまま流用できない。PHP 判定器と WP role/option の知識も移植できない。 |
| 運用上の教訓 | [LESSONS](../LESSONS.md) の「判断は prompt/skill、Harness は制御」「候補数と報奨を混同しない」「ハーネス作りを長引かせない」は特に重要。 | ゲーム固有の信頼境界を 1 件の実験で確かめるまで、汎用 interface や網羅的な packet 索引を増やさない。 |

現行 [SPEC](../SPEC.md) は対象を gVisor 内でのみ実行し、外向き通信を provider API に制限する。Hytale の正常なサーバー認証には Hytale サービスとの通信が必要で、ここに未解決の設計上の衝突がある。[PARKING](../PARKING.md) は第 2 Target Profile を WordPress の縦断ループ安定と固有要件の確認まで保留している。従って、この調査は現行本番ランナーを改造する根拠ではない。

## 「WordPress より脆弱性がぽんぽん出るか」の判断

- [WordPress.org](https://wordpress.org/plugins/) は無料プラグインを 76,000 超と表示する。[Patchstack の 2025 年集計](https://patchstack.com/whitepaper/state-of-wordpress-security-in-2026/)は WordPress 生態系で新規 11,334 件、その 91% がプラグインと報告する。ただしこれは広い生態系全体の公開件数であり、同じ研究者が同じ時間を投じて報奨対象を何件見つけるかを示さない。現行 WordPress ハーネスでも、2026-10-21 時点の [Finding 69 件](2026-10-21-selection-to-discovery-check.md)は重複・検証前の候補であって、確定した脆弱性や報奨ではない。
- [Bugcrowd CrowdStream](https://bugcrowd.com/engagements/hypixel-studios-mbb-og/crowdstream) の検索可能な公開表示には、Hytale Game Server の P3 受理（2026-07-22）と P2 受理（2026-08-25）がある。従って「出ない」とは言えない。表示されるのは一部の公開受理イベントだけで、投入時間、全提出、重複、非公開の受理、支払いを含まない。
- **推論:** 多数の独立した WordPress プラグインを横断する探索と比べ、Hytale の単一の公式 Java サーバーに限定した研究では、短時間に新規報奨候補が繰り返し出ると期待しない方がよい。認証済み通信と状態遷移を理解する初期費用もある。ただし、コード規模・更新頻度・研究者の熟練度の違いを測っていないため、発見率の数値や「何倍難しい」といった主張はできない。

## 次の判断点

まずは **1 件の正常な client→server 操作を、公開 API から状態変更まで説明できるか**を確認する。その後、現行 WordPress ランナーの Step 1 と第 2 profile の保留条件を踏まえ、gVisor 内の Java 25 / QUIC、公式認証、外向き通信、独立判定の実現可能性を分離した小さな実験で確認する。ハーネスの大規模な追加は、その結果が出てから判断する。
