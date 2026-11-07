'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// 搜索页的纯函数部分不碰 DOM，可以直接 require；DOM 初始化只在渲染进程里执行。
const {
  RESULT_LIMIT,
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  LAYER_META,
  readRecent,
  addRecent,
  saveRecent,
  sourceLabelOf,
  formatResultTime,
  focusWindowOf,
  jumpTargetOf,
  applyJump,
  cleanErrorMessage,
  renderCard,
  renderResults,
  resultSummary,
  createSearchView,
} = require('../src/renderer/search');

const ACTIVITY_ITEM = {
  key: 'activity:7',
  sourceType: 'activity',
  sourceLabel: '20秒记录',
  sourceId: '7',
  distance: 0.12,
  time: '2026-09-17T13:00:01+08:00',
  day: '2026-09-17',
  endTime: null,
  timelineId: 'shot-sqlite',
  title: '开发 SQLite 数据层',
  content: '写 ActivityRepository 与事务封装',
  project: 'Life Lens',
  category: 'coding',
  keywords: ['SQLite', '事务'],
  keywordsLabel: '关键词',
};

const DIARY_ITEM = {
  key: 'diary:2026-09-17',
  sourceType: 'diary',
  sourceLabel: '日记',
  sourceId: '2026-09-17',
  distance: 0.62,
  time: '2026-09-17',
  day: '2026-09-17',
  endTime: null,
  timelineId: null,
  title: '',
  content: '这一天主要在写记忆检索链路',
  project: null,
  category: null,
  keywords: ['完成语义检索'],
  keywordsLabel: '主要事项',
};

const BLOCK_ITEM = {
  key: 'block:2026-09-17T13:00:00+08:00',
  sourceType: 'block',
  sourceLabel: '10分钟汇总',
  sourceId: '2026-09-17T13:00:00+08:00',
  distance: 0.3,
  time: '2026-09-17T13:00:00+08:00',
  day: '2026-09-17',
  endTime: '2026-09-17T13:10:00+08:00',
  timelineId: null,
  title: '',
  content: '这 10 分钟在写迁移与索引',
  project: 'Life Lens',
  category: 'coding',
  keywords: ['VS Code'],
  keywordsLabel: '软件',
};

function payloadOf(items, overrides = {}) {
  return {
    query: 'SQLite',
    limit: RESULT_LIMIT,
    items,
    hits: items.length,
    returned: items.length,
    layerCounts: { activity: 2, block: 1, diary: 1 },
    missing: 0,
    invalid: 0,
    elapsedMs: 12,
    model: 'bge-m3',
    ...overrides,
  };
}

// ---- 最近搜索 ----

test('搜索页 1：最近搜索去重、最新在前、有上限', () => {
  assert.equal(RECENT_LIMIT, 8);

  let list = addRecent([], 'AI Agent');
  assert.deepEqual(list, ['AI Agent']);

  list = addRecent(list, 'Life Lens');
  list = addRecent(list, 'BGE-M3');
  assert.deepEqual(list, ['BGE-M3', 'Life Lens', 'AI Agent'], '新的在最前');

  // 重复搜索只置顶，不产生第二条。
  list = addRecent(list, 'Life Lens');
  assert.deepEqual(list, ['Life Lens', 'BGE-M3', 'AI Agent']);

  // 前后空格不影响去重。
  assert.deepEqual(addRecent(list, '  AI Agent  '), ['AI Agent', 'Life Lens', 'BGE-M3']);

  // 空关键词不进入历史，也不会把已有历史清掉。
  assert.deepEqual(addRecent(list, '   '), list.slice(0, RECENT_LIMIT));
  assert.deepEqual(addRecent([], '   '), []);

  const many = Array.from({ length: 12 }, (_, index) => `关键词 ${index}`);
  const capped = many.reduce((acc, keyword) => addRecent(acc, keyword), []);
  assert.equal(capped.length, RECENT_LIMIT);
  assert.equal(capped[0], '关键词 11');
});

test('搜索页 2：最近搜索的读写容错，坏数据不会让页面起不来', () => {
  const storage = fakeStorage();
  assert.deepEqual(readRecent(storage), [], '没有历史时是空数组');

  saveRecent(storage, ['SQLite', 'Life Lens']);
  assert.deepEqual(readRecent(storage), ['SQLite', 'Life Lens']);
  assert.equal(JSON.parse(storage.read(RECENT_STORAGE_KEY)).length, 2);

  // 存坏了 / 存成别的形状：退回空数组，而不是抛异常。
  assert.deepEqual(readRecent(fakeStorage('{ 这不是 JSON')), []);
  assert.deepEqual(readRecent(fakeStorage('{"a":1}')), []);
  assert.deepEqual(readRecent(fakeStorage('["ok", "", 3, null]')), ['ok']);
  assert.equal(readRecent(fakeStorage(JSON.stringify(new Array(20).fill('x')))).length, RECENT_LIMIT);

  // 写不进去（隐私模式 / 配额）也不能影响搜索。
  const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.doesNotThrow(() => saveRecent(broken, ['SQLite']));
  assert.doesNotThrow(() => saveRecent(undefined, ['SQLite']));
});

