// scripts/validate.mjs
// design.md §9.4: data/videos.json のバリデーション。pushの前に必ず実行する運用。
//
// 使い方:
//   node scripts/validate.mjs               通常の構造チェック
//   node scripts/validate.mjs --check-live   上記に加え、oEmbedで視聴可否も確認(時間がかかる)

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateVideos, validateCatalog, validateReference } from "./lib/validate-videos.mjs";
import { readJson } from "./lib/util.mjs";
import { buildVideosJson, serializeVideos } from "./lib/catalog.mjs";
import { checkFreshness } from "./lib/sync.mjs";
import { today } from "./lib/util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadJson(relativePath) {
  const text = await readFile(path.join(ROOT, relativePath), "utf8");
  return { text, data: JSON.parse(text) };
}

async function checkLive(video) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${video.id}`
  )}&format=json`;
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const checkLiveFlag = process.argv.includes("--check-live");

  const { text: videosRaw, data: videosData } = await loadJson("data/videos.json");
  const { data: vocabulary } = await loadJson("data/vocabulary.json");
  const { data: config } = await loadJson("scripts/config.json");

  const validChannels = new Set(config.channels.map((c) => c.name));
  const validTags = new Set(Object.values(vocabulary.categories).flat());

  const errors = validateVideos(videosRaw, videosData, validChannels, validTags);

  // 台帳(catalog.json)がある場合は、台帳+手動修正から生成した結果と videos.json が一致しているかも確認する
  // (videos.json を手で直接編集した、または生成し忘れた状態を検出する)
  const catalog = await readJson(path.join(ROOT, "data/catalog.json"), null);
  if (catalog) {
    const overrides = await readJson(path.join(ROOT, "data/overrides.json"), { videos: {} });
    errors.push(...validateCatalog(catalog, overrides, new Set(config.channels.map((c) => c.channel_id))));
    const reference = await readJson(path.join(ROOT, "data/reference-roles.json"), { videos: {} });
    errors.push(...validateReference(reference, catalog));
    const expected = buildVideosJson(catalog, overrides, validTags, videosData.updated, reference);
    if (serializeVideos(expected) !== serializeVideos(videosData)) {
      errors.push("data/videos.json が catalog.json + overrides.json から生成される内容と一致しません。node scripts/catalog-sync.mjs --rebuild を実行してください(videos.json は直接編集しない)");
    }

    // 保存データの鮮度(YouTube API規約: 保存から30日以内に再取得か削除)。ここでは警告のみ(エラーにはしない)
    for (const r of checkFreshness(catalog, config, today())) {
      if (r.level !== "ok") console.warn(`${r.level === "error" ? "警告(要対応)" : "注意"}: ${r.channel} の保存データは ${r.message}。Actionsの定期更新が動いているか確認してください`);
    }
  }

  if (errors.length > 0) {
    console.error(`videos.json の検証エラー: ${errors.length}件\n`);
    for (const error of errors) console.error(` - ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`videos.json の検証OK(${videosData.videos.length}件)`);
  }

  if (checkLiveFlag) {
    console.log("\n--check-live: 各動画のoEmbedを確認しています(件数が多いと時間がかかります)...");
    const warnings = [];
    for (const video of videosData.videos) {
      const ok = await checkLive(video);
      if (!ok) warnings.push(video.id);
    }
    if (warnings.length > 0) {
      console.warn(`\n視聴不可の可能性がある動画(要目視確認): ${warnings.length}件`);
      for (const id of warnings) console.warn(` - ${id}`);
    } else {
      console.log("oEmbedで視聴不可と判定された動画はありませんでした。");
    }
  }
}

main();
