// scripts/catalog-sync.mjs — 動画データベースの取得・分類・更新(定期自動更新と初回取得の入口)
//
// データの流れ:  YouTube Data API → data/catalog.json(台帳) ┐
//                                  data/overrides.json(人の修正)┴→ data/videos.json(アプリが読む推薦対象)
//
// 使い方:
//   node scripts/catalog-sync.mjs --incremental            定期更新(週1回。新着の取得+登録済み全動画のメタデータ再取得)
//   node scripts/catalog-sync.mjs --backfill               過去動画の初回取得(全件走査。何度実行しても重複しない)
//   node scripts/catalog-sync.mjs --reclassify [--apply]   ルール変更後の再分類(API不要。--applyなしは差分表示のみ)
//   node scripts/catalog-sync.mjs --rebuild                台帳+手動修正から videos.json を再生成(API不要)
//   node scripts/catalog-sync.mjs --seed-overrides         既存の人手確認済み分類を overrides.json に移行(一度だけ)
//   node scripts/catalog-sync.mjs --report                 現在の台帳の集計(チャンネル別・理由別)を表示
//   node scripts/catalog-sync.mjs --list-held              保留(要確認)の一覧と理由を表示
//   node scripts/catalog-sync.mjs --check-freshness [--max-days=14]  保存データが古すぎないか確認(超過なら終了コード1)
// 共通オプション:
//   --dry-run         ファイルを一切書き込まない
//   --no-build        台帳(catalog.json)のみ更新し、videos.json は更新しない
//   --allow-removals  推薦対象が大量に減る更新を許可する(通常は安全装置で中止)
//   --diff-out=<path> --reclassify の変更前後の差分をMarkdownで書き出す
//
// 終了コード: 0=成功(新着0件も成功) / 1=失敗(全チャンネル失敗・不整合等。データは変更しない) / 2=一部チャンネルのみ失敗(成功分は保存)

import { readFile, writeFile, rename, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createYouTubeClient } from "./lib/youtube.mjs";
import { ROOT, readJson, today as todayJst } from "./lib/util.mjs";
import { emptyCatalog, resolveAll, buildVideosJson, serializeVideos, serializeCatalog, serializeOverrides } from "./lib/catalog.mjs";
import { runSync, reclassifyAll, checkFreshness } from "./lib/sync.mjs";
import { validateVideos, validateCatalog } from "./lib/validate-videos.mjs";
import { renderHeldMarkdown, renderChangesMarkdown } from "./lib/report.mjs";

const P = {
  catalog: path.join(ROOT, "data/catalog.json"),
  overrides: path.join(ROOT, "data/overrides.json"),
  videos: path.join(ROOT, "data/videos.json"),
  rules: path.join(ROOT, "data/classification-rules.json"),
  vocabulary: path.join(ROOT, "data/vocabulary.json"),
  config: path.join(ROOT, "scripts/config.json"),
  progress: path.join(ROOT, "scripts/catalog-progress.json"),
  held: path.join(ROOT, "docs/HELD.md"),
};

const args = new Set(process.argv.slice(2));
const argValue = (name) => process.argv.slice(2).find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const log = (...a) => console.log(...a);

async function loadEnv() {
  try {
    const text = await readFile(path.join(ROOT, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      if (!(key in process.env)) process.env[key] = t.slice(eq + 1).trim();
    }
  } catch {
    // .env が無い場合は環境変数(GitHub Actions では Secrets)から読む
  }
}

// 複数ファイルを「全部一時ファイルに書いてから」まとめて置き換える(途中で落ちても元ファイルは無傷)
async function writeAllAtomic(files) {
  const tmps = [];
  try {
    for (const [file, text] of files) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, text, "utf8");
      tmps.push([tmp, file]);
    }
  } catch (err) {
    throw new Error(`書き込みの準備に失敗しました(元のファイルは変更されていません): ${err.message}`);
  }
  for (const [tmp, file] of tmps) await rename(tmp, file);
}

