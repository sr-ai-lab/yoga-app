// scripts/lib/sync.mjs — 取得 → 判定 → 分類 → 台帳更新 の中核処理
//
// ファイルI/Oは行わない(呼び出し側が担当)。入力の catalog は変更せず、新しい catalog を返す。
// 失敗時方針:
//   ・チャンネル単位で all-or-nothing。1チャンネルの処理が途中で失敗したら、そのチャンネルの結果は
//     一切反映せず(部分的なデータを残さない)、失敗として記録する。
//   ・もう一方のチャンネルが成功していれば、そちらは反映する(次回実行で失敗側を再取得できる)。
//   ・動画IDで重複判定するため、同じ処理を再実行しても二重登録されない。
//
// YouTube API規約(Non-Authorized Data は保存から30日以内に再取得か削除)への対応:
//   ・実行のたびに、台帳に残る全動画のメタデータを再取得する(週1回の定期実行で14日以内の間隔を保つ)
//   ・保存するのは動画ID・タイトル・公開日・再生時間・状態フラグのみ(説明文・統計値は保存しない)
//   ・削除/非公開が確定した動画は30日後にタイトル等を消去し、IDと状態だけの墓標(tombstone)にする

import { parseIsoDurationSec } from "./util.mjs";
import { evaluate, resolveAll } from "./catalog.mjs";
import { NON_OVERRIDABLE_REASONS } from "./judge.mjs";

export const DEFAULT_POLICY = {
  unavailable_confirm_runs: 2, // 「見つからない」が連続して何回続いたら確定とするか(一時的なAPIの取りこぼしによる誤削除の防止)
  purge_unavailable_days: 30, // 削除/非公開が確定してから、タイトル等を消去するまでの日数
};

export function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000);
}

export function buildFacts(ref, detail, inShortsPlaylist, channel) {
  const title = detail?.snippet?.title ?? ref.title ?? "";
  const description = detail?.snippet?.description ?? "";
  const live = Boolean(detail?.liveStreamingDetails) || (detail?.snippet?.liveBroadcastContent ?? "none") !== "none";
  return {
    title,
    duration_sec: parseIsoDurationSec(detail?.contentDetails?.duration),
    published_at: detail?.snippet?.publishedAt ?? ref.publishedAt ?? "",
    signals: {
      unavailable: !detail,
      public: detail?.status?.privacyStatus === "public",
      live,
      shorts_playlist: Boolean(inShortsPlaylist),
      // 説明文は分類には使わず、#shorts ハッシュタグの検出にのみ一時的に使う(説明文自体は保存しない)
      shorts_hashtag: /#shorts\b/i.test(`${title} ${description}`),
      wrong_channel: Boolean(detail) && detail.snippet?.channelId !== channel.channel_id,
    },
  };
}

function makeEntry(facts, channel, today, rules, vocabularyTags, limits, firstSeen) {
  const { judge, classify } = evaluate(facts, rules, vocabularyTags, limits);
  return {
    channel: channel.name,
    channel_id: channel.channel_id,
    title: facts.title,
    published_at: facts.published_at,
    duration_sec: facts.duration_sec,
    signals: facts.signals,
    judge,
    classify,
    first_seen: firstSeen ?? today,
  };
}

const factsOf = (e) => ({
  title: e.title,
  duration_sec: e.duration_sec,
  published_at: e.published_at,
  signals: e.signals,
});

// 削除/非公開が確定してから一定期間が過ぎた動画は、タイトル等を消して状態だけを残す
export function tombstone(old) {
  return {
    channel: old.channel,
    channel_id: old.channel_id,
    title: "",
    published_at: old.published_at,
    duration_sec: 0,
    signals: { unavailable: true },
    judge: { status: "excluded", reasons: ["unavailable"], primary: "unavailable" },
    classify: null,
    first_seen: old.first_seen,
    unavailable_since: old.unavailable_since,
    purged: true,
  };
}

const looksLikeShorts = (e) => Boolean(e.signals?.shorts_hashtag) || (e.duration_sec > 0 && e.duration_sec <= 60);

