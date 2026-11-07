'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// 时间线的纯函数部分不碰 DOM，可以直接 require；DOM 初始化只在渲染进程里执行。
const {
  TIMELINE_PAGE_SIZE,
  PROJECT_UNASSIGNED,
  imagePathToFileUrl,
  formatClock,
  formatDayLabel,
  groupByDay,
  statusOf,
  parseDateInput,
  resolveTimeRange,
  buildTimelineQuery,
  hasActiveFilters,
  matchesFilters,
} = require('../src/renderer/timeline');
const { formatLocalIso } = require('../src/main/time');

function at(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second);
}

test('时间线 1：imagePath 转成 file:/// URL（盘符 / 反斜杠 / 中文 / 空格 / #）', () => {
  assert.equal(imagePathToFileUrl('C:\\Users\\x\\a.png'), 'file:///C:/Users/x/a.png');
  assert.equal(
    imagePathToFileUrl('C:/Users/a b/中文#1.png'),
    'file:///C:/Users/a%20b/%E4%B8%AD%E6%96%87%231.png',
  );
  assert.equal(imagePathToFileUrl('D:\\截 图\\x.png'), 'file:///D:/%E6%88%AA%20%E5%9B%BE/x.png');
});

test('时间线 2：file URL 是三个斜杠，盘符冒号不被转义', () => {
  const url = imagePathToFileUrl('C:\\a\\b.png');
  assert.match(url, /^file:\/\/\/C:\//);
  assert.equal(url.startsWith('file://C:'), false);
  assert.equal(url.includes('%3A'), false);
});

test('时间线 3：空路径 / 缺失路径返回空字符串', () => {
  assert.equal(imagePathToFileUrl(''), '');
  assert.equal(imagePathToFileUrl('   '), '');
  assert.equal(imagePathToFileUrl(null), '');
  assert.equal(imagePathToFileUrl(undefined), '');
});

test('时间线 4：组内时间显示到秒（同一分钟内的两条时间不同）', () => {
  assert.equal(formatClock(formatLocalIso(at(2026, 9, 14, 9, 5))), '09:05:00');
  assert.equal(formatClock(formatLocalIso(at(2026, 9, 14, 9, 5, 20))), '09:05:20');
  assert.equal(formatClock(formatLocalIso(at(2026, 9, 14, 23, 59, 59))), '23:59:59');
  assert.equal(formatClock('这不是时间'), '--:--');
});

test('时间线 5：组头是 YYYY-MM-DD 周X，当天带「今天」', () => {
  const today = at(2026, 9, 14, 20, 0);
  assert.equal(formatDayLabel(at(2026, 9, 14, 10, 0), today), '今天 · 2026-09-14 周一');
  assert.equal(formatDayLabel(at(2026, 9, 13, 10, 0), today), '2026-09-13 周日');
});

test('时间线 6：按本地自然日分组，组内保持倒序', () => {
  const items = [
    { id: 'c', time: formatLocalIso(at(2026, 9, 14, 14, 32)) },
    { id: 'b', time: formatLocalIso(at(2026, 9, 14, 14, 31)) },
    { id: 'a', time: formatLocalIso(at(2026, 9, 13, 23, 59)) },
  ];

  const groups = groupByDay(items, at(2026, 9, 14, 20, 0));
  assert.deepEqual(groups.map((group) => group.key), ['2026-09-14', '2026-09-13']);
  assert.deepEqual(groups[0].items.map((item) => item.id), ['c', 'b']);
  assert.deepEqual(groups[1].items.map((item) => item.id), ['a']);
  assert.equal(groups[0].label, '今天 · 2026-09-14 周一');
  assert.equal(groups[1].label, '2026-09-13 周日');
});

test('时间线 7：跨年按自然日分开，没有数据就没有分组', () => {
  const items = [
    { id: 'x', time: formatLocalIso(at(2026, 1, 1, 0, 5)) },
    { id: 'y', time: formatLocalIso(at(2025, 12, 31, 23, 55)) },
  ];

  const groups = groupByDay(items, at(2026, 1, 1, 12, 0));
  assert.deepEqual(groups.map((group) => group.key), ['2026-01-01', '2025-12-31']);
  assert.equal(groups[0].label, '今天 · 2026-01-01 周四');
  assert.equal(groupByDay([]).length, 0);
});

test('时间线 8：时间字段坏掉时归入「未知时间」，不产生 NaN 组头', () => {
  const groups = groupByDay([{ id: 'bad', time: 'nope' }], at(2026, 9, 14));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'unknown');
  assert.equal(groups[0].label, '未知时间');
});

test('时间线 9：analysis_status 映射成三种展示状态，缺失值按分析中兜底', () => {
  assert.equal(statusOf({ analysisStatus: 'COMPLETED' }).text, '已分析');
  assert.equal(statusOf({ analysisStatus: 'FAILED' }).text, '分析失败');
  assert.equal(statusOf({ analysisStatus: 'PENDING' }).text, '分析中');
  assert.equal(statusOf({ analysisStatus: 'PROCESSING' }).text, '分析中');
  assert.equal(statusOf({}).text, '分析中');
});

