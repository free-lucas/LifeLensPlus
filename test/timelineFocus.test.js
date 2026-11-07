'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Phase 11：Timeline 的「搜索结果定位」模式。
// 定位复用同一套查询与渲染：只改「查哪个时间窗口」和加一条横幅，不新建详情页面。

function fakeElement(id) {
  return {
    id,
    value: '',
    hidden: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    options: [],
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of this.listeners[type] ?? []) handler({ target: this, ...event });
    },
    replaceChildren(...children) {
      this.options = children;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    prepend() {},
    closest() {
      return null;
    },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function loadViewInSandbox() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'timeline.js'), 'utf8');
  const sandbox = {
    JSON,
    window: { lifelens: {} },
    document: {
      createElement: (tagName) => ({
        tagName,
        value: '',
        textContent: '',
        innerHTML: '',
        content: { firstElementChild: fakeElement('node') },
      }),
      // init() 找不到元素就直接返回：这组用例只测 createTimelineView。
      getElementById: () => null,
    },
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { view: sandbox.module.exports, sandbox };
}

function makeRoots() {
  const selects = {
    '#timeline-search': fakeElement('timeline-search'),
    '#timeline-range': fakeElement('timeline-range'),
    '#timeline-category': fakeElement('timeline-category'),
    '#timeline-project': fakeElement('timeline-project'),
    '#timeline-status': fakeElement('timeline-status'),
    '#timeline-custom-range': fakeElement('timeline-custom-range'),
    '#timeline-from': fakeElement('timeline-from'),
    '#timeline-to': fakeElement('timeline-to'),
    '#timeline-clear': fakeElement('timeline-clear'),
  };
  return {
    selects,
    container: fakeElement('timeline'),
    moreButton: fakeElement('timeline-more'),
    filterRoot: { querySelector: (selector) => selects[selector] ?? null },
  };
}

function record(id, time) {
  return {
    id,
    time,
    imagePath: '',
    analysisStatus: 'COMPLETED',
    analysis: {
      activity: '开发 SQLite 数据层',
      summary: '写 ActivityRepository',
      category: 'coding',
      project: 'Life Lens',
      keywords: ['SQLite'],
      confidence: 0.9,
    },
    summary: '写 ActivityRepository',
    error: null,
    errorCode: null,
  };
}

function makeView(itemsByQuery = () => [record('shot-1', '2026-09-17T13:00:01+08:00')]) {
  const { view } = loadViewInSandbox();
  const roots = makeRoots();
  const queries = [];
  const timeline = view.createTimelineView({
    container: roots.container,
    moreButton: roots.moreButton,
    filterRoot: roots.filterRoot,
    openImage: async () => {},
    getTimeline: async (query) => {
      queries.push(query);
      return { items: itemsByQuery(query), total: 1, hasMore: false, limit: 20, offset: 0 };
    },
    getFacets: async () => ({ categories: [], projects: [], hasUnassignedProject: false }),
  });
  return { timeline, roots, queries };
}

const FROM = new Date('2026-09-17T13:00:01+08:00');
const TO = new Date('2026-09-17T13:00:02+08:00');

test('定位 1：focus 用记录自己的时间窗口查询，并画出「已定位」横幅与高亮卡片', async () => {
  const { timeline, roots, queries } = makeView();

  assert.equal(await timeline.focus({ from: FROM, to: TO }, 'shot-1'), true);

  // 定位查询不走筛选栏：直接是 [from, to) 的精确窗口。
  assert.equal(queries.length, 1);
  assert.equal(queries[0].from.getTime(), FROM.getTime());
  assert.equal(queries[0].to.getTime(), TO.getTime());
  assert.equal(queries[0].limit, 20);
  assert.equal(timeline.isFocused(), true);

  assert.ok(roots.container.innerHTML.includes('timeline-focus'));
  assert.ok(roots.container.innerHTML.includes('data-clear-focus'));
  assert.ok(roots.container.innerHTML.includes('2026-09-17 13:00:01–13:00:02'));
  assert.ok(roots.container.innerHTML.includes('timeline-card-focus'), '命中的卡片被高亮');
  // 卡片时间必须显示到秒：截屏间隔 20 秒，只到分钟会让同一分钟的多条看起来时间相同。
  assert.ok(
    roots.container.innerHTML.includes('<span class="record-time">13:00:01</span>'),
    '卡片时间显示到秒',
  );
});

test('定位 2：点「查看完整时间线」回到筛选查询；改筛选也会退出定位', async () => {
  const { timeline, roots, queries } = makeView();
  await timeline.focus({ from: FROM, to: TO }, null);
  assert.equal(queries.length, 1);

  // 点横幅里的按钮：回到筛选查询（默认「全部时间」，不传时间范围）。
  roots.container.dispatch('click', {
    target: { closest: (selector) => (selector === 'button[data-clear-focus]' ? { dataset: {} } : null) },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timeline.isFocused(), false);
  assert.equal(queries.length, 2);
  assert.equal(queries[1].from, undefined, '回到完整时间线：不带时间窗口');
  assert.equal(roots.container.innerHTML.includes('timeline-focus'), false);

  // 再定位一次，然后改筛选：同样退出定位。
  await timeline.focus({ from: FROM, to: TO }, null);
  assert.equal(timeline.isFocused(), true);
  roots.selects['#timeline-range'].value = 'today';
  roots.selects['#timeline-range'].dispatch('change');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timeline.isFocused(), false);
  const last = queries.at(-1);
  assert.equal(typeof last.from?.getTime, 'function', '「今天」翻译成闭开区间的起点');
  assert.equal(queries.filter((query) => query.from?.getTime?.() === TO.getTime()).length, 0);
});

test('定位 3：非法窗口不查询、返回 false；定位模式下新记录不插进列表', async () => {
  const { timeline, roots, queries } = makeView();

  assert.equal(await timeline.focus(null), false);
  assert.equal(await timeline.focus({ from: TO, to: FROM }), false, '结束早于开始');
  assert.equal(await timeline.focus({ from: '不是时间', to: TO }), false);
  assert.deepEqual(queries, [], '参数不合法时不去打扰数据层');

  await timeline.focus({ from: FROM, to: TO }, 'shot-1');
  const before = roots.container.innerHTML;
  const queried = queries.length;
  // 定位看的是一个历史窗口，实时新记录不应该插进来（插了也落在窗口之外）。
  timeline.prependRecord(record('shot-live', '2026-09-17T15:00:00+08:00'));
  assert.equal(roots.container.innerHTML, before);
  assert.equal(queries.length, queried);
});
