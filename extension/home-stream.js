(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliHomeStream = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const EMPTY_BATCH_LIMIT = 5;

  // 在原首页后面追加推荐，不触碰 B站组件内部数据，也不替换或移动原卡片。
  function create(document, options) {
    let section, grid, status, button, source;
    let batch = 1;
    let busy = false;
    let generation = 0;
    let emptyBatches = 0;
    let awaiting = [];
    let stopped = "";
    let stopMessage = "";
    const seen = new Set();

    function clear() {
      generation += 1;
      section?.remove();
      section = grid = status = button = source = null;
      batch = 1;
      busy = false;
      emptyBatches = 0;
      awaiting = [];
      stopped = "";
      stopMessage = "";
      seen.clear();
    }

    function write(text) {
      if (status && status.textContent !== text) status.textContent = text;
      options.onStatus?.(text);
    }

    function size() {
      if (!grid || !source?.isConnected) return;
      const style = document.defaultView.getComputedStyle(source);
      const columns = style.gridTemplateColumns;
      if (style.display.includes("grid") && columns && columns !== "none") grid.style.gridTemplateColumns = columns;
      else grid.style.removeProperty("grid-template-columns");
      if (style.gap && style.gap !== "normal") grid.style.gap = style.gap;
      const width = source.getBoundingClientRect().width;
      if (width > 0) section.style.width = `${width}px`;
    }

    function mount(state) {
      if (section?.isConnected && source?.isConnected) { size(); return true; }
      if (section) clear();
      const root = (state.roots || []).find(node => node.isConnected && !node.closest(".recommended-swipe, .bvf-home-stream"));
      if (!root?.parentElement || root.parentElement === document.body) return false;
      source = root.parentElement;
      section = document.createElement("section");
      section.className = "bvf-home-stream";
      section.setAttribute("data-bvf-owned", "");
      section.setAttribute("aria-label", "连续加载的筛选视频");
      grid = document.createElement("div");
      grid.className = "bvf-stream-grid";
      const footer = document.createElement("div");
      footer.className = "bvf-stream-footer";
      status = document.createElement("span");
      status.setAttribute("role", "status");
      button = document.createElement("button");
      button.type = "button";
      button.textContent = "加载更多";
      button.addEventListener("click", () => resume());
      footer.append(status, button);
      section.append(grid, footer);
      source.after(section);
      size();
      return true;
    }

    function nearEnd() {
      const viewport = document.defaultView.innerHeight || 800;
      return section.getBoundingClientRect().bottom < viewport + 900;
    }

    async function update(force = false) {
      const state = options.getState();
      if (!state.enabled) { if (section || busy) clear(); return; }
      if (!mount(state)) return;
      for (const bvid of state.bvids || []) if (bvid) seen.add(bvid);
      if (state.visible === false) return;
      if (busy) return;
      if (state.suspended) { write("筛选已暂停，请点击重试失败项"); return; }
      if (awaiting.length) {
        const activeIds = new Set(state.bvids || []);
        // 原站换一批可能移除此前去重对应的原生卡片；消失项不能让队列永久等待。
        const statuses = awaiting.map(bvid => state.statuses?.get(bvid) || (activeIds.has(bvid) ? "pending" : "unavailable"));
        if (statuses.some(value => !value || value === "pending")) { write("正在筛选新视频…"); return; }
        if (statuses.some(value => value === "error")) {
          stopped = "error";
          stopMessage = "新视频检查失败，请重试失败项";
          write("新视频检查失败，请重试失败项");
          return;
        }
        emptyBatches = statuses.some(value => value === "accepted") ? 0 : emptyBatches + 1;
        awaiting = [];
      }
      if (emptyBatches >= EMPTY_BATCH_LIMIT && !stopped) stopped = "empty";
      if (stopped) {
        write(stopped === "end" ? "B站暂时没有更多推荐" : stopped === "empty"
          ? "连续多批未找到新的合格视频，点击继续查找" : stopMessage || "加载已停止，点击重试");
        button.textContent = stopped === "end" ? "再检查一次" : stopped === "empty" ? "继续查找" : "重试加载";
        return;
      }
      if (state.checking) { write("正在筛选页面视频…"); return; }
      if (!force && !nearEnd()) { write("继续向下滚动会自动加载"); return; }
      busy = true;
      button.disabled = true;
      write("正在加载下一批推荐…");
      const token = generation;
      try {
        const response = await options.fetchCandidates({batch});
        if (token !== generation || !options.getState().enabled) return;
        if (!Array.isArray(response?.items)) throw new Error("推荐接口未返回有效视频列表");
        batch += 1;
        const fresh = response.items.filter(item => {
          const bvid = item?.bvid;
          if (typeof bvid !== "string" || !/^BV[0-9A-Za-z]{10}$/.test(bvid) || seen.has(bvid)) return false;
          seen.add(bvid);
          return true;
        });
        if (fresh.length) {
          awaiting = fresh.map(item => item.bvid);
          options.appendCandidates(grid, fresh);
        } else emptyBatches += 1;
        if (response.noMore === true) stopped = "end";
        options.onChange?.();
      } catch (error) {
        if (token !== generation || !options.getState().enabled) return;
        stopped = "error";
        stopMessage = `加载失败：${error.message}`;
        write(stopMessage);
        options.onError?.(error);
      } finally {
        if (token === generation) {
          busy = false;
          if (button) button.disabled = false;
          // 成功的新页或新筛选结果才推动后续加载；错误不自行重试。
          void update();
        }
      }
    }

    function resume() {
      stopped = "";
      stopMessage = "";
      emptyBatches = 0;
      options.onResume?.();
      return update(true);
    }
    return {update, clear, resume};
  }
  return {create, EMPTY_BATCH_LIMIT};
});
