// scripts/lib/util.mjs — 取得・判定・分類で共通に使う小さなユーティリティ

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ISO8601 duration ("PT1H2M3S") → 秒。解釈できない/0秒は 0 を返す
export function parseIsoDurationSec(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return 0;
  const [, d, h, min, s] = m.map((x) => Number(x || 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

// タイトル照合用: 全角英数・記号を半角に揃える(NFKC)
export function normalizeText(text) {
  return String(text ?? "").normalize("NFKC");
}

export async function readJson(absPath, fallback) {
  try {
    return JSON.parse(await readFile(absPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" && fallback !== undefined) return fallback;
    throw err;
  }
}

// 一時ファイルに書いてからrenameする(書き込み途中で落ちても元ファイルを壊さない)
export async function writeJsonAtomic(absPath, data) {
  await mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, absPath);
}

export function today(now = new Date()) {
  // 日本時間の日付(YYYY-MM-DD)
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}
