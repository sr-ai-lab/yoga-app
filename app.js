// Step 4: manifest.json / localStorageによる前回選択の記憶 / 仕上げ。

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
const COURSE_TEMPLATES = {
  30: [
    { type: "warmup", target: 5 },
    { type: "main", target: 18 },
    { type: "cooldown", target: 7 },
  ],
  45: [
    { type: "warmup", target: 8 },
    { type: "main", target: 25 },
    { type: "cooldown", target: 10 },
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
};

// Tier分類の対象外(従来どおりスコア+重み付きランダムのみ)
const TIERLESS_MODE_IDS = ["random"];
// Tier1が1件でもあればTier1のみを使う強いゲーティング対象
const STRICT_TIER_MODE_IDS = ["shoulder_neck", "hip_lower"];

const topScreen = document.getElementById("top-screen");
const resultScreen = document.getElementById("result-screen");
const timeChips = document.getElementById("time-chips");
const modeGrid = document.getElementById("mode-grid");
const backButton = document.getElementById("back-button");
const resultCondition = document.getElementById("result-condition");

const videoCard = document.getElementById("video-card");
const videoThumb = document.getElementById("video-thumb");
const videoTitle = document.getElementById("video-title");
const videoMeta = document.getElementById("video-meta");
const videoPlay = document.getElementById("video-play");

const courseFallbackNote = document.getElementById("course-fallback-note");
const courseCard = document.getElementById("course-card");
const courseList = document.getElementById("course-list");
const courseTotal = document.getElementById("course-total");

const noCandidates = document.getElementById("no-candidates");
const retryButton = document.getElementById("retry-button");
const toggleCourseButton = document.getElementById("toggle-course-button");
const playAllBar = document.getElementById("play-all-bar");
const playAllButton = document.getElementById("play-all-button");

function renderTimeChips() {
  timeChips.innerHTML = "";
  for (const minutes of TIME_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = `${minutes}分`;
    button.dataset.minutes = String(minutes);
    if (minutes === state.minutes) {
      button.classList.add("selected");
    }
    button.addEventListener("click", () => {
      state.minutes = minutes;
      saveLastTime(minutes);
      renderTimeChips();
    });
    timeChips.appendChild(button);
  }
}

function renderModeGrid() {
  modeGrid.innerHTML = "";
  const lastModeId = loadLastModeId();
  for (const mode of state.modes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-button";
    if (mode.id === lastModeId) {
      button.classList.add("mode-button--last-used");
      const badge = document.createElement("span");
      badge.className = "last-used-badge";
      badge.textContent = "前回";
      button.appendChild(badge);
    }
    button.appendChild(document.createTextNode(mode.label));
    button.addEventListener("click", () => recommend(mode));
    modeGrid.appendChild(button);
  }
}

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
    (v) => Math.abs(v.duration_min - minutes) <= tolerance && (mode.intensity[String(v.intensity)] ?? 0) > 0
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
        (mode.intensity[String(v.intensity)] ?? 0) > 0
    )
    .map((v) => ({ video: v, score: scoreVideo(v, mode, target, now) }));
}

function getWarmupCandidates(target, mode, maxIntensity, now) {
  return state.videos
    .filter((v) => v.type === "warmup" && v.intensity <= maxIntensity && Math.abs(v.duration_min - target) <= 3)
    .map((v) => {
      const tagScore = v.tags.reduce((sum, tag) => sum + (mode.tag_weights[tag] || 0), 0);
      const bonus = timeOfDayBonus(v.tags, now);
      const fit = durationFit(v, target);
      const jitter = Math.random() * 2;
      return { video: v, score: 1 + tagScore + bonus + fit + jitter };
    });
}

