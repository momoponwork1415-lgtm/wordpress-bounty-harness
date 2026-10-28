# 監視報告（2026-10-21）

依頼文は `docs/reviews/2026-10-21-monitor-brief.md`。所有者の追加の指示（2026-10-21 03:00 JST）は「対象選定などが自動で回り続けているかを確かめ、止まっていれば復旧する」。復旧は本番 runner に限り、実験側には手を出さない。

## 03:02 JST

1. 実験（os wave）: mwwpform / kirki / c2c の 3 本が `discovery-run-started` まで進んでいる（02:47 開始で経過 15 分）。`finished` はまだ無い。同時に走っているのは 3 本で、上限を超えていない。
2. 実験で終わった case: まだ無い。
3. 本番: runner は pid 591540 で `running`（稼働 25 時間）、campaign は prod-20261020-4。並列は 6 / claude 0 / codex 3。選定は自動で回っている（2026-10-20 だけで 4 batch、37 件を選定）。
   - prod-20261020-4 の 7 件の内訳
     - completed 2 件: wp-whatsapp-chat 8.6.6（60 分）、backup 3.1.24.10（61 分、Lead 4）
     - failed(provider) から `target-skipped(provider-refused)` になったもの 2 件: search-regex 3.5.1（16 分）、vk-blocks 1.129.0（21 分）
     - 走っているもの 3 件: contact-form-7-dynamic-text-extension 5.0.7（36 分）、real-cookie-banner 5.4.0（13 分）、pretty-link 4.0.17（13 分）
   - 本日の累計: Trial 53、completed 42、provider-limited 3、provider-refused 9、findings queue 34、parked 0。
4. 異常の兆候
   - 実験の campaign.log と continuous.log には、ZodError / cyber-policy / refusal / model-not-admitted の語が無い。
   - 要確認: Codex の `failed(provider)` から `provider-refused` へのスキップが、2026-10-20 の 4 batch で計 7 件ある（copy-delete-posts、wpconsent、qi-addons、cartflows、search-regex、vk-blocks ほか）。率は約 13%。
   - free は 12 GiB（available は 39 GiB）、disk の残りは 260 GB、load は 2.3。
   - コンテナは claude-agent 3 と codex-agent 3 で合計 6 本。上限内に収まっている。本番の verify Lab（`wbh-*` 4 本）が Up している。
5. 開発側へ: Codex の provider-refused 率を追う。reason が `provider` しか無いので、cyber-policy と他の拒否を台帳で区別できるかを確かめる必要がある。
   - 03:05 の追記: reasonDetail を見ると、7 件はどれも `provider-cyber-policy` だった。

## 03:05 JST 操作者の再開（所有者の指示による）

所有者の指示（「止まったものは再開してあげないといけない」）に従い、`provider-cyber-policy` で止まり、まだ再開していない v8 の Codex run 7 本を `campaign resume` で再開した（ADR 0036）。Codex の同時数が 4 を超えないよう、1 本ずつ順に実行している。

- 再開の対象: vk-blocks、search-regex、cartflows、qi-addons-for-elementor、wpconsent-cookies-banner-privacy-suite、copy-delete-posts、custom-twitter-feeds
- 再開しなかったもの
  - 再開後に再び拒否された 2 本: google-analytics-dashboard-for-wp、enable-media-replace
  - Claude の `provider-refusal`: breeze。規則では終了とする
  - v5 期の run
- 実行の記録: スクリプトは scratchpad の `resume-seq.sh`、log は `resume-seq.log`
- 1 本目の vk-blocks は、03:05 に segment 7b5da0d7（`resumesRun` は 21491a93）として始まった

## 03:34 JST

1. 実験（os wave）: mwwpform / kirki / c2c はどれも `discovery-run-started` で、経過 46〜47 分。`finished` はまだ無い。同時に走っているのは 3 本。
2. 実験で終わった case: まだ無い。
3. 本番: runner は running（pid 591540）。
   - contact-form-7-dynamic-text-extension 5.0.7 が completed（61 分、子 4、Lead 4、Finding 0）。
   - 次の対象に wp-asset-clean-up 1.4.0.6 が自動で選ばれ、03:26 に始まった。
   - 走っているもの: real-cookie-banner と pretty-link（45 分目）、wp-asset-clean-up（7 分目）。
   - 本日の累計: Trial 54、completed 43。unsettled 4 には、再開中の vk-blocks の segment が含まれる。
4. 再開: vk-blocks の segment は 29 分目に入り、正常に走っている。残りの 6 本はその後に順番に回る。
5. 異常の兆候
   - log に該当する語は無い。
   - エージェントのコンテナは claude 3 と codex 4 で、計 7 本。依頼文にある 6 本の閾値を超えているが、これは操作者の再開による 1 本で、想定どおり。
   - free は 11 GiB（available 38 GiB）、disk の残りは 260 GB、load は 2.1。

## 04:06 JST

