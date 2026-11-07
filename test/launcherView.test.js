'use strict';

// Phase 13：悬浮球交互层的单测。
// 手势判定是纯函数；视图装配用假 document / 假 window / 假 api（不碰 Electron、不碰 DOM）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DRAG_THRESHOLD_PX, STATE_CLASSES, EFFECT_CLASSES,
  gestureOf, effectClassOf, stateClassOf, createLauncherView,
} = require('../src/renderer/launcher');

// ---- 手势判定（纯函数）----

test('悬浮手势 1：阈值内是点击，超过阈值是拖动', () => {
  assert.equal(DRAG_THRESHOLD_PX, 4);
  assert.equal(gestureOf({ dx: 0, dy: 0 }), 'click');
  assert.equal(gestureOf({ dx: 3, dy: 0 }), 'click');
  // 正好 4px 仍然算阈值内（不把抖动当拖动）。
  assert.equal(gestureOf({ dx: 4, dy: 0 }), 'click');
  assert.equal(gestureOf({ dx: 5, dy: 0 }), 'drag');
  assert.equal(gestureOf({ dx: -40, dy: 0 }), 'drag');
  // 斜向位移按直线距离算：3-4-5 的 4px 直线距离已经超过阈值。
  assert.equal(gestureOf({ dx: 3, dy: 3 }), 'drag');
  assert.equal(gestureOf({ dx: 2, dy: 2 }), 'click');
  // 阈值可注入。
  assert.equal(gestureOf({ dx: 10, dy: 0 }, 20), 'click');
  // 坏输入当作没动。
  assert.equal(gestureOf(undefined), 'click');
  assert.equal(gestureOf({ dx: 'a', dy: NaN }), 'click');
});

// ---- 视图装配（假 DOM）----

function fakeClassList() {
  const set = new Set();
  // ops 记录调用顺序：重现「同一特效连续两次」时要断言先 remove 再 add。
  const ops = [];
  return {
    set,
    ops,
    add(name) { set.add(name); ops.push(`+${name}`); },
    remove(name) { set.delete(name); ops.push(`-${name}`); },
    contains: (name) => set.has(name),
  };
}

function fakeDoc() {
  return {
    body: { classList: fakeClassList() },
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    dispatch(type, event) {
      for (const handler of this.listeners[type] ?? []) handler(event);
    },
  };
}

function fakeApi() {
  const calls = [];
  const api = {
    calls,
    openMain: async () => { calls.push('openMain'); },
    dragMove: (position) => { calls.push({ type: 'move', position }); },
    dragEnd: async () => { calls.push('dragEnd'); },
    showContextMenu: async () => { calls.push('showContextMenu'); },
  };
  // preload 的 onEvent 会把回调存下来：测试直接把它当入口派发 Main 推来的事件。
  api.onEvent = (callback) => { api.eventHandler = callback; };
  return api;
}

// 按下 / 移动 / 抬起三个动作，坐标是屏幕坐标（与真实 MouseEvent 一致）。
const down = (doc, x, y, button = 0) => doc.dispatch('mousedown', { button, screenX: x, screenY: y, preventDefault() {} });
const move = (doc, x, y) => doc.dispatch('mousemove', { screenX: x, screenY: y });
const up = (doc) => doc.dispatch('mouseup', {});

// 点击路径里 openMain 是异步的：派发后等一个宏任务再断言。
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeView({ screenX = 100, screenY = 200 } = {}) {
  const doc = fakeDoc();
  const api = fakeApi();
  createLauncherView({ api, doc, view: { screenX, screenY } });
  return { doc, api };
}

test('悬浮手势 2：阈值内的按下抬起是点击，只打开主窗口', async () => {
  const { doc, api } = makeView();

  down(doc, 300, 400);
  move(doc, 301, 402);
  move(doc, 302, 401);
  up(doc);
  await flush();

  assert.deepEqual(api.calls, ['openMain']);
});

