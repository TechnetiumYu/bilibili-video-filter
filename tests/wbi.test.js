const test = require("node:test");
const assert = require("node:assert/strict");
const Wbi = require("../extension/wbi.js");

test("MD5 实现通过标准向量", () => {
  assert.equal(Wbi.md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(Wbi.md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
});

test("WBI 签名通过公开固定样例", () => {
  const signed = Wbi.signParams(
    {foo: "114", bar: "514", zab: 1919810},
    "7cd084941338484aae1ad9425b84077c",
    "4932caff0ff746eab6f01bf08b70ac45",
    1702204169
  );
  assert.equal(Wbi.mixinKey(
    "7cd084941338484aae1ad9425b84077c",
    "4932caff0ff746eab6f01bf08b70ac45"
  ), "ea1db124af3c7062474693fa704f4ff8");
  assert.equal(signed.wRid, "8f6f2b5b3d485fe1886cec6a0be8c5d4");
  assert.match(signed.queryString, /wts=1702204169/);
});

test("WBI 参数会排序并移除签名不允许字符", () => {
  const signed = Wbi.signParams(
    {keyword: "测!试(词)", page: 1},
    "7cd084941338484aae1ad9425b84077c",
    "4932caff0ff746eab6f01bf08b70ac45",
    1702204169
  );
  assert.equal(signed.query.startsWith("keyword=%E6%B5%8B%E8%AF%95%E8%AF%8D&page=1&"), true);
});