1. 実験（os wave）: 前半の 3 本は exit=0 で終わり、後半の 3 本が順に始まった。同時に走っているのは 3 本。
   - wpvivid: 03:48 に開始し、17 分目。
   - checkemail: 03:58 に開始し、8 分目。
   - forminator: 04:00 に開始し、5 分目。
2. 実験で終わった case（arm=os。Root は Opus 5.5 high、子は Sonnet 5.5 high。台帳の runtime で確認した）

   | case | 結果 | Root wall | 子 | Finding（範囲内 / parked） | Lead | 非 cache token（input / output） | 停止理由 |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | c2c（cm-c2c-os-1021-r1） | completed | 61 分 | 18 | 0 / 0 | 7 | 802 / 237,745 | 最終報告 |
   | mwwpform（cm-mwwpform-os-1021-r1） | completed | 71 分 | 11 | 0 / 0 | 4 | 814 / 494,586 | 最終報告 |
   | kirki（cm-kirki-os-1021-r1） | completed | 73 分 | 16 | 13 / 0 | 16 | 1,760 / 591,667 | 最終報告 |

3. 本番: runner は running。
   - real-cookie-banner 5.4.0 が completed（61 分、Lead 5）。pretty-link 4.0.17 も completed（61 分、Lead 2）。
   - 新しく自動で選ばれた filester 2.1.4 と wp-parsidate 6.4 が、03:50 に始まった。wp-asset-clean-up は 40 分目。
   - 本日の累計: Trial 56、completed 46、findings queue 42。
4. 再開
   - vk-blocks の segment 7b5da0d7 は completed で終わった（41 分。元の 21 分と合わせて 62 分）。Finding は 4 件。
   - 2 本目の search-regex（011a4f5c）は 03:46 に再開した。
5. 異常の兆候
   - 該当する語は無い。
   - エージェントのコンテナは計 7 本（再開の 1 本を含む）。
   - free は 9 GiB（available 39 GiB）、disk の残りは 257 GB、load は 1.6。
   - 本番の verify は 3 件とも incomplete（03:52〜04:02）。いつもの傾向と同じ。

## 04:39 JST

1. 実験（os wave）: 後半の 3 本が走っている。同時に走っているのは 3 本。
   - wpvivid: 50 分目
   - checkemail: 41 分目
   - forminator: 38 分目
2. 実験で終わった case: 前回から増えていない（3 本）。
3. 本番: runner は running。
   - wp-asset-clean-up 1.4.0.6 が completed（61 分、子 4、Finding 0、Lead 0）。
   - batch prod-20261020-4 の 10 件をすべて使い切った。残りの filester と wp-parsidate（49 分目）が終わると、次の batch が自動で選ばれる見込み。前回までの batch の境界と同じ動き。
   - 本日の累計: Trial 56、completed 47。
4. 再開: search-regex の segment b1f7c821 は 52 分目で走っている。残りの 5 本はまだ始めていない。
5. 異常の兆候: 無い。エージェントのコンテナは claude 3 と codex 3（runner 2、再開 1）。

## 05:12 JST

1. 実験（os wave）: 7 件目の seopress が 04:52 に始まり、19 分目。os 群で残っているのはこの 1 本だけ。oh 群は os 群が全部終わってから始まる。
2. 実験で終わった case（arm=os、すべて exit=0）。token は wave の最後にまとめて表に出す。

   | case | 結果 | Root wall | 子 | Finding（範囲内 / parked） | Lead |
   | --- | --- | --- | --- | --- | --- |
   | wpvivid | completed | 62 分 | 13 | 0 / 0 | 23 |
   | checkemail | completed | 68 分 | 16 | 8 / 0 | 10 |
   | forminator | completed | 67 分 | 18 | 4 / 1 | 34 |

3. 本番: runner は running。
   - batch prod-20261020-4 は、filester（61 分、Lead 2）と wp-parsidate（60 分、Lead 1）が completed になって終わった。
   - 04:58 に新しい batch prod-20261020-5 が自動で選ばれた。
   - 走っているもの（13 分目）: official-mailerlite-sign-up-forms 1.7.26、aruba-hispeed-cache 3.1.0、contact-form-7-simple-recaptcha 0.2.0。
   - 本日の累計: Trial 59、completed 49。
   - 自動選定が batch の境界を越えて続いていることを確かめた。
4. 再開: search-regex の segment は 85 分目で走っている。残りは 5 本。
5. 異常の兆候: 無い。free は 8 GiB（available 40 GiB）、disk の残りは 255 GB。

## 05:44 JST

