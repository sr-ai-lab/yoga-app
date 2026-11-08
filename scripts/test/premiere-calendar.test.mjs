// プレミア公開とライブアーカイブの見分け、公式カレンダーの掲載位置による種別のテスト
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAll, buildVideosJson } from "../lib/catalog.mjs";
import { reclassifyAll } from "../lib/sync.mjs";
import path from "node:path";
import { ROOT, readJson } from "../lib/util.mjs";
import { rules, vocabularyTags, config, TODAY, id, video, fakeClient, sync, statusOf } from "./helpers.mjs";

const world = (...videos) => ({ UC_A: { handle: "@a", videos }, UC_B: { handle: "@b", videos: [] } });
const T = "【10分】肩こり解消ストレッチヨガ";

test("プレミア公開(4条件がすべて成立)は通常の動画として扱われ、分類の対象になる", async () => {
  const r = await sync(fakeClient({ channels: world(video({ n: 1, title: T, premiere: true })) }));
  const e = r.catalog.videos[id(1)];
  assert.equal(e.signals.live, true, "APIにはliveStreamingDetailsがある事実は残す");
  assert.equal(e.signals.premiere, true);
  assert.deepEqual(e.signals.premiere_check, { published_before_start: true, not_in_live_tab: true, no_live_word: true, ended: true });
  assert.ok(!e.judge.reasons.includes("live_or_archive"));
  assert.equal(statusOf(r, null, 1).status, "registered");
});

test("ライブ配信のアーカイブは、タイトルや長さが通常動画に見えても除外のまま", async () => {
  const r = await sync(fakeClient({ channels: world(video({ n: 1, title: T, live: true })) }));
  assert.equal(r.catalog.videos[id(1)].signals.premiere, false);
  assert.equal(statusOf(r, null, 1).primary, "live_or_archive");
});

test("プレミア公開に見えても、1つでも確認できない条件があればライブ扱いのまま(安全側)", async () => {
  // タイトルにLIVE/ライブ/配信が含まれる
  for (const title of ["【LIVE】" + T, "ライブ" + T, T + " 配信"]) {
    const r = await sync(fakeClient({ channels: world(video({ n: 1, title, premiere: true })) }));
    assert.equal(statusOf(r, null, 1).primary, "live_or_archive", title);
  }
  // ライブタブが取得できず、ライブアーカイブでないことを確認できない
  const noTab = await sync(fakeClient({ channels: world(video({ n: 1, title: T, premiere: true })), liveTabAvailable: { UC_A: false } }));
  assert.equal(noTab.catalog.videos[id(1)].signals.premiere_check.not_in_live_tab, false);
  assert.equal(statusOf(noTab, null, 1).primary, "live_or_archive");
  // 公開日時が配信開始より後
  const late = video({ n: 1, title: T, premiere: true });
  late.snippet.publishedAt = "2026-01-01T01:30:00Z";
  assert.equal(statusOf(await sync(fakeClient({ channels: world(late) })), null, 1).primary, "live_or_archive");
  // 配信がまだ終わっていない(予定・配信中)
  const upcoming = video({ n: 1, title: T, premiere: true });
  upcoming.snippet.liveBroadcastContent = "upcoming";
  delete upcoming.liveStreamingDetails.actualEndTime;
  assert.equal(statusOf(await sync(fakeClient({ channels: world(upcoming) })), null, 1).primary, "live_or_archive");
});

test("公開日時と配信開始の前後だけでは判断しない(ライブタブに載っていれば除外のまま)", async () => {
  // 公開が開始以前でも、YouTubeがライブとして扱っている(ライブタブに載る)動画はプレミア公開と確認しない
  const v = video({ n: 1, title: T, live: true });
  v.snippet.publishedAt = "2025-12-31T23:58:00Z";
  const r = await sync(fakeClient({ channels: world(v) }));
  assert.equal(r.catalog.videos[id(1)].signals.premiere_check.published_before_start, true);
  assert.equal(r.catalog.videos[id(1)].signals.premiere, false);
  assert.equal(statusOf(r, null, 1).primary, "live_or_archive");
});

test("プレミア公開と確認できた動画でも、運動以外・分類不能なら通常のルールで除外/保留になる", async () => {
  const r = await sync(
    fakeClient({
      channels: world(video({ n: 1, title: "朝ごはんあるある編 食べていいの?", premiere: true }), video({ n: 2, title: "ヨガの不思議", premiere: true }), video({ n: 3, title: "ヨガ撮影の舞台裏", premiere: true })),
    })
  );
  assert.notEqual(statusOf(r, null, 1).status, "registered");
  assert.equal(statusOf(r, null, 2).status, "held");
  assert.equal(statusOf(r, null, 3).primary, "non_exercise");
});

test("定期更新で、既存のライブ判定の動画だけがプレミア確認つきで再評価される(他の動画は変わらない)", async () => {
  const w = world(video({ n: 1, title: T, premiere: true }), video({ n: 2, title: "全身ストレッチヨガ" }));
  const first = await sync(fakeClient({ channels: w }));
  // 古い形式(プレミア確認なし・live=true)の台帳を再現
  const old = structuredClone(first.catalog);
  old.videos[id(1)].signals = { unavailable: false, public: true, live: true, shorts_playlist: false, shorts_hashtag: false, wrong_channel: false };
  old.videos[id(1)].judge = { status: "excluded", reasons: ["live_or_archive"], primary: "live_or_archive" };
  old.videos[id(1)].classify = null;
  const snapshot2 = JSON.stringify(old.videos[id(2)]);
  const inc = await sync(fakeClient({ channels: w }), { catalog: old }, "incremental");
  assert.equal(statusOf(inc, null, 1).status, "registered");
  assert.equal(JSON.stringify(inc.catalog.videos[id(2)]), snapshot2, "ライブ関連でない動画は書き換えない");
  assert.equal(inc.report.channels["chan-a"].refreshed, 1);
});