async function loadAll() {
  const [catalog, overrides, rules, vocabulary, config, videos] = await Promise.all([
    readJson(P.catalog, emptyCatalog()),
    readJson(P.overrides, { schema_version: 1, note: "", videos: {} }),
    readJson(P.rules),
    readJson(P.vocabulary),
    readJson(P.config),
    readJson(P.videos),
  ]);
  const vocabularyTags = new Set(Object.values(vocabulary.categories).flat());
  return { catalog, overrides, rules, vocabularyTags, config, videos };
}

// 台帳+手動修正から videos.json を作り、構造検証と「推薦対象が急減していないか」の安全確認を行う
function buildAndCheck({ catalog, overrides, vocabularyTags, config, videos: current }, today) {
  const fresh = buildVideosJson(catalog, overrides, vocabularyTags, current.updated);
  const same = serializeVideos(fresh) === serializeVideos(current);
  const next = same ? current : { ...fresh, updated: today };

  const text = serializeVideos(next);
  const errors = validateVideos(text, next, new Set(config.channels.map((c) => c.name)), vocabularyTags);
  if (errors.length) throw new Error(`生成した videos.json が検証に失敗しました(書き込みを中止):\n - ${errors.slice(0, 10).join("\n - ")}`);

  const nextIds = new Set(next.videos.map((v) => v.id));
  const removed = current.videos.filter((v) => !nextIds.has(v.id));
  const limit = Math.max(5, Math.ceil(current.videos.length * 0.05));
  if (removed.length > limit && !args.has("--allow-removals")) {
    throw new Error(
      `推薦対象が${removed.length}件減ります(安全装置の上限${limit}件)。内容を確認し、問題なければ --allow-removals を付けて再実行してください。\n` +
        removed.slice(0, 10).map((v) => `   ${v.id} ${v.title}`).join("\n")
    );
  }
  const added = next.videos.filter((v) => !current.videos.some((c) => c.id === v.id));
  return { next, text, same, added, removed };
}

function summarize(catalog, overrides, vocabularyTags, config) {
  const { resolved } = resolveAll(catalog, overrides, vocabularyTags);
  const out = {};
  for (const ch of config.channels) out[ch.name] = { total: 0, registered: 0, held: 0, excluded: 0, by_reason: {}, by_reason_any: {}, source: {} };
  for (const [id, r] of resolved) {
    const s = out[catalog.videos[id].channel] ?? (out[catalog.videos[id].channel] = { total: 0, registered: 0, held: 0, excluded: 0, by_reason: {}, by_reason_any: {}, source: {} });
    s.total++;
    s[r.status]++;
    if (r.status === "registered") s.source[r.source] = (s.source[r.source] ?? 0) + 1;
    if (r.primary) s.by_reason[r.primary] = (s.by_reason[r.primary] ?? 0) + 1;
    for (const x of new Set(r.reasons)) s.by_reason_any[x] = (s.by_reason_any[x] ?? 0) + 1;
  }
  return out;
}

function printSummary(summary) {
  let all = { total: 0, registered: 0, held: 0, excluded: 0 };
  for (const [name, s] of Object.entries(summary)) {
    log(`\n[${name}] 台帳 ${s.total}件 = 推薦対象 ${s.registered} + 保留 ${s.held} + 除外 ${s.excluded}`);
    log(`  推薦対象の内訳(source): ${JSON.stringify(s.source)}`);
    log(`  除外/保留の理由(1本につき最優先の理由1つで集計。合計=保留+除外): ${JSON.stringify(s.by_reason)}`);
    log(`  参考: 該当した全理由の延べ件数(重複あり): ${JSON.stringify(s.by_reason_any)}`);
    for (const k of Object.keys(all)) all[k] += s[k];
  }
  log(`\n[全体] 台帳 ${all.total}件 = 推薦対象 ${all.registered} + 保留 ${all.held} + 除外 ${all.excluded}`);
}

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

