'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// 动态页的纯函数部分不碰 DOM，可以直接 require；DOM 初始化只在渲染进程里执行。
const {
  PAGE_SIZE,
  HEATMAP_COLUMNS,
  HEATMAP_ROWS,
  HEATMAP_MAX_LIMIT,
  CATEGORY_CLASSES,
  blockStartOf,
  startMsOf,
  blockRangeLabel,
  blockDayLabel,
  categoryClass,
  heatmapSlots,
  heatmapRange,
  heatRows,
  buildBlocksQuery,
  hasActiveFilters,
  parseDateInput,
  resolveTimeRange,
  renderHeatmap,
  renderBlockCard,
  renderBlockDetail,
} = require('../src/renderer/dynamics');
const { formatLocalIso } = require('../src/main/time');

function at(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second);
}

// 与数据层返回的区块同构。
function block(start, overrides = {}) {
  return {
    id: formatLocalIso(start),
    start: formatLocalIso(start),
    end: formatLocalIso(new Date(start.getTime() + 10 * 60 * 1000)),
    status: 'COMPLETED',
    activityCount: 3,
    project: '写《2026 年中报告》',
    category: '工作',
    description: '整理上半年数据，并把结论补进报告里。',
    software: ['Word', 'Chrome'],
    todos: [],
    model: 'fake-model',
    analysisMs: 1200,
    error: null,
    errorCode: null,
    ...overrides,
  };
}

test('动态 1：热力图是 6 行 × 12 列 = 72 个 10 分钟点，按列（小时）排列', () => {
  const now = at(2026, 9, 15, 10, 25);
  const slots = heatmapSlots(now);

  assert.equal(HEATMAP_ROWS, 6);
  assert.equal(HEATMAP_COLUMNS, 12);
  assert.equal(HEATMAP_MAX_LIMIT, 72);
  assert.equal(slots.length, 72);

  // 列 = 小时，行 = 一小时里的 6 个 10 分钟槽。
  assert.equal(slots[0].startMs, at(2026, 9, 14, 23, 0).getTime(), '最后一列是当前小时，第一列是 11 小时前');
  assert.equal(slots[5].startMs, at(2026, 9, 14, 23, 50).getTime());
  assert.equal(slots[6].startMs, at(2026, 9, 15, 0, 0).getTime(), '第 6 个之后进入下一个小时');
  assert.equal(slots[71].startMs, at(2026, 9, 15, 10, 50).getTime());
  assert.equal(slots[71].future, true, '当前时间之后的槽位标记为未来');
  assert.equal(slots[62].future, false, '10:20（当前槽位）不是未来');

  // 分钟标签是从 :00 到 :50 的 6 档。
  assert.deepEqual(heatRows(), [':00', ':10', ':20', ':30', ':40', ':50']);
});

test('动态 2：热力图槽位跨天正确，区块起点对齐 10 分钟', () => {
  const slots = heatmapSlots(at(2026, 9, 15, 0, 5));
  assert.equal(slots[0].startMs, at(2026, 9, 14, 13, 0).getTime(), '最近 12 小时会跨到前一天');
  assert.equal(slots.at(-1).startMs, at(2026, 9, 15, 0, 50).getTime());

  for (const slot of slots) {
    assert.equal(slot.start.getMinutes() % 10, 0);
    assert.equal(slot.start.getSeconds(), 0);
    assert.equal(blockStartOf(slot.start).getTime(), slot.startMs);
  }
});

test('动态 3：heatmapRange 覆盖最后一列的整点小时', () => {
  const range = heatmapRange(at(2026, 9, 15, 10, 25));
  assert.equal(range.from.getTime(), at(2026, 9, 14, 23, 0).getTime());
  assert.equal(range.to.getTime(), at(2026, 9, 15, 11, 0).getTime(), 'to 是开区间：含当前小时的最后一个槽位');
});

