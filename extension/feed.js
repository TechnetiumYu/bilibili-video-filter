(() => {
  "use strict";

  const Core = globalThis.BiliFilterCore;
  const SETTINGS_KEY = "biliFilterSettingsV1";
  const PAGE_SIZE = 20;
  const TARGET_INCREMENT = 20;
  const MAX_INSPECTED_PER_RUN = 120;

  const elements = {
    form: document.querySelector("#settingsForm"),
    keywords: document.querySelector("#blockedKeywords"),
    scopeTitle: document.querySelector("#scopeTitle"),
    scopeDescription: document.querySelector("#scopeDescription"),
    scopeTags: document.querySelector("#scopeTags"),
    scopeUploader: document.querySelector("#scopeUploader"),
    minFollowers: document.querySelector("#minFollowers"),
    maxFollowers: document.querySelector("#maxFollowers"),
    minViews: document.querySelector("#minViews"),
    maxViews: document.querySelector("#maxViews"),
    settingsError: document.querySelector("#settingsError"),
    resetButton: document.querySelector("#resetButton"),
    clearCacheButton: document.querySelector("#clearCacheButton"),
    refreshButton: document.querySelector("#refreshButton"),
    loadMoreButton: document.querySelector("#loadMoreButton"),
    sourceBadge: document.querySelector("#sourceBadge"),
    statusText: document.querySelector("#statusText"),
    acceptedCount: document.querySelector("#acceptedCount"),
    rejectedCount: document.querySelector("#rejectedCount"),
    inspectedCount: document.querySelector("#inspectedCount"),
    reasonSummary: document.querySelector("#reasonSummary"),
    videoGrid: document.querySelector("#videoGrid"),
    skeletonGrid: document.querySelector("#skeletonGrid"),
    emptyState: document.querySelector("#emptyState"),
  };

  let settings = Core.normalizeSettings(Core.DEFAULT_SETTINGS);
  const state = {
    batch: 1,
    accepted: [],
    seen: new Set(),
    inspected: 0,
    rejected: 0,
    causes: new Map(),
    loading: false,
    noMore: false,
    runId: 0,
  };

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "扩展后台没有返回有效结果"));
          return;
        }
        resolve(response);
      });
    });
  }

  function storageGet(area, key) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].get(key, result => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result[key]);
      });
    });
  }

  function storageSet(area, value) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].set(value, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  function safeImageUrl(value) {
    const text = String(value || "");
    if (text.startsWith("http://")) return `https://${text.slice(7)}`;
    return text.startsWith("https://") ? text : "";
  }

  function formatCount(value) {
    const number = Number(value) || 0;
    if (number >= 100000000) return `${(number / 100000000).toFixed(number >= 1000000000 ? 0 : 1)}亿`;
    if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
    return new Intl.NumberFormat("zh-CN").format(number);
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${minutes}:${String(rest).padStart(2, "0")}`;
  }

  function setOptionalInput(input, value) {
    input.value = value === null || value === undefined ? "" : String(value);
  }

  function writeSettingsForm(value) {
    elements.keywords.value = value.blockedKeywords.join("\n");
    elements.scopeTitle.checked = value.keywordScopes.title;
    elements.scopeDescription.checked = value.keywordScopes.description;
    elements.scopeTags.checked = value.keywordScopes.tags;
    elements.scopeUploader.checked = value.keywordScopes.uploaderName;
    setOptionalInput(elements.minFollowers, value.minFollowers);
    setOptionalInput(elements.maxFollowers, value.maxFollowers);
    setOptionalInput(elements.minViews, value.minViews);
    setOptionalInput(elements.maxViews, value.maxViews);
  }

  function readSettingsForm() {
    return {
      blockedKeywords: elements.keywords.value.split(/[\n,，]+/).map(value => value.trim()).filter(Boolean),
      keywordScopes: {
        title: elements.scopeTitle.checked,
        description: elements.scopeDescription.checked,
        tags: elements.scopeTags.checked,
        uploaderName: elements.scopeUploader.checked,
      },
      minFollowers: elements.minFollowers.value,
      maxFollowers: elements.maxFollowers.value,
      minViews: elements.minViews.value,
      maxViews: elements.maxViews.value,
    };
  }

  function addCause(reason) {
    const labelByType = {
      keyword: "关键词",
      play_count: "播放量",
      follower_count: "粉丝数",
      unknown_data: "数据无法确认",
    };
    const label = labelByType[reason.type] || "其他";
    state.causes.set(label, (state.causes.get(label) || 0) + 1);
  }

  function updateStats() {
    elements.acceptedCount.textContent = String(state.accepted.length);
    elements.rejectedCount.textContent = String(state.rejected);
    elements.inspectedCount.textContent = String(state.inspected);
    elements.reasonSummary.replaceChildren();
    for (const [label, count] of state.causes) {
      const chip = document.createElement("span");
      chip.textContent = `${label}过滤 ${count}`;
      elements.reasonSummary.append(chip);
    }
    elements.reasonSummary.hidden = state.causes.size === 0;
  }

  function createVideoCard(video) {
    const article = document.createElement("article");
    article.className = "video-card";

    const coverLink = document.createElement("a");
    coverLink.className = "cover-link";
    coverLink.href = video.url;
    coverLink.target = "_blank";
    coverLink.rel = "noreferrer";
    const image = document.createElement("img");
    image.src = safeImageUrl(video.coverUrl);
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    const duration = document.createElement("span");
    duration.className = "duration";
    duration.textContent = formatDuration(video.duration);
    coverLink.append(image, duration);

    const title = document.createElement("a");
    title.className = "video-title";
    title.href = video.url;
    title.target = "_blank";
    title.rel = "noreferrer";
    title.textContent = video.title;

    const meta = document.createElement("div");
    meta.className = "video-meta";
    const avatar = document.createElement("img");
    avatar.className = "avatar";
    avatar.src = safeImageUrl(video.uploaderAvatar);
    avatar.alt = "";
    avatar.loading = "lazy";
    avatar.referrerPolicy = "no-referrer";
    const uploader = document.createElement("span");
    uploader.className = "uploader";
    uploader.textContent = video.uploaderName;
    meta.append(avatar, uploader);

    const stats = document.createElement("div");
    stats.className = "video-stats";
    stats.textContent = `${formatCount(video.playCount)} 播放 · ${formatCount(video.followerCount)} 粉丝`;
    const mark = document.createElement("div");
    mark.className = "pass-mark";
    mark.textContent = "✓ 关键词、粉丝数、播放量均通过";
    article.append(coverLink, title, meta, stats, mark);
    return article;
  }

  function showSkeletons(count = 8) {
    elements.skeletonGrid.replaceChildren();
    for (let index = 0; index < count; index += 1) {
      const card = document.createElement("div");
      card.className = "skeleton-card";
      const cover = document.createElement("div");
      cover.className = "skeleton-cover";
      const line = document.createElement("div");
      line.className = "skeleton-line";
      const short = document.createElement("div");
      short.className = "skeleton-line skeleton-short";
      card.append(cover, line, short);
      elements.skeletonGrid.append(card);
    }
    elements.skeletonGrid.hidden = false;
  }

  function hideSkeletons() {
    elements.skeletonGrid.hidden = true;
    elements.skeletonGrid.replaceChildren();
  }

  function resetFeed() {
    state.runId += 1;
    state.batch = 1;
    state.accepted = [];
    state.seen.clear();
    state.inspected = 0;
    state.rejected = 0;
    state.causes.clear();
    state.noMore = false;
    state.loading = false;
    elements.videoGrid.replaceChildren();
    elements.emptyState.hidden = true;
    updateStats();
  }

  async function enrichAndFilter(candidates, runId) {
    const cheapSurvivors = [];
    for (const video of candidates) {
      state.inspected += 1;
      const result = Core.evaluate(video, settings, {cheapOnly: true});
      if (result.status === "rejected") {
        state.rejected += 1;
        result.reasons.forEach(addCause);
      } else {
        cheapSurvivors.push(video);
      }
    }
    updateStats();
    if (!cheapSurvivors.length || runId !== state.runId) return;

    const needDetails = settings.keywordScopes.description || settings.keywordScopes.tags;
    const detailPromise = needDetails
      ? runtimeMessage({type: "bili-filter-fetch-details", bvids: cheapSurvivors.map(video => video.bvid)})
      : Promise.resolve({details: {}, errors: {}});
    const followerPromise = runtimeMessage({
      type: "bili-filter-fetch-followers",
      mids: cheapSurvivors.map(video => video.uploaderId),
    });
    const [detailResult, followerResult] = await Promise.all([detailPromise, followerPromise]);
    if (runId !== state.runId) return;

    for (const candidate of cheapSurvivors) {
      const detail = detailResult.details?.[candidate.bvid];
      const video = {
        ...candidate,
        description: detail?.description ?? candidate.description ?? "",
        tags: detail?.tags ?? candidate.tags ?? [],
        detailsAvailable: needDetails ? Boolean(detail || candidate.detailsAvailable) : true,
        followerCount: followerResult.counts?.[candidate.uploaderId],
      };
      const result = Core.evaluate(video, settings);
      if (result.status === "accepted") {
        state.accepted.push(video);
        elements.videoGrid.append(createVideoCard(video));
      } else {
        state.rejected += 1;
        result.reasons.forEach(addCause);
      }
    }
    updateStats();
  }

  async function fillFeed(targetCount) {
    if (state.loading || state.noMore) return;
    state.loading = true;
    const runId = state.runId;
    let inspectedThisRun = 0;
    elements.loadMoreButton.disabled = true;
    elements.refreshButton.disabled = true;
    elements.statusText.textContent = "正在检查候选视频，未确认的视频不会显示…";
    showSkeletons();

    try {
      while (state.accepted.length < targetCount && inspectedThisRun < MAX_INSPECTED_PER_RUN && !state.noMore) {
        const response = await runtimeMessage({
          type: "bili-filter-fetch-feed",
          options: {batch: state.batch, pageSize: PAGE_SIZE},
        });
        if (runId !== state.runId) return;
        state.batch += 1;
        state.noMore = Boolean(response.noMore);
        elements.sourceBadge.textContent = response.source === "recommend" ? "个性化推荐候选" : "热门视频候选（兜底）";
        const fresh = (response.items || []).filter(video => {
          if (state.seen.has(video.bvid)) return false;
          state.seen.add(video.bvid);
          return true;
        });
        if (!fresh.length) {
          state.noMore = true;
          break;
        }
        inspectedThisRun += fresh.length;
        await enrichAndFilter(fresh, runId);
      }

      if (runId !== state.runId) return;
      elements.emptyState.hidden = state.accepted.length > 0;
      if (state.accepted.length >= targetCount) {
        elements.statusText.textContent = `已完成筛选；只展示三项条件全部通过的视频。`;
      } else {
        elements.statusText.textContent = `本轮检查了 ${inspectedThisRun} 个候选，当前门槛下通过结果较少。`;
      }
    } catch (error) {
      if (runId !== state.runId) return;
      elements.statusText.textContent = `加载失败：${error.message}`;
      elements.emptyState.hidden = state.accepted.length > 0;
    } finally {
      if (runId === state.runId) {
        state.loading = false;
        hideSkeletons();
        elements.loadMoreButton.disabled = false;
        elements.refreshButton.disabled = false;
      }
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const result = Core.validateSettings(readSettingsForm());
    if (result.errors.length) {
      elements.settingsError.textContent = result.errors.join("；");
      return;
    }
    elements.settingsError.textContent = "";
    settings = result.settings;
    await storageSet("sync", {[SETTINGS_KEY]: settings});
    resetFeed();
    fillFeed(TARGET_INCREMENT);
  }

  elements.form.addEventListener("submit", event => {
    saveSettings(event).catch(error => { elements.settingsError.textContent = error.message; });
  });
  elements.resetButton.addEventListener("click", () => {
    writeSettingsForm(Core.normalizeSettings(Core.DEFAULT_SETTINGS));
    elements.settingsError.textContent = "";
  });
  elements.clearCacheButton.addEventListener("click", async () => {
    elements.clearCacheButton.disabled = true;
    try {
      await runtimeMessage({type: "bili-filter-clear-cache"});
      elements.clearCacheButton.textContent = "缓存已清除";
    } catch (error) {
      elements.clearCacheButton.textContent = `清除失败：${error.message}`;
    } finally {
      setTimeout(() => {
        elements.clearCacheButton.disabled = false;
        elements.clearCacheButton.textContent = "清除粉丝与详情缓存";
      }, 1600);
    }
  });
  elements.refreshButton.addEventListener("click", () => {
    resetFeed();
    fillFeed(TARGET_INCREMENT);
  });
  elements.loadMoreButton.addEventListener("click", () => fillFeed(state.accepted.length + TARGET_INCREMENT));

  async function initialize() {
    const stored = await storageGet("sync", SETTINGS_KEY);
    settings = Core.normalizeSettings(stored || Core.DEFAULT_SETTINGS);
    writeSettingsForm(settings);
    resetFeed();
    await fillFeed(TARGET_INCREMENT);
  }

  initialize().catch(error => {
    hideSkeletons();
    elements.statusText.textContent = `初始化失败：${error.message}`;
    elements.emptyState.hidden = false;
  });
})();