test('悬浮手势 3：超过阈值是拖动，松手保存位置且不打开主窗口', async () => {
  const { doc, api } = makeView({ screenX: 100, screenY: 200 });

  down(doc, 300, 400);
  // 3px：还是点击范畴，不动窗口。
  move(doc, 303, 400);
  assert.deepEqual(api.calls, []);

  // 40px：进入拖动，位置 = 按下时的窗口位置 + 累计位移。
  move(doc, 340, 400);
  move(doc, 400, 430);
  up(doc);
  await flush();

  assert.deepEqual(api.calls, [
    { type: 'move', position: { x: 140, y: 200 } },
    { type: 'move', position: { x: 200, y: 230 } },
    'dragEnd',
  ]);
});

test('悬浮手势 4：拖动过程会标出 dragging，松手后清掉', () => {
  const { doc, api } = makeView();

  down(doc, 300, 400);
  assert.equal(doc.body.classList.contains('dragging'), false);
  move(doc, 320, 400);
  assert.equal(doc.body.classList.contains('dragging'), true);

  up(doc);
  assert.equal(doc.body.classList.contains('dragging'), false);
});

test('悬浮手势 5：拖动之后再单击仍然正常打开主窗口', async () => {
  const { doc, api } = makeView();

  // 第一次：拖动。
  down(doc, 300, 400);
  move(doc, 360, 460);
  up(doc);
  await flush();
  assert.deepEqual(api.calls, [{ type: 'move', position: { x: 160, y: 260 } }, 'dragEnd']);

  // 第二次：原地点一下，不应该被上一次拖动影响。
  down(doc, 360, 460);
  up(doc);
  await flush();
  assert.equal(api.calls.at(-1), 'openMain');
});

test('悬浮手势 6：没按下时移动不发 IPC，右键也不被当成手势', async () => {
  const { doc, api } = makeView();

  // 没按下：鼠标划过窗口不应该发位置。
  move(doc, 500, 500);
  assert.deepEqual(api.calls, []);

  // 右键：不开始手势，抬起也不打开主窗口。
  down(doc, 300, 400, 2);
  move(doc, 400, 400);
  up(doc);
  await flush();
  assert.deepEqual(api.calls, []);
});

test('悬浮手势 7：抬起时没有按下状态（窗口失去鼠标）不会重复触发', async () => {
  const { doc, api } = makeView();

  up(doc);
  up(doc);
  await flush();
  assert.deepEqual(api.calls, []);

  // 一次按下只对应一次动作：抬起两次也只打开一次。
  down(doc, 300, 400);
  up(doc);
  up(doc);
  await flush();
  assert.deepEqual(api.calls, ['openMain']);
});

// ---- Phase 13.1：事件 -> body class（纯函数）----

test('悬浮特效 1：事件类型映射到特效 class，未知类型不产生特效', () => {
  assert.equal(effectClassOf({ type: 'record' }), 'effect-shutter');
  assert.equal(effectClassOf({ type: 'analysis' }), 'effect-success');
  assert.equal(effectClassOf({ type: 'error' }), 'effect-error');
  // status 是持续态，不是特效；未知 / 坏输入一律 null。
  assert.equal(effectClassOf({ type: 'status', running: true }), null);
  assert.equal(effectClassOf({ type: 'ai' }), null);
  assert.equal(effectClassOf({}), null);
  assert.equal(effectClassOf(null), null);
  assert.equal(effectClassOf(undefined), null);

  assert.deepEqual([...STATE_CLASSES], ['state-running', 'state-paused']);
  assert.deepEqual(EFFECT_CLASSES, {
    record: 'effect-shutter', analysis: 'effect-success', error: 'effect-error',
  });
});

test('悬浮特效 2：录制状态映射到持续态 class，坏输入按已暂停', () => {
  assert.equal(stateClassOf(true), 'state-running');
  assert.equal(stateClassOf(false), 'state-paused');
  // 只认真布尔 true：宁可显示成暂停，也不显示出假的「正在记录」。
  assert.equal(stateClassOf(undefined), 'state-paused');
  assert.equal(stateClassOf('true'), 'state-paused');
  assert.equal(stateClassOf(1), 'state-paused');
});

