'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// 问答页的纯函数部分不碰 DOM，可以直接 require；DOM 初始化只在渲染进程里执行。
const {
  CONFIDENCE_LABELS,
  NO_QUESTION_HINT,
  confidenceLabel,
  renderAnswer,
  createAskView,
} = require('../src/renderer/ask');

// 相关记忆的卡片渲染与跳转都是搜索页（Phase 11）的真实实现，这里直接注入，
// 验证「不复制第二份」这件事是真的。
const search = require('../src/renderer/search');
const KIT = {
  jumpTargetOf: search.jumpTargetOf,
  applyJump: search.applyJump,
  cleanErrorMessage: search.cleanErrorMessage,
  renderResults: search.renderResults,
};

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
  keywords: ['SQLite'],
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

function payloadOf(overrides = {}) {
  return {
    question: '我最近在做什么？',
    answer: '你最近主要在 Life Lens 上写问答链路。',
    confidence: 'medium',
    memories: [ACTIVITY_ITEM, DIARY_ITEM],
    model: 'qwen3-vl:8b',
    elapsedMs: 18300,
    ...overrides,
  };
}

// ---- 回答渲染（纯函数）----

test('问答页 1：回答与依据充分程度渲染，内容一律转义', () => {
  assert.deepEqual(CONFIDENCE_LABELS, { high: '高', medium: '中', low: '低' });
  assert.equal(confidenceLabel('high'), '高');
  assert.equal(confidenceLabel('medium'), '中');
  assert.equal(confidenceLabel('low'), '低');
  assert.equal(confidenceLabel('very-high'), '未知');
  assert.equal(confidenceLabel(null), '未知');

  const html = renderAnswer(payloadOf());
  assert.ok(html.includes('你最近主要在 Life Lens 上写问答链路。'));
  assert.ok(html.includes('依据充分程度：中'));
  assert.ok(html.includes('用时 18.3 秒'));

  // 没有耗时就不显示这一段，而不是显示 undefined。
  const bare = renderAnswer(payloadOf({ elapsedMs: 0 }));
  assert.ok(bare.includes('依据充分程度：中'));
  assert.equal(bare.includes('用时'), false);

  // 没有回答（理论上走不到，服务端一定给文案）：退回提示而不是空白。
  assert.ok(renderAnswer(payloadOf({ answer: '   ' })).includes(NO_QUESTION_HINT));
  assert.ok(renderAnswer(null).includes(NO_QUESTION_HINT));

  const escaped = renderAnswer(payloadOf({ answer: '<img src=x onerror=alert(1)>' }));
  assert.ok(escaped.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(escaped.includes('<img'), false);
});

// ---- 视图装配（假 DOM）----

function fakeElement(id) {
  return {
    id,
    hidden: false,
    innerHTML: '',
    textContent: '',
    className: '',
    disabled: false,
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

// 事件处理器内部的 run() 是异步的：派发事件后等一个宏任务，让整条链路跑完。
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeView({ ask, views = {} } = {}) {
  const roots = {
    input: fakeElement('ask-input'),
    submit: fakeElement('ask-submit'),
    statusEl: fakeElement('ask-status'),
    answerEl: fakeElement('ask-answer'),
    memoriesEl: fakeElement('ask-memories'),
    memoriesWrap: fakeElement('ask-memories-wrap'),
  };
  // ask 可以在中途替换（测试「失败后还能继续提问」的场景）。
  const state = { ask };
  const view = createAskView({
    ...roots,
    ask: (question) => state.ask(question),
    kit: KIT,
    views,
  });
  return { view, roots, setAsk: (next) => { state.ask = next; } };
}

const clickTarget = (dataset) => ({ closest: (selector) => (selector === '[data-open]' ? { dataset } : null) });

test('问答页 2：点提问与回车都能提交，空问题不触发 IPC', async () => {
  const asked = [];
  const { roots } = makeView({
    ask: async (question) => {
      asked.push(question);
      return payloadOf();
    },
  });

  // 空问题：本地拦截，不走 IPC，页面上给提示。
  roots.input.value = '   ';
  roots.submit.dispatch('click');
  await flush();
  assert.deepEqual(asked, []);
  assert.ok(roots.answerEl.innerHTML.includes(NO_QUESTION_HINT));

  // 点「提问」按钮：前后空格裁掉。
  roots.input.value = '  我最近在做什么？  ';
  roots.submit.dispatch('click');
  await flush();
  assert.deepEqual(asked, ['我最近在做什么？']);
  assert.equal(roots.input.value, '我最近在做什么？');
  assert.ok(roots.answerEl.innerHTML.includes('你最近主要在 Life Lens 上写问答链路。'));

  // 回车提交走同一条链路。
  roots.input.value = '我昨天在做什么？';
  roots.input.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.deepEqual(asked, ['我最近在做什么？', '我昨天在做什么？']);

  // 非 Enter 的按键不触发。
  const before = roots.answerEl.innerHTML;
  roots.input.value = '不该触发';
  roots.input.dispatch('keydown', { key: 'a' });
  await flush();
  assert.equal(roots.answerEl.innerHTML, before);
  assert.equal(asked.length, 2);
});

test('问答页 3：生成期间显示 loading、按钮禁用、重复提交被拦，结束后恢复', async () => {
  const asked = [];
  let resolveAsk;
  const pending = new Promise((resolve) => { resolveAsk = resolve; });
  const { roots } = makeView({
    ask: (question) => {
      asked.push(question);
      return pending;
    },
  });

  assert.equal(roots.submit.disabled, false);

  roots.input.value = '我最近在做什么？';
  roots.submit.dispatch('click');
  await flush();

  // 生成要十几秒到几十秒：这段时间必须看得出在等，且不能重复提交。
  assert.equal(roots.submit.disabled, true);
  assert.ok(roots.answerEl.innerHTML.includes('正在检索记忆并生成回答'));
  assert.ok(roots.statusEl.textContent.includes('正在回忆并生成回答'));
  assert.equal(roots.statusEl.hidden, false);

  roots.submit.dispatch('click');
  roots.input.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.deepEqual(asked, ['我最近在做什么？'], '生成期间重复提交被拦下');

  resolveAsk(payloadOf());
  await flush();

  assert.equal(roots.submit.disabled, false);
  assert.ok(roots.answerEl.innerHTML.includes('依据充分程度：中'));
  assert.ok(roots.statusEl.textContent.includes('回答基于 2 条相关记忆'));
  assert.equal(roots.statusEl.className, 'search-status');
});

test('问答页 4：相关记忆列表渲染来源、时间、摘要与项目 / 分类', async () => {
  const { roots } = makeView({ ask: async () => payloadOf() });

  // 提交前：相关记忆区是收起的。
  assert.equal(roots.memoriesWrap.hidden, true);

  roots.input.value = '我最近在做什么？';
  roots.submit.dispatch('click');
  await flush();

  const html = roots.memoriesEl.innerHTML;
  assert.equal(roots.memoriesWrap.hidden, false);
  assert.equal(html.split('class="search-card"').length - 1, 2, '两条记忆两张卡片');
  assert.ok(html.includes('20秒记录'), '来源标签');
  assert.ok(html.includes('日记'));
  assert.ok(html.includes('写 ActivityRepository 与事务封装'), '摘要');
  assert.ok(html.includes('项目 Life Lens'), '项目');
  assert.ok(html.includes('分类 coding'), '分类');
  assert.ok(html.includes('主要事项：完成语义检索'), '日记的主要事项');
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(html), '时间');

  // 没有相关记忆：区域收起，但回答照常显示。
  const empty = makeView({
    ask: async () => payloadOf({ memories: [], answer: '没有找到足够相关的历史记录，暂时无法准确回答这个问题。' }),
  });
  empty.roots.input.value = '我上周在做什么？';
  empty.roots.submit.dispatch('click');
  await flush();
  assert.equal(empty.roots.memoriesWrap.hidden, true);
  assert.equal(empty.roots.memoriesEl.innerHTML, '');
  assert.ok(empty.roots.answerEl.innerHTML.includes('没有找到足够相关的历史记录'));
  assert.equal(empty.roots.statusEl.hidden, true);
});

test('问答页 5：点相关记忆复用搜索页的跳转（时间线定位 / 日记某一天）', async () => {
  const called = [];
  const { roots } = makeView({
    ask: async () => payloadOf(),
    views: {
      tabs: { select: (name) => called.push(['tab', name]) },
      timeline: { focus: (range, id) => called.push(['focus', id, range.from.getTime()]) },
      diary: { selectDay: (day) => called.push(['day', day]) },
    },
  });

  roots.input.value = '我最近在做什么？';
  roots.submit.dispatch('click');
  await flush();

  // 第 0 条是 20 秒记录 -> 时间线定位。
  roots.memoriesEl.dispatch('click', { target: clickTarget({ open: '0' }) });
  assert.deepEqual(called, [
    ['tab', 'overview'],
    ['focus', 'shot-sqlite', new Date(ACTIVITY_ITEM.time).getTime()],
  ]);
  assert.ok(roots.statusEl.textContent.includes('已跳转到时间线'));

  // 第 1 条是日记 -> 日记页的那一天。
  roots.memoriesEl.dispatch('click', { target: clickTarget({ open: '1' }) });
  assert.deepEqual(called.slice(2), [['tab', 'diary'], ['day', '2026-09-17']]);
  assert.ok(roots.statusEl.textContent.includes('已跳转到日记页'));
});

test('问答页 6：IPC 失败显示可读原因，页面结构与后续提问都不受影响', async () => {
  const { roots, setAsk } = makeView({
    ask: async () => {
      throw new Error("Error invoking remote method 'lifelens:ask': Error: 暂时无法搜索历史记忆，请检查本地 AI 服务：记忆检索没有装配");
    },
  });

  roots.input.value = '我最近在做什么？';
  roots.submit.dispatch('click');
  await flush();

  assert.ok(roots.answerEl.innerHTML.includes('提问失败'));
  assert.ok(roots.answerEl.innerHTML.includes('暂时无法搜索历史记忆'));
  assert.ok(roots.answerEl.innerHTML.includes('记忆检索没有装配'));
  assert.equal(roots.answerEl.innerHTML.includes('Error invoking remote method'), false);
  assert.equal(roots.statusEl.className, 'search-status error');
  assert.equal(roots.statusEl.hidden, false);
  assert.equal(roots.memoriesWrap.hidden, true, '失败时相关记忆区收起，不留上一次的残骸');
  assert.equal(roots.submit.disabled, false, '失败后按钮必须恢复');

  // 失败之后还能继续提问：错误被新结果覆盖。
  setAsk(async () => payloadOf());
  roots.submit.dispatch('click');
  await flush();
  assert.equal(roots.answerEl.innerHTML.includes('提问失败'), false);
  assert.ok(roots.answerEl.innerHTML.includes('依据充分程度：中'));
  assert.equal(roots.statusEl.className, 'search-status');
  assert.equal(roots.memoriesWrap.hidden, false);
});

// ---- classic script 的作用域隔离 ----

test('问答页 7：作为 classic script 执行时不污染全局作用域', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ask.js'), 'utf8');
  const sandbox = { JSON, window: { lifelens: {} }, document: { getElementById: () => null } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  // 与 search.js / renderer.js 共享同一个全局作用域：同名的 escapeHtml 会互相覆盖，
  // 所以这些函数不能挂到全局上。
  const names = [
    'escapeHtml', 'pad', 'confidenceLabel', 'renderAnswer', 'createAskView',
    'onElementClick', 'init', 'CONFIDENCE_LABELS', 'NO_QUESTION_HINT', 'LOADING_HINT',
  ];
  for (const name of names) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(sandbox, name),
      false,
      `${name} 不应该挂到全局作用域`,
    );
  }
});
