(() => {
  "use strict";

  const Core = globalThis.BiliFilterCore;
  const MarkedCore = globalThis.BiliMarkedCore;
  const SETTINGS_KEY = "biliFilterSettingsV2";
  const LEGACY_SETTINGS_KEY = "biliFilterSettingsV1";
  const MARKED_VIDEOS_KEY = "biliFilterMarkedVideosV1";
  const LEGACY_FILTER_CHECKPOINT_KEY = "biliFilterCheckpointV1";
  const elements = {
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
  };

  let settings = Core.normalizeSettings(Core.DEFAULT_SETTINGS);
  let markedVideos = {};
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
      try {
        const response = await runtimeMessage({type: "bili-filter-update-mark", bvid: snapshot.bvid, changes: {remove: true}});
        markedVideos = MarkedCore.normalizeCollection(response.collection);
        renderMarkedLibrary();
      } catch (error) { elements.markedActionStatus.textContent = `删除失败：${error.message}`; }
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
      try {
        const response = await runtimeMessage({type: "bili-filter-update-mark", bvid: snapshot.bvid, changes: {note: note.value}});
        markedVideos = MarkedCore.normalizeCollection(response.collection);
        elements.markedActionStatus.textContent = `已保存“${snapshot.title || snapshot.bvid}”的备注`;
      } catch (error) { elements.markedActionStatus.textContent = `备注保存失败：${error.message}`; }
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
    document.querySelector("#saveStatus").textContent = "已保存，已打开的 B站首页正在按新规则重新检查；其他页面不筛选。";
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
  elements.markedLibraryButton.addEventListener("click", () => {
    elements.markedActionStatus.textContent = "";
    storageGet("local", MARKED_VIDEOS_KEY).then(value => {
      markedVideos = MarkedCore.normalizeCollection(value || {});
      renderMarkedLibrary();
    }).catch(error => { elements.markedActionStatus.textContent = error.message; });
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
  }

  initialize().catch(error => {
    elements.settingsError.textContent = `初始化失败：${error.message}`;
  });
})();