test('动态 4：区块时间标签与分类配色', () => {
  assert.equal(blockRangeLabel(at(2026, 9, 15, 9, 50)), '09:50–10:00');
  assert.equal(blockRangeLabel(at(2026, 9, 15, 23, 50)), '23:50–00:00');
  assert.equal(blockRangeLabel('不是时间'), '--:--');
  assert.equal(blockDayLabel(at(2026, 9, 15, 9, 50)), '2026-09-15');
  assert.equal(startMsOf(at(2026, 9, 15, 9, 50)), at(2026, 9, 15, 9, 50).getTime());

  assert.equal(categoryClass('娱乐'), 'cat-fun');
  assert.equal(categoryClass('工作'), 'cat-work');
  assert.equal(categoryClass('学习'), 'cat-study');
  assert.equal(categoryClass('社交'), 'cat-social');
  assert.equal(categoryClass('其他'), '');
  assert.equal(categoryClass(null), '');
  assert.deepEqual(Object.keys(CATEGORY_CLASSES), ['娱乐', '工作', '学习', '社交']);
});

test('动态 5：热力图方块按活动类型着色（未汇总 / 无记录 / 未来各有区分）', () => {
  const now = at(2026, 9, 15, 10, 25);
  const slots = heatmapSlots(now);

  const blocks = new Map([
    [at(2026, 9, 15, 10, 0).getTime(), block(at(2026, 9, 15, 10, 0), { category: '学习' })],
    [at(2026, 9, 15, 10, 10).getTime(), block(at(2026, 9, 15, 10, 10), { status: 'PENDING', project: null })],
    [at(2026, 9, 15, 10, 20).getTime(), block(at(2026, 9, 15, 10, 20), { status: 'FAILED', error: 'AI 请求超时' })],
  ]);
  const html = renderHeatmap(slots, blocks, at(2026, 9, 15, 10, 10).getTime());

  assert.ok(html.includes('class="heat-cell cat-study"'));
  assert.ok(html.includes('class="heat-cell cat-pending"'), '未汇总 / 失败的方块用「汇总中」底色');
  assert.equal(html.includes('class="heat-cell selected"'), false, '选中态加在已有类名之后');
  assert.ok(html.includes('heat-cell cat-pending selected'), '选中的方块带自己的底色类与 selected');
  assert.ok(html.includes('class="heat-cell future"'), '未来槽位用浅色占位');
  assert.ok(html.includes(' disabled title='), '未来槽位不可点');
  assert.ok(html.includes('09:50–10:00 没有记录'), '没有记录的槽位提示没有记录');
  assert.ok(html.includes('10:00–10:10 学习 写《2026 年中报告》'));
  assert.equal(html.includes('<div class="heatmap-rows">'), true);
  assert.equal(html.includes('<div class="heatmap-hours">'), true);
});

test('动态 6：时间线卡片显示项目名、描述、软件 tag 与待办', () => {
  const html = renderBlockCard(block(at(2026, 9, 15, 10, 0), { todos: ['补充上半年数据'] }));

  assert.ok(html.includes('data-start="' + at(2026, 9, 15, 10, 0).getTime() + '"'));
  assert.ok(html.includes('10:00–10:10'));
  assert.ok(html.includes('2026-09-15'));
  assert.ok(html.includes('class="dynamics-category cat-work"'));
  assert.ok(html.includes('写《2026 年中报告》'));
  assert.ok(html.includes('整理上半年数据，并把结论补进报告里。'));
  assert.ok(html.includes('<span class="dynamics-tag">Word</span>'));
  assert.ok(html.includes('<span class="dynamics-tag">Chrome</span>'));
  assert.ok(html.includes('可能遗漏的待办：补充上半年数据'));
});