1. 実験（os wave）: seopress が 52 分目。os 群で残っているのはこの 1 本。終わった case は前回と同じ 6 本。
2. 本番: runner は running。batch prod-20261020-5 の 3 本は 46 分目。本日の累計は Trial 59、completed 51（再開した segment の完了を含む）。
3. 再開した run の結果（台帳で数えた）

   | 対象 | segment | 結果 | wall（元＋再開） | 子（合計） | Finding | Lead |
   | --- | --- | --- | --- | --- | --- | --- |
   | vk-blocks | 7b5da0d7 | completed | 21＋41＝62 分 | 13 | 8 | 0 |
   | search-regex | b1f7c821 | completed | 16＋95＝111 分 | 20 | 0 | 5 |
   | cartflows | 42a25f8b | completed | 44＋20＝64 分 | 5 | 0 | 6 |
   | qi-addons-for-elementor | 88a70de6 | 05:43 に再開して走っている | — | — | — | — |

   - 04:06 の節で vk-blocks の Finding を 4 件と書いたが、それは segment だけの数だった。対象の合計は 8 件。
   - 3 本とも再び拒否されることなく completed まで届いた。残りは wpconsent、copy-delete-posts、custom-twitter-feeds の 3 本。
4. 異常の兆候: 無い。free は 8 GiB（available 40 GiB）、load は 1.2。

## 06:17 JST

1. 実験
   - os 群: 05:55 に `all done ... arm=os` が出た。
   - oh 群（Root は Opus、子は Haiku）: mwwpform / kirki / c2c が 05:56 に始まった。
     - mwwpform-oh は 06:11 に end（exit=0）。
     - 続けて wpvivid-oh が 06:12 に始まった。
     - kirki-oh と c2c-oh は 21 分目。
   - 同時に走っているのは 3 本。
2. 実験で終わった case（追加分）
   - seopress-os: incomplete(provider: provider-refusal)。Root wall 63 分、子 18、Finding 0、Lead 6。
   - mwwpform-oh: incomplete(provider: provider-refusal)。Root wall 15 分、子 4、Finding 0、Lead 8。最低の 60 分に届いていない。
   - **要確認**
     - Claude Root の拒否が 2 本続いた。規則では Claude の `provider-refusal` は終了とするので、再開しない。
     - mwwpform-oh は 15 分で止まった。これを 0 件の比較に入れるかどうかは、開発側が判断する。正常な候補 0 件には数えない。
3. 本番: runner は running。
   - batch prod-20261020-5 の最初の 3 本が completed（いずれも 61 分）。
     - official-mailerlite-sign-up-forms: Finding 3、Lead 2
     - aruba-hispeed-cache: 0
     - contact-form-7-simple-recaptcha: 0
   - 06:00 に次の 3 本が自動で始まった（17〜18 分目）: content-views-query-and-display-post-page 4.5.1.2、white-label-cms 2.7.14、one-user-avatar 2.5.6。
   - 本日の累計: Trial 62、completed 55、findings queue 45。
4. 再開
   - qi-addons-for-elementor の segment 88a70de6 は completed（58＋5＝63 分。最低の 60 分に届いた時点で終わった）。
   - 5 本目の wpconsent は 05:48 に再開して走っている。残りは copy-delete-posts と custom-twitter-feeds。
5. 異常の兆候
   - free は 3 GiB で、閾値の 8 GiB を下回っている。ただし available は 39 GiB で、減った分は buff/cache が 37 GiB に増えたためなので、実害は無いと見ている。
   - disk の残りは 252 GB、load は 2.0。
   - エージェントのコンテナは claude 3 と codex 4（再開 1 を含む）。

## 06:51 JST

1. 実験（oh 群）: 同時に走っているのは 3 本。
   - kirki-oh と c2c-oh: 54 分目
   - wpvivid-oh: 39 分目
   - 終わったものは、前回と同じ mwwpform-oh（拒否で 15 分）だけ。
2. 本番: runner は running。
   - white-label-cms 2.7.14 が failed(provider: provider-cyber-policy) で止まった（40 分、Lead 1）。
   - その枠に ele-custom-skin 4.3.13 が自動で選ばれ、06:40 に始まった。
   - content-views と one-user-avatar は 50〜51 分目。
3. 再開の結果

   | 対象 | 結果 | wall（元＋再開） |
   | --- | --- | --- |
   | wpconsent | 再び provider-cyber-policy で止まった | 13＋33 分 |
   | copy-delete-posts | completed | 44＋18＝62 分 |
   | custom-twitter-feeds | 06:40 に再開して走っている | — |

4. 再開を続けるための仕組み（所有者の指示「止まったものは再開する」を、この先も続けるため）
   - scratchpad に `resume-watch.sh` を置き、起動した。
   - 対象: 10-20 以降の v8 の Codex Root のうち、`provider-cyber-policy` で止まり、まだ再開していないもの。
   - 動き
     - 最初の再開リスト（`resume-seq.sh`）が終わってから動き出す。
     - 5 分ごとに 1 本ずつ再開する。
     - 再開した segment がまた拒否された場合は、もう再開しない。
     - `campaign resume` が拒否したもの（exit 3）は、2 回目からは試さない。
   - log は `resume-watch.log`。最初に再開するのは white-label-cms の予定。
5. 異常の兆候: log に該当する語は無い。free は 3 GiB（available 39 GiB）、load は 0.9。

