// 今日のヨガ: 推薦・コース生成のロジック + 2画面(今日のヨガ / 今日のコース)の表示。

const TIME_OPTIONS = [10, 20, 30, 45, 60];
const DEFAULT_MINUTES = 30;
const POOL_SIZE = 5;
const MAX_COURSE_RETRIES = 20; // design.md §6.3: 再抽選は最大20回まで

// design.md §1.3: 前回選択した時間・モードをlocalStorageに保存する(値のみ、個人情報なし)
const STORAGE_KEYS = { lastTime: "bflow.lastTime", lastMode: "bflow.lastMode" };

function loadLastTime() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEYS.lastTime));
    return TIME_OPTIONS.includes(value) ? value : DEFAULT_MINUTES;
  } catch {
    return DEFAULT_MINUTES;
  }
}

function saveLastTime(minutes) {
  try {
    localStorage.setItem(STORAGE_KEYS.lastTime, String(minutes));
  } catch {
    // localStorageが使えない環境(プライベートブラウジング等)では記憶しないだけで機能は継続する
  }
}

function loadLastModeId() {
  try {
    return localStorage.getItem(STORAGE_KEYS.lastMode);
  } catch {
    return null;
  }
}

function saveLastModeId(modeId) {
  try {
    localStorage.setItem(STORAGE_KEYS.lastMode, modeId);
  } catch {
    // 同上
  }
}

// design.md §6.2 スロットテンプレート(目安分数)
// cooldownの max は、そのコースで選べるcooldown動画の長さの上限(分)。長めのcooldownも選べるようにしつつ、
// 短いコースでは従来どおり短いものに限る(30分=従来の最長12分 / 45分=18分 / 60分=固定上限なし)。
// 60分コースは固定の上限を設けず、合計時間の条件(選択時間-5分〜+3分)と各mainの長さの許容幅(目安の±30%)で絞られる。
const COURSE_TEMPLATES = {
  30: [
    { type: "warmup", target: 5 },
    { type: "main", target: 18 },
    { type: "cooldown", target: 7, max: 12 },
  ],
  45: [
    { type: "warmup", target: 8 },
    { type: "main", target: 25 },
    { type: "cooldown", target: 10, max: 18 },
  ],
  60: [
    { type: "warmup", target: 10 },
    { type: "main", target: 22 },
    { type: "main", target: 18 },
    { type: "cooldown", target: 10 },
  ],
};

const state = {
  minutes: loadLastTime(),
  modes: [],
  timeOfDayBonus: {},
  videos: [],
  allPrimaryTags: new Set(), // 全モードのprimary_tagsの和集合(Tier分類用)
  currentMode: null,
  courseModePreferred: true, // 「コースにする/1本にする」トグルの現在値
  currentPool: [], // 単発推薦: [{ video, score }] 上位5件
  shownIds: new Set(), // 単発推薦: 現在のプール内で提案済みのID
  noEquipment: false, // 「道具なし」条件(ONの間、equipment指定のある動画を候補から除外)
};

// Tier分類の対象外(従来どおりスコア+重み付きランダムのみ)
const TIERLESS_MODE_IDS = ["random"];
// Tier1が1件でもあればTier1のみを使う強いゲーティング対象
const STRICT_TIER_MODE_IDS = ["shoulder_neck", "hip_lower"];

// 画面の要素(画面① 今日のヨガ / 画面② 今日のコース)
const topScreen = document.getElementById("top-screen");
const resultScreen = document.getElementById("result-screen");
const timeChips = document.getElementById("time-chips");
const modeGrid = document.getElementById("mode-grid");
const noEquipmentCheckbox = document.getElementById("no-equipment-checkbox");
const generateButton = document.getElementById("generate-button");
const backButton = document.getElementById("back-button");
const kindToggle = document.getElementById("kind-toggle");
const courseFallbackNote = document.getElementById("course-fallback-note");
const resultList = document.getElementById("result-list");
const resultHint = document.getElementById("result-hint");
const noCandidates = document.getElementById("no-candidates");
const retryButton = document.getElementById("retry-button");
const playButton = document.getElementById("play-button");