// ---------- 公式カレンダーの掲載位置 ----------

const calendar = (n, role = "cooldown") => ({ videos: { [id(n)]: { role, positions: ["美腹筋カレンダー Week1 DAY1 4本目/4本"] } } });
const relax = "寝たままストレッチ";

test("公式カレンダーで最後の位置に置かれた動画はcooldownになり、根拠が『calendar』として区別される", async () => {
  const r = await sync(fakeClient({ channels: world(video({ n: 1, title: relax, sec: 1020 })) }));
  const plain = resolveAll(r.catalog, { videos: {} }, vocabularyTags).resolved.get(id(1));
  assert.equal(plain.record.type, "main");
  assert.equal(plain.type_source, "title");
  const withCal = resolveAll(r.catalog, { videos: {} }, vocabularyTags, calendar(1)).resolved.get(id(1));
  assert.equal(withCal.record.type, "cooldown");
  assert.equal(withCal.type_source, "calendar");
  assert.equal(withCal.record.duration_min, 17, "長さの上限はない(コース側で時間配分を調整する)");
  // 強度・タグはタイトルのルールのまま
  assert.equal(withCal.record.intensity, plain.record.intensity);
  assert.deepEqual(withCal.record.tags, plain.record.tags);
  const out = buildVideosJson(r.catalog, { videos: {} }, vocabularyTags, TODAY, calendar(1));
  assert.equal(out.videos[0].type, "cooldown");
  assert.deepEqual(Object.keys(out.videos[0]).sort(), ["channel", "duration_min", "id", "intensity", "tags", "title", "type"], "videos.jsonの項目は増えない");
});

test("公式カレンダーの位置は、人の手動修正を上書きしない。高強度や、推薦対象でない動画にも適用しない", async () => {
  const r = await sync(fakeClient({ channels: world(video({ n: 1, title: relax }), video({ n: 2, title: "腹筋トレーニング" }), video({ n: 3, title: "ヨガの不思議" })) }));
  const ref = { videos: { ...calendar(1).videos, ...calendar(2).videos, ...calendar(3).videos } };
  // 人が type: main と決めている場合は人を優先
  const o = { videos: { [id(1)]: { intensity: 1, type: "main", tags: ["全身"] } } };
  const res = resolveAll(r.catalog, o, vocabularyTags, ref).resolved;
  assert.equal(res.get(id(1)).record.type, "main");
  assert.equal(res.get(id(1)).type_source, "manual");
  // 高強度(3)はcooldownにしない
  assert.equal(res.get(id(2)).record.type, "main");
  // 分類できず保留の動画は、位置があっても保留のまま(推薦しない)
  assert.equal(res.get(id(3)).status, "held");
});

test("再分類の差分に、公式カレンダーによる種別の変更とその根拠が出る", async () => {
  const r = await sync(fakeClient({ channels: world(video({ n: 1, title: relax, sec: 1020 })) }));
  const re = reclassifyAll({ catalog: r.catalog, overrides: { videos: {} }, rules, vocabularyTags, limits: config.limits, reference: calendar(1) });
  assert.equal(re.changes.length, 0, "カタログとルールが同じなら差分なし");
  const before = resolveAll(r.catalog, { videos: {} }, vocabularyTags).resolved.get(id(1)).record.type;
  assert.equal(before, "main");
});

test("プレミア公開で確認できた運動動画4本は、暫定の人手承認として登録され、後から修正できる", async () => {
  const overrides = await readJson(path.join(ROOT, "data/overrides.json"));
  const catalog = await readJson(path.join(ROOT, "data/catalog.json"));
  const reference = await readJson(path.join(ROOT, "data/reference-roles.json"));
  const expected = {
    "CPN5q-vipx0": { intensity: 1, type: "cooldown", tags: ["夜", "疲労回復", "自律神経"] },
    "CvQhSHhcHuU": { intensity: 2, type: "main", tags: ["全身"] },
    "-1M4wiFSaDQ": { intensity: 1, type: "main", tags: ["朝"] },
    "QcqWYaMNvGY": { intensity: 2, type: "main", tags: ["全身"] },
  };
  const { resolved } = resolveAll(catalog, overrides, vocabularyTags, reference);
  for (const [vid, want] of Object.entries(expected)) {
    assert.equal(catalog.videos[vid].signals.premiere, true, `${vid}: プレミア公開と確認されている`);
    assert.equal(overrides.videos[vid].provisional, true, `${vid}: 暫定承認の印がある`);
    assert.ok(overrides.videos[vid].note.includes("未確認"));
    const rec = resolved.get(vid).record;
    assert.equal(resolved.get(vid).status, "registered");
    assert.equal(rec.intensity, want.intensity);
    assert.equal(rec.type, want.type);
    assert.deepEqual(rec.tags, want.tags);
  }
  // ライブアーカイブ(プレミア公開でない)は1本も推薦対象に入っていない
  for (const [vid, r] of resolved) if (catalog.videos[vid].signals?.live && !catalog.videos[vid].signals.premiere) assert.notEqual(r.status, "registered", vid);
});
