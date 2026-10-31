# CLAUDE.md

## このプロジェクトについて
スマートフォン用ヨガ動画推薦Webアプリ。GitHub Pagesで公開する静的サイト。
設計の全体像は docs/DESIGN.md(本設計ドキュメント)を参照。

## 構造の原則(変更しないこと)
- アプリ本体(index.html / style.css / app.js)は依存パッケージゼロ・ビルドなし
- 動画データ: アプリが読むのは data/videos.json だが、これは **生成物**(直接編集しない)。
  元データは data/catalog.json(自動取得+自動分類の台帳)と data/overrides.json(人の修正)。
  アプリのロジックとデータは分離を維持する
- 推薦の重み調整は data/modes.json の編集で行い、app.js は触らない
- タグは data/vocabulary.json の語のみ。勝手に語彙を追加しない

## よくある作業
- 新着動画の追加: 毎週月曜にGitHub Actionsが自動更新する(docs/UPDATE.md)。公開はGitHub Actions経由(deploy-pages.yml)。
  自動分類できず保留になった動画(docs/HELD.md)を採用する場合は、分類(intensity/type/tags)の
  案をユーザーに提示して承認を得てから data/overrides.json に書くこと
- 人の修正は overrides.json にだけ書く。catalog.json は自動処理専用(手で編集しない)
- 分類ルールの変更: data/classification-rules.json を編集 → `--reclassify` で差分を確認 → ユーザーに説明
- 推薦結果の調整: modes.json の重みを変更 → ユーザーに差分を説明
- validate.mjs がエラーの状態で commit しない。データ変更後は
  `node scripts/catalog-sync.mjs --rebuild` → `node scripts/validate.mjs` → `node --test scripts/test/*.test.mjs`

## 注意
- .env(APIキー)を読むのは scripts/ のみ。フロントエンドにキーを置かない。
  本番のキーは GitHub Secrets(YOUTUBE_API_KEY)だけに置く。YouTube APIを呼ぶのはActions/ローカルのscriptsだけ(Pagesからは呼ばない)
- youtube.com/watch_videos?video_ids= は非公式URL。動かなくなった場合は
  個別リンク表示のみに切り替える(app.jsにフォールバック実装済み)
