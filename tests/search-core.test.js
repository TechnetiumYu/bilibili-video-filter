const test = require("node:test");
const assert = require("node:assert/strict");
const Search = require("../extension/search-core.js");

test("搜索视频直接复用响应中的完整过滤元数据", () => {
  const video = Search.normalizeItem({
    type: "video",
    bvid: "BV1tG411M7Yb",
    mid: 381927576,
    title: '【开箱】<em class="keyword">华为</em>鼠标垫',
    description: "已有简介",
    tag: "华为,鸿蒙,数码",
    author: "一袋儿盐",
    pic: "//i0.hdslb.com/cover.jpg",
    duration: "7:28",
    pubdate: 1669463590,
    typeid: "95",
    typename: "数码",
    play: 187465,
  });

  assert.equal(video.title, "【开箱】华为鼠标垫");
  assert.deepEqual(video.tags, ["华为", "鸿蒙", "数码"]);
  assert.equal(video.duration, 448);
  assert.equal(video.coverUrl, "https://i0.hdslb.com/cover.jpg");
  assert.equal(video.detailsAvailable, true);
});

test("搜索标准化兼容 uid 字段并排除非视频结果", () => {
  assert.equal(Search.normalizeItem({type: "ketang", bvid: "", mid: 1}), null);
  assert.equal(Search.normalizeItem({type: "video", bvid: "BV1234567890", uid: 42, description: "", tag: ""}).uploaderId, "42");
});

test("搜索分页响应保留总数并正确判断末页", () => {
  const response = Search.normalizeResponse({
    numResults: 41,
    numPages: 3,
    result: [{type: "video", bvid: "BV1234567890", mid: 42, description: "", tag: ""}],
  }, 3);
  assert.equal(response.total, 41);
  assert.equal(response.noMore, true);
  assert.equal(response.items.length, 1);
});
