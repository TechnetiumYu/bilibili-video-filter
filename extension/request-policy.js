(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliRequestPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COOLDOWN_DELAYS_MS = Object.freeze([30000, 120000, 300000, 900000]);
  const STRIKE_WINDOW_MS = 30 * 60 * 1000;

  function nextRateLimitState(previous = {}, now = Date.now(), endpoint = "B站接口") {
    const recent = now - Number(previous.lastTriggeredAt || 0) < STRIKE_WINDOW_MS;
    const strikes = recent ? Math.min(COOLDOWN_DELAYS_MS.length, Number(previous.strikes || 0) + 1) : 1;
    const waitMs = COOLDOWN_DELAYS_MS[Math.min(strikes - 1, COOLDOWN_DELAYS_MS.length - 1)];
    return {strikes, lastTriggeredAt: now, until: now + waitMs, endpoint, waitMs};
  }

  function rateLimitStatus(state = {}, now = Date.now()) {
    const retryAfterMs = Math.max(0, Number(state.until || 0) - now);
    return {
      rateLimited: retryAfterMs > 0,
      retryAfterMs,
      endpoint: String(state.endpoint || ""),
    };
  }

  function candidateCacheMode(entry, now = Date.now(), freshMs = 120000, staleMs = 1800000) {
    if (!entry || typeof entry !== "object") return "miss";
    const age = now - Number(entry.fetchedAt || 0);
    if (age >= 0 && age < freshMs) return "fresh";
    if (age >= 0 && age < staleMs) return "stale";
    return "expired";
  }

  return {COOLDOWN_DELAYS_MS, STRIKE_WINDOW_MS, nextRateLimitState, rateLimitStatus, candidateCacheMode};
});
