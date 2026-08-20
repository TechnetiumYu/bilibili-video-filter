const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../extension/filter-core.js");

function video(overrides = {}) {
  return {
    title: "普通的视频标题",
    description: "一段普通简介",
    tags: ["知识"],
    uploaderName: "示例UP主",
    playCount: 20000,
    followerCount: 20000,
    detailsAvailable: true,
    ...overrides,
  };
}

const settings = {
  blockedKeywords: ["破防", "引 战"],
  keywordScopes: {title: true, description: true, tags: true, uploaderName: false},
  minFollowers: 10000,
  maxFollowers: 5000000,
  minViews: 5000,
  maxViews: 1000000,
};

test("三项条件全部通过时才接受", () => {
  assert.equal(Core.evaluate(video(), settings).status, "accepted");
});

test("关键词匹配忽略空格和全角字符", () => {
  const result = Core.evaluate(video({title: "这次彻底破 防了"}), settings);
  assert.equal(result.status, "rejected");
  assert.equal(result.reasons[0].type, "keyword");
});

test("简介和标签中的关键词会被拦截", () => {
  assert.equal(Core.evaluate(video({description: "开始引战"}), settings).status, "rejected");
  assert.equal(Core.evaluate(video({tags: ["引 战"]}), settings).status, "rejected");
});

test("UP主名称仅在开关打开时参与匹配", () => {
  assert.equal(Core.evaluate(video({uploaderName: "破防现场"}), settings).status, "accepted");
  const enabled = {...settings, keywordScopes: {...settings.keywordScopes, uploaderName: true}};
  assert.equal(Core.evaluate(video({uploaderName: "破防现场"}), enabled).status, "rejected");
});

test("粉丝数和播放量使用包含边界", () => {
  assert.equal(Core.evaluate(video({followerCount: 10000, playCount: 5000}), settings).status, "accepted");
  assert.equal(Core.evaluate(video({followerCount: 5000000, playCount: 1000000}), settings).status, "accepted");
});

test("任一数值越界都会拒绝", () => {
  assert.equal(Core.evaluate(video({followerCount: 9999}), settings).status, "rejected");
  assert.equal(Core.evaluate(video({followerCount: 5000001}), settings).status, "rejected");
  assert.equal(Core.evaluate(video({playCount: 4999}), settings).status, "rejected");
  assert.equal(Core.evaluate(video({playCount: 1000001}), settings).status, "rejected");
});

test("粉丝或详情未知时严格不放行", () => {
  assert.equal(Core.evaluate(video({followerCount: undefined}), settings).status, "rejected");
  assert.equal(Core.evaluate(video({detailsAvailable: false}), settings).status, "rejected");
});

test("廉价预筛不要求粉丝数据", () => {
  const result = Core.evaluate(video({followerCount: undefined}), settings, {cheapOnly: true});
  assert.equal(result.status, "pending");
});

test("设置验证拒绝倒置区间", () => {
  const result = Core.validateSettings({...settings, minViews: 10, maxViews: 9});
  assert.deepEqual(result.errors, ["最低播放量不能大于最高播放量"]);
});

test("特殊话题命中后使用更高门槛", () => {
  const special = {
    ...settings,
    topicPolicies: [{
      id: "huawei",
      name: "华为",
      enabled: true,
      minViews: 200000,
      minFollowers: 100000,
      confidenceGte: 0.75,
    }],
  };
  const rejected = Core.evaluate(video({
    playCount: 80000,
    followerCount: 30000,
    topicMatches: [{id: "huawei", confidence: 0.98}],
    topicClassificationAvailable: true,
  }), special);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.effectiveThresholds.minViews, 200000);
  assert.equal(rejected.effectiveThresholds.minFollowers, 100000);
});

test("粉丝查询前即可按特殊话题播放量门槛拒绝", () => {
  const special = {
    ...settings,
    topicPolicies: [{id: "huawei", name: "华为", minViews: 200000, minFollowers: 100000}],
  };
  const result = Core.evaluate(video({
    playCount: 80000,
    followerCount: undefined,
    topicMatches: [{id: "huawei", confidence: 0.95}],
  }), special, {cheapOnly: true});
  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.some(reason => reason.type === "play_count"));
  assert.ok(result.reasons.every(reason => reason.type !== "follower_count"));
});

test("未命中特殊话题时继续使用全局门槛", () => {
  const special = {
    ...settings,
    topicPolicies: [{id: "huawei", name: "华为", minViews: 200000, minFollowers: 100000}],
  };
  const result = Core.evaluate(video({topicMatches: [], topicClassificationAvailable: true}), special);
  assert.equal(result.status, "accepted");
  assert.equal(result.effectiveThresholds.minViews, 5000);
  assert.equal(result.effectiveThresholds.minFollowers, 10000);
});

test("多个特殊话题命中时各项取最高门槛", () => {
  const special = {
    ...settings,
    topicPolicies: [
      {id: "huawei", name: "华为", minViews: 200000, minFollowers: 100000},
      {id: "conflict", name: "争议科技", minViews: 500000, minFollowers: 80000},
    ],
  };
  const effective = Core.resolveEffectiveThresholds(special, [
    {id: "huawei", confidence: 0.9},
    {id: "conflict", confidence: 0.9},
  ]);
  assert.equal(effective.minViews, 500000);
  assert.equal(effective.minFollowers, 100000);
});

test("低置信度话题不触发特殊门槛", () => {
  const special = {
    ...settings,
    topicPolicies: [{id: "huawei", name: "华为", minViews: 200000, confidenceGte: 0.8}],
  };
  const result = Core.evaluate(video({
    topicMatches: [{id: "huawei", confidence: 0.79}],
    topicClassificationAvailable: true,
  }), special);
  assert.equal(result.status, "accepted");
});

test("必要的话题分类失败时严格不放行", () => {
  const special = {
    ...settings,
    topicPolicies: [{id: "huawei", name: "华为", minViews: 200000}],
  };
  const result = Core.evaluate(video({topicClassificationAvailable: false}), special);
  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.some(reason => reason.field === "topic_classification"));
});

test("启用特殊话题后标签详情缺失时严格不放行", () => {
  const noKeywordDetailScopes = {
    ...settings,
    keywordScopes: {...settings.keywordScopes, description: false, tags: false},
    topicPolicies: [{id: "huawei", name: "华为", minViews: 200000}],
  };
  const result = Core.evaluate(video({
    detailsAvailable: false,
    topicClassificationAvailable: true,
  }), noKeywordDetailScopes);
  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.some(reason => reason.field === "video_details"));
});

test("特殊话题设置验证名称、重复项与门槛", () => {
  const result = Core.validateSettings({
    ...settings,
    topicPolicies: [
      {id: "one", name: "华为", minViews: 100},
      {id: "two", name: " 华 为 ", minFollowers: 100},
      {id: "three", name: "苹果"},
    ],
  });
  assert.ok(result.errors.includes("特殊话题“华 为”重复"));
  assert.ok(result.errors.includes("特殊话题“苹果”至少需要设置一个门槛"));
});
