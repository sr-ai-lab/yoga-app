// アプリ(app.js)のコース設定の静的な確認。実際の推薦動作の検証はブラウザで行う
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, readJson } from "../lib/util.mjs";

const src = (await readFile(path.join(ROOT, "app.js"), "utf8")).replace(/\r\n/g, "\n");
const templates = new Function(`${src.slice(src.indexOf("const COURSE_TEMPLATES"), src.indexOf("};", src.indexOf("const COURSE_TEMPLATES")) + 2)}\nreturn COURSE_TEMPLATES;`)();

test("コースのcooldown上限: 30分は従来の最長(12分)を維持し、45分は18分、60分は固定の上限なし", () => {
  const max = (m) => templates[m].find((s) => s.type === "cooldown").max;
  assert.equal(max(30), 12);
  assert.equal(max(45), 18);
  assert.equal(max(60), undefined, "60分は固定上限を設けず、合計時間とmainの許容幅で絞られる");
  // 上限のあるコースは、その長さのコースの合計時間(選択時間+3分以内)から、warmupとmainの目安を引いた範囲に収まる
  for (const m of [30, 45]) {
    const others = templates[m].filter((s) => s.type !== "cooldown").reduce((sum, s) => sum + s.target * 0.7, 0);
    assert.ok(others + max(m) <= m + 3 + 10, `${m}分: 上限が大きすぎる`);
  }
});

test("コースの目安時間(warmup+main+cooldown)は従来のまま(合計が選択時間)", () => {
  const expected = { 30: 30, 45: 43, 60: 60 };
  for (const m of [30, 45, 60]) assert.equal(templates[m].reduce((s, x) => s + x.target, 0), expected[m]);
});

test("推薦対象の動画: cooldown候補が各コースの上限で絞られても、各長さのコースに選べる動画がある", async () => {
  const videos = (await readJson(path.join(ROOT, "data/videos.json"))).videos;
  const cooldowns = videos.filter((v) => v.type === "cooldown");
  for (const m of [30, 45, 60]) {
    const max = templates[m].find((s) => s.type === "cooldown").max ?? Infinity;
    assert.ok(cooldowns.filter((v) => v.duration_min <= max).length >= 15, `${m}分で選べるcooldownが少なすぎる`);
  }
  assert.ok(cooldowns.length >= 18);
});
