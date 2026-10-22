const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const {webcrypto} = require("node:crypto");
const {JSDOM} = require("jsdom");
const Core = require("../extension/filter-core.js");
const Adapter = require("../extension/page-adapter.js");
const extension = path.join(__dirname, "../extension");
const BV_A = "BV1tG411M7Yb";
const BV_B = "BV1Vk4y147YL";
const BV_C = "BV1Na41167N6";

function background(settings = {}, fetchOverride) {
  const storage = {biliFilterSettingsV2: Core.normalizeSettings({...Core.DEFAULT_SETTINGS, ...settings})};
  const calls = [];
  const listeners = [];
  const area = {
    get: async key => structuredClone({[key]: storage[key]}),
    set: async data => Object.assign(storage, structuredClone(data)),
    remove: async keys => { for (const key of [].concat(keys)) delete storage[key]; },
  };
  const sandbox = vm.createContext({
    console, TextEncoder, URL, URLSearchParams, AbortController, AbortSignal,
    crypto: webcrypto, setTimeout, clearTimeout,
    chrome: {storage: {local: area, sync: area},
      action: {onClicked: {addListener() {}}},
      runtime: {onMessage: {addListener(fn) { listeners.push(fn); }}, openOptionsPage: async () => {}},
    },
    fetch: async (url, options) => {
      calls.push(url);
      if (fetchOverride) {
        const custom = fetchOverride(url, options);
        if (custom) return custom;
      }
      const parsed = new URL(url);
      let data;
      if (parsed.pathname === "/x/relation/stat") data = {follower: 20000};
      else if (parsed.pathname === "/x/web-interface/view/detail") {
        const bvid = parsed.searchParams.get("bvid");
        data = {View: {bvid, title: bvid === BV_B ? "彻底破防了" : "鸿蒙使用技巧",
          desc: "正常简介", owner: {mid: 42, name: "测试UP"}, stat: {view: 20000},
          tid: 95, tname: "数码", pubdate: 1669463590}, Tags: [{tag_name: "鸿蒙"}]};
      } else throw new Error(`意外请求 ${url}`);
      return {ok: true, status: 200, json: async () => ({code: 0, data})};
    },
  });
  sandbox.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync(path.join(extension, name), "utf8"), sandbox));
  vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), sandbox);
  const request = payload => new Promise(resolve => listeners[0](payload, {}, resolve));
  return {storage, calls, request};
}

test("原页面使用准确数据过滤，关键词拒绝不会继续查询粉丝，缓存避免重复请求", async () => {
  const bg = background();
  const response = await bg.request({type: "bili-filter-check-page", bvids: [BV_A, BV_B], mode: "feed"});
  assert.equal(response.ok, true);
  const accepted = response.results.find(x => x.bvid === BV_A);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.video.playCount, 20000);
  assert.deepEqual(Array.from(accepted.video.tags), ["鸿蒙"]);
  assert.equal(response.results.find(x => x.bvid === BV_B).status, "rejected");
  assert.equal(bg.calls.filter(x => x.includes("/x/relation/stat")).length, 1);
  const before = bg.calls.length;
  await bg.request({type: "bili-filter-check-page", bvids: [BV_A], mode: "feed"});
  assert.equal(bg.calls.length, before);
  const marked = await bg.request({type: "bili-filter-mark-page", bvid: BV_A, context: {sourceMode: "search", sourceQuery: "鸿蒙"}});
  assert.equal(marked.ok, true);
  assert.equal(bg.storage.biliFilterMarkedVideosV1[BV_A].title, "鸿蒙使用技巧");
  assert.equal(bg.storage.biliFilterMarkedVideosV1[BV_A].source.query, "鸿蒙");
});

test("原页面命中特殊话题更高门槛后直接拒绝", async () => {
  const bg = background({topicPolicies: [{id: "huawei", name: "华为", aliases: ["鸿蒙"], enabled: true, minViews: 100000}]});
  const response = await bg.request({type: "bili-filter-check-page", bvids: [BV_A], mode: "feed"});
  assert.equal(response.results[0].status, "rejected");
  assert.equal(bg.calls.some(x => x.includes("/x/relation/stat")), false);
});

