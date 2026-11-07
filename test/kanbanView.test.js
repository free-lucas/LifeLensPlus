'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// 看板页的纯函数部分不碰 DOM，可以直接 require；DOM 初始化只在渲染进程里执行。
const {
  PERIODS,
  PERIOD_LABELS,
  DEFAULT_PERIOD,
  CATEGORY_CLASSES,
  formatMinutes,
  formatShortMinutes,
  formatShare,
  categoryClass,
  truncateLabel,
  buildStatsQuery,
  donutSlices,
  renderDonut,
  trendGeometry,
  renderTrendChart,
  rankGeometry,
  renderRankChart,
  renderKeywords,
  renderTodos,
  renderStatCards,
  hourlyTrend,
  renderKanbanReport,
  createKanbanView,
} = require('../src/renderer/kanban');

// 与 StatsRepository.summarize() 的返回结构同构：一周里只有周一有数据。
function fakeStats(overrides = {}) {
  const labels = ['一', '二', '三', '四', '五', '六', '日'];
  const trend = labels.map((label, index) => ({
    key: `2026-09-${14 + index}`,
    label,
    startMs: new Date(2026, 8, 14 + index).getTime(),
    future: index > 4,
    blocks: index === 0 ? 8 : 0,
    minutes: index === 0 ? 80 : 0,
    activities: index === 0 ? 12 : 0,
    byCategory: index === 0 ? { 工作: 50, 学习: 20, 娱乐: 10 } : {},
  }));
  const hourly = Array.from({ length: 24 }, (_value, hour) => ({
    hour,
    blocks: hour === 10 ? 8 : 0,
    minutes: hour === 10 ? 80 : 0,
    byCategory: hour === 10 ? { 工作: 50, 学习: 20, 娱乐: 10 } : {},
  }));

  return {
    period: 'week',
    blockMinutes: 10,
    totals: {
      blocks: 8,
      completed: 8,
      pending: 0,
      failed: 0,
      minutes: 80,
      activities: 12,
      activeDays: 3,
      days: 7,
    },
    categories: [
      { category: '娱乐', blocks: 1, minutes: 10, share: 0.125 },
      { category: '工作', blocks: 5, minutes: 50, share: 0.625 },
      { category: '学习', blocks: 2, minutes: 20, share: 0.25 },
      { category: '社交', blocks: 0, minutes: 0, share: 0 },
    ],
    projects: [
      { label: '写《2026 年中报告》', blocks: 5, minutes: 50, share: 0.625 },
      { label: '整理数据', blocks: 3, minutes: 30, share: 0.375 },
    ],
    software: [
      { label: 'Word', blocks: 5, minutes: 50, share: 0.625 },
      { label: 'Chrome', blocks: 3, minutes: 30, share: 0.375 },
    ],
    hourly,
    trend,
    keywords: [{ keyword: '报告', count: 6 }, { keyword: '数据', count: 3 }],
    todos: [{ todo: '补充上半年数据', day: '2026-09-14', count: 1 }],
    counts: { projects: 3, software: 4 },
    anchor: '2026-09-15',
    label: '2026年9月14日 – 20日',
    prevAnchor: '2026-09-07',
    nextAnchor: '2026-09-21',
    future: false,
    hasToday: true,
    from: '2026-09-14T00:00:00+08:00',
    to: '2026-09-21T00:00:00+08:00',
    ...overrides,
  };
}

function emptyStats(overrides = {}) {
  const stats = fakeStats();
  return {
    ...stats,
    totals: { blocks: 0, completed: 0, pending: 0, failed: 0, minutes: 0, activities: 0, activeDays: 0, days: 7 },
    categories: stats.categories.map((item) => ({ ...item, blocks: 0, minutes: 0, share: 0 })),
    projects: [],
    software: [],
    keywords: [],
    todos: [],
    trend: stats.trend.map((item) => ({ ...item, blocks: 0, minutes: 0, activities: 0, byCategory: {} })),
    hourly: stats.hourly.map((item) => ({ ...item, blocks: 0, minutes: 0, byCategory: {} })),
    ...overrides,
  };
}

