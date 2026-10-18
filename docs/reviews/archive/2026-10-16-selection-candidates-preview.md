# 探索候補の一覧（本番選定方針のプレビュー、2026-10-16 10:05Z）

正本ではない。`src/profiles/wordpress/policy/selection.json`（id `wordpress-selection-2026-10-20`）の候補源とローカル条件を、WordPress.org の公開 API に対してそのまま当てた結果。実際の `select` はこの上に Programme の対象範囲（Wordfence の転記）と台帳の既往除外を掛け、score（インストール数 ×10、更新の新しさ ×5）の上位 5 件を 1 batch として凍結する。`revisitPolicy: never` なので、batch を重ねるごとにこの表を上から消化していく。

- 候補源: 人気順 10 ページ × 50 件 ＋ タグ 8 種（forms, contact-form, membership, page-builder, elementor-addons, multilingual, backup, booking）× 1 ページ × 50 件。重複を除いて 816 件。
- ローカル条件で残ったもの: 427 件。除外は インストール 10 万未満 352、更新 365 日超 54、除外著者（Automattic / Facebook / Google / SiteGround / Yoast）23。
- この表に無い除外: Programme の対象外資産、plugin 配布の終了、WP 7.1.3 非互換、台帳の既往（本番 state は空）。

| # | slug | name | active installs | last updated | author | version |
|---|---|---|---|---|---|---|
| 1 | contact-form-7 | Contact Form 7 | 10,000,000 | 2026-10-11 | Rock Lobster Inc. | 6.2.2 |
| 2 | elementor | Elementor Website Builder – more than ju | 10,000,000 | 2026-10-13 | Elementor | 4.3.5 |
| 3 | classic-editor | Classic Editor | 8,000,000 | 2026-05-28 | WordPress.org | 1.7.0 |
| 4 | litespeed-cache | LiteSpeed Cache | 7,000,000 | 2026-09-01 | LiteSpeed Technologies | 7.9.1 |
| 5 | wordfence | Wordfence Security – Firewall, Malware S | 5,000,000 | 2026-09-30 | Mark Maunder | 9.0.2 |
| 6 | wpforms-lite | WPForms – AI Form Builder for WordPress  | 5,000,000 | 2026-10-06 | Syed Balkhi | 2.0.2.2 |
| 7 | all-in-one-wp-migration | All-in-One WP Migration and Backup | 5,000,000 | 2026-10-07 | ServMask | 7.112 |
| 8 | seo-by-rank-math | Rank Math SEO – AI SEO Tools to Dominate | 4,000,000 | 2026-10-06 | Rank Math SEO | 1.0.280 |
| 9 | wp-mail-smtp | WP Mail SMTP by WPForms – Free SMTP Plug | 4,000,000 | 2026-10-08 | Syed Balkhi | 4.10.2 |
| 10 | updraftplus | UpdraftPlus: WP Backup & Migration Plugi | 4,000,000 | 2026-10-15 | David Anderson / Team Updraft | 1.26.10 |
| 11 | duplicate-page | Duplicate Page | 3,000,000 | 2026-05-08 | mndpsingh287 | 4.5.9 |
| 12 | really-simple-ssl | Really Simple Security – Simple and Perf | 3,000,000 | 2026-09-15 | Really Simple Plugins | 9.8.3 |
| 13 | hostinger | Hostinger Tools | 3,000,000 | 2026-10-07 | Hostinger | 3.0.79 |
| 14 | insert-headers-and-footers | WPCode – Insert Headers and Footers + Cu | 3,000,000 | 2026-10-08 | Syed Balkhi | 2.4.0 |
| 15 | classic-widgets | Classic Widgets | 2,000,000 | 2025-12-08 | Tonya Mork | 0.3 |
| 16 | wps-hide-login | WPS Hide Login | 2,000,000 | 2026-08-13 | Remy Perona | 1.9.19 |
| 17 | wordpress-importer | WordPress Importer | 2,000,000 | 2026-08-27 | WordPress.org | 0.9.6 |
| 18 | advanced-custom-fields | Advanced Custom Fields (ACF®) | 2,000,000 | 2026-09-10 | WP Engine | 6.8.10 |
| 19 | google-analytics-for-wordpress | MonsterInsights – Google Analytics Dashb | 2,000,000 | 2026-09-16 | chriscct7 | 11.3.0 |
| 20 | redirection | Redirection | 2,000,000 | 2026-09-19 | John Godley | 5.10.1 |
| 21 | header-footer-elementor | Ultimate Addons for Elementor – Widgets, | 2,000,000 | 2026-09-25 | Brainstorm Force | 2.9.5 |
| 22 | all-in-one-seo-pack | All in One SEO – AI SEO Plugin to Boost  | 2,000,000 | 2026-10-07 | Syed Balkhi | 5.0.3 |
| 23 | one-click-demo-import | One Click Demo Import | 1,000,000 | 2026-04-22 | Syed Balkhi | 3.4.1 |
| 24 | custom-post-type-ui | Custom Post Type UI | 1,000,000 | 2026-07-14 | webdevstudios | 1.19.3 |
| 25 | svg-support | SVG Support | 1,000,000 | 2026-07-25 | Benbodhi | 2.6.1 |
| 26 | optinmonster | Popup Builder & Popup Maker for WordPres | 1,000,000 | 2026-08-14 | Syed Balkhi | 2.17.1 |
| 27 | maintenance | Maintenance | 1,000,000 | 2026-08-16 | WebFactory | 4.32 |
| 28 | wp-multibyte-patch | WP Multibyte Patch | 1,000,000 | 2026-08-16 | Seisuke Kuraishi | 2.9.3 |
| 29 | worker | ManageWP Worker | 1,000,000 | 2026-08-21 | ManageWP | 4.9.38 |
| 30 | better-search-replace | Better Search Replace | 1,000,000 | 2026-08-25 | WP Engine | 1.4.11 |
| 31 | tinymce-advanced | Advanced Editor Tools | 1,000,000 | 2026-08-26 | Andrew Ozz | 5.10.1 |
| 32 | disable-comments | Disable Comments – Remove Comments & Sto | 1,000,000 | 2026-09-01 | WPDeveloper | 2.9.0 |
| 33 | imagify | Imagify Image Optimization: Optimize Ima | 1,000,000 | 2026-09-07 | WP Media | 2.3.4 |
| 34 | mailchimp-for-wp | MC4WP: Mailchimp for WordPress | 1,000,000 | 2026-09-16 | Danny van Kooten | 4.14.1 |
| 35 | all-in-one-wp-security-and-firewall | All-In-One Security (AIOS) – Security an | 1,000,000 | 2026-09-17 | David Anderson / Team Updraft | 5.4.10 |
| 36 | google-sitemap-generator | XML Sitemap Generator for Google | 1,000,000 | 2026-09-18 | Auctollo | 4.1.25 |
| 37 | wp-optimize | WP-Optimize – Cache, Compress images, Mi | 1,000,000 | 2026-09-21 | David Anderson / Team Updraft | 4.7.0 |
| 38 | safe-svg | Safe SVG | 1,000,000 | 2026-09-22 | 10up | 2.5.1 |
| 39 | image-optimization | Image Optimizer – Compress Images and Co | 1,000,000 | 2026-09-22 | Elementor | 1.7.7 |
| 40 | limit-login-attempts-reloaded | Limit Login Attempts Security – Login Se | 1,000,000 | 2026-09-23 | WPChef | 3.3.10 |
| 41 | wp-file-manager | File Manager | 1,000,000 | 2026-09-24 | mndpsingh287 | 8.0.6 |
| 42 | wp-reviews-plugin-for-google | Widgets for Google Reviews | 1,000,000 | 2026-09-24 | Trustindex | 14.2 |
| 43 | instagram-feed | Smash Balloon Social Photo Feed – Easy S | 1,000,000 | 2026-09-29 | Syed Balkhi | 6.14.0 |
| 44 | wp-smushit | Smush – Image Optimization, Compression, | 1,000,000 | 2026-09-29 | WPMU DEV - Your All-in-One Wor | 4.3.4 |
| 45 | loco-translate | Loco Translate | 1,000,000 | 2026-09-30 | Tim W | 2.8.9 |
| 46 | astra-sites | Starter Templates: AI-Powered Website Te | 1,000,000 | 2026-10-01 | Brainstorm Force | 4.7.8 |
| 47 | loginizer | Loginizer | 1,000,000 | 2026-10-09 | Softaculous | 2.1.2 |
| 48 | ultimate-addons-for-gutenberg | Spectra Legacy – Gutenberg Blocks | 1,000,000 | 2026-10-09 | Brainstorm Force | 2.20.5 |
| 49 | wp-fastest-cache | WP Fastest Cache – WordPress Cache Plugi | 1,000,000 | 2026-10-10 | Emre Vona | 1.5.3 |
| 50 | elementskit-lite | ElementsKit Elementor Addons – Advanced  | 1,000,000 | 2026-10-11 | Roxnor | 4.0.8 |
| 51 | code-snippets | Code Snippets | 1,000,000 | 2026-10-12 | Code Snippets Pro | 4.0.0 |
| 52 | complianz-gdpr | Complianz GDPR/CCPA Cookie Consent Banne | 1,000,000 | 2026-10-13 | Complianz | 7.5.6 |
| 53 | ewww-image-optimizer | EWWW Image Optimizer | 1,000,000 | 2026-10-13 | Shane Bishop | 8.9.0 |
| 54 | cookie-law-info | CookieYes – Cookie Banner for Cookie Con | 1,000,000 | 2026-10-14 | CookieYes | 3.5.7 |
| 55 | duplicator | Duplicator – Backups & Migration Plugin  | 1,000,000 | 2026-10-14 | Syed Balkhi | 5.0.6 |
| 56 | hostinger-reach | Hostinger Reach – AI-Powered Email Marke | 1,000,000 | 2026-10-14 | Hostinger | 1.8.7 |
| 57 | essential-addons-for-elementor-lite | Essential Addons for Elementor – Popular | 1,000,000 | 2026-10-15 | WPDeveloper | 6.8.6 |
| 58 | gtranslate | Translate WordPress with GTranslate | 900,000 | 2026-09-15 | edo888 | 5.0.1 |
| 59 | wpvivid-backuprestore | WPvivid — Backup, Migration & Staging | 900,000 | 2026-09-28 | wpvividplugins | 0.9.136 |
| 60 | w3-total-cache | W3 Total Cache | 900,000 | 2026-10-01 | BoldGrid | 2.10.7 |
| 61 | redux-framework | Redux Framework | 900,000 | 2026-10-12 | David Anderson / Team Updraft | 4.5.16 |
| 62 | polylang | Polylang | 900,000 | 2026-10-12 | Chouby | 3.8.11 |
| 63 | flamingo | Flamingo | 800,000 | 2026-08-18 | Rock Lobster Inc. | 2.6.4 |
| 64 | smart-slider-3 | Smart Slider 3 | 800,000 | 2026-08-19 | Nextendweb | 3.5.1.39 |
| 65 | breadcrumb-navxt | Breadcrumb NavXT | 800,000 | 2026-08-29 | John Havlik | 7.5.2 |
| 66 | woocommerce-paypal-payments | WooCommerce PayPal Payments | 800,000 | 2026-09-09 | WooCommerce | 4.1.3 |
| 67 | autoptimize | Autoptimize | 800,000 | 2026-09-26 | Optimizing Matters | 3.1.16 |
| 68 | fluentform | Fluent Forms – Customizable Contact Form | 800,000 | 2026-09-30 | WPManageNinja | 6.2.15 |
| 69 | woocommerce-payments | WooPayments: Integrated WooCommerce Paym | 800,000 | 2026-10-08 | WooCommerce | 11.2.0 |
| 70 | google-listings-and-ads | Google for WooCommerce | 800,000 | 2026-10-12 | WooCommerce | 3.9.6 |
| 71 | cookie-notice | Cookie Compliance for WordPress – Cookie | 800,000 | 2026-10-15 | Humanityco | 3.1.17 |
| 72 | antispam-bee | Antispam Bee | 700,000 | 2026-08-23 | pluginkollektiv | 2.11.13 |
| 73 | popup-maker | Popup Maker – Boost Sales, Conversions,  | 700,000 | 2026-09-11 | Daniel Iser | 1.25.0 |
| 74 | user-role-editor | User Role Editor | 700,000 | 2026-09-25 | Vladimir Garagulya | 4.66.2 |
| 75 | fluent-smtp | FluentSMTP – WP Mail SMTP Plugin with Am | 700,000 | 2026-09-27 | WPManageNinja | 2.4.1 |
| 76 | woocommerce-gateway-stripe | WooCommerce Stripe Payment Gateway | 700,000 | 2026-10-05 | WooCommerce | 11.0.1 |
| 77 | duracelltomi-google-tag-manager | GTM4WP – A Google Tag Manager (GTM) plug | 700,000 | 2026-10-12 | Thomas Geiger | 2.0.6 |
| 78 | mainwp-child | MainWP Child – Securely Connects to the  | 700,000 | 2026-10-13 | mainwp | 6.3 |
| 79 | creame-whatsapp-me | Joinchat – Enhanced “click to chat” | 700,000 | 2026-10-13 | Creame | 6.4.2 |
| 80 | better-wp-security | Kadence Security – Password, Two Factor  | 700,000 | 2026-10-14 | Nexcess | 10.0.6 |
| 81 | hello-dolly | Hello Dolly | 600,000 | 2025-10-24 | Matt Mullenweg | 1.7.2 |
| 82 | header-footer-code-manager | Header Footer Code Manager | 600,000 | 2026-07-15 | DraftPress Team | 1.1.46 |
| 83 | enable-media-replace | Enable Media Replace | 600,000 | 2026-08-20 | ShortPixel | 4.2.2 |
| 84 | under-construction-page | Under Construction | 600,000 | 2026-09-18 | WebFactory | 5.83 |
| 85 | click-to-chat-for-whatsapp | Click to Chat – HoliThemes | 600,000 | 2026-09-28 | HoliThemes | 4.45 |
| 86 | coming-soon | Website Builder by SeedProd — Theme Buil | 600,000 | 2026-09-29 | SeedProd | 6.20.10 |
| 87 | backuply | Backuply – Backup, Restore, Migrate and  | 600,000 | 2026-10-01 | Softaculous | 1.5.9 |
| 88 | metform | MetForm – Contact Form, Survey, Quiz, Co | 600,000 | 2026-10-02 | Roxnor | 4.3.2 |
| 89 | custom-css-js | Simple Custom CSS and JS | 600,000 | 2026-10-08 | SilkyPress | 3.54.3 |
| 90 | contact-form-cfdb7 | Database Addon for Contact Form 7 – CFDB | 600,000 | 2026-10-09 | Arshid | 1.4.2 |
| 91 | tablepress | TablePress – Tables in WordPress made ea | 600,000 | 2026-10-12 | Tobias Bäthge | 3.4.1 |
| 92 | post-types-order | Post Types Order | 600,000 | 2026-10-12 | nsp-code | 2.5.7 |
| 93 | kadence-blocks | Kadence Blocks — Page Builder Toolkit fo | 600,000 | 2026-10-13 | Nexcess | 3.8.0 |
| 94 | forminator | Forminator Forms – Contact Form, Payment | 600,000 | 2026-10-14 | WPMU DEV - Your All-in-One Wor | 1.58.2 |
| 95 | sucuri-scanner | Sucuri Security – Auditing, Malware Scan | 600,000 | 2026-10-14 | Sucuri | 2.8.1 |
| 96 | the-events-calendar | The Events Calendar | 600,000 | 2026-10-15 | Nexcess | 6.18.2 |
| 97 | premium-addons-for-elementor | Premium Addons for Elementor – AI-Ready  | 600,000 | 2026-10-15 | Leap13 | 4.11.113 |
| 98 | royal-elementor-addons | Royal Addons for Elementor – Addons and  | 600,000 | 2026-10-15 | WP Royal | 1.7.1069 |
| 99 | easy-table-of-contents | Easy Table of Contents | 600,000 | 2026-10-16 | Magazine3 | 2.0.89 |
| 100 | disable-gutenberg | Disable Gutenberg | 500,000 | 2026-07-18 | Jeff Starr | 3.3.2 |
| 101 | easy-wp-smtp | Easy WP SMTP – WordPress SMTP and Email  | 500,000 | 2026-08-12 | Syed Balkhi | 2.15.1 |
| 102 | taxonomy-terms-order | Category Order and Taxonomy Terms Order | 500,000 | 2026-08-17 | nsp-code | 2.0 |
| 103 | siteguard | SiteGuard WP Plugin | 500,000 | 2026-08-19 | jp-secure | 1.8.9 |
| 104 | pojo-accessibility | Web Accessibility (formally known as All | 500,000 | 2026-08-24 | Elementor | 4.1.4 |
| 105 | redis-cache | Redis Object Cache | 500,000 | 2026-09-18 | Till Krüss | 3.0.0 |
| 106 | siteseo | SiteSEO – SEO Simplified | 500,000 | 2026-09-24 | Softaculous | 1.4.2 |
| 107 | ml-slider | Slider, Gallery, and Carousel by MetaSli | 500,000 | 2026-09-30 | MetaSlider | 3.113.1 |
| 108 | gosmtp | GoSMTP – SMTP for WordPress | 500,000 | 2026-10-07 | Softaculous | 1.2.4 |
| 109 | meta-box | Meta Box – A Framework for Dynamic Websi | 500,000 | 2026-10-07 | Meta Box | 5.15.2 |
| 110 | speedycache | SpeedyCache – Cache, Optimization, Perfo | 500,000 | 2026-10-08 | Softaculous | 1.4.3 |
| 111 | extendify | Extendify | 500,000 | 2026-10-08 | Extendify | 3.2.3 |
| 112 | broken-link-checker | Broken Link Checker | 500,000 | 2026-10-13 | WPMU DEV - Your All-in-One Wor | 2.4.15 |
| 113 | mailpoet | MailPoet – Newsletters, Email Marketing, | 500,000 | 2026-10-13 | MailPoet | 5.42.0 |
| 114 | kirki | Kirki – Freeform Page Builder, Website B | 500,000 | 2026-10-13 | Themeum | 6.4.0 |
| 115 | ocean-extra | Ocean Extra | 500,000 | 2026-10-13 | oceanwp | 2.6.3 |
| 116 | wp-statistics | WP Statistics – Simple, privacy-friendly | 500,000 | 2026-10-14 | VeronaLabs | 14.16.17 |
| 117 | woocommerce-services | WooCommerce Tax (formerly WooCommerce Sh | 500,000 | 2026-10-14 | WooCommerce | 3.7.3 |
| 118 | sureforms | SureForms – Contact Form Builder, AI For | 500,000 | 2026-10-14 | Brainstorm Force | 2.12.9 |
| 119 | webp-converter-for-media | Converter for Media – Optimize images |  | 500,000 | 2026-10-14 | Mateusz Gbiorczyk | 6.7.0 |
| 120 | ninja-forms | Ninja Forms – Contact Form Builder with  | 500,000 | 2026-10-15 | Kevin Stover | 3.15.6 |
| 121 | ga-google-analytics | GA Google Analytics – Connect Google Ana | 400,000 | 2026-08-10 | Jeff Starr | 20260810 |
| 122 | font-awesome | Font Awesome | 400,000 | 2026-08-13 | fontawesome | 5.2.1 |
| 123 | custom-fonts | Custom Fonts – Host Your Fonts Locally | 400,000 | 2026-08-24 | Brainstorm Force | 2.1.17 |
| 124 | wp-pagenavi | WP-PageNavi | 400,000 | 2026-08-28 | Lester Chan | 3.0.1 |
| 125 | woo-checkout-field-editor-pro | Checkout Field Editor (Checkout Manager) | 400,000 | 2026-09-01 | ThemeHigh | 2.2.0 |
| 126 | honeypot | WP Armour – Honeypot Anti Spam | 400,000 | 2026-09-03 | Dnesscarkey | 2.4.02 |
| 127 | template-kit-import | Template Kit – Import | 400,000 | 2026-09-17 | envato | 1.0.17 |
| 128 | pagelayer | Page Builder: Pagelayer – Drag and Drop  | 400,000 | 2026-09-24 | Softaculous | 2.2.2 |
| 129 | shortcodes-ultimate | Shortcodes Ultimate – Content Elements | 400,000 | 2026-09-25 | Vova | 7.9.1 |
| 130 | pixelyoursite | PixelYourSite – Your smart PIXEL (TAG) & | 400,000 | 2026-09-27 | PixelYourSite | 11.4.2.1 |
| 131 | wp-maintenance-mode | LightStart – Maintenance Mode, Coming So | 400,000 | 2026-09-29 | Themeisle | 2.6.24 |
| 132 | yith-woocommerce-wishlist | YITH WooCommerce Wishlist | 400,000 | 2026-10-02 | YITHEMES | 4.19.0 |
| 133 | so-widgets-bundle | SiteOrigin Widgets Bundle | 400,000 | 2026-10-02 | Greg - SiteOrigin | 1.75.0 |
| 134 | siteorigin-panels | Page Builder by SiteOrigin | 400,000 | 2026-10-04 | Greg - SiteOrigin | 2.37.0 |
| 135 | happy-elementor-addons | HappyAddons for Elementor – 160 Elemento | 400,000 | 2026-10-05 | Leevio | 3.50.1 |
| 136 | cookieadmin | CookieAdmin – Cookie Consent Banner | 400,000 | 2026-10-12 | Softaculous | 1.2.6 |
| 137 | translatepress-multilingual | TranslatePress – Translate Multilingual  | 400,000 | 2026-10-13 | Cozmoslabs | 3.3.8 |
| 138 | backwpup | BackWPup – WordPress Backup & Restore Pl | 400,000 | 2026-10-14 | WP Media | 5.7.8 |
| 139 | gutenberg | Gutenberg | 400,000 | 2026-10-14 | WordPress.org | 24.2.0 |
| 140 | coblocks | Page Builder Gutenberg Blocks – CoBlocks | 300,000 | 2026-03-05 | GoDaddy | 3.1.17 |
| 141 | add-to-any | AddToAny Share Buttons | 300,000 | 2026-05-22 | micropat | 1.8.18 |
| 142 | webp-express | WebP Express | 300,000 | 2026-06-19 | rosell.dk | 0.25.15 |
| 143 | wp-headers-and-footers | Insert Headers And Footers | 300,000 | 2026-07-17 | Adnan | 3.1.5 |
| 144 | password-protected | Password Protected — Lock Entire Site, P | 300,000 | 2026-07-30 | Saad Iqbal | 2.8.4 |
| 145 | cyr2lat | Cyr-To-Lat | 300,000 | 2026-08-08 | Sergey Biryukov | 7.1.0 |
| 146 | pdf-embedder | PDF Embedder – PDF Viewer & Embed PDF Fi | 300,000 | 2026-08-14 | Syed Balkhi | 5.0.2 |
| 147 | eps-301-redirects | 301 Redirects – Redirect Manager | 300,000 | 2026-08-15 | WebFactory | 2.85 |
| 148 | wp-reset | WP Reset | 300,000 | 2026-08-16 | WebFactory | 2.08 |
| 149 | admin-menu-editor | Admin Menu Editor | 300,000 | 2026-08-19 | Janis Elsts | 1.15.2 |
| 150 | really-simple-captcha | Really Simple CAPTCHA | 300,000 | 2026-08-23 | Rock Lobster Inc. | 2.5 |
| 151 | members | Members – Membership & User Role Editor  | 300,000 | 2026-08-25 | Blair Williams | 3.2.26 |
| 152 | stops-core-theme-and-plugin-updates | Easy Updates Manager | 300,000 | 2026-08-31 | David Anderson / Team Updraft | 9.0.22 |
| 153 | megamenu | Max Mega Menu | 300,000 | 2026-09-14 | megamenu | 3.10.8 |
| 154 | google-analytics-dashboard-for-wp | ExactMetrics – Google Analytics Dashboar | 300,000 | 2026-09-16 | Syed Balkhi | 10.3.0 |
| 155 | woo-variation-swatches | Variation Swatches for WooCommerce | 300,000 | 2026-09-17 | Emran Ahmed | 2.5.0 |
| 156 | complianz-terms-conditions | Complianz – Terms and Conditions | 300,000 | 2026-09-17 | Complianz | 1.4.1 |
| 157 | sticky-header-effects-for-elementor | Sticky Header Effects for Elementor | 300,000 | 2026-09-18 | POSIMYTH | 2.2.3 |
| 158 | copy-delete-posts | Duplicate Post | 300,000 | 2026-09-23 | Inisev | 1.5.7 |
| 159 | wp-security-audit-log | WP Activity Log | 300,000 | 2026-09-23 | Melapress | 5.6.7 |
| 160 | ad-inserter | Ad Inserter – Ad Manager & AdSense Ads | 300,000 | 2026-09-23 | Spacetime | 2.8.19 |
| 161 | post-smtp | Post SMTP – Complete Email Delivery and  | 300,000 | 2026-09-24 | Saad Iqbal | 4.0.2 |
| 162 | templately | Templately – Elementor & Gutenberg Templ | 300,000 | 2026-09-24 | WPDeveloper | 3.8.0 |
| 163 | wp-google-maps | WP Go Maps – Google Map, OpenStreetMap,  | 300,000 | 2026-09-28 | WPGMaps | 10.1.10 |
| 164 | contact-form-7-honeypot | CF7 Apps – Honeypot, Database, Redirecti | 300,000 | 2026-09-29 | Saad Iqbal | 3.8.0 |
| 165 | otter-blocks | Otter Blocks – Gutenberg Blocks, Page Bu | 300,000 | 2026-09-29 | Themeisle | 3.2.7 |
| 166 | broken-link-checker-seo | Broken Link Checker by AIOSEO – Find & F | 300,000 | 2026-09-30 | AIOSEO Plugin Team | 1.3.1 |
| 167 | wp-seopress | SEOPress – AI SEO Plugin & On-site SEO | 300,000 | 2026-10-01 | Benjamin Denis | 10.3 |
| 168 | surerank | SureRank SEO – Meta Tags, Social Preview | 300,000 | 2026-10-05 | Brainstorm Force | 1.10.2 |
| 169 | simple-history | Simple History – Track, Log, and Audit W | 300,000 | 2026-10-07 | Pär Thernström | 5.35.0 |
| 170 | chaty | Floating Chat Widget: Contact Chat Icons | 300,000 | 2026-10-08 | Premio | 3.6.3 |
| 171 | woocommerce-pdf-invoices-packing-slips | PDF Invoices & Packing Slips for WooComm | 300,000 | 2026-10-08 | WP Overnight | 5.16.4 |
| 172 | jeg-elementor-kit | Jeg Kit for Elementor – Powerful Addons  | 300,000 | 2026-10-08 | jegtheme | 3.2.21 |
| 173 | gdpr-cookie-compliance | GDPR Cookie Compliance – Cookie Banner,  | 300,000 | 2026-10-08 | Moove Agency | 5.2.2 |
| 174 | wp-rollback | WP Rollback – Rollback Plugins and Theme | 300,000 | 2026-10-08 | Devin Walker | 3.2.0 |
| 175 | cmb2 | CMB2 | 300,000 | 2026-10-09 | Justin Sternberg | 2.13.4 |
| 176 | simple-custom-post-order | Simple Custom Post Order | 300,000 | 2026-10-12 | colorlibplugins | 2.8.10 |
| 177 | host-webfonts-local | OMGF | GDPR/DSGVO Compliant, Faster Goog | 300,000 | 2026-10-12 | Daan van den Bergh | 6.3.13 |
| 178 | breeze | Breeze Cache | 300,000 | 2026-10-13 | Cloudways | 2.6.2 |
| 179 | unlimited-elements-for-elementor | Unlimited Elements for Elementor | 300,000 | 2026-10-13 | Unlimited Elements | 2.0.24 |
| 180 | wp-mail-logging | WP Mail Logging | 300,000 | 2026-10-14 | Syed Balkhi | 1.17.1 |
| 181 | formidable | Formidable Forms – WordPress Form Builde | 300,000 | 2026-10-14 | Strategy11 Team | 7.0 |
| 182 | shortpixel-image-optimiser | ShortPixel Image Optimizer – Optimize Im | 300,000 | 2026-10-14 | ShortPixel | 6.6.1 |
| 183 | nextgen-gallery | Photo Gallery, Sliders, Proofing and The | 300,000 | 2026-10-15 | Syed Balkhi | 4.5.3 |
| 184 | blocksy-companion | Blocksy Companion | 300,000 | 2026-10-15 | Creative Themes | 2.1.60 |
| 185 | wp-crontrol | WP Crontrol | 300,000 | 2026-10-15 | Syed Balkhi | 2.0.0 |
| 186 | woo-cart-abandonment-recovery | Cart Abandonment Recovery for WooCommerc | 300,000 | 2026-10-16 | Brainstorm Force | 2.2.1 |
| 187 | fast-indexing-api | Instant Indexing for Google | 200,000 | 2025-11-21 | Rank Math SEO | 1.1.22 |
| 188 | header-and-footer-scripts | Header and Footer Scripts | 200,000 | 2026-02-01 | Anand Kumar | 2.4.2 |
| 189 | force-regenerate-thumbnails | Force Regenerate Thumbnails | 200,000 | 2026-02-17 | Shane Bishop | 2.3.0 |
| 190 | header-footer | Head, Footer and Post Injections | 200,000 | 2026-03-28 | Stefano Lissa | 3.3.6 |
| 191 | custom-post-type-permalinks | Custom Post Type Permalinks | 200,000 | 2026-05-20 | Toro_Unit (Hiroshi Urabe) | 3.5.5 |
| 192 | disable-xml-rpc | Disable XML-RPC | 200,000 | 2026-05-27 | Phil Erb | 1.0.1 |
| 193 | wpcf7-recaptcha | ReCaptcha v2 for Contact Form 7 | 200,000 | 2026-06-05 | IQComputing | 1.5.0 |
| 194 | query-monitor | Query Monitor | 200,000 | 2026-06-20 | John Blackbourn | 4.0.7 |
| 195 | white-label-cms | White Label CMS | 200,000 | 2026-07-09 | Video User Manuals | 2.7.14 |
| 196 | loginpress | LoginPress | wp-login Custom Login Page  | 200,000 | 2026-07-10 | Adnan | 6.2.5 |
| 197 | site-mailer | Email Deliverability – SMTP Replacement, | 200,000 | 2026-07-16 | Elementor | 1.4.7 |
| 198 | popup-builder | Popup Builder – Create highly converting | 200,000 | 2026-07-18 | popupbuilder | 4.4.5 |
| 199 | php-compatibility-checker | PHP Compatibility Checker | 200,000 | 2026-07-20 | WP Engine | 1.6.3 |
| 200 | nextend-facebook-connect | Nextend Social Login and Register | 200,000 | 2026-07-28 | Nextendweb | 3.1.26 |
| 201 | skyboot-custom-icons-for-elementor | Skyboot Custom Icons for Elementor – Ele | 200,000 | 2026-08-11 | SkyBootstrap | 1.2.0 |
| 202 | kadence-starter-templates | Kadence Starter Templates — Predesigned  | 200,000 | 2026-08-12 | Nexcess | 2.3.4 |
| 203 | wpfront-scroll-top | WPFront Scroll Top | 200,000 | 2026-08-18 | Syam Mohan | 3.0.1 |
| 204 | iwp-client | InfiniteWP Client | 200,000 | 2026-08-19 | revmakx | 1.13.10 |
| 205 | imsanity | Imsanity | 200,000 | 2026-08-20 | Shane Bishop | 2.9.4 |
| 206 | black-studio-tinymce-widget | Black Studio TinyMCE Widget | 200,000 | 2026-08-20 | Black Studio | 2.7.4 |
| 207 | wp-sitemap-page | WP Sitemap Page | 200,000 | 2026-08-21 | Tony Archambeau | 1.9.6 |
| 208 | all-404-redirect-to-homepage | All 404 Redirect to Homepage | 200,000 | 2026-08-21 | wp-buy | 5.7 |
| 209 | post-duplicator | Post Duplicator | 200,000 | 2026-08-22 | metaphorcreations | 3.0.16 |
| 210 | astra-widgets | Astra Widgets | 200,000 | 2026-08-24 | Brainstorm Force | 1.2.17 |
| 211 | backup | JetBackup – Backup, Restore & Migrate | 200,000 | 2026-08-26 | JetBackup | 3.1.23.6 |
| 212 | variation-swatches-woo | Variation Swatches for WooCommerce – Col | 200,000 | 2026-08-26 | Brainstorm Force | 1.0.14 |
| 213 | migrate-guru | Migrate Guru – Site Migration & Cloning | 200,000 | 2026-08-28 | migrateguru | 6.72 |
| 214 | user-switching | User Switching | 200,000 | 2026-08-29 | John Blackbourn | 1.12.2 |
| 215 | iubenda-cookie-law-solution | iubenda | All-in-one Compliance for GDPR | 200,000 | 2026-09-01 | iubenda | 3.13.5 |
| 216 | use-any-font | Use Any Font | Custom Font Uploader | 200,000 | 2026-09-03 | Dnesscarkey | 6.4.1 |
| 217 | olympus-google-fonts | Fonts Plugin | Google Fonts, Adobe Fonts | 200,000 | 2026-09-03 | fontsplugin | 4.2.2 |
| 218 | aryo-activity-log | Activity Log – Monitor User and Agent Ch | 200,000 | 2026-09-07 | Elementor | 2.15.0 |
| 219 | nginx-helper | Nginx Helper | 200,000 | 2026-09-09 | rtCamp | 2.4.1 |
| 220 | 3d-flipbook-dflip-lite | DearFlip – PDF Flipbook, 3D Flipbook, PD | 200,000 | 2026-09-09 | DearHive | 2.4.37 |
| 221 | leadin | HubSpot All-In-One Marketing – Forms, Po | 200,000 | 2026-09-16 | HubSpot | 11.3.75 |
| 222 | tiktok-for-business | TikTok | 200,000 | 2026-09-16 | TikTok | 1.4.2 |
| 223 | qi-addons-for-elementor | Qi Addons For Elementor | 200,000 | 2026-09-16 | Qode | 1.11.1 |
| 224 | userfeedback-lite | UserFeedback – Create Interactive Feedba | 200,000 | 2026-09-16 | Syed Balkhi | 1.12.0 |
| 225 | table-of-contents-plus | Table of Contents Plus – Automatic Table | 200,000 | 2026-09-17 | Syed Balkhi | 202609.1 |
| 226 | favicon-by-realfavicongenerator | Favicon by RealFaviconGenerator | 200,000 | 2026-09-20 | phbernard | 1.3.51 |
| 227 | call-now-button | Call Now Button – The Free Click to Call | 200,000 | 2026-09-20 | Jerry Rietveld | 2.0.4 |
| 228 | fileorganizer | FileOrganizer – WordPress File Manager | 200,000 | 2026-09-23 | Softaculous | 1.2.2 |
| 229 | mailchimp-for-woocommerce | Mailchimp for WooCommerce | 200,000 | 2026-09-23 | Mailchimp | 6.3 |
| 230 | mw-wp-form | MW WP Form | 200,000 | 2026-09-27 | Webの相談所 | 5.1.8 |
| 231 | burst-statistics | Burst Statistics – Simple WordPress Anal | 200,000 | 2026-09-28 | Burst Statistics B.V. | 3.7.2 |
| 232 | simple-cloudflare-turnstile | Simple CAPTCHA with Cloudflare Turnstile | 200,000 | 2026-09-29 | Elliot Sowersby / RelyWP | 1.44.0 |
| 233 | ultimate-member | Ultimate Member – User Profile, Registra | 200,000 | 2026-09-29 | Ultimate Member | 2.14.0 |
| 234 | supreme-modules-for-divi | Supreme Modules Lite – Divi Theme, Extra | 200,000 | 2026-09-29 | Supreme Modules | 2.5.64 |
| 235 | optimole-wp | Optimole – Optimize Images | Convert Web | 200,000 | 2026-10-01 | Optimole | 4.2.16 |
| 236 | microsoft-clarity | Microsoft Clarity | 200,000 | 2026-10-01 | Microsoft | 0.10.35 |
| 237 | wp-whatsapp-chat | Social Chat – Click To Chat App Button | 200,000 | 2026-10-04 | quadlayers | 8.6.6 |
| 238 | cloudflare | Cloudflare | 200,000 | 2026-10-05 | Cloudflare | 4.14.5 |
| 239 | cartflows | CartFlows – Funnel Builder & Checkout Pl | 200,000 | 2026-10-05 | Brainstorm Force | 3.3.0 |
| 240 | easy-fancybox | Firelight Lightbox | 200,000 | 2026-10-05 | Firelight | 2.3.25 |
| 241 | advanced-google-recaptcha | Advanced Google reCAPTCHA | 200,000 | 2026-10-06 | WebFactory | 5.42 |
| 242 | newsletter | Newsletter – Send awesome emails from Wo | 200,000 | 2026-10-06 | Stefano Lissa | 9.4.7 |
| 243 | wpconsent-cookies-banner-privacy-suite | WPConsent – Cookie Banner & Cookie Conse | 200,000 | 2026-10-08 | Syed Balkhi | 1.2.0 |
| 244 | suremails | SureMail – SMTP and Email Logs Plugin wi | 200,000 | 2026-10-08 | Brainstorm Force | 2.0.3 |
| 245 | admin-site-enhancements | Admin and Site Enhancements (ASE) | 200,000 | 2026-10-11 | Bowo | 9.2.1 |
| 246 | wp-migrate-db | WP Migrate Lite – Migration Made Easy | 200,000 | 2026-10-12 | WP Engine | 2.7.12 |
| 247 | filebird | FileBird – WordPress Media Library Folde | 200,000 | 2026-10-13 | Ninja Team | 6.5.9 |
| 248 | generateblocks | GenerateBlocks | 200,000 | 2026-10-13 | Tom | 2.5.0 |
| 249 | pinterest-for-woocommerce | Pinterest for WooCommerce | 200,000 | 2026-10-14 | WooCommerce | 1.5.4 |
| 250 | autodescription | The SEO Framework – Fast, Automated, Eff | 200,000 | 2026-10-14 | Sybre Waaijer | 5.2.0 |
| 251 | wp-consent-api | WP Consent API | 200,000 | 2026-10-15 | Rogier Lankhorst | 2.1.0 |
| 252 | wpcf7-redirect | Redirection for Contact Form 7 | 200,000 | 2026-10-15 | Themeisle | 3.2.14 |
| 253 | pretty-link | PrettyLinks – Affiliate Link Management, | 200,000 | 2026-10-15 | Blair Williams | 4.0.17 |
| 254 | cmp-coming-soon-maintenance | CMP – Coming Soon & Maintenance Plugin b | 200,000 | 2026-10-15 | NiteoThemes | 4.1.21 |
| 255 | cleantalk-spam-protect | Spam Protection for Forms & Comments. An | 200,000 | 2026-10-15 | CleanTalk Inc | 6.90 |
| 256 | widget-importer-exporter | Widget Importer & Exporter | 200,000 | 2026-10-15 | Steven Gliebe | 1.6.2 |
| 257 | post-type-switcher | Post Type Switcher | 200,000 | 2026-10-15 | John James Jacoby | 4.1.1 |
| 258 | essential-blocks | Gutenberg Essential Blocks – Page Builde | 200,000 | 2026-10-15 | WPDeveloper | 6.5.0 |
| 259 | xserver-typesquare-webfonts | TypeSquare Webfonts for エックスサーバー | 100,000 | 2025-12-04 | XServer | 2.0.9 |
| 260 | cloudflare-flexible-ssl | Flexible SSL for CloudFlare | 100,000 | 2025-12-23 | Paul | 1.3.1 |
| 261 | duplicate-menu | Duplicate Menu | 100,000 | 2025-12-30 | Jon Christopher | 0.2.3 |
| 262 | connect-polylang-elementor | Connect Polylang for Elementor | 100,000 | 2025-12-31 | David Decker | 2.5.5 |
| 263 | tawkto-live-chat | Tawk.To Live Chat | 100,000 | 2026-01-14 | tawkto | 0.9.3 |
| 264 | disable-xml-rpc-api | Disable XML-RPC-API | 100,000 | 2026-02-04 | Amin Nazemi | 2.1.7 |
| 265 | page-links-to | Page Links To | 100,000 | 2026-04-04 | Mark Jaquith | 3.4.1 |
| 266 | email-address-encoder | Email Address Encoder | 100,000 | 2026-04-12 | Till Krüss | 1.0.25 |
| 267 | image-widget | Image Widget | 100,000 | 2026-04-20 | Nexcess | 4.4.12 |
| 268 | google-captcha | reCaptcha by BestWebSoft | 100,000 | 2026-04-24 | bestwebsoft | 1.87 |
| 269 | 404page | Smart Custom 404 Error Page | 100,000 | 2026-05-21 | NerdPress | 11.4.8 |
| 270 | seo-simple-pack | SEO SIMPLE PACK | 100,000 | 2026-05-22 | LOOS | 3.7.0 |
| 271 | instant-images | Instant Images – One-click Image Uploads | 100,000 | 2026-06-01 | connekthq | 7.2.0 |
| 272 | page-scroll-to-id | Page scroll to id | 100,000 | 2026-06-09 | malihu | 1.7.9 |
| 273 | adminimize | Adminimize | 100,000 | 2026-06-10 | WP Media | 1.11.14 |
| 274 | xml-sitemap-feed | XML Sitemap & Google News | 100,000 | 2026-06-10 | Rolf Allard van Hagen | 5.7.7 |
| 275 | customizer-export-import | Customizer Export/Import | 100,000 | 2026-06-16 | Beaver Builder | 0.9.8 |
| 276 | public-post-preview | Public Post Preview | 100,000 | 2026-06-17 | Dominik Schilling | 3.1.2 |
| 277 | mailin | Brevo – Email, SMS, Web Push, Chat, and  | 100,000 | 2026-06-24 | Brevo | 3.3.5 |
| 278 | indexnow | IndexNow Plugin | 100,000 | 2026-06-26 | bingwebmastertools | 1.0.4 |
| 279 | official-mailerlite-sign-up-forms | MailerLite – Signup forms (official) | 100,000 | 2026-06-26 | MailerLite | 1.7.26 |
| 280 | gotmls | Anti-Malware Security and Brute-Force Fi | 100,000 | 2026-06-29 | Eli | 4.23.90 |
| 281 | wp-live-chat-support | 3CX Free Live Chat, Calls & Messaging | 100,000 | 2026-06-29 | WP-LiveChat | 10.0.18 |
| 282 | intelly-related-posts | Inline Related Posts | 100,000 | 2026-08-03 | Data443 Risk Mitigation, Inc. | 3.11.0 |
| 283 | contact-form-7-dynamic-text-extension | DTX – Dynamic Text Extension for Contact | 100,000 | 2026-08-04 | sevenspark | 5.0.7 |
| 284 | block-bad-queries | BBQ Firewall – Fast & Powerful Firewall  | 100,000 | 2026-08-09 | Jeff Starr | 20260809 |
| 285 | minimal-coming-soon-maintenance-mode | Minimal Coming Soon – Coming Soon Page | 100,000 | 2026-08-16 | WebFactory | 2.45 |
| 286 | custom-sidebars | Custom Sidebars – Dynamic Sidebar Classi | 100,000 | 2026-08-16 | WebFactory | 3.38 |
| 287 | klaviyo | Klaviyo | 100,000 | 2026-08-17 | klaviyo | 3.8.3 |
| 288 | simple-local-avatars | Simple Local Avatars | 100,000 | 2026-08-19 | 10up | 2.8.6 |
| 289 | popups-for-divi | Popups for Divi | 100,000 | 2026-08-19 | Tim Strifler | 3.2.8 |
| 290 | advanced-database-cleaner | Advanced Database Cleaner – Optimize & C | 100,000 | 2026-08-20 | Younes JFR. | 4.2.0 |
| 291 | show-current-template | Show Current Template | 100,000 | 2026-08-20 | JOTAKI, Taisuke | 0.5.4 |
| 292 | resmushit-image-optimizer | reSmush.it : The original free image com | 100,000 | 2026-08-20 | ShortPixel | 1.0.6 |
| 293 | independent-analytics | Independent Analytics – WordPress Analyt | 100,000 | 2026-08-20 | Ben Sibley | 2.15.5 |
| 294 | mainwp-child-reports | MainWP Child Reports | 100,000 | 2026-08-20 | mainwp | 2.3.1 |
| 295 | pubsubhubbub | WebSub (FKA. PubSubHubbub) | 100,000 | 2026-08-21 | joshfraz | 4.0.1 |
| 296 | one-user-avatar | One User Avatar | User Profile Picture | 100,000 | 2026-08-21 | One Designs | 2.5.6 |
| 297 | wp-whatsapp | WP Chat App | 100,000 | 2026-08-23 | Ninja Team | 3.8.2 |
| 298 | wp-sweep | WP-Sweep | 100,000 | 2026-08-24 | Lester Chan | 2.0.1 |
| 299 | advanced-nocaptcha-recaptcha | CAPTCHA 4WP – Antispam CAPTCHA solution  | 100,000 | 2026-08-25 | WPKube | 7.6.2 |
| 300 | performance-lab | Performance Lab | 100,000 | 2026-08-26 | WordPress Performance Team | 4.2.0 |
| 301 | webp-uploads | Modern Image Formats | 100,000 | 2026-08-26 | WordPress Performance Team | 2.7.1 |
| 302 | no-category-base-wpml | No Category Base (WPML) | 100,000 | 2026-08-27 | DigitalME | 1.5.7 |
| 303 | acf-extended | Advanced Custom Fields: Extended | 100,000 | 2026-08-27 | Konrad Chmielewski | 0.9.2.7 |
| 304 | head-footer-code | Head & Footer Code | 100,000 | 2026-08-31 | Aleksandar Urošević | 1.5.9 |
| 305 | content-views-query-and-display-post-page | Content Views – Post Grid & Filter (Shor | 100,000 | 2026-08-31 | Content Views | 4.5.1.2 |
| 306 | vk-block-patterns | VK Block Patterns | 100,000 | 2026-08-31 | Vektor,Inc. | 1.39.1 |
| 307 | pods | Pods – Custom Content Types and Fields | 100,000 | 2026-08-31 | Scott Kingsley Clark | 3.3.9.2 |
| 308 | auto-image-attributes-from-filename-with-bulk-updater | Auto Image Attributes From Filename With | 100,000 | 2026-09-01 | Arun Basil Lal | 4.9.1 |
| 309 | gravity-forms-zero-spam | Gravity Forms Zero Spam | 100,000 | 2026-09-01 | GravityKit | 1.10.2 |
| 310 | check-email | Check & Log Email – Easy Email Testing & | 100,000 | 2026-09-02 | checkemail | 2.0.16 |
| 311 | woo-razorpay | Razorpay for WooCommerce | 100,000 | 2026-09-04 | Razorpay | 4.8.8 |
| 312 | vk-all-in-one-expansion-unit | VK All in One Expansion Unit | 100,000 | 2026-09-05 | Hidekazu Ishikawa | 9.123.1 |
| 313 | ssl-insecure-content-fixer | SSL Insecure Content Fixer | 100,000 | 2026-09-06 | webaware | 2.7.2 |
| 314 | youtube-embed-plus | Embed Plus for YouTube Gallery, Livestre | 100,000 | 2026-09-06 | embedplus | 14.2.6.1 |
| 315 | widget-options | Widget Options – Advanced Conditional Vi | 100,000 | 2026-09-11 | Marketing Fire | 4.2.5 |
| 316 | google-language-translator | Translate WordPress – Google Language Tr | 100,000 | 2026-09-11 | edo888 | 7.0.1 |
| 317 | simple-lightbox | Simple Lightbox | 100,000 | 2026-09-12 | Archetyped | 2.9.5 |
| 318 | disable-remove-google-fonts | Disable and Remove Google Fonts | GDPR & | 100,000 | 2026-09-13 | fontsplugin | 2.0.3 |
| 319 | ads-txt | Ads.txt Manager | 100,000 | 2026-09-14 | 10up | 1.4.6 |
| 320 | shortcoder | Shortcoder — Create Shortcodes for Anyth | 100,000 | 2026-09-14 | vaakash | 6.6 |
| 321 | disable-admin-notices | Disable Admin Notices – Hide Dashboard N | 100,000 | 2026-09-14 | Themeisle | 1.4.8 |
| 322 | matomo | Matomo Analytics – Powerful, Privacy-Fir | 100,000 | 2026-09-15 | matomoteam | 5.13.1 |
| 323 | filester | File Manager Pro – Filester | 100,000 | 2026-09-16 | Ninja Team | 2.1.4 |
| 324 | wp-asset-clean-up | Asset CleanUp: Page Speed Booster | 100,000 | 2026-09-16 | Gabe Livan | 1.4.0.6 |
| 325 | malcare-security | MalCare WordPress Security Plugin – Malw | 100,000 | 2026-09-17 | malcare | 6.76 |
| 326 | woo-discount-rules | Discount Rules for WooCommerce | 100,000 | 2026-09-17 | flycart | 2.6.18 |
| 327 | simple-social-icons | Simple Social Icons | 100,000 | 2026-09-17 | OsomPress | 4.1.0 |
| 328 | wps-limit-login | WPS Limit Login | 100,000 | 2026-09-18 | NicolasKulka | 1.5.9.4 |
| 329 | ultimate-social-media-icons | Social Media Share Buttons & Social Shar | 100,000 | 2026-09-18 | Inisev | 3.0.2 |
| 330 | persian-woocommerce | ووکامرس فارسی | 100,000 | 2026-09-19 | PersianScript | 10.0.5 |
| 331 | statify | Statify | 100,000 | 2026-09-20 | pluginkollektiv | 2.0.3 |
| 332 | captcha-code-authentication | Captcha Code | 100,000 | 2026-09-21 | WebFactory | 3.33 |
| 333 | wp-content-copy-protector | WP Content Copy Protection & No Right Cl | 100,000 | 2026-09-22 | wp-buy | 4.2 |
| 334 | aruba-hispeed-cache | Aruba HiSpeed Cache | 100,000 | 2026-09-22 | Aruba.it Dev | 3.1.0 |
| 335 | formlayer | FormLayer | 100,000 | 2026-09-22 | Softaculous | 1.1.1 |
| 336 | wp-parsidate | پارسی دیت – Parsi Date | 100,000 | 2026-09-23 | Morteza Geransayeh | 6.4 |
| 337 | simple-page-ordering | Simple Page Ordering | 100,000 | 2026-09-24 | 10up | 2.8.1 |
| 338 | omnisend | Newsletters, Email Marketing, SMS and Po | 100,000 | 2026-09-24 | Omnisend | 1.9.1 |
| 339 | contact-form-7-simple-recaptcha | LukasApps CAPTCHA tools for Contact Form | 100,000 | 2026-09-24 | LukasApps | 0.2.0 |
| 340 | disable-comments-rb | Disable Comments | 100,000 | 2026-09-25 | rbplugins | 1.0.28 |
| 341 | beaver-builder-lite-version | Beaver Builder Page Builder – Drag and D | 100,000 | 2026-09-25 | Beaver Builder | 2.11.0.6 |
| 342 | relevanssi | Relevanssi – A Better Search | 100,000 | 2026-09-26 | Christoph Vielgrader | 4.28.4 |
| 343 | wordpress-popular-posts | WP Popular Posts | 100,000 | 2026-09-27 | Hector Cabrera | 7.4.3 |
| 344 | the-post-grid | The Post Grid – Shortcode, Gutenberg Blo | 100,000 | 2026-09-27 | RadiusTheme | 7.9.7 |
| 345 | cache-enabler | Cache Enabler | 100,000 | 2026-09-27 | KeyCDN | 1.8.17 |
| 346 | two-factor | Two Factor | 100,000 | 2026-09-28 | WordPress.org | 0.17.0 |
| 347 | woo-smart-wishlist | WPC Smart Wishlist for WooCommerce | 100,000 | 2026-09-28 | WPClever | 6.2.0 |
| 348 | menu-icons | Menu Icons by Themeisle – Add Icons to N | 100,000 | 2026-09-29 | Themeisle | 0.13.25 |
| 349 | themeisle-companion | Orbit Fox: Duplicate Page, Menu Icons, S | 100,000 | 2026-09-29 | Themeisle | 3.0.10 |
| 350 | feeds-for-youtube | Feeds for YouTube (YouTube video, channe | 100,000 | 2026-09-29 | Syed Balkhi | 2.10.0 |
| 351 | string-locator | String locator | 100,000 | 2026-09-29 | InstaWP | 2.6.8 |
| 352 | robin-image-optimizer | Robin Image Optimizer – Unlimited Image  | 100,000 | 2026-09-29 | Themeisle | 2.0.9 |
| 353 | custom-facebook-feed | Smash Balloon Social Post Feed – Simple  | 100,000 | 2026-09-30 | Syed Balkhi | 4.14.0 |
| 354 | custom-twitter-feeds | Custom Twitter Feeds – A Tweets Widget o | 100,000 | 2026-09-30 | Syed Balkhi | 2.10.0 |
| 355 | 404-to-301 | 404 to 301 – Redirect Manager, 301 Redir | 100,000 | 2026-09-30 | Syed Balkhi | 4.0.5 |
| 356 | templates-patterns-collection | Starter Sites & Templates by Neve | 100,000 | 2026-09-30 | Themeisle | 1.4.6 |
| 357 | real-media-library-lite | Real Media Library: Media Library Folder | 100,000 | 2026-09-30 | devowl.io GmbH | 4.23.7 |
| 358 | addquicktag | AddQuicktag | 100,000 | 2026-10-01 | Frank Bueltge | 2.6.2 |
| 359 | wp-all-export | WP All Export – Drag & Drop Export to An | 100,000 | 2026-10-01 | Soflyy | 1.6.0 |
| 360 | vk-blocks | VK Blocks | 100,000 | 2026-10-02 | Vektor,Inc. | 1.128.0 |
| 361 | woo-stripe-payment | Payment Plugins for Stripe WooCommerce | 100,000 | 2026-10-03 | Payment Plugins | 4.0.18 |
| 362 | responsive-lightbox | Responsive Lightbox & Gallery | 100,000 | 2026-10-05 | dFactory | 2.7.10 |
| 363 | wp-all-import | WP All Import – Drag & Drop Import for C | 100,000 | 2026-10-05 | WP All Import | 4.1.3 |
| 364 | search-regex | Search Regex | 100,000 | 2026-10-06 | John Godley | 3.5.1 |
| 365 | angie | Angie – Agentic AI | 100,000 | 2026-10-06 | Elementor | 1.1.19 |
| 366 | ninjafirewall | NinjaFirewall (WP Edition) – Advanced Se | 100,000 | 2026-10-06 | nintechnet | 4.9.2 |
| 367 | login-lockdown | Login Lockdown & Protection | 100,000 | 2026-10-06 | WebFactory | 2.19 |
| 368 | rocket-lazy-load | LazyLoad Plugin – Lazy Load Images, Vide | 100,000 | 2026-10-06 | WP Media | 2.4.1 |
| 369 | shopengine | ShopEngine – All-in-One Elementor WooCom | 100,000 | 2026-10-06 | Roxnor | 4.9.7 |
| 370 | foogallery | FooGallery Photo Gallery : Image, Video  | 100,000 | 2026-10-07 | FooPlugins | 3.3.8 |
| 371 | woocommerce-multilingual | WPML Multilingual & Multicurrency for Wo | 100,000 | 2026-10-07 | Amir Helzer | 5.6.3 |
| 372 | codepress-admin-columns | Admin Columns | 100,000 | 2026-10-07 | Codepress | 7.1.7 |
| 373 | envira-gallery-lite | Envira Gallery – Image Photo Gallery, Al | 100,000 | 2026-10-07 | Syed Balkhi | 1.16.2 |
| 374 | the-plus-addons-for-elementor-page-builder | The Plus Addons for Elementor – Mega Men | 100,000 | 2026-10-07 | POSIMYTH | 6.5.3 |
| 375 | woocommerce-mercadopago | Mercado Pago payments for WooCommerce | 100,000 | 2026-10-07 | Mercado Pago | 8.9.6 |
| 376 | wp-downgrade | WP Downgrade | Specific Core Version | 100,000 | 2026-10-07 | Reisetiger | 1.2.9 |
| 377 | post-expirator | Schedule Post Changes With PublishPress  | 100,000 | 2026-10-07 | PublishPress | 4.10.7 |
| 378 | tuxedo-big-file-uploads | Big File Uploads – Increase Maximum File | 100,000 | 2026-10-07 | Infinite Uploads | 2.2.2 |
| 379 | embedpress | EmbedPress – PDF Embedder, 3D PDF FlipBo | 100,000 | 2026-10-07 | WPDeveloper | 4.6.8 |
| 380 | post-views-counter | Post Views Counter | 100,000 | 2026-10-08 | dFactory | 1.8.0 |
| 381 | ajax-search-for-woocommerce | FiboSearch – Ajax Search for WooCommerce | 100,000 | 2026-10-08 | Damian Góra | 1.34.3 |
| 382 | cookiebot | Cookiebot by Usercentrics – Automatic Co | 100,000 | 2026-10-08 | cookiebot | 4.7.5 |
| 383 | manage-notification-emails | Manage Notification E-mails | 100,000 | 2026-10-08 | 3D Virge | 1.9.2 |
| 384 | manage | Manage – Centralized site maintenance an | 100,000 | 2026-10-08 | Elementor | 1.0.11 |
| 385 | wp-staging | WP STAGING – Backups & Restore, Migratio | 100,000 | 2026-10-09 | Rene Hermenau | 4.17.0 |
| 386 | so-css | SiteOrigin CSS | 100,000 | 2026-10-09 | Greg - SiteOrigin | 1.6.8 |
| 387 | recent-posts-widget-with-thumbnails | Recent Posts Widget With Thumbnails | 100,000 | 2026-10-10 | Kybernetik Services | 7.2.0 |
| 388 | advanced-access-manager | Access Governance for WordPress (aka AAM | 100,000 | 2026-10-10 | AAM Plugin | 8.0.1 |
| 389 | cf7-conditional-fields | Conditional Fields for Contact Form 7 | 100,000 | 2026-10-11 | Jules Colle | 2.8.2 |
| 390 | widget-google-reviews | Rich Showcase for Google Reviews | 100,000 | 2026-10-12 | richplugins | 7.1.6 |
| 391 | woo-order-export-lite | Advanced Order Export For WooCommerce | 100,000 | 2026-10-12 | algol.plus | 4.1.3 |
| 392 | schema-and-structured-data-for-wp | Schema & Structured Data for WP & AMP | 100,000 | 2026-10-12 | Magazine3 | 1.68 |
| 393 | https-redirection | Easy HTTPS Redirection (SSL) | 100,000 | 2026-10-12 | mra13 / Team Tips and Tricks H | 2.0.2 |
| 394 | ti-woocommerce-wishlist | TI WooCommerce Wishlist | 100,000 | 2026-10-12 | templateinvaders | 2.13.0 |
| 395 | reviews-feed | Reviews Feed – Add Testimonials and Cust | 100,000 | 2026-10-12 | Syed Balkhi | 2.15.1 |
| 396 | redirect-redirection | Redirection | 100,000 | 2026-10-12 | Inisev | 1.4.0 |
| 397 | foobox-image-lightbox | Lightbox & Modal Popup WordPress Plugin  | 100,000 | 2026-10-12 | FooPlugins | 2.8.7 |
| 398 | mystickymenu | My Sticky Bar – Floating Notification Ba | 100,000 | 2026-10-12 | Premio | 2.9.3 |
| 399 | mollie-payments-for-woocommerce | Mollie Payments for WooCommerce | 100,000 | 2026-10-12 | Mollie | 8.1.11 |
| 400 | woocommerce-google-analytics-integration | Google Analytics for WooCommerce | 100,000 | 2026-10-13 | WooCommerce | 2.4.3 |
| 401 | tiny-compress-images | TinyPNG Image Optimization – Image Compr | 100,000 | 2026-10-13 | TinyPNG | 3.8.1 |
| 402 | stackable-ultimate-gutenberg-blocks | Stackable – Page Builder Gutenberg Block | 100,000 | 2026-10-13 | Benjamin Intal | 3.20.3 |
| 403 | flexible-shipping | Weight Based Shipping Table Rate for Woo | 100,000 | 2026-10-13 | Octolize Shipping Plugins | 6.13.3 |
| 404 | give | GiveWP – Donation Plugin and Fundraising | 100,000 | 2026-10-13 | Nexcess | 4.19.0 |
| 405 | custom-permalinks | Custom Permalinks | 100,000 | 2026-10-13 | Sami Ahmed Siddiqui | 3.3.3 |
| 406 | yith-woocommerce-compare | YITH WooCommerce Compare | 100,000 | 2026-10-13 | YITHEMES | 3.15.1 |
| 407 | permalink-manager | Permalink Manager Lite | 100,000 | 2026-10-13 | Maciej Bis | 2.6.1 |
| 408 | bdthemes-prime-slider-lite | Prime Slider – Hero Slider, Carousel, Wo | 100,000 | 2026-10-13 | bdthemes | 4.7.2 |
| 409 | cloudsecure-wp-security | CloudSecure WP Security | 100,000 | 2026-10-14 | XServer | 1.4.18 |
| 410 | file-manager-advanced | Advanced File Manager – Ultimate File Ma | 100,000 | 2026-10-14 | Saad Iqbal | 6.0.0 |
| 411 | real-cookie-banner | Real Cookie Banner: GDPR & ePrivacy Cook | 100,000 | 2026-10-14 | devowl.io GmbH | 5.4.0 |
| 412 | wp-2fa | WP 2FA – Two-factor authentication for W | 100,000 | 2026-10-14 | Melapress | 4.2.1 |
| 413 | modula-best-grid-gallery | Modula Image Gallery – Photo Grid & Vide | 100,000 | 2026-10-14 | WP Chill | 3.0.13 |
| 414 | bdthemes-element-pack-lite | Element Pack Addons for Elementor – MCP  | 100,000 | 2026-10-14 | bdthemes | 10.0.0 |
| 415 | hide-my-wp | Hide My WP Ghost – Security & Firewall | 100,000 | 2026-10-14 | John Darrel | 7.0.13 |
| 416 | advanced-ads | Advanced Ads – Ad Manager & AdSense | 100,000 | 2026-10-14 | monetizemore | 2.0.29 |
| 417 | capability-manager-enhanced | PublishPress Capabilities: User Role Acc | 100,000 | 2026-10-14 | PublishPress | 2.53.0 |
| 418 | photo-gallery | Photo Gallery by 10Web – Mobile-Friendly | 100,000 | 2026-10-15 | 10Web | 1.8.48 |
| 419 | simple-301-redirects | Simple 301 Redirects by BetterLinks – Ea | 100,000 | 2026-10-15 | WPDeveloper | 2.1.1 |
| 420 | wp-user-avatar | Paid Membership Plugin, Ecommerce, User  | 100,000 | 2026-10-15 | properfraction | 4.17.7 |
| 421 | presto-player | Presto Player | 100,000 | 2026-10-15 | Andre Gagnon | 4.5.4 |
| 422 | bbpress | bbPress | 100,000 | 2026-10-15 | John James Jacoby | 2.6.20 |
| 423 | secure-custom-fields | Secure Custom Fields | 100,000 | 2026-10-15 | WordPress.org | 6.9.6 |
| 424 | tutor | Tutor LMS – eLearning and online course  | 100,000 | 2026-10-15 | Themeum | 4.1.3 |
| 425 | download-manager | Download Manager | 100,000 | 2026-10-15 | Shahjada | 3.3.73 |
| 426 | latepoint | Appointment Booking Plugin – LatePoint | | 100,000 | 2026-10-16 | LatePoint | 5.7.5 |
| 427 | ele-custom-skin | ECS – Ele Custom Skin for Elementor | 100,000 | 2026-10-16 | dudaster | 4.3.13 |
