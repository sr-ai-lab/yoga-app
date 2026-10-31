// scripts/lib/classify.mjs — ルールベースの自動分類(タイトル + 再生時間のみを根拠にする)
//
// intensity / type / tags / equipment を決める。根拠(どのルールがどの語に一致したか)を
// evidence に残す。1つでも確信を持てない項目があれば ok=false として「保留」にする。
// 生成AIは使わない(決定論的で、同じ入力は常に同じ結果になる)。

import { normalizeText } from "./util.mjs";

const find = (pattern, text) => new RegExp(pattern).exec(text)?.[0] ?? null;

// 強度(1=低 / 2=中 / 3=高)。動画の長さだけでは決めない。時間帯(朝・夜)も強度の根拠にしない。
// 判断の優先順:
//   1. 高強度の語(トレーニング等)=3。穏やかな語と混在するなら判断しない
//   2. 中強度の語(フロー・ピラティス・脂肪燃焼等)=2。「やさしい」「初心者向け」では下げない
//   3. 穏やかな語(リラックス・ストレッチ・ほぐす・寝たまま等)=1。中強度の語と混在するなら判断しない
//   4. 補助的な手がかり(疲労回復・自律神経・首こり等)は、人手分類との照合で低強度への一致率が高かったもののみ。
//      他に強度の手がかりがなく、かつ長時間でない場合に限り=1
function resolveIntensity(title, durationSec, rules) {
  const p = rules.intensity;
  const minutes = Math.round(durationSec / 60);
  const hits = {
    strong: find(p.strong_high, title),
    flow: find(p.flow, title),
    burn: find(p.burn, title),
    calm: find(p.calm, title),
    gentle: find(p.gentle, title),
    support: p.low_support ? find(p.low_support, title) : null,
  };

  if (hits.strong && (hits.calm || hits.gentle || hits.flow)) {
    return { reason: "intensity_conflict", evidence: [`conflict:${hits.strong}+${hits.calm || hits.gentle || hits.flow}`] };
  }
  if (hits.strong) return { value: 3, evidence: [`intensity=3:${hits.strong}`] };
  if (hits.calm && (hits.flow || hits.burn)) {
    return { reason: "intensity_conflict", evidence: [`conflict:${hits.calm}+${hits.flow || hits.burn}`] };
  }
  if (hits.flow || hits.burn) return { value: 2, evidence: [`intensity=2:${hits.flow || hits.burn}`] };
  if (hits.calm || hits.gentle) return { value: 1, evidence: [`intensity=1:${hits.calm || hits.gentle}`] };
  if (hits.support) {
    if (minutes > 0 && minutes <= (p.low_support_max_min ?? 0)) {
      return { value: 1, evidence: [`intensity=1:補助的な手がかり「${hits.support}」(${minutes}分)`] };
    }
    return { reason: "intensity_unresolved", evidence: [`補助的な手がかり「${hits.support}」はあるが長時間のため判断しない`] };
  }
  return { reason: "intensity_unresolved", evidence: [] };
}

// 種別(コース内の役割)。強度・目的・時間帯とは別の軸。長さだけでは決めない。
//   高強度(トレーニング等)は短時間でも main。
//   cooldown: 「運動後」「疲れをとる」「寝る前」「安眠」など終わりの整えを示す語があり、低強度で、長すぎない
//   warmup: 「ウォームアップ」「目覚め」「朝ヨガ」など始めの準備を示す語があり、低〜中強度で、長すぎない
//   それ以外は main(長さは上限としてのみ使う)
function resolveType(title, durationSec, intensity, rules) {
  const t = rules.type;
  const minutes = Math.round(durationSec / 60);

  if (intensity === 3) return { value: "main", evidence: ["type=main:高強度は短時間でも主運動"] };

  const cool = find(t.cooldown_words, title);
  if (cool && intensity === 1 && minutes <= t.cooldown_max_min) {
    return { value: "cooldown", evidence: [`type=cooldown:${cool}`] };
  }
  const warm = find(t.warmup_words, title);
  if (warm && (intensity === 1 || intensity === 2) && minutes <= t.warmup_max_min) {
    return { value: "warmup", evidence: [`type=warmup:${warm}`] };
  }
  return { value: "main", evidence: ["type=main:既定"] };
}

function resolveTags(title, rules, vocabularyTags) {
  const found = [];
  const evidence = [];
  for (const tag of rules.tag_priority) {
    if (!vocabularyTags.has(tag)) continue; // 統制語彙にない語は付けない
    const hit = find(rules.tags[tag], title);
    if (hit) {
      found.push(tag);
      evidence.push(`tag=${tag}:${hit}`);
    }
  }
  return { value: found.slice(0, 5), evidence: evidence.slice(0, 5) };
}

function resolveEquipment(title, rules) {
  const value = [];
  const evidence = [];
  for (const [name, pattern] of Object.entries(rules.equipment ?? {})) {
    const hit = find(pattern, title);
    if (hit) {
      value.push(name);
      evidence.push(`equipment=${name}:${hit}`);
    }
  }
  return { value, evidence };
}

// 戻り値: { ok, heldReasons[], auto:{ intensity,type,tags,equipment,evidence[],rules_version } }
export function classifyVideo({ title, duration_sec }, rules, vocabularyTags) {
  const normalized = normalizeText(title);
  const heldReasons = [];
  const evidence = [];

  const intensity = resolveIntensity(normalized, duration_sec, rules);
  evidence.push(...intensity.evidence);
  if (intensity.reason) heldReasons.push(intensity.reason);

  const type = resolveType(normalized, duration_sec, intensity.value ?? null, rules);
  evidence.push(...type.evidence);

  const tags = resolveTags(normalized, rules, vocabularyTags);
  evidence.push(...tags.evidence);
  if (tags.value.length === 0) heldReasons.push("tags_unresolved");

  const equipment = resolveEquipment(normalized, rules);
  evidence.push(...equipment.evidence);

  return {
    ok: heldReasons.length === 0,
    heldReasons,
    auto: {
      intensity: intensity.value ?? null,
      type: type.value,
      tags: tags.value,
      equipment: equipment.value,
      evidence,
      rules_version: rules.version,
    },
  };
}
