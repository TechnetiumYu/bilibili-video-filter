const BILI_API = "https://api.bilibili.com";
const FOLLOWER_CACHE_KEY = "biliFilterFollowerCacheV1";
const DETAIL_CACHE_KEY = "biliFilterDetailCacheV1";
const FOLLOWER_TTL_MS = 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 6 * 60 * 60 * 1000;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({url: chrome.runtime.getURL("feed.html")});
});

async function apiJson(path) {
  const response = await fetch(`${BILI_API}${path}`, {
    credentials: "include",
    headers: {Accept: "application/json"},
    referrer: "https://www.bilibili.com/",
  });
  if (!response.ok) throw new Error(`B站接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(payload.message || `B站接口错误 ${payload.code}`);
  }
  return payload.data;
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
    playCount: Number(item.stat?.view) || 0,
    likeCount: Number(item.stat?.like) || 0,
    danmakuCount: Number(item.stat?.danmaku) || 0,
    url: `https://www.bilibili.com/video/${item.bvid}`,
    detailsAvailable: false,
  };
}

async function fetchFeed({batch = 1, pageSize = 20} = {}) {
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
    const data = await apiJson(`/x/web-interface/index/top/feed/rcmd?${query}`);
    const items = (data?.item || []).map(normalizeRecommendedItem).filter(Boolean);
    if (items.length) return {source: "recommend", items};
  } catch (error) {
    console.warn("个性化推荐接口不可用，改用热门视频：", error);
  }

  const data = await apiJson(`/x/web-interface/popular?ps=${safeSize}&pn=${safeBatch}`);
  return {
    source: "popular",
    items: (data?.list || []).map(normalizePopularItem).filter(Boolean),
    noMore: Boolean(data?.no_more),
  };
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

async function fetchFollowerCounts(mids) {
  const uniqueMids = [...new Set((mids || []).map(String).filter(value => /^\d+$/.test(value)))].slice(0, 50);
  const cache = await getStorageValue(FOLLOWER_CACHE_KEY);
  const now = Date.now();
  const counts = {};
  const errors = {};
  const missing = [];

  for (const mid of uniqueMids) {
    const cached = cache[mid];
    if (cached && now - cached.fetchedAt < FOLLOWER_TTL_MS && Number.isFinite(cached.value)) {
      counts[mid] = cached.value;
    } else {
      missing.push(mid);
    }
  }

  await mapWithConcurrency(missing, 4, async mid => {
    try {
      const data = await apiJson(`/x/relation/stat?vmid=${encodeURIComponent(mid)}`);
      const value = Number(data?.follower);
      if (!Number.isFinite(value)) throw new Error("接口未返回有效粉丝数");
      counts[mid] = value;
      cache[mid] = {value, fetchedAt: now};
    } catch (error) {
      errors[mid] = String(error?.message || error);
    }
  });

  const compactCache = Object.fromEntries(
    Object.entries(cache)
      .filter(([, entry]) => now - Number(entry?.fetchedAt || 0) < FOLLOWER_TTL_MS * 2)
      .slice(-1000)
  );
  await setStorageValue(FOLLOWER_CACHE_KEY, compactCache);
  return {counts, errors};
}

async function fetchVideoDetails(bvids) {
  const uniqueBvids = [...new Set((bvids || []).map(String).filter(value => /^BV[0-9A-Za-z]{10}$/.test(value)))].slice(0, 50);
  const cache = await getStorageValue(DETAIL_CACHE_KEY);
  const now = Date.now();
  const details = {};
  const errors = {};
  const missing = [];

  for (const bvid of uniqueBvids) {
    const cached = cache[bvid];
    if (cached && now - cached.fetchedAt < DETAIL_TTL_MS) details[bvid] = cached.value;
    else missing.push(bvid);
  }

  await mapWithConcurrency(missing, 4, async bvid => {
    try {
      const data = await apiJson(`/x/web-interface/view/detail?bvid=${encodeURIComponent(bvid)}`);
      const value = {
        description: String(data?.View?.desc || ""),
        tags: (data?.Tags || []).map(tag => String(tag?.tag_name || "").trim()).filter(Boolean),
      };
      details[bvid] = value;
      cache[bvid] = {value, fetchedAt: now};
    } catch (error) {
      errors[bvid] = String(error?.message || error);
    }
  });

  const compactCache = Object.fromEntries(
    Object.entries(cache)
      .filter(([, entry]) => now - Number(entry?.fetchedAt || 0) < DETAIL_TTL_MS * 2)
      .slice(-500)
  );
  await setStorageValue(DETAIL_CACHE_KEY, compactCache);
  return {details, errors};
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    "bili-filter-fetch-feed": () => fetchFeed(message.options),
    "bili-filter-fetch-followers": () => fetchFollowerCounts(message.mids),
    "bili-filter-fetch-details": () => fetchVideoDetails(message.bvids),
    "bili-filter-clear-cache": async () => {
      await chrome.storage.local.remove([FOLLOWER_CACHE_KEY, DETAIL_CACHE_KEY]);
      return {ok: true};
    },
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler()
    .then(result => sendResponse({ok: true, ...result}))
    .catch(error => sendResponse({ok: false, error: String(error?.message || error)}));
  return true;
});
