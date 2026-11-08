// scripts/lib/catalog.mjs — 台帳(catalog.json)・手動修正(overrides.json)から videos.json を生成する
//
// データの役割分担:
//   data/catalog.json   … 収集した全動画の台帳。事実データ(タイトル・長さ等)+判定結果+自動分類+その根拠。
//                          推薦対象外・保留も含む。自動処理だけが書き換える。
//   data/overrides.json … 人間の手動修正。人だけが編集し、自動処理は書き換えない。
//   data/videos.json    … アプリが読む推薦対象一覧。上2つから生成される(手で直接編集しない)。

import { judgeVideo, NON_OVERRIDABLE_REASONS } from "./judge.mjs";
import { classifyVideo } from "./classify.mjs";

const TYPES = new Set(["warmup", "main", "cooldown"]); // meditation は現状アプリの推薦対象外

export function emptyCatalog() {
  return { schema_version: 1, rules_version: null, channels: {}, videos: {} };
}

// 事実データ(facts)から「判定」と「自動分類」を求める。同じ入力なら常に同じ結果(決定論的)
export function evaluate(facts, rules, vocabularyTags, limits) {
  const judge = judgeVideo(facts, rules, limits);
  // 技術的に除外される動画は分類しない(分類してもアプリで使われないため)
  const classify =
    judge.status === "excluded" ? null : classifyVideo(facts, rules, vocabularyTags);
  return { judge, classify };
}

export function entryReasons(entry) {
  return [...(entry.judge?.reasons ?? []), ...(entry.classify?.heldReasons ?? [])];
}

// 1本の最終状態を決める。overrides(人の判断)が自動判定より優先される。
// 戻り値: { status: registered|held|excluded, primary, reasons, source: auto|manual|mixed, record? }
//   reference: 公式カレンダーでの掲載位置(data/reference-roles.json の1件)。タイトルによる自動分類とは別の根拠として種別にだけ使う
//   種別の根拠の強さ: 人の手動修正(overrides) > 公式カレンダーの掲載位置 > タイトルによる自動分類
export function resolveEntry(id, entry, override, vocabularyTags, reference) {
  const o = override ?? {};

  if (o.exclude === true) {
    return { status: "excluded", primary: "manual_exclude", reasons: ["manual_exclude"], source: "manual" };
  }

  // ライブ・Shorts・非公開など技術的に使えない動画は、手動修正でも復活させない
  const hard = (entry.judge?.reasons ?? []).filter((r) => NON_OVERRIDABLE_REASONS.has(r));
  if (hard.length > 0) {
    return { status: "excluded", primary: hard[0], reasons: hard, source: "auto" };
  }

  if (o.hold === true) {
    return { status: "held", primary: "manual_hold", reasons: ["manual_hold"], source: "manual" };
  }

  const auto = entry.classify?.auto ?? {};
  const intensity = o.intensity ?? auto.intensity ?? null;
  let type = o.type ?? auto.type ?? null;
  let typeSource = o.type != null ? "manual" : "title";
  const tags = o.tags ?? auto.tags ?? [];
  const equipment = o.equipment ?? auto.equipment ?? [];

  // 人が3項目(強度・種別・タグ)を揃えた、または approve:true を付けた場合は「人が承認した」扱い
  const approved = o.approve === true || (o.intensity != null && o.type != null && Array.isArray(o.tags));
  const overridden = ["intensity", "type", "tags", "equipment"].some((k) => o[k] !== undefined);

  // 公式カレンダーで「その日の最後の動画」に置かれている動画は cooldown とする(高強度の動画には適用しない)
  if (o.type == null && reference?.role === "cooldown" && intensity !== 3 && type !== "cooldown") {
    type = "cooldown";
    typeSource = "calendar";
  }

  if (!approved) {
    const reasons = entryReasons(entry);
    if (reasons.length > 0) {
      const excluded = entry.judge?.status === "excluded";
      return { status: excluded ? "excluded" : "held", primary: reasons[0], reasons, source: "auto" };
    }
  }

  const valid =
    [1, 2, 3].includes(intensity) &&
    TYPES.has(type) &&
    Array.isArray(tags) &&
    tags.length >= 1 &&
    tags.length <= 5 &&
    tags.every((t) => vocabularyTags.has(t));
  if (!valid) {
    return { status: "held", primary: "invalid_classification", reasons: ["invalid_classification"], source: "auto" };
  }

  const record = {
    id,
    title: entry.title,
    channel: entry.channel,
    duration_min: Math.round(entry.duration_sec / 60),
    intensity,
    type,
    tags,
    ...(equipment.length > 0 ? { equipment } : {}),
  };
  return {
    status: "registered",
    primary: null,
    reasons: [],
    source: approved ? "manual" : overridden ? "mixed" : "auto",
    type_source: typeSource,
    record,
  };
}

