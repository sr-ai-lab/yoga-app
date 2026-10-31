// 自動更新の中核処理のテスト(ネットワーク・APIキー不要)。実行: node --test scripts/test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { emptyCatalog, resolveAll, buildVideosJson, serializeVideos } from "../lib/catalog.mjs";
import { reclassifyAll } from "../lib/sync.mjs";
import { validateVideos } from "../lib/validate-videos.mjs";
import { rules, vocabularyTags, config, TODAY, id, video, fakeClient, world, sync, incremental, statusOf } from "./helpers.mjs";

test("2チャンネルから取得し、チャンネルごとの件数が出る", async () => {
  const r = await sync(fakeClient({ channels: world(), shorts: {} }));
  assert.equal(r.report.channels["chan-a"].fetched, 6);
  assert.equal(r.report.channels["chan-b"].fetched, 2);
  assert.equal(Object.keys(r.catalog.videos).length, 8);
  assert.equal(r.catalog.videos[id(1)].channel, "chan-a");
  assert.equal(r.catalog.videos[id(11)].channel, "chan-b");
  assert.equal(r.report.failures.length, 0);
});

test("動画IDで重複判定: 同じIDが複数回返っても、再実行しても二重登録されない", async () => {
  const w = world();
  w.UC_A.videos.push(w.UC_A.videos[0]); // 同じ動画が一覧に2回出る
  const client = fakeClient({ channels: w });
  const first = await sync(client);
  assert.equal(Object.keys(first.catalog.videos).length, 8);
  const second = await sync(client, { catalog: first.catalog });
  assert.equal(second.report.channels["chan-a"].new, 0);
  assert.equal(Object.keys(second.catalog.videos).length, 8);
});

test("ライブ配信・ライブアーカイブは再生時間があっても除外される(手動でも復活しない)", async () => {
  const r = await sync(fakeClient({ channels: world() }));
  const s = statusOf(r, null, 2);
  assert.equal(s.status, "excluded");
  assert.equal(s.primary, "live_or_archive");
  const forced = { videos: { [id(2)]: { intensity: 1, type: "main", tags: ["全身"] } } };
  assert.equal(statusOf(r, forced, 2).status, "excluded");
});

test("Shorts: 専用リスト該当・#shorts+短尺は除外。ハッシュタグのない短尺は断定せず保留", async () => {
  const w = world();
  w.UC_A.videos.push(video({ n: 7, title: "肩のストレッチ", sec: 120 }));
  const r = await sync(fakeClient({ channels: w, shorts: { UC_A: [id(7)] } }));
  assert.equal(statusOf(r, null, 7).primary, "shorts");
  assert.equal(statusOf(r, null, 5).primary, "shorts");
  const t = statusOf(r, null, 3); // 45秒・信号なし
  assert.equal(t.status, "held");
  assert.equal(t.primary, "possible_shorts");
});

test("運動以外(お知らせ等)は除外される", async () => {
  const r = await sync(fakeClient({ channels: world() }));
  assert.equal(statusOf(r, null, 4).status, "excluded");
  assert.equal(statusOf(r, null, 4).primary, "non_exercise");
});

test("分類できない動画は保留になり、videos.json(推薦対象)に入らない", async () => {
  const r = await sync(fakeClient({ channels: world() }));
  const s = statusOf(r, null, 6);
  assert.equal(s.status, "held");
  const videos = buildVideosJson(r.catalog, { videos: {} }, vocabularyTags, TODAY).videos;
  assert.ok(!videos.some((v) => v.id === id(6)));
  assert.ok(videos.some((v) => v.id === id(1)));
  // 生成物は既存のvalidateを通る(語彙・形式がアプリの前提どおり)
  const data = buildVideosJson(r.catalog, { videos: {} }, vocabularyTags, TODAY);
  assert.deepEqual(validateVideos(serializeVideos(data), data, new Set(["chan-a", "chan-b"]), vocabularyTags), []);
});

