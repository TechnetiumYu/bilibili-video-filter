const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {webcrypto} = require("node:crypto");

const extension = path.join(__dirname, "../extension");
const extensionBase = "chrome-extension://bvf-entrypoint-test/";

function backgroundEntrypoints(createOverride) {
  let actionListener;
  let messageListener;
  let optionsPageCalls = 0;
  const openedTabs = [];
  const fetchCalls = [];
  const sandbox = vm.createContext({
    console, TextEncoder, URL, URLSearchParams, AbortController, AbortSignal,
    crypto: webcrypto, setTimeout, clearTimeout,
    chrome: {
      action: {onClicked: {addListener(listener) { actionListener = listener; }}},
      tabs: {create: async options => {
        openedTabs.push(options.url);
        if (createOverride) return createOverride(options);
        return {id: openedTabs.length, url: options.url};
      }},
      runtime: {
        getURL: resource => `${extensionBase}${resource}`,
        openOptionsPage: async () => { optionsPageCalls += 1; },
        onMessage: {addListener(listener) { messageListener = listener; }},
      },
    },
    fetch: async (...args) => {
      fetchCalls.push(args);
      throw new Error("打开界面不应请求视频接口");
    },
  });
  sandbox.importScripts = (...names) => names.forEach(name =>
    vm.runInContext(fs.readFileSync(path.join(extension, name), "utf8"), sandbox, {filename: name}));
  vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), sandbox, {filename: "background.js"});
  return {
    click: () => actionListener(),
    request: message => new Promise(resolve => {
      const keepAlive = messageListener(message, {}, resolve);
      assert.equal(keepAlive, true);
    }),
    openedTabs,
    fetchCalls,
    get optionsPageCalls() { return optionsPageCalls; },
  };
}

test("工具栏打开独立视频界面而非规则编辑器，导航不请求视频接口", async () => {
  const bg = backgroundEntrypoints();
  await bg.click();
  assert.deepEqual(bg.openedTabs, [`${extensionBase}feed.html`]);
  assert.equal(bg.optionsPageCalls, 0);
  assert.equal(bg.fetchCalls.length, 0);
});

test("原生页面设置入口携带设置参数打开编辑器并返回成功，导航不请求视频接口", async () => {
  const bg = backgroundEntrypoints();
  const response = await bg.request({type: "bili-filter-open-settings"});
  assert.equal(response.ok, true);
  assert.deepEqual(bg.openedTabs, [`${extensionBase}feed.html?settings=1`]);
  assert.equal(bg.optionsPageCalls, 0);
  assert.equal(bg.fetchCalls.length, 0);
});

test("设置入口打开标签页失败时返回错误，不误报成功或请求视频接口", async () => {
  const bg = backgroundEntrypoints(() => { throw new Error("无法打开标签页"); });
  const response = await bg.request({type: "bili-filter-open-settings"});
  assert.equal(response.ok, false);
  assert.equal(response.error, "无法打开标签页");
  assert.equal(bg.fetchCalls.length, 0);
});
