// テスト共通の部品: 偽のYouTube APIクライアント、テスト用の動画データ、同期の呼び出し
import path from "node:path";
import { ROOT, readJson } from "../lib/util.mjs";
import { emptyCatalog, resolveAll } from "../lib/catalog.mjs";
import { runSync } from "../lib/sync.mjs";

export const rules = await readJson(path.join(ROOT, "data/classification-rules.json"));
export const vocabulary = await readJson(path.join(ROOT, "data/vocabulary.json"));
export const vocabularyTags = new Set(Object.values(vocabulary.categories).flat());

export const CH_A = { name: "chan-a", channel_id: "UC_A", handle: "@a" };
export const CH_B = { name: "chan-b", channel_id: "UC_B", handle: "@b" };
export const config = { channels: [CH_A, CH_B], limits: { max_duration_min: 60, shorts_max_sec: 180, incremental_max_pages: 6 } };
export const TODAY = "2026-11-01";

export const id = (n) => String(n).padStart(11, "x"); // 11文字のダミーID

// 動画の「API上の姿」を作る
export function video({ n, title, sec = 600, channel = "UC_A", live = false, privacy = "public", published = "2026-01-01T00:00:00Z" }) {
  return {
    id: id(n),
    snippet: { title, publishedAt: published, channelId: channel, description: "" },
    contentDetails: { duration: sec ? `PT${Math.floor(sec / 60)}M${sec % 60}S` : "P0D" },
    status: { privacyStatus: privacy },
    ...(live ? { liveStreamingDetails: { actualStartTime: "2026-01-01T00:00:00Z" } } : {}),
  };
}

// YouTube APIの代わりになる偽クライアント
//   shortsAvailable: チャンネルごとにShorts一覧(UUSH)が取得できるか(既定: できる)
//   flakyOnce: 最初の1回だけ結果から漏れる動画(一時的な取りこぼしの模擬)
export function fakeClient({ channels, shorts = {}, shortsAvailable = {}, failChannel = null, flakyOnce = [] }) {
  const all = new Map();
  const flaky = new Set(flakyOnce);
  for (const c of Object.values(channels)) for (const v of c.videos) all.set(v.id, v);
  return {
    async getChannel(channelId) {
      if (failChannel === channelId) throw new Error("quotaExceeded (模擬)");
      const c = channels[channelId];
      return c && { id: channelId, title: c.title ?? channelId, handle: c.handle, uploadsPlaylistId: `UU${channelId}`, videoCount: c.videos.length };
    },
    async listUploads(playlistId) {
      const c = channels[playlistId.slice(2)];
      return { refs: c.videos.map((v) => ({ id: v.id, title: v.snippet.title, publishedAt: v.snippet.publishedAt })), pages: 1, complete: true };
    },
    async listShortsIds(channelId) {
      const available = shortsAvailable[channelId] ?? true;
      return { ids: new Set(available ? (shorts[channelId] ?? []) : []), available };
    },
    async getVideos(ids) {
      const out = new Map();
      for (const i of ids) {
        if (!all.has(i)) continue;
        if (flaky.has(i)) {
          flaky.delete(i);
          continue;
        }
        out.set(i, all.get(i));
      }
      return out;
    },
  };
}

export const world = () => ({
  UC_A: {
    handle: "@a",
    videos: [
      video({ n: 1, title: "【10分】肩こり解消ストレッチヨガ", sec: 600 }),
      video({ n: 2, title: "【ライブ】夜のヨガ配信アーカイブ ストレッチ", sec: 1800, live: true }),
      video({ n: 3, title: "朝の全身ストレッチヨガ", sec: 45 }),
      video({ n: 4, title: "チャンネルからのお知らせ", sec: 300 }),
      video({ n: 5, title: "腰痛予防ヨガ #shorts", sec: 40 }),
      video({ n: 6, title: "ヨガの不思議", sec: 900 }),
    ],
  },
  UC_B: {
    handle: "@b",
    videos: [
      video({ n: 11, title: "【15分】股関節をゆるめるやさしいヨガ", sec: 900, channel: "UC_B" }),
      video({ n: 12, title: "本気のお腹トレーニング・ヨガ", sec: 600, channel: "UC_B" }),
    ],
  },
});

export const sync = (client, state = {}, mode = "backfill", extra = {}) =>
  runSync({
    mode,
    client,
    config: extra.config ?? config,
    catalog: state.catalog ?? emptyCatalog(),
    overrides: state.overrides ?? { videos: {} },
    rules,
    vocabularyTags,
    today: extra.today ?? TODAY,
    ...(extra.now ? { now: extra.now } : {}),
  });

export const incremental = (client, catalog, extra) => sync(client, { catalog }, "incremental", extra);

export const statusOf = (result, overrides, n) => resolveAll(result.catalog, overrides ?? { videos: {} }, vocabularyTags).resolved.get(id(n));