test('动态 7：未汇总 / 失败的区块卡片给出状态而不是内容', () => {
  const pending = renderBlockCard(block(at(2026, 9, 15, 10, 0), {
    status: 'PENDING', project: null, category: null, description: null, software: [],
  }));
  assert.ok(pending.includes('汇总中…'));
  assert.equal(pending.includes('dynamics-project'), false);

  const failed = renderBlockCard(block(at(2026, 9, 15, 10, 0), {
    status: 'FAILED', error: 'AI 请求超时', errorCode: 'AI_TIMEOUT',
  }));
  assert.ok(failed.includes('汇总失败：AI 请求超时 · AI_TIMEOUT'));
});

test('动态 8：热力图详情区分「有记录」与「没有记录」', () => {
  const withBlock = renderBlockDetail(block(at(2026, 9, 15, 10, 0)), at(2026, 9, 15, 10, 0).getTime());
  assert.ok(withBlock.includes('2026-09-15 10:00–10:10'));
  assert.ok(withBlock.includes('工作'));
  assert.ok(withBlock.includes('这个时间段有 3 条截图记录。'));

  const empty = renderBlockDetail(null, at(2026, 9, 15, 10, 0).getTime());
  assert.ok(empty.includes('这个时间段没有记录。'));
});

test('动态 9：渲染结果对内容做转义（不执行记录里的 HTML）', () => {
  const html = renderBlockCard(block(at(2026, 9, 15, 10, 0), {
    project: '<img src=x onerror=alert(1)>',
    description: '<script>alert(2)</script>',
    software: ['<b>粗体</b>'],
  }));
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;b&gt;粗体&lt;/b&gt;'));
});

// ---- 筛选 ----

test('动态 10：buildBlocksQuery 把筛选状态翻译成数据层参数', () => {
  const now = at(2026, 9, 15, 14, 0);

  assert.deepEqual(buildBlocksQuery({ range: 'all' }, { limit: PAGE_SIZE, now }), { limit: PAGE_SIZE, offset: 0 });

  const today = buildBlocksQuery({ range: 'today' }, { limit: 20, now });
  assert.equal(today.from.getTime(), at(2026, 9, 15, 0, 0).getTime());
  assert.equal(today.to.getTime(), at(2026, 9, 16, 0, 0).getTime());

  const last7 = resolveTimeRange('last7', null, null, now);
  assert.equal(last7.from.getTime(), at(2026, 9, 9, 0, 0).getTime());
  assert.equal(last7.to.getTime(), at(2026, 9, 16, 0, 0).getTime());

  const custom = buildBlocksQuery(
    { range: 'custom', from: '2026-09-10', to: '2026-09-11' },
    { limit: 20, now },
  );
  assert.equal(custom.from.getTime(), at(2026, 9, 10, 0, 0).getTime());
  assert.equal(custom.to.getTime(), at(2026, 9, 12, 0, 0).getTime(), '结束日期含当天');

  const filtered = buildBlocksQuery(
    { range: 'all', project: '写《2026 年中报告》', software: 'Word' },
    { limit: 20, offset: 40, now },
  );
  assert.equal(filtered.project, '写《2026 年中报告》');
  assert.equal(filtered.software, 'Word');
  assert.equal(filtered.offset, 40);

  // 空值一律不传，交给数据层用默认行为。
  const empty = buildBlocksQuery({ range: 'all', project: '', software: '', from: '', to: '' }, { limit: 20, now });
  assert.equal('project' in empty, false);
  assert.equal('software' in empty, false);
  assert.equal('from' in empty, false);
});

test('动态 11：hasActiveFilters 与 parseDateInput', () => {
  assert.equal(hasActiveFilters({ range: 'all' }), false);
  assert.equal(hasActiveFilters({ range: 'today' }), true);
  assert.equal(hasActiveFilters({ range: 'all', project: 'x' }), true);
  assert.equal(hasActiveFilters({ range: 'all', software: 'x' }), true);
  assert.equal(hasActiveFilters(null), false);

  assert.equal(parseDateInput('2026-09-15').getFullYear(), 2026);
  assert.equal(parseDateInput('2026-09-15').getMonth(), 8);
  assert.equal(parseDateInput('2026-09-15').getDate(), 15);
  assert.equal(parseDateInput('2026-09-15').getHours(), 0, '按本地时间解析，不能按 UTC');
  assert.equal(parseDateInput(''), null);
  assert.equal(parseDateInput('2026/09/15'), null);
});

