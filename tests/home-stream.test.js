const test = require("node:test");
const assert = require("node:assert/strict");
const {JSDOM} = require("jsdom");
const HomeStream = require("../extension/home-stream.js");

const bv = index => `BV${String(index).padStart(10, "0")}`;
const item = index => ({bvid: bv(index), title: `测试视频 ${index}`});
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

async function settle() {
  // 所有请求和筛选结果均由测试决定；只排空有限次数的微任务，不等待真实网络或计时器。
  for (let index = 0; index < 12; index += 1) await tick();
}

function harness(t, options = {}) {
  const dom = new JSDOM(`<main><div class="native-grid" style="display:grid;grid-template-columns:300px 300px;gap:20px"><article class="native-card"></article></div></main>`, {
    url: "https://www.bilibili.com/",
  });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  let bottom = options.bottom ?? 1100;
  Object.defineProperty(dom.window, "innerHeight", {value: 800, configurable: true});
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return {x: 0, y: 0, top: 0, left: 0, right: 620,
      width: 620, height: this.classList.contains("bvf-home-stream") ? bottom : 400,
      bottom: this.classList.contains("bvf-home-stream") ? bottom : 400};
  };
  const state = {
    enabled: true, visible: true, suspended: false, checking: false,
    roots: [document.querySelector(".native-card")], bvids: [bv(0)],
    statuses: new Map([[bv(0), "accepted"]]),
    ...options.state,
  };
  const calls = [], appended = [], errors = [], changes = [], statuses = [], resumes = [];
  const stream = HomeStream.create(document, {
    getState: () => state,
    fetchCandidates: request => {
      calls.push({...request});
      return options.fetchCandidates?.(request, calls.length) ?? Promise.resolve({items: [], noMore: true});
    },
    appendCandidates: (grid, items) => {
      appended.push(items.map(entry => entry.bvid));
      for (const entry of items) {
        const card = document.createElement("article");
        card.dataset.bvid = entry.bvid;
        grid.append(card);
        state.roots.push(card);
        state.bvids.push(entry.bvid);
        state.statuses.set(entry.bvid, options.appendStatus ?? "pending");
      }
      options.appendCandidates?.(grid, items, state, {setBottom: value => { bottom = value; }});
    },
    onChange: () => { changes.push(true); options.onChange?.(state); },
    onError: error => { errors.push(error); },
    onStatus: text => { statuses.push(text); },
    onResume: () => { resumes.push(true); options.onResume?.(state); },
  });
  t.after(() => stream.clear());
  return {stream, document, state, calls, appended, errors, changes, statuses, resumes,
    setBottom: value => { bottom = value; },
    section: () => document.querySelector(".bvf-home-stream"),
    status: () => document.querySelector('[role="status"]')?.textContent,
    button: () => document.querySelector(".bvf-stream-footer button"),
  };
}

test("连续加载在近底逐批补齐，远离底部不请求，回到底部继续下一页", {timeout: 3000}, async t => {
  const h = harness(t, {
    bottom: 2500,
    appendStatus: "accepted",
    fetchCandidates: async ({batch}) => ({items: [item(batch)], noMore: batch === 3}),
    appendCandidates: (_grid, entries, state, view) => {
      if (entries[0].bvid === bv(1)) state.statuses.set(bv(1), "rejected");
      if (entries[0].bvid === bv(2)) view.setBottom(2500);
    },
  });
  await h.stream.update();
  assert.equal(h.calls.length, 0);
  assert.match(h.status(), /继续向下滚动/);
  h.setBottom(1100);
  await h.stream.update();
  await settle();
  assert.deepEqual(h.calls.map(call => call.batch), [1, 2]);
  assert.deepEqual(h.appended, [[bv(1)], [bv(2)]]);
  await h.stream.update();
  assert.equal(h.calls.length, 2);
  h.setBottom(1100);
  await h.stream.update();
  await settle();
  assert.deepEqual(h.calls.map(call => call.batch), [1, 2, 3]);
  assert.deepEqual(h.appended[2], [bv(3)]);
});

