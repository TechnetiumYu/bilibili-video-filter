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
    topicPolicies: [],
    topicClassifier: {
      semanticEnabled: false,
      endpoint: "http://127.0.0.1:8000/v1/chat/completions",
      model: "Qwen/Qwen2.5-27B-Instruct",
      timeoutMs: 120000,
    },
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

  function clampConfidence(value, fallback = 0.75) {
    if (value === "" || value === null || value === undefined) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
  }

  function normalizeTopicPolicy(input = {}, index = 0) {
    const name = String(input.name || "").trim().slice(0, 40);
    const rawId = String(input.id || "").trim();
    const generatedId = `topic-${index + 1}-${normalizeText(name).slice(0, 24) || "unnamed"}`;
    return {
      id: (rawId || generatedId).slice(0, 80),
      name,
      enabled: input.enabled !== false,
      aliases: Array.from(new Set((input.aliases || [])
        .map(value => String(value).trim().slice(0, 40))
        .filter(Boolean)))
        .slice(0, 30),
      minFollowers: optionalNumber(input.minFollowers),
      minViews: optionalNumber(input.minViews),
      confidenceGte: clampConfidence(input.confidenceGte),
    };
  }

  function normalizeClassifier(input = {}) {
    return {
      semanticEnabled: input.semanticEnabled === true,
      endpoint: String(input.endpoint || DEFAULT_SETTINGS.topicClassifier.endpoint).trim().slice(0, 300),
      model: String(input.model || DEFAULT_SETTINGS.topicClassifier.model).trim().slice(0, 120),
      timeoutMs: Math.min(120000, Math.max(5000, Number(input.timeoutMs) || DEFAULT_SETTINGS.topicClassifier.timeoutMs)),
    };
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
      topicPolicies: (input.topicPolicies || [])
        .slice(0, 30)
        .map(normalizeTopicPolicy),
      topicClassifier: normalizeClassifier(input.topicClassifier),
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
    const names = new Set();
    settings.topicPolicies.forEach((policy, index) => {
      if (!policy.name) errors.push(`第 ${index + 1} 个特殊话题缺少名称`);
      const normalizedName = normalizeText(policy.name);
      if (normalizedName && names.has(normalizedName)) errors.push(`特殊话题“${policy.name}”重复`);
      names.add(normalizedName);
      if (policy.minFollowers === null && policy.minViews === null) {
        errors.push(`特殊话题“${policy.name || index + 1}”至少需要设置一个门槛`);
      }
    });
    if (settings.topicClassifier.semanticEnabled) {
      try {
        const endpoint = new URL(settings.topicClassifier.endpoint);
        if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname)) {
          errors.push("模型接口必须是本机的 http://127.0.0.1 或 http://localhost 地址");
        }
      } catch (_error) {
        errors.push("模型接口地址无效");
      }
      if (!settings.topicClassifier.model) errors.push("启用语义关联时必须填写模型名称");
    }
    return {settings, errors};
  }

  function normalizeTopicMatches(matches) {
    if (!Array.isArray(matches)) return [];
    return matches
      .filter(match => match && typeof match === "object")
      .map(match => ({
        id: String(match.id || "").slice(0, 80),
        confidence: clampConfidence(match.confidence, 0),
        evidence: Array.isArray(match.evidence) ? match.evidence.slice(0, 6) : [],
      }))
      .filter(match => match.id);
  }

  function resolveEffectiveThresholds(rawSettings, rawMatches = []) {
    const settings = normalizeSettings(rawSettings);
    const matches = normalizeTopicMatches(rawMatches);
    const activePolicies = settings.topicPolicies.filter(policy => policy.enabled && policy.name);
    const matchedPolicies = activePolicies.filter(policy => {
      const match = matches.find(candidate => candidate.id === policy.id);
      return match && match.confidence >= policy.confidenceGte;
    });
    const maximum = (values) => values.reduce((result, value) => value === null ? result : result === null ? value : Math.max(result, value), null);
    return {
      minFollowers: maximum([settings.minFollowers, ...matchedPolicies.map(policy => policy.minFollowers)]),
      maxFollowers: settings.maxFollowers,
      minViews: maximum([settings.minViews, ...matchedPolicies.map(policy => policy.minViews)]),
      maxViews: settings.maxViews,
      matchedPolicies,
    };
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
    const effective = resolveEffectiveThresholds(settings, video.topicMatches);
    const reasons = [];
    const keyword = keywordReason(video, settings);
    if (keyword) reasons.push(keyword);
    const views = rangeReason(Number(video.playCount), effective.minViews, effective.maxViews, "play_count", "播放量");
    if (views) reasons.push(views);

    if (!options.cheapOnly) {
      const activeTopics = settings.topicPolicies.filter(policy => policy.enabled && policy.name);
      if (activeTopics.length && video.topicClassificationAvailable === false) {
        reasons.push({type: "unknown_data", field: "topic_classification", message: "无法确认特殊话题分类"});
      }
      const followers = rangeReason(Number(video.followerCount), effective.minFollowers, effective.maxFollowers, "follower_count", "UP主粉丝数");
      if (followers) reasons.push(followers);
      if (video.detailsAvailable === false && (settings.keywordScopes.description || settings.keywordScopes.tags || activeTopics.length)) {
        reasons.push({type: "unknown_data", field: "video_details", message: "无法确认视频简介或标签"});
      }
    }

    return {
      status: reasons.length ? "rejected" : options.cheapOnly ? "pending" : "accepted",
      reasons,
      effectiveThresholds: effective,
    };
  }

  return {
    DEFAULT_SETTINGS,
    normalizeText,
    normalizeSettings,
    validateSettings,
    normalizeTopicMatches,
    resolveEffectiveThresholds,
    evaluate,
  };
});