test('看板 1：周期口径与查询构造（默认看本周）', () => {
  assert.deepEqual([...PERIODS], ['day', 'week', 'month', 'year']);
  assert.equal(DEFAULT_PERIOD, 'week');
  assert.deepEqual({ ...PERIOD_LABELS }, { day: '日', week: '周', month: '月', year: '年' });

  assert.deepEqual(
    buildStatsQuery({ period: 'month', anchor: '2026-09-15' }),
    { period: 'month', anchor: '2026-09-15' },
  );
  // 非法周期退回默认；空锚点交给主进程解释成「今天 / 本周 / 本月 / 今年」。
  assert.deepEqual(buildStatsQuery({ period: '周', anchor: '' }), { period: 'week', anchor: null });
  assert.deepEqual(buildStatsQuery(), { period: 'week', anchor: null });
});

test('看板 2：时长 / 占比 / 分类配色的展示口径', () => {
  assert.equal(formatMinutes(0), '0 分钟');
  assert.equal(formatMinutes(45), '45 分钟');
  assert.equal(formatMinutes(60), '1 小时');
  assert.equal(formatMinutes(80), '1 小时 20 分');
  assert.equal(formatMinutes(-5), '0 分钟');

  assert.equal(formatShortMinutes(0), '0m');
  assert.equal(formatShortMinutes(45), '45m');
  assert.equal(formatShortMinutes(60), '1h');
  assert.equal(formatShortMinutes(90), '1.5h');

  assert.equal(formatShare(0), '0%');
  assert.equal(formatShare(0.625), '63%');
  assert.equal(formatShare(0.004), '<1%');

  assert.equal(categoryClass('工作'), 'cat-work');
  assert.equal(categoryClass(undefined), '');
  assert.deepEqual(Object.keys(CATEGORY_CLASSES), ['娱乐', '工作', '学习', '社交']);

  assert.equal(truncateLabel('短名字'), '短名字');
  assert.equal(truncateLabel('一二三四五六七八九十壹贰叁肆伍'), '一二三四五六七八九十壹贰叁…');
});

