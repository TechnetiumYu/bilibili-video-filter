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
  } finally { await browser.close(); }
});
