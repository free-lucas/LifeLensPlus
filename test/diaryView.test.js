'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// 日记页的纯函数部分不碰 DOM，可以直接 require；DOM 初始化只在渲染进程里执行。
const {
  BLOCK_MINUTES,
  WEEKDAY_SHORT,
  CATEGORY_CLASSES,
  dayKeyOf,
  parseDayKey,
  shiftDayKey,
  dayLabel,
  monthLabel,
  categoryClass,
  calendarCells,
  monthRange,
  cellTitle,
  renderDot,
  renderCalendar,
  metaLine,
  renderDiaryBody,
  renderDiaryDetail,
  renderDiaryStatus,
  shiftMonthCursor,
  createDiaryView,
} = require('../src/renderer/diary');

const DIARY = {
  day: '2026-09-15',
  status: 'COMPLETED',
  summary: '这一天主要在写《2026 年中报告》，下午把结论补进报告里。',
  mainEvents: ['写《2026 年中报告》', '整理上半年数据'],
  highlights: ['一口气写完了报告初稿'],
  todos: ['补充上半年的数据'],
  suggestions: ['把整理数据挪到上午做'],
  tips: ['记得每小时起来活动一下'],
};

function dayPayload(overrides = {}) {
  return {
    day: '2026-09-15',
    today: false,
    diary: null,
    blocks: { total: 0, completed: 0, pending: 0, failed: 0, categorized: 0, categories: [] },
    activityCount: 0,
    ...overrides,
  };
}

test('日记 1：日历网格周一起始、补满整周，未来与今天分别标记', () => {
  assert.equal(BLOCK_MINUTES, 10);
  assert.deepEqual([...WEEKDAY_SHORT], ['一', '二', '三', '四', '五', '六', '日']);

  // 2026-09-01 是周二：网格从 8 月 31 日（周一）开始，补到 10 月 4 日。
  const cells = calendarCells(2026, 8, { today: '2026-09-15', selected: '2026-09-15' });
  assert.equal(cells.length, 35);
  assert.equal(cells[0].day, '2026-08-31');
  assert.equal(cells[0].outside, true);
  assert.equal(cells[1].day, '2026-09-01');
  assert.equal(cells.at(-1).day, '2026-10-04');
  assert.equal(cells.at(-1).outside, true);

  const todayCell = cells.find((cell) => cell.day === '2026-09-15');
  assert.equal(todayCell.today, true);
  assert.equal(todayCell.selected, true);
  assert.equal(todayCell.future, false, '今天这一格不算未来');
  assert.equal(cells.find((cell) => cell.day === '2026-09-16').future, true);

  assert.deepEqual(monthRange(2026, 8), { from: '2026-08-31', to: '2026-10-04' });
  assert.equal(monthLabel(2026, 8), '2026年9月');
});

test('日记 2：日期口径与主进程一致（前 10 个字符就是本地日期）', () => {
  assert.equal(dayKeyOf('2026-09-15T09:50:00+08:00'), '2026-09-15');
  assert.equal(dayKeyOf('2026-09-15'), '2026-09-15');
  assert.equal(dayKeyOf('不是时间'), null);
  assert.equal(parseDayKey('2026-09-15').getDate(), 15);
  assert.equal(shiftDayKey('2026-09-01', -1), '2026-08-31');
  assert.equal(dayLabel('2026-09-15'), '2026年9月15日 周二');
  assert.equal(categoryClass('学习'), 'cat-study');
  assert.equal(categoryClass('其他'), '');
  assert.deepEqual(Object.keys(CATEGORY_CLASSES), ['娱乐', '工作', '学习', '社交']);
});