function byNewestThenId(a, b) {
  const pa = a.entry.published_at ?? "";
  const pb = b.entry.published_at ?? "";
  if (pa !== pb) return pa < pb ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

// 台帳+手動修正 → { resolved: Map(id → resolveEntry結果), videos: 推薦対象レコード配列 }
export function resolveAll(catalog, overrides, vocabularyTags, reference = {}) {
  const resolved = new Map();
  const rows = Object.entries(catalog.videos).map(([id, entry]) => ({ id, entry }));
  rows.sort(byNewestThenId);
  for (const { id, entry } of rows) {
    resolved.set(id, resolveEntry(id, entry, overrides.videos?.[id], vocabularyTags, reference.videos?.[id]));
  }
  const videos = [...resolved.values()].filter((r) => r.status === "registered").map((r) => r.record);
  return { resolved, videos };
}

export function buildVideosJson(catalog, overrides, vocabularyTags, updated, reference = {}) {
  const { videos } = resolveAll(catalog, overrides, vocabularyTags, reference);
  return { schema_version: 1, updated, videos };
}

// --- 読みやすさ重視のシリアライズ(差分レビューしやすく、出力が決定論的になるようにする) ---

export function serializeVideos(data) {
  const lines = data.videos.map((v) => {
    const fields = [
      `      "id": ${JSON.stringify(v.id)}`,
      `      "title": ${JSON.stringify(v.title)}`,
      `      "channel": ${JSON.stringify(v.channel)}`,
      `      "duration_min": ${v.duration_min}`,
      `      "intensity": ${v.intensity}`,
      `      "type": ${JSON.stringify(v.type)}`,
      `      "tags": ${JSON.stringify(v.tags).replace(/","/g, '", "')}`,
    ];
    if (v.equipment?.length) fields.push(`      "equipment": ${JSON.stringify(v.equipment).replace(/","/g, '", "')}`);
    return `    {\n${fields.join(",\n")}\n    }`;
  });
  return (
    `{\n  "schema_version": ${data.schema_version},\n  "updated": ${JSON.stringify(data.updated)},\n  "videos": [\n` +
    lines.join(",\n") +
    `\n  ]\n}\n`
  );
}

export function serializeCatalog(catalog) {
  const rows = Object.entries(catalog.videos).map(([id, entry]) => ({ id, entry }));
  rows.sort(byNewestThenId);
  const videoLines = rows.map(({ id, entry }) => `    ${JSON.stringify(id)}: ${JSON.stringify(entry)}`);
  const head = JSON.stringify(
    { schema_version: catalog.schema_version, rules_version: catalog.rules_version, channels: catalog.channels },
    null,
    2
  ).replace(/\n}$/, "");
  return `${head},\n  "videos": {\n${videoLines.join(",\n")}\n  }\n}\n`;
}

export function serializeOverrides(overrides) {
  const rows = Object.entries(overrides.videos ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const lines = rows.map(([id, o]) => `    ${JSON.stringify(id)}: ${JSON.stringify(o)}`);
  return (
    `{\n  "schema_version": 1,\n  "note": ${JSON.stringify(overrides.note ?? "")},\n  "videos": {\n` +
    lines.join(",\n") +
    `\n  }\n}\n`
  );
}
