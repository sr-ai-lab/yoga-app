// 分類ルール(強度・種別・目的・時間帯は別の軸)と、運動以外の除外ルールのテスト
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ROOT, readJson } from "../lib/util.mjs";
import { evaluate, resolveAll } from "../lib/catalog.mjs";
import { reclassifyAll } from "../lib/sync.mjs";
import { rules, vocabularyTags, config, id, fakeClient, world, sync } from "./helpers.mjs";

const classify = (title, min) =>
  evaluate({ title, duration_sec: min * 60, signals: { public: true } }, rules, vocabularyTags, config.limits);
const auto = (title, min) => classify(title, min).classify.auto;

test("種別: 動画が短いだけではwarmupにならない。高強度の筋力・体幹トレーニングは短時間でもmain", () => {
  assert.equal(auto("痩せやすい体を作る体幹トレーニング", 6).type, "main");
  assert.equal(auto("美腹筋を作るトレーニング", 4).type, "main");
  assert.equal(auto("肩こりをほぐす簡単ストレッチヨガ", 6).type, "main");
});

test("種別: 『仕事後』『運動後』『疲れをとる』などの目的はcooldown。『毎晩』だけではcooldownにしない", () => {
  assert.equal(auto("仕事の後や運動後の疲れをとる6分間ストレッチ", 7).type, "cooldown");
  assert.equal(auto("【毎晩10分】骨盤のゆがみ改善、腰回りの疲れ解消", 12).type, "main");
  assert.equal(auto("寝たまま10分 姿勢改善ヨガ", 11).type, "main", "「寝たまま」は姿勢であり、役割ではない");
});

test("種別: 朝・夜という時間帯だけでは役割を決めない(長い動画は朝でもmain)", () => {
  assert.equal(auto("朝のたっぷり30分ストレッチヨガ", 30).type, "main");
  assert.equal(auto("朝ヨガ ストレッチで目覚める", 9).type, "warmup", "朝+低強度+短時間の組み合わせのみwarmup");
  assert.equal(auto("朝のトレーニング", 9).type, "main");
});

test("強度: 『やさしい』『初心者向け』でもピラティスは中強度のまま。ストレッチ・ほぐす・寝たまま等は低強度", () => {
  assert.equal(auto("初心者のためのやさしいピラティス", 21).intensity, 2);
  assert.equal(auto("寝たままストレッチ", 10).intensity, 1);
  assert.equal(auto("陰ヨガで深くほぐす", 20).intensity, 1);
  assert.equal(auto("1日の疲労回復ヨガ", 15).intensity, 1, "疲労回復は低強度の手がかり");
});

test("強度: 短時間でも筋力・体幹トレーニングは高強度", () => {
  assert.equal(auto("3分で叶える二の腕エクササイズ", 4).intensity, 3);
  assert.equal(auto("体幹強化で脂肪燃焼", 8).intensity, 3);
});

test("強度: 長さだけ・朝/夜という時間帯だけでは強度を決めない(保留になる)", () => {
  const short = classify("【5分】朝ヨガ", 5);
  assert.equal(short.classify.auto.intensity, null);
  assert.ok(short.classify.heldReasons.includes("intensity_unresolved"));
  assert.equal(classify("夜ヨガ", 12).classify.auto.intensity, null);
  assert.equal(classify("寝る前のヨガ", 12).classify.auto.intensity, null);
});

test("強度: 補助的な手がかり(疲労回復など)は長時間の動画では使わず、保留にする", () => {
  assert.equal(auto("疲労回復ヨガ", 15).intensity, 1);
  assert.equal(classify("疲労回復ヨガ", 40).classify.auto.intensity, null);
});

test("強度: 手がかりが矛盾する場合は判断せず保留にする", () => {
  assert.ok(classify("寝たままピラティス", 10).classify.heldReasons.includes("intensity_conflict"));
  assert.ok(classify("リラックスできる本気トレーニング", 10).classify.heldReasons.includes("intensity_conflict"));
});

