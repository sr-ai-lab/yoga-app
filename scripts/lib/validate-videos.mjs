// scripts/lib/validate-videos.mjs — data/videos.json の構造検証(validate.mjs と catalog-sync.mjs で共用)

const REQUIRED_FIELDS = ["id", "title", "channel", "duration_min", "intensity", "type", "tags"];
const VALID_TYPES = ["warmup", "main", "cooldown", "meditation"];
const VALID_INTENSITIES = [1, 2, 3];
const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// 元のJSONテキスト内で該当動画の "id" が出現する行番号を調べる(エラー表示用)
function findLineForId(rawText, id) {
  if (!id || !rawText) return "?";
  const index = rawText.indexOf(`"id": "${id}"`);
  if (index === -1) return "?";
  return rawText.slice(0, index).split("\n").length;
}

export function validateVideos(videosRaw, videosData, validChannels, validTags) {
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

    // equipment(任意): 壁・椅子・ブロック等、動画の実施に必要な道具。未設定/空配列=道具なし
    if (video.equipment !== undefined) {
      if (!Array.isArray(video.equipment) || video.equipment.some((e) => typeof e !== "string" || e.trim() === "")) {
        errors.push(`${prefix}: equipment は文字列の配列である必要があります`);
      }
    }
  }

  return errors;
}

// catalog.json / overrides.json の整合チェック(台帳が壊れていないか)
export function validateCatalog(catalog, overrides, validChannelIds) {
  const errors = [];
  for (const [id, e] of Object.entries(catalog.videos ?? {})) {
    if (!ID_PATTERN.test(id)) errors.push(`catalog: 不正な動画ID "${id}"`);
    if (!validChannelIds.has(e.channel_id)) errors.push(`catalog: id=${id} の channel_id が config.json にありません`);
    if (typeof e.title !== "string") errors.push(`catalog: id=${id} に title がありません`);
    if (!e.judge || !Array.isArray(e.judge.reasons)) errors.push(`catalog: id=${id} に判定結果(judge)がありません`);
  }
  for (const id of Object.keys(overrides.videos ?? {})) {
    if (!catalog.videos?.[id]) errors.push(`overrides: id=${id} は catalog.json に存在しません(手動修正の対象が不明)`);
  }
  return errors;
}
