(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliCarouselFilter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const views = new WeakMap();

  function entries(document) {
    const result = [];
    for (const carousel of document.querySelectorAll(".recommended-swipe")) {
      // 轮播原始节点不移动、不删除；循环轮播产生的重复项由后台 BV 缓存去重。
      const slides = [...carousel.querySelectorAll(".carousel-item, .carousel-slide, [data-carousel-item]")]
        .filter(node => !node.closest(".bvf-carousel-view"));
      const roots = slides.length ? slides : [...carousel.querySelectorAll("a[href]")]
        .filter(node => !node.closest(".bvf-carousel-view"));
      for (const root of roots) result.push({root, carousel});
    }
    return result;
  }

  function clear(document) {
    document.querySelectorAll("[data-bvf-carousel-filtered], [data-bvf-carousel-empty]").forEach(carousel => {
      carousel.removeAttribute("data-bvf-carousel-filtered");
      carousel.removeAttribute("data-bvf-carousel-empty");
      carousel.querySelector(":scope > .bvf-carousel-view")?.remove();
      views.delete(carousel);
    });
  }

  function sync(document, records, enabled) {
    if (!enabled) { clear(document); return; }
    for (const carousel of document.querySelectorAll(".recommended-swipe")) {
      carousel.setAttribute("data-bvf-carousel-filtered", "");
      const videos = new Map();
      for (const record of records) {
        if (record.carousel === carousel && record.status === "accepted" && record.video) videos.set(record.bvid, record.video);
      }
      const accepted = [...videos.values()];
      carousel.toggleAttribute("data-bvf-carousel-empty", !accepted.length);
      const signature = JSON.stringify(accepted.map(video => [video.bvid, video.title, video.coverUrl]));
      const previous = views.get(carousel);
      if (previous?.signature === signature && previous.view.isConnected) continue;
      carousel.querySelector(":scope > .bvf-carousel-view")?.remove();
      const view = document.createElement("div");
      view.className = "bvf-carousel-view";
      views.set(carousel, {signature, view});
      if (!accepted.length) continue;
      const link = document.createElement("a");
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const image = document.createElement("img");
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      const title = document.createElement("span");
      link.append(image, title);
      const controls = document.createElement("div");
      controls.className = "bvf-carousel-controls";
      const count = document.createElement("span");
      let index = 0;
      function show() {
        const video = accepted[index];
        link.href = `https://www.bilibili.com/video/${video.bvid}`;
        title.textContent = video.title || video.bvid;
        const cover = String(video.coverUrl || "").replace(/^http:/, "https:");
        if (/^https:\/\//.test(cover)) image.src = cover;
        else image.removeAttribute("src");
        count.textContent = `${index + 1} / ${accepted.length}`;
      }
      for (const [text, step] of [["上一个", -1], ["下一个", 1]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.disabled = accepted.length < 2;
        button.addEventListener("click", event => {
          event.stopPropagation();
          index = (index + step + accepted.length) % accepted.length;
          show();
        });
        controls.append(button);
      }
      controls.prepend(count);
      view.append(link, controls);
      carousel.append(view);
      show();
    }
  }
  return {entries, sync, clear};
});
