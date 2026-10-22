const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright-core");

test("首页连续加载的完整内容脚本：筛选后补齐、滚动续页、去重、标记和退出", async t => {
  const executablePath = process.env.BVF_TEST_BROWSER || [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome",
  ].find(candidate => fs.existsSync(candidate));
  if (!executablePath) { t.skip("需 Chromium/Edge 验证完整内容脚本"); return; }
  const browser = await chromium.launch({executablePath, headless: true});
  const root = path.join(__dirname, "../extension");
  const page = await browser.newPage({viewport: {width: 1100, height: 700}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("https://www.bilibili.com/**", route => route.fulfill({contentType: "text/html", body: `<!doctype html><style>
      body{margin:24px}.native-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
      .bili-video-card{min-height:160px}nav{height:100px}
    </style><nav>原生导航与搜索<input placeholder="搜索"></nav><main><div class="native-grid">
      <div class="feed-card"><div class="bili-video-card"><a href="/video/BV0000000001">待过滤视频</a></div></div>
    </div></main>`}));
    await page.goto("https://www.bilibili.com/");
    await page.evaluate(() => {
      window.requestLog = [];
      window.storageListeners = [];
      window.filterBlocked = false;
      window.candidateBlocked = false;
      window.activeCandidates = 0;
      window.maxCandidates = 0;
      window.chrome = {
        runtime: {sendMessage(payload, callback) {
          requestLog.push(payload);
          if (payload.type === "bili-filter-home-candidates") {
            activeCandidates += 1;
            maxCandidates = Math.max(maxCandidates, activeCandidates);
          }
          setTimeout(() => {
            if (payload.type === "bili-filter-home-candidates") {
              activeCandidates -= 1;
              const batch = payload.options.batch;
              callback(candidateBlocked ? {ok: false, status: 412, biliRateLimited: true, error: "推荐接口 HTTP 412"} :
                {ok: true, items: Array.from({length: 20}, (_, index) => ({bvid: `BV${String(batch * 20 + index).padStart(10, "0")}`, title: "未确认的候选标题"})), noMore: batch >= 4});
            } else if (payload.type === "bili-filter-check-page") callback({ok: true, rateLimited: filterBlocked,
              results: payload.bvids.map(bvid => ({bvid, status: filterBlocked ? "error" : Number(bvid.slice(2)) % 4 === 0 ? "accepted" : "rejected",
                reasons: filterBlocked ? ["HTTP 412"] : [], video: {bvid, title: `准确标题${bvid}`, uploaderId: "42", uploaderName: "测试UP", publishTime: 1669463590, playCount: 20000,
                  danmakuCount: Number(bvid.slice(2)) % 3 === 0 ? 0 : Number(bvid.slice(2)) % 3 === 1 ? 12345 : undefined}}))});
            else callback({ok: true});
          }, 5);
        }},
        storage: {local: {get: async () => ({biliFilterSettingsV2: {onlyVideos: true, continuousLoad: true}})},
          onChanged: {addListener(listener) { storageListeners.push(listener); }}},
      };
    });
    for (const file of ["page-adapter.js", "home-layout.js", "carousel-filter.js", "home-stream.js", "content.js"]) await page.addScriptTag({path: path.join(root, file)});
    await page.addStyleTag({path: path.join(root, "content.css")});
    await page.waitForFunction(() => document.querySelectorAll('.bvf-stream-card[data-bvf-state="accepted"]').length >= 5);
    assert.equal(await page.locator(".native-grid > .feed-card").getAttribute("data-bvf-state"), "rejected");
    assert.equal(await page.locator(".bvf-home-stream").count(), 1);
    assert.equal(await page.locator(".bvf-home-stream").getAttribute("data-bvf-state"), null, "托管区外层不能被误当作非视频隐藏");
    assert.equal(await page.locator(".bvf-home-stream").isVisible(), true);
    assert.equal(await page.locator("nav input").isVisible(), true);
    assert.match(await page.locator('.bvf-stream-card[data-bvf-state="accepted"] .bvf-stream-title').first().textContent(), /^准确标题/);
    assert.equal(await page.getByText("未确认的候选标题", {exact: true}).count(), 0);
    for (const [bvid, expectedText, exactCount] of [
      ["BV0000000024", "0 弹幕", 0],
      ["BV0000000028", "1.2万 弹幕", 12345],
      ["BV0000000020", "弹幕量未知", undefined],
    ]) {
      const cover = page.locator(`.bvf-stream-card[data-bvf-stream-bvid="${bvid}"] .bvf-stream-cover`);
      const plays = cover.locator(".bvf-stream-play-count");
      const danmaku = cover.locator(".bvf-stream-danmaku-count");
      assert.equal(await plays.count(), 1, "播放量必须是封面中的独立数值");
      assert.equal(await danmaku.count(), 1, "弹幕量必须是封面中的独立数值");
      assert.equal(await plays.textContent(), "2.0万 播放");
      assert.equal(await danmaku.textContent(), expectedText);
      assert.equal(await danmaku.isVisible(), true);
      const coverBox = await cover.boundingBox();
      const playBox = await plays.boundingBox();
      const danmakuBox = await danmaku.boundingBox();
      assert.ok(coverBox && playBox && danmakuBox, "封面及两个统计值都应占据可见区域");
      for (const box of [playBox, danmakuBox]) {
        assert.ok(box.width > 0 && box.height > 0);
        assert.ok(box.x >= coverBox.x - 1 && box.y >= coverBox.y - 1
          && box.x + box.width <= coverBox.x + coverBox.width + 1
          && box.y + box.height <= coverBox.y + coverBox.height + 1, "统计值不能溢出封面");
      }
      assert.ok(playBox.x + playBox.width <= danmakuBox.x + 1 || danmakuBox.x + danmakuBox.width <= playBox.x + 1
        || playBox.y + playBox.height <= danmakuBox.y + 1 || danmakuBox.y + danmakuBox.height <= playBox.y + 1,
      "播放量与弹幕量不能相互重叠");
      if (exactCount !== undefined) {
        assert.match(await danmaku.getAttribute("title") || "", new RegExp(`\\b${exactCount}\\b`), "悬停提示保留完整弹幕整数");
      } else {
        assert.doesNotMatch(await danmaku.textContent(), /^0\b/, "未知弹幕量不能冒充为零");
      }
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(100);
      if (await page.evaluate(() => requestLog.filter(call => call.type === "bili-filter-home-candidates").length >= 4)
        && await page.locator('.bvf-stream-card[data-bvf-state="pending"]').count() === 0) break;
    }
    await page.waitForFunction(() => document.querySelector(".bvf-stream-footer")?.textContent.includes("没有更多"));
    const requests = await page.evaluate(() => requestLog.filter(call => call.type === "bili-filter-home-candidates").map(call => call.options.batch));
    assert.deepEqual(requests, [1, 2, 3, 4]);
    assert.equal(await page.evaluate(() => maxCandidates), 1);
    const cards = await page.locator('.bvf-stream-card[data-bvf-state="accepted"]').evaluateAll(nodes => nodes.map(node => node.dataset.bvfStreamBvid));
    assert.equal(cards.length, 20);
    assert.equal(new Set(cards).size, 20);
    await page.locator('.bvf-stream-card[data-bvf-state="accepted"] .bvf-card-actions button').first().click();
    await page.waitForFunction(() => requestLog.some(call => call.type === "bili-filter-mark-page"));
    await page.evaluate(() => {
      const node = document.createElement("div");
      node.className = "feed-card";
      node.innerHTML = '<div class="bili-video-card"><a href="/video/BV0000000020">原生重复视频</a></div>';
      document.querySelector(".native-grid").append(node);
    });
    await page.waitForFunction(() => !document.querySelector('.bvf-stream-card[data-bvf-stream-bvid="BV0000000020"]'));
    await page.evaluate(() => {
      history.pushState({}, "", "/video/BV1tG411M7Yb");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    assert.equal(await page.locator(".bvf-home-stream").count(), 0);
    const before = await page.evaluate(() => requestLog.length);
    await page.evaluate(() => dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => requestLog.length), before);
    await page.evaluate(() => {
      candidateBlocked = true;
      history.pushState({}, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
      window.scrollTo(0, 0);
    });
    await page.waitForFunction(() => document.querySelector(".bvf-stream-footer")?.textContent.includes("暂停"));
    const blockedCalls = await page.evaluate(() => requestLog.filter(call => call.type === "bili-filter-home-candidates").length);
    await page.evaluate(() => dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => requestLog.filter(call => call.type === "bili-filter-home-candidates").length), blockedCalls, "412 后不能自动重试");
    await page.evaluate(() => { candidateBlocked = false; });
    await page.locator(".bvf-stream-footer button").click();
    await page.waitForFunction(() => document.querySelector('.bvf-stream-card[data-bvf-state="accepted"]'));
    assert.deepEqual(await page.evaluate(() => requestLog.filter(call => call.type === "bili-filter-home-candidates").slice(4, 6).map(call => call.options.batch)), [1, 1], "手动重试仍加载之前失败的批次");
    await page.evaluate(() => storageListeners[0]({biliFilterSettingsV2: {newValue: {onlyVideos: true, continuousLoad: false}}}, "local"));
    assert.equal(await page.locator(".bvf-home-stream").count(), 0);
    await page.waitForTimeout(40);
    const hiddenBefore = await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {value: "hidden", configurable: true});
      storageListeners[0]({biliFilterSettingsV2: {newValue: {onlyVideos: true, continuousLoad: true}}}, "local");
      document.dispatchEvent(new Event("visibilitychange"));
      return requestLog.length;
    });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => requestLog.length), hiddenBefore, "隐藏页不启动推荐或新的补查批次");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {value: "visible", configurable: true});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(before => requestLog.length > before, hiddenBefore);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
