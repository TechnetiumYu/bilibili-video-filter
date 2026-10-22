const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
const {chromium} = require("playwright-core");
const Core = require("../extension/filter-core.js");

const extension = path.join(__dirname, "../extension");
const html = fs.readFileSync(path.join(extension, "feed.html"), "utf8");
const source = name => fs.readFileSync(path.join(extension, name), "utf8");
const SETTINGS_KEY = "biliFilterSettingsV2";
const MARKS_KEY = "biliFilterMarkedVideosV1";
const UI_KEY = "biliFilterUiV1";
const A = "BV1tG411M7Yb", B = "BV1Vk4y147YL", C = "BV1Na41167N6";
const video = (bvid, extra = {}) => ({bvid, title: `正常视频 ${bvid}`, uploaderId: 42,
  uploaderName: "测试 UP", playCount: 12000, danmakuCount: 0, publishTime: 1669463590,
  duration: 125, ...extra});
const accepted = (bvid, extra) => ({bvid, status: "accepted", video: video(bvid, extra)});

async function until(check, message = "界面未按预期更新") {
  for (let n = 0; n < 100; n += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function harness(t, {storage, settings = {}, query = "", realUI = false, handle, width = 1440} = {}) {
  const store = storage || {[SETTINGS_KEY]: Core.normalizeSettings({...Core.DEFAULT_SETTINGS, continuousLoad: false, ...settings}), [MARKS_KEY]: {}};
  const dom = new JSDOM(html, {url: `https://extension.invalid/feed.html${query}`, runScripts: "outside-only", pretendToBeVisual: true});
  t.after(() => dom.window.close());
  const win = dom.window, doc = win.document, calls = [], writes = [], changes = [];
  Object.defineProperty(win, "innerWidth", {value: width, configurable: true});
  // 本组交互测试显式触发下一批，避免 jsdom 的零尺寸误触发连续加载。
  doc.getElementById("videoGrid").getBoundingClientRect = () => ({bottom: 10000});
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event("close")); };
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const area = {
    get(key, callback) { queueMicrotask(() => callback({[key]: clone(store[key])})); },
    set(values, callback) {
      writes.push(clone(values)); Object.assign(store, clone(values));
      queueMicrotask(() => callback?.());
    },
    remove(key, callback) { delete store[key]; queueMicrotask(() => callback?.()); },
  };
  win.chrome = {storage: {local: area, sync: {get(key, callback) { queueMicrotask(() => callback({})); }},
    onChanged: {addListener(listener) { changes.push(listener); }}}, runtime: {
    sendMessage(payload, callback) {
      calls.push(clone(payload));
      const response = handle ? handle(payload, callback, store) : payload.type === "bili-filter-home-candidates"
        ? {ok: true, items: [{bvid: A}], noMore: false}
        : {ok: true, results: (payload.bvids || []).map(bvid => accepted(bvid))};
      if (response !== undefined) Promise.resolve(response).then(value => queueMicrotask(() => callback(value)));
    },
  }};
  win.BiliFilterCore = Core;
  if (realUI) { win.eval(source("marked-core.js")); win.eval(source("feed.js")); }
  else {
    let current = Core.normalizeSettings(store[SETTINGS_KEY] || {...Core.DEFAULT_SETTINGS, continuousLoad: false});
    win.BiliSettingsUI = {
      isReady: () => true, getSettings: () => current, getMarked: () => store[MARKS_KEY] || {},
      openRules: () => doc.querySelector("#settingsDialog").showModal(),
      refreshMarks: async () => {},
      updateQuickSettings: async patch => {
        current = Core.normalizeSettings({...current, ...patch});
        await new Promise(resolve => area.set({[SETTINGS_KEY]: current}, resolve));
        win.dispatchEvent(new win.CustomEvent("bili-filter-settings-changed", {detail: current}));
      },
    };
  }
  win.eval(source("browse.js"));
  return {dom, win, doc, store, calls, writes, changes,
    element: id => doc.getElementById(id),
    dispatchSettings: next => win.dispatchEvent(new win.CustomEvent("bili-filter-settings-changed", {detail: Core.normalizeSettings(next)})),
  };
}

