(() => {
  "use strict";
  const Adapter = globalThis.BiliPageAdapter;
  let mode = Adapter.pageMode(location.href);
  let route = location.href;
  let revision = 0;
  let running = false;
  let scanTimer;
  let suspended = false;
  const records = new Map();
  const decisions = new Map();
  const inView = new WeakSet();
  let panel;
  let summary;
  let lastError = "";
  let savedIds = new Set();

  function activate() {
    if (!document.documentElement) return;
    document.documentElement.toggleAttribute("data-bvf-active", Boolean(mode));
    if (panel) panel.hidden = !mode;
  }
  activate();

  function message(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, result => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else if (!result?.ok) reject(new Error(result?.error || "过滤后台没有响应"));
          else resolve(result);
        });
      } catch (error) { reject(error); }
    });
  }

  function updateSummary() {
    if (!summary) return;
    const counts = {pending: 0, accepted: 0, rejected: 0, error: 0};
    for (const record of records.values()) counts[record.status] += 1;
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
    retry.addEventListener("click", () => {
      for (const [bvid, result] of decisions) if (result.status === "error") decisions.delete(bvid);
      for (const record of records.values()) if (record.status === "error") setState(record, "pending");
      suspended = false;
      lastError = "";
      scan();
    });
    section.append(heading, summary, settings, retry);
    shadow.append(style, section);
    document.body.append(panel);
    activate();
    updateSummary();
  }

  function setState(record, status) {
    record.status = status;
    record.root.dataset.bvfState = status;
    record.root.dataset.bvfLabel = status === "error" ? "检查失败，可点击右下角重试" : "正在检查视频…";
    record.root.removeAttribute("data-bvf-approved");
    for (const child of record.root.querySelectorAll(Adapter.CARD_SELECTOR)) {
      if (status === "accepted") child.setAttribute("data-bvf-approved", "");
      else child.removeAttribute("data-bvf-approved");
    }
    if (status !== "accepted") record.root.querySelector(".bvf-card-actions")?.remove();
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
    if (!record.root.isConnected || Adapter.videoId(record.root) !== record.bvid) return;
    setState(record, result.status);
    if (result.status === "accepted") renderActions(record, result.video);
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
    record.root.querySelector(".bvf-card-actions")?.remove();
    record.root.querySelectorAll("[data-bvf-approved]").forEach(child => child.removeAttribute("data-bvf-approved"));
  }

  function scan() {
    scanTimer = null;
    if (route !== location.href) {
      route = location.href;
      mode = Adapter.pageMode(route);
      revision += 1;
      suspended = false;
      decisions.clear();
      for (const record of records.values()) release(record);
      records.clear();
    }
    activate();
    if (!mode) return;
    mountPanel();
    const found = new Set(Adapter.cards(document));
    for (const [root, record] of records) {
      if (!root.isConnected || !found.has(root)) { release(record); records.delete(root); }
    }
    for (const root of found) {
      const bvid = Adapter.videoId(root);
      let record = records.get(root);
      if (record?.bvid === bvid) {
        // B站可能在相同外层重建子卡片，需要同步嵌套卡片的可见状态。
        if (record.status === "accepted") root.querySelectorAll(Adapter.CARD_SELECTOR)
          .forEach(child => { if (!child.hasAttribute("data-bvf-approved")) child.setAttribute("data-bvf-approved", ""); });
        if (record.status === "accepted" && decisions.get(bvid)?.video) renderActions(record, decisions.get(bvid).video);
        continue;
      }
      if (record) release(record);
      record = {root, bvid, status: "pending"};
      records.set(root, record);
      if (!bvid) setState(record, "rejected");
      else {
        setState(record, "pending");
        observer.observe(root);
        if (decisions.has(bvid)) apply(record, decisions.get(bvid));
      }
    }
    updateSummary();
    pump();
  }

  async function pump() {
    if (running || suspended || !mode) return;
    const batch = [...new Set([...records.values()]
      .filter(record => record.status === "pending" && inView.has(record.root))
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
      updateSummary();
      pump();
    }
  }

  function fatal(error) {
    lastError = error.message;
    if (summary) summary.textContent = "扩展已更新或暂不可用，请刷新 B站页面";
  }
  const mutations = new MutationObserver(() => {
    // 在浏览器下一次绘制前遮住被复用的卡片，避免节流扫描期间闪出新视频。
    for (const record of records.values()) if (record.status === "accepted" && Adapter.videoId(record.root) !== record.bvid) {
      record.root.dataset.bvfState = "pending";
      record.root.dataset.bvfLabel = "正在检查视频…";
      record.root.querySelectorAll("[data-bvf-approved]").forEach(child => child.removeAttribute("data-bvf-approved"));
    }
    if (!scanTimer) scanTimer = setTimeout(scan, 60);
  });
  mutations.observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ["href"]});
  // pushState 不触发 popstate；兼容 B站 SPA 路由以及整页导航。
  addEventListener("popstate", scan);
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
    revision += 1;
    decisions.clear();
    suspended = false;
    for (const record of records.values()) if (record.bvid) setState(record, "pending");
    pump();
  });
  chrome.storage.local.get("biliFilterMarkedVideosV1").then(value => {
    savedIds = new Set(Object.keys(value.biliFilterMarkedVideosV1 || {}));
  }).catch(fatal);
  scan();
})();
