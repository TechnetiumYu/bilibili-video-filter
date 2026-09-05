(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliRequestPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function candidateCacheMode(entry, now = Date.now(), freshMs = 120000, staleMs = 1800000) {
    if (!entry || typeof entry !== "object") return "miss";
    const age = now - Number(entry.fetchedAt || 0);
    if (age >= 0 && age < freshMs) return "fresh";
    if (age >= 0 && age < staleMs) return "stale";
    return "expired";
  }

  return {candidateCacheMode};
});
