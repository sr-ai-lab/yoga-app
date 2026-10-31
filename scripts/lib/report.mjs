// scripts/lib/report.mjs — 保留(要確認)一覧の生成。出力は決定論的(日時を含めない)

import { resolveAll } from "./catalog.mjs";

export const REASON_LABELS = {
  possible_shorts: "60秒以下でShortsの可能性(断定できないため保留)",
  meditation_out_of_scope: "瞑想系(現在のアプリでは推薦対象外)",
  program_intro: "プログラム紹介の可能性(運動動画か判断できない)",
  non_exercise_conflict: "運動を示す語と運動以外を示す語の両方を含む",
  no_exercise_signal: "タイトルから運動動画と判断できる語がない",
  intensity_conflict: "強度を示す語が矛盾している",
  intensity_unresolved: "強度を判断できる語がない",
  tags_unresolved: "部位・目的のタグを判断できない",
  invalid_classification: "分類内容が不正(語彙外など)",
  manual_hold: "人が保留にした",
};

const row = (s) => String(s).replace(/\|/g, "\\|");

export function renderHeldMarkdown(catalog, overrides, vocabularyTags) {
  const { resolved } = resolveAll(catalog, overrides, vocabularyTags);
  const held = [...resolved].filter(([, r]) => r.status === "held");
  const lines = [
    "# 保留(要確認)の動画",
    "",
    "自動判定で確信が持てなかった動画です。**アプリの推薦には使われていません。**",
    "このファイルは `node scripts/catalog-sync.mjs --rebuild` などで自動生成されます(直接編集しないでください)。",
    "",
    "採用する場合は `data/overrides.json` に動画IDで分類(intensity / type / tags)を書くか、`approve: true`(自動分類のまま承認)を追加します。",
    "推薦しない場合は `exclude: true` を追加すると、このリストから消えます。",
    "",
    `保留: ${held.length}件`,
    "",
  ];
  if (held.length === 0) return lines.join("\n") + "\n";
  lines.push("| 動画 | チャンネル | 分 | 保留の理由 | 自動分類の案 |", "|---|---|---:|---|---|");
  for (const [id, r] of held) {
    const e = catalog.videos[id];
    const a = e.classify?.auto;
    const proposal = a ? `強度${a.intensity ?? "?"} / ${a.type} / ${a.tags.join("・") || "-"}` : "-";
    const reasons = r.reasons.map((x) => REASON_LABELS[x] ?? x).join("; ");
    lines.push(
      `| [${row(e.title)}](https://www.youtube.com/watch?v=${id}) \`${id}\` | ${e.channel} | ${Math.round(e.duration_sec / 60)} | ${row(reasons)} | ${row(proposal)} |`
    );
  }
  return lines.join("\n") + "\n";
}

// 再分類の変更前後の差分(人が確認するための一覧)
export function renderChangesMarkdown(changes, fromVersion, toVersion) {
  const fmt = (r) =>
    r.intensity != null || r.type
      ? `強度${r.intensity} / ${r.type} / ${(r.tags ?? []).join("・")}`
      : `(推薦なし: ${(r.reasons ?? []).map((x) => REASON_LABELS[x] ?? x).join("; ")})`;
  const kind = (c) => (c.from === "registered" && c.to === "registered" ? "分類の変更" : `${c.from} → ${c.to}`);
  const groups = {};
  for (const c of changes) (groups[kind(c)] ??= []).push(c);
  const lines = [`# 再分類の差分(ルール v${fromVersion} → v${toVersion})`, "", `変更: ${changes.length}件`, ""];
  for (const [k, list] of Object.entries(groups)) lines.push(`- ${k}: ${list.length}件`);
  for (const [k, list] of Object.entries(groups)) {
    lines.push("", `## ${k}(${list.length}件)`, "", "| 動画 | 分 | 変更前 | 変更後 | 根拠 |", "|---|---:|---|---|---|");
    for (const c of list) {
      lines.push(`| ${row(c.title)} \`${c.id}\` | ${c.duration_min} | ${row(fmt(c.before))} | ${row(fmt(c.after))} | ${row(c.evidence.join("; "))} |`);
    }
  }
  return lines.join("\n") + "\n";
}