// --- 共通スコアリング(design.md §5.1) ---

function timeOfDayBonus(tags, now) {
  const hour = now.getHours();
  let bonus = 0;
  for (const period of Object.values(state.timeOfDayBonus)) {
    const [start, end] = period.hours;
    const inRange = end > 24 ? hour >= start || hour < end - 24 : hour >= start && hour < end;
    if (!inRange) continue;
    for (const [tag, points] of Object.entries(period.tags)) {
      if (tags.includes(tag)) {
        bonus += points;
      }
    }
  }
  return bonus;
}

function durationFit(video, minutes) {
  const diff = Math.abs(video.duration_min - minutes);
  return Math.max(3 - diff, 0);
}

// 「道具なし」条件: video.equipmentが未設定・空配列なら道具不要とみなす
function isEquipmentFree(video) {
  return !(video.equipment && video.equipment.length > 0);
}

// state.noEquipmentがOFFなら常にtrue(既存の絞り込み結果に一切影響しない)
function passesEquipmentFilter(video) {
  return !state.noEquipment || isEquipmentFree(video);
}

function getTagScore(video, mode) {
  return video.tags.reduce((sum, tag) => sum + (mode.tag_weights[tag] || 0), 0);
}

function scoreVideo(video, mode, minutes, now) {
  const intensityScore = mode.intensity[String(video.intensity)] ?? 0;
  const tagScore = getTagScore(video, mode);
  const bonus = timeOfDayBonus(video.tags, now);
  const fit = durationFit(video, minutes);
  const jitter = Math.random() * 2;
  return intensityScore + tagScore + bonus + fit + jitter;
}

// スコアに比例した重み付きランダムで1件選ぶ(design.md §5.2)
function weightedPick(scoredList) {
  if (scoredList.length === 0) return null;
  const total = scoredList.reduce((sum, item) => sum + item.score, 0);
  if (total <= 0) {
    return scoredList[Math.floor(Math.random() * scoredList.length)].video;
  }
  let r = Math.random() * total;
  for (const item of scoredList) {
    r -= item.score;
    if (r <= 0) return item.video;
  }
  return scoredList[scoredList.length - 1].video;
}

// 除外IDを取り除いたうえで重み付きランダムに1件選ぶ
function weightedPickExcluding(scoredList, excludeIds) {
  const pool = scoredList.filter((item) => !excludeIds.has(item.video.id));
  return weightedPick(pool);
}

// --- Tier分類(design.md §5.3): 部位が明確なモードで無関係な部位の動画を優先度低下させる ---

// tagScore>0: Tier1(一致)。tagScore=0でも他モードのprimary_tagsに触れていなければTier2(中立な補完)。
// それ以外(別モードの部位に一致)はTier3(別部位の衝突)。
function classifyTier(video, mode) {
  if (getTagScore(video, mode) > 0) return 1;
  const hasConflict = video.tags.some((tag) => state.allPrimaryTags.has(tag));
  return hasConflict ? 3 : 2;
}

function splitByTier(scoredList, mode) {
  const tiers = { 1: [], 2: [], 3: [] };
  for (const item of scoredList) {
    tiers[classifyTier(item.video, mode)].push(item);
  }
  for (const key of [1, 2, 3]) {
    tiers[key].sort((a, b) => b.score - a.score);
  }
  return tiers;
}

