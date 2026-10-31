// scripts/build-site.mjs — GitHub Pagesに公開するファイルだけを _site/ に集める(ビルド処理はなく、コピーと確認のみ)
//
// 公開するのはアプリの実行に必要なファイルだけ。台帳(catalog.json)・人の修正(overrides.json)・
// ルール・スクリプト・ドキュメントは公開しない(リポジトリ上では引き続き閲覧できる)。
// 公開前の確認: アプリから参照されるファイルがすべて含まれていること、videos.json が読めて動画が1本以上あること。
//
// 使い方: node scripts/build-site.mjs [出力先(既定: _site)]

import { cp, mkdir, rm, readFile, access } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./lib/util.mjs";

const OUT = path.resolve(ROOT, process.argv[2] ?? "_site");
const PUBLISH = [
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "robots.txt",
  ".nojekyll",
  "icons",
  "data/videos.json",
  "data/modes.json",
  "data/vocabulary.json",
];

const exists = (p) => access(p).then(() => true, () => false);

// ローカルファイルへの参照(外部URL・アンカー・data:を除く)
function localRefs(text, patterns) {
  const refs = new Set();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const ref = m[1].split(/[?#]/)[0];
      if (ref && !/^(https?:)?\/\//.test(ref) && !ref.startsWith("data:") && !ref.startsWith("mailto:")) refs.add(ref);
    }
  }
  return [...refs];
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (const rel of PUBLISH) {
    const src = path.join(ROOT, rel);
    if (!(await exists(src))) throw new Error(`公開対象のファイルがありません: ${rel}`);
    await mkdir(path.dirname(path.join(OUT, rel)), { recursive: true });
    await cp(src, path.join(OUT, rel), { recursive: true });
  }

  // アプリの参照先がすべて含まれているか
  const read = (rel) => readFile(path.join(ROOT, rel), "utf8");
  const checks = [
    ["index.html", await read("index.html"), [/(?:href|src)="([^"]+)"/g], ""],
    ["style.css", await read("style.css"), [/url\(["']?([^)"']+)["']?\)/g], ""],
    ["app.js", await read("app.js"), [/fetch\(\s*"([^"]+)"/g], ""],
    ["manifest.json", await read("manifest.json"), [/"(?:src|start_url|scope)"\s*:\s*"([^"]+)"/g], ""],
  ];
  const missing = [];
  for (const [from, text, patterns] of checks) {
    for (const ref of localRefs(text, patterns)) {
      if (ref === "." || ref === "./" || ref === "/") continue;
      if (!(await exists(path.join(OUT, ref)))) missing.push(`${from} が参照する ${ref}`);
    }
  }
  if (missing.length) throw new Error(`公開ファイルに不足があります:\n - ${missing.join("\n - ")}`);

  // データの最終確認(壊れた/空のデータを公開しない)
  const videos = JSON.parse(await readFile(path.join(OUT, "data/videos.json"), "utf8"));
  JSON.parse(await readFile(path.join(OUT, "data/modes.json"), "utf8"));
  if (!Array.isArray(videos.videos) || videos.videos.length < 1) throw new Error("videos.json に動画がありません。公開を中止します");

  console.log(`公開用ファイルを ${path.relative(ROOT, OUT) || "."} に集めました(動画 ${videos.videos.length}本)`);
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exitCode = 1;
});