## 07:25 JST

1. 実験（oh 群）: 同時に走っているのは 3 本。
   - checkemail-oh: 07:03 に開始し、21 分目
   - forminator-oh: 07:08 に開始し、16 分目
   - seopress-oh: 07:14 に開始し、10 分目。これが最後の case。
2. 実験で終わった case（arm=oh、いずれも exit=0）

   | case | 結果 | Root wall | 子 | Finding（範囲内 / parked） | Lead |
   | --- | --- | --- | --- | --- | --- |
   | c2c-oh | completed | 66 分 | 15 | 0 / 0 | 17 |
   | kirki-oh | completed | 72 分 | 15 | 0 / 0 | 37 |
   | wpvivid-oh | completed | 62 分 | 14 | 11 / 0 | 31 |

3. 本番: runner は running。
   - content-views（61 分、Lead 3）と one-user-avatar（61 分、Lead 2）が completed。
   - ele-custom-skin 4.3.13 が provider-cyber-policy で止まった（31 分）。
   - 自動で選ばれた independent-analytics 2.16.0、favicon-by-realfavicongenerator 1.3.52、pojo-accessibility 4.1.4 が走っている（13〜24 分目）。
4. 再開
   - custom-twitter-feeds は completed（41＋23＝64 分、Finding 4）。これで最初の 7 本が終わった。
     - completed: 6 本（vk-blocks、search-regex、cartflows、qi-addons、copy-delete-posts、custom-twitter-feeds）
     - 再び拒否: 1 本（wpconsent）
   - `resume-watch.sh` が 07:03 に white-label-cms を再開し、走っている。次は ele-custom-skin を再開する。
5. 異常の兆候
   - log に該当する語は無い。
   - free は 0 GiB だが、available は 38 GiB（buff/cache が 40 GiB）。swap は使っていない。
   - load は 3.0。

## 07:58 JST

1. 実験（oh 群）: 同時に走っているのは 3 本で、残りもこの 3 本。
   - checkemail-oh: 55 分目
   - forminator-oh: 49 分目
   - seopress-oh: 43 分目
2. 本番: **Codex の quota 上限に当たった。**
   - 07:01 前後に始まった 3 本が、いずれも `provider-limited(cli-exit:1)` で止まった。止まったのは 07:01〜07:11 から 25〜36 分目。
     - independent-analytics
     - favicon-by-realfavicongenerator
     - pojo-accessibility
   - 07:37 に batch prod-20261020-5 が `campaign-stopped(provider-limit)` で止まった。
   - continuous.log に `backoff until=2026-10-20T23:07:31Z（08:07 JST） providerLimit=quota` が出ている。
   - runner の state は `backoff`（pid 591540 は生きている）。
   - ADR 0036 の追記 4 により、runner は backoff の後に同じ Trial を自動で再開する。08:07 以降にそれが起きるかどうかを次回に確かめる。止まったままなら復旧する。
3. 再開
   - white-label-cms は exit 0 で終わった（07:27）。
   - ele-custom-skin は 07:32 に再開を始めたが、quota 上限に当たって exit 3 で終わった。
   - 不具合を見つけた: `resume-watch.sh` が exit 3 の run を「再開不可」の一覧に入れていた。ele-custom-skin は quota のせいで失敗しただけなので、一覧から外した。
   - `resume-watch.sh` を直して起動し直した（pid 4060036）。
     - runner が `backoff` の間は再開しない。上限を待つ runner と quota を取り合わないため。
     - provider-limit で失敗したものは、後でもう一度試す。
4. 異常の兆候
   - 上記の quota 上限。
   - Codex のコンテナは 0 本。
   - free は 2 GiB（available 40 GiB）、load は 1.1。

## 08:15 JST

1. 本番: runner は 08:07 に backoff を終え、prod-20261020-5 を再開した。しかし 08:08 に再び provider-limit（quota）に当たった。
   - 次の待ちは 60 分の backoff（step 2）で、09:08 JST まで。
   - runner のプロセスは生きていて、設計どおりに待っている。止まってはいないので、復旧の操作はしていない。
   - 原因は Codex の quota が尽きたことなので、待つほかない。
   - 本日の累計: Trial 63、completed 60、provider-limited 10、provider-refused 11、findings queue 49。
2. 実験
   - forminator-oh は exit 0 で終わった（08:15）。
   - checkemail-oh と seopress-oh が走っている。Claude のコンテナは 2 本。
3. 再開: `resume-watch.sh` は runner の backoff 中なので待っている。
4. 開発側へ
   - Codex の quota が尽きている間は、本番の探索は止まる。
   - 実験が終われば Claude の枠（`.claude` は 0）を 3 に戻す予定になっている。そうすれば Opus 側で探索を続けられる。
   - これは所有者の作業（依頼文 B）なので、このセッションでは変えていない。

## 08:48 JST 実験の最終表（`all done ... arm=oh` 2026-10-20T23:42Z）

