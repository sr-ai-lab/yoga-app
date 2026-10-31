// GitHub Actionsワークフローの静的な確認(実際の実行ではない。Actions/Pagesでの動作確認は別途必要)
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "../lib/util.mjs";

const text = async (rel) => (await readFile(path.join(ROOT, rel), "utf8")).replace(/\r\n/g, "\n"); // Windowsの改行(CRLF)も同じに扱う
const update = await text(".github/workflows/data-update.yml");
const deploy = await text(".github/workflows/deploy-pages.yml");

// 最小限のcron評価(数値・*・カンマ区切りのみ)。2027〜2029年に実行される日(UTC)の最大間隔(日)を返す
function maxGapDays(cron) {
  const [, , dom, mon, dow] = cron.trim().split(/\s+/);
  const match = (field, value) => field === "*" || field.split(",").map(Number).includes(value);
  const days = [];
  const end = Date.UTC(2030, 0, 1);
  for (let t = Date.UTC(2027, 0, 1); t < end; t += 86400000) {
    const d = new Date(t);
    const domHit = match(dom, d.getUTCDate());
    const dowHit = match(dow, d.getUTCDay());
    // cronの仕様: 日と曜日の両方を指定した場合はどちらかに一致すればよい
    const okDay = dom !== "*" && dow !== "*" ? domHit || dowHit : domHit && dowHit;
    if (match(mon, d.getUTCMonth() + 1) && okDay) days.push(t / 86400000);
  }
  let gap = 0;
  for (let i = 1; i < days.length; i++) gap = Math.max(gap, days[i] - days[i - 1]);
  return gap;
}

test("更新スケジュール: どの月でも実行間隔が14日以内(YouTube API規約の30日要件に余裕を持たせる)", () => {
  const crons = [...update.matchAll(/cron:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(crons.length >= 1, "scheduleが設定されていません");
  for (const c of crons) {
    const gap = maxGapDays(c);
    assert.ok(gap <= 14, `${c} の最大間隔が${gap}日です`);
  }
  assert.equal(maxGapDays("0 0 * * 1"), 7);
  assert.ok(maxGapDays("0 0 1,15 * *") > 14, "毎月1日・15日では14日以内に収まらない(15日→翌月1日が最大17日)");
});

test("手動実行(workflow_dispatch)と、dry_runの選択肢がある", () => {
  assert.match(update, /workflow_dispatch:/);
  assert.match(update, /dry_run:/);
});

test("APIキーは GitHub Secrets から環境変数として渡すだけで、ファイルやログに出さない", () => {
  assert.match(update, /YOUTUBE_API_KEY:\s*\$\{\{\s*secrets\.YOUTUBE_API_KEY\s*\}\}/);
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(update + deploy), "キーらしき文字列がある");
  assert.ok(!/echo[^\n]*YOUTUBE_API_KEY/.test(update), "キーをechoしている");
  assert.ok(!/set -x/.test(update), "set -x はコマンド内容をログに出す");
  // Secretsを渡すのは同期ステップだけ
  assert.equal([...update.matchAll(/secrets\./g)].length, 1);
});

test("データ更新ワークフロー: 最小権限・同時実行制御・テストと検証の後でだけコミットする", () => {
  assert.match(update, /^permissions:\n  contents: read/m);
  assert.match(update, /concurrency:\n  group: data-update/);
  const order = ["Run tests", "Sync videos from YouTube", "Validate data", "Commit changes"].map((n) => update.indexOf(`name: ${n}`));
  assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]));
  assert.match(update, /git add data\/catalog\.json data\/videos\.json docs\/HELD\.md/);
});

test("更新失敗の警告: 一部失敗・鮮度超過のときワークフローが失敗になる", () => {
  assert.match(update, /exit_code == '2'/);
  assert.match(update, /--check-freshness --max-days=14/);
});

test("Pages自動デプロイ: 更新があったときだけ、追加トークンなしでデプロイ用ワークフローを呼ぶ", () => {
  assert.match(update, /uses: \.\/\.github\/workflows\/deploy-pages\.yml/);
  assert.match(update, /needs\.update\.outputs\.changed == 'true'/);
  assert.match(deploy, /workflow_call:/);
  assert.match(deploy, /push:\n\s+branches: \[main\]/);
  assert.match(deploy, /pages: write/);
  assert.match(deploy, /id-token: write/);
  for (const a of ["actions/configure-pages", "actions/upload-pages-artifact", "actions/deploy-pages"]) assert.ok(deploy.includes(a), a);
  assert.ok(!/personal access|\bPAT\b|GH_TOKEN|secrets\.(?!YOUTUBE_API_KEY)/.test(update + deploy), "個人アクセストークンなど追加のSecretsを使っていない");
  assert.match(deploy, /ref: main/, "呼び出し元がコミットした直後でも最新のmainを公開する");
});

test("公開用ファイル: アプリに必要なものだけが集まり、台帳・修正・ルール・スクリプトは公開されない", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "site-"));
  try {
    await promisify(execFile)(process.execPath, [path.join(ROOT, "scripts/build-site.mjs"), dir]);
    const exists = (rel) => access(path.join(dir, rel)).then(() => true, () => false);
    for (const f of ["index.html", "app.js", "style.css", "manifest.json", "data/videos.json", "data/modes.json", "icons/icon-192.png", "robots.txt"]) assert.ok(await exists(f), f);
    for (const f of ["data/catalog.json", "data/overrides.json", "data/classification-rules.json", "scripts", "docs", ".env"]) assert.ok(!(await exists(f)), `${f} が公開対象に含まれている`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
