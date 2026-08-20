const test = require("node:test");
const assert = require("node:assert/strict");
const Policy = require("../extension/request-policy.js");

test("连续412按30秒、2分钟、5分钟、15分钟退避", () => {
  let state = {};
  const waits = [];
  for (let index = 0; index < 5; index += 1) {
    const next = Policy.nextRateLimitState(state, 1000 + index * 1000, "视频详情接口");
    waits.push(next.waitMs);
    state = next;
  }
  assert.deepEqual(waits, [30000, 120000, 300000, 900000, 900000]);
});

test("超过30分钟未触发后退避等级重置", () => {
  const previous = {strikes: 4, lastTriggeredAt: 1000, until: 2000};
  const next = Policy.nextRateLimitState(previous, 1000 + Policy.STRIKE_WINDOW_MS + 1, "推荐接口");
  assert.equal(next.strikes, 1);
  assert.equal(next.waitMs, 30000);
});

test("冷却状态返回准确剩余时间和接口", () => {
  assert.deepEqual(Policy.rateLimitStatus({until: 5000, endpoint: "粉丝数接口"}, 2000), {
    rateLimited: true,
    retryAfterMs: 3000,
    endpoint: "粉丝数接口",
  });
});

test("候选缓存区分新鲜、过期兜底和失效", () => {
  const now = 2000000;
  assert.equal(Policy.candidateCacheMode({fetchedAt: now - 1000}, now), "fresh");
  assert.equal(Policy.candidateCacheMode({fetchedAt: now - 300000}, now), "stale");
  assert.equal(Policy.candidateCacheMode({fetchedAt: now - 2000000}, now), "expired");
  assert.equal(Policy.candidateCacheMode(null, now), "miss");
});