// 単発推薦・コースmain枠向け: モード種別に応じてTier1/2/3から候補を選ぶ。
// poolSizeを指定すると件数を上限まで切り詰める(単発推薦の上位5件用)。コース生成ではnullを渡し全件を対象にする。
function selectTierCandidates(scoredList, mode, poolSize) {
  if (TIERLESS_MODE_IDS.includes(mode.id)) {
    const sorted = [...scoredList].sort((a, b) => b.score - a.score);
    return poolSize ? sorted.slice(0, poolSize) : sorted;
  }

  const tiers = splitByTier(scoredList, mode);

  if (STRICT_TIER_MODE_IDS.includes(mode.id)) {
    // Tier1が1件でもあればTier1のみ。0件の場合のみTier2、それも0件ならTier3。
    const chosen = tiers[1].length > 0 ? tiers[1] : tiers[2].length > 0 ? tiers[2] : tiers[3];
    return poolSize ? chosen.slice(0, poolSize) : chosen;
  }

  // ブレンド方式: Tier1を優先し、不足分をTier2、それでも不足すればTier3で補う
  if (poolSize == null) {
    return tiers[1].length + tiers[2].length > 0 ? [...tiers[1], ...tiers[2]] : tiers[3];
  }
  const blended = [...tiers[1]];
  if (blended.length < poolSize) blended.push(...tiers[2].slice(0, poolSize - blended.length));
  if (blended.length < poolSize) blended.push(...tiers[3].slice(0, poolSize - blended.length));
  return blended;
}

// コースのwarmup/cooldown枠向け: モード種別によらず中立な補完(Tier1∪Tier2)を優先し、
// 別部位の動画(Tier3)は両方0件のときの最終手段とする(design.md §6.3)
function selectSupportSlotCandidates(scoredList, mode) {
  if (TIERLESS_MODE_IDS.includes(mode.id)) {
    return scoredList;
  }
  const tiers = splitByTier(scoredList, mode);
  return tiers[1].length + tiers[2].length > 0 ? [...tiers[1], ...tiers[2]] : tiers[3];
}

// --- 単発推薦(design.md §5) ---

function filterCandidates(minutes, mode, tolerance) {
  return state.videos.filter(
    (v) =>
      Math.abs(v.duration_min - minutes) <= tolerance &&
      (mode.intensity[String(v.intensity)] ?? 0) > 0 &&
      passesEquipmentFilter(v)
  );
}

function buildCandidatePool(minutes, mode) {
  const now = new Date();
  const tolerance1 = Math.max(minutes * 0.15, 3);
  let candidates = filterCandidates(minutes, mode, tolerance1);

  if (candidates.length === 0) {
    const tolerance2 = minutes * 0.3;
    candidates = filterCandidates(minutes, mode, tolerance2);
  }

  if (candidates.length === 0) {
    return [];
  }

  const scored = candidates.map((video) => ({ video, score: scoreVideo(video, mode, minutes, now) }));
  return selectTierCandidates(scored, mode, POOL_SIZE);
}

function pickFromPool() {
  let remaining = state.currentPool.filter((item) => !state.shownIds.has(item.video.id));
  if (remaining.length === 0) {
    state.shownIds.clear();
    remaining = state.currentPool;
  }
  const chosen = weightedPick(remaining);
  state.shownIds.add(chosen.id);
  return chosen;
}

// --- コース生成(design.md §6) ---

function getMainCandidates(target, mode, now) {
  return state.videos
    .filter(
      (v) =>
        mode.main_types.includes(v.type) &&
        Math.abs(v.duration_min - target) <= target * 0.3 &&
        (mode.intensity[String(v.intensity)] ?? 0) > 0 &&
        passesEquipmentFilter(v)
    )
    .map((v) => ({ video: v, score: scoreVideo(v, mode, target, now) }));
}

function getWarmupCandidates(target, mode, maxIntensity, now) {
  return state.videos
    .filter(
      (v) =>
        v.type === "warmup" &&
        v.intensity <= maxIntensity &&
        Math.abs(v.duration_min - target) <= 3 &&
        passesEquipmentFilter(v)
    )
    .map((v) => {
      const tagScore = v.tags.reduce((sum, tag) => sum + (mode.tag_weights[tag] || 0), 0);
      const bonus = timeOfDayBonus(v.tags, now);
      const fit = durationFit(v, target);
      const jitter = Math.random() * 2;
      return { video: v, score: 1 + tagScore + bonus + fit + jitter };
    });
}