test("独立页侧栏切换只改变布局，保留视频节点和规则，独立偏好刷新恢复并正确转移焦点", async t => {
  const fixture = harness(t);
  const {element, calls, store, writes, doc} = fixture;
  await until(() => element("videoGrid").childElementCount === 1);
  const card = element("videoGrid").firstElementChild;
  const originalSettings = structuredClone(store[SETTINGS_KEY]);
  const originalMarks = structuredClone(store[MARKS_KEY]);
  const originalCalls = calls.length;
  element("collapseSidebar").focus(); element("collapseSidebar").click();
  assert.equal(element("filterSidebar").hidden, true);
  assert.equal(element("expandSidebar").hidden, false);
  assert.equal(doc.activeElement, element("expandSidebar"));
  for (const id of ["collapseSidebar", "expandSidebar", "toggleSidebarButton"]) assert.equal(element(id).getAttribute("aria-expanded"), "false");
  assert.equal(element("toggleSidebarButton").getAttribute("aria-label"), "展开筛选侧栏");
  assert.equal(element("videoGrid").firstElementChild, card);
  assert.equal(card.dataset.bvid, A);
  assert.deepEqual(store[SETTINGS_KEY], originalSettings);
  assert.deepEqual(store[MARKS_KEY], originalMarks);
  assert.equal(calls.length, originalCalls, "收起不能重新请求候选或改变筛选结果");
  assert.deepEqual(writes, [{[UI_KEY]: {sidebarCollapsed: true}}]);
  const reloaded = harness(t, {storage: structuredClone(store)});
  await until(() => reloaded.element("filterSidebar").hidden);
  assert.equal(reloaded.element("expandSidebar").hidden, false);
  element("expandSidebar").click();
  assert.equal(element("filterSidebar").hidden, false);
  assert.equal(doc.activeElement, element("collapseSidebar"));
  assert.equal(element("toggleSidebarButton").getAttribute("aria-expanded"), "true");
  assert.deepEqual(store[UI_KEY], {sidebarCollapsed: false});
});

test("独立页只渲染通过且 BV 对应的视频，未检查标题不泄漏，零弹幕与未知弹幕准确展示并可标记", async t => {
  let checkCallback;
  const fixture = harness(t, {handle(payload, callback) {
    if (payload.type === "bili-filter-home-candidates") return {ok: true, items: [
      {bvid: A, title: "候选标题不得提前展示"}, {bvid: B}, {bvid: C}, {bvid: A}, {bvid: "invalid"},
    ]};
    if (payload.type === "bili-filter-check-page") { checkCallback = callback; return; }
    if (payload.type === "bili-filter-mark-page") return {ok: true};
    throw new Error(`意外消息 ${payload.type}`);
  }});
  const {element, calls, doc} = fixture;
  await until(() => checkCallback);
  assert.equal(element("videoGrid").childElementCount, 0);
  assert.equal(doc.body.textContent.includes("候选标题不得提前展示"), false);
  assert.deepEqual(calls.find(call => call.type === "bili-filter-check-page"), {type: "bili-filter-check-page", bvids: [A, B, C], mode: "feed"});
  checkCallback({ok: true, results: [accepted(A), accepted(B, {danmakuCount: null}), {bvid: C, status: "rejected", video: video(C, {title: "不合格标题"})}]});
  await until(() => element("videoGrid").childElementCount === 2);
  assert.match(element("videoGrid").firstElementChild.textContent, /0 弹幕/);
  assert.match(element("videoGrid").lastElementChild.textContent, /弹幕量未知/);
  assert.equal(element("videoGrid").firstElementChild.querySelector(".video-metrics span:last-child").title, "弹幕量：0");
  assert.equal(element("videoGrid").textContent.includes("不合格标题"), false);
  assert.match(element("videoGrid").textContent, /2022-11-/);
  const mark = element("videoGrid").querySelector(".mark-video-button");
  assert.equal(mark.getAttribute("aria-pressed"), "false"); mark.click();
  await until(() => mark.getAttribute("aria-pressed") === "true");
  assert.equal(mark.disabled, true);
  assert.deepEqual(calls.find(call => call.type === "bili-filter-mark-page"), {type: "bili-filter-mark-page", bvid: A, context: {sourceMode: "feed"}});
});

test("不完整或错误 BV 的通过结果保持关闭，不展示元数据", async t => {
  const {element} = harness(t, {handle(payload) {
    return payload.type === "bili-filter-home-candidates" ? {ok: true, items: [{bvid: A}]}
      : {ok: true, results: [{bvid: A, status: "accepted", video: video(B, {title: "错误稿件"})}]};
  }});
  await until(() => !element("retryFeedButton").hidden);
  assert.equal(element("videoGrid").childElementCount, 0);
  assert.match(element("browseStatus").textContent, /检查结果不完整/);
});