test('日记 3：日历格子的一天状态 —— 区块数 / 主要分类 / 生成状态', () => {
  const marks = new Map([
    ['2026-09-14', { day: '2026-09-14', status: 'COMPLETED', blockCount: 20, pending: 0, category: '工作', categoryBlocks: 12 }],
    ['2026-09-15', { day: '2026-09-15', status: 'PENDING', blockCount: 6, pending: 2, category: '学习', categoryBlocks: 4 }],
    ['2026-09-16', { day: '2026-09-16', status: 'FAILED', blockCount: 3, pending: 0, category: null, categoryBlocks: 0 }],
    ['2026-09-17', { day: '2026-09-17', status: null, blockCount: 1, pending: 1, category: null, categoryBlocks: 0 }],
  ]);
  const cells = calendarCells(2026, 8, { marks, today: '2026-09-18' });
  const cellOf = (day) => cells.find((cell) => cell.day === day);

  assert.equal(cellTitle(cellOf('2026-09-13')), '2026年9月13日 周日 没有记录');
  assert.equal(
    cellTitle(cellOf('2026-09-14')),
    '2026年9月14日 周一 · 20 个时间段 · 主要在工作 · 已生成日记',
  );
  assert.equal(
    cellTitle(cellOf('2026-09-15')),
    '2026年9月15日 周二 · 6 个时间段 · 主要在学习 · 正在生成日记',
  );
  assert.equal(cellTitle(cellOf('2026-09-16')).endsWith('日记生成失败'), true);
  assert.equal(cellTitle(cellOf('2026-09-17')).endsWith('1 个时间段在汇总'), true);

  assert.equal(renderDot(null), '<i class="cal-dot"></i>');
  assert.ok(renderDot({ status: 'PENDING' }).includes('cal-dot-pending'));
  assert.ok(renderDot({ status: 'FAILED' }).includes('cal-dot-failed'));
  assert.ok(renderDot({ status: 'COMPLETED', category: '工作' }).includes('cat-work'));
  assert.ok(renderDot({ blockCount: 3 }).includes('cal-dot-muted'));

  const html = renderCalendar(cells, { year: 2026, month: 8 });
  assert.ok(html.includes('2026年9月'));
  assert.equal((html.match(/class="cal-weekday"/g) ?? []).length, 7);
  assert.equal((html.match(/data-day=/g) ?? []).length, 30, '本月的每一天都能点');
  assert.ok(html.includes('class="cal-cell outside"'), '补位的日子不是按钮');
  assert.equal(html.includes('cal-submit'), false);

  // 停在当前月份时「下个月」不可点；翻到过去的月份则可以。
  assert.equal(renderCalendar(cells, { year: 2026, month: 8, canGoNext: false }).includes('disabled'), true);
});

test('日记 4：一天详情的六段内容与各种空态', () => {
  const complete = renderDiaryDetail(dayPayload({
    diary: DIARY,
    blocks: {
      total: 12,
      completed: 12,
      pending: 0,
      failed: 0,
      categorized: 10,
      categories: [{ category: '工作', blocks: 7 }, { category: '学习', blocks: 3 }],
    },
    activityCount: 24,
  }), { today: '2026-09-16' });

  for (const title of ['简短总结', '主要事项', '高光', '待办', '优化建议', '温馨提示']) {
    assert.ok(complete.includes(title), `应该有「${title}」`);
  }
  assert.ok(complete.includes(DIARY.summary));
  assert.ok(complete.includes('2026年9月15日 周二'));
  assert.ok(complete.includes('class="diary-regen"'), '有日记时给「重新生成」按钮');
  assert.equal(
    metaLine({ blocks: { total: 12, categorized: 10, categories: [{ category: '工作', blocks: 7 }] }, activityCount: 24 }),
    '12 个时间段 · 共 1 小时 40 分 · 24 张截图 · 主要在工作（7 段）',
  );
  assert.equal(metaLine(dayPayload()), '这一天没有记录');
  assert.equal(complete.includes('这一天没有记录'), false);

  // 还没有记录 / 还没汇总 / 还没生成 / 正在生成 / 生成失败。
  assert.ok(renderDiaryDetail(dayPayload(), { today: '2026-09-16' }).includes('这一天没有记录。'));
  assert.ok(renderDiaryDetail(dayPayload({ day: '2026-09-20' }), { today: '2026-09-16' }).includes('这一天还没到。'));
  assert.ok(renderDiaryDetail(dayPayload({ activityCount: 30 }), { today: '2026-09-16' })
    .includes('30 条记录还没有汇总成时间段'));
  assert.ok(renderDiaryDetail(dayPayload({
    blocks: { total: 6, completed: 4, pending: 2, failed: 0, categorized: 4, categories: [] },
  }), { today: '2026-09-16' }).includes('还有 2 个时间段在汇总'));
  assert.ok(renderDiaryDetail(dayPayload({
    blocks: { total: 6, completed: 6, pending: 0, failed: 0, categorized: 6, categories: [] },
  }), { today: '2026-09-16' }).includes('日记还没有生成'));

  const pending = renderDiaryDetail(dayPayload({
    diary: { ...DIARY, status: 'PENDING' },
    blocks: {
      total: 6, completed: 6, pending: 0, failed: 0, categorized: 6, categories: [{ category: '工作', blocks: 6 }],
    },
  }), { today: '2026-09-16' });
  assert.ok(pending.includes('正在生成这一天的日记'));
  assert.equal(pending.includes(DIARY.summary), false, '还没生成时不会提前写正文');

  const failed = renderDiaryDetail(dayPayload({
    diary: { ...DIARY, status: 'FAILED', error: 'AI 请求超时', errorCode: 'AI_TIMEOUT' },
    blocks: {
      total: 6, completed: 6, pending: 0, failed: 0, categorized: 6, categories: [{ category: '工作', blocks: 6 }],
    },
  }), { today: '2026-09-16' });
  assert.ok(failed.includes('日记生成失败：AI 请求超时 · AI_TIMEOUT'));
  assert.ok(failed.includes('class="diary-regen"'), '失败时也能重新生成');

  const withFailures = renderDiaryDetail(dayPayload({
    diary: DIARY,
    blocks: {
      total: 8, completed: 6, pending: 0, failed: 2, categorized: 6, categories: [{ category: '工作', blocks: 6 }],
    },
  }), { today: '2026-09-16' });
  assert.ok(withFailures.includes('有 2 个时间段汇总失败'));
});