test("目的(tags)と時間帯(朝・夜タグ)は強度・種別とは別に付く", () => {
  const a = auto("朝のトレーニングで体幹と全身を鍛える", 20);
  assert.ok(a.tags.includes("朝") && a.tags.includes("体幹") && a.tags.includes("全身"));
  assert.equal(a.intensity, 3);
  assert.equal(a.type, "main");
  assert.ok(a.tags.every((t) => vocabularyTags.has(t)));
});

// ---------- 運動以外の除外ルール ----------

test("募集・舞台裏・お知らせ・告知は、タイトルに『ヨガ』が含まれていても運動プログラムではない", () => {
  for (const t of ["ヨガインストラクター募集", "【ヨガ、ピラティス講師大募集!】", "ハワイ島ヒロにて、朝ヨガの撮影&舞台裏☆", "ヨガ動画撮影の舞台裏", "ヨガスタジオのお知らせ", "ヨガ新企画のご報告", "ヨガ体験会の告知"]) {
    assert.equal(classify(t, 10).judge.status, "excluded", t);
  }
});

test("『撮影』『紹介』などの単語だけで機械的に除外しない(運動プログラムとの区別)", () => {
  assert.equal(classify("撮影の合間にできる肩こり解消ストレッチヨガ", 10).judge.status, "ok");
  assert.equal(classify("ヨガの基本ポーズを紹介 肩ストレッチ", 10).judge.status, "ok");
  // 対談・インタビュー・ワークショップは運動語を含むなら保留(人が確認)
  assert.equal(classify("ヨガインストラクターとの対談", 10).judge.status, "held");
  assert.equal(classify("バレトン&ヨガストレッチ ワークショップ", 10).judge.status, "held");
});

test("除外ルールの対象でも、人が承認した動画(overrides)は推薦対象のまま維持される", async () => {
  const w = world();
  w.UC_A.videos[0].snippet.title = "【10分】ヨガ撮影の舞台裏をのぞきながら一緒にストレッチ";
  const r = await sync(fakeClient({ channels: w }));
  assert.equal(r.catalog.videos[id(1)].judge.status, "excluded");
  const o = { videos: { [id(1)]: { intensity: 1, type: "main", tags: ["全身"] } } };
  assert.equal(resolveAll(r.catalog, o, vocabularyTags).resolved.get(id(1)).status, "registered");
});

// ---------- 既存102本の維持 ----------

test("既存102本の人手分類は、ルールを変えても維持される(overridesが優先)", async () => {
  const catalog = await readJson(path.join(ROOT, "data/catalog.json"));
  const overrides = await readJson(path.join(ROOT, "data/overrides.json"));
  const labeled = Object.entries(overrides.videos).filter(([, o]) => o.intensity != null);
  assert.ok(labeled.length >= 100);
  const { resolved } = resolveAll(catalog, overrides, vocabularyTags);
  for (const [vid, o] of labeled) {
    const rec = resolved.get(vid).record;
    assert.ok(rec, `${vid} が推薦対象から外れている`);
    assert.equal(rec.intensity, o.intensity);
    assert.equal(rec.type, o.type);
    assert.deepEqual(rec.tags, o.tags);
  }
});

test("ルール変更後の再分類で、変化した動画が変更前後つきの差分として分かる", async () => {
  const first = await sync(fakeClient({ channels: world() }));
  const changed = structuredClone(rules);
  changed.version = "99";
  changed.intensity.gentle = "やさしい"; // 「ストレッチ」を穏やかな語から外す
  const re = reclassifyAll({ catalog: first.catalog, overrides: { videos: {} }, rules: changed, vocabularyTags, limits: config.limits });
  assert.ok(re.changes.length > 0);
  const c = re.changes.find((x) => x.id === id(1));
  assert.equal(c.from, "registered");
  assert.equal(c.to, "held");
  assert.equal(c.before.intensity, 1);
  assert.equal(re.catalog.rules_version, "99");
  // 手動修正がある動画は変化しない
  const guarded = reclassifyAll({
    catalog: first.catalog,
    overrides: { videos: { [id(1)]: { intensity: 1, type: "main", tags: ["肩"] } } },
    rules: changed,
    vocabularyTags,
    limits: config.limits,
  });
  assert.ok(!guarded.changes.some((x) => x.id === id(1)));
});