test('看板 3：环形图按分钟切片，0 分钟的分类不占扇区', () => {
  const { circumference, total, slices } = donutSlices(fakeStats().categories);
  assert.equal(circumference, 289.03, '2π × 46');
  assert.equal(total, 80);
  assert.equal(slices.length, 3, '「社交」是 0 分钟，不画扇区');
  assert.deepEqual(slices.map((item) => item.category), ['娱乐', '工作', '学习']);
  assert.deepEqual(slices.map((item) => item.length), [36.13, 180.64, 72.26]);
  assert.equal(String(slices[0].offset), '0', '第一个扇区从 12 点开始');
  assert.equal(slices[1].offset, -36.13, '第二个扇区接在第一个后面');
  assert.equal(slices[2].offset, -216.77);

  assert.deepEqual(donutSlices([]), { circumference: 289.03, total: 0, slices: [] });
  assert.deepEqual(donutSlices([{ category: '工作', minutes: 0 }]).slices, []);

  const html = renderDonut(fakeStats().categories, { minutes: 80 });
  assert.equal((html.match(/class="donut-slice/g) ?? []).length, 3);
  assert.ok(html.includes('class="donut-slice cat-work"'));
  assert.ok(html.includes('>1.3h<'), '圆心写总时长');
  assert.ok(html.includes('donut-track'));
  assert.equal(html.includes('style="'), false, 'CSP 是 style-src self，不能写内联样式');

  // 四个分类之外的取值也要有颜色（历史脏数据不能让扇区变成透明的）。
  const other = renderDonut([{ category: '运动', minutes: 10 }], { minutes: 10 });
  assert.ok(other.includes('class="donut-slice chart-bar-other"'));
});

test('看板 4：趋势图几何 —— 分类堆叠、折线与刻度', () => {
  const geometry = trendGeometry(fakeStats().trend);
  assert.equal(geometry.plotWidth, 666);
  assert.equal(geometry.plotHeight, 178);
  assert.equal(geometry.step, 95.14, '666 / 7 天');
  assert.equal(geometry.barWidth, 34, '柱宽有上限，不会随桶数变宽');

  const monday = geometry.bars[0];
  assert.equal(monday.x, 70.57);
  assert.equal(monday.centerX, 87.57);
  // 堆叠顺序是固定的分类顺序（娱乐最靠下），保证同一张图里颜色位置稳定。
  assert.deepEqual(monday.segments.map((item) => item.category), ['娱乐', '工作', '学习']);
  assert.deepEqual(monday.segments.map((item) => item.height), [22.25, 111.25, 44.5]);
  assert.equal(monday.segments[0].y, 171.75, '第一个分类贴基线');
  assert.equal(monday.segments.at(-1).y, 16, '最高的分类贴到图表顶部');
  assert.equal(monday.totalHeight, 178, '堆叠总高度 = 这一桶的时长占比');
  assert.equal(monday.future, false);
  assert.equal(geometry.maxMinutes, 80);

  assert.deepEqual(geometry.ticks.map((tick) => tick.label), ['0m', '40m', '1.3h']);
  assert.equal(geometry.points[0].x, 87.57, '折线点对齐柱子中心');
  assert.equal(geometry.points[0].y, 16, '折线画的是截图记录数');
  assert.equal(geometry.points[1].y, 194, '没有记录的一天落在基线上');

  const chart = renderTrendChart(fakeStats().trend, { title: '活动趋势' });
  assert.ok(chart.includes('class="chart-bar cat-work"'));
  assert.ok(chart.includes('class="chart-line"'));
  assert.ok(chart.includes('class="chart-dot"'));
  assert.ok(chart.includes('活动趋势'));
  assert.equal(chart.includes('style="'), false);

  const blank = renderTrendChart(fakeStats().trend.map((item) => ({ ...item, minutes: 0 })), { title: '活动趋势' });
  assert.ok(blank.includes('这个周期还没有汇总数据。'));
  assert.ok(renderTrendChart([], { title: '活动趋势' }).includes('这个周期还没有汇总数据。'));
});

test('看板 5：排行图按最长的条归一化', () => {
  const geometry = rankGeometry(fakeStats().projects);
  assert.equal(geometry.max, 50);
  assert.equal(geometry.height, 56, '两行 ×（20 + 8）');
  assert.deepEqual(geometry.bars.map((bar) => bar.barWidth), [158, 94.8]);

  const html = renderRankChart('项目专注时长', '按区块累计', fakeStats().projects);
  assert.ok(html.includes('chart-rank-bar rank-bar-0'));
  assert.ok(html.includes('>50 分钟<'));
  assert.ok(html.includes('>30 分钟<'));
  assert.equal(html.includes('style="'), false);

  const software = renderRankChart('软件使用次数', null, fakeStats().software, {
    valueText: (bar) => `${bar.blocks} 次`,
  });
  assert.ok(software.includes('>5 次<'), '软件用「次」而不是时长');

  assert.ok(renderRankChart('项目', null, []).includes('这个周期还没有数据。'));
  assert.ok(renderRankChart('项目', null, [], { empty: '还没有项目。' }).includes('还没有项目。'));
});

test('看板 6：卡片 / 关键词 / 待办都能画出来，文本一律转义', () => {
  const cards = renderStatCards(fakeStats().totals);
  assert.equal((cards.match(/class="stat-card"/g) ?? []).length, 5);
  assert.ok(cards.includes('已汇总时长'));
  assert.ok(cards.includes('>1 小时 20 分<'));
  assert.ok(cards.includes('>8 个<'));
  assert.ok(cards.includes('>12 张<'));
  assert.ok(cards.includes('>3/7 天<'));
  assert.ok(cards.includes('>27 分钟<'), '平均每天 = 80 / 3 个活跃天');
  assert.equal(renderStatCards({ blocks: 2, failed: 1 }).includes('1 个汇总失败'), true);

  const tags = renderKeywords([{ keyword: '<img src=x onerror=alert(1)>', count: 2 }, { keyword: '数据', count: 1 }], '来自截图');
  assert.ok(tags.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(tags.includes('<img'), false);
  assert.ok(tags.includes('tag-lg'), '出现最多的关键词字号最大');
  assert.ok(tags.includes('tag-md'));
  assert.ok(renderKeywords([], 'note').includes('这个周期还没有关键词。'));

  const todos = renderTodos(fakeStats().todos);
  assert.ok(todos.includes('补充上半年数据'));
  assert.ok(todos.includes('2026-09-14'));
  assert.ok(renderTodos([]).includes('这个周期没有发现待办线索。'));

  const rank = renderRankChart('项目', null, [{ label: '<b>项目</b>', blocks: 1, minutes: 10, share: 1 }]);
  assert.ok(rank.includes('&lt;b&gt;项目&lt;/b&gt;'));
});

test('看板 7：整页面板 —— 周视图 7 块、日视图 6 块（日视图不重复画时段分布）', () => {
  const countPanels = (html) => (html.match(/class="panel/g) ?? []).length;
  const week = renderKanbanReport(fakeStats());
  assert.equal(countPanels(week), 7);
  for (const title of ['时间分配', '活动趋势', '时段分布', '项目专注时长', '软件使用次数', '关键词', '待办线索']) {
    assert.ok(week.includes(title), `周视图应该有「${title}」`);
  }

  const day = renderKanbanReport(fakeStats({ period: 'day' }));
  assert.equal(countPanels(day), 6);
  assert.equal(day.includes('时段分布'), false, '日视图的趋势就是时段分布，不重复画');
  assert.ok(day.includes('按小时统计时长'));

  // 整页都不写内联样式，也不注入脚本。
  for (const html of [week, day]) {
    assert.equal(html.includes('style="'), false);
    assert.equal(html.includes('<script'), false);
  }
  assert.equal(renderKanbanReport(null), '<p class="timeline-state">加载中…</p>');
  assert.ok(renderKanbanReport(emptyStats()).includes('这个周期还没有汇总数据。'));
});

test('看板 8：日视图的趋势由 24 个小时槽拼出来', () => {
  const trend = hourlyTrend(fakeStats().hourly);
  assert.equal(trend.length, 24);
  assert.equal(trend[0].key, '00');
  assert.equal(trend[10].label, '10');
  assert.equal(trend[10].minutes, 80);
  assert.deepEqual(trend[10].byCategory, { 工作: 50, 学习: 20, 娱乐: 10 });
  assert.equal(trend[10].future, false);
  assert.deepEqual(hourlyTrend(null), []);
});

test('看板 9：作为 classic script 执行时不污染全局作用域', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'kanban.js'), 'utf8');
  const sandbox = {
    JSON,
    window: { lifelens: {} },
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  // kanban.js 与 timeline.js / diary.js / renderer.js 共享同一个全局作用域，
  // 重名的函数声明会互相覆盖（pad / escapeHtml / formatMinutes / categoryClass 都是同名函数）。
  const names = [
    'pad', 'escapeHtml', 'round2', 'formatMinutes', 'formatShortMinutes', 'formatShare',
    'categoryClass', 'truncateLabel', 'buildStatsQuery', 'donutSlices', 'renderDonut',
    'trendGeometry', 'renderTrendChart', 'sparsePoints', 'rankGeometry', 'renderRankChart',
    'renderKeywords', 'renderTodos', 'renderStatCards', 'hourlyTrend', 'renderKanbanReport',
    'createKanbanView', 'init', 'PERIODS', 'PERIOD_LABELS', 'DEFAULT_PERIOD',
    'CATEGORY_ORDER', 'CATEGORY_CLASSES', 'DONUT_SIZE', 'DONUT_RADIUS', 'DONUT_STROKE',
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
// 纯函数全对不代表页面能画出来：createKanbanView 里同名的函数声明会把模块级纯函数遮蔽掉，
// 调用直接变成无限递归。这一组用例把 DOM 桩到刚好够用，专门守住「装配出来的页面能渲染」。

function classListOf() {
  const set = new Set();
  return {
    set,
    add: (name) => set.add(name),
    remove: (name) => set.delete(name),
    contains: (name) => set.has(name),
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
  };
}

function fakeElement(id) {
  return {
    id,
    value: '',
    hidden: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    dataset: {},
    classList: classListOf(),
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    dispatch(type) {
      for (const handler of this.listeners[type] ?? []) handler({ target: this });
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
  };
}

function click(root, target) {
  for (const handler of root.listeners.click ?? []) handler({ target });
}

function loadViewInSandbox() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'kanban.js'), 'utf8');
  const sandbox = {
    JSON,
    window: { lifelens: {} },
    document: {
      createElement: (tagName) => ({ tagName, value: '', textContent: '' }),
      // init() 找不到元素就直接返回：这组用例只测 createKanbanView。
      getElementById: () => null,
    },
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { view: sandbox.module.exports, sandbox };
}

function makeViewRoots() {
  const periods = PERIODS.map((period) => {
    const button = fakeElement(`kanban-${period}`);
    button.dataset = { period };
    button.closest = (selector) => (selector === '.kanban-period' ? button : null);
    return button;
  });
  const periodsRoot = fakeElement('kanban-periods');
  periodsRoot.querySelectorAll = (selector) => (selector === '.kanban-period' ? periods : []);

  return {
    periods,
    periodsRoot,
    cardsRoot: fakeElement('kanban-cards'),
    chartsRoot: fakeElement('kanban-charts'),
    statusEl: fakeElement('kanban-status'),
    labelEl: fakeElement('kanban-label'),
    dateInput: fakeElement('kanban-date'),
    prevButton: fakeElement('kanban-prev'),
    nextButton: fakeElement('kanban-next'),
    todayButton: fakeElement('kanban-today'),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
// 沙箱里的对象与测试进程不是同一个 realm，deepEqual 会连原型一起比：先转成宿主对象再断言。
const plain = (value) => JSON.parse(JSON.stringify(value));

test('看板 10：reload 会按当前周期查询，并把卡片与图表画进 DOM', async () => {
  const { view, sandbox } = loadViewInSandbox();
  const roots = makeViewRoots();
  const queries = [];
  const kanban = view.createKanbanView({
    ...roots,
    getStats: async (query) => {
      queries.push(query);
      return fakeStats();
    },
  });

  await kanban.reload();

  assert.deepEqual(plain(queries), [{ period: 'week', anchor: null }], '打开时看本周，锚点交给主进程');
  assert.ok(roots.chartsRoot.innerHTML.includes('时间分配'));
  assert.ok(roots.chartsRoot.innerHTML.includes('项目专注时长'));
  assert.ok(roots.cardsRoot.innerHTML.includes('已汇总时长'));
  assert.equal(roots.labelEl.textContent, '2026年9月14日 – 20日');
  assert.equal(roots.dateInput.value, '2026-09-15', '日期框回显主进程规范化后的锚点');
  assert.equal(roots.periods[1].classList.contains('active'), true, '当前周期的按钮高亮');
  assert.equal(roots.statusEl.hidden, true);
  assert.equal(roots.prevButton.disabled, false);
  assert.equal(roots.nextButton.disabled, true, '本期含今天：没有下一期可看');
  assert.deepEqual(plain(kanban.read()), { period: 'week', anchor: '2026-09-15' });
  assert.equal(sandbox.window.lifelensKanban, undefined, '沙箱里不应该自动初始化');
});

test('看板 11：上一期 / 下一期 / 回到今天 / 切周期 / 改日期都走同一套锚点', async () => {
  const { view } = loadViewInSandbox();
  const roots = makeViewRoots();
  const queries = [];
  const payload = fakeStats({
    anchor: '2026-09-08',
    label: '2026年9月7日 – 13日',
    prevAnchor: '2026-09-01',
    nextAnchor: '2026-09-15',
    hasToday: false,
    future: false,
  });
  const kanban = view.createKanbanView({
    ...roots,
    getStats: async (query) => {
      queries.push(query);
      return payload;
    },
  });

  await kanban.reload();
  assert.equal(roots.nextButton.disabled, false, '过去的一期可以往后翻');

  roots.nextButton.dispatch('click');
  await flush();
  assert.deepEqual(plain(queries.at(-1)), { period: 'week', anchor: '2026-09-15' }, '下一期用主进程给的 nextAnchor');

  roots.prevButton.dispatch('click');
  await flush();
  assert.deepEqual(plain(queries.at(-1)), { period: 'week', anchor: '2026-09-01' });

  roots.todayButton.dispatch('click');
  await flush();
  assert.deepEqual(plain(queries.at(-1)), { period: 'week', anchor: null }, '回到今天 = 清空锚点');

  click(roots.periodsRoot, roots.periods[2]);
  await flush();
  assert.deepEqual(plain(queries.at(-1)), { period: 'month', anchor: '2026-09-08' }, '切周期保留当前锚点');
  assert.equal(roots.periods[2].classList.contains('active'), true);

  roots.dateInput.value = '2026-08-01';
  roots.dateInput.dispatch('change');
  await flush();
  assert.deepEqual(plain(queries.at(-1)), { period: 'month', anchor: '2026-08-01' });

  // 点当前周期不重复查询。
  const before = queries.length;
  click(roots.periodsRoot, roots.periods[2]);
  await flush();
  assert.equal(queries.length, before);
});

test('看板 12：整段在未来的周期锁住「下一期」，没有数据的周期画成空态', async () => {
  const { view } = loadViewInSandbox();
  const roots = makeViewRoots();
  let payload = fakeStats({ anchor: '2026-12-01', future: true, hasToday: false });
  const kanban = view.createKanbanView({ ...roots, getStats: async () => payload });

  await kanban.reload();
  assert.equal(roots.nextButton.disabled, true, '已经在未来的周期里，不能再往后');

  payload = emptyStats();
  await kanban.reload();
  assert.equal(roots.cardsRoot.innerHTML.includes('>0 分钟<'), true);
  assert.ok(roots.chartsRoot.innerHTML.includes('这个周期还没有汇总数据。'));
  assert.ok(roots.chartsRoot.innerHTML.includes('还没有汇总出项目'));
  assert.equal(roots.chartsRoot.innerHTML.includes('style="'), false);
});

test('看板 13：查询失败时给出可读的错误，页面不残留旧数据', async () => {
  const { view } = loadViewInSandbox();
  const roots = makeViewRoots();
  const kanban = view.createKanbanView({
    ...roots,
    getStats: async () => {
      throw new Error('数据库打不开');
    },
  });

  await kanban.reload();

  assert.equal(roots.statusEl.hidden, false);
  assert.ok(roots.statusEl.textContent.includes('数据库打不开'));
  assert.ok(roots.chartsRoot.innerHTML.includes('加载统计失败'));
  assert.equal(roots.cardsRoot.innerHTML, '');
  assert.equal(roots.labelEl.textContent, '—');
  assert.equal(roots.prevButton.disabled, true, '没有数据时不能翻页');
});