async function syncChannel({ channel, mode, client, catalog, rules, vocabularyTags, limits, today }) {
  const policy = { ...DEFAULT_POLICY, ...(limits.policy ?? {}) };
  const warnings = [];
  const info = await client.getChannel(channel.channel_id);
  if (!info) throw new Error(`チャンネルが見つかりません (${channel.channel_id})`);
  // 公式チャンネルの照合: ハンドルは固定の識別子なので不一致なら中止。表示名は改名があり得るため警告のみ
  if (channel.handle && info.handle && info.handle.toLowerCase() !== channel.handle.toLowerCase()) {
    throw new Error(`公式チャンネルの照合に失敗しました (期待 ${channel.handle} / 実際 ${info.handle})`);
  }
  if (channel.expected_title && info.title !== channel.expected_title) {
    warnings.push(`チャンネル表示名が設定と異なります: "${info.title}"`);
  }
  if (!info.uploadsPlaylistId) throw new Error("uploadsプレイリストIDを取得できませんでした");

  const known = new Set(Object.keys(catalog.videos));
  const own = Object.entries(catalog.videos).filter(([, e]) => e.channel_id === channel.channel_id);
  let pagesSeen = 0;
  const listOptions =
    mode === "backfill"
      ? {}
      : {
          maxPages: limits.incremental_max_pages,
          // アップロード一覧は新しい順。既知の動画だけのページに当たったら(最低2ページ見たうえで)打ち切る
          shouldStop: (pageRefs) => ++pagesSeen >= 2 && pageRefs.every((r) => known.has(r.id)),
        };
  const { refs, complete } = await client.listUploads(info.uploadsPlaylistId, listOptions);

  // Shorts専用プレイリスト(補助信号)。YouTubeの非公式仕様に依存するため、消えたことを見逃さない
  const shorts = await client.listShortsIds(channel.channel_id);
  const prevMeta = catalog.channels[channel.channel_id];
  const everHadShorts = prevMeta?.shorts_playlist_status === "ok" || prevMeta?.shorts_playlist_available === true || own.some(([, e]) => e.signals?.shorts_playlist);
  if (!shorts.available && everHadShorts && !channel.ignore_shorts_playlist) {
    throw new Error(
      "Shorts一覧(UUSHプレイリスト)が以前は取得できていましたが、今回は取得できません(YouTube側の仕様変更の可能性)。" +
        "このチャンネルの更新を中止しました。確認のうえ、本当にShortsが無くなった場合のみ scripts/config.json の該当チャンネルに \"ignore_shorts_playlist\": true を追加してください"
    );
  }

  const seenInRun = new Set();
  const newRefs = refs.filter((r) => {
    if (known.has(r.id) || seenInRun.has(r.id)) return false;
    seenInRun.add(r.id);
    return true;
  });

  const entries = {};
  const newDetails = await client.getVideos(newRefs.map((r) => r.id));
  for (const ref of newRefs) {
    const facts = buildFacts(ref, newDetails.get(ref.id), shorts.ids.has(ref.id), channel);
    entries[ref.id] = makeEntry(facts, channel, today, rules, vocabularyTags, limits);
  }

  // 定期更新: 登録済みの動画も最新のメタデータに更新する(削除・非公開の検出と、保存データの鮮度維持のため)
  const stats = { checked: 0, refreshed: 0, pending_unavailable: 0, newly_unavailable: 0, recovered: 0, purged: 0 };
  const refreshIds = own.filter(([, e]) => !e.purged).map(([id]) => id);
  if (mode === "incremental" && refreshIds.length > 0) {
    const details = await client.getVideos(refreshIds);
    stats.checked = refreshIds.length; // 再取得して確認した動画数(変更の有無とは別)
    // 取得結果から漏れた動画は、同じ実行内でもう一度だけ個別に確認する(一時的な取りこぼしの除外)
    const missing = refreshIds.filter((id) => !details.has(id));
    if (missing.length > 0) for (const [id, d] of await client.getVideos(missing)) details.set(id, d);

    for (const [id, old] of own) {
      if (old.purged) continue;
      const detail = details.get(id);
      const gone = !detail || detail.status?.privacyStatus !== "public";

      if (gone) {
        if (old.unavailable_since) {
          // すでに確定済み。一定期間を過ぎたらタイトル等を消去する
          if (daysBetween(old.unavailable_since, today) >= policy.purge_unavailable_days) {
            entries[id] = tombstone(old);
            stats.purged++;
          }
          continue;
        }
        const streak = (old.missing_runs ?? 0) + 1;
        if (streak < policy.unavailable_confirm_runs) {
          // 1回目の「見つからない」では判断を変えない(推薦対象のまま。連続して確認できたときだけ除外する)
          entries[id] = { ...old, missing_runs: streak, last_missing: today };
          stats.pending_unavailable++;
          continue;
        }
        const entry = makeEntry(buildFacts({ title: old.title, publishedAt: old.published_at }, detail, shorts.ids.has(id), channel), channel, today, rules, vocabularyTags, limits, old.first_seen);
        entry.unavailable_since = today;
        entries[id] = entry;
        stats.newly_unavailable++;
        stats.refreshed++;
        continue;
      }

      const facts = buildFacts({ title: old.title, publishedAt: old.published_at }, detail, shorts.ids.has(id), channel);
      const wasGone = Boolean(old.unavailable_since);
      if (JSON.stringify(factsOf(old)) === JSON.stringify(facts)) {
        // 事実データは同じ。以前の「見つからない」記録だけを消す(分類ルールの変更は --reclassify でのみ反映する)
        if (old.missing_runs !== undefined || old.last_missing !== undefined) {
          const { missing_runs, last_missing, ...clean } = old;
          entries[id] = clean;
        }
        continue;
      }
      entries[id] = makeEntry(facts, channel, today, rules, vocabularyTags, limits, old.first_seen);
      stats.refreshed++;
      if (wasGone) stats.recovered++;
    }
    // 安全装置: API側の障害で大量の動画が一度に「使えない」扱いになるのを防ぐ
    const limit = Math.max(5, Math.ceil(own.length * 0.05));
    if (stats.newly_unavailable > limit) {
      throw new Error(`更新の安全装置が作動しました: ${stats.newly_unavailable}件が一度に利用不可と確定しました(上限${limit}件)`);
    }
  }

  // Shorts一覧の状態: 取得できた / 存在しない(Shortsらしい動画なし) / 存在しないがShortsらしい動画がある(要注意)
  let shortsStatus = "ok";
  if (!shorts.available) {
    const merged = [...own.map(([id, e]) => entries[id] ?? e), ...Object.values(entries)];
    const signs = merged.filter(looksLikeShorts).length;
    shortsStatus = signs > 0 ? "absent_with_signs" : "absent_no_signs";
    if (signs > 0) {
      warnings.push(
        `Shorts一覧が存在しませんが、Shortsらしい動画(#shortsタグまたは60秒以下)が${signs}本あります。#shorts付きは除外、60秒以下のタグなしは保留で対処済みですが、YouTube側の仕様を確認してください`
      );
    }
  }

  return {
    entries,
    meta: {
      name: channel.name,
      handle: info.handle,
      title: info.title,
      uploads_playlist_id: info.uploadsPlaylistId,
      shorts_playlist_status: shortsStatus,
    },
    stats: { fetched: refs.length, listing_complete: complete, new: newRefs.length, ...stats },
    warnings,
  };
}

