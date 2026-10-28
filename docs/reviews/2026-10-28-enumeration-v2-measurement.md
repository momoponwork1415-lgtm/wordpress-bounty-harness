# 列挙道具 v2 の静的計測（2026-10-28）

#647 の受入条件に対応する計測記録で、正本は ADR 0042 追記 4。探索 Trial と AI の区画案は実行していない。

## 方法と根拠

WordPress.org の公式 plugin_information API が返した最新 stable の `version` と `download_link` を使い、公式 ZIP を取得した。各 ZIP のルート PHP ヘッダの `Version` と API の版を照合した。取得は 2026-10-28 09:46:30〜09:46:38 UTC（18:46 JST）。展開前に絶対パス・親への移動・symlink・特殊 file・展開サイズを検査し、対象コードは実行せず、道具だけをホストで動かした。v2 の PHP は `token_get_all` でソースをデータとして読む（include/eval なし）。

各ソースのルートに対して `sh enumerate-hooks-v1.sh "$source"` と `sh enumerate-sinks-v{1,2}.sh "$source"` の改行数を数えた。時刻・API 応答・ZIP・TSV は Git 外の `/tmp/wbh-647-measure` に保管した。以下には公開 metadata と集計だけを載せる。再取得時には ZIP の SHA-256 と版を照合する（stable は将来変わる）。

## 件数

| slug | stable | PHP files | hooks | sinks v1 | sinks v2 | 合計 v1 | 合計 v2 | 300 行で必要な区画 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| wp-seopress | 10.3 | 1143 | 491 | 866 | 697 | 1357 | 1188 | 4 |
| themeisle-companion | 3.0.11 | 398 | 434 | 1173 | 432 | 1607 | 866 | 3 |
| foogallery | 3.3.17 | 459 | 781 | 1701 | 835 | 2482 | 1616 | 6 |
| pojo-accessibility | 4.1.4 | 195 | 204 | 169 | 132 | 373 | 336 | 2 |
| gdpr-cookie-compliance | 5.2.2 | 64 | 112 | 385 | 166 | 497 | 278 | 1 |
| popup-maker | 1.25.0 | 360 | 549 | 723 | 549 | 1272 | 1098 | 4 |
| the-events-calendar | 6.18.2 | 2906 | 1686 | 3128 | 1887 | 4814 | 3573 | 12 |
| pods | 3.3.9.2 | 303 | 310 | 1084 | 506 | 1394 | 816 | 3 |
| check-email | 2.0.17 | 303 | 118 | 534 | 312 | 652 | 430 | 2 |
| shortcoder | 6.6 | 11 | 33 | 41 | 27 | 74 | 60 | 1 |
| woocommerce-germanized | 4.1.6 | 838 | 976 | 1170 | 768 | 2146 | 1744 | 6 |
| translatepress-multilingual | 3.3.8 | 182 | 659 | 926 | 719 | 1585 | 1378 | 5 |

既定は 300 行 × 8 区画 = 2,400 行にする。全行を割り当てられる容量は 11/12 対象であり、超過は the-events-calendar の 1 対象（3,573 行、12 区画相当）。最大 16 区画の設定を自動で使ったり、行を落としたりはしない。差し戻しが尽きた結果は従来の `incomplete(schema / enumeration-rejected)` のままである。AI が追加する行や機能単位の切り方は未計測なので、11/12 は実際の受入率を示さない。

全 12 対象で query / file / deserialize / write / message の出力 bytes は v1 と一致した。`output` の行数は下表のとおり。`/usr/bin/time -f "%e %M"` による v2 の最大 wall は 0.45 秒、最大 RSS は 51,264 KiB だった（各 1 回の静的計測であり、provider run の時間ではない）。

| slug | output v1 | output v2 | v2 秒 | v2 RSS KiB |
| --- | ---: | ---: | ---: | ---: |
| wp-seopress | 285 | 116 | 0.22 | 30528 |
| themeisle-companion | 862 | 121 | 0.09 | 27072 |
| foogallery | 1065 | 199 | 0.18 | 51264 |
| pojo-accessibility | 59 | 22 | 0.04 | 24576 |
| gdpr-cookie-compliance | 284 | 65 | 0.03 | 25344 |
| popup-maker | 292 | 118 | 0.09 | 25728 |
| the-events-calendar | 1853 | 612 | 0.45 | 34868 |
| pods | 711 | 133 | 0.17 | 39700 |
| check-email | 300 | 78 | 0.08 | 33216 |
| shortcoder | 23 | 9 | 0.02 | 24000 |
| woocommerce-germanized | 583 | 181 | 0.15 | 27648 |
| translatepress-multilingual | 275 | 68 | 0.28 | 28800 |

## 取得した版の照合情報

リンクは取得に使った公式 API と ZIP。SHA-256 はそれぞれの応答 bytes に対する値。themeisle-companion の API は版なしの ZIP URL を返したため、ヘッダの 3.0.11 と ZIP digest でも固定した。