test("本地模型失败不会退回无话题规则放行", async () => {
  const bg = background({topicPolicies: [{id: "huawei", name: "华为", enabled: true, minViews: 10000}],
    topicClassifier: {semanticEnabled: true, endpoint: "http://127.0.0.1:8000/v1/chat/completions", model: "test"}},
  url => url.startsWith("http://127.0.0.1") ? Promise.reject(new Error("模型未启动")) : null);
  const response = await bg.request({type: "bili-filter-check-page", bvids: [BV_A], mode: "feed"});
  assert.equal(response.results[0].status, "error");
  assert.match(response.results[0].reasons[0], /模型未启动/);
  assert.equal(bg.calls.some(x => x.includes("/x/relation/stat")), false);
});

test("更新样本备注与新增样本并发时均能保存", async () => {
  const bg = background();
  await bg.request({type: "bili-filter-mark-page", bvid: BV_A});
  await Promise.all([
    bg.request({type: "bili-filter-update-mark", bvid: BV_A, changes: {note: "保留此样本"}}),
    bg.request({type: "bili-filter-mark-page", bvid: BV_C}),
  ]);
  assert.equal(bg.storage.biliFilterMarkedVideosV1[BV_A].note, "保留此样本");
  assert.ok(bg.storage.biliFilterMarkedVideosV1[BV_C]);
});

test("412和不完整详情不会被缓存为通过，手动重试不受冷却限制", async () => {
  let blocked = true;
  const bg = background({}, url => url.includes("view/detail") && blocked
    ? {ok: false, status: 412} : null);
  const first = await bg.request({type: "bili-filter-check-page", bvids: [BV_A], mode: "feed"});
  assert.equal(first.results[0].status, "error");
  blocked = false;
  const retry = await bg.request({type: "bili-filter-check-page", bvids: [BV_A], mode: "feed"});
  assert.equal(retry.results[0].status, "accepted");
  const incomplete = background({}, () => ({ok: true, status: 200, json: async () => ({code: 0, data: {}})}));
  const result = await incomplete.request({type: "bili-filter-check-page", bvids: [BV_A], mode: "feed"});
  assert.equal(result.results[0].status, "error");
});

test("null和空字符串数值仍严格视为未知，不能以零绕过门槛", () => {
  for (const value of [null, undefined, ""]) {
    const result = Core.evaluate({playCount: value, followerCount: value, detailsAvailable: true}, {minViews: 0, minFollowers: 0});
    assert.equal(result.status, "rejected");
  }
});

test("页面适配仅允许首页推荐流，按外层网格识别卡片", () => {
  assert.equal(Adapter.pageMode("https://www.bilibili.com/"), "feed");
  assert.equal(Adapter.pageMode("https://www.bilibili.com/index.html?spm_id_from=test"), "feed");
  for (const url of excludedPages) assert.equal(Adapter.pageMode(url), null, url);
  const dom = new JSDOM(`<div class="feed-card"><div class="bili-video-card"><a href="//www.bilibili.com/video/${BV_A}/?x=1">标题</a></div></div>`);
  assert.equal(Adapter.cards(dom.window.document).length, 1);
  assert.equal(Adapter.cards(dom.window.document)[0].className, "feed-card");
  assert.equal(Adapter.videoId(Adapter.cards(dom.window.document)[0]), BV_A);
  dom.window.close();
});

const excludedPages = [
  "https://search.bilibili.com/?keyword=test",
  "https://search.bilibili.com/all?keyword=test",
  "https://search.bilibili.com/video/?keyword=test",
  "https://search.bilibili.com/bangumi?keyword=test",
  "https://space.bilibili.com/42",
  "https://space.bilibili.com/42/upload/video",
  "https://space.bilibili.com/42/search/video?keyword=test",
  `https://www.bilibili.com/video/${BV_A}`,
  "https://www.bilibili.com/v/dynamic",
  "https://t.bilibili.com/",
  "https://www.bilibili.com/medialist/play/ml42",
  "https://www.bilibili.com/account/history",
];

test("扩展声明不再向搜索域名或UP主空间注入脚本和样式", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts.flatMap(script => script.matches), ["https://www.bilibili.com/*"]);
});

