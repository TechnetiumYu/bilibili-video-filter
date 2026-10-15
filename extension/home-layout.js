(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliHomeLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 首页轮播跨两行，其高度依赖右侧视频撑起网格。display:none 隐藏视频后，
  // 自动行高会塌缩。临时恢复原生卡片的布局贡献，测量后在同一任务内还原过滤。
  // 不固定宽度或图片比例，保留 B站自身的响应式尺寸。
  function preserve(document) {
    const view = document.defaultView;
    for (const carousel of document.querySelectorAll(".recommended-swipe")) {
      const grid = carousel.parentElement;
      if (!grid || !view.getComputedStyle(grid).display.includes("grid")) continue;
      const cards = [...grid.children].filter(child => child !== carousel
        && (child.matches(".feed-card, .bili-video-card") || child.querySelector(".bili-video-card")));
      if (!cards.length) continue;
      const saved = [];
      const actions = [];
      const wasPinned = carousel.hasAttribute("data-bvf-home-layout");
      let height = 0;
      try {
        carousel.removeAttribute("data-bvf-home-layout");
        for (const card of cards) {
          // 可能是嵌套卡片，内外层都要恢复本来的行高。
          for (const node of [card, ...card.querySelectorAll("[data-bvf-state]")]) {
            if (!node.hasAttribute("data-bvf-state")) continue;
            saved.push([node, node.getAttribute("data-bvf-state")]);
            node.removeAttribute("data-bvf-state");
          }
          for (const action of card.querySelectorAll(".bvf-card-actions")) {
            actions.push([action, action.style.getPropertyValue("display"), action.style.getPropertyPriority("display")]);
            action.style.setProperty("display", "none", "important");
          }
        }
        height = carousel.getBoundingClientRect().height;
      } finally {
        for (const [node, state] of saved) node.setAttribute("data-bvf-state", state);
        for (const [node, display, priority] of actions) {
          if (display) node.style.setProperty("display", display, priority);
          else node.style.removeProperty("display");
        }
        if (height > 0) {
          carousel.style.setProperty("--bvf-home-height", `${height}px`);
          carousel.setAttribute("data-bvf-home-layout", "");
        } else if (wasPinned) carousel.setAttribute("data-bvf-home-layout", "");
      }
    }
  }

  function clear(document) {
    for (const carousel of document.querySelectorAll("[data-bvf-home-layout]")) {
      carousel.removeAttribute("data-bvf-home-layout");
      carousel.style.removeProperty("--bvf-home-height");
    }
  }
  return {preserve, clear};
});
