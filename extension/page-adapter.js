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
      unique.add(card.closest(".feed-card, .video-list-item, .video-item") || card);
    }
    return [...unique];
  }
  return {CARD_SELECTOR, pageMode, videoId, cards};
});