function reportToMarkdown(report, build) {
  const lines = ["## 動画データ更新結果", "", `モード: \`${report.mode}\``, ""];
  lines.push("| チャンネル | 結果 | 新着の一覧取得 | 新規 | 登録 | 保留 | 除外 | 登録済みの再確認 | うち内容が変わった | 利用不可を確認中 | 利用不可を確定 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [name, c] of Object.entries(report.channels)) {
    if (!c.ok) {
      lines.push(`| ${name} | ❌ 失敗 | - | - | - | - | - | - | - | - | - |`);
      continue;
    }
    const n = c.new_result ?? {};
    lines.push(`| ${name} | ✅ | ${c.fetched} | ${c.new} | ${n.registered ?? 0} | ${n.held ?? 0} | ${n.excluded ?? 0} | ${c.checked ?? 0} | ${c.refreshed} | ${c.pending_unavailable ?? 0} | ${c.newly_unavailable ?? 0} |`);
  }
  for (const f of report.failures) lines.push("", `❌ **${f.channel}** の更新に失敗しました: ${f.error}`);
  for (const w of report.warnings) lines.push("", `⚠️ ${w}`);
  if (build) lines.push("", `推薦対象(videos.json): 追加 ${build.added.length}件 / 削除 ${build.removed.length}件`);
  if (report.mode === "incremental" && Object.values(report.channels).every((c) => c.ok && c.new === 0)) {
    lines.push("", "新着動画はありませんでした(正常終了)。");
  }
  return lines;
}

async function seedOverrides(ctx) {
  const { catalog, overrides, videos } = ctx;
  const progress = await readJson(P.progress, { processed: {} });
  const next = structuredClone(overrides);
  next.videos = next.videos ?? {};
  next.note =
    next.note ||
    "人の判断による修正。自動処理は書き換えない。キー=動画ID。intensity/type/tags/equipment=分類の上書き(3項目揃うと承認扱い)、approve=true=自動分類のまま承認、exclude=true=推薦対象外、hold=true=保留。";
  const added = { approved: 0, excluded: 0, missing: [] };

  for (const v of videos.videos) {
    if (next.videos[v.id]) continue;
    if (!catalog.videos[v.id]) {
      added.missing.push(v.id);
      continue;
    }
    next.videos[v.id] = { intensity: v.intensity, type: v.type, tags: v.tags, ...(v.equipment ? { equipment: v.equipment } : {}), note: "人が確認済み(初期100本)" };
    added.approved++;
  }
  const HUMAN_EXCLUDE = new Set(["talk_or_announcement_no_exercise", "interview", "channel_intro"]);
  for (const [id, p] of Object.entries(progress.processed)) {
    if (p.status !== "rejected" || !HUMAN_EXCLUDE.has(p.reason) || next.videos[id] || !catalog.videos[id]) continue;
    next.videos[id] = { exclude: true, note: `人が除外(${p.reason})` };
    added.excluded++;
  }
  return { next, added };
}

