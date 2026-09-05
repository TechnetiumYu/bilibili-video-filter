importScripts("topic-classifier.js", "request-policy.js", "search-core.js", "wbi.js");

const BILI_API = "https://api.bilibili.com";
const FOLLOWER_CACHE_KEY = "biliFilterFollowerCacheV1";
const DETAIL_CACHE_KEY = "biliFilterDetailCacheV2";
const LEGACY_DETAIL_CACHE_KEY = "biliFilterDetailCacheV1";
const TOPIC_CACHE_KEY = "biliFilterTopicCacheV1";
const CANDIDATE_CACHE_KEY = "biliFilterCandidateCacheV2";
const LEGACY_CANDIDATE_CACHE_KEY = "biliFilterCandidateCacheV1";
const FOLLOWER_TTL_MS = 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
const TOPIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CANDIDATE_FRESH_MS = 2 * 60 * 1000;
const CANDIDATE_STALE_MS = 30 * 60 * 1000;
const WBI_KEY_TTL_MS = 6 * 60 * 60 * 1000;
const CLASSIFIER_BATCH_SIZE = 20;
const TOPIC_TAXONOMY_VERSION = 1;
const TOPIC_PROMPT_VERSION = 1;
const BILI_REQUEST_INTERVAL_MS = 200;
const BILI_MAX_CONCURRENCY = 2;

let biliRequestLanes = Array.from({length: BILI_MAX_CONCURRENCY}, () => Promise.resolve());
let biliStartQueue = Promise.resolve();
let nextBiliLane = 0;
let nextBiliRequestAt = 0;
let wbiKeyCache = null;

class BiliApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BiliApiError";
    this.status = Number(options.status) || 0;
    this.endpoint = String(options.endpoint || "B站接口");
    this.retryAfterMs = Math.max(0, Number(options.retryAfterMs) || 0);
    this.biliRateLimited = this.status === 412;
  }
}

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({url: chrome.runtime.getURL("feed.html")});
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function acquireBiliStartSlot() {
  const start = biliStartQueue.then(async () => {
    const now = Date.now();
    const spacing = Math.max(0, nextBiliRequestAt - now);
    if (spacing) await delay(spacing);
    nextBiliRequestAt = Date.now() + BILI_REQUEST_INTERVAL_MS + Math.floor(Math.random() * 100);
  });
  biliStartQueue = start.catch(() => undefined);
  return start;
}

function scheduleBiliRequest(worker) {
  const laneIndex = nextBiliLane++ % BILI_MAX_CONCURRENCY;
  const run = biliRequestLanes[laneIndex].then(async () => {
    await acquireBiliStartSlot();
    return worker();
  });
  biliRequestLanes[laneIndex] = run.catch(() => undefined);
  return run;
}

async function runFastBiliRequest(worker) {
  return worker();
}

async function apiJson(path, referrer = "https://www.bilibili.com/", endpoint = "B站接口", requestProfile = "search-safe", credentials = "include") {
  const execute = async () => {
    const response = await fetch(`${BILI_API}${path}`, {
      credentials,
      headers: {Accept: "application/json"},
      referrer,
    });
    if (!response.ok) {
      throw new BiliApiError(`${endpoint}返回 HTTP ${response.status}`, {
        status: response.status,
        endpoint,
      });
    }
    const payload = await response.json();
    if (payload.code !== 0) {
      if (Number(payload.code) === -412 || Number(payload.code) === 412) {
        throw new BiliApiError(payload.message || `${endpoint}触发风控`, {status: 412, endpoint});
      }
      throw new BiliApiError(payload.message || `${endpoint}错误 ${payload.code}`, {endpoint});
    }
    return payload.data;
  };
  return requestProfile === "feed-fast" ? runFastBiliRequest(execute) : scheduleBiliRequest(execute);
}

function normalizeRecommendedItem(item) {
  if (!item?.bvid || !item?.owner?.mid || item.goto !== "av") return null;
  return {
    bvid: item.bvid,
    title: item.title || "",
    description: item.desc || "",
    tags: [],
    uploaderId: String(item.owner.mid),
    uploaderName: item.owner.name || "",
    uploaderAvatar: item.owner.face || "",
    coverUrl: item.pic || "",
    duration: Number(item.duration) || 0,
    publishTime: Number(item.pubdate) || 0,
    categoryId: String(item.tid || ""),
    categoryName: item.tname || "",
    playCount: Number(item.stat?.view) || 0,
    likeCount: Number(item.stat?.like) || 0,
    danmakuCount: Number(item.stat?.danmaku) || 0,
    url: item.uri || `https://www.bilibili.com/video/${item.bvid}`,
    detailsAvailable: false,
  };
}

