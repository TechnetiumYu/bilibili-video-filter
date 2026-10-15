(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliPageAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const CARD_SELECTOR = ".bili-video-card, .video-item, .video-list-item";

  function pageMode(href) {
    const url = new URL(href);
    if (url.hostname === "www.bilibili.com" && ["/", "/index.html"].includes(url.pathname)) return "feed";
    if (url.hostname === "search.bilibili.com" && ["/all", "/video", "/all/", "/video/", "/"].includes(url.pathname)) return "search";
    return null;
  }

  function videoId(card) {
    for (const link of card.querySelectorAll('a[href*="/video/"]')) {
      const match = link.getAttribute("href")?.match(/\/video\/(BV[0-9A-Za-z]{10})(?:[/?#]|$)/);
      if (match) return match[1];
    }
    return "";
  }

  function cards(document) {
    const unique = new Set();
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      if (card.closest(".recommended-swipe, .bili-banner, .bili-header__banner")) continue;
      // 首页 feed-card、搜索 video-list-item 是网格实际占位，隐藏外层才能收拢空位。
      let item = card.closest(".feed-card, .video-list-item, .video-item") || card;
      let probe = item;
      // 某些搜索布局在卡片外还有 col_* 列包装，必须折叠实际占位的外层。
      for (let depth = 0; depth < 4 && probe.parentElement && probe.parentElement !== document.body; depth += 1) {
        const parent = probe.parentElement;
        const style = document.defaultView.getComputedStyle(parent);
        if (style.display.includes("grid") || (style.display.includes("flex") && style.flexWrap === "wrap")) { item = probe; break; }
        const otherCard = [...parent.querySelectorAll(CARD_SELECTOR)]
          .some(candidate => !candidate.contains(item) && !item.contains(candidate));
        if (otherCard) break;
        probe = parent;
      }
      unique.add(item);
    }
    return [...unique];
  }

  function compact(document, roots) {
    const items = new Set(roots);
    const parents = new Set();
    for (const item of items) {
      const parent = item.parentElement;
      if (!parent) continue;
      const display = document.defaultView.getComputedStyle(parent).display;
      if (!display.includes("grid") && !display.includes("flex")) continue;
      parent.setAttribute("data-bvf-flow", "");
      item.setAttribute("data-bvf-item", "");
      parents.add(parent);
    }
    for (const old of document.querySelectorAll("[data-bvf-flow]")) {
      if (!parents.has(old)) old.removeAttribute("data-bvf-flow");
    }
    for (const old of document.querySelectorAll("[data-bvf-item]")) {
      if (!items.has(old)) old.removeAttribute("data-bvf-item");
    }
  }

  function clearLayout(document) {
    document.querySelectorAll("[data-bvf-flow]").forEach(node => node.removeAttribute("data-bvf-flow"));
    document.querySelectorAll("[data-bvf-item]").forEach(node => node.removeAttribute("data-bvf-item"));
  }
  return {CARD_SELECTOR, pageMode, videoId, cards, compact, clearLayout};
});
