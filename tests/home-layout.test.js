const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const {chromium} = require("playwright-core");

// 本地静态夹具，验证浏览器真实网格尺寸；不访问用户浏览器或任何网站。
test("首页轮播在全部视频被隐藏后保持原生高度，并随窗口响应式缩放", async t => {
  const executablePath = process.env.BVF_TEST_BROWSER || [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome",
  ].find(candidate => fs.existsSync(candidate));
  if (!executablePath) { t.skip("设置 BVF_TEST_BROWSER 指向 Chromium/Edge 可运行布局回归测试"); return; }
  const browser = await chromium.launch({executablePath, headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    const root = path.join(__dirname, "../extension");
    await page.setContent(`<!doctype html><html><head><style>
      body {margin:24px}
      .grid {display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:20px}
      .recommended-swipe {grid-area:1/1/3/3;position:relative;min-height:70px;background:#ccc}
      .slide {position:absolute;inset:0;background:linear-gradient(#b9d7fa,#6c5140)}
      .feed-card {align-self:start}
      .bili-video-card::before {content:'';display:block;aspect-ratio:16/9;background:#ddd}
      .native-title {height:48px}
      @media (max-width:1100px) {.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
      @media (max-width:800px) {.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
      </style></head><body><div class="grid">
        <div class="recommended-swipe"><div class="slide video-item">原生轮播内容</div></div>
        ${Array.from({length: 8}, () => '<div class="feed-card"><div class="bili-video-card"><div class="native-title">原生标题</div></div></div>').join("")}
      </div></body></html>`);
    await page.addStyleTag({path: path.join(root, "content.css")});
    await page.addScriptTag({path: path.join(root, "home-layout.js")});
    await page.addScriptTag({path: path.join(root, "page-adapter.js")});
    const initial = await page.locator(".recommended-swipe").boundingBox();
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-bvf-active", "");
      document.querySelectorAll(".feed-card").forEach(card => { card.dataset.bvfState = "rejected"; });
    });
    const collapsed = await page.locator(".recommended-swipe").boundingBox();
    assert.ok(collapsed.height < initial.height / 2, "夹具应能复现旧代码导致的轮播塌缩");

    const measurements = [];
    for (const width of [1440, 1000, 740, 1440]) {
      await page.setViewportSize({width, height: 900});
      const measurement = await page.evaluate(() => {
        const carousel = document.querySelector(".recommended-swipe");
        const cards = [...document.querySelectorAll(".feed-card")];
        BiliHomeLayout.clear(document);
        cards.forEach(card => card.removeAttribute("data-bvf-state"));
        const native = carousel.getBoundingClientRect().toJSON();
        cards.forEach(card => { card.dataset.bvfState = "rejected"; });
        BiliHomeLayout.preserve(document);
        BiliHomeLayout.preserve(document); // 重复扫描不能累计高度。
        return {native, filtered: carousel.getBoundingClientRect().toJSON(),
          hidden: cards.every(card => getComputedStyle(card).display === "none"),
          carouselVisible: getComputedStyle(carousel.querySelector(".slide")).visibility,
          cardCount: BiliPageAdapter.cards(document).length};
      });
      assert.ok(Math.abs(measurement.native.height - measurement.filtered.height) < 1,
        `${width}px 宽度下应恢复原生高度：${JSON.stringify(measurement)}`);
      assert.ok(Math.abs(measurement.native.width - measurement.filtered.width) < 1);
      assert.equal(measurement.hidden, true);
      assert.equal(measurement.carouselVisible, "visible");
      assert.equal(measurement.cardCount, 8, "轮播内部元素不能被识别为视频卡片");
      measurements.push({viewport: width, width: measurement.filtered.width, height: measurement.filtered.height});
    }
    await page.evaluate(() => {
      document.querySelectorAll(".feed-card").forEach(card => {
        card.dataset.bvfState = "accepted";
        card.querySelector(".bili-video-card").setAttribute("data-bvf-approved", "");
        const actions = document.createElement("div");
        actions.className = "bvf-card-actions";
        actions.style.cssText = "display:flex;height:32px";
        actions.textContent = "发布时间 / 标记待分析";
        card.append(actions);
      });
      BiliHomeLayout.preserve(document);
    });
    const afterActions = await page.locator(".recommended-swipe").boundingBox();
    assert.ok(Math.abs(afterActions.height - measurements[0].height) < 1,
      "部分卡片通过并增加操作栏时，轮播也不能被拉高");
    assert.equal(await page.locator(".bvf-card-actions").first().evaluate(el => el.style.display), "flex");
    t.diagnostic(JSON.stringify(measurements));
    await page.close();
    await t.test("显式网格位置中的通过视频按原顺序连续补位，待查项排到后面", async () => {
      const compactPage = await browser.newPage({viewport: {width: 1200, height: 900}});
      await compactPage.setContent(`<style>
        .grid{display:grid;grid-template-columns:repeat(5,180px);gap:20px}
        .recommended-swipe{grid-area:1/1/3/3;min-height:220px}
        .col_3{height:100px}.bili-video-card{height:100px}
      </style><div class="grid"><div class="recommended-swipe">轮播</div>
      ${["rejected", "pending", "error", "accepted", "rejected", "accepted", "accepted", "accepted"]
        .map((state, index) => {
          const row = index < 6 ? Math.floor(index / 3) + 1 : 3;
          const column = index < 6 ? index % 3 + 3 : index - 5;
          return `<div class="col_3" style="grid-row:${row};grid-column:${column}">
            <div class="bili-video-card" id="card-${index}" data-test-state="${state}"><a href="https://www.bilibili.com/video/BV1tG411M7Yb/">视频${index}</a></div></div>`;
        }).join("")}</div>`);
      await compactPage.addStyleTag({path: path.join(root, "content.css")});
      await compactPage.addScriptTag({path: path.join(root, "page-adapter.js")});
      const result = await compactPage.evaluate(() => {
        document.documentElement.setAttribute("data-bvf-active", "");
        const originals = [...document.querySelectorAll(".col_3")];
        const roots = BiliPageAdapter.cards(document);
        for (const node of roots) {
          node.dataset.bvfState = node.querySelector("[data-test-state]").dataset.testState;
          if (node.dataset.bvfState === "accepted") node.querySelector(".bili-video-card").setAttribute("data-bvf-approved", "");
        }
        BiliPageAdapter.compact(document, roots);
        const boxes = roots.filter(node => node.dataset.bvfState === "accepted").map(node => ({
          id: node.querySelector(".bili-video-card").id,
          x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y,
        }));
        const grid = document.querySelector(".grid").getBoundingClientRect();
        const pending = roots.find(node => node.dataset.bvfState === "pending").getBoundingClientRect();
        return {boxes, grid: {x: grid.x, y: grid.y}, pending: {x: pending.x, y: pending.y},
          collapsed: roots.filter(node => ["error", "rejected"].includes(node.dataset.bvfState))
            .every(node => node.getBoundingClientRect().width === 0 && node.getBoundingClientRect().height === 0),
          sameNodes: originals.every((node, index) => document.querySelectorAll(".col_3")[index] === node),
          roots: roots.map(node => node.className)};
      });
      assert.deepEqual(result.roots, Array(8).fill("col_3"), "必须隐藏实际列包装而不是仅隐藏内部卡片");
      assert.equal(result.collapsed, true);
      assert.equal(result.sameNodes, true, "保留B站框架持有的DOM节点与原始顺序");
      assert.deepEqual(result.boxes.map(box => box.id), ["card-3", "card-5", "card-6", "card-7"]);
      assert.ok(Math.abs(result.boxes[0].x - result.grid.x - 400) < 1);
      assert.ok(Math.abs(result.boxes[0].y - result.grid.y) < 1);
      assert.ok(Math.abs(result.boxes[1].x - result.boxes[0].x - 200) < 1);
      assert.ok(Math.abs(result.boxes[2].y - result.boxes[0].y) < 1);
      assert.ok(result.boxes[3].y > result.boxes[0].y);
      assert.ok(result.pending.y >= result.boxes[3].y, "待查占位不能插在已通过的视频之间");
      await compactPage.close();
    });
    await t.test("搜索结果外层列包装折叠后连续排列，退出时恢复原布局标记", async () => {
      const searchPage = await browser.newPage();
      await searchPage.setContent(`<style>.row{display:flex;flex-wrap:wrap;width:800px}.col{width:200px;height:120px}</style>
        <div class="row">${["rejected", "pending", "accepted", "error", "accepted"].map((state, index) =>
          `<div class="col" data-test-state="${state}"><div class="bili-video-card"><a href="/video/BV1tG411M7Yb">视频${index}</a></div></div>`).join("")}</div>`);
      await searchPage.addStyleTag({path: path.join(root, "content.css")});
      await searchPage.addScriptTag({path: path.join(root, "page-adapter.js")});
      const result = await searchPage.evaluate(() => {
        document.documentElement.setAttribute("data-bvf-active", "");
        const roots = BiliPageAdapter.cards(document);
        roots.forEach(node => { node.dataset.bvfState = node.dataset.testState; });
        BiliPageAdapter.compact(document, roots);
        const accepted = roots.filter(node => node.dataset.bvfState === "accepted").map(node => node.getBoundingClientRect().toJSON());
        const x = document.querySelector(".row").getBoundingClientRect().x;
        BiliPageAdapter.clearLayout(document);
        return {accepted, x, remaining: document.querySelectorAll("[data-bvf-flow], [data-bvf-item]").length};
      });
      assert.ok(Math.abs(result.accepted[0].x - result.x) < 1);
      assert.ok(Math.abs(result.accepted[1].x - result.x - 200) < 1);
      assert.equal(result.accepted[0].y, result.accepted[1].y);
      assert.equal(result.remaining, 0);
      await searchPage.close();
    });
    await t.test("仅视频模式保留合格轮播尺寸，全部拒绝后释放占位，关闭后恢复原轮播", async () => {
      const carouselPage = await browser.newPage({viewport: {width: 1440, height: 900}});
      await carouselPage.setContent(`<style>
        .grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:20px}
        .recommended-swipe{grid-area:1/1/3/3;position:relative;min-height:70px}
        .carousel-inner{position:absolute;inset:0}.carousel-item{height:100%}
        .feed-card{height:160px}.bili-video-card{height:100%}
        @media(max-width:1000px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
      </style><nav>导航与搜索框<input></nav><div class="grid">
        <div class="recommended-swipe"><div class="carousel-inner">
          <div class="carousel-item"><a href="https://live.bilibili.com/42">直播</a></div>
          <div class="carousel-item" id="valid-slide"><a href="https://www.bilibili.com/video/BV1tG411M7Yb">视频</a></div>
        </div><div class="carousel-footer">活动推广标题</div></div>
        ${Array.from({length: 6}, () => '<div class="feed-card"><div class="bili-video-card"><a href="https://www.bilibili.com/video/BV1tG411M7Yb">视频</a></div></div>').join("")}
        <div class="feed-card" id="product"><a href="https://show.bilibili.com/">商品</a></div>
      </div>`);
      await carouselPage.addStyleTag({path: path.join(root, "content.css")});
      for (const file of ["page-adapter.js", "home-layout.js", "carousel-filter.js"]) await carouselPage.addScriptTag({path: path.join(root, file)});
      for (const width of [1440, 900, 1440]) {
        await carouselPage.setViewportSize({width, height: 900});
        const measurement = await carouselPage.evaluate(() => {
          const carousel = document.querySelector(".recommended-swipe");
          BiliCarouselFilter.clear(document);
          BiliHomeLayout.clear(document);
          BiliPageAdapter.clearLayout(document);
          document.querySelectorAll("[data-bvf-state]").forEach(node => node.removeAttribute("data-bvf-state"));
          document.documentElement.removeAttribute("data-bvf-active");
          document.documentElement.removeAttribute("data-bvf-video-only");
          const native = carousel.getBoundingClientRect().toJSON();
          document.documentElement.setAttribute("data-bvf-active", "");
          document.documentElement.setAttribute("data-bvf-video-only", "");
          BiliHomeLayout.preserve(document);
          const cards = BiliPageAdapter.cards(document, true);
          cards.forEach(node => { node.dataset.bvfState = node.id === "product" ? "rejected" : "accepted"; node.querySelector(".bili-video-card")?.setAttribute("data-bvf-approved", ""); });
          BiliPageAdapter.compact(document, cards);
          BiliCarouselFilter.sync(document, [{carousel, root: document.querySelector("#valid-slide"), bvid: "BV1tG411M7Yb", status: "accepted", video: {bvid: "BV1tG411M7Yb", title: "合格视频"}}], true);
          BiliHomeLayout.preserve(document);
          const filtered = carousel.getBoundingClientRect().toJSON();
          const view = carousel.querySelector(".bvf-carousel-view").getBoundingClientRect().toJSON();
          const nativeHidden = getComputedStyle(carousel.querySelector(".carousel-footer")).visibility === "hidden";
          BiliCarouselFilter.sync(document, [], true);
          BiliHomeLayout.preserve(document); // 收起状态再次扫描不应丢失可恢复的原生高度。
          const hidden = carousel.getBoundingClientRect().height === 0;
          const grid = document.querySelector(".grid").getBoundingClientRect().toJSON();
          const first = cards[0].getBoundingClientRect().toJSON();
          BiliCarouselFilter.clear(document);
          const restored = carousel.getBoundingClientRect().toJSON();
          return {native, filtered, view, nativeHidden, hidden, grid, first, restored, navigation: getComputedStyle(document.querySelector("nav")).visibility};
        });
        assert.ok(Math.abs(measurement.native.height - measurement.filtered.height) < 1, `${width}px 应保留轮播高度`);
        assert.ok(Math.abs(measurement.filtered.width - measurement.view.width) < 1);
        assert.ok(Math.abs(measurement.filtered.height - measurement.view.height) < 1);
        assert.equal(measurement.nativeHidden, true);
        assert.equal(measurement.hidden, true);
        assert.equal(measurement.first.x, measurement.grid.x);
        assert.equal(measurement.first.y, measurement.grid.y);
        assert.ok(Math.abs(measurement.native.height - measurement.restored.height) < 1);
        assert.equal(measurement.navigation, "visible");
      }
      await carouselPage.close();
    });
  } finally { await browser.close(); }
});