test('日记 5：正文文本一律转义，缺段用空态兜底', () => {
  const html = renderDiaryBody({
    summary: '<b>总结</b>',
    mainEvents: ['<img src=x onerror=alert(1)>'],
    highlights: [],
    todos: [],
    suggestions: [],
    tips: [],
  });
  assert.ok(html.includes('&lt;b&gt;总结&lt;/b&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(html.includes('<img'), false);
  assert.ok(html.includes('这一天没有记录到明显的高光'));
  assert.ok(html.includes('没有发现被落下的待办'));
  assert.ok(renderDiaryBody({ summary: '', mainEvents: [] }).includes('这一天没有特别明确的主要事项'));
  assert.equal(renderDiaryDetail(null), '<p class="timeline-state">加载中…</p>');
});

test('日记 6：生成状态提示（排队中 / 扫描中 / 失败）', () => {
  assert.equal(renderDiaryStatus(null), null);
  assert.equal(renderDiaryStatus({ stats: { total: 0, completed: 0, pending: 0, failed: 0 } }), null);
  assert.equal(
    renderDiaryStatus({ scanning: true, stats: { pending: 3, failed: 1 } }),
    '正在生成 3 天的日记 · 正在检查有没有漏掉的日记 · 1 天生成失败',
  );
});

test('日记 7：换月时保持日号，目标月没有这一天就退到月末', () => {
  assert.deepEqual(shiftMonthCursor({ year: 2026, month: 8 }, -1, '2026-09-15'), {
    year: 2026,
    month: 7,
    day: '2026-08-15',
  });
  assert.deepEqual(shiftMonthCursor({ year: 2026, month: 0 }, -1, '2026-01-31'), {
    year: 2025,
    month: 11,
    day: '2025-12-31',
  });
  // 2 月没有 31 号：退到 2 月最后一天。
  assert.deepEqual(shiftMonthCursor({ year: 2026, month: 0 }, 1, '2026-01-31'), {
    year: 2026,
    month: 1,
    day: '2026-02-28',
  });
});

test('日记 8：作为 classic script 执行时不污染全局作用域', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'diary.js'), 'utf8');
  const sandbox = {
    JSON,
    window: { lifelens: {} },
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  // diary.js 与 timeline.js / dynamics.js / kanban.js / renderer.js 共享同一个全局作用域，
  // 重名的函数声明会互相覆盖（pad / escapeHtml / formatMinutes / categoryClass 都是同名函数）。
  const names = [
    'pad', 'escapeHtml', 'toDate', 'dayKeyOf', 'parseDayKey', 'addDays', 'shiftDayKey',
    'dayLabel', 'monthLabel', 'formatMinutes', 'categoryClass', 'calendarCells', 'monthRange',
    'cellTitle', 'renderDot', 'renderCalendar', 'metaLine', 'stateBlock', 'renderList',
    'renderSection', 'renderDiaryBody', 'renderDiaryDetail', 'renderDiaryStatus',
    'shiftMonthCursor', 'createDiaryView', 'init',
    'BLOCK_MINUTES', 'WEEKDAY_SHORT', 'WEEKDAY_NAMES', 'CATEGORY_CLASSES',
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

function fakeElement(id) {
  return {
    id,
    hidden: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    dataset: {},
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    dispatch(type) {
      for (const handler of this.listeners[type] ?? []) handler({ target: this });
    },
    closest() {
      return null;
    },
  };
}

function loadViewInSandbox() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'diary.js'), 'utf8');
  const sandbox = {
    JSON,
    window: { lifelens: {} },
    document: {
      createElement: (tagName) => ({ tagName, value: '', textContent: '' }),
      getElementById: () => null,
    },
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { view: sandbox.module.exports, sandbox };
}

function makeViewRoots() {
  return {
    calendarRoot: fakeElement('diary-calendar'),
    detailRoot: fakeElement('diary-detail'),
    statusEl: fakeElement('diary-status'),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('日记 9：默认打开前一天，reload 会画日历与详情', async () => {
  const { view, sandbox } = loadViewInSandbox();
  const roots = makeViewRoots();
  const asked = [];
  const yesterday = '2026-09-15';

  const diary = view.createDiaryView({
    ...roots,
    getDiary: async (day) => {
      asked.push(day);
      return dayPayload({
        day: day ?? yesterday,
        diary: DIARY,
        activityCount: 3,
        blocks: {
          total: 12,
          completed: 12,
          pending: 0,
          failed: 0,
          categorized: 12,
          categories: [{ category: '工作', blocks: 12 }],
        },
      });
    },
    getDays: async () => [
      { day: yesterday, status: 'COMPLETED', blockCount: 12, pending: 0, category: '工作', categoryBlocks: 7 },
    ],
    getStatus: async () => ({ running: true, scanning: false, stats: { total: 1, completed: 1, pending: 0, failed: 0 } }),
    regenerate: async () => ({ created: true }),
  });

  await diary.reload();

  assert.equal(asked.length, 1);
  assert.match(asked[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(asked[0], view.shiftDayKey(view.dayKeyOf(new Date()), -1), '默认看前一天');
  assert.ok(roots.calendarRoot.innerHTML.includes('data-day='));
  assert.ok(roots.detailRoot.innerHTML.includes(DIARY.summary));
  assert.equal(roots.statusEl.hidden, true, '没有待生成 / 失败的日记时不显示提示');
  assert.deepEqual(JSON.parse(JSON.stringify(diary.read())).selectedDay, asked[0]);
  assert.equal(sandbox.window.lifelensDiary, undefined, '沙箱里不应该自动初始化');
});

test('日记 10：点日期、翻月、回到今天都会重新查询，重新生成按钮能补跑', async () => {
  const { view } = loadViewInSandbox();
  const roots = makeViewRoots();
  const asked = [];
  const regen = [];
  let payload = dayPayload({ day: '2026-09-15', diary: DIARY });

  const diary = view.createDiaryView({
    ...roots,
    getDiary: async (day) => {
      asked.push(day);
      return payload;
    },
    getDays: async () => [],
    getStatus: async () => ({ stats: { total: 1, completed: 0, pending: 1, failed: 0 } }),
    regenerate: async (day) => {
      regen.push(day);
      return { created: true };
    },
  });

  await diary.reload();
  assert.equal(roots.statusEl.hidden, false);
  assert.ok(roots.statusEl.textContent.includes('正在生成 1 天的日记'));

  // 点日历上的某一天（走的是事件委托 + data-day）。
  const cell = { dataset: { day: '2026-09-10' }, disabled: false };
  cell.closest = (selector) => (selector === 'button.cal-cell' ? cell : null);
  const clickCalendar = (target) => {
    for (const handler of roots.calendarRoot.listeners.click ?? []) handler({ target });
  };
  clickCalendar(cell);
  await flush();
  assert.equal(asked.at(-1), '2026-09-10');
  assert.deepEqual(JSON.parse(JSON.stringify(diary.read())).cursor, { year: 2026, month: 8 });

  // 点「重新生成」：先调 regenerate，再重新拉一次这一天。
  const button = { dataset: { day: '2026-09-15' }, disabled: false };
  button.closest = (selector) => (selector === 'button.diary-regen' ? button : null);
  for (const handler of roots.detailRoot.listeners.click ?? []) handler({ target: button });
  await flush();
  await flush();
  assert.deepEqual(regen, ['2026-09-15']);
  assert.equal(asked.at(-1), '2026-09-10', '重新生成后重新拉当前选中的那一天');

  // 点「回到今天」：选中今天并把日历翻回当月。
  const today = view.dayKeyOf(new Date());
  const todayButton = { dataset: {}, closest: (selector) => (selector === '.cal-today' ? todayButton : null) };
  clickCalendar(todayButton);
  await flush();
  assert.equal(asked.at(-1), today);
  assert.equal(JSON.parse(JSON.stringify(diary.read())).selectedDay, today);
});

test('日记 11：接口失败时给可读的错误，不把页面留成空白', async () => {
  const { view } = loadViewInSandbox();
  const roots = makeViewRoots();
  const diary = view.createDiaryView({
    ...roots,
    getDiary: async () => {
      throw new Error('数据库打不开');
    },
    getDays: async () => [],
    getStatus: async () => ({ stats: {} }),
    regenerate: async () => ({ created: false }),
  });

  await diary.reload();

  assert.ok(roots.detailRoot.innerHTML.includes('加载日记失败'));
  assert.ok(roots.detailRoot.innerHTML.includes('数据库打不开'));
  assert.ok(roots.calendarRoot.innerHTML.includes('data-day='), '日历仍然画出来，用户可以换一天');
});
