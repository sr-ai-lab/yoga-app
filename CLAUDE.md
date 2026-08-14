# CLAUDE.md

## このプロジェクトについて
スマートフォン用ヨガ動画推薦Webアプリ。GitHub Pagesで公開する静的サイト。
設計の全体像は docs/DESIGN.md(本設計ドキュメント)を参照。

## 構造の原則(変更しないこと)
- アプリ本体(index.html / style.css / app.js)は依存パッケージゼロ・ビルドなし
- 動画データは data/videos.json。アプリのロジックとデータは分離を維持する
- 推薦の重み調整は data/modes.json の編集で行い、app.js は触らない
- タグは data/vocabulary.json の語のみ。勝手に語彙を追加しない

## よくある作業
- 新着動画の追加: docs/UPDATE.md の手順に従う。分類(intensity/type/tags)の
  最終確認は必ずユーザーに提示して承認を得ること
- 推薦結果の調整: modes.json の重みを変更 → ユーザーに差分を説明
- validate.mjs がエラーの状態で commit しない

## 注意
- .env(APIキー)を読むのは scripts/ のみ。フロントエンドにキーを置かない
- youtube.com/watch_videos?video_ids= は非公式URL。動かなくなった場合は
  個別リンク表示のみに切り替える(app.jsにフォールバック実装済み)
