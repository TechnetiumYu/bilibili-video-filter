(() => {
  "use strict";

  const Core = globalThis.BiliFilterCore;
  const MarkedCore = globalThis.BiliMarkedCore;
  const SETTINGS_KEY = "biliFilterSettingsV2";
  const LEGACY_SETTINGS_KEY = "biliFilterSettingsV1";
  const MARKED_VIDEOS_KEY = "biliFilterMarkedVideosV1";
  const LEGACY_FILTER_CHECKPOINT_KEY = "biliFilterCheckpointV1";
  const PAGE_SIZE = 20;
  const TARGET_INCREMENT = 20;
  const FEED_MAX_INSPECTED_PER_RUN = 120;
  const SEARCH_MAX_INSPECTED_PER_RUN = 60;
  const ENRICH_BATCH_SIZE = 8;

  const elements = {
    searchForm: document.querySelector("#searchForm"),
    searchInput: document.querySelector("#searchInput"),
    searchSubmit: document.querySelector("#searchForm button[type='submit']"),
    searchClearButton: document.querySelector("#searchClearButton"),
    markedLibraryButton: document.querySelector("#markedLibraryButton"),
    markedCount: document.querySelector("#markedCount"),
    markedDialog: document.querySelector("#markedDialog"),
    closeMarkedDialog: document.querySelector("#closeMarkedDialog"),
    markedSummary: document.querySelector("#markedSummary"),
    markedActionStatus: document.querySelector("#markedActionStatus"),
    markedVideoList: document.querySelector("#markedVideoList"),
    markedEmpty: document.querySelector("#markedEmpty"),
    copyMarkedButton: document.querySelector("#copyMarkedButton"),
    exportMarkedButton: document.querySelector("#exportMarkedButton"),
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
    topicPolicyList: document.querySelector("#topicPolicyList"),
    topicEmptyHint: document.querySelector("#topicEmptyHint"),
    addTopicButton: document.querySelector("#addTopicButton"),
    semanticEnabled: document.querySelector("#semanticEnabled"),
    classifierEndpoint: document.querySelector("#classifierEndpoint"),
    classifierModel: document.querySelector("#classifierModel"),
    settingsError: document.querySelector("#settingsError"),
    resetButton: document.querySelector("#resetButton"),
    clearCacheButton: document.querySelector("#clearCacheButton"),
    refreshButton: document.querySelector("#refreshButton"),
    loadMoreButton: document.querySelector("#loadMoreButton"),
    sourceBadge: document.querySelector("#sourceBadge"),
    feedEyebrow: document.querySelector("#feedEyebrow"),
    feedTitle: document.querySelector("#feedTitle"),
    statusText: document.querySelector("#statusText"),
    acceptedCount: document.querySelector("#acceptedCount"),
    rejectedCount: document.querySelector("#rejectedCount"),
    inspectedCount: document.querySelector("#inspectedCount"),
    reasonSummary: document.querySelector("#reasonSummary"),
    videoGrid: document.querySelector("#videoGrid"),
    skeletonGrid: document.querySelector("#skeletonGrid"),
    emptyState: document.querySelector("#emptyState"),
    emptyTitle: document.querySelector("#emptyTitle"),
    emptyMessage: document.querySelector("#emptyMessage"),
  };

  let settings = Core.normalizeSettings(Core.DEFAULT_SETTINGS);
  let markedVideos = {};
  const state = {
    mode: "feed",
    query: "",
    total: null,
    batch: 1,
    accepted: [],
    seen: new Set(),
    inspected: 0,
    rejected: 0,
    causes: new Map(),
    loading: false,
    noMore: false,
    runId: 0,
    pendingCandidates: [],
    requestStopped: false,
    initialized: false,
    autoLoadVisible: false,
    autoLoadTimer: null,
  };

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          const error = new Error(response?.error || "扩展后台没有返回有效结果");
          error.status = Number(response?.status) || 0;
          error.endpoint = String(response?.endpoint || "");
          error.retryAfterMs = Math.max(0, Number(response?.retryAfterMs) || 0);
          error.biliRateLimited = Boolean(response?.biliRateLimited);
          reject(error);
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

  function storageRemove(area, key) {
    return new Promise((resolve, reject) => {
      chrome.storage[area].remove(key, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  async function persistMarkedVideos() {
    markedVideos = MarkedCore.normalizeCollection(markedVideos);
    await storageSet("local", {[MARKED_VIDEOS_KEY]: markedVideos});
    updateMarkedCount();
  }

  function updateMarkedCount() {
    elements.markedCount.textContent = String(Object.keys(markedVideos).length);
    document.querySelectorAll(".mark-video-button[data-bvid]").forEach(button => {
      const saved = Boolean(markedVideos[button.dataset.bvid]);
      button.disabled = saved;
      button.textContent = saved ? "✓ 已标记" : "标记待分析";
    });
  }

  function discussionExport() {
    return MarkedCore.buildDiscussionExport(markedVideos, settings);
  }

  function formatDateTime(value) {
    const time = Number(value);
    if (!Number.isFinite(time)) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(new Date(time));
  }

  function policyName(topicId, snapshot) {
    return snapshot.classification?.appliedPolicies?.find(policy => policy.id === topicId)?.name
      || settings.topicPolicies.find(policy => policy.id === topicId)?.name
      || topicId;
  }

  function renderMarkedItem(snapshot) {
    const item = document.createElement("article");
    item.className = "marked-item";

    const cover = document.createElement("a");
    cover.className = "marked-cover";
    cover.href = snapshot.url;
    cover.target = "_blank";
    cover.rel = "noreferrer";
    const image = document.createElement("img");
    image.src = safeImageUrl(snapshot.coverUrl);
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    cover.append(image);

    const main = document.createElement("div");
    main.className = "marked-item-main";
    const heading = document.createElement("div");
    heading.className = "marked-item-heading";
    const title = document.createElement("a");
    title.className = "marked-item-title";
    title.href = snapshot.url;
    title.target = "_blank";
    title.rel = "noreferrer";
    title.textContent = snapshot.title || snapshot.bvid;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "marked-remove";
    remove.textContent = "删除标记";
    remove.addEventListener("click", async () => {
      if (!confirm(`确定删除“${snapshot.title || snapshot.bvid}”的分析标记吗？`)) return;
      delete markedVideos[snapshot.bvid];
      await persistMarkedVideos();
      renderMarkedLibrary();
    });
    heading.append(title, remove);

    const meta = document.createElement("p");
    meta.className = "marked-item-meta";
    const category = snapshot.category?.name || "分区未确认";
    meta.textContent = `${category} · ${formatCount(snapshot.metrics?.playCount)} 播放 · ${formatCount(snapshot.uploader?.followerCount)} 粉丝 · 标记于 ${formatDateTime(snapshot.markedAt)}`;

    const chips = document.createElement("div");
    chips.className = "marked-chip-row";
    for (const match of snapshot.classification?.topicMatches || []) {
      const chip = document.createElement("span");
      chip.className = "topic-chip";
      chip.textContent = `${policyName(match.id, snapshot)} ${(Number(match.confidence) * 100).toFixed(0)}%`;
      chips.append(chip);
    }
    for (const tag of (snapshot.tags || []).slice(0, 10)) {
      const chip = document.createElement("span");
      chip.textContent = `#${tag}`;
      chips.append(chip);
    }

    const note = document.createElement("textarea");
    note.className = "marked-note";
    note.maxLength = 1000;
    note.placeholder = "可选备注：为什么标记、希望过滤还是保留、你认为属于什么话题……";
    note.value = snapshot.note || "";
    note.addEventListener("change", async () => {
      const current = markedVideos[snapshot.bvid];
      if (!current) return;
      current.note = note.value.trim().slice(0, 1000);
      current.updatedAt = Date.now();
      await persistMarkedVideos();
      elements.markedActionStatus.textContent = `已保存“${snapshot.title || snapshot.bvid}”的备注`;
    });

    main.append(heading, meta);
    if (chips.childElementCount) main.append(chips);
    main.append(note);
    item.append(cover, main);
    return item;
  }

  function renderMarkedLibrary() {
    const videos = MarkedCore.sortedVideos(markedVideos);
    elements.markedVideoList.replaceChildren(...videos.map(renderMarkedItem));
    elements.markedEmpty.hidden = videos.length > 0;
    elements.markedVideoList.hidden = videos.length === 0;
    elements.copyMarkedButton.disabled = videos.length === 0;
    elements.exportMarkedButton.disabled = videos.length === 0;
    const summary = discussionExport().summary;
    const categoryText = summary.categories.slice(0, 3).map(item => `${item.name} ${item.count}`).join("、") || "暂无";
    const tagText = summary.tags.slice(0, 5).map(item => `${item.name} ${item.count}`).join("、") || "暂无";
    elements.markedSummary.textContent = `共 ${videos.length} 个样本 · 主要分区：${categoryText} · 常见标签：${tagText}`;
    updateMarkedCount();
  }

  async function markVideo(video, button) {
    if (markedVideos[video.bvid]) return;
    if (Object.keys(markedVideos).length >= MarkedCore.MAX_MARKED_VIDEOS) {
      throw new Error(`标记库已达到 ${MarkedCore.MAX_MARKED_VIDEOS} 个上限，请先导出并删除部分样本`);
    }
    const snapshot = MarkedCore.createSnapshot(video, {
      sourceMode: state.mode,
      sourceQuery: state.query,
      effectiveThresholds: video.effectiveThresholds,
      appliedTopicPolicies: video.appliedTopicPolicies,
    });
    if (!snapshot.bvid) throw new Error("视频缺少 BV 号，无法标记");
    markedVideos[snapshot.bvid] = snapshot;
    await persistMarkedVideos();
    button.disabled = true;
    button.textContent = "✓ 已标记";
    elements.markedActionStatus.textContent = `已标记“${snapshot.title || snapshot.bvid}”`;
  }

  async function copyDiscussionData() {
    const content = JSON.stringify(discussionExport(), null, 2);
    await navigator.clipboard.writeText(content);
    elements.markedActionStatus.textContent = `已复制 ${Object.keys(markedVideos).length} 个视频的讨论数据，可直接粘贴给我`;
  }

  function exportDiscussionData() {
    const content = JSON.stringify(discussionExport(), null, 2);
    const blob = new Blob([content], {type: "application/json;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `bilibili-filter-marked-${date}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    elements.markedActionStatus.textContent = "讨论数据 JSON 已导出，可在后续对话中上传给我";
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

  function formatPublishTime(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return "发布时间未知";
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return "发布时间未知";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `发布时间：${year}-${month}-${day}`;
  }

  function setOptionalInput(input, value) {
    input.value = value === null || value === undefined ? "" : String(value);
  }

  function createTopicId() {
    return typeof crypto.randomUUID === "function"
      ? `topic-${crypto.randomUUID()}`
      : `topic-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function createTopicPolicyRow(policy = {}) {
    const row = document.createElement("section");
    row.className = "topic-policy";
    row.dataset.topicId = policy.id || createTopicId();

    const header = document.createElement("div");
    header.className = "topic-policy-header";
    const enabledLabel = document.createElement("label");
    enabledLabel.className = "topic-enabled";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "topic-enabled-input";
    enabled.checked = policy.enabled !== false;
    const enabledText = document.createElement("span");
    enabledText.textContent = "启用";
    enabledLabel.append(enabled, enabledText);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "topic-remove";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      row.remove();
      elements.topicEmptyHint.hidden = elements.topicPolicyList.childElementCount > 0;
    });
    header.append(enabledLabel, remove);

    const nameLabel = document.createElement("label");
    nameLabel.className = "compact-field topic-name";
    const nameText = document.createElement("span");
    nameText.textContent = "话题名称";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "topic-name-input";
    name.maxLength = 40;
    name.placeholder = "例如：华为";
    name.value = policy.name || "";
    nameLabel.append(nameText, name);

    const thresholdGrid = document.createElement("div");
    thresholdGrid.className = "topic-threshold-grid";
    const definitions = [
      ["最低播放量", "topic-min-views", policy.minViews, "例如 200000", "1"],
      ["最低粉丝数", "topic-min-followers", policy.minFollowers, "例如 100000", "1"],
      ["置信度", "topic-confidence", policy.confidenceGte ?? 0.75, "0.75", "0.05"],
    ];
    definitions.forEach(([labelText, className, value, placeholder, step]) => {
      const label = document.createElement("label");
      label.className = "compact-field";
      const span = document.createElement("span");
      span.textContent = labelText;
      const input = document.createElement("input");
      input.type = "number";
      input.className = className;
      input.min = "0";
      input.step = step;
      if (className === "topic-confidence") input.max = "1";
      input.placeholder = placeholder;
      setOptionalInput(input, value);
      label.append(span, input);
      thresholdGrid.append(label);
    });

    const aliasesLabel = document.createElement("label");
    aliasesLabel.className = "compact-field topic-aliases";
    const aliasesText = document.createElement("span");
    aliasesText.textContent = "补充关联词（可选，逗号分隔）";
    const aliases = document.createElement("input");
    aliases.type = "text";
    aliases.className = "topic-aliases-input";
    aliases.placeholder = "模型关闭时也可确定性命中，例如 HarmonyOS, 鸿蒙";
    aliases.value = (policy.aliases || []).join(", ");
    aliasesLabel.append(aliasesText, aliases);

    row.append(header, nameLabel, thresholdGrid, aliasesLabel);
    return row;
  }

  function writeTopicPolicies(policies) {
    elements.topicPolicyList.replaceChildren(...(policies || []).map(createTopicPolicyRow));
    elements.topicEmptyHint.hidden = elements.topicPolicyList.childElementCount > 0;
  }

  function readTopicPolicies() {
    return [...elements.topicPolicyList.querySelectorAll(".topic-policy")].map(row => ({
      id: row.dataset.topicId,
      name: row.querySelector(".topic-name-input").value,
      enabled: row.querySelector(".topic-enabled-input").checked,
      aliases: row.querySelector(".topic-aliases-input").value.split(/[,，\n]+/).map(value => value.trim()).filter(Boolean),
      minViews: row.querySelector(".topic-min-views").value,
      minFollowers: row.querySelector(".topic-min-followers").value,
      confidenceGte: row.querySelector(".topic-confidence").value,
    }));
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
    writeTopicPolicies(value.topicPolicies);
    elements.semanticEnabled.checked = value.topicClassifier.semanticEnabled;
    elements.classifierEndpoint.value = value.topicClassifier.endpoint;
    elements.classifierModel.value = value.topicClassifier.model;
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
      topicPolicies: readTopicPolicies(),
      topicClassifier: {
        semanticEnabled: elements.semanticEnabled.checked,
        endpoint: elements.classifierEndpoint.value,
        model: elements.classifierModel.value,
        timeoutMs: settings.topicClassifier.timeoutMs,
      },
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

  function updateModeUi() {
    const searching = state.mode === "search";
    elements.feedEyebrow.textContent = searching ? "FILTERED SEARCH" : "CLEAN FEED";
    elements.feedTitle.textContent = searching ? `搜索：${state.query}` : "为你筛选";
    elements.searchClearButton.hidden = !searching;
    elements.refreshButton.textContent = searching ? "重新搜索" : "换一批";
    elements.loadMoreButton.textContent = searching ? "自动加载更多搜索结果" : "自动加载更多视频";
    elements.emptyTitle.textContent = searching ? "没有符合门槛的搜索结果" : "暂时没有足够的通过结果";
    elements.emptyMessage.textContent = searching
      ? "搜索候选已完成检查。可以尝试其他搜索词，或适当放宽过滤门槛。"
      : "过滤器已经检查了本轮候选。可以放宽门槛，或稍后换一批。";
    elements.sourceBadge.textContent = searching ? `正在搜索“${state.query}”` : "正在连接 B站";
  }

  function completedFilterMessage(searching) {
    const hasTopics = settings.topicPolicies.some(policy => policy.enabled && policy.name);
    const scope = hasTopics ? "全局条件及命中的特殊话题门槛" : "关键词、粉丝数和播放量三项条件";
    return searching
      ? `“${state.query}”的搜索结果已过滤；只展示通过${scope}的视频，向下滚动会继续加载。`
      : `已完成当前批次；只展示通过${scope}的视频，向下滚动会继续加载。`;
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
    const publishTime = document.createElement("div");
    publishTime.className = "video-publish-time";
    const topics = document.createElement("div");
    topics.className = "topic-badges";
    for (const policy of video.appliedTopicPolicies || []) {
      const badge = document.createElement("span");
      badge.textContent = `特殊话题：${policy.name}`;
      topics.append(badge);
    }
    publishTime.textContent = formatPublishTime(video.publishTime);
    const cardActions = document.createElement("div");
    cardActions.className = "card-actions";
    const markButton = document.createElement("button");
    markButton.type = "button";
    markButton.className = "mark-video-button";
    markButton.dataset.bvid = video.bvid;
    markButton.disabled = Boolean(markedVideos[video.bvid]);
    markButton.textContent = markButton.disabled ? "✓ 已标记" : "标记待分析";
    markButton.addEventListener("click", () => {
      markVideo(video, markButton).catch(error => {
        markButton.disabled = false;
        markButton.textContent = "标记失败";
        elements.statusText.textContent = `标记失败：${error.message}`;
      });
    });
    cardActions.append(publishTime, markButton);
    article.append(coverLink, title, meta, stats);
    if (topics.childElementCount) article.append(topics);
    article.append(cardActions);
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

  function resetFeed(options = {}) {
    if (options.clearCheckpoint !== false) storageRemove("local", LEGACY_FILTER_CHECKPOINT_KEY).catch(() => undefined);
    if (state.autoLoadTimer) clearTimeout(state.autoLoadTimer);
    state.runId += 1;
    state.batch = 1;
    state.accepted = [];
    state.seen.clear();
    state.inspected = 0;
    state.rejected = 0;
    state.causes.clear();
    state.noMore = false;
    state.total = null;
    state.loading = false;
    state.pendingCandidates = [];
    state.requestStopped = false;
    state.autoLoadTimer = null;
    elements.videoGrid.replaceChildren();
    elements.emptyState.hidden = true;
    updateModeUi();
    updateStats();
  }

  function stopForRateLimit(rateLimit) {
    const endpoint = rateLimit?.endpoint || "B站接口";
    state.pendingCandidates = [];
    state.noMore = true;
    state.requestStopped = true;
    elements.statusText.textContent = `${endpoint}返回 HTTP 412；本地冷却已关闭，本轮已停止。可点击“${state.mode === "search" ? "重新搜索" : "换一批"}”立即重试。`;
    storageRemove("local", LEGACY_FILTER_CHECKPOINT_KEY).catch(() => undefined);
  }

  function recordFinalDecision(video, result) {
    if (result.status === "accepted") {
      video.appliedTopicPolicies = result.effectiveThresholds.matchedPolicies;
      video.effectiveThresholds = {
        minViews: result.effectiveThresholds.minViews,
        maxViews: result.effectiveThresholds.maxViews,
        minFollowers: result.effectiveThresholds.minFollowers,
        maxFollowers: result.effectiveThresholds.maxFollowers,
      };
      state.accepted.push(video);
      elements.videoGrid.append(createVideoCard(video));
    } else {
      state.rejected += 1;
      result.reasons.forEach(addCause);
    }
  }

  function rateLimitResult(response, fallbackEndpoint) {
    return {
      endpoint: response?.rateLimitEndpoint || fallbackEndpoint,
      retryAfterMs: Math.max(1000, Number(response?.retryAfterMs) || 30000),
    };
  }

  async function enrichAndFilterFast(candidates, runId) {
    const cheapSurvivors = [];
    for (const video of candidates) {
      if (video.__cheapChecked) {
        cheapSurvivors.push(video);
        continue;
      }
      state.inspected += 1;
      const result = Core.evaluate(video, settings, {cheapOnly: true});
      if (result.status === "rejected") {
        state.rejected += 1;
        result.reasons.forEach(addCause);
      } else {
        cheapSurvivors.push({...video, __cheapChecked: true});
      }
    }
    updateStats();
    if (!cheapSurvivors.length || runId !== state.runId) return {pending: []};

    const activeTopicPolicies = settings.topicPolicies.filter(policy => policy.enabled && policy.name);
    const needDetails = settings.keywordScopes.description || settings.keywordScopes.tags || activeTopicPolicies.length > 0;
    const detailPromise = needDetails
      ? runtimeMessage({
          type: "bili-filter-fetch-details",
          bvids: cheapSurvivors.map(video => video.bvid),
          requestProfile: "feed-fast",
        })
      : Promise.resolve({details: {}, errors: {}, rateLimited: false});
    const followerPromise = runtimeMessage({
      type: "bili-filter-fetch-followers",
      mids: cheapSurvivors.map(video => video.uploaderId),
      requestProfile: "feed-fast",
    });
    const [detailResult, followerResult] = await Promise.all([detailPromise, followerPromise]);
    if (runId !== state.runId) return {pending: []};
    if (detailResult.rateLimited || followerResult.rateLimited) {
      const limited = detailResult.rateLimited ? detailResult : followerResult;
      return {
        pending: cheapSurvivors,
        rateLimit: rateLimitResult(limited, detailResult.rateLimited ? "视频详情接口" : "粉丝数接口"),
      };
    }

    const enrichedCandidates = cheapSurvivors.map(candidate => {
      const detail = detailResult.details?.[candidate.bvid];
      return {
        ...candidate,
        description: detail?.description ?? candidate.description ?? "",
        tags: detail?.tags ?? candidate.tags ?? [],
        categoryId: detail?.categoryId ?? candidate.categoryId ?? "",
        categoryName: detail?.categoryName ?? candidate.categoryName ?? "",
        coverText: Array.isArray(candidate.coverText) ? candidate.coverText : [],
        followerCount: followerResult.counts?.[candidate.uploaderId],
        detailsAvailable: needDetails ? Boolean(detail || candidate.detailsAvailable) : true,
      };
    });

    let topicResult = {results: enrichedCandidates.map(video => ({id: video.bvid, topics: []})), mode: "none"};
    let topicClassificationAvailable = true;
    if (activeTopicPolicies.length) {
      try {
        topicResult = await runtimeMessage({
          type: "bili-filter-classify-topics",
          options: {videos: enrichedCandidates, policies: activeTopicPolicies, classifier: settings.topicClassifier},
        });
      } catch (error) {
        topicClassificationAvailable = false;
        console.warn("特殊话题分类失败，候选将严格不放行：", error);
      }
    }
    if (runId !== state.runId) return {pending: []};
    const topicByVideo = new Map((topicResult.results || []).map(result => [result.id, result]));
    for (const candidate of enrichedCandidates) {
      const classification = topicByVideo.get(candidate.bvid) || {topics: []};
      const video = {
        ...candidate,
        topicMatches: classification.topics || [],
        topicClassificationAvailable,
        topicClassifierMode: topicResult.mode || "none",
        topicClassifiedAt: classification.classifiedAt,
        topicCacheExpiresAt: classification.cacheExpiresAt,
      };
      recordFinalDecision(video, Core.evaluate(video, settings));
    }
    updateStats();
    return {pending: []};
  }

  async function enrichAndFilterSafe(candidates, runId) {
    const cheapSurvivors = [];
    for (const video of candidates) {
      if (video.__cheapChecked) {
        cheapSurvivors.push(video);
        continue;
      }
      state.inspected += 1;
      const result = Core.evaluate(video, settings, {cheapOnly: true});
      if (result.status === "rejected") {
        state.rejected += 1;
        result.reasons.forEach(addCause);
      } else {
        cheapSurvivors.push({...video, __cheapChecked: true});
      }
    }
    updateStats();
    if (!cheapSurvivors.length || runId !== state.runId) return {pending: []};

    const activeTopicPolicies = settings.topicPolicies.filter(policy => policy.enabled && policy.name);
    const needDetails = settings.keywordScopes.description || settings.keywordScopes.tags || activeTopicPolicies.length > 0;
    for (let offset = 0; offset < cheapSurvivors.length; offset += ENRICH_BATCH_SIZE) {
      const group = cheapSurvivors.slice(offset, offset + ENRICH_BATCH_SIZE);
      const remaining = cheapSurvivors.slice(offset + ENRICH_BATCH_SIZE);
      const missingDetailCandidates = needDetails ? group.filter(video => video.detailsAvailable !== true) : [];
      const detailResult = missingDetailCandidates.length
        ? await runtimeMessage({type: "bili-filter-fetch-details", bvids: missingDetailCandidates.map(video => video.bvid), requestProfile: "search-safe"})
        : {details: {}, errors: {}, rateLimited: false};
      if (runId !== state.runId) return {pending: []};
      if (detailResult.rateLimited) {
        return {pending: [...group, ...remaining], rateLimit: rateLimitResult(detailResult, "视频详情接口")};
      }

      const enrichedCandidates = [];
      for (const candidate of group) {
        const detail = detailResult.details?.[candidate.bvid];
        const video = {
          ...candidate,
          description: detail?.description ?? candidate.description ?? "",
          tags: detail?.tags ?? candidate.tags ?? [],
          categoryId: detail?.categoryId ?? candidate.categoryId ?? "",
          categoryName: detail?.categoryName ?? candidate.categoryName ?? "",
          coverText: Array.isArray(candidate.coverText) ? candidate.coverText : [],
          detailsAvailable: needDetails ? Boolean(detail || candidate.detailsAvailable) : true,
        };
        if (needDetails && !video.detailsAvailable) {
          recordFinalDecision(video, Core.evaluate({...video, topicClassificationAvailable: false}, settings));
        } else {
          enrichedCandidates.push(video);
        }
      }
      if (!enrichedCandidates.length) {
        updateStats();
        continue;
      }

      let topicResult = {results: enrichedCandidates.map(video => ({id: video.bvid, topics: []})), mode: "none"};
      if (activeTopicPolicies.length) {
        try {
          topicResult = await runtimeMessage({
            type: "bili-filter-classify-topics",
            options: {videos: enrichedCandidates, policies: activeTopicPolicies, classifier: settings.topicClassifier},
          });
        } catch (error) {
          console.warn("特殊话题分类失败，候选将严格不放行：", error);
          for (const video of enrichedCandidates) {
            recordFinalDecision({...video, topicClassificationAvailable: false}, Core.evaluate({
              ...video,
              topicClassificationAvailable: false,
            }, settings));
          }
          updateStats();
          continue;
        }
      }
      if (runId !== state.runId) return {pending: []};

      const topicByVideo = new Map((topicResult.results || []).map(result => [result.id, result]));
      const followerCandidates = [];
      for (const candidate of enrichedCandidates) {
        const classification = topicByVideo.get(candidate.bvid) || {topics: []};
        const video = {
          ...candidate,
          topicMatches: classification.topics || [],
          topicClassificationAvailable: true,
          topicClassifierMode: topicResult.mode || "none",
          topicClassifiedAt: classification.classifiedAt,
          topicCacheExpiresAt: classification.cacheExpiresAt,
        };
        const preFollower = Core.evaluate(video, settings, {cheapOnly: true});
        if (preFollower.status === "rejected") recordFinalDecision(video, preFollower);
        else followerCandidates.push(video);
      }
      if (!followerCandidates.length) {
        updateStats();
        continue;
      }

      const followerResult = await runtimeMessage({
        type: "bili-filter-fetch-followers",
        mids: followerCandidates.map(video => video.uploaderId),
        requestProfile: "search-safe",
      });
      if (runId !== state.runId) return {pending: []};
      const pendingFollowers = [];
      for (const candidate of followerCandidates) {
        const followerCount = followerResult.counts?.[candidate.uploaderId];
        if (followerResult.rateLimited && !Number.isFinite(Number(followerCount))) {
          pendingFollowers.push(candidate);
          continue;
        }
        const video = {...candidate, followerCount};
        recordFinalDecision(video, Core.evaluate(video, settings));
      }
      updateStats();
      if (followerResult.rateLimited) {
        return {
          pending: [...pendingFollowers, ...remaining],
          rateLimit: rateLimitResult(followerResult, "粉丝数接口"),
        };
      }
    }
    updateStats();
    return {pending: []};
  }

  function enrichAndFilter(candidates, runId) {
    return state.mode === "feed" ? enrichAndFilterFast(candidates, runId) : enrichAndFilterSafe(candidates, runId);
  }

  async function fillFeed(targetCount) {
    if (state.loading || (state.noMore && !state.pendingCandidates.length)) return;
    state.loading = true;
    const runId = state.runId;
    const acceptedAtStart = state.accepted.length;
    let inspectedThisRun = 0;
    const maxInspectedThisRun = state.mode === "feed" ? FEED_MAX_INSPECTED_PER_RUN : SEARCH_MAX_INSPECTED_PER_RUN;
    elements.loadMoreButton.disabled = true;
    elements.refreshButton.disabled = true;
    elements.searchSubmit.disabled = true;
    elements.statusText.textContent = state.mode === "search"
      ? `正在搜索“${state.query}”并检查候选，未通过的视频不会显示…`
      : "正在检查候选视频，未确认的视频不会显示…";
    showSkeletons();

    try {
      while (state.accepted.length < targetCount && inspectedThisRun < maxInspectedThisRun && (state.pendingCandidates.length || !state.noMore)) {
        if (state.pendingCandidates.length) {
          const pending = state.pendingCandidates;
          state.pendingCandidates = [];
          const pendingResult = await enrichAndFilter(pending, runId);
          if (pendingResult?.rateLimit) {
            stopForRateLimit(pendingResult.rateLimit);
            break;
          }
          continue;
        }
        const response = state.mode === "search"
          ? await runtimeMessage({
              type: "bili-filter-search",
              options: {query: state.query, page: state.batch, pageSize: PAGE_SIZE},
            })
          : await runtimeMessage({
              type: "bili-filter-fetch-feed",
              options: {batch: state.batch, pageSize: PAGE_SIZE, requestProfile: "feed-fast"},
            });
        if (runId !== state.runId) return;
        state.batch += 1;
        state.noMore = Boolean(response.noMore);
        state.total = Number.isFinite(Number(response.total)) ? Number(response.total) : state.total;
        const cacheLabel = response.cacheMode === "fresh" ? " · 本地缓存" : response.cacheMode === "stale" ? " · 风控缓存" : "";
        elements.sourceBadge.textContent = response.source === "search"
          ? `搜索候选${state.total === null ? "" : ` ${formatCount(state.total)} 条`}${cacheLabel}`
          : `${response.source === "recommend" ? "个性化推荐候选" : "热门视频候选（兜底）"}${cacheLabel}`;
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
        const filterResult = await enrichAndFilter(fresh, runId);
        if (filterResult?.rateLimit) {
          stopForRateLimit(filterResult.rateLimit);
          break;
        }
        if (runId === state.runId && state.accepted.length < targetCount) {
          elements.statusText.textContent = `${state.mode === "search" ? `搜索“${state.query}”并` : ""}已检查 ${state.inspected} 个候选，通过 ${state.accepted.length} 个，正在继续补量…`;
        }
      }

      if (runId !== state.runId) return;
      if (state.requestStopped) {
        elements.emptyState.hidden = state.accepted.length > 0;
        return;
      }
      elements.emptyState.hidden = state.accepted.length > 0;
      if (state.accepted.length >= targetCount) {
        elements.statusText.textContent = completedFilterMessage(state.mode === "search");
      } else {
        elements.statusText.textContent = state.mode === "search"
          ? `搜索“${state.query}”并检查了 ${inspectedThisRun} 个候选，当前门槛下通过结果较少。`
          : `本轮检查了 ${inspectedThisRun} 个候选，当前门槛下通过结果较少。`;
      }
      storageRemove("local", LEGACY_FILTER_CHECKPOINT_KEY).catch(() => undefined);
    } catch (error) {
      if (runId !== state.runId) return;
      if (error.biliRateLimited) {
        stopForRateLimit({endpoint: error.endpoint});
      } else {
        elements.statusText.textContent = `加载失败：${error.message}`;
      }
      elements.emptyState.hidden = state.accepted.length > 0;
    } finally {
      if (runId === state.runId) {
        state.loading = false;
        hideSkeletons();
        elements.loadMoreButton.disabled = false;
        elements.refreshButton.disabled = false;
        elements.searchSubmit.disabled = false;
        if (state.accepted.length > acceptedAtStart) scheduleAutoLoad();
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
    await storageSet("local", {[SETTINGS_KEY]: settings});
    resetFeed();
    fillFeed(TARGET_INCREMENT);
  }

  function scheduleAutoLoad() {
    if (state.autoLoadTimer || !state.initialized || !state.autoLoadVisible || state.loading) return;
    if (state.noMore && !state.pendingCandidates.length) return;
    state.autoLoadTimer = setTimeout(() => {
      state.autoLoadTimer = null;
      if (!state.autoLoadVisible || state.loading) return;
      fillFeed(state.accepted.length + TARGET_INCREMENT);
    }, 180);
  }

  elements.form.addEventListener("submit", event => {
    saveSettings(event).catch(error => { elements.settingsError.textContent = error.message; });
  });
  elements.addTopicButton.addEventListener("click", () => {
    const row = createTopicPolicyRow({enabled: true, confidenceGte: 0.75});
    elements.topicPolicyList.append(row);
    elements.topicEmptyHint.hidden = true;
    row.querySelector(".topic-name-input").focus();
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
        elements.clearCacheButton.textContent = "清除全部筛选缓存";
      }, 1600);
    }
  });
  elements.searchForm.addEventListener("submit", event => {
    event.preventDefault();
    const query = elements.searchInput.value.trim();
    if (!query) {
      state.mode = "feed";
      state.query = "";
      resetFeed();
      fillFeed(TARGET_INCREMENT);
      return;
    }
    state.mode = "search";
    state.query = query.slice(0, 100);
    elements.searchInput.value = state.query;
    resetFeed();
    fillFeed(TARGET_INCREMENT);
  });
  elements.searchClearButton.addEventListener("click", () => {
    elements.searchInput.value = "";
    state.mode = "feed";
    state.query = "";
    resetFeed();
    fillFeed(TARGET_INCREMENT);
    elements.searchInput.focus();
  });
  elements.refreshButton.addEventListener("click", () => {
    resetFeed();
    fillFeed(TARGET_INCREMENT);
  });
  elements.loadMoreButton.addEventListener("click", () => fillFeed(state.accepted.length + TARGET_INCREMENT));
  const infiniteScrollObserver = new IntersectionObserver(entries => {
    state.autoLoadVisible = entries.some(entry => entry.isIntersecting);
    if (state.autoLoadVisible) scheduleAutoLoad();
  }, {rootMargin: "500px 0px"});
  infiniteScrollObserver.observe(elements.loadMoreButton);
  elements.markedLibraryButton.addEventListener("click", () => {
    elements.markedActionStatus.textContent = "";
    renderMarkedLibrary();
    elements.markedDialog.showModal();
  });
  elements.closeMarkedDialog.addEventListener("click", () => elements.markedDialog.close());
  elements.markedDialog.addEventListener("click", event => {
    if (event.target === elements.markedDialog) elements.markedDialog.close();
  });
  elements.copyMarkedButton.addEventListener("click", () => {
    copyDiscussionData().catch(error => {
      elements.markedActionStatus.textContent = `复制失败：${error.message}；请改用“导出 JSON”`;
    });
  });
  elements.exportMarkedButton.addEventListener("click", exportDiscussionData);

  async function initialize() {
    const [stored, storedMarked] = await Promise.all([
      storageGet("local", SETTINGS_KEY),
      storageGet("local", MARKED_VIDEOS_KEY),
    ]);
    const legacy = stored ? null : await storageGet("sync", LEGACY_SETTINGS_KEY);
    settings = Core.normalizeSettings(stored || legacy || Core.DEFAULT_SETTINGS);
    markedVideos = MarkedCore.normalizeCollection(storedMarked || {});
    if (!stored) await storageSet("local", {[SETTINGS_KEY]: settings});
    writeSettingsForm(settings);
    renderMarkedLibrary();
    await storageRemove("local", LEGACY_FILTER_CHECKPOINT_KEY).catch(() => undefined);
    resetFeed({clearCheckpoint: false});
    await fillFeed(TARGET_INCREMENT);
    state.initialized = true;
    scheduleAutoLoad();
  }

  initialize().catch(error => {
    hideSkeletons();
    elements.statusText.textContent = `初始化失败：${error.message}`;
    elements.emptyState.hidden = false;
  });
})();