async function main() {
  const dryRun = args.has("--dry-run");
  const today = todayJst();
  const ctx = await loadAll();
  const { catalog, overrides, rules, vocabularyTags, config } = ctx;

  if (args.has("--report") || args.has("--list-held")) {
    const summary = summarize(catalog, overrides, vocabularyTags, config);
    if (args.has("--report")) printSummary(summary);
    if (args.has("--list-held")) log(renderHeldMarkdown(catalog, overrides, vocabularyTags));
    return 0;
  }

  if (args.has("--check-freshness")) {
    const maxDays = Number(argValue("--max-days") ?? 14);
    const results = checkFreshness(catalog, config, today, { maxDays });
    let bad = false;
    for (const r of results) {
      log(`${r.level === "ok" ? "OK  " : r.level === "warn" ? "注意" : "NG  "} ${r.channel}: ${r.message}`);
      if (r.level === "error") bad = true;
    }
    if (bad) console.error(`保存データの再取得から${maxDays}日を超えています(YouTube API規約の30日要件に対する余裕が小さくなっています)。Actionsの実行状況を確認してください。`);
    return bad ? 1 : 0;
  }

  if (args.has("--seed-overrides")) {
    const { next, added } = await seedOverrides(ctx);
    log(`移行: 承認済み ${added.approved}件 / 手動除外 ${added.excluded}件 / 台帳に無く移行できなかった ${added.missing.length}件 ${added.missing.join(",")}`);
    if (!dryRun) await writeAllAtomic([[P.overrides, serializeOverrides(next)]]);
    return 0;
  }

  let nextCatalog = catalog;
  let report = null;
  let exitCode = 0;

  if (args.has("--incremental") || args.has("--backfill")) {
    await loadEnv();
    const client = createYouTubeClient({ apiKey: process.env.YOUTUBE_API_KEY });
    const mode = args.has("--backfill") ? "backfill" : "incremental";
    const result = await runSync({ mode, client, config, catalog, overrides, rules, vocabularyTags, today });
    nextCatalog = result.catalog;
    report = result.report;
    for (const [name, c] of Object.entries(report.channels)) {
      log(
        c.ok
          ? `[${name}] 新着の一覧取得 ${c.fetched}件 / 新規 ${c.new}件 / 登録済みの再確認 ${c.checked}件(うち内容が変わったもの ${c.refreshed}件) / 利用不可を確認中 ${c.pending_unavailable}件 / 利用不可を確定 ${c.newly_unavailable}件 / 復活 ${c.recovered}件 / 消去 ${c.purged}件`
          : `[${name}] 失敗: ${c.error}`
      );
    }
    for (const w of report.warnings) log(`警告: ${w}`);
    if (report.failures.length === config.channels.length) {
      await writeStepSummary(reportToMarkdown(report));
      console.error("全チャンネルの更新に失敗しました。データは変更していません。");
      return 1;
    }
    if (report.failures.length > 0) exitCode = 2;
  } else if (args.has("--reclassify")) {
    const { catalog: re, changes } = reclassifyAll({ catalog, overrides, rules, vocabularyTags, limits: config.limits });
    log(`再分類による変化: ${changes.length}件`);
    for (const c of changes.slice(0, 50)) log(`  ${c.id} ${c.from} → ${c.to}  ${c.title}`);
    const diffOut = argValue("--diff-out");
    if (diffOut && !dryRun) {
      await writeAllAtomic([[path.resolve(ROOT, diffOut), renderChangesMarkdown(changes, catalog.rules_version, rules.version)]]);
      log(`差分を書き出しました: ${diffOut}`);
    }
    if (!args.has("--apply")) {
      log("(差分表示のみ。反映するには --apply を付けてください)");
      return 0;
    }
    nextCatalog = re;
  } else if (!args.has("--rebuild")) {
    console.error("オプションを指定してください(--incremental / --backfill / --reclassify / --rebuild / --report / --list-held / --seed-overrides)");
    return 1;
  }

  const files = [];
  if (nextCatalog !== catalog) {
    const errors = validateCatalog(nextCatalog, overrides, new Set(config.channels.map((c) => c.channel_id)));
    if (errors.length) throw new Error(`台帳の整合性エラー(書き込みを中止):\n - ${errors.slice(0, 10).join("\n - ")}`);
    const text = serializeCatalog(nextCatalog);
    if (text !== serializeCatalog(catalog)) files.push([P.catalog, text]);
  }

  let build = null;
  if (!args.has("--no-build")) {
    build = buildAndCheck({ ...ctx, catalog: nextCatalog }, today);
    if (!build.same) files.push([P.videos, build.text]);
    const held = renderHeldMarkdown(nextCatalog, overrides, vocabularyTags);
    const heldBefore = await readFile(P.held, "utf8").catch(() => null);
    if (held !== heldBefore) files.push([P.held, held]);
    log(`\nvideos.json: 推薦対象 ${build.next.videos.length}件(追加 ${build.added.length} / 削除 ${build.removed.length})`);
    for (const v of build.removed) log(`  削除: ${v.id} ${v.title}`);
  }

  printSummary(summarize(nextCatalog, overrides, vocabularyTags, config));
  if (report) await writeStepSummary(reportToMarkdown(report, build));

  if (dryRun) {
    log("\n--dry-run: ファイルは書き込みません。");
  } else if (files.length > 0) {
    await writeAllAtomic(files);
    log(`\n更新したファイル: ${files.map(([f]) => path.relative(ROOT, f)).join(", ")}`);
  } else {
    log("\n変更はありません。");
  }
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // エラーメッセージにはAPIキー・URLを含めない(youtube.mjs側で除去済み)
    console.error(`エラー: ${err.message}`);
    process.exitCode = 1;
  }
);