// ---- Phase 13.1：视图装配（假 DOM）----

const animationEnd = (doc, animationName) => doc.dispatch('animationend', { animationName });
const contextMenu = (doc) => doc.dispatch('contextmenu', { preventDefault() { doc.prevented = true; } });

test('悬浮特效 3：status 事件切换持续态 class，两个状态不会同时存在', () => {
  const { doc, api } = makeView();
  assert.equal(typeof api.eventHandler, 'function', '视图应该订阅了事件');

  api.eventHandler({ type: 'status', running: true });
  assert.equal(doc.body.classList.contains('state-running'), true);
  assert.equal(doc.body.classList.contains('state-paused'), false);

  api.eventHandler({ type: 'status', running: false });
  assert.equal(doc.body.classList.contains('state-running'), false);
  assert.equal(doc.body.classList.contains('state-paused'), true);

  // 重复的相同状态：结果稳定，不会堆出两个状态。
  api.eventHandler({ type: 'status', running: false });
  assert.equal(doc.body.classList.contains('state-paused'), true);
  assert.equal(doc.body.classList.contains('state-running'), false);
});

test('悬浮特效 4：三个瞬时事件各自加 class，animationend 后自动摘掉', () => {
  const { doc, api } = makeView();
  const cases = [
    [{ type: 'record' }, 'effect-shutter', 'shutter-ring'],
    [{ type: 'analysis' }, 'effect-success', 'success-ring'],
    [{ type: 'error' }, 'effect-error', 'error-ring'],
  ];

  for (const [payload, className, animationName] of cases) {
    api.eventHandler(payload);
    assert.equal(doc.body.classList.contains(className), true, `${className} 应该在事件后被加上`);
    animationEnd(doc, animationName);
    assert.equal(doc.body.classList.contains(className), false, `${className} 应该在动画结束后被摘掉`);
  }

  // 与特效无关的动画名（例如将来的新特效）不会误摘。
  api.eventHandler({ type: 'error' });
  animationEnd(doc, 'some-other-animation');
  assert.equal(doc.body.classList.contains('effect-error'), true);
});

test('悬浮特效 5：同类特效连续触发会重播（先摘后挂），不同类特效可以叠加', () => {
  const { doc, api } = makeView();

  api.eventHandler({ type: 'record' });
  doc.body.classList.ops.length = 0;
  api.eventHandler({ type: 'record' });
  // 先 remove 再 add：中间那次 reflow 让动画从头播，而不是被忽略、也不会堆 class。
  assert.deepEqual(doc.body.classList.ops, ['-effect-shutter', '+effect-shutter']);

  // 两个不同特效同时挂：各自独立，先结束的那个只回收自己。
  api.eventHandler({ type: 'record' });
  api.eventHandler({ type: 'analysis' });
  assert.equal(doc.body.classList.contains('effect-shutter'), true);
  assert.equal(doc.body.classList.contains('effect-success'), true);

  animationEnd(doc, 'success-ring');
  assert.equal(doc.body.classList.contains('effect-success'), false);
  assert.equal(doc.body.classList.contains('effect-shutter'), true);
});

test('悬浮特效 6：未知事件类型不改变任何 class', () => {
  const { doc, api } = makeView();

  for (const payload of [{ type: 'ai' }, { type: 'summary' }, {}, null, undefined]) {
    api.eventHandler(payload);
  }
  assert.deepEqual([...doc.body.classList.set], []);
});

test('悬浮特效 7：右键交给 Main 弹菜单，默认菜单被没收', async () => {
  const { doc, api } = makeView();

  contextMenu(doc);
  await flush();
  assert.equal(doc.prevented, true);
  assert.deepEqual(api.calls, ['showContextMenu']);

  // 右键不应该被当成手势：不打开主窗口、不发位置。
  down(doc, 300, 400, 2);
  move(doc, 400, 400);
  up(doc);
  await flush();
  assert.deepEqual(api.calls, ['showContextMenu']);
});