function getCooldownCandidates(target, mode, now, max = Infinity) {
  return state.videos
    .filter((v) => (v.type === "cooldown" || v.type === "meditation") && v.duration_min <= max && passesEquipmentFilter(v))
    .map((v) => {
      const tagScore = v.tags.reduce((sum, tag) => sum + (mode.tag_weights[tag] || 0), 0);
      const bonus = timeOfDayBonus(v.tags, now);
      const fit = durationFit(v, target);
      const jitter = Math.random() * 2;
      const intensityPriority = v.intensity === 1 ? 5 : 0;
      const relaxBonus = (v.tags.includes("リラックス") ? 3 : 0) + (v.tags.includes("寝る前") ? 3 : 0);
      return { video: v, score: 1 + tagScore + bonus + fit + jitter + intensityPriority + relaxBonus };
    });
}

// 強度の並びが「上がって下がる」山型かどうか(warmup ≦ main ≧ cooldown の一般化)
function isMountainShape(values) {
  const n = values.length;
  let i = 0;
  while (i < n - 1 && values[i] <= values[i + 1]) i++;
  while (i < n - 1 && values[i] >= values[i + 1]) i++;
  return i === n - 1;
}

// スロット構成1回分を組み立てる。埋まらないスロットがあれば null(構造的に不可能)
function attemptCombination(templateSlots, mode) {
  const now = new Date();
  const usedIds = new Set();

  const mainVideos = [];
  for (const slot of templateSlots) {
    if (slot.type !== "main") continue;
    const candidates = getMainCandidates(slot.target, mode, now);
    // main枠はモード種別に応じてTier1(一致)を優先・またはTier1のみに絞る(design.md §5.3・§6.3)
    const tierCandidates = selectTierCandidates(candidates, mode, null);
    const picked = weightedPickExcluding(tierCandidates, usedIds);
    if (!picked) return null;
    usedIds.add(picked.id);
    mainVideos.push(picked);
  }

  let warmupVideo = null;
  const warmupSlot = templateSlots.find((s) => s.type === "warmup");
  if (warmupSlot) {
    const refIntensity = mainVideos.length ? mainVideos[0].intensity : 3;
    const candidates = getWarmupCandidates(warmupSlot.target, mode, refIntensity, now);
    // warmup枠は中立な補完(全身・リラックス等)を許可し、別部位の動画は最終手段とする
    const tierCandidates = selectSupportSlotCandidates(candidates, mode);
    warmupVideo = weightedPickExcluding(tierCandidates, usedIds);
    if (!warmupVideo) return null;
    usedIds.add(warmupVideo.id);
  }

  let cooldownVideo = null;
  const cooldownSlot = templateSlots.find((s) => s.type === "cooldown");
  if (cooldownSlot) {
    const candidates = getCooldownCandidates(cooldownSlot.target, mode, now, cooldownSlot.max);
    // cooldown枠も同様に中立な補完を許可する
    const tierCandidates = selectSupportSlotCandidates(candidates, mode);
    cooldownVideo = weightedPickExcluding(tierCandidates, usedIds);
    if (!cooldownVideo) return null;
    usedIds.add(cooldownVideo.id);
  }

  let mainIndex = 0;
  return templateSlots.map((slot) => {
    if (slot.type === "warmup") return warmupVideo;
    if (slot.type === "cooldown") return cooldownVideo;
    return mainVideos[mainIndex++];
  });
}

function validateCombination(course, minutes) {
  const ids = course.map((v) => v.id);
  if (new Set(ids).size !== ids.length) return false; // 同一動画の重複禁止
  if (!isMountainShape(course.map((v) => v.intensity))) return false; // 山型検査
  const total = course.reduce((sum, v) => sum + v.duration_min, 0);
  return total >= minutes - 5 && total <= minutes + 3; // 合計時間: 選択時間-5分〜+3分
}

