---
status: accepted
---
# provider認証情報は有界のegress brokerを通す

エージェントのコンテナへAPIキー、OAuthトークン、コンテナソケット、任意の外向き通信を渡さない。provider向けの通信は、runごとのinternal networkに接続したpinned sidecarが、固定upstream・exact model・deadline・request / byte上限を強制して中継する。grant receiptをrunの記録に含める。旧リポジトリADR 0142を引き継ぐ。Labへの到達はinternal network内に限る。