function contentPage(handler, url = "https://www.bilibili.com/") {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="grid"></div></body></html>', {
    url, runScripts: "outside-only",
  });
  const win = dom.window;
  const changes = [];
  const calls = [];
  const shadowRoots = [];
  const attachShadow = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function (options) {
    const root = attachShadow.call(this, options);
    shadowRoots.push(root);
    return root;
  };
  win.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(target) { queueMicrotask(() => this.callback([{target, isIntersecting: true}])); }
    unobserve() {}
  };
  win.chrome = {
    runtime: {sendMessage(payload, callback) {
      calls.push(payload);
      Promise.resolve(handler(payload)).then(callback);
    }},
    storage: {local: {get: async () => ({})}, onChanged: {addListener(fn) { changes.push(fn); }}},
  };
  const style = win.document.createElement("style");
  style.textContent = fs.readFileSync(path.join(extension, "content.css"), "utf8");
  win.document.head.append(style);
  for (const file of ["page-adapter.js", "home-layout.js", "content.js"]) win.eval(fs.readFileSync(path.join(extension, file), "utf8"));
  const addCard = bvid => {
    const card = win.document.createElement("div");
    card.className = "feed-card";
    card.innerHTML = `<div class="bili-video-card"><a href="https://www.bilibili.com/video/${bvid}/">原生视频</a></div>`;
    win.document.querySelector("#grid").append(card);
    return card;
  };
  return {dom, win, changes, calls, addCard, shadowRoots};
}
const accepted = bvid => ({bvid, status: "accepted", video: {bvid, publishTime: 1669463590}});
async function until(check) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error("等待卡片状态超时");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("动态新增、重复BV去重、原生卡片替换、规则更新和退出目标页", async () => {
  const page = contentPage(payload => ({ok: true, results: payload.bvids.map(bvid => bvid === BV_B
    ? {bvid, status: "rejected", reasons: ["关键词"]} : accepted(bvid))}));
  try {
    const first = page.addCard(BV_A);
    await until(() => first.dataset.bvfState === "accepted");
    assert.equal(first.querySelectorAll(".bvf-card-actions").length, 1);
    assert.equal(first.querySelector(".bili-video-card").hasAttribute("data-bvf-approved"), true);
    const duplicate = page.addCard(BV_A);
    await until(() => duplicate.dataset.bvfState === "accepted");
    assert.equal(page.calls.length, 1);
    first.querySelector("a").href = `https://www.bilibili.com/video/${BV_B}/`;
    await until(() => first.dataset.bvfState === "rejected");
    assert.equal(first.querySelector(".bvf-card-actions"), null);
    page.changes[0]({biliFilterSettingsV2: {newValue: {}}}, "local");
    await until(() => page.calls.length >= 3 && duplicate.dataset.bvfState === "accepted");
    page.win.history.pushState({}, "", `/video/${BV_C}`);
    page.win.dispatchEvent(new page.win.PopStateEvent("popstate"));
    assert.equal(page.win.document.documentElement.hasAttribute("data-bvf-active"), false);
    assert.equal(first.hasAttribute("data-bvf-state"), false);
  } finally { page.dom.window.close(); }
});

test("旧卡片请求晚返回不会放行已替换的新卡片", async () => {
  let resolveFirst;
  const page = contentPage(payload => payload.bvids.includes(BV_A)
    ? new Promise(resolve => { resolveFirst = resolve; })
    : {ok: true, results: [{bvid: BV_B, status: "rejected", reasons: ["关键词"]}]});
  try {
    const card = page.addCard(BV_A);
    await until(() => resolveFirst);
    card.querySelector("a").href = `https://www.bilibili.com/video/${BV_B}/`;
    await new Promise(resolve => setTimeout(resolve, 100));
    resolveFirst({ok: true, results: [accepted(BV_A)]});
    await until(() => card.dataset.bvfState === "rejected");
    assert.equal(card.querySelector(".bvf-card-actions"), null);
  } finally { page.dom.window.close(); }
});

test("首页卡片失败后可手动重试且不自动重试", async () => {
  let failed = true;
  const page = contentPage(payload => ({ok: true, rateLimited: failed, results: payload.bvids.map(bvid => failed
    ? {bvid, status: "error", reasons: ["HTTP 412"]} : accepted(bvid))}));
  try {
    const card = page.win.document.createElement("div");
    card.className = "video-list-item";
    card.innerHTML = `<div class="bili-video-card"><a href="https://www.bilibili.com/video/${BV_A}">首页视频</a></div>`;
    page.win.document.querySelector("#grid").append(card);
    await until(() => card.dataset.bvfState === "error");
    assert.equal(page.calls[0].mode, "feed");
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(page.calls.length, 1);
    assert.equal(card.querySelector(".bvf-card-actions"), null);
    failed = false;
    const retry = [...page.shadowRoots[0].querySelectorAll("button")].find(button => button.textContent === "重试失败项");
    retry.click();
    await until(() => card.dataset.bvfState === "accepted");
    assert.equal(card.querySelector(".bili-video-card").hasAttribute("data-bvf-approved"), true);
  } finally { page.dom.window.close(); }
});

