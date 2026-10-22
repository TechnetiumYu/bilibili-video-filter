(() => {
  "use strict";
  const UI = globalThis.BiliSettingsUI;
  const Core = globalThis.BiliFilterCore;
  const UI_KEY = "biliFilterUiV1";
  const el = Object.fromEntries(["filterSidebar", "collapseSidebar", "expandSidebar", "toggleSidebarButton", "editRulesButton",
    "keywordChips", "summaryViews", "summaryFollowers", "summaryTopics", "quickOnlyVideos", "quickContinuousLoad",
    "videoGrid", "browseSummary", "browseStatus", "loadMoreButton", "retryFeedButton", "settingsDialog", "filterStatus"]
    .map(id => [id, document.getElementById(id)]));
  let settings, ready = false, generation = 0, busy = false, paused = false, ended = false;
  let batch = 1, emptyBatches = 0, pending = [], batchOpen = false, batchAccepted = false, errorMessage = "";
  let scrollFrame, sidebarVersion = 0;
  const seen = new Set(), outcomes = new Map(), cards = new Map(), saved = new Set();

  function request(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, response => {
          const lastError = chrome.runtime.lastError;
          if (lastError) reject(new Error(lastError.message));
          else if (!response?.ok) reject(Object.assign(new Error(response?.error || "扩展后台未返回有效结果"), {status: response?.status}));
          else resolve(response);
        });
      } catch (error) { reject(error); }
    });
  }

  function compact(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return value >= 100000000 ? `${(value / 100000000).toFixed(1)}亿` : value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value);
  }

  function threshold(value) { return value === null ? "不限" : compact(value) ?? "不限"; }
  function range(min, max) { return `${threshold(min)} — ${threshold(max)}`; }

  function setSidebar(collapsed, persist = false) {
    const focusInside = el.filterSidebar.contains(document.activeElement);
    const focusExpand = document.activeElement === el.expandSidebar;
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    el.filterSidebar.hidden = collapsed;
    el.expandSidebar.hidden = !collapsed;
    for (const button of [el.collapseSidebar, el.expandSidebar, el.toggleSidebarButton]) button.setAttribute("aria-expanded", String(!collapsed));
    el.toggleSidebarButton.setAttribute("aria-label", collapsed ? "展开筛选侧栏" : "收起筛选侧栏");
    if (collapsed && focusInside) el.expandSidebar.focus();
    if (!collapsed && focusExpand) el.collapseSidebar.focus();
    if (persist) {
      sidebarVersion += 1;
      chrome.storage.local.set({[UI_KEY]: {sidebarCollapsed: collapsed}}, () => {
        if (chrome.runtime.lastError) el.browseStatus.textContent = "界面已切换，但布局偏好保存失败";
      });
    }
  }

  el.collapseSidebar.addEventListener("click", () => setSidebar(true, true));
  el.expandSidebar.addEventListener("click", () => setSidebar(false, true));
  el.toggleSidebarButton.addEventListener("click", () => setSidebar(!el.filterSidebar.hidden, true));
  el.editRulesButton.addEventListener("click", () => UI.openRules());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && innerWidth <= 900 && !document.querySelector("dialog[open]")) setSidebar(true, true);
  });
  setSidebar(innerWidth <= 900);
  chrome.storage.local.get(UI_KEY, result => {
    if (sidebarVersion || chrome.runtime.lastError) return;
    const preference = result[UI_KEY]?.sidebarCollapsed;
    if (typeof preference === "boolean") setSidebar(preference);
  });

  function summary() {
    const counts = {accepted: 0, rejected: 0, error: 0};
    for (const result of outcomes.values()) counts[result.status] += 1;
    el.browseSummary.textContent = `已通过 ${counts.accepted} · 已隐藏 ${counts.rejected}${counts.error ? ` · 检查失败 ${counts.error}` : ""}`;
    el.filterStatus.textContent = paused ? "筛选已暂停" : "筛选已开启";
    el.filterStatus.dataset.state = paused ? "paused" : "active";
    el.retryFeedButton.hidden = !paused;
    el.loadMoreButton.disabled = busy;
    el.loadMoreButton.textContent = busy ? "加载中…" : ended ? "再检查一次" : emptyBatches >= 5 ? "继续查找" : "加载更多";
  }

  function renderRules() {
    el.keywordChips.replaceChildren();
    for (const keyword of settings.blockedKeywords.slice(0, 3)) {
      const chip = document.createElement("span"); chip.textContent = keyword; el.keywordChips.append(chip);
    }
    if (settings.blockedKeywords.length > 3) {
      const chip = document.createElement("span"); chip.textContent = `+${settings.blockedKeywords.length - 3}`; el.keywordChips.append(chip);
    }
    if (!settings.blockedKeywords.length) el.keywordChips.textContent = "未设置";
    el.summaryViews.textContent = range(settings.minViews, settings.maxViews);
    el.summaryFollowers.textContent = range(settings.minFollowers, settings.maxFollowers);
    el.summaryTopics.replaceChildren();
    const policies = settings.topicPolicies.filter(policy => policy.enabled);
    for (const policy of policies) {
      const row = document.createElement("div"); row.className = "summary-topic";
      const info = document.createElement("div"); info.className = "summary-topic-info";
      const name = document.createElement("strong"); name.textContent = policy.name;
      const thresholds = document.createElement("small"); thresholds.className = "topic-thresholds";
      thresholds.textContent = [policy.minViews === null ? "" : `播放 ≥ ${threshold(policy.minViews)}`,
        policy.minFollowers === null ? "" : `粉丝 ≥ ${threshold(policy.minFollowers)}`].filter(Boolean).join(" · ");
      info.append(name, thresholds);
      const edit = document.createElement("button"); edit.className = "text-button"; edit.type = "button"; edit.textContent = "编辑";
      edit.title = `播放量 ≥ ${threshold(policy.minViews)}；粉丝数 ≥ ${threshold(policy.minFollowers)}`;
      edit.addEventListener("click", () => UI.openRules()); row.append(info, edit); el.summaryTopics.append(row);
    }
    if (!policies.length) el.summaryTopics.textContent = "暂无特殊话题";
    el.quickOnlyVideos.checked = settings.onlyVideos;
    el.quickContinuousLoad.checked = settings.continuousLoad;
  }

  function bookmarkIcon(button) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", "M6 3h12v18l-6-4-6 4V3Z");
    svg.append(path); button.append(svg);
  }

  function updateMark(button, bvid) {
    const marked = saved.has(bvid);
    button.disabled = marked;
    button.classList.toggle("is-marked", marked);
    button.setAttribute("aria-pressed", String(marked));
    button.setAttribute("aria-label", marked ? "已标记待分析" : "标记待分析");
    button.title = marked ? "已标记待分析" : "标记待分析";
  }

  function renderVideo(video) {
    if (cards.has(video.bvid)) return;
    const card = document.createElement("article"); card.className = "video-card"; card.dataset.bvid = video.bvid;
    const cover = document.createElement("a"); cover.className = "video-cover";
    cover.href = `https://www.bilibili.com/video/${video.bvid}`; cover.target = "_blank"; cover.rel = "noopener noreferrer";
    const image = document.createElement("img"); image.alt = ""; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
    const imageUrl = String(video.coverUrl || "").replace(/^\/\//, "https://").replace(/^http:/, "https:");
    if (imageUrl.startsWith("https://")) image.src = imageUrl;
    cover.append(image);
    const duration = Math.floor(Number(video.duration));
    if (Number.isFinite(duration) && duration > 0) {
      const badge = document.createElement("span"); badge.className = "video-duration";
      badge.textContent = duration >= 3600 ? `${Math.floor(duration / 3600)}:${String(Math.floor(duration / 60) % 60).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`
        : `${String(Math.floor(duration / 60)).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`;
      cover.append(badge);
    }
    const heading = document.createElement("div"); heading.className = "video-card-heading";
    const title = document.createElement("a"); title.className = "video-title"; title.href = cover.href;
    title.target = "_blank"; title.rel = "noopener noreferrer"; title.textContent = video.title;
    const mark = document.createElement("button"); mark.className = "mark-video-button"; mark.type = "button"; mark.dataset.bvid = video.bvid;
    bookmarkIcon(mark); updateMark(mark, video.bvid);
    mark.addEventListener("click", async () => {
      mark.disabled = true;
      try {
        await request({type: "bili-filter-mark-page", bvid: video.bvid, context: {sourceMode: "feed"}});
        saved.add(video.bvid); updateMark(mark, video.bvid); await UI.refreshMarks();
      } catch (error) { mark.disabled = false; mark.title = `标记失败：${error.message}，可点击重试`; el.browseStatus.textContent = mark.title; }
    });
    heading.append(title, mark);
    const meta = document.createElement("p"); meta.className = "video-meta";
    const uploader = document.createElement("a"); uploader.href = `https://space.bilibili.com/${encodeURIComponent(video.uploaderId || "")}`;
    uploader.target = "_blank"; uploader.rel = "noopener noreferrer"; uploader.textContent = video.uploaderName || "UP主";
    const published = new Date(Number(video.publishTime) * 1000);
    const date = Number(video.publishTime) > 0 && !Number.isNaN(published.getTime())
      ? `${published.getFullYear()}-${String(published.getMonth() + 1).padStart(2, "0")}-${String(published.getDate()).padStart(2, "0")}` : "发布时间未知";
    meta.append(uploader, document.createTextNode(` · ${date}`));
    const metrics = document.createElement("div"); metrics.className = "video-metrics";
    for (const [value, label] of [[video.playCount, "播放"], [video.danmakuCount, "弹幕"]]) {
      const span = document.createElement("span"); const number = compact(value);
      span.textContent = number === null ? `${label}量未知` : `${number} ${label}`;
      span.title = number === null ? `${label}量未知` : `${label}量：${value}`; metrics.append(span);
    }
    card.append(cover, heading, meta, metrics); cards.set(video.bvid, card); el.videoGrid.append(card);
  }

  function status() {
    if (paused) return errorMessage || "检查失败，请手动重试";
    if (ended && !pending.length) return "B站暂时没有更多推荐";
    if (emptyBatches >= 5) return "连续 5 批未找到新的合格视频，点击继续查找";
    if (!settings?.continuousLoad) return "连续加载已关闭，可手动加载更多";
    return "继续向下，自动加载";
  }

  function canLoad(force) {
    return ready && !busy && !paused && (!ended || pending.length) && !el.settingsDialog.open && document.visibilityState !== "hidden"
      && emptyBatches < 5 && (pending.length || force || settings.continuousLoad && el.videoGrid.getBoundingClientRect().bottom < innerHeight + 700);
  }

  async function load(force = false) {
    if (!canLoad(force)) return;
    busy = true; summary(); const token = generation;
    try {
      if (!pending.length) {
        el.browseStatus.textContent = "正在加载推荐…";
        const response = await request({type: "bili-filter-home-candidates", options: {batch}});
        if (token !== generation) return;
        if (!Array.isArray(response.items)) throw new Error("推荐列表不完整");
        batch += 1; ended = response.noMore === true; batchOpen = true; batchAccepted = false;
        pending = response.items.map(item => item?.bvid).filter(bvid => {
          if (typeof bvid !== "string" || !/^BV[0-9A-Za-z]{10}$/.test(bvid) || seen.has(bvid)) return false;
          seen.add(bvid); return true;
        });
      }
      while (pending.length) {
        if (token !== generation) return;
        if (document.visibilityState === "hidden" || el.settingsDialog.open) break;
        el.browseStatus.textContent = `正在筛选视频，剩余 ${pending.length} 个…`;
        const ids = pending.slice(0, 8);
        const response = await request({type: "bili-filter-check-page", bvids: ids, mode: "feed"});
        if (token !== generation) return;
        const finished = new Set();
        for (const bvid of ids) {
          let result = response.results?.find(item => item.bvid === bvid);
          if (!result || !["accepted", "rejected", "error"].includes(result.status) || result.status === "accepted" && result.video?.bvid !== bvid)
            result = {bvid, status: "error", reasons: ["视频检查结果不完整"]};
          outcomes.set(bvid, result);
          if (result.status === "accepted") { renderVideo(result.video); batchAccepted = true; }
          if (result.status !== "error") finished.add(bvid);
          else { paused = true; errorMessage = (result.reasons || ["检查失败"]).join("；"); }
        }
        pending = pending.filter(bvid => !finished.has(bvid));
        if (response.rateLimited) { paused = true; errorMessage ||= "B站返回 HTTP 412，请手动重试"; }
        summary(); if (paused) break;
      }
      if (!pending.length && batchOpen) { emptyBatches = batchAccepted ? 0 : emptyBatches + 1; batchOpen = false; }
    } catch (error) {
      if (token === generation) { paused = true; errorMessage = `加载失败：${error.message}`; }
    } finally {
      if (token === generation) {
        busy = false; summary(); el.browseStatus.textContent = status();
        void load();
      }
    }
  }

  function restart(next) {
    settings = Core.normalizeSettings(next); generation += 1; busy = paused = ended = false;
    batch = 1; emptyBatches = 0; pending = []; batchOpen = batchAccepted = false; errorMessage = "";
    seen.clear(); outcomes.clear(); cards.clear(); el.videoGrid.replaceChildren();
    renderRules(); summary(); el.browseStatus.textContent = status();
    void load(true);
  }

  function resume() {
    paused = false; if (!pending.length) ended = false; emptyBatches = 0; errorMessage = ""; void load(true);
  }
  el.loadMoreButton.addEventListener("click", resume);
  el.retryFeedButton.addEventListener("click", resume);
  el.settingsDialog.addEventListener("close", () => { void load(true); });
  for (const [input, key] of [[el.quickOnlyVideos, "onlyVideos"], [el.quickContinuousLoad, "continuousLoad"]]) input.addEventListener("change", async () => {
    input.disabled = true;
    try { await UI.updateQuickSettings({[key]: input.checked}); }
    catch (error) { el.browseStatus.textContent = `保存失败：${error.message}`; renderRules(); }
    finally { input.disabled = false; }
  });
  addEventListener("scroll", () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = null; void load(); });
  }, {passive: true});
  addEventListener("resize", () => { void load(); });
  document.addEventListener("visibilitychange", () => { void load(); });
  addEventListener("bili-filter-settings-changed", event => {
    if (!ready) return;
    const next = Core.normalizeSettings(event.detail);
    // 连续加载开关不改变通过结果，也不重置当前页或发起首批新请求。
    if (JSON.stringify({...settings, continuousLoad: next.continuousLoad}) === JSON.stringify(next)) {
      settings = next; renderRules(); el.browseStatus.textContent = status(); void load();
    } else restart(next);
  });
  addEventListener("bili-filter-marks-changed", event => {
    saved.clear(); for (const bvid of Object.keys(event.detail || {})) saved.add(bvid);
    for (const button of el.videoGrid.querySelectorAll("button[data-bvid]")) updateMark(button, button.dataset.bvid);
  });
  function initialize(value) {
    if (ready) return;
    ready = true; for (const bvid of Object.keys(UI.getMarked())) saved.add(bvid);
    const editOnly = new URL(location.href).searchParams.get("settings") === "1";
    if (editOnly) UI.openRules();
    restart(value);
    if (editOnly) el.browseStatus.textContent = "关闭规则设置后开始加载视频";
  }
  addEventListener("bili-filter-settings-ready", event => initialize(event.detail));
  if (UI.isReady()) initialize(UI.getSettings());
})();
