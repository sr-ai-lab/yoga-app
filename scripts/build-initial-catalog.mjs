// scripts/build-initial-catalog.mjs
// design.md §9.5: 初回(および追加)カタログ構築 — uploadsプレイリストをさかのぼって過去動画を取得する。
// fetch-new.mjs(直近15本のRSS新着検知)とは役割が異なる別ツール。RSSの範囲を超えた
// 過去動画にアクセスするため、YouTube Data APIのuploadsプレイリストを使う。
//
// 使い方:
//   node scripts/build-initial-catalog.mjs [--max-pages=N]
//     --max-pages: 1チャンネルあたり今回取得するページ数の上限(1ページ=最大50件。既定値5)
//                  0を指定すると、動画取得は行わずチャンネルの母集団規模だけを確認する
//
// 出力:
//   scripts/catalog-candidates.json … 今回取得した候補の下書き(intensity/type/tagsは"TODO")。
//                                      既存分に追記する(上書きしない)
//   scripts/catalog-progress.json  … video ID単位の処理状況を記録する進捗ファイル。
//                                      pageTokenは再開の目安として補助的に使うのみで、
//                                      重複判定の根拠には videos.json の既存IDとこのファイルの
//                                      processed(video ID単位の記録)を使う
//
// このスクリプトはアプリの通常利用では実行されない。カタログ拡充のときにのみ人が実行する。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROGRESS_PATH = path.join(ROOT, "scripts/catalog-progress.json");
const CANDIDATES_PATH = path.join(ROOT, "scripts/catalog-candidates.json");

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

async function loadJsonOptional(absolutePath, fallback) {
  try {
    const text = await readFile(absolutePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
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

function parseArgs(argv) {
  const maxPagesArg = argv.find((a) => a.startsWith("--max-pages="));
  const raw = maxPagesArg ? Number(maxPagesArg.split("=")[1]) : 5;
  const maxPages = Number.isFinite(raw) && raw >= 0 ? raw : 5;
  return { maxPages };
}

// 両チャンネル分をまとめて1回で取得する(1リクエスト=1ユニット)
async function getChannelInfo(apiKey, channelIds) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails,statistics");
  url.searchParams.set("id", channelIds.join(","));
  url.searchParams.set("key", apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`channels.list の呼び出しに失敗しました: HTTP ${res.status}`);
  }
  const data = await res.json();
  const result = new Map();
  for (const item of data.items ?? []) {
    result.set(item.id, {
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
      videoCount: Number(item.statistics?.videoCount ?? 0),
    });
  }
  return result;
}

async function fetchPlaylistPage(apiKey, playlistId, pageToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("playlistId", playlistId);
  url.searchParams.set("maxResults", "50");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("key", apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`playlistItems.list の呼び出しに失敗しました: HTTP ${res.status}`);
  }
  return res.json();
}

