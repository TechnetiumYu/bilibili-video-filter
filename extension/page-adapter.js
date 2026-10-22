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
    return null;
  }

  function videoId(card) {
    for (const link of card.querySelectorAll('a[href*="/video/"]')) {
      const match = link.getAttribute("href")?.match(/\/video\/(BV[0-9A-Za-z]{10})(?:[/?#]|$)/);
      if (match) return match[1];
    }
    return "";
  }

  // 只信任内容的主跳转目标，不把外链参数里的 BV 号或 UP主页链接当作视频。
  function ordinaryVideoId(card) {
    const primary = card.matches("a[href]") ? card : card.querySelector("a.bili-video-card__image--link[href], a.bili-video-card__info--tit[href]");
    const links = primary ? [primary] : [...card.querySelectorAll("a[href]")].filter(link => {
      try { return new URL(link.getAttribute("href"), card.ownerDocument.URL).hostname !== "space.bilibili.com"; }
      catch (_) { return true; }
    });
    const link = links[0];
    if (!link) return "";
    try {
      const url = new URL(link.getAttribute("href"), card.ownerDocument.URL);
      if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "www.bilibili.com") return "";
      return url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/)?.[1] || "";
    } catch (_) { return ""; }
  }

  function cards(document, onlyVideos = false) {
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
    if (onlyVideos) {
      // 只扩展已识别的推荐网格与 feed-card，不扫描导航、横幅或任意页面链接。
      for (const card of document.querySelectorAll(".feed-card")) {
        if (!card.closest(".recommended-swipe, .bili-banner, .bili-header__banner")) unique.add(card);
      }
      const parents = new Set([...unique].map(item => item.parentElement));
      for (const carousel of document.querySelectorAll(".recommended-swipe")) parents.add(carousel.parentElement);
      for (const parent of parents) {
        if (!parent || parent === document.body) continue;
        const style = document.defaultView.getComputedStyle(parent);
        if (!style.display.includes("grid") && !(style.display.includes("flex") && style.flexWrap === "wrap")) continue;
        for (const child of parent.children) {
          if (child.matches(".recommended-swipe, .bili-banner, .bili-header__banner, script, style, template, nav, header, footer")) continue;
          unique.add(child);
        }
      }
      // 推荐 wrapper 内有旧版样式卡片时只保留外层占位，避免重复处理。
      for (const item of unique) {
        for (let parent = item.parentElement; parent; parent = parent.parentElement) {
          if (unique.has(parent)) { unique.delete(item); break; }
        }
      }
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
  return {CARD_SELECTOR, pageMode, videoId, ordinaryVideoId, cards, compact, clearLayout};
});