test("HTTP 412 暂停后不因滚动或布局切换自动重试，可立即手动恢复", async t => {
  let attempts = 0;
  const {element, win, calls} = harness(t, {handle(payload) {
    if (payload.type === "bili-filter-home-candidates") return {ok: true, items: [{bvid: A}]};
    attempts += 1;
    return attempts === 1 ? {ok: true, results: [{bvid: A, status: "error", reasons: ["B站返回 HTTP 412"]}], rateLimited: true}
      : {ok: true, results: [accepted(A)]};
  }});
  await until(() => !element("retryFeedButton").hidden);
  assert.equal(element("videoGrid").childElementCount, 0);
  assert.match(element("browseStatus").textContent, /412/);
  win.dispatchEvent(new win.Event("scroll")); win.dispatchEvent(new win.Event("resize"));
  element("collapseSidebar").click();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(attempts, 1);
  element("retryFeedButton").click();
  await until(() => element("videoGrid").childElementCount === 1);
  assert.equal(attempts, 2);
  assert.equal(calls.filter(call => call.type === "bili-filter-home-candidates").length, 1, "重试复用待查 BV，不能再拉推荐");
});

test("真实设置页入口保留所有表单值，关闭弹窗前不请求推荐，保存规则使迟到结果失效", async t => {
  const initial = Core.normalizeSettings({...Core.DEFAULT_SETTINGS, continuousLoad: false, onlyVideos: false,
    blockedKeywords: ["保留关键词", "不覆盖"], minViews: 25000, maxViews: 900000, minFollowers: 60000, maxFollowers: null,
    keywordScopes: {title: true, description: false, tags: true, uploaderName: true},
    topicPolicies: [{id: "huawei", name: "华为", enabled: true, aliases: ["鸿蒙", "HarmonyOS"], minViews: 300000, minFollowers: 200000, confidenceGte: 0.85}],
    topicClassifier: {semanticEnabled: true, endpoint: "http://127.0.0.1:8989/v1/chat/completions", model: "local-qwen-27b", timeoutMs: 75000},
  });
  const callbacks = [];
  const fixture = harness(t, {realUI: true, query: "?settings=1", storage: {[SETTINGS_KEY]: initial, [MARKS_KEY]: {}}, handle(payload, callback) {
    if (payload.type === "bili-filter-home-candidates") return {ok: true, items: [{bvid: A}]};
    callbacks.push(callback);
  }});
  const {element, win, calls, store, doc} = fixture;
  await until(() => win.BiliSettingsUI.isReady());
  assert.equal(element("settingsDialog").open, true);
  assert.equal(calls.length, 0);
  assert.equal(element("blockedKeywords").value, initial.blockedKeywords.join("\n"));
  assert.equal(element("minViews").value, "25000");
  assert.equal(element("maxViews").value, "900000");
  assert.equal(element("minFollowers").value, "60000");
  assert.equal(element("maxFollowers").value, "");
  assert.equal(element("onlyVideos").checked, false);
  assert.equal(element("scopeDescription").checked, false);
  assert.equal(element("scopeUploader").checked, true);
  assert.equal(element("semanticEnabled").checked, true);
  assert.equal(element("classifierEndpoint").value, initial.topicClassifier.endpoint);
  assert.equal(element("classifierModel").value, initial.topicClassifier.model);
  assert.equal(doc.querySelector(".topic-name-input").value, "华为");
  assert.equal(doc.querySelector(".topic-aliases-input").value, "鸿蒙, HarmonyOS");
  assert.equal(doc.querySelector(".topic-min-views").value, "300000");
  assert.equal(doc.querySelector(".topic-confidence").value, "0.85");
  element("closeSettingsDialog").click();
  await until(() => callbacks.length === 1);
  element("editRulesButton").click();
  element("blockedKeywords").value = "新规则";
  element("settingsForm").dispatchEvent(new win.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => store[SETTINGS_KEY].blockedKeywords[0] === "新规则");
  callbacks[0]({ok: true, results: [accepted(A, {title: "旧规则迟到结果"})]});
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(element("videoGrid").childElementCount, 0);
  assert.equal(calls.filter(call => call.type === "bili-filter-home-candidates").length, 1, "规则弹窗开启时不能发新推荐请求");
  assert.equal(store[SETTINGS_KEY].topicClassifier.timeoutMs, 75000);
  assert.equal(store[SETTINGS_KEY].topicPolicies[0].aliases[0], "鸿蒙");
  element("closeSettingsDialog").click();
  await until(() => callbacks.length === 2);
  callbacks[1]({ok: true, results: [accepted(A, {title: "新规则合格视频"})]});
  await until(() => element("videoGrid").childElementCount === 1);
  assert.match(element("videoGrid").textContent, /新规则合格视频/);
  assert.doesNotMatch(element("videoGrid").textContent, /迟到/);
});