test("搜索、UP主空间等非首页即使加载内容脚本也不检查或改动卡片", async t => {
  for (const url of excludedPages) await t.test(url, async () => {
    const page = contentPage(() => { throw new Error("非首页不得发起筛选请求"); }, url);
    try {
      const card = page.addCard(BV_A);
      const original = card.outerHTML;
      page.changes[0]({biliFilterSettingsV2: {newValue: {}}}, "local");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(page.calls.length, 0);
      assert.equal(page.win.document.documentElement.hasAttribute("data-bvf-active"), false);
      assert.equal(page.win.document.querySelector("#bvf-page-controls"), null);
      assert.equal(card.outerHTML, original);
      assert.equal(page.win.getComputedStyle(card.querySelector(".bili-video-card")).visibility, "visible");
    } finally { page.dom.window.close(); }
  });
});

test("离开首页清理布局和操作栏，迟到响应不重新开启筛选，返回首页才恢复", async () => {
  let resolvePending;
  const page = contentPage(payload => payload.bvids.includes(BV_B)
    ? new Promise(resolve => { resolvePending = resolve; })
    : {ok: true, results: payload.bvids.map(accepted)});
  try {
    page.win.document.querySelector("#grid").style.display = "grid";
    const first = page.addCard(BV_A);
    await until(() => first.dataset.bvfState === "accepted");
    const pending = page.addCard(BV_B);
    await until(() => resolvePending);
    page.win.history.pushState({}, "", `/video/${BV_C}`);
    page.win.dispatchEvent(new page.win.PopStateEvent("popstate"));
    const checks = page.calls.length;
    resolvePending({ok: true, results: [accepted(BV_B)]});
    page.changes[0]({biliFilterSettingsV2: {newValue: {}}}, "local");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(page.calls.length, checks);
    assert.equal(page.win.document.querySelector("[data-bvf-flow], [data-bvf-item], [data-bvf-state], [data-bvf-approved], .bvf-card-actions"), null);
    assert.equal(page.win.document.querySelector("#bvf-page-controls").hidden, true);
    assert.equal(page.win.getComputedStyle(first.querySelector(".bili-video-card")).visibility, "visible");
    pending.remove();
    page.win.history.pushState({}, "", "/");
    page.win.dispatchEvent(new page.win.PopStateEvent("popstate"));
    await until(() => first.dataset.bvfState === "accepted");
    assert.equal(page.win.document.documentElement.hasAttribute("data-bvf-active"), true);
    assert.equal(page.win.document.querySelector("#bvf-page-controls").hidden, false);
    assert.equal(page.calls.length, checks + 1);
  } finally { page.dom.window.close(); }
});

test("设置页保留旧设置与样本，保存后不再请求推荐或搜索接口", async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(extension, "feed.html"), "utf8"), {
    url: "https://extension.invalid/feed.html", runScripts: "outside-only",
  });
  const win = dom.window;
  const existing = Core.normalizeSettings({...Core.DEFAULT_SETTINGS, minFollowers: 12345});
  const storage = {biliFilterSettingsV2: existing, biliFilterMarkedVideosV1: {}};
  const calls = [];
  const area = {
    get: (key, callback) => callback({[key]: storage[key]}),
    set: (values, callback) => { Object.assign(storage, values); callback(); },
    remove: (key, callback) => { delete storage[key]; callback(); },
  };
  win.chrome = {storage: {local: area, sync: area}, runtime: {sendMessage(payload, callback) {
    calls.push(payload); callback({ok: true});
  }}};
  try {
    for (const file of ["filter-core.js", "marked-core.js", "feed.js"]) win.eval(fs.readFileSync(path.join(extension, file), "utf8"));
    await until(() => win.document.querySelector("#minFollowers").value === "12345");
    win.document.querySelector("#minFollowers").value = "23456";
    win.document.querySelector("#settingsForm").dispatchEvent(new win.Event("submit", {cancelable: true}));
    await until(() => win.document.querySelector("#saveStatus").textContent.includes("已保存"));
    assert.equal(storage.biliFilterSettingsV2.minFollowers, 23456);
    assert.equal(calls.length, 0);
    assert.equal(win.document.querySelector("#searchForm"), null);
    assert.equal(win.document.querySelector("#videoGrid"), null);
    assert.equal(win.document.querySelector("#settingsError").textContent, "");
  } finally { dom.window.close(); }
});
