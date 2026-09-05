(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliSearchCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function stripMarkup(value) {
    const entities = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'"};
    return String(value || "")
      .replace(/<[^>]*>/g, "")
      .replace(/&(amp|lt|gt|quot|#39);/g, entity => entities[entity] || entity)
      .trim();
  }

  function parseDuration(value) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
    const parts = String(value || "").split(":").map(Number);
    if (!parts.length || parts.some(part => !Number.isFinite(part) || part < 0)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function absoluteImageUrl(value) {
    const text = String(value || "");
    return text.startsWith("//") ? `https:${text}` : text;
  }

  function normalizeItem(item) {
    const uploaderId = item?.mid ?? item?.uid;
    if (!item?.bvid || !uploaderId || (item.type && item.type !== "video")) return null;
    const hasDescription = typeof item.description === "string" || typeof item.desc === "string";
    const hasTags = typeof item.tag === "string" || Array.isArray(item.tags);
    const rawTags = Array.isArray(item.tags) ? item.tags : String(item.tag || "").split(",");
    return {
      bvid: item.bvid,
      title: stripMarkup(item.title),
      description: stripMarkup(item.description || item.desc),
      tags: rawTags.map(tag => String(tag).trim()).filter(Boolean),
      uploaderId: String(uploaderId),
      uploaderName: stripMarkup(item.author || item.uname),
      uploaderAvatar: absoluteImageUrl(item.upic || item.uface),
      coverUrl: absoluteImageUrl(item.pic || item.cover),
      duration: parseDuration(item.duration),
      publishTime: Number(item.pubdate) || 0,
      categoryId: String(item.typeid || item.tid || ""),
      categoryName: stripMarkup(item.typename || item.tname || item.cate_name),
      playCount: Number(item.play) || 0,
      likeCount: Number(item.like) || 0,
      danmakuCount: Number(item.video_review ?? item.danmaku) || 0,
      url: item.arcurl || `https://www.bilibili.com/video/${item.bvid}`,
      // B站搜索响应已经包含过滤所需的简介与标签，无需逐个请求 view/detail。
      detailsAvailable: hasDescription && hasTags,
    };
  }

  function normalizeResponse(data, page) {
    const safePage = Math.max(1, Number(page) || 1);
    const totalPages = Math.max(0, Number(data?.numPages) || 0);
    return {
      items: (Array.isArray(data?.result) ? data.result : []).map(normalizeItem).filter(Boolean),
      total: Math.max(0, Number(data?.numResults) || 0),
      noMore: totalPages === 0 || safePage >= totalPages,
    };
  }

  return {stripMarkup, parseDuration, absoluteImageUrl, normalizeItem, normalizeResponse};
});