export async function runSync({ mode, client, config, catalog, overrides, rules, vocabularyTags, now = new Date(), today }) {
  const next = structuredClone(catalog);
  next.rules_version = next.rules_version ?? rules.version;
  const limits = config.limits;
  const report = { mode, channels: {}, failures: [], warnings: [] };
  const newIdsByChannel = {};

  for (const channel of config.channels) {
    try {
      const result = await syncChannel({ channel, mode, client, catalog, rules, vocabularyTags, limits, today });
      Object.assign(next.videos, result.entries);
      // last_verified_at: このチャンネルの全動画のメタデータを再取得できた日時(UTC)。規約の30日要件の管理に使う
      next.channels[channel.channel_id] = {
        ...result.meta,
        last_verified: today,
        last_verified_at: now.toISOString(),
      };
      newIdsByChannel[channel.name] = Object.keys(result.entries).filter((id) => !(id in catalog.videos));
      report.channels[channel.name] = { ...result.stats, ok: true };
      report.warnings.push(...result.warnings.map((w) => `${channel.name}: ${w}`));
    } catch (err) {
      report.failures.push({ channel: channel.name, error: err.message });
      report.channels[channel.name] = { ok: false, error: err.message };
    }
  }

  // 新規分の内訳(登録/保留/除外と、除外・保留の理由)を集計する。理由は1本につき1つ(primary)で数える
  const { resolved } = resolveAll(next, overrides, vocabularyTags);
  for (const [name, ids] of Object.entries(newIdsByChannel)) {
    const tally = { registered: 0, held: 0, excluded: 0, by_reason: {}, by_reason_any: {} };
    for (const id of ids) {
      const r = resolved.get(id);
      tally[r.status]++;
      if (r.primary) tally.by_reason[r.primary] = (tally.by_reason[r.primary] ?? 0) + 1;
      for (const reason of new Set(r.reasons)) tally.by_reason_any[reason] = (tally.by_reason_any[reason] ?? 0) + 1;
    }
    Object.assign(report.channels[name], { new_result: tally });
  }
  for (const channel of config.channels) {
    const chState = next.channels[channel.channel_id];
    if (chState && report.channels[channel.name]?.ok) {
      chState.last_stats = { ...report.channels[channel.name] };
      delete chState.last_stats.ok;
      delete chState.last_stats.new_result;
    }
  }

  return { catalog: next, report };
}

