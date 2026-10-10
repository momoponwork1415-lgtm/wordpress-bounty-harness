---
status: accepted
---

# Stored XSS 判定器は Finding が宣言する被害者ロールと画面で発火を観測する

## 決定

Stored XSS の判定器は、固定の訪問先（front、`/wp-admin/`、`/wp-admin/edit.php`、未認証の route path）に加えて、Verifier の `route.json` が宣言する被害者ロールと到達経路を、そのロールでログインした Lab のブラウザで開く。

- `route.json` に `victim` 欄を加える。値は Lab が持つロール（`administrator`、`subscriber`、`customer`、`unauthenticated`）と、そのロールが開く経路の列。経路は最大 5 件。
- 発火 context は既存の `front` / `admin-all` / `admin-partial` / `route-page` に `victim-route-page` を加えて記録する。`siteWide` の記録は変えない。
- Wordfence と Patchstack の対象範囲の判定は引き続き scope 段階で行い、判定器は観測だけを記録する（ADR 0010、ADR 0017）。
- alert の有無、文字列の存在、ブラウザ操作なしの自己申告は引き続き証拠にしない。canary の回収だけが証明である（不変条件 3）。

## 理由

ADR 0017 で Wordfence 向けの site-wide 条件は scope 段階へ移したが、観測側の `observeStoredScript` は route path を未認証でしか開かない。被害者が管理者で、画面がプラグイン固有の管理画面である Stored XSS は、Verifier が canary を置けても判定器が観測できず、`runtime-confirmed` に到達する経路が設計上存在しない。2026-10-10 の tp326-wp2-comment-c1 の XSS 検証は、管理者の操作を要する前提で `incomplete` になった。被害者の文脈は脆弱性ごとに異なるので、判定器の固定リストではなく Finding 側の宣言で決める。

## 採らなかった選択肢

- 管理画面の全 URL を判定器が巡回する: 画面数が対象ごとに不定で、プラグイン固有の操作を伴う画面は巡回で到達できない。
- Verifier に管理者セッションで操作させて自己申告させる: 不変条件 3 に反する。被害者ロールでの訪問は Harness の観測器だけが行う。

## 既存決定との関係

- SPEC 第7節の Stored XSS 行に「Finding が宣言する被害者ロールの画面」を加える。ADR 0004 の「判定器は Harness 所有・決定論的」は変えない。
- ADR 0020 のシナリオと組み合わせ、被害者が開く画面に必要な通常機能の状態はシナリオで用意する。

## 帰結

- 判定器 fixture のテストを更新し、Lab のブラウザ観測を実機で 1 回通した記録を残す。
- 受入条件: 記録済みの tp326-wp2-comment-c1 の XSS Finding を ADR 0020 のシナリオと合わせて再検証する。