// ---- 结果整形 ----

test('搜索页 3：三种来源都有中文标签，时间显示区分粒度', () => {
  assert.deepEqual(LAYER_META, [['activity', '20秒记录'], ['block', '10分钟汇总'], ['diary', '日记']]);
  assert.equal(sourceLabelOf(ACTIVITY_ITEM), '20秒记录');
  assert.equal(sourceLabelOf({ sourceType: 'unknown' }), '记忆', '拿不到标签时有兜底');

  assert.match(formatResultTime(ACTIVITY_ITEM), /^2026-09-17 \d{2}:\d{2}$/);
  assert.match(formatResultTime(BLOCK_ITEM), /^2026-09-17 \d{2}:\d{2}–\d{2}:\d{2}$/, '区块带上结束时刻');
  assert.equal(formatResultTime(DIARY_ITEM), '2026-09-17', '日记只有日期');
  assert.equal(formatResultTime({ sourceType: 'activity', time: '不是时间' }), '不是时间');
});

test('搜索页 4：定位窗口——区块看 10 分钟，Activity 看它自己那一秒', () => {
  const activity = focusWindowOf(ACTIVITY_ITEM);
  assert.equal(activity.from.getTime(), new Date('2026-09-17T13:00:01+08:00').getTime());
  assert.equal(activity.to.getTime() - activity.from.getTime(), 1000);

  const block = focusWindowOf(BLOCK_ITEM);
  assert.equal(block.from.getTime(), new Date(BLOCK_ITEM.time).getTime());
  assert.equal(block.to.getTime(), new Date(BLOCK_ITEM.endTime).getTime());

  assert.equal(focusWindowOf({ sourceType: 'activity', time: null }), null);
  assert.equal(focusWindowOf({ sourceType: 'activity', time: '不是时间' }), null);
  // 结束时间早于开始时间（脏数据）时退回「一秒窗口」，不会查出一个空区间。
  const dirty = focusWindowOf({ ...BLOCK_ITEM, endTime: '2026-09-17T12:59:00+08:00' });
  assert.equal(dirty.to.getTime() - dirty.from.getTime(), 1000);
});

test('搜索页 5：点结果 -> 切到已有页面并定位，不新建详情页', () => {
  const called = [];
  const views = {
    tabs: { select: (name) => called.push(['tab', name]) },
    timeline: { focus: (range, id) => called.push(['focus', range, id]) },
    diary: { selectDay: (day) => called.push(['day', day]) },
  };

  // 20 秒记录：切到时间线，用记录自己的时间窗口定位，并带上 Timeline 的卡片 id。
  assert.equal(applyJump(jumpTargetOf(ACTIVITY_ITEM), views), true);
  assert.deepEqual(called[0], ['tab', 'overview']);
  assert.equal(called[1][0], 'focus');
  assert.equal(called[1][1].from.getTime(), new Date(ACTIVITY_ITEM.time).getTime());
  assert.equal(called[1][2], 'shot-sqlite');

  // 日记：切到日记页并选中那一天。
  assert.equal(applyJump(jumpTargetOf(DIARY_ITEM), views), true);
  assert.deepEqual(called.slice(2), [['tab', 'diary'], ['day', '2026-09-17']]);

  // 时间取不出来的结果不跳转（而不是跳到错误的位置）。
  assert.equal(jumpTargetOf({ sourceType: 'activity', time: '' }), null);
  assert.equal(jumpTargetOf({}), null);
  assert.equal(applyJump(null, views), false);
  // 目标视图还没挂上（脚本顺序 / 页面没打开）时不能抛错。
  assert.doesNotThrow(() => applyJump(jumpTargetOf(ACTIVITY_ITEM), undefined));
});

test('搜索页 6：IPC 错误信息剥掉 Electron 前缀', () => {
  assert.equal(cleanErrorMessage(new Error('Ollama 连不上')), 'Ollama 连不上');
  assert.equal(
    cleanErrorMessage(new Error("Error invoking remote method 'lifelens:memory-search': Error: 记忆搜索不可用：向量检索失败")),
    '记忆搜索不可用：向量检索失败',
  );
  assert.equal(cleanErrorMessage(undefined), '未知原因');
});