// 保存データの鮮度チェック。YouTube API規約(保存から30日以内に再取得か削除)に対し、14日を超えたら警告、
// maxDays(既定14日)を超えたらエラーとする。チャンネルが一度も検証されていない場合もエラー。
export function checkFreshness(catalog, config, today, { warnDays = 10, maxDays = 14 } = {}) {
  const results = [];
  for (const channel of config.channels) {
    const meta = catalog.channels?.[channel.channel_id];
    const last = meta?.last_verified ?? meta?.last_run;
    if (!last) {
      results.push({ channel: channel.name, days: null, level: "error", message: "一度も更新できていません" });
      continue;
    }
    const days = daysBetween(last, today);
    const level = days > maxDays ? "error" : days > warnDays ? "warn" : "ok";
    results.push({ channel: channel.name, days, level, message: `最終更新 ${last}(${days}日前)` });
  }
  return results;
}

// ルール変更後の再分類(API不要)。手動修正(overrides)は resolveEntry で常に優先されるため上書きされない。
export function reclassifyAll({ catalog, overrides, rules, vocabularyTags, limits }) {
  const before = resolveAll(catalog, overrides, vocabularyTags).resolved;
  const next = structuredClone(catalog);
  for (const entry of Object.values(next.videos)) {
    if (entry.purged) continue; // 消去済みの墓標は対象外
    const { judge, classify } = evaluate(factsOf(entry), rules, vocabularyTags, limits);
    entry.judge = judge;
    entry.classify = classify;
  }
  next.rules_version = rules.version;
  const after = resolveAll(next, overrides, vocabularyTags).resolved;

  const changes = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    const sameRecord = JSON.stringify(a.record ?? null) === JSON.stringify(b.record ?? null);
    if (a.status !== b.status || !sameRecord) {
      changes.push({
        id,
        title: next.videos[id].title,
        duration_min: Math.round(next.videos[id].duration_sec / 60),
        from: b.status,
        to: a.status,
        before: b.record ?? { reasons: b.reasons },
        after: a.record ?? { reasons: a.reasons },
        evidence: next.videos[id].classify?.auto?.evidence ?? [],
      });
    }
  }
  return { catalog: next, changes };
}
