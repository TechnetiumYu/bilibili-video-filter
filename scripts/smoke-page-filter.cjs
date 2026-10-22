// 显式运行的联网诊断：调用真实后台过滤流程，不读取用户浏览器数据。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {webcrypto} = require("node:crypto");
const extension = path.join(__dirname, "../extension");
const storage = {};
let listener;
const area = {
  get: async key => ({[key]: storage[key]}),
  set: async data => Object.assign(storage, data),
  remove: async keys => [].concat(keys).forEach(key => delete storage[key]),
};
const sandbox = vm.createContext({
  console, TextEncoder, URL, URLSearchParams, AbortController, AbortSignal,
  crypto: webcrypto, setTimeout, clearTimeout,
  chrome: {storage: {local: area, sync: area}, action: {onClicked: {addListener() {}}},
    runtime: {onMessage: {addListener(fn) { listener = fn; }}, openOptionsPage: async () => {}},
  },
  fetch: async (url, options) => fetch(url, {...options, headers: {...options.headers,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
    Referer: options.referrer,
  }}),
});
sandbox.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync(path.join(extension, name), "utf8"), sandbox));
vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), sandbox);
const bvids = process.argv.slice(2);
if (bvids.includes("--home")) {
  listener({type: "bili-filter-home-candidates", options: {batch: 1}}, {}, response => {
    console.log(JSON.stringify({ok: response.ok, batch: response.batch, candidateCount: response.items?.length,
      noMore: response.noMore, status: response.status, error: response.error}, null, 2));
    if (!response.ok || !response.items?.length) process.exitCode = 1;
  });
} else {
  if (!bvids.length) bvids.push("BV1tG411M7Yb");
  listener({type: "bili-filter-check-page", bvids, mode: "search"}, {}, response => {
    console.log(JSON.stringify({ok: response.ok, rateLimited: response.rateLimited,
      results: response.results?.map(result => ({bvid: result.bvid, status: result.status, reasons: result.reasons,
        title: result.video?.title, playCount: result.video?.playCount, followerCount: result.video?.followerCount,
        tags: result.video?.tags, publishTime: result.video?.publishTime})), error: response.error}, null, 2));
    if (!response.ok || response.results?.some(result => result.status === "error") || !response.results?.length) process.exitCode = 1;
  });
}
