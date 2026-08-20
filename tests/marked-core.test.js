const test = require("node:test");
const assert = require("node:assert/strict");
const Marked = require("../extension/marked-core.js");

function sample(overrides = {}) {
  return {
    bvid: "BV1234567890",
    title: "鸿蒙 NEXT 体验",
    description: "系统体验视频",
    url: "https://www.bilibili.com/video/BV1234567890",
    coverUrl: "https://example.com/cover.jpg",
    tags: ["华为", "鸿蒙", "数码"],
    coverText: ["纯血鸿蒙"],
    categoryId: "95",
    categoryName: "数码",
    uploaderId: "123",
    uploaderName: "示例UP",
    followerCount: 120000,
    playCount: 250000,
    likeCount: 10000,
    danmakuCount: 500,
    topicClassifierMode: "semantic-cache",
    topicClassifiedAt: 1000,
    topicCacheExpiresAt: 2000,
    topicMatches: [{
      id: "huawei",
      confidence: 0.98,
      evidence: [{source: "title", text: "鸿蒙 NEXT", relation: "华为操作系统"}],
    }],
    appliedTopicPolicies: [{
      id: "huawei", name: "华为", minViews: 200000, minFollowers: 100000, confidenceGte: 0.75,
    }],
    effectiveThresholds: {minViews: 200000, maxViews: 1000000, minFollowers: 100000, maxFollowers: 5000000},
    ...overrides,
  };
}

test("标记快照保存后续讨论所需的筛选信息", () => {
  const snapshot = Marked.createSnapshot(sample(), {markedAt: 3000, sourceMode: "search", sourceQuery: "鸿蒙"});
  assert.equal(snapshot.bvid, "BV1234567890");
  assert.equal(snapshot.category.name, "数码");
  assert.deepEqual(snapshot.tags, ["华为", "鸿蒙", "数码"]);
  assert.deepEqual(snapshot.coverText, ["纯血鸿蒙"]);
  assert.equal(snapshot.metrics.playCount, 250000);
  assert.equal(snapshot.uploader.followerCount, 120000);
  assert.equal(snapshot.classification.topicMatches[0].confidence, 0.98);
  assert.equal(snapshot.classification.topicMatches[0].evidence[0].relation, "华为操作系统");
  assert.equal(snapshot.classification.cacheExpiresAt, 2000);
  assert.equal(snapshot.effectiveThresholds.minViews, 200000);
  assert.equal(snapshot.source.query, "鸿蒙");
  assert.equal(snapshot.markedAt, 3000);
});

test("标记快照不会保存无关的任意字段", () => {
  const snapshot = Marked.createSnapshot(sample({cookie: "secret", rawResponse: {private: true}}));
  assert.equal("cookie" in snapshot, false);
  assert.equal("rawResponse" in snapshot, false);
});

test("讨论数据汇总分区、标签和话题频次", () => {
  const first = Marked.createSnapshot(sample(), {markedAt: 3000});
  const second = Marked.createSnapshot(sample({
    bvid: "BV0987654321",
    title: "麒麟芯片分析",
    tags: ["华为", "芯片"],
  }), {markedAt: 4000});
  const result = Marked.buildDiscussionExport({[first.bvid]: first, [second.bvid]: second}, {minViews: 5000}, 5000);
  assert.equal(result.purpose, "bilibili-filter-rule-discussion");
  assert.equal(result.count, 2);
  assert.deepEqual(result.summary.categories[0], {name: "数码", count: 2});
  assert.deepEqual(result.summary.tags[0], {name: "华为", count: 2});
  assert.deepEqual(result.summary.matchedTopics[0], {name: "huawei", count: 2});
  assert.equal(result.videos[0].bvid, "BV0987654321");
  assert.deepEqual(result.currentFilterSettings, {minViews: 5000});
});

test("备注独立保存在持久快照中", () => {
  const snapshot = Marked.createSnapshot(sample(), {note: "希望以后过滤此类视频"});
  const collection = Marked.normalizeCollection({[snapshot.bvid]: snapshot});
  assert.equal(collection[snapshot.bvid].note, "希望以后过滤此类视频");
});

test("未知数值在快照中保持为空而不是零", () => {
  const snapshot = Marked.createSnapshot(sample({followerCount: undefined, effectiveThresholds: {maxViews: null}}));
  assert.equal(snapshot.uploader.followerCount, null);
  assert.equal(snapshot.effectiveThresholds.maxViews, null);
});
