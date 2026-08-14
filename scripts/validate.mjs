// scripts/validate.mjs
// design.md §9.4: data/videos.json のバリデーション。pushの前に必ず実行する運用。
//
// 使い方:
//   node scripts/validate.mjs               通常の構造チェック
//   node scripts/validate.mjs --check-live   上記に加え、oEmbedで視聴可否も確認(時間がかかる)

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_FIELDS = ["id", "title", "channel", "duration_min", "intensity", "type", "tags"];
const VALID_TYPES = ["warmup", "main", "cooldown", "meditation"];
const VALID_INTENSITIES = [1, 2, 3];
const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

async function loadJson(relativePath) {
  const text = await readFile(path.join(ROOT, relativePath), "utf8");
  return { text, data: JSON.parse(text) };
}

// 元のJSONテキスト内で該当動画の "id" が出現する行番号を調べる(エラー表示用)
function findLineForId(rawText, id) {
  if (!id) return "?";
  const marker = `"id": "${id}"`;
  const index = rawText.indexOf(marker);
  if (index === -1) return "?";
  return rawText.slice(0, index).split("\n").length;
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

function validateVideos(videosRaw, videosData, validChannels, validTags) {
  const errors = [];
  const seenIds = new Set();

  for (const video of videosData.videos) {
    const line = findLineForId(videosRaw, video.id);
    const prefix = `[行${line}] id=${video.id ?? "(なし)"}`;

    for (const field of REQUIRED_FIELDS) {
      if (video[field] === undefined || video[field] === null) {
        errors.push(`${prefix}: 必須項目 "${field}" がありません`);
      }
    }

    if (typeof video.id !== "string" || !ID_PATTERN.test(video.id)) {
      errors.push(`${prefix}: id は11文字の英数字・-・_ である必要があります`);
    } else if (seenIds.has(video.id)) {
      errors.push(`${prefix}: id が重複しています`);
    } else {
      seenIds.add(video.id);
    }

    if (typeof video.title !== "string" || video.title.trim() === "") {
      errors.push(`${prefix}: title が空です`);
    }

    if (typeof video.channel !== "string" || !validChannels.has(video.channel)) {
      errors.push(`${prefix}: channel "${video.channel}" は scripts/config.json のチャンネル名のいずれかである必要があります`);
    }

    if (!Number.isInteger(video.duration_min) || video.duration_min < 1 || video.duration_min > 120) {
      errors.push(`${prefix}: duration_min は1〜120の整数である必要があります`);
    }

    if (!VALID_INTENSITIES.includes(video.intensity)) {
      errors.push(`${prefix}: intensity は 1 / 2 / 3 のいずれかである必要があります`);
    }

    if (!VALID_TYPES.includes(video.type)) {
      errors.push(`${prefix}: type は ${VALID_TYPES.join(" / ")} のいずれかである必要があります`);
    }

    if (!Array.isArray(video.tags) || video.tags.length < 1 || video.tags.length > 5) {
      errors.push(`${prefix}: tags は1〜5個である必要があります`);
    } else {
      for (const tag of video.tags) {
        if (!validTags.has(tag)) {
          errors.push(`${prefix}: タグ "${tag}" は data/vocabulary.json にありません`);
        }
      }
    }
  }

  return errors;
}

async function main() {
  const checkLiveFlag = process.argv.includes("--check-live");

  const { text: videosRaw, data: videosData } = await loadJson("data/videos.json");
  const { data: vocabulary } = await loadJson("data/vocabulary.json");
  const { data: config } = await loadJson("scripts/config.json");

  const validChannels = new Set(config.channels.map((c) => c.name));
  const validTags = new Set(Object.values(vocabulary.categories).flat());

  const errors = validateVideos(videosRaw, videosData, validChannels, validTags);

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