test("自動分類は根拠(evidence)を持ち、強度と種別が既存の体系の値になる", async () => {
  const r = await sync(fakeClient({ channels: world() }));
  const a = r.catalog.videos[id(12)].classify.auto;
  assert.equal(a.intensity, 3);
  assert.ok(a.evidence.length > 0);
  assert.ok(a.tags.every((t) => vocabularyTags.has(t)));
});

test("手動修正は自動更新・再分類・メタデータ更新で上書きされない", async () => {
  const client = fakeClient({ channels: world() });
  const first = await sync(client);
  const overrides = { videos: { [id(1)]: { intensity: 3, type: "warmup", tags: ["腰"] }, [id(6)]: { exclude: true } } };
  // 再分類
  const re = reclassifyAll({ catalog: first.catalog, overrides, rules: { ...rules, version: "2" }, vocabularyTags, limits: config.limits });
  const rec = resolveAll(re.catalog, overrides, vocabularyTags).resolved.get(id(1)).record;
  assert.equal(rec.intensity, 3);
  assert.deepEqual(rec.tags, ["腰"]);
  assert.equal(resolveAll(re.catalog, overrides, vocabularyTags).resolved.get(id(6)).status, "excluded");
  // 定期更新(タイトルが変わった動画があっても修正は維持)
  const w = world();
  w.UC_A.videos[0].snippet.title = "【10分】肩こり解消ストレッチヨガ(改)";
  const inc = await sync(fakeClient({ channels: w }), { catalog: first.catalog, overrides }, "incremental");
  const rec2 = resolveAll(inc.catalog, overrides, vocabularyTags).resolved.get(id(1)).record;
  assert.equal(rec2.intensity, 3);
  assert.equal(rec2.title, "【10分】肩こり解消ストレッチヨガ(改)");
});

test("APIエラー: 失敗したチャンネルは何も反映せず、成功したチャンネルだけ反映する", async () => {
  const base = await sync(fakeClient({ channels: world() }));
  const snapshot = JSON.stringify(base.catalog);
  const w = world();
  w.UC_A.videos.push(video({ n: 8, title: "新作ヨガ 肩ストレッチ", sec: 600 }));
  w.UC_B.videos.push(video({ n: 13, title: "新しい腰ヨガ", sec: 600, channel: "UC_B" }));
  const r = await incremental(fakeClient({ channels: w, failChannel: "UC_A" }), base.catalog);
  assert.equal(r.report.failures.length, 1);
  assert.equal(r.report.failures[0].channel, "chan-a");
  assert.ok(!r.catalog.videos[id(8)], "失敗側の新着は反映されない");
  assert.ok(r.catalog.videos[id(13)], "成功側は反映される");
  assert.equal(JSON.stringify(base.catalog), snapshot, "入力の台帳は変更されない");
  assert.equal(r.catalog.channels.UC_A.last_verified, base.catalog.channels.UC_A.last_verified, "失敗したチャンネルの最終更新日は進めない");
});

test("公式チャンネルの照合に失敗したら、そのチャンネルは取り込まない", async () => {
  const w = world();
  w.UC_A.handle = "@someone-else";
  const r = await sync(fakeClient({ channels: w }));
  assert.equal(r.report.failures[0].channel, "chan-a");
  assert.ok(r.report.failures[0].error.includes("照合"));
  assert.ok(!r.catalog.videos[id(1)]);
  assert.ok(r.catalog.videos[id(11)]);
});

test("別チャンネルの動画が紛れ込んだら除外される", async () => {
  const w = world();
  w.UC_A.videos.push(video({ n: 9, title: "他チャンネルのヨガ動画", channel: "UC_OTHER" }));
  const r = await sync(fakeClient({ channels: w }));
  assert.equal(statusOf(r, null, 9).primary, "wrong_channel");
});

test("再実行しても結果が変わらない(冪等)。新着0件でも成功", async () => {
  const client = fakeClient({ channels: world() });
  const first = await sync(client);
  const again = await incremental(client, first.catalog);
  assert.deepEqual(again.catalog.videos, first.catalog.videos); // 動画データは完全に同一(last_statsは実行ごとの記録なので除く)
  assert.equal(again.report.failures.length, 0);
  assert.equal(again.report.channels["chan-a"].new, 0);
});
