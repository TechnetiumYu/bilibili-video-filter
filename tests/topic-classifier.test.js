const test = require("node:test");
const assert = require("node:assert/strict");
const Classifier = require("../extension/topic-classifier.js");

const videos = [{
  bvid: "BV1234567890",
  title: "鸿蒙 NEXT 正式版体验",
  tags: ["HarmonyOS", "操作系统"],
  coverText: ["纯血鸿蒙终于来了"],
  description: "这部分不得发送",
  playCount: 999999,
  followerCount: 888888,
}];
const policies = [{id: "huawei", name: "华为", aliases: ["鸿蒙"], enabled: true}];

test("分类输入只包含标题、标签和封面文字", () => {
  assert.deepEqual(Classifier.classificationInput(videos[0]), {
    id: "BV1234567890",
    title: "鸿蒙 NEXT 正式版体验",
    tags: ["HarmonyOS", "操作系统"],
    coverText: ["纯血鸿蒙终于来了"],
  });
});

test("模型关闭时按话题名和补充关联词确定性匹配", () => {
  const results = Classifier.lexicalClassify(videos, policies);
  assert.equal(results[0].topics[0].id, "huawei");
  assert.equal(results[0].topics[0].confidence, 1);
  assert.equal(results[0].topics[0].evidence[0].source, "title");
});

test("模型提示明确语义关联、数据边界和不可信输入", () => {
  const messages = Classifier.buildMessages(videos, policies);
  assert.match(messages[0].content, /鸿蒙\/HarmonyOS.*华为/);
  assert.match(messages[0].content, /不可信数据/);
  assert.doesNotMatch(messages[1].content, /不得发送/);
  assert.doesNotMatch(messages[1].content, /999999/);
});

test("合法模型 JSON 被校验并保留证据", () => {
  const payload = {
    choices: [{message: {content: JSON.stringify({
      results: [{
        id: "BV1234567890",
        topics: [{
          id: "huawei",
          confidence: 0.97,
          evidence: [{source: "tag", text: "HarmonyOS", relation: "华为操作系统"}],
        }],
      }],
    })}}],
  };
  const results = Classifier.validateResults(payload, videos, policies);
  assert.equal(results[0].topics[0].confidence, 0.97);
  assert.equal(results[0].topics[0].evidence[0].text, "HarmonyOS");
});

test("模型不得返回未知话题或无证据命中", () => {
  const payload = {
    results: [{
      id: "BV1234567890",
      topics: [
        {id: "unknown", confidence: 1, evidence: [{source: "title", text: "伪造"}]},
        {id: "huawei", confidence: 1, evidence: []},
      ],
    }],
  };
  assert.deepEqual(Classifier.validateResults(payload, videos, policies)[0].topics, []);
});

test("模型伪造的不在输入中的证据会被丢弃", () => {
  const payload = {
    results: [{
      id: "BV1234567890",
      topics: [{
        id: "huawei",
        confidence: 1,
        evidence: [{source: "title", text: "标题中不存在的华为手机", relation: "伪造证据"}],
      }],
    }],
  };
  assert.deepEqual(Classifier.validateResults(payload, videos, policies)[0].topics, []);
});

test("模型缺失任一视频结果时失败关闭", () => {
  assert.throws(
    () => Classifier.validateResults({results: []}, videos, policies),
    /缺少视频/,
  );
});
