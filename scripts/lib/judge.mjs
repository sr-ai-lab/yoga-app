// scripts/lib/judge.mjs — 動画を「推薦対象にしてよいか」判定する(決定論的・理由コード付き)
//
// 判定結果:
//   excluded … 推薦対象外(理由コードを記録)
//   held     … 判定が不確か。自動登録せず確認対象として保留
//   ok       … 運動プログラムとして登録候補(分類は classify.mjs で行う)
//
// 1本の動画に複数の理由が該当しうるため、reasons に全て記録し、
// 集計用には REASON_PRIORITY の先頭に当たるもの(primary)を1つ採用する(合計が総数と一致する)。

import { normalizeText } from "./util.mjs";

export const REASON_PRIORITY = [
  "unavailable",
  "wrong_channel",
  "not_public",
  "live_or_archive",
  "no_duration",
  "shorts",
  "over_max_duration",
  "non_exercise",
  "possible_shorts",
  "meditation_out_of_scope",
  "program_intro",
  "non_exercise_conflict",
  "no_exercise_signal",
];

// 技術的に推薦に使えない理由。手動修正(overrides)でも復活させない
export const NON_OVERRIDABLE_REASONS = new Set([
  "unavailable",
  "wrong_channel",
  "not_public",
  "live_or_archive",
  "no_duration",
  "shorts",
  "over_max_duration",
]);

// 推薦対象外として確定する理由(これ以外の理由は「保留」)
const EXCLUDING_REASONS = new Set([...NON_OVERRIDABLE_REASONS, "non_exercise"]);

const re = (pattern) => new RegExp(pattern);

export function judgeVideo(facts, rules, limits) {
  const title = normalizeText(facts.title);
  const s = facts.signals ?? {};
  const durationSec = facts.duration_sec ?? 0;
  const reasons = [];

  if (s.unavailable) {
    reasons.push("unavailable");
  } else {
    // 収集元チャンネルの動画であることを動画単位でも確認する(公式チャンネル以外を混入させない)
    if (s.wrong_channel) reasons.push("wrong_channel");
    if (!s.public) reasons.push("not_public");
    // ライブ配信中/予定、およびアーカイブは再生時間が取れても完全に除外する
    if (s.live) reasons.push("live_or_archive");
    if (!(durationSec > 0)) reasons.push("no_duration");

    if (s.shorts_playlist || (s.shorts_hashtag && durationSec > 0 && durationSec <= limits.shorts_max_sec)) {
      reasons.push("shorts");
    } else if (durationSec > 0 && durationSec <= 60) {
      // 時間だけではShortsと断定しない。保留して人が確認する
      reasons.push("possible_shorts");
    }
    if (Math.round(durationSec / 60) > limits.max_duration_min) reasons.push("over_max_duration");

    const j = rules.judge;
    const isNon = re(j.non_exercise).test(title);
    const isExercise = re(j.exercise).test(title);
    // 募集・舞台裏・お知らせなどは、タイトルに「ヨガ」等の運動語が含まれていても運動プログラムではない
    // (単語1つで機械的に除外するのは、この明確な語のみ。「撮影」「紹介」などは含めない)
    const isStrongNon = j.non_exercise_strong ? re(j.non_exercise_strong).test(title) : false;
    if (isStrongNon) reasons.push("non_exercise");
    else if (isNon && !isExercise) reasons.push("non_exercise");
    else if (isNon && isExercise) reasons.push("non_exercise_conflict");
    else if (!isExercise) reasons.push("no_exercise_signal");

    if (re(j.meditation).test(title)) reasons.push("meditation_out_of_scope");
    if (re(j.program_intro).test(title) && !re(j.program_day).test(title) && durationSec <= 600) {
      reasons.push("program_intro");
    }
  }

  reasons.sort((a, b) => REASON_PRIORITY.indexOf(a) - REASON_PRIORITY.indexOf(b));
  if (reasons.length === 0) return { status: "ok", reasons, primary: null };

  const excluded = reasons.some((r) => EXCLUDING_REASONS.has(r));
  return { status: excluded ? "excluded" : "held", reasons, primary: reasons[0] };
}