// ---- 渲染 ----

test('搜索页 7：结果卡片展示时间、内容、项目、分类、关键词与来源标签', () => {
  const html = renderCard(ACTIVITY_ITEM, 0);

  assert.ok(html.includes('data-open="0"'));
  assert.ok(html.includes('search-source-activity'));
  assert.ok(html.includes('20秒记录'));
  assert.ok(html.includes('开发 SQLite 数据层'));
  assert.ok(html.includes('写 ActivityRepository 与事务封装'));
  assert.ok(html.includes('项目 Life Lens'));
  assert.ok(html.includes('分类 coding'));
  assert.ok(html.includes('关键词：SQLite · 事务'));
  // CSP 是 script-src 'self'：不能出现内联事件或内联样式。
  assert.equal(/on[a-z]+=/.test(html), false);
  assert.equal(html.includes('style='), false);

  // 区块用「软件」，日记用「主要事项」；没有内容的记录给一行提示而不是空白卡片。
  assert.ok(renderCard(BLOCK_ITEM, 1).includes('软件：VS Code'));
  assert.ok(renderCard(DIARY_ITEM, 2).includes('主要事项：完成语义检索'));
  assert.ok(renderCard({ sourceType: 'block', content: '', time: '' }, 3).includes('这条记录没有可显示的内容'));

  // 内容里的 HTML 一律转义。
  const escaped = renderCard({ ...ACTIVITY_ITEM, title: '<img src=x onerror=alert(1)>' }, 4);
  assert.ok(escaped.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(escaped.includes('<img'), false);
});

test('搜索页 8：空结果与统计文案', () => {
  const empty = renderResults(payloadOf([]));
  assert.ok(empty.includes('没有找到相关的记忆'));
  assert.equal(empty.includes('search-results'), false);

  const html = renderResults(payloadOf([ACTIVITY_ITEM, DIARY_ITEM]));
  assert.ok(html.startsWith('<ol class="search-results">'));
  assert.equal(html.split('class="search-card"').length - 1, 2, '两条结果两张卡片');

  assert.equal(
    resultSummary(payloadOf([ACTIVITY_ITEM])),
    '找到 1 条相关记忆 · 各层候选：20秒记录 2 · 10分钟汇总 1 · 日记 1',
  );
  assert.equal(
    resultSummary(payloadOf([ACTIVITY_ITEM], { missing: 2, invalid: 1 })),
    '找到 1 条相关记忆 · 各层候选：20秒记录 2 · 10分钟汇总 1 · 日记 1（已失效 2 条，跳过异常 1 条）',
  );
});

// ---- classic script 的作用域隔离 ----

test('搜索页 9：作为 classic script 执行时不污染全局作用域', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'search.js'), 'utf8');
  const sandbox = { JSON, window: { lifelens: {} }, document: { getElementById: () => null } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  // search.js 与 renderer.js / timeline.js 共享同一个全局作用域，同名的 pad / escapeHtml
  // 会互相覆盖，所以这些函数不能挂到全局上。
  const names = [
    'pad', 'escapeHtml', 'toDate', 'formatDateTime', 'formatClock', 'formatResultTime',
    'sourceLabelOf', 'readRecent', 'addRecent', 'saveRecent', 'focusWindowOf', 'jumpTargetOf',
    'applyJump', 'cleanErrorMessage', 'renderCard', 'renderResults', 'resultSummary',
    'createSearchView', 'onElementClick', 'init', 'LAYER_META', 'SOURCE_LABELS',
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
    innerHTML: '',
    textContent: '',
    className: '',
    dataset: {},
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of this.listeners[type] ?? []) handler({ target: this, ...event });
    },
    closest() {
      return null;
    },
  };
}

function fakeStorage(initial = null) {
  const map = new Map();
  if (initial !== null) map.set(RECENT_STORAGE_KEY, initial);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    read: (key) => map.get(key),
  };
}

// 事件处理器内部的 run() 是异步的：派发事件后等一个宏任务，让整条链路跑完。
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeView({ search, storage = fakeStorage(), views = {} } = {}) {
  const roots = {
    input: fakeElement('search-input'),
    submit: fakeElement('search-submit'),
    statusEl: fakeElement('search-status'),
    resultsEl: fakeElement('search-results'),
    recentEl: fakeElement('search-recent'),
    recentWrap: fakeElement('search-recent-wrap'),
  };
  const view = createSearchView({ ...roots, history: storage, search, views });
  return { view, roots, history: storage };
}