test("关闭连续加载不会清空已通过视频或重置推荐批次，手动加载仍可用", async t => {
  let batches = 0;
  const {element, calls, win} = harness(t, {settings: {continuousLoad: true}, handle(payload) {
    if (payload.type === "bili-filter-home-candidates") return {ok: true, items: [{bvid: ++batches === 1 ? A : B}]};
    return {ok: true, results: payload.bvids.map(bvid => accepted(bvid))};
  }});
  await until(() => element("videoGrid").childElementCount === 1);
  const original = element("videoGrid").firstElementChild;
  element("quickContinuousLoad").checked = false;
  element("quickContinuousLoad").dispatchEvent(new win.Event("change"));
  await until(() => !element("quickContinuousLoad").disabled);
  assert.equal(element("videoGrid").firstElementChild, original);
  assert.equal(batches, 1);
  element("loadMoreButton").click();
  await until(() => element("videoGrid").childElementCount === 2);
  assert.equal(element("videoGrid").firstElementChild, original);
  assert.deepEqual(calls.filter(call => call.type === "bili-filter-home-candidates").map(call => call.options.batch), [1, 2]);
});

test("最后一批推荐被隐藏标签页或规则弹窗打断后，关闭连续加载也会恢复未检查候选", async t => {
  for (const interruption of ["hidden", "dialog"]) await t.test(interruption, async subtest => {
    const ids = Array.from({length: 20}, (_, index) => `BV${String(index + 1).padStart(10, "0")}`);
    let releaseFirst;
    const {win, doc, element, calls} = harness(subtest, {handle(payload, callback) {
      if (payload.type === "bili-filter-home-candidates") return {ok: true, items: ids.map(bvid => ({bvid})), noMore: true};
      if (!releaseFirst) {
        releaseFirst = () => callback({ok: true, results: payload.bvids.map(bvid => accepted(bvid))});
        return;
      }
      return {ok: true, results: payload.bvids.map(bvid => accepted(bvid))};
    }});
    await until(() => releaseFirst);
    assert.equal(element("quickContinuousLoad").checked, false);
    if (interruption === "hidden") Object.defineProperty(doc, "visibilityState", {value: "hidden", configurable: true});
    else element("settingsDialog").showModal();
    releaseFirst();
    await until(() => element("videoGrid").childElementCount === 8 && !element("loadMoreButton").disabled);
    const firstCards = [...element("videoGrid").children];
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(calls.filter(call => call.type === "bili-filter-check-page").length, 1,
      "后台或规则弹窗中暂停剩余 12 个候选，不能继续请求");
    if (interruption === "hidden") {
      Object.defineProperty(doc, "visibilityState", {value: "visible", configurable: true});
      doc.dispatchEvent(new win.Event("visibilitychange"));
    } else element("settingsDialog").close();
    await until(() => element("videoGrid").childElementCount === 20 && !element("loadMoreButton").disabled);
    assert.deepEqual(calls.filter(call => call.type === "bili-filter-check-page").map(call => call.bvids.length), [8, 8, 4]);
    assert.equal(calls.filter(call => call.type === "bili-filter-home-candidates").length, 1,
      "noMore=true 后恢复只能排空待查候选，不能再次拉取推荐");
    assert.deepEqual([...element("videoGrid").children].map(card => card.dataset.bvid), ids);
    assert.ok(firstCards.every((card, index) => element("videoGrid").children[index] === card), "恢复不能重建已经通过的卡片");
    assert.match(element("browseStatus").textContent, /暂时没有更多推荐/);
  });
});

test("窄屏初始收起，Escape 收起侧栏但不影响规则弹窗", async t => {
  const {win, element} = harness(t, {width: 740});
  assert.equal(element("filterSidebar").hidden, true);
  element("expandSidebar").click();
  element("editRulesButton").click();
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape"}));
  assert.equal(element("filterSidebar").hidden, false);
  element("settingsDialog").close();
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape"}));
  assert.equal(element("filterSidebar").hidden, true);
});

