// 保存データの更新・削除(YouTube API規約対応)、誤削除の防止、Shorts一覧の404ガードのテスト
import test from "node:test";
import assert from "node:assert/strict";
import { runSync, checkFreshness } from "../lib/sync.mjs";
import { emptyCatalog, resolveAll } from "../lib/catalog.mjs";
import { createYouTubeClient } from "../lib/youtube.mjs";
import { rules, vocabularyTags, config, CH_A, CH_B, TODAY, id, video, fakeClient, world, sync, incremental, statusOf } from "./helpers.mjs";

const statusIn = (r, n) => statusOf(r, null, n).status;

test("非公開・削除された動画: 1回目は様子見、連続して確認できたら推薦対象から除外する(誤削除の防止)", async () => {
  const base = await sync(fakeClient({ channels: world() }));
  const w = world();
  w.UC_A.videos[0].status.privacyStatus = "private";
  const first = await incremental(fakeClient({ channels: w }), base.catalog);
  assert.equal(statusIn(first, 1), "registered", "1回目の検出では推薦対象のまま");
  assert.equal(first.catalog.videos[id(1)].missing_runs, 1);
  assert.equal(first.report.channels["chan-a"].pending_unavailable, 1);
  const second = await incremental(fakeClient({ channels: w }), first.catalog);
  assert.equal(statusIn(second, 1), "excluded", "2回連続で確認できたら除外");
  assert.equal(statusOf(second, null, 1).primary, "not_public");
  assert.equal(second.catalog.videos[id(1)].unavailable_since, TODAY);
});

test("削除された動画(APIから消える)も同様に、連続確認のうえ除外される", async () => {
  const base = await sync(fakeClient({ channels: world() }));
  const w = world();
  w.UC_A.videos = w.UC_A.videos.filter((v) => v.id !== id(1));
  const first = await incremental(fakeClient({ channels: w }), base.catalog);
  assert.equal(statusIn(first, 1), "registered");
  const second = await incremental(fakeClient({ channels: w }), first.catalog);
  assert.equal(statusOf(second, null, 1).primary, "unavailable");
});

test("一時的な取りこぼし(API結果から漏れた)は同じ実行内で再確認し、誤って除外しない", async () => {
  const base = await sync(fakeClient({ channels: world() }));
  const r = await incremental(fakeClient({ channels: world(), flakyOnce: [id(1)] }), base.catalog);
  assert.equal(statusIn(r, 1), "registered");
  assert.equal(r.catalog.videos[id(1)].missing_runs, undefined);
  assert.equal(r.report.channels["chan-a"].pending_unavailable, 0);
});

test("一度『見つからない』になっても、次の実行で見つかれば記録が消える。確定後の復活も反映される", async () => {
  const base = await sync(fakeClient({ channels: world() }));
  const hidden = world();
  hidden.UC_A.videos[0].status.privacyStatus = "private";
  const first = await incremental(fakeClient({ channels: hidden }), base.catalog);
  const back = await incremental(fakeClient({ channels: world() }), first.catalog);
  assert.equal(back.catalog.videos[id(1)].missing_runs, undefined);
  assert.equal(statusIn(back, 1), "registered");

  const confirmed = await incremental(fakeClient({ channels: hidden }), (await incremental(fakeClient({ channels: hidden }), base.catalog)).catalog);
  assert.equal(statusIn(confirmed, 1), "excluded");
  const recovered = await incremental(fakeClient({ channels: world() }), confirmed.catalog);
  assert.equal(statusIn(recovered, 1), "registered");
  assert.equal(recovered.catalog.videos[id(1)].unavailable_since, undefined);
  assert.equal(recovered.report.channels["chan-a"].recovered, 1);
});