test('时间线 10：页大小与数据层默认 limit 一致', () => {
  assert.equal(TIMELINE_PAGE_SIZE, 20);
});

test('时间线 11：作为 classic script 执行时不污染全局作用域', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'timeline.js'),
    'utf8',
  );
  const sandbox = {
    JSON,
    window: { lifelens: {} },
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  // timeline.js 与 renderer.js 共享同一个全局作用域，重名的函数声明会互相覆盖
  //（两边都有 pad / formatClock，谁泄漏到全局就会把对方的实现顶掉）。
  const names = [
    'pad', 'escapeHtml', 'formatClock', 'formatDayLabel', 'groupByDay', 'statusOf', 'renderCard',
    'parseDateInput', 'resolveTimeRange', 'buildTimelineQuery', 'hasActiveFilters', 'matchesFilters',
    'createFilterBar', 'fillSelect', 'facetEntries', 'SEARCH_DEBOUNCE_MS', 'PROJECT_UNASSIGNED',
  ];
  for (const name of names) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(sandbox, name),
      false,
      `${name} 不应该挂到全局作用域`,
    );
  }
});

// ---- Phase 7.3：搜索与筛选的纯函数 ----

// 与数据层返回的记录同构：有 analysis 时顶层 summary 与 analysis.summary 同值。
function analyzed(id, time, analysis = {}, overrides = {}) {
  const merged = {
    activity: '写代码',
    summary: '正在写代码',
    category: 'coding',
    project: 'Life Lens',
    keywords: [],
    confidence: 0.9,
    ...analysis,
  };
  return {
    id,
    time: formatLocalIso(time),
    imagePath: `C:/tmp/${id}.png`,
    analysisStatus: 'COMPLETED',
    analysis: merged,
    summary: merged.summary,
    ...overrides,
  };
}

function pendingRecord(id, time) {
  return {
    id,
    time: formatLocalIso(time),
    imagePath: `C:/tmp/${id}.png`,
    analysisStatus: 'PENDING',
    analysis: null,
    summary: null,
  };
}

// 界面上的「不筛」状态。
const NO_FILTERS = {
  search: '',
  category: '',
  project: '',
  noProject: false,
  status: '',
  range: 'all',
  from: '',
  to: '',
};

function isoRange(range) {
  return {
    from: range.from ? formatLocalIso(range.from) : null,
    to: range.to ? formatLocalIso(range.to) : null,
  };
}
test('时间线 12：日期输入按本地时间解析成当天 00:00，非法值返回 null', () => {
  assert.equal(formatLocalIso(parseDateInput('2026-09-11')), formatLocalIso(at(2026, 9, 11, 0, 0)));
  assert.equal(parseDateInput('  2026-09-11 ').getDate(), 11);
  for (const bad of ['', '   ', '2026/09/11', '2026-9-1', '不是日期', null, undefined]) {
    assert.equal(parseDateInput(bad), null, `${String(bad)} 应该解析失败`);
  }
});

