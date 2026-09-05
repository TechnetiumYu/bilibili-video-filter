(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliWbi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MIXIN_KEY_ENC_TAB = Object.freeze([
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ]);

  const MD5_SHIFT = Object.freeze([
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]);
  const MD5_CONSTANT = Object.freeze(Array.from({length: 64}, (_, index) =>
    Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0));

  function rotateLeft(value, amount) {
    return ((value << amount) | (value >>> (32 - amount))) >>> 0;
  }

  function md5(value) {
    const input = new TextEncoder().encode(String(value));
    const totalLength = Math.ceil((input.length + 9) / 64) * 64;
    const bytes = new Uint8Array(totalLength);
    bytes.set(input);
    bytes[input.length] = 0x80;
    const view = new DataView(bytes.buffer);
    const bitLength = input.length * 8;
    view.setUint32(totalLength - 8, bitLength >>> 0, true);
    view.setUint32(totalLength - 4, Math.floor(bitLength / 0x100000000), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    for (let offset = 0; offset < totalLength; offset += 64) {
      const words = Array.from({length: 16}, (_, index) => view.getUint32(offset + index * 4, true));
      let a = a0;
      let b = b0;
      let c = c0;
      let d = d0;
      for (let index = 0; index < 64; index += 1) {
        let f;
        let wordIndex;
        if (index < 16) {
          f = (b & c) | (~b & d);
          wordIndex = index;
        } else if (index < 32) {
          f = (d & b) | (~d & c);
          wordIndex = (5 * index + 1) % 16;
        } else if (index < 48) {
          f = b ^ c ^ d;
          wordIndex = (3 * index + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          wordIndex = (7 * index) % 16;
        }
        const nextD = d;
        d = c;
        c = b;
        const sum = (a + f + MD5_CONSTANT[index] + words[wordIndex]) >>> 0;
        b = (b + rotateLeft(sum, MD5_SHIFT[index])) >>> 0;
        a = nextD;
      }
      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }

    return [a0, b0, c0, d0]
      .flatMap(word => [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff])
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function keyFromUrl(value) {
    const match = String(value || "").match(/\/([^/]+)\.[^.]+$/);
    return match ? match[1] : "";
  }

  function mixinKey(imgKey, subKey) {
    const source = `${imgKey || ""}${subKey || ""}`;
    if (source.length < 64) throw new Error("B站 WBI 密钥格式无效");
    return MIXIN_KEY_ENC_TAB.map(index => source[index]).join("").slice(0, 32);
  }

  function signParams(input, imgKey, subKey, timestamp = Math.floor(Date.now() / 1000)) {
    const params = {...input, wts: Math.max(0, Math.floor(Number(timestamp) || 0))};
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value).replace(/[!'()*]/g, ""))}`)
      .join("&");
    const wRid = md5(query + mixinKey(imgKey, subKey));
    return {query, wRid, queryString: `${query}&w_rid=${wRid}`};
  }

  return {MIXIN_KEY_ENC_TAB, md5, keyFromUrl, mixinKey, signParams};
});