test("削除が確定して30日たった動画は、タイトル等を消して状態だけの墓標にする(保存期間の最小化)", async () => {
  const base = await sync(fakeClient({ channels: world() }));
  const hidden = world();
  hidden.UC_A.videos = hidden.UC_A.videos.filter((v) => v.id !== id(1));
  let state = base.catalog;
  for (let i = 0; i < 2; i++) state = (await incremental(fakeClient({ channels: hidden }), state)).catalog;
  assert.equal(state.videos[id(1)].unavailable_since, TODAY);
  assert.ok(state.videos[id(1)].title.length > 0, "確定直後はまだ保持");
  const later = await incremental(fakeClient({ channels: hidden }), state, { today: "2026-12-05" }); // 確定から34日後
  const t = later.catalog.videos[id(1)];
  assert.equal(t.purged, true);
  assert.equal(t.title, "");
  assert.equal(statusIn(later, 1), "excluded");
  assert.equal(later.report.channels["chan-a"].purged, 1);
});

test("API障害で大量の動画が一度に消えたように見えても、そのチャンネルは更新しない", async () => {
  const many = world();
  many.UC_A.videos = [];
  for (let n = 100; n < 130; n++) many.UC_A.videos.push(video({ n, title: "全身ストレッチヨガ", sec: 600 }));
  const seeded = await sync(fakeClient({ channels: many }));
  const empty = { ...many, UC_A: { handle: "@a", videos: [] } };
  const first = await incremental(fakeClient({ channels: empty }), seeded.catalog); // 1回目は様子見のみ
  assert.equal(first.report.failures.length, 0);
  const second = await incremental(fakeClient({ channels: empty }), first.catalog); // 確定しようとすると安全装置が作動
  assert.equal(second.report.failures[0]?.channel, "chan-a");
  assert.ok(second.report.failures[0].error.includes("安全装置"));
  assert.equal(Object.values(second.catalog.videos).filter((e) => e.channel === "chan-a" && e.unavailable_since).length, 0);
});

test("定期更新のたびに、台帳の全動画のメタデータを再取得し、最終更新日時を記録する", async () => {
  const base = await sync(fakeClient({ channels: world() }));
  const w = world();
  w.UC_A.videos[0].snippet.title = "【10分】肩こり解消ストレッチヨガ(改)";
  w.UC_A.videos[0].contentDetails.duration = "PT12M0S";
  const now = new Date("2026-11-08T00:00:00Z");
  const r = await incremental(fakeClient({ channels: w }), base.catalog, { today: "2026-11-08", now });
  assert.equal(r.catalog.videos[id(1)].title, "【10分】肩こり解消ストレッチヨガ(改)");
  assert.equal(r.catalog.videos[id(1)].duration_sec, 720);
  assert.equal(r.catalog.channels.UC_A.last_verified, "2026-11-08");
  assert.equal(r.catalog.channels.UC_A.last_verified_at, "2026-11-08T00:00:00.000Z");
  assert.equal(r.catalog.channels.UC_A.video_count_stat, undefined, "統計値は保存しない");
  // 保存しているのはID・タイトル・公開日・再生時間・状態フラグのみ(説明文などは保存しない)
  const keys = Object.keys(r.catalog.videos[id(1)]).sort();
  assert.deepEqual(keys, ["channel", "channel_id", "classify", "duration_sec", "first_seen", "judge", "published_at", "signals", "title"]);
});

test("保存データの鮮度チェック: 14日を超えたらエラー、10日超で注意", async () => {
  const base = await sync(fakeClient({ channels: world() }));
  const at = (d) => Object.fromEntries(checkFreshness(base.catalog, config, d).map((x) => [x.channel, x.level]));
  assert.deepEqual(at("2026-11-08"), { "chan-a": "ok", "chan-b": "ok" });
  assert.deepEqual(at("2026-11-13"), { "chan-a": "warn", "chan-b": "warn" });
  assert.deepEqual(at("2026-11-20"), { "chan-a": "error", "chan-b": "error" });
  assert.equal(checkFreshness(emptyCatalog(), config, TODAY)[0].level, "error");
});

