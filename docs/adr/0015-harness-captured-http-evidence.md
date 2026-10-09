---
status: accepted
---
# 判定器のHTTP証拠をHarnessが捕捉する

## 決定

VerifierのLab HTTP宛先に、Harnessが管理する使い捨てのrunsc reverse proxyを置く。request / responseを上限付きJSON LinesとしてGit外のPrivate Evidenceに保存し、読出し系判定器はその記録を優先する。request側はrawに加えてURL、base64、hexのdecode後も調べる。捕捉が無い場合はVerifierの `http.json` を `agent-authored` の補助資料として使えるが、`runtime-confirmed` には引き続きHarness発行のnonce canary回収とsnapshot digest一致を要する。

台帳の `verification-finished.evidenceCapture` はoptionalな `harness-captured` / `agent-authored` のenumだけを記録する。HTTP本文、cookie、payloadは台帳やGitへ置かない。旧eventは変更せず読み続ける。

## 理由

Verifierが自分で書いた `http.json` だけでは、実際に送られたrequestを判定器が確かめられない。Lab側で捕捉すれば証拠の出所をHarnessが管理でき、反射されたsecretや意図しないrequestを除外できる。捕捉経路が使えない場合も証拠不足を隠さず、出所を区別して扱う。

## 採らなかった選択肢

- `http.json` だけを正式なHTTP証拠とする: Verifierの自己申告への依存が残る。
- Harnessがrequestを再生するreplayerを同時に作る: routeの構造化と安全な再生契約が別に必要で、confirmedの実例を得てからADR 0004の改訂として判断する。

## 帰結

汎用のrecorderはHTTP転送と記録の上限だけを担い、WordPress Labが配置とVerifierへの宛先を担う。捕捉記録の欠落や上限超過は証拠の不足として扱い、失敗を `contradicted` に丸めない。