test("连续加载同一时刻只有一个在途请求", {timeout: 3000}, async t => {
  const response = deferred();
  const h = harness(t, {fetchCandidates: () => response.promise});
  const first = h.stream.update();
  await Promise.all([h.stream.update(), h.stream.update(), h.stream.update()]);
  assert.deepEqual(h.calls, [{batch: 1}]);
  assert.equal(h.button().disabled, true);
  response.resolve({items: [item(1)], noMore: true});
  await first;
  assert.equal(h.button().disabled, false);
  assert.equal(h.appended.length, 1);
});

test("候选BV跨批及批内去重，并排除主页面已见BV和非法编号", {timeout: 3000}, async t => {
  const h = harness(t, {
    appendStatus: "accepted",
    fetchCandidates: async ({batch}) => batch === 1
      ? {items: [item(0), item(1), item(1), {bvid: "av123"}, {bvid: "BVbad"}, null, {}]}
      : {items: [item(1), item(2), item(2), item(3)], noMore: true},
    appendCandidates: (_grid, entries, _state, view) => {
      if (entries.some(entry => entry.bvid === bv(1))) view.setBottom(2500);
    },
  });
  await h.stream.update();
  await settle();
  assert.deepEqual(h.appended, [[bv(1)]]);
  // 用户浏览期间，原生推荐流又新增了一个BV，也应进入去重集合。
  h.state.bvids.push(bv(3));
  h.setBottom(1100);
  await h.stream.update();
  assert.deepEqual(h.appended, [[bv(1)], [bv(2)]]);
});

test("连续五批没有新BV后转手动，继续查找可从下一批恢复", {timeout: 3000}, async t => {
  const h = harness(t, {
    appendStatus: "accepted",
    fetchCandidates: async ({batch}) => batch <= 5
      ? {items: batch % 2 ? [item(0)] : []}
      : {items: [item(6)], noMore: true},
  });
  assert.equal(HomeStream.EMPTY_BATCH_LIMIT, 5);
  await h.stream.update();
  await settle();
  assert.deepEqual(h.calls.map(call => call.batch), [1, 2, 3, 4, 5]);
  assert.equal(h.appended.length, 0);
  assert.match(h.status(), /连续多批/);
  assert.equal(h.button().textContent, "继续查找");
  await h.stream.update();
  await h.stream.update();
  assert.equal(h.calls.length, 5);
  await h.stream.resume();
  assert.equal(h.resumes.length, 1);
  assert.deepEqual(h.calls.map(call => call.batch), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(h.appended, [[bv(6)]]);
});

test("连续五批候选全部被拒绝后停止自动补齐", {timeout: 3000}, async t => {
  const h = harness(t, {
    appendStatus: "rejected",
    fetchCandidates: async ({batch}) => ({items: [item(batch)]}),
  });
  await h.stream.update();
  await settle();
  assert.equal(h.calls.length, 5);
  assert.equal(h.appended.length, 5);
  assert.match(h.status(), /连续多批/);
  for (let index = 0; index < 3; index += 1) await h.stream.update();
  assert.equal(h.calls.length, 5);
});

test("通过一批视频会重置连续无合格结果计数", {timeout: 3000}, async t => {
  const h = harness(t, {
    appendStatus: "rejected",
    fetchCandidates: async ({batch}) => ({items: [item(batch)]}),
    appendCandidates: (_grid, entries, state) => {
      if (entries[0].bvid === bv(5)) state.statuses.set(bv(5), "accepted");
    },
  });
  await h.stream.update();
  await settle();
  assert.equal(h.calls.length, 10);
  assert.match(h.status(), /连续多批/);
});

test("网络失败不自动重试，手动恢复重试失败的同一页", {timeout: 3000}, async t => {
  const h = harness(t, {
    fetchCandidates: async (_request, count) => {
      if (count === 1) throw new Error("HTTP 412");
      return {items: [item(1)], noMore: true};
    },
  });
  await h.stream.update();
  await settle();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /412/);
  assert.ok(h.statuses.some(text => /加载失败.*412/.test(text)));
  for (let index = 0; index < 3; index += 1) await h.stream.update();
  await settle();
  assert.deepEqual(h.calls, [{batch: 1}]);
  await h.stream.resume();
  assert.deepEqual(h.calls, [{batch: 1}, {batch: 1}]);
  assert.deepEqual(h.appended, [[bv(1)]]);
});