test("Shorts一覧: 以前は取得できていたのに取得できなくなったら、そのチャンネルの更新を止めて警告する", async () => {
  const base = await sync(fakeClient({ channels: world(), shorts: { UC_A: [id(5)] } }));
  assert.equal(base.catalog.channels.UC_A.shorts_playlist_status, "ok");
  const w = world();
  w.UC_A.videos.push(video({ n: 20, title: "新作 肩ストレッチヨガ", sec: 600 }));
  const r = await incremental(fakeClient({ channels: w, shortsAvailable: { UC_A: false } }), base.catalog);
  assert.equal(r.report.failures[0]?.channel, "chan-a");
  assert.ok(r.report.failures[0].error.includes("Shorts一覧"));
  assert.ok(!r.catalog.videos[id(20)], "停止したチャンネルの新着は反映しない");
  assert.equal(r.catalog.channels.UC_A.last_verified, base.catalog.channels.UC_A.last_verified);
  // 本当にShortsが無くなった場合の明示的な解除
  const cfg = { ...config, channels: [{ ...CH_A, ignore_shorts_playlist: true }, CH_B] };
  const ok = await incremental(fakeClient({ channels: w, shortsAvailable: { UC_A: false } }), base.catalog, { config: cfg });
  assert.equal(ok.report.failures.length, 0);
});

test("Shorts一覧が最初から無いチャンネル: Shortsらしい動画が無ければ正常、あれば警告を出す", async () => {
  const none = await sync(fakeClient({ channels: world(), shortsAvailable: { UC_B: false } }));
  assert.equal(none.catalog.channels.UC_B.shorts_playlist_status, "absent_no_signs");
  assert.ok(!none.report.warnings.some((x) => x.includes("chan-b")));
  const w = world();
  w.UC_B.videos.push(video({ n: 30, title: "ヨガのコツ #shorts", sec: 30, channel: "UC_B" }));
  const sus = await sync(fakeClient({ channels: w, shortsAvailable: { UC_B: false } }));
  assert.equal(sus.catalog.channels.UC_B.shorts_playlist_status, "absent_with_signs");
  assert.ok(sus.report.warnings.some((x) => x.includes("chan-b") && x.includes("Shorts一覧")));
  assert.equal(statusOf(sus, null, 30).primary, "shorts", "一覧が無くても #shorts+短尺 は除外される");
});

test("YouTube APIクライアント: 404でも『プレイリストなし』だけをShorts無しとし、権限・クォータ等のエラーは失敗にする", async () => {
  const respond = (status, reason) => async () => ({ ok: false, status, json: async () => ({ error: { errors: [{ reason }] } }) });
  const mk = (fetchImpl) => createYouTubeClient({ apiKey: "dummy-key", fetchImpl, sleep: async () => {} });
  const absent = await mk(respond(404, "playlistNotFound")).listShortsIds("UC_X1234567890123456789");
  assert.equal(absent.available, false);
  await assert.rejects(mk(respond(403, "quotaExceeded")).listShortsIds("UC_X1234567890123456789"), /403/);
  await assert.rejects(mk(respond(404, "channelNotFound")).listShortsIds("UC_X1234567890123456789"), /404/);
  // エラー文言にAPIキーを含めない
  await assert.rejects(mk(respond(403, "quotaExceeded")).getChannel("UC_X"), (e) => !String(e.message).includes("dummy-key"));
});

test("一時的なHTTPエラー(5xx/429)は再試行し、成功すればそのまま続行する", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ items: [{ id: "UC_A", snippet: { title: "t", customUrl: "@a" }, contentDetails: { relatedPlaylists: { uploads: "UU_A" } }, statistics: {} }] }) };
  };
  const c = createYouTubeClient({ apiKey: "dummy-key", fetchImpl, sleep: async () => {} });
  assert.equal((await c.getChannel("UC_A")).uploadsPlaylistId, "UU_A");
  assert.equal(calls, 3);
});