// 制約を満たす組み合わせが見つかるまで最大20回再抽選する(design.md §6.3)
function buildCourseForTemplate(templateSlots, mode, minutes) {
  for (let attempt = 0; attempt < MAX_COURSE_RETRIES; attempt++) {
    const course = attemptCombination(templateSlots, mode);
    if (!course) return null; // スロットが構造的に埋まらない → 再抽選しても無意味
    if (validateCombination(course, minutes)) return course;
  }
  return null;
}

// フォールバック段階(design.md §6.3 手順5)
function buildCourse(minutes, mode) {
  const baseTemplate = COURSE_TEMPLATES[minutes];

  let course = buildCourseForTemplate(baseTemplate, mode, minutes);
  if (course) return { videos: course, template: baseTemplate };

  const warmupSlot = baseTemplate.find((s) => s.type === "warmup");
  const cooldownSlot = baseTemplate.find((s) => s.type === "cooldown");
  const mainSlots = baseTemplate.filter((s) => s.type === "main");
  const mergedMainTarget = mainSlots.reduce((sum, s) => sum + s.target, 0);

  if (mainSlots.length > 1) {
    // 60分でmain2が埋まらない場合: mainを1本に統合して3本構成に
    const tier1 = [warmupSlot, { type: "main", target: mergedMainTarget }, cooldownSlot];
    course = buildCourseForTemplate(tier1, mode, minutes);
    if (course) return { videos: course, template: tier1 };
  }

  // warmupが埋まらない場合: mainを長めにして2本構成(main→cooldown)に
  const tier2 = [{ type: "main", target: mergedMainTarget + warmupSlot.target }, cooldownSlot];
  course = buildCourseForTemplate(tier2, mode, minutes);
  if (course) return { videos: course, template: tier2 };

  // 最終手段: 単発提案にフォールバック
  return { videos: null, template: null };
}

function buildRoleLabels(template) {
  const mainCount = template.filter((s) => s.type === "main").length;
  let mainSeen = 0;
  return template.map((slot) => {
    if (slot.type === "warmup") return "ウォームアップ";
    if (slot.type === "cooldown") return "クールダウン";
    mainSeen++;
    return mainCount > 1 ? `メイン${mainSeen}` : "メイン";
  });
}

// --- 画面(UI) ---
// 推薦・コース生成のロジックは上のまま。ここは「今日のヨガ」(条件をえらぶ)と「今日のコース」(結果)の
// 2画面の表示と操作だけを担当する。選定は buildCourse / buildCandidatePool / pickFromPool をそのまま呼ぶ。

const THEME_COLORS = { morning: "#f8e1d1", day: "#dfeaee", night: "#10152a" };

// 配色は時間帯で切り替える(表示のみ。動画の推薦には影響しない)。確認用に ?theme=morning|day|night で固定できる。
function applyTheme() {
  const forced = new URLSearchParams(location.search).get("theme");
  const hour = new Date().getHours();
  const theme = THEME_COLORS[forced] ? forced : hour >= 4 && hour < 10 ? "morning" : hour >= 10 && hour < 17 ? "day" : "night";
  document.body.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[theme];
}

// 目的ごとの補足文(表示専用。ラベル・重みは data/modes.json のまま)
const MODE_COPY = {
  stretch: "全身をやさしく伸ばす",
  active: "筋力・体幹を使う",
  shoulder_neck: "デスクワークのこりに",
  hip_lower: "座り疲れ・脚の重さに",
  relax: "呼吸を深めて休む",
  random: "強度も部位もおまかせ",
};
const CHANNEL_LABELS = { "b-flow": "B-flow", "b-flow-studio": "B-flow Studio" };

const ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/></svg>',
  shuffle:
    '<svg viewBox="0 0 24 24"><path d="M3 7h3.5c2 0 3.2 1 4.3 2.6l2.4 4.8c1.1 1.6 2.3 2.6 4.3 2.6H21M3 17h3.5c1.3 0 2.3-.4 3.1-1.2M21 7h-3.5c-1.3 0-2.3.4-3.1 1.2M18 4l3 3-3 3M18 14l3 3-3 3"/></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const thumbUrl = (id) => `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
