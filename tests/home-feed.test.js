const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const {webcrypto} = require("node:crypto");

const extension = path.join(__dirname, "../extension");
const BV_A = "BV1tG411M7Yb";
const BV_B = "BV1Vk4y147YL";

function candidate(bvid = BV_A, changes = {}) {
  return {bvid, goto: "av", title: "正常视频", owner: {mid: 42, name: "测试UP"},
    pic: "https://example.test/cover.jpg", stat: {view: 20000}, ...changes};
}

function background(responder = () => ({item: [candidate()]})) {
  const calls = [];
  const listeners = [];
  const storageReads = [];
  const area = {
    get: async key => { storageReads.push(key); return {}; },
    set: async () => {},
    remove: async () => {},
  };
  const sandbox = vm.createContext({
    console, TextEncoder, URL, URLSearchParams, AbortController, AbortSignal,
    crypto: webcrypto, setTimeout, clearTimeout,
    chrome: {
      storage: {local: area, sync: area},
      action: {onClicked: {addListener() {}}},
      runtime: {onMessage: {addListener(fn) { listeners.push(fn); }}, openOptionsPage: async () => {}},
    },
    fetch: async (url, options) => {
      calls.push({url, options});
      const data = await responder(new URL(url), options);
      if (data?.httpStatus) return {ok: false, status: data.httpStatus};
      return {ok: true, status: 200, json: async () => ({code: 0, data})};
    },
  });
  sandbox.importScripts = (...names) => names.forEach(name =>
    vm.runInContext(fs.readFileSync(path.join(extension, name), "utf8"), sandbox));
  vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), sandbox);
  const request = options => new Promise(resolve => listeners[0](
    {type: "bili-filter-home-candidates", options}, {}, resolve));
  return {calls, storageReads, request};
}

test("首页续载批次递增，固定20条并直接使用高速推荐接口而非旧候选缓存", async () => {
  const bg = background(url => ({item: [candidate(url.searchParams.get("fresh_idx") === "1" ? BV_A : BV_B)]}));
  for (const batch of [1, 2, 1001, 1000000]) {
    const result = await bg.request({batch, pageSize: 1, requestProfile: "search-safe"});
    assert.equal(result.ok, true);
    assert.equal(result.batch, batch);
    assert.equal(result.noMore, false);
    const call = bg.calls.at(-1);
    const url = new URL(call.url);
    assert.equal(url.pathname, "/x/web-interface/index/top/feed/rcmd");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      fresh_type: "4", ps: "20", fresh_idx: String(batch), fresh_idx_1h: String(batch),
      feed_version: "V8", homepage_ver: "1",
    });
    assert.equal(call.options.credentials, "include");
    assert.equal(call.options.referrer, "https://www.bilibili.com/");
  }
  await bg.request({batch: 2});
  assert.equal(bg.calls.length, 5, "同一批次也不复用旧独立流的候选缓存");
  assert.equal(bg.storageReads.length, 0);
});

test("首页续载默认首批且将有效小数批次向下取整", async () => {
  const bg = background();
  assert.equal((await bg.request()).batch, 1);
  assert.equal((await bg.request({batch: 2.9})).batch, 2);
  assert.equal(new URL(bg.calls.at(-1).url).searchParams.get("fresh_idx"), "2");
});

test("首页候选只保留规范BV号和普通av视频，不将候选数值视为已确认详情", async () => {
  const bg = background(() => ({item: [candidate(), candidate(BV_B, {goto: "live"}),
    candidate("BVbad"), candidate(`${BV_A}/extra`), candidate(BV_B, {owner: {}}),
    candidate(BV_B, {goto: "ad"}), null]}));
  const result = await bg.request({batch: 1});
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.items, item => item.bvid), [BV_A]);
  assert.equal(result.items[0].title, "正常视频");
  assert.equal(result.items[0].uploaderId, "42");
  assert.equal(result.items[0].detailsAvailable, false);
  assert.equal(result.noMore, false);
});

test("首页候选412只有一次请求，无热门兜底和自动重试", async () => {
  const bg = background(() => ({httpStatus: 412}));
  const result = await bg.request({batch: 3});
  assert.equal(result.ok, false);
  assert.equal(result.status, 412);
  assert.equal(result.biliRateLimited, true);
  assert.equal(bg.calls.length, 1);
  assert.equal(new URL(bg.calls[0].url).pathname, "/x/web-interface/index/top/feed/rcmd");
});

test("首页候选网络错误原样返回且不调用备用接口", async () => {
  const bg = background(() => { throw new Error("网络连接已断开"); });
  const result = await bg.request({batch: 4});
  assert.equal(result.ok, false);
  assert.equal(result.error, "网络连接已断开");
  assert.equal(bg.calls.length, 1);
});

test("首页候选voucher作为412，不接受缺失或非数组候选列表", async () => {
  for (const value of [{v_voucher: "verify", item: []}, undefined, null, {}, {item: null}, {item: {}}]) {
    const bg = background(() => value);
    const result = await bg.request({batch: 1});
    assert.equal(result.ok, false);
    assert.equal(bg.calls.length, 1);
    if (value?.v_voucher) {
      assert.equal(result.status, 412);
      assert.equal(result.biliRateLimited, true);
    } else assert.match(result.error, /候选列表/);
  }
});

test("首页候选拒绝非法批次，不夹成重复页也不发起请求", async () => {
  const bg = background();
  for (const batch of [0, -1, 0.9, 1000001, 1000000.1, NaN, Infinity, -Infinity, "2", null, true, {}]) {
    const result = await bg.request({batch});
    assert.equal(result.ok, false, String(batch));
    assert.match(result.error, /批次/);
  }
  assert.equal(bg.calls.length, 0);
});

test("首页候选仅以明确布尔结束标记判断noMore，空页或过滤空页不代表结束", async () => {
  for (const [data, expected] of [
    [{item: []}, false],
    [{item: [candidate(BV_A, {goto: "live"})]}, false],
    [{item: [], no_more: true}, true],
    [{item: [], is_finish: true}, true],
    [{item: [], no_more: 1, is_finish: "true"}, false],
    [{item: [candidate()], no_more: false, is_finish: true}, true],
  ]) {
    const bg = background(() => data);
    const result = await bg.request({batch: 1});
    assert.equal(result.ok, true);
    assert.equal(result.noMore, expected);
  }
});