test('悬浮特效 8：老版 preload（没有 onEvent / showContextMenu）不会报错', async () => {
  const doc = fakeDoc();
  const calls = [];
  createLauncherView({
    api: { openMain: async () => calls.push('openMain'), dragMove() {}, dragEnd: async () => {} },
    doc,
    view: { screenX: 0, screenY: 0 },
  });

  contextMenu(doc);
  await flush();
  assert.equal(doc.prevented, true);
  assert.deepEqual(calls, []);

  // 手势照常可用。
  down(doc, 300, 400);
  up(doc);
  await flush();
  assert.deepEqual(calls, ['openMain']);
});


// ---- Phase 13.3：待机（持续态）的小镜 ----

// 小镜的假节点：只实现 isTimeline 认的三个 SMIL 入口，并把调用顺序记下来。
function fakeMascot() {
  const ops = [];
  return {
    ops,
    pauseAnimations() { ops.push('pause'); },
    unpauseAnimations() { ops.push('unpause'); },
    setCurrentTime(seconds) { ops.push(`t=${seconds}`); },
  };
}

// 带小镜的假 doc：querySelector('.mascot-<state>') 返回一个能再查 'svg' 的容器。
function fakeDocWithMascots(states) {
  const doc = fakeDoc();
  const nodes = new Map(states.map((state) => [state, fakeMascot()]));
  doc.querySelector = (selector) => {
    const matched = /^\.mascot-(\w+)$/.exec(selector);
    const node = matched ? nodes.get(matched[1]) : null;
    return node ? { querySelector: (tag) => (tag === 'svg' ? node : null) } : null;
  };
  return { doc, nodes };
}

test('悬浮特效 9：录制中放开待机小镜，暂停时冻回第一帧', () => {
  const { doc, nodes } = fakeDocWithMascots(['smug', 'thinking', 'happy', 'idle']);
  const api = fakeApi();
  createLauncherView({ api, doc, view: { screenX: 0, screenY: 0 } });

  // 一加载：四只全部冻在第 0 帧 —— 待机那只也在内，第一次 status 到达之前它不该空转。
  for (const state of ['smug', 'thinking', 'happy', 'idle']) {
    assert.deepEqual(nodes.get(state).ops, ['pause', 't=0'], `${state} 应该被冻在第 0 帧`);
  }

  // 录制中（默认状态）：球亮着、外围扫光在转，小镜也跟着演，所以放开时间轴（先拨回第一帧）。
  api.eventHandler({ type: 'status', running: true });
  assert.deepEqual(nodes.get('idle').ops, ['pause', 't=0', 't=0', 'unpause']);

  // 暂停：冻回第一帧 —— 「一暂停整个圆标完全静止」这条信号要保住，脸换成小镜也一样。
  api.eventHandler({ type: 'status', running: false });
  assert.deepEqual(nodes.get('idle').ops, ['pause', 't=0', 't=0', 'unpause', 'pause', 't=0']);
});

test('悬浮特效 10：待机小镜与三个瞬时态互不干扰', () => {
  const { doc, nodes } = fakeDocWithMascots(['smug', 'thinking', 'happy', 'idle']);
  const api = fakeApi();
  createLauncherView({ api, doc, view: { screenX: 0, screenY: 0 } });

  api.eventHandler({ type: 'status', running: true });
  const idleOps = [...nodes.get('idle').ops];

  // 待机小镜在台上时来了一个瞬时特效：只有那只小镜被动，待机那只一步都不走
  // （它在 CSS 里被瞬时态盖住，但时间轴不跟着特效走）。
  api.eventHandler({ type: 'record' });
  assert.deepEqual(nodes.get('idle').ops, idleOps);
  assert.equal(nodes.get('smug').ops.at(-1), 'unpause');
});
