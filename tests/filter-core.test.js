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