test('动态 12：作为 classic script 执行时不污染全局作用域', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'dynamics.js'),
    'utf8',
  );
  const sandbox = {
    JSON,
    window: { lifelens: {} },
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  // dynamics.js 与 timeline.js / renderer.js 共享同一个全局作用域，
  // 重名的函数声明会互相覆盖（pad / escapeHtml / blockStartOf 都是同名函数）。
  const names = [
    'pad', 'escapeHtml', 'toLocalDate', 'blockStartOf', 'startMsOf', 'blockRangeLabel',
    'blockDayLabel', 'categoryClass', 'heatmapSlots', 'heatmapRange', 'heatRows',
    'startOfDay', 'addDays', 'parseDateInput', 'resolveTimeRange', 'buildBlocksQuery',
    'hasActiveFilters', 'renderHeatmap', 'renderBlockCard', 'renderBlockDetail',
    'createFilterBar', 'createDynamicsView', 'fillSelect', 'facetEntries',
    'PAGE_SIZE', 'HEATMAP_COLUMNS', 'HEATMAP_ROWS', 'CATEGORY_CLASSES',
  ];
  for (const name of names) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(sandbox, name),
      false,
      `${name} 不应该挂到全局作用域`,
    );
  }
});

// ---- 视图装配（假 DOM）----
// 纯函数全对不代表页面能画出来：createDynamicsView 里同名的函数声明会把模块级纯函数遮蔽掉，
// 调用直接变成无限递归。这一组用例把 DOM 桩到刚好够用，专门守住「装配出来的页面能渲染」。

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
    dispatch(type) {
      for (const handler of this.listeners[type] ?? []) handler({ target: this });
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
    closest() {
      return null;
    },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

// 把 dynamics.js 放进带假 DOM 的沙箱里跑，拿到 createDynamicsView 与其 module.exports。
function loadViewInSandbox() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'dynamics.js'),
    'utf8',
  );
  const sandbox = {
    JSON,
    window: { lifelens: {} },
    document: {
      createElement: (tagName) => ({ tagName, value: '', textContent: '' }),
      // init() 找不到元素就直接返回：这组用例只测 createDynamicsView。
      getElementById: () => null,
    },
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { view: sandbox.module.exports, sandbox };
}

function makeViewRoots() {
  const selects = {
    '#dynamics-project': fakeElement('dynamics-project'),
    '#dynamics-software': fakeElement('dynamics-software'),
    '#dynamics-range': fakeElement('dynamics-range'),
    '#dynamics-custom-range': fakeElement('dynamics-custom-range'),
    '#dynamics-from': fakeElement('dynamics-from'),
    '#dynamics-to': fakeElement('dynamics-to'),
    '#dynamics-clear': fakeElement('dynamics-clear'),
  };
  selects['#dynamics-range'].value = 'all';

  return {
    selects,
    heatmapRoot: fakeElement('heatmap'),
    detailRoot: fakeElement('heatmap-detail'),
    timelineRoot: fakeElement('dynamics-timeline'),
    statusEl: fakeElement('dynamics-status'),
    sentinel: fakeElement('dynamics-sentinel'),
    filterRoot: { querySelector: (selector) => selects[selector] ?? null },
  };
}

function makeViewDeps(blocks) {
  return {
    getBlocks: async () => ({ items: blocks, total: blocks.length, hasMore: false }),
    getFacets: async () => ({ projects: ['写《2026 年中报告》'], software: ['Word', 'Chrome'] }),
  };
}