// まとめて再生: 非公式の watch_videos エンドポイントを使用(design.md §6.4)。将来無効化される可能性があるが、
// 各動画の個別リンクが常にフォールバックとして機能する。途中の動画から始める場合は、その動画以降のIDだけを渡す。
const playlistUrl = (videos) =>
  videos.length === 1 ? watchUrl(videos[0].id) : `https://www.youtube.com/watch_videos?video_ids=${videos.map((v) => v.id).join(",")}`;
const sumMinutes = (videos) => videos.reduce((sum, v) => sum + v.duration_min, 0);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function iconNode(name) {
  const span = el("span", { class: "ico", "aria-hidden": "true" });
  span.innerHTML = ICONS[name];
  return span;
}

function initUi() {
  const $ = (id) => document.getElementById(id);
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const view = {
    screen: "home",
    modeId: null,
    result: null, // { kind: "course" | "single", videos, roles, fallback } / 候補なしは null
    generated: false,
    start: 0, // 何本目から再生するか(コースの途中から再生する位置)
  };

  // 前回選んだ目的を選択済みにしておく(時間は state.minutes が前回値で初期化済み)
  const lastModeId = loadLastModeId();
  view.modeId = state.modes.some((m) => m.id === lastModeId) ? lastModeId : null;

  document.querySelectorAll("[data-ico]").forEach((node) => {
    node.innerHTML = ICONS[node.dataset.ico];
  });

  // ---------- 画面の切り替え(端末の「戻る」操作で画面①に戻れるようにする) ----------

  function show(name) {
    view.screen = name;
    topScreen.hidden = name !== "home";
    resultScreen.hidden = name !== "result";
    window.scrollTo(0, 0);
    if (name === "home") renderHome();
  }

  window.addEventListener("popstate", (event) => {
    const target = event.state?.screen ?? "home";
    show(target === "result" && !view.generated ? "home" : target);
  });

  // ---------- 画面① 今日のヨガ ----------

  function renderHome() {
    applyTheme();

    // 時間帯による動画の重み付け(modes.json の time_of_day_bonus)が効いている時間帯であることを知らせる
    const hour = new Date().getHours();
    const activeTags = [];
    for (const period of Object.values(state.timeOfDayBonus || {})) {
      const [start, end] = period.hours;
      const inRange = end > 24 ? hour >= start || hour < end - 24 : hour >= start && hour < end;
      if (inRange) activeTags.push(...Object.keys(period.tags));
    }
    $("when").textContent = activeTags.length ? `いまは「${activeTags.join("・")}」向けを優先` : "";

    // 大きな数字は「希望する時間」。実際の動画の合計時間は画面②で別に表示する
    $("hero-min").textContent = String(state.minutes);
    const template = COURSE_TEMPLATES[state.minutes];
    const sub = $("hero-sub");
    if (template) {
      const labels = buildRoleLabels(template);
      sub.replaceChildren(
        "目安 ",
        ...template.flatMap((slot, i) => [i > 0 && el("b", { text: "→" }), el("span", { class: "nw", text: `${labels[i]} ${slot.target}分` })]).filter(Boolean)
      );
    } else {
      sub.textContent = "希望に近い長さの動画を1本、提案します";
    }

    timeChips.replaceChildren(
      ...TIME_OPTIONS.map((minutes) =>
        el("button", {
          type: "button",
          role: "radio",
          "aria-checked": String(minutes === state.minutes),
          "aria-label": `${minutes}分`,
          text: String(minutes),
          onclick: () => {
            state.minutes = minutes;
            saveLastTime(minutes);
            renderHome();
          },
        })
      )
    );

    modeGrid.replaceChildren(
      ...state.modes.map((mode) =>
        el(
          "button",
          {
            type: "button",
            role: "radio",
            "aria-checked": String(mode.id === view.modeId),
            onclick: () => {
              view.modeId = mode.id;
              renderHome();
            },
          },
          el("b", { text: mode.label }),
          MODE_COPY[mode.id] && el("small", { text: MODE_COPY[mode.id] })
        )
      )
    );

    const mode = state.modes.find((m) => m.id === view.modeId);
    generateButton.disabled = !mode;
    generateButton.replaceChildren(...(mode ? [template ? "コースをつくる" : "動画をえらぶ", iconNode("arrow")] : ["目的をえらんでください"]));
  }

  noEquipmentCheckbox.addEventListener("change", () => {
    state.noEquipment = noEquipmentCheckbox.checked;
  });

  generateButton.addEventListener("click", () => {
    const mode = state.modes.find((m) => m.id === view.modeId);
    if (!mode) return;
    state.currentMode = mode;
    saveLastModeId(mode.id);
    state.courseModePreferred = true; // 新しい検索のたびにデフォルトはコース提案(design.md §6.1)
    view.generated = true;
    buildResult();
    history.pushState({ screen: "result" }, "");
    show("result");
  });

  // ---------- 画面② 今日のコース ----------

  // 分岐は従来の renderResult / renderCourse / renderSingle と同じ。選定は既存の関数をそのまま呼ぶ
  function buildResult() {
    const mode = state.currentMode;
    const isCourseEligible = state.minutes >= 30;
    let result = null;
    let fallback = false;

    if (isCourseEligible && state.courseModePreferred) {
      const course = buildCourse(state.minutes, mode);
      if (course.videos) result = { kind: "course", videos: course.videos, roles: buildRoleLabels(course.template), fallback: false };
      else fallback = true; // コースが組めなかった → 単発提案にフォールバック(design.md §6.3 最終手段)
    }
    if (!result) {
      state.currentPool = buildCandidatePool(state.minutes, mode);
      state.shownIds = new Set();
      if (state.currentPool.length > 0) result = { kind: "single", videos: [pickFromPool()], roles: ["今日の1本"], fallback };
    }
    view.result = result;
    view.start = 0;
    renderResult(true);
  }

  retryButton.addEventListener("click", () => {
    const isCourseEligible = state.minutes >= 30;
    if (isCourseEligible && state.courseModePreferred) {
      buildResult();
    } else if (state.currentPool.length > 0) {
      view.result = { ...view.result, videos: [pickFromPool()] };
      view.start = 0;
      renderResult(true);
    }
  });

  backButton.addEventListener("click", () => history.back());

  // animate: 新しい提案のときだけ、上から順に表示する。再生開始位置を選び直すときは動かさない
  function renderResult(animate) {
    const { result } = view;
    const mode = state.currentMode;
    const isCourseEligible = state.minutes >= 30;

    // 画面②の大きな数字は、実際に提案された動画の合計時間(画面①の「希望する時間」とは別)
    $("result-eyebrow").textContent = !result ? "" : result.kind === "course" ? "今日のコース ・ 合計時間" : "今日の1本 ・ 再生時間";
    $("result-total").parentElement.hidden = !result;
    $("result-total").textContent = result ? String(sumMinutes(result.videos)) : "";
    $("result-count").textContent = result && result.kind === "course" ? `${result.videos.length}本` : "";
    $("result-condition").textContent = `希望 ${state.minutes}分 ・ ${mode.label}${state.noEquipment ? " ・ 道具なし" : ""}`;

    // 「コース / 1本」の切り替え(従来の「1本にする / コースにする」と同じ働き。30分以上のみ)
    kindToggle.hidden = !isCourseEligible || !result;
    kindToggle.replaceChildren(
      ...[
        ["course", "コース"],
        ["single", "1本"],
      ].map(([value, label]) =>
        el("button", {
          type: "button",
          role: "radio",
          "aria-checked": String(result?.kind === value),
          text: label,
          onclick: () => {
            const wantCourse = value === "course";
            if (wantCourse === state.courseModePreferred && result?.kind === value) return;
            state.courseModePreferred = wantCourse;
            buildResult();
          },
        })
      )
    );

    courseFallbackNote.hidden = !(result && result.fallback);
    noCandidates.hidden = Boolean(result);
    retryButton.hidden = !result;
    playButton.hidden = !result;
    resultHint.hidden = !result || result.videos.length < 2;

    resultList.className = `list${result?.kind === "single" ? " single" : ""}`;
    resultList.replaceChildren();
    if (!result) return;

    const { videos, roles } = result;
    const single = result.kind === "single";

    videos.forEach((video, i) => {
      const img = el("img", { alt: "", loading: "lazy", src: thumbUrl(video.id) });
      img.onerror = () => img.classList.add("broken");

      // 行をタップ: コースなら「ここから再生」の位置を選ぶ(画面は移動しない)。1本だけの提案ならそのままYouTubeで開く
      const main = el(
        single ? "a" : "button",
        single
          ? { class: "row-main", href: watchUrl(video.id), target: "_blank", rel: "noopener" }
          : {
              class: "row-main",
              type: "button",
              "aria-pressed": String(i === view.start),
              "aria-label": `${roles[i]} ${video.duration_min}分 ${video.title}。ここから再生する`,
              onclick: () => {
                view.start = i;
                renderResult(false);
              },
            },
        el("span", { class: "thumb-wrap" }, img, el("span", { class: "start-badge" }, iconNode("play"))),
        el(
          "span",
          { class: "row-text" },
          !single &&
            el(
              "span",
              { class: "row-head" },
              el("span", { class: "role", text: roles[i] }),
              el("span", { class: "dur" }, String(video.duration_min), el("small", { text: "分" }))
            ),
          el("span", { class: "title", text: video.title }),
          single && el("span", { class: "meta", style: "display:block", text: `${CHANNEL_LABELS[video.channel] || video.channel} ・ ${video.duration_min}分 ・ 強度${video.intensity}` })
        )
      );

      const row = el(
        "li",
        { class: `row${i === view.start ? " is-start" : ""}${i < view.start ? " is-before" : ""}` },
        main,
        // 個別リンク: その動画だけをYouTubeで開く(まとめて再生が動かない環境でのフォールバックも兼ねる)
        !single &&
          el("a", { class: "row-open", href: watchUrl(video.id), target: "_blank", rel: "noopener", "aria-label": `${video.title} だけをYouTubeで開く` }, iconNode("external"))
      );
      resultList.append(row);
      if (!animate || prefersReducedMotion) row.classList.add("in");
      else setTimeout(() => row.classList.add("in"), 60 + i * 130);
    });

    const rest = videos.slice(view.start);
    playButton.href = playlistUrl(rest);
    playButton.textContent =
      videos.length === 1 ? "YouTubeで再生" : view.start === 0 ? "YouTubeでまとめて再生" : rest.length === 1 ? "この1本をYouTubeで再生" : "ここからまとめて再生";
    resultHint.textContent =
      view.start === 0 ? "動画をタップすると、その動画から続けて再生できます。" : `${view.start + 1}本目から再生します(残り 約${sumMinutes(rest)}分)。`;
  }

  history.replaceState({ screen: "home" }, "");
  renderHome();
}

async function init() {
  applyTheme();

  try {
    // no-cache: 月次更新で videos.json が変わっても、ブラウザの古いキャッシュを使い続けないよう毎回サーバーに確認する
    const fresh = { cache: "no-cache" };
    const [modesRes, videosRes] = await Promise.all([fetch("data/modes.json", fresh), fetch("data/videos.json", fresh)]);
    const modesData = await modesRes.json();
    const videosData = await videosRes.json();

    state.modes = modesData.modes;
    state.timeOfDayBonus = modesData.time_of_day_bonus;
    state.videos = videosData.videos;
    state.allPrimaryTags = new Set(state.modes.flatMap((m) => m.primary_tags || []));
  } catch {
    generateButton.textContent = "データを読み込めませんでした";
    return;
  }

  initUi();
}

init();