const clickTarget = (dataset) => ({ closest: (selector) => (selector === '[data-open]' ? { dataset } : null) });

test('搜索页 10：输入 -> 搜索 -> 画结果 + 记最近搜索', async () => {
  const storage = fakeStorage();
  const asked = [];
  const { view, roots, history } = makeView({
    storage,
    search: async (query, limit) => {
      asked.push([query, limit]);
      return payloadOf([ACTIVITY_ITEM, DIARY_ITEM]);
    },
  });

  // 空输入不查库，只提示。
  await view.run('');
  assert.deepEqual(asked, []);
  assert.ok(roots.resultsEl.innerHTML.includes('先输入一句话'));

  // 点「搜索」按钮走完整链路：前后空格裁掉、结果画出来、状态栏给统计。
  roots.input.value = '  我最近什么时候研究过 SQLite？  ';
  roots.submit.dispatch('click');
  await flush();

  assert.deepEqual(asked, [['我最近什么时候研究过 SQLite？', RESULT_LIMIT]]);
  assert.equal(roots.input.value, '我最近什么时候研究过 SQLite？');
  assert.equal(roots.resultsEl.innerHTML.split('class="search-card"').length - 1, 2);
  assert.ok(roots.statusEl.textContent.includes('找到 2 条相关记忆'));
  assert.equal(roots.statusEl.hidden, false);

  // 最近搜索：进了 localStorage，并且画成可点的按钮。
  assert.deepEqual(JSON.parse(history.read(RECENT_STORAGE_KEY)), ['我最近什么时候研究过 SQLite？']);
  assert.equal(roots.recentWrap.hidden, false);
  assert.ok(roots.recentEl.innerHTML.includes('data-recent="0"'));

  // 点最近搜索的词条会重新执行搜索。
  roots.recentEl.dispatch('click', { target: { closest: () => ({ dataset: { recent: '0' } }) } });
  await flush();
  assert.equal(asked.length, 2);
  assert.equal(asked[1][0], '我最近什么时候研究过 SQLite？');
});

test('搜索页 11：搜索失败给可读原因，结果区与状态区都不留空白', async () => {
  const { roots } = makeView({
    search: async () => {
      throw new Error("Error invoking remote method 'lifelens:memory-search': Error: 记忆搜索不可用：向量检索失败（LanceDB 打不开）");
    },
  });

  roots.input.value = 'SQLite';
  roots.submit.dispatch('click');
  await flush();

  assert.ok(roots.resultsEl.innerHTML.includes('搜索失败'));
  assert.ok(roots.resultsEl.innerHTML.includes('LanceDB 打不开'));
  assert.equal(roots.resultsEl.innerHTML.includes('Error invoking remote method'), false);
  assert.equal(roots.statusEl.className, 'search-status error');
  assert.ok(roots.statusEl.textContent.includes('Ollama'));
});

test('搜索页 12：回车搜索，点结果调用注入的视图对象跳转', async () => {
  const called = [];
  const { roots } = makeView({
    search: async () => payloadOf([ACTIVITY_ITEM, DIARY_ITEM]),
    views: {
      tabs: { select: (name) => called.push(['tab', name]) },
      timeline: { focus: (range, id) => called.push(['focus', id, range.from.getTime()]) },
      diary: { selectDay: (day) => called.push(['day', day]) },
    },
  });

  roots.input.value = 'SQLite';
  roots.input.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.equal(roots.resultsEl.innerHTML.split('class="search-card"').length - 1, 2);

  // 第 0 条是 20 秒记录 -> 时间线定位。
  roots.resultsEl.dispatch('click', { target: clickTarget({ open: '0' }) });
  assert.deepEqual(called, [
    ['tab', 'overview'],
    ['focus', 'shot-sqlite', new Date(ACTIVITY_ITEM.time).getTime()],
  ]);
  assert.ok(roots.statusEl.textContent.includes('已跳转到时间线'));

  // 第 1 条是日记 -> 日记页的那一天。
  roots.resultsEl.dispatch('click', { target: clickTarget({ open: '1' }) });
  assert.deepEqual(called.slice(2), [['tab', 'diary'], ['day', '2026-09-17']]);
  assert.ok(roots.statusEl.textContent.includes('已跳转到日记页'));

  // 非 Enter 的按键不触发搜索。
  const before = roots.resultsEl.innerHTML;
  roots.input.value = '不该触发';
  roots.input.dispatch('keydown', { key: 'a' });
  await flush();
  assert.equal(roots.resultsEl.innerHTML, before);
});