function getCooldownCandidates(target, mode, now) {
  return state.videos
    .filter((v) => v.type === "cooldown" || v.type === "meditation")
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
    const candidates = getCooldownCandidates(cooldownSlot.target, mode, now);
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

// --- 画面表示 ---

function recommend(mode) {
  state.currentMode = mode;
  state.courseModePreferred = true; // 新しい検索のたびにデフォルトはコース提案(design.md §6.1)
  saveLastModeId(mode.id);
  resultCondition.textContent = `${state.minutes}分 × ${mode.label}`;
  topScreen.hidden = true;
  resultScreen.hidden = false;
  renderResult();
}

function renderResult() {
  const isCourseEligible = state.minutes >= 30;
  toggleCourseButton.hidden = !isCourseEligible;
  courseFallbackNote.hidden = true;

  if (isCourseEligible && state.courseModePreferred) {
    renderCourse();
  } else {
    renderSingle();
  }

  if (isCourseEligible) {
    toggleCourseButton.textContent = courseCard.hidden ? "コースにする" : "1本にする";
  }
}

function renderSingle() {
  courseCard.hidden = true;
  playAllBar.hidden = true;

  state.currentPool = buildCandidatePool(state.minutes, state.currentMode);
  state.shownIds = new Set();

  if (state.currentPool.length === 0) {
    showNoCandidates();
    return;
  }
  showVideo(pickFromPool());
}

function renderCourse() {
  videoCard.hidden = true;

  const result = buildCourse(state.minutes, state.currentMode);

  if (!result.videos) {
    // コースが組めなかった → 単発提案にフォールバック(design.md §6.3 最終手段)
    renderSingle();
    if (!videoCard.hidden) {
      courseFallbackNote.hidden = false;
    }
    return;
  }

  showCourse(result);
}

function showVideo(video) {
  noCandidates.hidden = true;
  videoCard.hidden = false;
  retryButton.hidden = false;

  videoThumb.classList.remove("broken");
  videoThumb.onerror = () => videoThumb.classList.add("broken");
  videoThumb.src = `https://img.youtube.com/vi/${video.id}/mqdefault.jpg`;
  videoThumb.alt = video.title;

  videoTitle.textContent = video.title;
  videoMeta.textContent = `${video.channel} ・ ${video.duration_min}分 ・ 強度${video.intensity}`;
  videoPlay.href = `https://www.youtube.com/watch?v=${video.id}`;
}

function showCourse({ videos, template }) {
  noCandidates.hidden = true;
  courseCard.hidden = false;
  retryButton.hidden = false;
  playAllBar.hidden = false;

  const roleLabels = buildRoleLabels(template);
  courseList.innerHTML = "";

  videos.forEach((video, index) => {
    const li = document.createElement("li");
    li.className = "course-item";

    const link = document.createElement("a");
    link.className = "course-item-link";
    link.href = `https://www.youtube.com/watch?v=${video.id}`;
    link.target = "_blank";
    link.rel = "noopener";

    const thumb = document.createElement("img");
    thumb.className = "course-thumb";
    thumb.alt = video.title;
    thumb.onerror = () => thumb.classList.add("broken");
    thumb.src = `https://img.youtube.com/vi/${video.id}/mqdefault.jpg`;

    const info = document.createElement("div");
    info.className = "course-item-info";

    const role = document.createElement("p");
    role.className = "course-item-role";
    role.textContent = `${index + 1}. ${roleLabels[index]}`;

    const title = document.createElement("p");
    title.className = "course-item-title";
    title.textContent = `${video.title}(${video.duration_min}分)`;

    info.appendChild(role);
    info.appendChild(title);
    link.appendChild(thumb);
    link.appendChild(info);
    li.appendChild(link);
    courseList.appendChild(li);
  });

  const total = videos.reduce((sum, v) => sum + v.duration_min, 0);
  courseTotal.textContent = `合計 ${total}分`;

  // まとめて再生: 非公式の watch_videos エンドポイントを使用(design.md §6.4)。
  // 将来無効化される可能性があるが、上記の個別動画リンクが常にフォールバックとして機能する。
  const ids = videos.map((v) => v.id).join(",");
  playAllButton.href = `https://www.youtube.com/watch_videos?video_ids=${ids}`;
}

function showNoCandidates() {
  videoCard.hidden = true;
  courseCard.hidden = true;
  playAllBar.hidden = true;
  retryButton.hidden = true;
  noCandidates.hidden = false;
}

function showTopScreen() {
  resultScreen.hidden = true;
  topScreen.hidden = false;
  playAllBar.hidden = true;
}

backButton.addEventListener("click", showTopScreen);

retryButton.addEventListener("click", () => {
  const isCourseEligible = state.minutes >= 30;
  if (isCourseEligible && state.courseModePreferred) {
    renderCourse();
    toggleCourseButton.textContent = courseCard.hidden ? "コースにする" : "1本にする";
  } else if (state.currentPool.length > 0) {
    showVideo(pickFromPool());
  }
});

toggleCourseButton.addEventListener("click", () => {
  state.courseModePreferred = !state.courseModePreferred;
  renderResult();
});

async function init() {
  renderTimeChips();

  const [modesRes, videosRes] = await Promise.all([fetch("data/modes.json"), fetch("data/videos.json")]);
  const modesData = await modesRes.json();
  const videosData = await videosRes.json();

  state.modes = modesData.modes;
  state.timeOfDayBonus = modesData.time_of_day_bonus;
  state.videos = videosData.videos;
  state.allPrimaryTags = new Set(state.modes.flatMap((m) => m.primary_tags || []));

  renderModeGrid();
}

init();