| slug（公式 API） | 公式 ZIP | API SHA-256 | ZIP SHA-256 |
| --- | --- | --- | --- |
| [wp-seopress](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=wp-seopress) | [10.3](https://downloads.wordpress.org/plugin/wp-seopress.10.3.zip) | `5436bfb928b26b75f0a9755629d31b7ce6fbde8d8bc212fdc601b5b893afaeb1` | `1ad572745b0c70dfd131e91207eccec93527d3d6dad409fc71c3b655c765699b` |
| [themeisle-companion](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=themeisle-companion) | [3.0.11](https://downloads.wordpress.org/plugin/themeisle-companion.zip) | `8f9e2e9f4a4703328e9d25374bee1ab37348da63d1fab5d40d45df58131d437f` | `cb5bc9639358e495eb14f2651d91e24a7d1e8e3f982cd57cbe6ba064a7326748` |
| [foogallery](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=foogallery) | [3.3.17](https://downloads.wordpress.org/plugin/foogallery.3.3.17.zip) | `508e386ba715259225e66a5c1203cbed04235f4ea8dbf823dfbbd941de88d8a4` | `6656a456c29c2c0e8f01bb72743f3cc2d61b83deff7ef36b96b171ccfe543a92` |
| [pojo-accessibility](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=pojo-accessibility) | [4.1.4](https://downloads.wordpress.org/plugin/pojo-accessibility.4.1.4.zip) | `71b4b254412b4561139d1329fb0f62143e72ec766511fe2028d516a919386abb` | `1440284d1510273b519a11314be9f3fcaea82ba984477944891b5b88083e4713` |
| [gdpr-cookie-compliance](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=gdpr-cookie-compliance) | [5.2.2](https://downloads.wordpress.org/plugin/gdpr-cookie-compliance.5.2.2.zip) | `4ed65b8669a03c4045650fa0740c666e9c316aa01fd302bf3e52ce264db2f68e` | `11048883afbaa6bf7cd1e5c4fde26c776e7837a1359b7255114bdd8ccb1b5fe8` |
| [popup-maker](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=popup-maker) | [1.25.0](https://downloads.wordpress.org/plugin/popup-maker.1.25.0.zip) | `c491318b9e62f5fa4b898571931490f540be36f751a925d9581eb7471668a01f` | `07e15421b302471e0c3d9d756fc06ec9851676eab71617347e5fc0d10986fee6` |
| [the-events-calendar](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=the-events-calendar) | [6.18.2](https://downloads.wordpress.org/plugin/the-events-calendar.6.18.2.zip) | `c7cfa0498200c8e82398477e1dc958ec640e6ad3a5d26aaed3404c2990e12e6c` | `38c323575fe69c2ee6b2bd596182ca129e1bfcdc7c7118210e05743dfed30159` |
| [pods](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=pods) | [3.3.9.2](https://downloads.wordpress.org/plugin/pods.3.3.9.2.zip) | `1d1792413e431a6215881c634a919764ed1361b544bffe61f0959bb306cc13f4` | `2e61df4a5210926891c84ef9c85f5721ef3c7b6609ef8a4593eed3a5df675013` |
| [check-email](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=check-email) | [2.0.17](https://downloads.wordpress.org/plugin/check-email.2.0.17.zip) | `b02bffe97153f0546bc7ee8a13e9406081b7203f476f664fedcab9e3a3541c39` | `a4ee948531c80eed4c3ba05c6a7fac3e144bb1142071c1c0cc7d467789718871` |
| [shortcoder](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=shortcoder) | [6.6](https://downloads.wordpress.org/plugin/shortcoder.6.6.zip) | `83b61aa73f95d6ea21d8dbf1a6866ef5e93917ae89d6f710b4e8d776f9f258d7` | `e3e394aff5c2113fb5c82f1f67af9a7bc9067782f19c016f1228c98635911a8b` |
| [woocommerce-germanized](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=woocommerce-germanized) | [4.1.6](https://downloads.wordpress.org/plugin/woocommerce-germanized.4.1.6.zip) | `aa5a4791ad407daf95f4c5123c876611352c78a835823ccf04e5b570deb07069` | `455a31828f7e6250bf002b404ccb8e39f9ed6758642f147fdce307391fc2576e` |
| [translatepress-multilingual](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=translatepress-multilingual) | [3.3.8](https://downloads.wordpress.org/plugin/translatepress-multilingual.3.3.8.zip) | `f5bff53d00dfbd92bae437a4b19a90bd2c276d5ebfedec6413006d64a98c961d` | `aa78ce60c6cf244c121f4f13ae4984282b2795f17902dff17ae45f6a0bbbcf05` |

道具の SHA-256:

- `enumerate-hooks-v1.sh`: `dd208c53a31fb8c6d35759e4f651dcfc174ebfdc1273d7172f6bfe4acf2f5362`。
- `enumerate-sinks-v1.sh`: `957be12aa7a8e250d40edfa6b637b7c65cd111abf8f6af42d28c90117d7605ea`。
- `enumerate-sinks-v2.sh`: `2c28a56be45a909380f692d839c6850ee679a2741e57e0432928e3cebef203fd`。

v1 の file は変更していない。役が名指しする `enumerate-sinks-v1.sh` は v2 を選ぶ pack 内でだけ v2 bytes の互換名になる。明示的な v1 pack は元の v1 bytes のままで、両版を指定する設定は拒否される。