test('时间线 13：时间预设换算成闭开区间 [from, to)', () => {
  const now = at(2026, 9, 11, 15, 30);
  assert.deepEqual(isoRange(resolveTimeRange('all', '', '', now)), { from: null, to: null });
  assert.deepEqual(isoRange(resolveTimeRange('today', '', '', now)), {
    from: formatLocalIso(at(2026, 9, 11, 0)),
    to: formatLocalIso(at(2026, 9, 12, 0)),
  });
  assert.deepEqual(isoRange(resolveTimeRange('yesterday', '', '', now)), {
    from: formatLocalIso(at(2026, 9, 10, 0)),
    to: formatLocalIso(at(2026, 9, 11, 0)),
  });
  assert.deepEqual(isoRange(resolveTimeRange('last7', '', '', now)), {
    from: formatLocalIso(at(2026, 9, 5, 0)),
    to: formatLocalIso(at(2026, 9, 12, 0)),
  });

  // 自定义：结束日期按「含当天」理解，上界取它第二天 00:00。
  assert.deepEqual(isoRange(resolveTimeRange('custom', '2026-09-01', '2026-09-03', now)), {
    from: formatLocalIso(at(2026, 9, 1, 0)),
    to: formatLocalIso(at(2026, 9, 4, 0)),
  });
  assert.deepEqual(isoRange(resolveTimeRange('custom', '2026-09-01', '', now)), {
    from: formatLocalIso(at(2026, 9, 1, 0)),
    to: null,
  });
  assert.deepEqual(isoRange(resolveTimeRange('custom', '', '2026-09-03', now)), {
    from: null,
    to: formatLocalIso(at(2026, 9, 4, 0)),
  });
  assert.deepEqual(isoRange(resolveTimeRange('custom', '', '', now)), { from: null, to: null });
  // 认不出来的预设不筛时间。
  assert.deepEqual(isoRange(resolveTimeRange('nope', '', '', now)), { from: null, to: null });

  // 跨月：9 月 2 日的「最近 7 天」从 8 月 27 日开始。
  const early = at(2026, 9, 2, 9);
  assert.deepEqual(isoRange(resolveTimeRange('last7', '', '', early)), {
    from: formatLocalIso(at(2026, 8, 27, 0)),
    to: formatLocalIso(at(2026, 9, 3, 0)),
  });
});
test('时间线 14：buildTimelineQuery 把筛选状态翻译成数据层参数', () => {
  const now = at(2026, 9, 11, 15, 30);

  // 不筛：只剩分页参数。
  assert.deepEqual(buildTimelineQuery(NO_FILTERS, { limit: 20, now }), { limit: 20, offset: 0 });
  assert.equal(hasActiveFilters(NO_FILTERS), false);
  assert.equal(buildTimelineQuery(NO_FILTERS, { limit: 20 }).offset, 0);

  const full = {
    ...NO_FILTERS,
    search: 'SQLite',
    category: 'coding',
    project: 'Life Lens',
    status: 'COMPLETED',
    range: 'today',
  };
  assert.equal(hasActiveFilters(full), true);
  assert.deepEqual(buildTimelineQuery(full, { limit: 20, offset: 40, now }), {
    from: at(2026, 9, 11, 0),
    to: at(2026, 9, 12, 0),
    search: 'SQLite',
    category: 'coding',
    project: 'Life Lens',
    status: 'COMPLETED',
    limit: 20,
    offset: 40,
  });

  // 每一项单独出现时都算「有筛选」。
  for (const patch of [
    { search: 'x' }, { category: 'coding' }, { project: 'Life Lens' },
    { noProject: true }, { status: 'FAILED' }, { range: 'custom' },
  ]) {
    assert.equal(hasActiveFilters({ ...NO_FILTERS, ...patch }), true, JSON.stringify(patch));
  }

  // 无项目：只传 noProject，不传 project。
  const unassigned = { ...NO_FILTERS, noProject: true };
  assert.deepEqual(buildTimelineQuery(unassigned, { limit: 20, now }), {
    noProject: true,
    limit: 20,
    offset: 0,
  });
});
test('时间线 15：matchesFilters 与数据层语义一致（时间 / 关键词 / 分类 / 项目 / 状态）', () => {
  const now = at(2026, 9, 11, 15, 30);
  const coding = analyzed('a', at(2026, 9, 11, 10), { summary: '调 SQLite 索引', keywords: ['Ollama'] });
  const learning = analyzed('b', at(2026, 9, 10, 10), {
    category: 'learning', project: 'Ollama', summary: '看文档', keywords: [],
  });
  const pending = pendingRecord('c', at(2026, 9, 11, 11));

  // 没有任何筛选：一律通过（PENDING 也一样）。
  for (const item of [coding, learning, pending]) {
    assert.equal(matchesFilters(item, NO_FILTERS, now), true);
  }

  // 关键词：activity / summary / project / keywords 都能命中，且 ASCII 不分大小写。
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, search: 'sqlite' }, now), true);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, search: 'ollama' }, now), true);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, search: '写代码' }, now), true);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, search: 'life lens' }, now), true);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, search: '中文关键词' }, now), false);
  // PENDING 还没有任何文本，任何关键词都筛不到它。
  assert.equal(matchesFilters(pending, { ...NO_FILTERS, search: '写代码' }, now), false);

  // 时间范围。
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, range: 'today' }, now), true);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, range: 'yesterday' }, now), false);
  assert.equal(matchesFilters(learning, { ...NO_FILTERS, range: 'yesterday' }, now), true);
  assert.equal(matchesFilters(learning, { ...NO_FILTERS, range: 'last7' }, now), true);

  // 分类 / 项目 / 无项目。
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, category: 'coding' }, now), true);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, category: 'learning' }, now), false);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, project: 'Life Lens' }, now), true);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, project: 'Ollama' }, now), false);
  assert.equal(matchesFilters(pending, { ...NO_FILTERS, noProject: true }, now), true);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, noProject: true }, now), false);

  // 状态三档。
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, status: 'COMPLETED' }, now), true);
  assert.equal(matchesFilters(pending, { ...NO_FILTERS, status: 'COMPLETED' }, now), false);
  assert.equal(matchesFilters(pending, { ...NO_FILTERS, status: 'PENDING' }, now), true);
  assert.equal(matchesFilters(coding, { ...NO_FILTERS, status: 'PENDING' }, now), false);
  assert.equal(matchesFilters(pending, { ...NO_FILTERS, status: 'FAILED' }, now), false);

  // 组合：时间 + 分类 + 项目 + 关键词。
  const combo = {
    ...NO_FILTERS, range: 'last7', category: 'coding', project: 'Life Lens', search: 'sqlite',
  };
  assert.equal(matchesFilters(coding, combo, now), true);
  assert.equal(matchesFilters(learning, combo, now), false);
});