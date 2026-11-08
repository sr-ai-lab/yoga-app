// scripts/lib/youtube.mjs — YouTube Data API v3 の薄いクライアント
// - APIキーはURLクエリでのみ使い、エラーメッセージ・ログには一切含めない(URL自体を出力しない)
// - 429/5xx/ネットワークエラーのみ指数バックオフで再試行する

export class YouTubeApiError extends Error {
  constructor(message, { status = 0, reason = "" } = {}) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = status;
    this.reason = reason;
  }
}

const API_BASE = "https://www.googleapis.com/youtube/v3";

export function createYouTubeClient({
  apiKey,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxRetries = 3,
} = {}) {
  if (!apiKey) throw new YouTubeApiError("YOUTUBE_API_KEY が設定されていません");

  async function call(resource, params) {
    const url = new URL(`${API_BASE}/${resource}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("key", apiKey);

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url);
      } catch {
        if (attempt < maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new YouTubeApiError(`${resource}: ネットワークエラー`);
      }
      if (res.ok) return res.json();

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      let reason = "";
      try {
        const body = await res.json();
        reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? "";
      } catch {
        // 本文が読めなくてもステータスだけ報告する
      }
      throw new YouTubeApiError(`${resource}: HTTP ${res.status}${reason ? ` (${reason})` : ""}`, {
        status: res.status,
        reason,
      });
    }
  }

  return {
    // チャンネル情報(公式チャンネルの照合とuploadsプレイリストID取得用)
    async getChannel(channelId) {
      const data = await call("channels", {
        part: "snippet,contentDetails,statistics",
        id: channelId,
      });
      const item = data.items?.[0];
      if (!item) return null;
      return {
        id: item.id,
        title: item.snippet?.title ?? "",
        handle: item.snippet?.customUrl ?? "",
        uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
        videoCount: Number(item.statistics?.videoCount ?? 0),
      };
    },

    // uploadsプレイリストを新しい順に走査して [{id,title,publishedAt}] を返す。
    // shouldStop(pageRefs) が true を返したページで走査を打ち切る(定期更新の差分取得用)。
    async listUploads(playlistId, { maxPages = Infinity, shouldStop = () => false } = {}) {
      const refs = [];
      let pageToken;
      let pages = 0;
      do {
        const data = await call("playlistItems", {
          part: "snippet,contentDetails",
          playlistId,
          maxResults: 50,
          ...(pageToken ? { pageToken } : {}),
        });
        const pageRefs = (data.items ?? [])
          .map((it) => ({
            id: it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId,
            title: it.snippet?.title ?? "",
            publishedAt: it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt ?? "",
          }))
          .filter((r) => r.id);
        refs.push(...pageRefs);
        pages++;
        pageToken = data.nextPageToken;
        if (shouldStop(pageRefs)) break;
      } while (pageToken && pages < maxPages);
      return { refs, pages, complete: !pageToken };
    },

    // 公式ドキュメントには載っていない派生IDのため、いずれも「補助信号」として扱う。
    // YouTubeが「Shorts」「ライブ」タブとして持つ派生プレイリスト(UUSH / UULV。非公式仕様)の動画ID一覧。
    // 「プレイリストなし」の404だけを available:false とし、権限・クォータ・一時障害などは呼び出し側にエラーとして伝える
    async listDerivedIds(prefix, channelId) {
      const playlistId = `${prefix}${channelId.slice(2)}`;
      const ids = new Set();
      let pageToken;
      try {
        do {
          const data = await call("playlistItems", {
            part: "contentDetails",
            playlistId,
            maxResults: 50,
            ...(pageToken ? { pageToken } : {}),
          });
          for (const it of data.items ?? []) {
            if (it.contentDetails?.videoId) ids.add(it.contentDetails.videoId);
          }
          pageToken = data.nextPageToken;
        } while (pageToken);
      } catch (err) {
        if (err instanceof YouTubeApiError && err.status === 404 && err.reason === "playlistNotFound") {
          return { ids, available: false };
        }
        throw err;
      }
      return { ids, available: true };
    },

    // Shorts専用プレイリスト(UUSH)
    listShortsIds(channelId) {
      return this.listDerivedIds("UUSH", channelId);
    },

    // ライブ専用プレイリスト(UULV)。プレミア公開の動画は載らない(ライブ配信のアーカイブとの見分けに使う)
    listLiveIds(channelId) {
      return this.listDerivedIds("UULV", channelId);
    },

    // videos.list は1回50件まで。存在しない/非公開の動画は結果に含まれない
    async getVideos(videoIds) {
      const details = new Map();
      for (let i = 0; i < videoIds.length; i += 50) {
        const batch = videoIds.slice(i, i + 50);
        const data = await call("videos", {
          part: "snippet,contentDetails,status,liveStreamingDetails",
          id: batch.join(","),
        });
        for (const item of data.items ?? []) details.set(item.id, item);
      }
      return details;
    },
  };
}