- 全 14 本が exit=0。prompt は wp2shell-bounty-v8、Lab は無い。Root は Opus 5.5 high。子は os が Sonnet 5.5 high、oh が Haiku 5.5 high（`ledger runtime` で確認した）。
- 非 cache token は input / output で示す。cached input は別に添える。
- Finding は `finding-recorded` の件数で、parked はその内数ではなく別に数えた。

| case | arm | 結果 | Root wall | 子 | Finding | parked | Lead | 非 cache in / out | cached in | 停止理由 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mwwpform | os | completed | 71 分 | 11 | 0 | 0 | 4 | 814 / 494,586 | 38.3M | 最終報告 |
| kirki | os | completed | 73 分 | 16 | 13 | 0 | 16 | 1,760 / 591,667 | 80.3M | 最終報告 |
| c2c | os | completed | 61 分 | 18 | 0 | 0 | 7 | 802 / 237,745 | 25.2M | 最終報告 |
| wpvivid | os | completed | 62 分 | 13 | 0 | 0 | 23 | 1,138 / 470,354 | 42.7M | 最終報告 |
| checkemail | os | completed | 68 分 | 16 | 8 | 0 | 10 | 1,244 / 592,878 | 55.8M | 最終報告 |
| forminator | os | completed | 67 分 | 18 | 4 | 1 | 34 | 2,738 / 862,802 | 187.2M | 最終報告 |
| seopress | os | incomplete(provider: provider-refusal) | 63 分 | 18 | 0 | 0 | 6 | 1,246 / 365,975 | 53.3M | Claude の拒否 |
| mwwpform | oh | incomplete(provider: provider-refusal) | 15 分 | 4 | 0 | 0 | 8 | 308 / 350,599 | 17.4M | Claude の拒否（最低 60 分に届いていない） |
| kirki | oh | completed | 72 分 | 15 | 0 | 0 | 37 | 2,428 / 1,502,664 | 154.3M | 最終報告 |
| c2c | oh | completed | 66 分 | 15 | 0 | 0 | 17 | 1,434 / 925,101 | 74.4M | 最終報告 |
| wpvivid | oh | completed | 62 分 | 14 | 11 | 0 | 31 | 1,586 / 1,152,529 | 72.1M | 最終報告 |
| checkemail | oh | completed | 98 分 | 10 | 2 | 1 | 39 | 1,516 / 1,167,001 | 105.8M | 最終報告 |
| forminator | oh | completed | 66 分 | 17 | 8 | 0 | 40 | 3,034 / 1,528,938 | 175.6M | 最終報告 |
| seopress | oh | completed | 70 分 | 20 | 0 | 0 | 18 | 2,476 / 1,271,912 | 135.5M | 最終報告 |

集計（拒否で止まった 2 本を含む）

| arm | Finding | Lead | output token | completed |
| --- | --- | --- | --- | --- |
| os | 25 | 100 | 3.62M | 6/7 |
| oh | 21 | 190 | 7.90M | 6/7 |

- kirki と wpvivid は arm によって Finding の出方が逆になった（kirki は os 13 / oh 0、wpvivid は os 0 / oh 11）。
- 中身の評価（重複、検証）は開発側の仕事なので、ここでは件数だけを書く。

本番: runner は backoff（quota、step 2）で、09:08 JST まで待つ。依頼文の終了条件に達したので、この後は本番だけを 1 時間ごとに観測する。所有者が `.claude` を 3 に戻すと、Opus の探索が始まる。

## 09:16 JST

1. 本番: 09:08 に backoff を終えて再開したが、09:09 に再び quota 上限に当たった。
   - 3 回続いたので、backoff は step 3 の 360 分になった。待ちは 15:09 JST まで。
   - runner のプロセスは生きている。
   - Codex のコンテナは 0 本で、探索は止まっている。
2. 選択肢（どれにするかは所有者が決める）
   - backoff は batch 全体を待たせる（OPERATIONS 151 行）。このため、`.claude` を 3 にしても、backoff が明けるまで Opus は始まらない。
   - Opus を今すぐ回したいときは、`runtimeShare: {codex: 0, claude: 100}` の別の campaign 設定と別の campaign ID で `campaign run` を手で回す。OPERATIONS に書かれている手順。
   - 何もしなければ、15:09 に runner が自動で再開する。
3. 再開: `resume-watch.sh` は backoff の間、待っている。

## 10:10 JST 所有者の選択「Opus を別に回す」

- runner は Codex の quota で backoff 中（step 3、15:09 JST まで）。その間、OPERATIONS 151 行の手順で Opus を手動で 3 本起動した。
  - 設定は `campaign-production-opus.json`（runtimeShare は claude 100、対象 1）。selection は本番と同じ方針 file。
  - opus-prod-20261021-1: easy-table-of-contents 2.0.89（10:07 に開始）
  - opus-prod-20261021-2: gotmls 4.23.90（10:08 に開始）
  - opus-prod-20261021-3: tiny-compress-images 3.8.1（10:09 に開始）
  - いずれも `discovery-run-started` を確認した（claude-code/v1、v8）。
  - 出力の置き場は `~/.local/state/wordpress-bounty-harness/opus-manual-20261021/`。
