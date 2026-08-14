# 動画リスト更新手順

このファイルの手順に従えば、誰でも(数か月後の自分でも、Claude Codeでも)
動画リストを更新できます。

## Claude Codeに依頼する場合

「docs/UPDATE.md に従って新着動画を追加して」と依頼してください。
Claude Codeは以下の手順1〜5を実行し、手順4の分類確認だけを
あなたに提示して承認を求めます。

## 手順

### 1. 新着動画を確認する
```
node scripts/fetch-new.mjs
```
- 新着があれば scripts/inbox.json に下書きが作られます
- 事前に .env に YOUTUBE_API_KEY を設定しておくこと(.env.example参照)

### 2. 視聴可否を確認する
- inbox.json の各動画URLを開き、ログインなし・無料で再生できることを確認
- メンバー限定・限定公開・削除済みの動画は inbox.json から削除する

### 3. 分類する
inbox.json の各動画に intensity / type / tags を記入します。

**intensity(強度)**
- 1: リラックス・ストレッチ中心。汗をかかない
- 2: 通常のフロー。ほどよく動く
- 3: パワー系・体幹強化。運動量が多い

**type(役割)**
- warmup: 5〜12分の準備運動・目覚まし系
- main: その日の中心になるレッスン(迷ったらこれ)
- cooldown: 10分以下のストレッチ・就寝前系
- meditation: 瞑想・呼吸法(ほぼ動かない)

**tags(1〜5個)**
- data/vocabulary.json にある語だけを使う
- タイトル・内容に合う語を選ぶ。無理に5個つけない
- 語彙にない概念が必要になったら、安易に追加せず、
  既存語で表せないか先に検討する(追加する場合はこのファイルにも基準を書く)

### 4. videos.json に追加する
- inbox.json の内容を data/videos.json の videos 配列末尾に追記
- "updated" の日付を今日に更新
- inbox.json にのみ含まれる `_privacyStatus` 等の参考情報は、videos.json には転記しない(§4.1のスキーマにない項目のため)

### 5. 検証する
```
node scripts/validate.mjs
```
- エラーが出たら修正して再実行。エラーゼロになるまでpushしない
- 年に1回程度は --check-live 付きで実行し、視聴不可動画を削除する

### 6. 動作確認する
- ローカルで `python3 -m http.server` 等を起動し index.html を開く
- 追加した動画が推薦に出てくるか、いくつかの条件で確認

### 7. GitHubに反映する
```
git add data/ && git commit -m "add videos" && git push
```
- 数分後に公開サイトへ反映されます