test('动态 13：reload 会真的把热力图与时间线画进 DOM（装配不遮蔽纯函数）', async () => {
  const { view, sandbox } = loadViewInSandbox();
  const roots = makeViewRoots();
  const blocks = [block(at(2026, 9, 15, 10, 0)), block(at(2026, 9, 15, 9, 50))];

  const dynamics = view.createDynamicsView({
    heatmapRoot: roots.heatmapRoot,
    detailRoot: roots.detailRoot,
    timelineRoot: roots.timelineRoot,
    statusEl: roots.statusEl,
    sentinel: roots.sentinel,
    filterRoot: roots.filterRoot,
    ...makeViewDeps(blocks),
  });

  await dynamics.reload();

  const cells = roots.heatmapRoot.innerHTML.match(/class="heat-cell/g) ?? [];
  assert.equal(cells.length, HEATMAP_MAX_LIMIT, '热力图应该画出 72 个点');
  assert.ok(roots.heatmapRoot.innerHTML.includes('title="'), '每个方块都带一段可读的提示');
  assert.ok(roots.heatmapRoot.innerHTML.includes('class="dynamics-card"') === false, '热力图里不铺时间线卡片');
  assert.ok(roots.timelineRoot.innerHTML.includes('写《2026 年中报告》'));
  assert.ok(roots.timelineRoot.innerHTML.includes('Word'));
  assert.equal(roots.statusEl.textContent, '没有更多了');
  assert.equal(roots.statusEl.hidden, false);

  // 项目下拉框来自 listFacets，不是界面自己写死的清单。
  assert.deepEqual(roots.selects['#dynamics-project'].options.map((o) => o.value), ['', '写《2026 年中报告》']);
  assert.deepEqual(roots.selects['#dynamics-software'].options.map((o) => o.value), ['', 'Word', 'Chrome']);
  assert.equal(sandbox.window.lifelensDynamics, undefined, '沙箱里不应该自动初始化');
});

test('动态 14：改筛选条件会重新查询，空结果显示空态', async () => {
  const { view } = loadViewInSandbox();
  const roots = makeViewRoots();
  const queries = [];
  let blocks = [block(at(2026, 9, 15, 10, 0))];

  const dynamics = view.createDynamicsView({
    heatmapRoot: roots.heatmapRoot,
    detailRoot: roots.detailRoot,
    timelineRoot: roots.timelineRoot,
    statusEl: roots.statusEl,
    sentinel: roots.sentinel,
    filterRoot: roots.filterRoot,
    getBlocks: async (query) => {
      queries.push(query);
      return { items: blocks, total: blocks.length, hasMore: false };
    },
    getFacets: async () => ({ projects: [], software: [] }),
  });

  await dynamics.reload();
  assert.equal(queries.length, 2, '一次 reload = 时间线一次 + 热力图一次');
  assert.equal(queries[0].limit, PAGE_SIZE);
  assert.equal(queries[0].from, undefined, '默认「全部时间」不传 from');

  // 换成「今天」后重新查询，且带上时间范围。
  roots.selects['#dynamics-range'].value = 'today';
  roots.selects['#dynamics-range'].dispatch('change');
  await new Promise((resolve) => setImmediate(resolve));
  await dynamics.reload();
  // 沙箱里的 Date 与测试进程不是同一个 realm，instanceof 会假阴性，按结构判断。
  const ranged = queries.at(-2).from;
  assert.equal(typeof ranged?.getTime, 'function', '「今天」应该翻译成闭开区间的起点');
  assert.equal(ranged.getHours(), 0, '区间起点是当天 00:00');

  // 命中不了任何区块时给空态而不是空白。
  blocks = [];
  roots.selects['#dynamics-project'].value = '不存在的项目';
  roots.selects['#dynamics-project'].dispatch('change');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(roots.timelineRoot.innerHTML.includes('没有符合条件的动态'));
});