test("无效推荐响应也停止且手动重试不跳页", {timeout: 3000}, async t => {
  const h = harness(t, {
    fetchCandidates: async (_request, count) => count === 1 ? {items: null} : {items: [], noMore: true},
  });
  await h.stream.update();
  assert.match(h.errors[0].message, /未返回有效视频列表/);
  await h.stream.update();
  assert.equal(h.calls.length, 1);
  await h.stream.resume();
  assert.deepEqual(h.calls, [{batch: 1}, {batch: 1}]);
});

test("接口明确没有更多时停止，只有手动再检查才请求", {timeout: 3000}, async t => {
  const h = harness(t, {fetchCandidates: async () => ({items: [], noMore: true})});
  await h.stream.update();
  await settle();
  await h.stream.update();
  assert.match(h.status(), /暂时没有更多推荐/);
  assert.equal(h.button().textContent, "再检查一次");
  await h.stream.update();
  assert.equal(h.calls.length, 1);
  await h.stream.resume();
  assert.deepEqual(h.calls, [{batch: 1}, {batch: 2}]);
});

test("关闭功能或离开首页会清理，迟到响应不追加，重新开启从第一页开始", {timeout: 3000}, async t => {
  for (const action of ["disable", "leave"]) {
    const response = deferred();
    const h = harness(t, {
      fetchCandidates: (_request, count) => count === 1 ? response.promise : Promise.resolve({items: [], noMore: true}),
    });
    const first = h.stream.update();
    assert.ok(h.section(), action);
    if (action === "disable") {
      h.state.enabled = false;
      await h.stream.update();
    } else h.stream.clear();
    assert.equal(h.section(), null, action);
    response.resolve({items: [item(1)]});
    await first;
    await settle();
    assert.equal(h.section(), null, action);
    assert.equal(h.appended.length, 0, action);
    assert.equal(h.calls.length, 1, action);
    h.state.enabled = true;
    await h.stream.update();
    assert.deepEqual(h.calls, [{batch: 1}, {batch: 1}], action);
  }
});

test("隐藏标签页不发请求，恢复可见后才加载", {timeout: 3000}, async t => {
  const h = harness(t, {state: {visible: false}});
  await h.stream.update();
  await h.stream.resume();
  assert.equal(h.calls.length, 0);
  h.state.visible = true;
  await h.stream.update();
  assert.equal(h.calls.length, 1);
});

test("页面正在筛选或暂停时不抢先拉取下一批", {timeout: 3000}, async t => {
  const h = harness(t, {state: {checking: true}});
  await h.stream.update();
  assert.equal(h.calls.length, 0);
  assert.match(h.status(), /正在筛选页面视频/);
  h.state.checking = false;
  h.state.suspended = true;
  await h.stream.update();
  await h.stream.resume();
  assert.equal(h.calls.length, 0);
  assert.match(h.status(), /筛选已暂停/);
  h.state.suspended = false;
  await h.stream.update();
  assert.equal(h.calls.length, 1);
});

