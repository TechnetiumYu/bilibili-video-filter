(() => {
  "use strict";
  const Adapter = globalThis.BiliPageAdapter;
  const Carousel = globalThis.BiliCarouselFilter;
  let onlyVideos = true;
  let continuousLoad = true;
  let settingsReady = false;
  let settingsRevision = 0;
  let mode = Adapter.pageMode(location.href);
  let route = location.href;
  let revision = 0;
  let running = false;
  let scanTimer;
  let streamFrame;
  let suspended = false;
  const records = new Map();
  const decisions = new Map();
  const inView = new WeakSet();
  let panel;
  let summary;
  let lastError = "";
  let savedIds = new Set();
  const stream = globalThis.BiliHomeStream.create(document, {
    getState: () => ({
      enabled: Boolean(document?.documentElement && settingsReady && continuousLoad && mode === "feed" && route === location.href),
      visible: document?.visibilityState === "visible",
      suspended,
      checking: running || [...records.values()].some(record => record.status === "pending"),
      roots: [...records.values()].filter(record => !record.carousel).map(record => record.root),
      bvids: [...records.values()].map(record => record.bvid),
      statuses: new Map([
        ...[...decisions].map(([bvid, result]) => [bvid, result.status]),
        ...[...records.values()].filter(record => record.bvid).map(record => [record.bvid, record.status]),
      ]),
    }),
    fetchCandidates: options => message({type: "bili-filter-home-candidates", options}),
    appendCandidates: (grid, items) => {
      for (const item of items) {
        const card = document.createElement("div");
        card.className = "feed-card bvf-stream-card";
        card.dataset.bvfStreamBvid = item.bvid;
        const video = document.createElement("div");
        video.className = "bili-video-card";
        const link = document.createElement("a");
        link.href = `https://www.bilibili.com/video/${item.bvid}`;
        link.textContent = "正在检查视频…";
        video.append(link);
        card.append(video);
        grid.append(card);
      }
    },
    onChange: () => scan(),
    onError: error => {
      lastError = error.message;
      if (error.biliRateLimited || error.status === 412) {
        suspended = true;
        for (const record of records.values()) if (record.status === "pending") setState(record, "error");
      }
      updateSummary();
    },
    onResume: () => retryFailed(false),
  });

  function activate() {
    if (!document.documentElement) return;
    document.documentElement.toggleAttribute("data-bvf-active", Boolean(mode));
    document.documentElement.toggleAttribute("data-bvf-video-only", Boolean(mode && onlyVideos));
    if (panel) panel.hidden = !mode;
  }
  activate();

  function message(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, result => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else if (!result?.ok) reject(Object.assign(new Error(result?.error || "过滤后台没有响应"), {
            status: Number(result?.status) || 0,
            biliRateLimited: Boolean(result?.biliRateLimited),
          }));
          else resolve(result);
        });
      } catch (error) { reject(error); }
    });
  }

  function updateSummary() {
    if (!summary) return;
    const counts = {pending: 0, accepted: 0, rejected: 0, error: 0};
    for (const record of records.values()) if (record.status in counts) counts[record.status] += 1;
    const next = `通过 ${counts.accepted} · 隐藏 ${counts.rejected} · 待查 ${counts.pending} · 失败 ${counts.error}`;
    if (summary.textContent !== next) summary.textContent = next;
    summary.title = lastError || "仅检查当前页面的原生视频卡片；向下滚动会检查新视频。";
  }

  function mountPanel() {
    if (panel || !document.body) return;
    panel = document.createElement("div");
    panel.id = "bvf-page-controls";
    panel.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483646;";
    const shadow = panel.attachShadow({mode: "closed"});
    const style = document.createElement("style");
    style.textContent = "section{padding:10px 12px;background:#fff;color:#61666d;border:1px solid #e3e5e7;border-radius:8px;box-shadow:0 3px 18px #0002;font:12px/1.7 'Microsoft YaHei',sans-serif;max-width:320px}strong{color:#fb7299}p{margin:3px 0}button{cursor:pointer;background:#f6f7f8;border:1px solid #e3e5e7;border-radius:4px;padding:3px 8px;margin:3px 5px 0 0;color:#61666d;font:inherit}";
    const section = document.createElement("section");
    const heading = document.createElement("strong");
    heading.textContent = "B站视频过滤器";
    summary = document.createElement("p");
    const settings = document.createElement("button");
    settings.textContent = "设置 / 标记库";
    settings.addEventListener("click", () => message({type: "bili-filter-open-settings"}).catch(fatal));
    const retry = document.createElement("button");
    retry.textContent = "重试失败项";
    retry.addEventListener("click", () => retryFailed());
    section.append(heading, summary, settings, retry);
    shadow.append(style, section);
    document.body.append(panel);
    activate();
    updateSummary();
  }

  function setState(record, status) {
    record.status = status;
    if (status !== "accepted") record.video = null;
    record.root.dataset.bvfState = status;
    record.root.dataset.bvfLabel = status === "error" ? "检查失败，可点击右下角重试" : "正在检查视频…";
    record.root.removeAttribute("data-bvf-approved");
    for (const child of record.root.querySelectorAll(Adapter.CARD_SELECTOR)) {
      if (status === "accepted") child.setAttribute("data-bvf-approved", "");
      else child.removeAttribute("data-bvf-approved");
    }
    if (status !== "accepted") record.root.querySelector(".bvf-card-actions")?.remove();
  }

  function retryFailed(resumeStream = true) {
    for (const [bvid, result] of decisions) if (result.status === "error") decisions.delete(bvid);
    for (const record of records.values()) if (record.status === "error") setState(record, "pending");
    suspended = false;
    lastError = "";
    scan();
    if (resumeStream) void stream.resume();
  }

  function renderStreamVideo(record, video) {
    if (!record.root.matches(".bvf-stream-card")) return;
    const signature = JSON.stringify([record.bvid, video.title, video.coverUrl, video.playCount, video.uploaderId, video.uploaderName]);
    if (record.root.dataset.bvfRendered === signature) return;
    const body = record.root.querySelector(".bili-video-card");
    const cover = document.createElement("a");
    cover.className = "bvf-stream-cover";
    cover.href = `https://www.bilibili.com/video/${record.bvid}`;
    cover.target = "_blank";
    cover.rel = "noopener noreferrer";
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    const coverUrl = String(video.coverUrl || "").replace(/^\/\//, "https://").replace(/^http:/, "https:");
    if (coverUrl.startsWith("https://")) image.src = coverUrl;
    const stats = document.createElement("span");
    const views = Number(video.playCount);
    stats.textContent = `${views >= 10000 ? `${(views / 10000).toFixed(1)}万` : views} 播放`;
    cover.append(image, stats);
    const title = document.createElement("a");
    title.className = "bvf-stream-title";
    title.href = cover.href;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    title.textContent = video.title || record.bvid;
    const uploader = document.createElement("a");
    uploader.className = "bvf-stream-uploader";
    uploader.href = `https://space.bilibili.com/${encodeURIComponent(video.uploaderId || "")}`;
    uploader.target = "_blank";
    uploader.rel = "noopener noreferrer";
    uploader.textContent = video.uploaderName || "UP主";
    body.replaceChildren(cover, title, uploader);
    record.root.dataset.bvfRendered = signature;
  }

  function renderActions(record, video) {
    if (record.root.querySelector(".bvf-card-actions")) return;
    const actions = document.createElement("div");
    actions.className = "bvf-card-actions";
    const date = document.createElement("span");
    const published = new Date(Number(video.publishTime) * 1000);
    date.textContent = Number(video.publishTime) > 0 && !Number.isNaN(published.getTime())
      ? `发布于 ${published.getFullYear()}-${String(published.getMonth() + 1).padStart(2, "0")}-${String(published.getDate()).padStart(2, "0")}` : "发布时间未知";
    const mark = document.createElement("button");
    mark.type = "button";
    mark.textContent = savedIds.has(record.bvid) ? "✓ 已标记" : "标记待分析";
    mark.disabled = savedIds.has(record.bvid);
    mark.dataset.bvfBvid = record.bvid;
    mark.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      mark.disabled = true;
      try {
        await message({type: "bili-filter-mark-page", bvid: record.bvid,
          context: {sourceMode: mode, sourceQuery: new URL(location.href).searchParams.get("keyword") || ""}});
        savedIds.add(record.bvid);
        mark.textContent = "✓ 已标记";
      } catch (error) {
        mark.disabled = false;
        mark.textContent = "标记失败，重试";
        mark.title = error.message;
      }
    });
    actions.append(date, mark);
    record.root.append(actions);
  }

  function apply(record, result) {
    if (!record.root.isConnected || identify(record.root) !== record.bvid) return;
    setState(record, result.status);
    if (result.status === "accepted") {
      record.video = result.video;
      renderStreamVideo(record, result.video);
      if (!record.carousel) renderActions(record, result.video);
    }
    if (result.status === "error") lastError = (result.reasons || []).join("；");
  }

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) inView.add(entry.target);
      else inView.delete(entry.target);
    }
    pump();
  }, {rootMargin: "600px 0px"});

  function release(record) {
    observer.unobserve(record.root);
    record.root.removeAttribute("data-bvf-state");
    record.root.removeAttribute("data-bvf-label");
    record.root.removeAttribute("data-bvf-item");
    record.root.querySelector(".bvf-card-actions")?.remove();
    record.root.querySelectorAll("[data-bvf-approved]").forEach(child => child.removeAttribute("data-bvf-approved"));
  }

  function identify(root) {
    return onlyVideos ? Adapter.ordinaryVideoId(root) : Adapter.videoId(root);
  }

  function layout() {
    if (!mode || !document?.documentElement) return;
    Adapter.compact(document, [...records.values()].filter(record => !record.carousel).map(record => record.root));
    Carousel.sync(document, [...records.values()], onlyVideos);
  }

  function scan() {
    scanTimer = null;
    if (route !== location.href) {
      stream.clear();
      route = location.href;
      mode = Adapter.pageMode(route);
      revision += 1;
      suspended = false;
      decisions.clear();
      for (const record of records.values()) release(record);
      records.clear();
    }
    activate();
    if (mode === "feed") globalThis.BiliHomeLayout.preserve(document);
    else globalThis.BiliHomeLayout.clear(document);
    if (!mode) { Adapter.clearLayout(document); Carousel.clear(document); stream.clear(); return; }
    if (!settingsReady) return;
    mountPanel();
    const found = new Map(Adapter.cards(document, onlyVideos).map(root => [root, null]));
    if (onlyVideos) for (const entry of Carousel.entries(document)) found.set(entry.root, entry.carousel);
    // 原站稍后也可能加载同一个 BV；保留原生卡片，移除托管区的重复副本。
    const nativeIds = new Set([...found.keys()].filter(root => !root.closest(".bvf-home-stream")).map(identify).filter(Boolean));
    for (const root of found.keys()) if (root.matches(".bvf-stream-card") && nativeIds.has(identify(root))) {
      root.remove();
      found.delete(root);
    }
    for (const [root, record] of records) {
      if (!root.isConnected || !found.has(root)) { release(record); records.delete(root); }
    }
    for (const [root, carousel] of found) {
      const bvid = identify(root);
      let record = records.get(root);
      if (record?.bvid === bvid) {
        // B站可能在相同外层重建子卡片，需要同步嵌套卡片的可见状态。
        if (record.status === "accepted") root.querySelectorAll(Adapter.CARD_SELECTOR)
          .forEach(child => { if (!child.hasAttribute("data-bvf-approved")) child.setAttribute("data-bvf-approved", ""); });
        if (!record.carousel && record.status === "accepted" && decisions.get(bvid)?.video) renderActions(record, decisions.get(bvid).video);
        continue;
      }
      if (record) release(record);
      record = {root, bvid, carousel, status: "pending"};
      records.set(root, record);
      if (!bvid) setState(record, onlyVideos ? "rejected" : "unfiltered");
      else {
        setState(record, "pending");
        observer.observe(root);
        if (decisions.has(bvid)) apply(record, decisions.get(bvid));
      }
    }
    layout();
    updateSummary();
    pump();
    void stream.update();
  }

  async function pump() {
    if (running || suspended || !mode || !settingsReady || !document?.documentElement
      || route !== location.href || document.visibilityState === "hidden") return;
    const batch = [...new Set([...records.values()]
      .filter(record => record.status === "pending" && (record.carousel || inView.has(record.root)))
      .map(record => record.bvid).filter(Boolean))].slice(0, 8);
    if (!batch.length) return;
    running = true;
    const currentRevision = revision;
    try {
      const response = await message({type: "bili-filter-check-page", bvids: batch, mode});
      if (currentRevision !== revision || route !== location.href) return;
      for (const bvid of batch) {
        const result = response.results?.find(item => item.bvid === bvid)
          || {bvid, status: "error", reasons: ["后台未返回完整结果"]};
        decisions.set(bvid, result);
        for (const record of records.values()) if (record.bvid === bvid) apply(record, result);
      }
      if (response.rateLimited) {
        suspended = true;
        for (const record of records.values()) if (record.status === "pending") setState(record, "error");
      }
    } catch (error) {
      if (currentRevision !== revision) return;
      lastError = error.message;
      suspended = true;
      for (const record of records.values()) if (record.status === "pending") {
        setState(record, "error");
      }
    } finally {
      running = false;
      layout();
      updateSummary();
      pump();
      void stream.update();
    }
  }

  function fatal(error) {
    lastError = error.message;
    if (summary) summary.textContent = "扩展已更新或暂不可用，请刷新 B站页面";
  }
  const mutations = new MutationObserver(() => {
    if (!document?.documentElement) return;
    // 在浏览器下一次绘制前遮住被复用的卡片，避免节流扫描期间闪出新视频。
    for (const record of records.values()) if (record.status === "accepted" && identify(record.root) !== record.bvid) {
      record.root.dataset.bvfState = "pending";
      record.root.dataset.bvfLabel = "正在检查视频…";
      record.root.querySelectorAll("[data-bvf-approved]").forEach(child => child.removeAttribute("data-bvf-approved"));
      record.status = "pending";
      record.video = null;
    }
    // 轮播原始链接被复用时，立即撤下旧的通过视图，下一轮扫描重新确认。
    if (mode && onlyVideos) Carousel.sync(document, [...records.values()], true);
    if (!scanTimer) scanTimer = setTimeout(scan, 60);
  });
  mutations.observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ["href"]});
  // pushState 不触发 popstate；兼容 B站 SPA 路由以及整页导航。
  addEventListener("popstate", scan);
  addEventListener("resize", () => {
    if (!scanTimer) scanTimer = setTimeout(scan, 60);
  });
  addEventListener("scroll", () => {
    if (streamFrame) return;
    streamFrame = requestAnimationFrame(() => { streamFrame = null; void stream.update(); });
  }, {passive: true});
  document.addEventListener("visibilitychange", () => { pump(); void stream.update(); });
  setInterval(() => { if (route !== location.href) scan(); }, 500);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.biliFilterMarkedVideosV1) {
      savedIds = new Set(Object.keys(changes.biliFilterMarkedVideosV1.newValue || {}));
      for (const button of document.querySelectorAll("button[data-bvf-bvid]")) {
        button.disabled = savedIds.has(button.dataset.bvfBvid);
        button.textContent = button.disabled ? "✓ 已标记" : "标记待分析";
      }
    }
    if (!changes.biliFilterSettingsV2) return;
    settingsRevision += 1;
    settingsReady = true;
    onlyVideos = changes.biliFilterSettingsV2.newValue?.onlyVideos !== false;
    continuousLoad = changes.biliFilterSettingsV2.newValue?.continuousLoad !== false;
    if (!continuousLoad) stream.clear();
    revision += 1;
    decisions.clear();
    suspended = false;
    for (const record of records.values()) release(record);
    records.clear();
    Carousel.clear(document);
    scan();
  });
  const initialSettingsRevision = settingsRevision;
  chrome.storage.local.get(["biliFilterMarkedVideosV1", "biliFilterSettingsV2"]).then(value => {
    savedIds = new Set(Object.keys(value.biliFilterMarkedVideosV1 || {}));
    if (settingsRevision === initialSettingsRevision) {
      onlyVideos = value.biliFilterSettingsV2?.onlyVideos !== false;
      continuousLoad = value.biliFilterSettingsV2?.continuousLoad !== false;
    }
    settingsReady = true;
    scan();
  }).catch(fatal);
  scan();
})();