function normalizePopularItem(item) {
  if (!item?.bvid || !item?.owner?.mid) return null;
  const dynamicTags = Array.from(String(item.dynamic || "").matchAll(/#([^#]+)#/g), match => match[1].trim());
  return {
    bvid: item.bvid,
    title: item.title || "",
    description: item.desc || "",
    tags: dynamicTags,
    uploaderId: String(item.owner.mid),
    uploaderName: item.owner.name || "",
    uploaderAvatar: item.owner.face || "",
    coverUrl: item.pic || "",
    duration: Number(item.duration) || 0,
    publishTime: Number(item.pubdate) || 0,
    categoryId: String(item.tid || ""),
    categoryName: item.tname || "",
    playCount: Number(item.stat?.view) || 0,
    likeCount: Number(item.stat?.like) || 0,
    danmakuCount: Number(item.stat?.danmaku) || 0,
    url: `https://www.bilibili.com/video/${item.bvid}`,
    detailsAvailable: false,
  };
}

async function fetchFeedUncached({batch = 1, pageSize = 20, requestProfile = "feed-fast"} = {}) {
  const safeBatch = Math.max(1, Math.min(1000, Number(batch) || 1));
  const safeSize = Math.max(1, Math.min(30, Number(pageSize) || 20));
  try {
    const query = new URLSearchParams({
      fresh_type: "4",
      ps: String(safeSize),
      fresh_idx: String(safeBatch),
      fresh_idx_1h: String(safeBatch),
      feed_version: "V8",
      homepage_ver: "1",
    });
    const data = await apiJson(`/x/web-interface/index/top/feed/rcmd?${query}`, "https://www.bilibili.com/", "推荐接口", requestProfile);
    const items = (data?.item || []).map(normalizeRecommendedItem).filter(Boolean);
    if (items.length) return {source: "recommend", items};
  } catch (error) {
    console.warn("个性化推荐接口不可用，改用热门视频：", error);
  }

  const data = await apiJson(`/x/web-interface/popular?ps=${safeSize}&pn=${safeBatch}`, "https://www.bilibili.com/", "热门接口", requestProfile, "omit");
  return {
    source: "popular",
    items: (data?.list || []).map(normalizePopularItem).filter(Boolean),
    noMore: Boolean(data?.no_more),
  };
}

async function searchVideosUncached({query = "", page = 1, pageSize = 20} = {}) {
  const safeQuery = String(query).trim().slice(0, 100);
  if (!safeQuery) throw new Error("请输入搜索关键词");
  const safePage = Math.max(1, Math.min(1000, Number(page) || 1));
  const safeSize = Math.max(1, Math.min(30, Number(pageSize) || 20));
  const params = {
    search_type: "video",
    keyword: safeQuery,
    page: String(safePage),
    page_size: String(safeSize),
    platform: "pc",
    web_location: "1430654",
  };
  let data;
  let provider = "wbi";
  let primaryError;
  try {
    const keys = await getWbiKeys();
    const signed = BiliWbi.signParams(params, keys.imgKey, keys.subKey);
    data = await apiJson(
      `/x/web-interface/wbi/search/type?${signed.queryString}`,
      "https://search.bilibili.com/",
      "WBI搜索接口",
      "search-safe",
      "omit"
    );
    if (data?.v_voucher) throw new BiliApiError("WBI搜索接口要求额外验证", {status: 412, endpoint: "WBI搜索接口"});
  } catch (error) {
    primaryError = error;
    wbiKeyCache = null;
    provider = "all-v2";
    try {
      const fallbackParams = new URLSearchParams({keyword: safeQuery, page: String(safePage)});
      data = await apiJson(
        `/x/web-interface/search/all/v2?${fallbackParams}`,
        "https://search.bilibili.com/",
        "备用搜索接口",
        "search-safe",
        "omit"
      );
    } catch (fallbackError) {
      throw new BiliApiError(
        `新版搜索失败：${primaryError?.message || primaryError}；备用搜索失败：${fallbackError?.message || fallbackError}`,
        {status: fallbackError?.status, endpoint: fallbackError?.endpoint || "备用搜索接口"}
      );
    }
  }
  const normalized = BiliSearchCore.normalizeResponse(data, safePage);
  if (!normalized.items.length && normalized.total > 0) {
    throw new BiliApiError(`${provider === "wbi" ? "WBI" : "备用"}搜索响应缺少视频结果`, {endpoint: "搜索接口"});
  }
  return {
    source: "search",
    searchProvider: provider,
    query: safeQuery,
    ...normalized,
  };
}

async function getWbiKeys() {
  const now = Date.now();
  if (wbiKeyCache?.expiresAt > now) return wbiKeyCache;
  const data = await apiJson("/x/web-interface/nav", "https://www.bilibili.com/", "WBI密钥接口", "search-safe", "omit");
  const imgKey = BiliWbi.keyFromUrl(data?.wbi_img?.img_url);
  const subKey = BiliWbi.keyFromUrl(data?.wbi_img?.sub_url);
  if (!imgKey || !subKey) throw new BiliApiError("B站未返回有效 WBI 密钥", {endpoint: "WBI密钥接口"});
  wbiKeyCache = {imgKey, subKey, expiresAt: now + WBI_KEY_TTL_MS};
  return wbiKeyCache;
}

async function cachedCandidates(key, loader) {
  const cache = await getStorageValue(CANDIDATE_CACHE_KEY);
  const now = Date.now();
  const cached = cache[key];
  const cacheMode = BiliRequestPolicy.candidateCacheMode(cached, now, CANDIDATE_FRESH_MS, CANDIDATE_STALE_MS);
  if (cacheMode === "fresh") {
    return {...cached.value, cacheMode: "fresh"};
  }
  try {
    const value = await loader();
    cache[key] = {value, fetchedAt: now};
    const compact = Object.fromEntries(Object.entries(cache)
      .filter(([, entry]) => now - Number(entry?.fetchedAt || 0) < CANDIDATE_STALE_MS * 2)
      .sort((left, right) => Number(left[1]?.fetchedAt || 0) - Number(right[1]?.fetchedAt || 0))
      .slice(-200));
    await setStorageValue(CANDIDATE_CACHE_KEY, compact);
    return {...value, cacheMode: "network"};
  } catch (error) {
    if (cacheMode === "stale" && error?.biliRateLimited) {
      return {
        ...cached.value,
        cacheMode: "stale",
        rateLimited: true,
        retryAfterMs: error.retryAfterMs,
        rateLimitEndpoint: error.endpoint,
      };
    }
    throw error;
  }
}

async function fetchFeed(options = {}) {
  const batch = Math.max(1, Math.min(1000, Number(options.batch) || 1));
  const pageSize = Math.max(1, Math.min(30, Number(options.pageSize) || 20));
  const requestProfile = options.requestProfile === "feed-fast" ? "feed-fast" : "search-safe";
  return cachedCandidates(`feed:${batch}:${pageSize}`, () => fetchFeedUncached({batch, pageSize, requestProfile}));
}

async function searchVideos(options = {}) {
  const query = String(options.query || "").trim().slice(0, 100);
  const page = Math.max(1, Math.min(1000, Number(options.page) || 1));
  const pageSize = Math.max(1, Math.min(30, Number(options.pageSize) || 20));
  return cachedCandidates(`search:${query}:${page}:${pageSize}`, () => searchVideosUncached({query, page, pageSize}));
}

async function getStorageValue(key) {
  const result = await chrome.storage.local.get(key);
  return result[key] || {};
}

async function setStorageValue(key, value) {
  await chrome.storage.local.set({[key]: value});
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, values.length)}, run));
  return results;
}

function validateLocalEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(String(value || ""));
  } catch (_error) {
    throw new Error("本地模型接口地址无效");
  }
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname)) {
    throw new Error("为保护隐私，模型接口仅允许使用本机 http://127.0.0.1 或 http://localhost 地址");
  }
  return endpoint.href;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function topicCacheKey(video, policies, classifier) {
  return sha256(JSON.stringify({
    taxonomyVersion: TOPIC_TAXONOMY_VERSION,
    promptVersion: TOPIC_PROMPT_VERSION,
    model: String(classifier.model || ""),
    endpoint: String(classifier.endpoint || ""),
    video: BiliTopicClassifier.classificationInput(video),
    topics: policies.map(policy => ({id: policy.id, name: policy.name, aliases: policy.aliases || []})),
  }));
}

async function classifyTopics({videos = [], policies = [], classifier = {}} = {}) {
  const safeVideos = videos.slice(0, CLASSIFIER_BATCH_SIZE).map(BiliTopicClassifier.classificationInput);
  const safePolicies = policies.filter(policy => policy?.enabled !== false && String(policy?.name || "").trim()).slice(0, 30);
  if (!safeVideos.length || !safePolicies.length) {
    return {results: safeVideos.map(video => ({id: video.id, topics: []})), mode: "none"};
  }

  if (!classifier.semanticEnabled) {
    const classifiedAt = Date.now();
    return {
      results: BiliTopicClassifier.lexicalClassify(safeVideos, safePolicies).map(result => ({
        ...result,
        classifiedAt,
        cacheExpiresAt: null,
      })),
      mode: "keyword",
    };
  }

  const endpoint = validateLocalEndpoint(classifier.endpoint);
  const now = Date.now();
  const cache = await getStorageValue(TOPIC_CACHE_KEY);
  const cacheKeys = await Promise.all(safeVideos.map(video => topicCacheKey(video, safePolicies, classifier)));
  const resultsById = new Map();
  const missingVideos = [];
  const missingKeys = [];
  safeVideos.forEach((video, index) => {
    const cached = cache[cacheKeys[index]];
    if (cached && now - Number(cached.fetchedAt || 0) < TOPIC_TTL_MS && cached.value?.id === video.id) {
      resultsById.set(video.id, {
        ...cached.value,
        classifiedAt: cached.fetchedAt,
        cacheExpiresAt: Number(cached.fetchedAt) + TOPIC_TTL_MS,
      });
    } else {
      missingVideos.push(video);
      missingKeys.push(cacheKeys[index]);
    }
  });
  if (!missingVideos.length) {
    return {results: safeVideos.map(video => resultsById.get(video.id)), mode: "semantic-cache"};
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(120000, Math.max(5000, Number(classifier.timeoutMs) || 120000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "omit",
      headers: {"Content-Type": "application/json", Accept: "application/json"},
      body: JSON.stringify({
        model: String(classifier.model || "").slice(0, 120),
        temperature: 0,
        response_format: {type: "json_object"},
        messages: BiliTopicClassifier.buildMessages(missingVideos, safePolicies),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`本地模型接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    const freshResults = BiliTopicClassifier.validateResults(payload, missingVideos, safePolicies);
    const missingKeyById = new Map(missingVideos.map((video, index) => [video.id, missingKeys[index]]));
    freshResults.forEach(result => {
      resultsById.set(result.id, {...result, classifiedAt: now, cacheExpiresAt: now + TOPIC_TTL_MS});
      cache[missingKeyById.get(result.id)] = {value: result, fetchedAt: now};
    });
    const compactCache = Object.fromEntries(
      Object.entries(cache)
        .filter(([, entry]) => now - Number(entry?.fetchedAt || 0) < TOPIC_TTL_MS * 2)
        .sort((left, right) => Number(left[1]?.fetchedAt || 0) - Number(right[1]?.fetchedAt || 0))
        .slice(-1000)
    );
    await setStorageValue(TOPIC_CACHE_KEY, compactCache);
    return {results: safeVideos.map(video => resultsById.get(video.id)), mode: "semantic"};
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`本地模型在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFollowerCounts(mids, requestProfile = "search-safe") {
  const uniqueMids = [...new Set((mids || []).map(String).filter(value => /^\d+$/.test(value)))].slice(0, 50);
  const cache = await getStorageValue(FOLLOWER_CACHE_KEY);
  const now = Date.now();
  const counts = {};
  const errors = {};
  const missing = [];
  let rateLimited = false;
  let retryAfterMs = 0;

  for (const mid of uniqueMids) {
    const cached = cache[mid];
    if (cached && now - cached.fetchedAt < FOLLOWER_TTL_MS && Number.isFinite(cached.value)) {
      counts[mid] = cached.value;
    } else {
      missing.push(mid);
    }
  }

  const concurrency = requestProfile === "feed-fast" ? 4 : 2;
  await mapWithConcurrency(missing, concurrency, async mid => {
    try {
      const data = await apiJson(`/x/relation/stat?vmid=${encodeURIComponent(mid)}`, "https://space.bilibili.com/", "粉丝数接口", requestProfile, "omit");
      const value = Number(data?.follower);
      if (!Number.isFinite(value)) throw new Error("接口未返回有效粉丝数");
      counts[mid] = value;
      cache[mid] = {value, fetchedAt: now};
    } catch (error) {
      errors[mid] = String(error?.message || error);
      if (error?.biliRateLimited) {
        rateLimited = true;
        retryAfterMs = Math.max(retryAfterMs, Number(error.retryAfterMs) || 0);
      }
    }
  });

  const compactCache = Object.fromEntries(
    Object.entries(cache)
      .filter(([, entry]) => now - Number(entry?.fetchedAt || 0) < FOLLOWER_TTL_MS * 2)
      .slice(-1000)
  );
  await setStorageValue(FOLLOWER_CACHE_KEY, compactCache);
  return {counts, errors, rateLimited, retryAfterMs, rateLimitEndpoint: rateLimited ? "粉丝数接口" : ""};
}

async function fetchVideoDetails(bvids, requestProfile = "search-safe") {
  const uniqueBvids = [...new Set((bvids || []).map(String).filter(value => /^BV[0-9A-Za-z]{10}$/.test(value)))].slice(0, 50);
  const cache = await getStorageValue(DETAIL_CACHE_KEY);
  const now = Date.now();
  const details = {};
  const errors = {};
  const missing = [];
  let rateLimited = false;
  let retryAfterMs = 0;

  for (const bvid of uniqueBvids) {
    const cached = cache[bvid];
    if (cached && now - cached.fetchedAt < DETAIL_TTL_MS) details[bvid] = cached.value;
    else missing.push(bvid);
  }

  const concurrency = requestProfile === "feed-fast" ? 4 : 2;
  await mapWithConcurrency(missing, concurrency, async bvid => {
    try {
      const data = await apiJson(`/x/web-interface/view/detail?bvid=${encodeURIComponent(bvid)}`, "https://www.bilibili.com/", "视频详情接口", requestProfile, "omit");
      const value = {
        description: String(data?.View?.desc || ""),
        tags: (data?.Tags || []).map(tag => String(tag?.tag_name || "").trim()).filter(Boolean),
        categoryId: String(data?.View?.tid || ""),
        categoryName: String(data?.View?.tname || ""),
      };
      details[bvid] = value;
      cache[bvid] = {value, fetchedAt: now};
    } catch (error) {
      errors[bvid] = String(error?.message || error);
      if (error?.biliRateLimited) {
        rateLimited = true;
        retryAfterMs = Math.max(retryAfterMs, Number(error.retryAfterMs) || 0);
      }
    }
  });

  const compactCache = Object.fromEntries(
    Object.entries(cache)
      .filter(([, entry]) => now - Number(entry?.fetchedAt || 0) < DETAIL_TTL_MS * 2)
      .slice(-500)
  );
  await setStorageValue(DETAIL_CACHE_KEY, compactCache);
  return {details, errors, rateLimited, retryAfterMs, rateLimitEndpoint: rateLimited ? "视频详情接口" : ""};
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    "bili-filter-fetch-feed": () => fetchFeed(message.options),
    "bili-filter-search": () => searchVideos(message.options),
    "bili-filter-fetch-followers": () => fetchFollowerCounts(message.mids, message.requestProfile),
    "bili-filter-fetch-details": () => fetchVideoDetails(message.bvids, message.requestProfile),
    "bili-filter-classify-topics": () => classifyTopics(message.options),
    "bili-filter-rate-limit-status": async () => {
      return {
        rateLimited: false,
        retryAfterMs: 0,
        rateLimitEndpoint: "",
      };
    },
    "bili-filter-clear-cache": async () => {
      nextBiliRequestAt = 0;
      wbiKeyCache = null;
      await chrome.storage.local.remove([
        FOLLOWER_CACHE_KEY,
        DETAIL_CACHE_KEY,
        LEGACY_DETAIL_CACHE_KEY,
        TOPIC_CACHE_KEY,
        CANDIDATE_CACHE_KEY,
        LEGACY_CANDIDATE_CACHE_KEY,
        "biliFilterRateLimitV2",
        "biliFilterRateLimitV3",
      ]);
      return {ok: true};
    },
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler()
    .then(result => sendResponse({ok: true, ...result}))
    .catch(error => sendResponse({
      ok: false,
      error: String(error?.message || error),
      status: Number(error?.status) || 0,
      endpoint: String(error?.endpoint || ""),
      retryAfterMs: Math.max(0, Number(error?.retryAfterMs) || 0),
      biliRateLimited: Boolean(error?.biliRateLimited),
    }));
  return true;
});