- 対象の選び方
  - 選定を確かめるために `select` を 1 回走らせた。これは台帳に選定 batch `selection-61c86c1e`（10 件の target-selected と 7 件の target-skipped）を追記した。campaign には束縛されていない。
  - その上位 10 件のうち、independent-analytics、favicon、pojo-accessibility の 3 件は、runner が backoff の後にやり直す対象なので除いた。
  - 残りの上位 3 件を手で名指しした。
- 要確認
  - 束縛されていない選定 batch が台帳に 1 つ増えた。2026-10-17 と同じように、runner が次の batch で `holding-error` を出すかどうかを見る。

## 10:36 JST runner の切り替え（所有者の指示）

- PR #427 を merge した（4a339e9）。子モデルを Root と別に選べるようになった。
- 新しい本番 checkout: `/home/dev/wordpress-bounty-harness-prod19`（4a339e9、build 済み）。
- 新しい host 設定: `host-production-v7.json`。v6 の Claude profile を `claude-opus-root-sonnet-child-high`（Root opus high ＋ 子 sonnet high）に替えた。`runtime check` は ok。
- campaign 設定 `campaign-production-mixed-6.json` の変更点（元の file は `*.before-sonnet-20261021.json` に残した）
  - runtimeShare を {codex: 0, claude: 1} にした。Codex の quota が尽きているため。
  - 同時数の上限を claude 4 / codex 3 / 合計 7 にした。所有者の判断「4 並列で行けると思う」による。
- 切り替えの流れ
  - 旧 runner（pid 591540）に `continuous stop` を打ち、10:33 に止まった。
  - prod19 から `--resume` で起動し直した（pid 4124637、出力は `continuous-20261021.out`）。
  - prod-20261020-5 の残りの対象が、10:36 に Claude で始まった。
- 同時数
  - Codex は 0。
  - Claude は「4 − 手動 Opus の本数」。scratchpad の `claude-ramp.sh` が 1 分ごとに合わせ、手動の 3 本が終わると 4 になる。
- `resume-watch.sh` は、Codex の同時数が 0 の間は再開しない。
- Codex の quota が戻ったら、runtimeShare を {codex: 1, claude: 1}、`.codex` を 3 に戻す。

## 11:11 JST

- 手で回した Opus（子も Opus）: 3 本のうち 2 本が completed。
  - easy-table-of-contents: 61 分、子 15、Finding 0、parked 2、Lead 26
  - gotmls: 61 分、子 12、Finding 0、Lead 40
  - tiny-compress-images: 61 分目で、まだ走っている。
- runner（prod19、Opus ＋ Sonnet）
  - `claude-ramp.sh` が Claude の上限を 1 → 2 → 3 に上げた（11:09〜11:10）。
  - prod-20261020-5 の残り 3 件のうち 2 件が走っている（35 分目と 1 分目）。残りの 1 件もまもなく始まるはず。
  - 走っているのは Claude 3 本で、Codex は 0 本。
- 429 / rate-limit は 0 件。free は 3 GiB（available 40 GiB）、load は 6.1。

## 12:18 JST

- 手で回した Opus の 3 本目 tiny-compress-images が completed（65 分）。手動の 3 本はこれですべて終わり、`claude-ramp.sh` が Claude の上限を 4 にして終わった（11:15）。
- prod-20261020-5 の残り 3 件を Opus ＋ Sonnet で走らせ、12:11 に batch が終わった（stopped=none）。
  - completed 2 本: 63 分と 61 分。
  - provider-refused 1 本: 15 分。Claude の拒否なので再開しない。
  - `ledger runtime` で、子が `claude-sonnet-5-5 effort high` として記録されているのを確かめた（42 run）。
- 12:17 に新しい batch prod-20261021-1 が自動で始まった。Claude の上限は 4、Codex は 0。
  - 4 本が同時に走っている: woo-checkout-field-editor-pro 2.2.0、permalink-manager 2.6.1、email-address-encoder 1.0.25、codepress-admin-columns 7.1.7。
  - 10:10 に `select` が残した束縛の無い batch は、この batch に使われたとみられる（4 件とも、その上位 10 件に含まれていた）。holding-error は出ていない。
- 429 は 0 件。free は 4 GiB（available 41 GiB）、load は 1.8。

## 13:25 JST

- runner は running（prod19）。batch prod-20261021-1 で、Claude 4 本が切れ目なく回っている。
  - completed 2 本
    - permalink-manager: 62 分、子 17、Lead 20
    - email-address-encoder: 60 分、子 6
  - provider-refused（Claude の拒否）2 本
    - woo-checkout-field-editor-pro: 18 分、Finding 1
    - codepress-admin-columns: 42 分、Finding 5
  - 走っているもの: auto-image-attributes（49 分目）、popup-builder（25 分目）、image-widget（7 分目）、mystickymenu（5 分目）。
