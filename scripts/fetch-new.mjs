// scripts/fetch-new.mjs
// design.md §9.3: チャンネルRSSで新着動画を検知し、新着分のみYouTube Data APIで詳細を取得する。
// 出力: scripts/inbox.json(下書き。intensity / type / tags は "TODO" のまま)
//
// 使い方: node scripts/fetch-new.mjs
// 事前準備: .env に YOUTUBE_API_KEY を設定しておくこと(.env.example参照)
// このスクリプトはアプリの通常利用では実行されない。動画リスト更新時にのみ人が実行する。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadEnv() {
  try {
    const text = await readFile(path.join(ROOT, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env が無い場合は、環境変数が別途設定されている前提で続行する
  }
}

async function loadJson(relativePath) {
  const text = await readFile(path.join(ROOT, relativePath), "utf8");
  return JSON.parse(text);
}

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// YouTubeチャンネルRSSの <entry> ブロックから videoId・title・公開日を抽出する
function extractEntriesFromRss(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml))) {
    const block = match[1];
    const idMatch = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const titleMatch = block.match(/<title>([^<]*)<\/title>/);
    const publishedMatch = block.match(/<published>([^<]+)<\/published>/);
    if (!idMatch) continue;
    entries.push({
      id: idMatch[1],
      title: titleMatch ? decodeXmlEntities(titleMatch[1]) : "",
      published: publishedMatch ? publishedMatch[1] : "",
    });
  }
  return entries;
}

// ISO8601形式の動画時間("PT12M34S"等)を分(四捨五入)に変換する
function parseIsoDurationToMinutes(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return Math.round(hours * 60 + minutes + seconds / 60);
}

async function fetchChannelEntries(channel, rssUrlTemplate) {
  const url = rssUrlTemplate.replace("{channel_id}", channel.channel_id);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const xml = await res.text();
  return extractEntriesFromRss(xml).map((entry) => ({ ...entry, channel: channel.name }));
}

// videos.list は一度に最大50件まで指定できる
async function fetchVideoDetails(apiKey, ids) {
  const details = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "contentDetails,status,snippet");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`YouTube Data APIの呼び出しに失敗しました: HTTP ${res.status}`);
    }
    const data = await res.json();
    for (const item of data.items ?? []) {
      details.set(item.id, item);
    }
  }
  return details;
}

async function main() {
  await loadEnv();

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("エラー: YOUTUBE_API_KEY が設定されていません。.env.example を参考に .env を作成してください。");
    process.exitCode = 1;
    return;
  }

  const config = await loadJson("scripts/config.json");
  const videosData = await loadJson("data/videos.json");
  const existingIds = new Set(videosData.videos.map((v) => v.id));

  let allEntries = [];
  for (const channel of config.channels) {
    if (!channel.channel_id || channel.channel_id.startsWith("(")) {
      console.warn(`警告: ${channel.name} の channel_id が未設定のためスキップします(scripts/config.json を確認してください)`);
      continue;
    }
    try {
      const entries = await fetchChannelEntries(channel, config.rss_url_template);
      allEntries = allEntries.concat(entries);
    } catch (err) {
      console.error(`RSS取得に失敗しました(${channel.name}): ${err.message}`);
    }
  }

  const newEntries = allEntries.filter((entry) => !existingIds.has(entry.id));

  if (newEntries.length === 0) {
    console.log("新着動画はありませんでした。");
    return;
  }

  const details = await fetchVideoDetails(
    apiKey,
    newEntries.map((entry) => entry.id)
  );

  const drafts = newEntries.map((entry) => {
    const detail = details.get(entry.id);
    return {
      id: entry.id,
      title: entry.title,
      channel: entry.channel,
      duration_min: parseIsoDurationToMinutes(detail?.contentDetails?.duration),
      intensity: "TODO",
      type: "TODO",
      tags: ["TODO"],
      // 以下はinbox.jsonのみで使う参考情報。videos.jsonへ追記する際は削除すること(§4.1のスキーマにはない項目)
      _privacyStatus: detail?.status?.privacyStatus ?? "unknown",
    };
  });

  const inboxPath = path.join(ROOT, "scripts/inbox.json");
  await writeFile(
    inboxPath,
    JSON.stringify({ generated: new Date().toISOString().slice(0, 10), videos: drafts }, null, 2) + "\n",
    "utf8"
  );

  console.log(`新着動画 ${drafts.length} 件を scripts/inbox.json に書き出しました。`);
  console.log("docs/UPDATE.md の手順2以降に従って、視聴可否の確認・分類を行ってください。");
}

main();
