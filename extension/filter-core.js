(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliFilterCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    blockedKeywords: ["破防", "急了", "对线", "开战", "逆天"],
    keywordScopes: {
      title: true,
      description: true,
      tags: true,
      uploaderName: false,
    },
    minFollowers: 10000,
    maxFollowers: 5000000,
    minViews: 5000,
    maxViews: 1000000,
  });

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN")
      .replace(/\s+/g, "");
  }

  function optionalNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function normalizeSettings(input = {}) {
    const scopes = input.keywordScopes || {};
    return {
      blockedKeywords: Array.from(new Set((input.blockedKeywords || [])
        .map(value => String(value).trim())
        .filter(Boolean))),
      keywordScopes: {
        title: scopes.title !== false,
        description: scopes.description !== false,
        tags: scopes.tags !== false,
        uploaderName: scopes.uploaderName === true,
      },
      minFollowers: optionalNumber(input.minFollowers),
      maxFollowers: optionalNumber(input.maxFollowers),
      minViews: optionalNumber(input.minViews),
      maxViews: optionalNumber(input.maxViews),
    };
  }

  function validateSettings(input) {
    const settings = normalizeSettings(input);
    const errors = [];
    if (settings.minFollowers !== null && settings.maxFollowers !== null && settings.minFollowers > settings.maxFollowers) {
      errors.push("最低粉丝数不能大于最高粉丝数");
    }
    if (settings.minViews !== null && settings.maxViews !== null && settings.minViews > settings.maxViews) {
      errors.push("最低播放量不能大于最高播放量");
    }
    return {settings, errors};
  }

  function keywordReason(video, settings) {
    const fields = [];
    if (settings.keywordScopes.title) fields.push(["title", "标题", video.title]);
    if (settings.keywordScopes.description) fields.push(["description", "简介", video.description]);
    if (settings.keywordScopes.tags) fields.push(["tags", "标签", (video.tags || []).join(" ")]);
    if (settings.keywordScopes.uploaderName) fields.push(["uploaderName", "UP主名称", video.uploaderName]);

    const keywords = settings.blockedKeywords.map(keyword => ({raw: keyword, normalized: normalizeText(keyword)}));
    for (const [field, label, value] of fields) {
      const normalizedValue = normalizeText(value);
      const match = keywords.find(keyword => keyword.normalized && normalizedValue.includes(keyword.normalized));
      if (match) return {type: "keyword", field, keyword: match.raw, message: `${label}命中关键词“${match.raw}”`};
    }
    return null;
  }

  function rangeReason(value, min, max, type, label) {
    if (!Number.isFinite(value)) return {type: "unknown_data", field: type, message: `无法确认${label}`};
    if (min !== null && value < min) return {type, actual: value, minimum: min, message: `${label}低于最低门槛`};
    if (max !== null && value > max) return {type, actual: value, maximum: max, message: `${label}高于最高门槛`};
    return null;
  }

  function evaluate(video, rawSettings, options = {}) {
    const settings = normalizeSettings(rawSettings);
    const reasons = [];
    const keyword = keywordReason(video, settings);
    if (keyword) reasons.push(keyword);
    const views = rangeReason(Number(video.playCount), settings.minViews, settings.maxViews, "play_count", "播放量");
    if (views) reasons.push(views);

    if (!options.cheapOnly) {
      const followers = rangeReason(Number(video.followerCount), settings.minFollowers, settings.maxFollowers, "follower_count", "UP主粉丝数");
      if (followers) reasons.push(followers);
      if (video.detailsAvailable === false && (settings.keywordScopes.description || settings.keywordScopes.tags)) {
        reasons.push({type: "unknown_data", field: "video_details", message: "无法确认视频简介或标签"});
      }
    }

    return {
      status: reasons.length ? "rejected" : options.cheapOnly ? "pending" : "accepted",
      reasons,
    };
  }

  return {DEFAULT_SETTINGS, normalizeText, normalizeSettings, validateSettings, evaluate};
});