- 本日の累計: Trial 14、completed 7、provider-refused 3、findings queue 6、parked 3。自動の verify 4 件は、いずれも incomplete。
- **要確認**: Opus ＋ Sonnet の本番で、Claude の `provider-refusal` が 9 本中 3 本出ている。
  - 実験の os 群では 7 本中 1 本だった。
  - 規則では Claude の拒否は終了とするので、再開はしていない。
  - 拒否された run でも、止まるまでに出した Finding は台帳に残っている。
- 429 は 0 件。free は 2 GiB（available 40 GiB）、load は 1.2。

## 13:38 JST Claude の拒否も再開する（所有者の指示）

- 所有者の判断「拒否の場合も再開するほうがいいかも codex の cyber policy とおんなじ」に従い、scratchpad に `resume-watch-claude.sh` を置いて起動した。
  - 対象: 10:30 以降の Claude Root のうち、`provider-refusal` で止まり、まだ再開していないもの。
  - 1 本ずつ再開し、再び拒否された segment は再開しない。
  - 再開している間は、runner の Claude の上限を 3 に下げる。Claude の合計を 4 に保つため。
- 1 本目は pojo-accessibility（prod-20261020-5、d0023223）。segment 31baf33d が 13:37 に始まった。
- 次の順番: woo-checkout-field-editor-pro、codepress-admin-columns。
- 正本との差: ADR 0036 の追記 4 と AGENTS.md には「Claude の provider-refusal は終了」とある。この決定を残すには、ADR の追記が要る。

## 14:32 JST

- runner は running。batch prod-20261021-1 の 10 件のうち 8 件が終わった。
  - 前回からの completed 4 本
    - auto-image-attributes: 60 分、Lead 12
    - popup-builder: 60 分、Finding 3
    - image-widget: 69 分、Lead 1
    - mystickymenu: 62 分、Lead 9
  - 走っているもの: mainwp-child 6.3（55 分目）、header-and-footer-scripts 2.4.2（30 分目）。
- 本日の累計: Trial 16、completed 11、findings queue 9。
- Claude の拒否の再開（ADR 0036 の 2026-10-21 追記、#440 で merge 済み）

  | 対象 | segment | 結果 |
  | --- | --- | --- |
  | pojo-accessibility | 31baf33d | 0 分で再び provider-refusal |
  | woo-checkout-field-editor-pro | 7c74fd1a | 1 分で再び provider-refusal |
  | codepress-admin-columns | 725b1bba | 14:23 に始まり、9 分目で走っている |

  - 再び拒否された 2 本は、規則どおりこれ以上再開しない。
  - **観測**: Claude の拒否は、再開の最初の turn ですぐにまた拒否される傾向がある（2 本中 2 本）。復元した会話をそのまま送り直すためとみられる。Codex の cyber-policy の再開は 9 本中 7 本が completed まで届いており、それとは違う。
- 429 は 0 件。free は 4 GiB（available 40 GiB）、load は 0.8。

## 15:19 JST

- **Codex の quota**: host の codex CLI で最小の要求を 1 回送って確かめた。返事は「usage limit、次に使えるのは 2026-10-27 15:33」だった。週の上限とみられる。
  - Codex は 10-27 まで使えない。runtimeShare を codex 0、`.codex` を 0 のままにする。
  - Codex の再開 watcher も止まったままでよい。
- runner は running。
  - batch prod-20261021-1 は 15:11 に終わった。mainwp-child（60 分、Lead 19）と header-and-footer-scripts（61 分）が completed。
  - 15:11 に batch prod-20261021-2 が自動で始まった。Claude 4 本が走っている: contact-form-cfdb7 1.4.2、flamingo 2.6.4、astra-widgets 1.2.17、ocean-extra 2.6.3。
- Claude の拒否の再開: codepress-admin-columns の segment 725b1bba は 11 分走ったところで、再び provider-refusal になった。
  - 3 本中 3 本が、再開した後にまた拒否された（0 分、1 分、11 分）。
  - 再開で増えたのは、codepress の子 2 本の completed だけ。
- 本日の累計: Trial 20、completed 13、findings queue 11。429 は 0 件。

## 16:24 JST

- runner は running。batch prod-20261021-2 の最初の 4 本は、どれも completed（61〜67 分）。Finding は 0 で、Lead はそれぞれ 23 / 8 / 9 / 17。
- 続けて 4 本が走っている（5〜11 分目）: speedycache 1.4.3、menu-icons 0.13.25、so-widgets-bundle 1.75.0、suremails 2.0.3。
- 本日の累計: Trial 24、completed 17、provider-refused 3、findings queue 11。
- 新しい拒否は無い。429 は 0 件。free は 5 GiB（available 42 GiB）、disk の残りは 247 GB。