test("极简布局在真实浏览器中为 248px 侧栏与三列，折叠释放宽度且窄屏无横向溢出", async t => {
  const executablePath = process.env.BVF_TEST_BROWSER || [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome",
  ].find(candidate => fs.existsSync(candidate));
  if (!executablePath) { t.skip("设置 BVF_TEST_BROWSER 指向 Chromium/Edge 可运行布局回归测试"); return; }
  const browser = await chromium.launch({executablePath, headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  await page.setContent(html.replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g, "").replace(/<link[^>]*href="feed.css"[^>]*>/, ""));
  await page.addStyleTag({path: path.join(extension, "feed.css")});
  await page.addScriptTag({path: path.join(extension, "filter-core.js")});
  await page.evaluate(() => {
    const settings = BiliFilterCore.normalizeSettings({...BiliFilterCore.DEFAULT_SETTINGS, continuousLoad: false});
    window.chrome = {runtime: {sendMessage(payload, callback) {
      callback(payload.type === "bili-filter-home-candidates" ? {ok: true, items: [{bvid: "BV1tG411M7Yb"}, {bvid: "BV1Vk4y147YL"}, {bvid: "BV1Na41167N6"}]}
        : {ok: true, results: payload.bvids.map(bvid => ({bvid, status: "accepted", video: {bvid, title: "本地测试视频", uploaderName: "UP 主", playCount: 25000, danmakuCount: 123, duration: 185, publishTime: 1669463590}}))});
    }}, storage: {local: {get(key, callback) { callback({}); }, set(data, callback) { callback?.(); }}}};
    window.BiliSettingsUI = {isReady: () => true, getSettings: () => settings, getMarked: () => ({}), openRules() {}, refreshMarks: async () => {}};
  });
  await page.addScriptTag({path: path.join(extension, "browse.js")});
  await page.waitForSelector(".video-card");
  const measure = () => page.evaluate(() => ({
    sidebar: document.getElementById("filterSidebar").getBoundingClientRect().width,
    main: document.querySelector(".browse-section").getBoundingClientRect().width,
    columns: getComputedStyle(document.getElementById("videoGrid")).gridTemplateColumns.split(" ").length,
    overflow: document.documentElement.scrollWidth > innerWidth,
    cards: [...document.querySelectorAll(".video-card")].map(card => card.dataset.bvid),
    headings: [...document.querySelectorAll(".video-card-heading")].map(heading => ({
      height: heading.getBoundingClientRect().height,
      titleWidth: heading.querySelector(".video-title").getBoundingClientRect().width,
      markWidth: heading.querySelector(".mark-video-button").getBoundingClientRect().width,
      iconWidth: heading.querySelector("svg").getBoundingClientRect().width,
      iconHeight: heading.querySelector("svg").getBoundingClientRect().height,
    })),
  }));
  const checkIcons = measurement => {
    for (const heading of measurement.headings) {
      assert.equal(heading.iconWidth, 18);
      assert.equal(heading.iconHeight, 18);
      assert.ok(heading.titleWidth > 0, "视频标题应保留可见区域");
      assert.ok(heading.markWidth <= 30, "标记按钮不能被 SVG 默认尺寸撑开");
      assert.ok(heading.height < 65, "18px 图标不能以默认 300×150 撑高标题区域");
    }
  };
  const expanded = await measure();
  assert.equal(expanded.sidebar, 248);
  assert.equal(expanded.columns, 3);
  assert.equal(expanded.overflow, false);
  checkIcons(expanded);
  await page.locator("#collapseSidebar").click();
  const collapsed = await measure();
  assert.equal(collapsed.sidebar, 0);
  assert.ok(collapsed.main > expanded.main + 250);
  assert.deepEqual(collapsed.cards, expanded.cards);
  checkIcons(collapsed);
  await page.locator("#expandSidebar").click();
  assert.equal((await measure()).main, expanded.main);
  for (const width of [740, 390]) {
    await page.setViewportSize({width, height: 900});
    await page.locator("#toggleSidebarButton").click();
    const narrow = await measure();
    assert.equal(narrow.overflow, false, `${width}px 不能横向溢出`);
    assert.equal(narrow.columns, width === 390 ? 1 : 3);
    checkIcons(narrow);
  }
  assert.deepEqual(errors, []);
});
