(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliMarkedCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const MAX_MARKED_VIDEOS = 1000;

  function text(value, limit = 500) {
    return String(value ?? "").trim().slice(0, limit);
  }

  function number(value) {
    if (value === "" || value === null || value === undefined) return null;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : null;
  }

  function safeEvidence(items) {
    return (Array.isArray(items) ? items : []).slice(0, 6).map(item => ({
      source: ["title", "tag", "coverText"].includes(item?.source) ? item.source : "",
      text: text(item?.text, 200),
      relation: text(item?.relation, 200),
    })).filter(item => item.source && item.text);
  }

  function isoFromUnixSeconds(value) {
    const seconds = number(value);
    if (seconds === null) return "";
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  function createSnapshot(video = {}, context = {}) {
    const markedAt = Number(context.markedAt) || Date.now();
    const classificationResult = context.classificationResult || {};
    const effective = context.effectiveThresholds || {};
    const appliedPolicies = context.appliedTopicPolicies || video.appliedTopicPolicies || [];
    return {
      schemaVersion: SCHEMA_VERSION,
      bvid: text(video.bvid || video.id, 80),
      title: text(video.title, 300),
      description: text(video.description, 2000),
      url: text(video.url, 500),
      coverUrl: text(video.coverUrl, 500),
      duration: number(video.duration),
      publishTime: number(video.publishTime),
      publishedAt: isoFromUnixSeconds(video.publishTime),
      category: {
        id: text(video.categoryId, 40),
        name: text(video.categoryName, 80),
        parentId: text(video.parentCategoryId, 40),
        parentName: text(video.parentCategoryName, 80),
      },
      tags: (Array.isArray(video.tags) ? video.tags : []).map(value => text(value, 80)).filter(Boolean).slice(0, 60),
      coverText: (Array.isArray(video.coverText) ? video.coverText : []).map(value => text(value, 200)).filter(Boolean).slice(0, 30),
      uploader: {
        id: text(video.uploaderId, 80),
        name: text(video.uploaderName, 120),
        followerCount: number(video.followerCount),
      },
      metrics: {
        playCount: number(video.playCount),
        likeCount: number(video.likeCount),
        danmakuCount: number(video.danmakuCount),
      },
      classification: {
        mode: text(classificationResult.mode || video.topicClassifierMode || "none", 40),
        classifiedAt: number(classificationResult.classifiedAt || video.topicClassifiedAt),
        cacheExpiresAt: number(classificationResult.cacheExpiresAt || video.topicCacheExpiresAt),
        topicMatches: (video.topicMatches || []).slice(0, 30).map(match => ({
          id: text(match?.id, 80),
          confidence: number(match?.confidence),
          evidence: safeEvidence(match?.evidence),
        })).filter(match => match.id),
        appliedPolicies: appliedPolicies.slice(0, 30).map(policy => ({
          id: text(policy?.id, 80),
          name: text(policy?.name, 80),
          minViews: number(policy?.minViews),
          minFollowers: number(policy?.minFollowers),
          confidenceGte: number(policy?.confidenceGte),
        })).filter(policy => policy.id && policy.name),
      },
      effectiveThresholds: {
        minViews: number(effective.minViews ?? video.effectiveThresholds?.minViews),
        maxViews: number(effective.maxViews ?? video.effectiveThresholds?.maxViews),
        minFollowers: number(effective.minFollowers ?? video.effectiveThresholds?.minFollowers),
        maxFollowers: number(effective.maxFollowers ?? video.effectiveThresholds?.maxFollowers),
      },
      source: {
        mode: text(context.sourceMode || "feed", 20),
        query: text(context.sourceQuery, 100),
      },
      note: text(context.note, 1000),
      markedAt,
      updatedAt: markedAt,
    };
  }

  function normalizeCollection(value) {
    const entries = Array.isArray(value) ? value.map(item => [item?.bvid, item]) : Object.entries(value || {});
    return Object.fromEntries(entries
      .filter(([key, item]) => text(key, 80) && item && typeof item === "object")
      .slice(-MAX_MARKED_VIDEOS)
      .map(([key, item]) => [text(key, 80), item]));
  }

  function sortedVideos(collection) {
    return Object.values(normalizeCollection(collection)).sort((left, right) => Number(right.markedAt || 0) - Number(left.markedAt || 0));
  }

  function frequency(values, limit = 30) {
    const counts = new Map();
    values.filter(Boolean).forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
      .slice(0, limit)
      .map(([name, count]) => ({name, count}));
  }

  function buildDiscussionExport(collection, settings = {}, exportedAt = Date.now()) {
    const videos = sortedVideos(collection);
    return {
      schemaVersion: SCHEMA_VERSION,
      purpose: "bilibili-filter-rule-discussion",
      exportedAt,
      count: videos.length,
      summary: {
        categories: frequency(videos.map(video => video.category?.name || "未确认分区")),
        tags: frequency(videos.flatMap(video => video.tags || []), 50),
        matchedTopics: frequency(videos.flatMap(video => (video.classification?.topicMatches || []).map(match => match.id))),
      },
      currentFilterSettings: settings,
      videos,
    };
  }

  return {SCHEMA_VERSION, MAX_MARKED_VIDEOS, createSnapshot, normalizeCollection, sortedVideos, buildDiscussionExport};
});