## 17:24 JST

- runner は running。batch prod-20261021-2 は 10 件中 8 件が終わった。
  - completed: speedycache（67 分、Lead 17）、menu-icons（61 分、Lead 8）、suremails（61 分、Lead 12）。
  - so-widgets-bundle: 27 分で provider-refusal になった。17:18 に再開したが、1 分以内にまた拒否された。
  - 走っているもの: wp-mail-logging（39 分目）、shortcoder（5 分目）。この batch の最後の 2 本で、終わると次の batch が自動で選ばれる。
- Claude の拒否の再開は、4 本中 4 本が再開した後にまた拒否された。
- 本日の累計: Trial 26、completed 20、provider-refused 4、findings queue 11。429 は 0 件。

## 18:58 JST 所有者の指示: 再開は数回まで、だめなら新しい Trial。Claude を 5 本に

- Claude の同時数の上限を 5 にした。campaign 設定は claude 5 / 合計 8、live の値も 5。
- `resume-watch-claude.sh` を書き換えた。
  - 拒否で止まった Claude の Trial は、最新の segment を最大 2 回まで再開する。
  - 2 回とも拒否されたら、同じ slug で新しい Trial を 1 回だけ起動する（`campaign run <slug> --campaign fresh-20261021-<slug>`）。prompt は変えない。
  - どちらの作業も Claude 5 本の枠の中で回す。作業中は runner の上限を 4 に下げる。
- 1 件目は pojo-accessibility の 2 回目の再開（18:57）。

## 19:08 JST

- pojo-accessibility は 2 回目の再開でも拒否されたので、新しい Trial に切り替えた。
  - 最初の試みは「no selected target matched」で始まらなかった。本番の選定方針が、一度選ばれた slug を外すため。
  - そこで、`selection-manual-retry-20261019.json` と同じ形の 1 件だけの方針（`~/.config/wordpress-bounty-harness/selection-fresh-<slug>.json`、candidateSlugs と pinnedVersions）を watcher が作るように直した。
  - その方針で、`fresh-20261021-pojo-accessibility` が 19:07 に始まった（claude-code/v1、v8）。
- runner は batch prod-20261021-3 を走らせている。
  - completed 2 本: stackable（64 分）、yith-wishlist（68 分、Lead 8）。
  - 走っているもの 4 本: wp-rollback、otter-blocks、surerank、chaty。
  - Claude の上限は live で 5。watcher が作業している間は 4 に下げる。
- 本日の累計: Trial 32、completed 23、provider-refused 5、findings queue 15。429 は 0 件。

## 20:07 JST

- Claude は 5 本が同時に走っている（runner 4 本 ＋ 探索のやり直し 1 本）。429 は 0 件。
- runner（batch prod-20261021-3）
  - completed 3 本: otter-blocks（64 分、Finding 3）、surerank（61 分、Lead 12）、chaty（61 分、Lead 5）。
  - 走っているもの: tiktok-for-business（51 分目）、simple-cloudflare-turnstile（13 分目）、password-protected（5 分目）、aryo-activity-log（0 分目）。
- 探索のやり直し: fresh-20261021-pojo-accessibility は 60 分目で、拒否されずに走っている。
- 本日の累計: Trial 37、completed 27、provider-refused 5、findings queue 18。free は 4 GiB（available 42 GiB）。

## 21:08 JST

- runner は running。batch prod-20261021-3 は最後の 1 本（61 分目）だけが走っている。終わると次の batch が自動で選ばれる。
- 前回からの completed 3 本: tiktok-for-business（60 分）、simple-cloudflare-turnstile（61 分）、password-protected（63 分、parked 11）。
- 探索のやり直し
  - pojo-accessibility は completed（67 分、Lead 59、parked 2）。
  - codepress-admin-columns は 2 回目の再開でも止まったので、20:37 に新しい Trial にした。31 分目で走っている。
- 本日の累計: Trial 38、completed 31、findings queue 18、parked 16。429 は 0 件。

## 22:08 JST

- runner: 動作中（prod19、pid 4124637）。ただし backoff 中（rate-limit、step 2、22:18 JST まで）。claude 5 / codex 0。
- prod-20261021-4: so-css / gdpr-cookie-compliance / post-duplicator ほかが 21:22〜21:47 に開始し、33〜34 分で provider-limited になった。22:07 の再開 segment は 0 分で再び provider-limited。Claude を 5 本にしてから rate-limit が出ている。
- fresh-20261021-codepress-admin-columns: completed（70 分）。
- shortcoder の再開は exit=3（watcher の 2 回目）→ 次は新しい Trial になる。
- 本日: Trial 38、completed 33、provider-limited 15、refused 5、Finding queue 28 + parked 19。
- 資源: free 43 GiB。コンテナは registry だけ（backoff 中）。
- 要確認: 5 本並列で rate-limit が出る。4 本に戻すかどうかは所有者が決める。