// videos.list は一度に最大50件まで指定できる
async function fetchVideoDetails(apiKey, ids) {
  const details = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "contentDetails,status,snippet,statistics");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`videos.list の呼び出しに失敗しました: HTTP ${res.status}`);
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

  const { maxPages } = parseArgs(process.argv.slice(2));

  const config = await loadJson("scripts/config.json");
  const videosData = await loadJson("data/videos.json");
  const existingIds = new Set(videosData.videos.map((v) => v.id));

  const progress = await loadJsonOptional(PROGRESS_PATH, {
    schema_version: 1,
    updated: null,
    channels: {},
    processed: {},
  });

  // 重複判定はvideo ID基準: videos.jsonの既存分 + このファイルで一度でも処理した(採用/除外/候補化)ID
  const knownIds = new Set([...existingIds, ...Object.keys(progress.processed)]);

  const activeChannels = config.channels.filter((c) => c.channel_id && !c.channel_id.startsWith("("));
  const channelInfo = await getChannelInfo(
    apiKey,
    activeChannels.map((c) => c.channel_id)
  );

  const newCandidateRefs = [];
  let skippedAlreadyInVideosJson = 0;
  let skippedAlreadyProcessed = 0;

  for (const channel of activeChannels) {
    const info = channelInfo.get(channel.channel_id);
    if (!info?.uploadsPlaylistId) {
      console.warn(`警告: ${channel.name} のuploadsプレイリストIDが取得できませんでした`);
      continue;
    }

    progress.channels[channel.name] ??= {
      channel_id: channel.channel_id,
      uploads_playlist_id: info.uploadsPlaylistId,
      video_count: info.videoCount,
      next_page_token: null,
      fully_scanned: false,
    };
    const channelState = progress.channels[channel.name];
    channelState.uploads_playlist_id = info.uploadsPlaylistId;
    channelState.video_count = info.videoCount;

    console.log(`${channel.name}: 公開動画 ${info.videoCount} 本(チャンネル統計上の件数)`);

    if (maxPages === 0) continue; // 母集団規模の確認のみで、取得は行わない

    if (channelState.fully_scanned) {
      console.log(`  → 既に全件走査済みです(スキップ)`);
      continue;
    }

    let pageToken = channelState.next_page_token || undefined;
    let pagesFetched = 0;

    while (pagesFetched < maxPages) {
      const page = await fetchPlaylistPage(apiKey, channelState.uploads_playlist_id, pageToken);
      pagesFetched++;

      for (const item of page.items ?? []) {
        const videoId = item.snippet?.resourceId?.videoId;
        if (!videoId) continue;
        if (existingIds.has(videoId)) {
          skippedAlreadyInVideosJson++;
          continue;
        }
        if (knownIds.has(videoId)) {
          skippedAlreadyProcessed++;
          continue;
        }
        knownIds.add(videoId);
        newCandidateRefs.push({
          id: videoId,
          title: item.snippet?.title ?? "",
          publishedAt: item.snippet?.publishedAt ?? "",
          channel: channel.name,
        });
      }

      pageToken = page.nextPageToken;
      if (!pageToken) {
        channelState.fully_scanned = true;
        break;
      }
    }
    channelState.next_page_token = pageToken || null;

    console.log(
      `  → 今回${pagesFetched}ページ取得(${channelState.fully_scanned ? "全件走査完了" : "続きあり。次回はこの続きから再開します"})`
    );
  }

  progress.updated = new Date().toISOString().slice(0, 10);

  if (skippedAlreadyInVideosJson > 0) {
    console.log(`data/videos.json に既存のため重複スキップ: ${skippedAlreadyInVideosJson} 件`);
  }
  if (skippedAlreadyProcessed > 0) {
    console.log(`過去に処理済み(候補化/除外)のため重複スキップ: ${skippedAlreadyProcessed} 件`);
  }

  if (newCandidateRefs.length === 0) {
    await writeFile(PROGRESS_PATH, JSON.stringify(progress, null, 2) + "\n", "utf8");
    console.log("新規に取得した候補はありません。");
    return;
  }

  const details = await fetchVideoDetails(
    apiKey,
    newCandidateRefs.map((c) => c.id)
  );

  const drafts = [];
  let rejectedNotPublic = 0;
  let rejectedNoDuration = 0;

  for (const ref of newCandidateRefs) {
    const detail = details.get(ref.id);
    const privacyStatus = detail?.status?.privacyStatus ?? "unknown";
    const durationMin = parseIsoDurationToMinutes(detail?.contentDetails?.duration);

    if (privacyStatus !== "public") {
      progress.processed[ref.id] = { status: "rejected", reason: "not_public", channel: ref.channel };
      rejectedNotPublic++;
      continue;
    }
    if (durationMin <= 0) {
      progress.processed[ref.id] = { status: "rejected", reason: "live_or_unknown_duration", channel: ref.channel };
      rejectedNoDuration++;
      continue;
    }

    drafts.push({
      id: ref.id,
      title: ref.title,
      channel: ref.channel,
      published_at: ref.publishedAt,
      duration_min: durationMin,
      intensity: "TODO",
      type: "TODO",
      tags: ["TODO"],
      // 以下は参考情報。videos.jsonへ追記する際は削除すること(§4.1のスキーマにはない項目)
      _view_count: Number(detail?.statistics?.viewCount ?? 0),
    });
    progress.processed[ref.id] = { status: "candidate", channel: ref.channel };
  }

  if (drafts.length > 0) {
    const existingCandidates = await loadJsonOptional(CANDIDATES_PATH, { generated: null, videos: [] });
    const mergedVideos = [...existingCandidates.videos, ...drafts];
    await writeFile(
      CANDIDATES_PATH,
      JSON.stringify({ generated: new Date().toISOString().slice(0, 10), videos: mergedVideos }, null, 2) + "\n",
      "utf8"
    );
    console.log(
      `新規候補 ${drafts.length} 件を scripts/catalog-candidates.json に追加しました(累計 ${mergedVideos.length} 件)。`
    );
  }

  if (rejectedNotPublic > 0) console.log(`非公開/メンバー限定等のため自動除外: ${rejectedNotPublic} 件`);
  if (rejectedNoDuration > 0) console.log(`時間未確定(ライブ配信等)のため自動除外: ${rejectedNoDuration} 件`);

  await writeFile(PROGRESS_PATH, JSON.stringify(progress, null, 2) + "\n", "utf8");
  console.log("講師インタビュー・告知等の内容面での除外・分類は、この後のレビューで判断してください。");
}

main();