test("新候选仍待检查时不继续拉页，全部完成后才推进", {timeout: 3000}, async t => {
  const h = harness(t, {
    fetchCandidates: async ({batch}) => ({items: batch === 1 ? [item(1), item(2)] : [], noMore: batch > 1}),
  });
  await h.stream.update();
  await settle();
  assert.deepEqual(h.calls, [{batch: 1}]);
  assert.match(h.status(), /正在筛选新视频/);
  h.state.statuses.delete(bv(1));
  h.state.statuses.set(bv(2), "accepted");
  await h.stream.update();
  assert.equal(h.calls.length, 1);
  h.state.statuses.set(bv(1), "rejected");
  await h.stream.update();
  assert.deepEqual(h.calls, [{batch: 1}, {batch: 2}]);
});

test("新候选检查失败不会继续拉页，重试筛选通过后可手动继续", {timeout: 3000}, async t => {
  const h = harness(t, {
    appendStatus: "error",
    fetchCandidates: async ({batch}) => ({items: batch === 1 ? [item(1)] : [], noMore: batch > 1}),
    onResume: state => { state.statuses.set(bv(1), "accepted"); },
  });
  await h.stream.update();
  await settle();
  assert.equal(h.calls.length, 1);
  await h.stream.update();
  assert.equal(h.calls.length, 1);
  await h.stream.resume();
  assert.deepEqual(h.calls, [{batch: 1}, {batch: 2}]);
});

test("待检查候选从活动列表和决策状态消失后不会永久等待，可继续下一页", {timeout: 3000}, async t => {
  const h = harness(t, {
    fetchCandidates: async ({batch}) => batch === 1
      ? {items: [item(1)]}
      : {items: [], noMore: true},
  });
  await h.stream.update();
  await settle();
  assert.deepEqual(h.calls, [{batch: 1}]);
  assert.match(h.status(), /正在筛选新视频/);
  const removed = h.document.querySelector(`[data-bvid="${bv(1)}"]`);
  removed.remove();
  h.state.roots = h.state.roots.filter(root => root !== removed);
  h.state.bvids = h.state.bvids.filter(bvid => bvid !== bv(1));
  h.state.statuses.delete(bv(1));
  await h.stream.update();
  await settle();
  assert.deepEqual(h.calls, [{batch: 1}, {batch: 2}]);
  assert.match(h.status(), /暂时没有更多推荐/);
  await h.stream.update();
  assert.equal(h.calls.length, 2);
});

test("原生推荐网格被替换会清理旧托管区，旧响应不会追加或解锁新请求", {timeout: 3000}, async t => {
  const oldResponse = deferred();
  const replacementResponse = deferred();
  const h = harness(t, {
    fetchCandidates: (_request, count) => count === 1 ? oldResponse.promise : replacementResponse.promise,
  });
  const first = h.stream.update();
  const oldSection = h.section();
  const oldSource = h.document.querySelector(".native-grid");
  const replacement = h.document.createElement("div");
  replacement.className = "native-grid";
  replacement.style.cssText = "display:grid;grid-template-columns:300px 300px;gap:20px";
  const replacementCard = h.document.createElement("article");
  replacementCard.className = "native-card";
  replacement.append(replacementCard);
  oldSource.replaceWith(replacement);
  h.state.roots = [replacementCard];
  h.state.bvids = [bv(4)];
  h.state.statuses = new Map([[bv(4), "accepted"]]);
  const second = h.stream.update();
  assert.equal(oldSection.isConnected, false);
  assert.notEqual(h.section(), oldSection);
  assert.equal(h.document.querySelectorAll(".bvf-home-stream").length, 1);
  assert.deepEqual(h.calls, [{batch: 1}, {batch: 1}]);
  oldResponse.resolve({items: [item(1)]});
  await first;
  await settle();
  assert.equal(h.appended.length, 0);
  assert.equal(h.button().disabled, true);
  await h.stream.update();
  assert.equal(h.calls.length, 2);
  replacementResponse.resolve({items: [item(2)], noMore: true});
  await second;
  assert.deepEqual(h.appended, [[bv(2)]]);
  assert.equal(h.button().disabled, false);
});
