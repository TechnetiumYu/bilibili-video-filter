const test = require("node:test");
const assert = require("node:assert/strict");
const Policy = require("../extension/request-policy.js");

test("请求策略不再提供本地风控冷却调度", () => {
  assert.equal(Policy.nextRateLimitState, undefined);
  assert.equal(Policy.rateLimitStatus, undefined);
});

test("候选缓存区分新鲜、过期兜底和失效", () => {
  const now = 2000000;
  assert.equal(Policy.candidateCacheMode({fetchedAt: now - 1000}, now), "fresh");
  assert.equal(Policy.candidateCacheMode({fetchedAt: now - 300000}, now), "stale");
  assert.equal(Policy.candidateCacheMode({fetchedAt: now - 2000000}, now), "expired");
  assert.equal(Policy.candidateCacheMode(null, now), "miss");
});
