'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { LanceStore } = require('../src/main/embedding/lanceStore');
const { MemoryVectorRepository } = require('../src/main/embedding/MemoryVectorRepository');
const {
  MemorySearchService,
  MemorySearchError,
  SOURCE_LAYERS,
} = require('../src/main/search/MemorySearchService');
const {
  AskMyLifeService,
  AskMyLifeError,
  QA_SCHEMA,
  QA_SYSTEM_PROMPT,
  CONFIDENCE_LEVELS,
  SEARCH_LIMIT,
  CONTEXT_MAX_CHARS,
  NO_MEMORY_ANSWER,
  SEARCH_ERROR_PREFIX,
  ANSWER_ERROR_PREFIX,
  buildContext,
  formatMemoryTime,
} = require('../src/main/ask/AskMyLifeService');
const { registerAskIpc, ASK_CHANNEL } = require('../src/main/askIpc');
const { AIError, ERROR_CODES } = require('../src/main/ai/errors');
const { createJob } = require('../src/main/ai/job');
const { tempDir, cleanup, makeQueue } = require('./support');

// Phase 12 的问答链路：问题 -> MemorySearchService.search -> Context -> chatWithOllama -> 回答 + 相关记忆。
// 检索与回查 SQLite 都是真的（真实 LanceDB 文件 + 真实 SQLite），只有「模型」用假 chat 函数注入。

const DIMENSION = 4;
const CONFIG = Object.freeze({
  ollamaHost: 'http://127.0.0.1:11434',
  model: 'qwen3-vl:8b',
  timeoutMs: 300000,
  numCtx: 16384,
});

function vector(a, b, c, d) {
  return [a, b, c, d];
}

// 一条完整的检索结果（字段与 MemorySearchService.search() 的 items 一致）。
function memoryItem(overrides = {}) {
  return {
    key: 'activity:1',
    sourceType: 'activity',
    sourceLabel: '20秒记录',
    sourceId: '1',
    distance: 0.1,
    time: '2026-09-18T20:10:01+08:00',
    day: '2026-09-18',
    endTime: null,
    timelineId: 'shot-1',
    title: '开发记忆搜索',
    content: '正在开发 Life Lens 的记忆搜索功能',
    project: 'Life Lens',
    category: 'coding',
    keywords: ['搜索'],
    keywordsLabel: '关键词',
    ...overrides,
  };
}

// 假检索：只记录调用参数，结果由测试给定。
function fakeSearch({ items = [], error = null, model = 'bge-m3' } = {}) {
  const search = {
    calls: [],
    async search(query, options) {
      search.calls.push([query, options]);
      if (error) throw error;
      return {
        query,
        limit: options?.limit ?? SEARCH_LIMIT,
        items,
        hits: items.length,
        returned: items.length,
        layerCounts: { activity: 0, block: 0, diary: 0 },
        missing: 0,
        invalid: 0,
        elapsedMs: 1,
        model,
      };
    },
  };
  return search;
}

// 假 chat：记录收到的请求（用来断言 format / numCtx / messages），返回给定的 content 或抛错。
function fakeChat({ content = '{"answer":"回答","confidence":"high"}', error = null } = {}) {
  const chat = async (request) => {
    chat.calls.push(request);
    if (error) throw error;
    return { content, model: request.model, analysisMs: 1 };
  };
  chat.calls = [];
  return chat;
}

function makeService({ items = [memoryItem()], searchError = null, chat = null, ...options } = {}) {
  const search = fakeSearch({ items, error: searchError });
  const chatFn = chat ?? fakeChat();
  const service = new AskMyLifeService({
    search,
    chat: chatFn,
    ...CONFIG,
    ...options,
  });
  return { service, search, chat: chatFn };
}

// 本地时间的期望值由测试自己算，避免断言依赖运行机器的时区。
function localDateTime(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localClock(value) {
  return localDateTime(value).slice(11);
}

// ---- 1. 空问题 ----

test('问答 1：空问题不触发检索、不触发模型，直接给出提示', async () => {
  const { service, search, chat } = makeService();

  for (const empty of ['', '   ', null, undefined]) {
    const result = await service.ask(empty);
    assert.equal(result.answer, '先输入一个问题，再开始提问。');
    assert.equal(result.confidence, 'low');
    assert.deepEqual(result.memories, []);
    assert.equal(result.question, '');
    assert.equal(result.elapsedMs, 0);
  }

  assert.deepEqual(search.calls, [], '空问题不查向量库');
  assert.deepEqual(chat.calls, [], '空问题不调模型');
});

// ---- 2. 正常问题：检索 + 模型请求 ----

test('问答 2：正常问题检索 limit=20，模型请求带上 Schema / numCtx / system prompt', async () => {
  const { service, search, chat } = makeService();

  const result = await service.ask('  最近一段时间我主要在做什么？  ');

  // 问题前后的空格裁掉，limit 固定 20（与搜索页同一口径）。
  assert.equal(SEARCH_LIMIT, 20);
  assert.deepEqual(search.calls, [['最近一段时间我主要在做什么？', { limit: 20 }]]);

  assert.equal(chat.calls.length, 1);
  const request = chat.calls[0];
  assert.equal(request.format, QA_SCHEMA);
  assert.equal(request.numCtx, CONFIG.numCtx, 'numCtx 必须显式传，否则会被 Ollama 静默截断');
  assert.equal(request.model, CONFIG.model);
  assert.equal(request.timeoutMs, CONFIG.timeoutMs);
  assert.equal(request.think, false);
  assert.equal(request.options.num_predict, 1024, '输出预算要给足');
  assert.deepEqual(request.messages.map((message) => message.role), ['system', 'user']);
  assert.equal(request.messages[0].content, QA_SYSTEM_PROMPT);
  assert.ok(request.messages[0].content.includes('你是 Life Lens 的本地个人记忆助手'));
  assert.ok(request.messages[1].content.includes('问题：最近一段时间我主要在做什么？'));
  assert.ok(request.messages[1].content.includes('以下是检索到的历史记忆'));

  assert.equal(result.question, '最近一段时间我主要在做什么？');
  assert.equal(result.memories.length, 1);
  assert.equal(result.model, CONFIG.model);
  assert.equal(typeof result.elapsedMs, 'number');
});

// ---- 3. 真实检索链路：LanceDB + SQLite -> Context ----

function vectorRow({ id, sourceId, vec, text, project = 'Life Lens', category = 'coding', date = '2026-09-18' }) {
  return {
    id,
    source_id: sourceId,
    text,
    vector: vec,
    captured_at: `${date}T20:10:01+08:00`,
    date,
    project,
    category,
    embedding_model: 'bge-m3',
    embedding_version: 'v1',
    created_at: '2026-09-18T20:10:01+08:00',
  };
}

// 查询向量由测试给定，写入 / 回查都是真实的（与 test/memorySearch.test.js 同一套做法）。
function queryProvider(queryVector) {
  const provider = {
    model: 'bge-m3',
    version: 'v1',
    dimension: DIMENSION,
    calls: [],
    async health() {
      return { online: true, modelAvailable: true };
    },
    async embedText(text) {
      const [first] = await provider.embedTexts([text]);
      return first;
    },
    async embedTexts(texts) {
      provider.calls.push(texts.slice());
      return texts.map(() => queryVector.slice());
    },
  };
  return provider;
}

const BLOCK_START = '2026-09-18T20:10:00+08:00';
const BLOCK_END = '2026-09-18T20:20:00+08:00';
const DIARY_DAY = '2026-09-17';

async function makeRealSearch(t) {
  const dir = await tempDir();
  const fixture = await makeQueue({ dir });
  const store = new LanceStore({ dir: path.join(dir, 'lancedb') });
  await store.open();
  cleanup(t, dir, [fixture.queue, { stop: () => store.close() }]);

  // SQLite 侧：一条 20 秒记录、一个 10 分钟区块、一篇日记。
  fixture.activities.createActivity({
    id: 'shot-ask',
    time: '2026-09-18T20:10:01+08:00',
    imagePath: 'C:/tmp/shot-ask.png',
    analysisStatus: 'COMPLETED',
    analysis: {
      activity: '开发记忆搜索',
      summary: '正在开发 Life Lens 的记忆搜索功能',
      category: 'coding',
      project: 'Life Lens',
      keywords: ['搜索', 'LanceDB'],
      confidence: 0.9,
    },
  });
  fixture.timeBlocks.insertBlockWithJob(
    { id: BLOCK_START, end: BLOCK_END, status: 'PENDING', activityCount: 3 },
    createJob({ type: 'TIMEBLOCK_SUMMARY', payload: { blockStart: BLOCK_START } }),
  );
  fixture.timeBlocks.updateSummary(BLOCK_START, {
    status: 'COMPLETED',
    summary: {
      project: 'Life Lens',
      category: 'coding',
      description: '这 10 分钟在写问答服务的 Context 拼装',
      software: ['VS Code'],
      todos: [],
    },
  });
  fixture.diaries.upsertDiaryWithJob(
    { day: DIARY_DAY, status: 'PENDING', blockCount: 5 },
    createJob({ type: 'DIARY_GENERATION', payload: { day: DIARY_DAY } }),
  );
  fixture.diaries.updateDiary(DIARY_DAY, {
    status: 'COMPLETED',
    diary: {
      summary: '这一天主要在写 Life Lens 的问答链路',
      mainEvents: ['实现 AskMyLifeService'],
      highlights: [],
      todos: [],
      suggestions: [],
      tips: [],
    },
  });

  const vectors = {
    activity: new MemoryVectorRepository({ store, tableName: SOURCE_LAYERS.activity.table }),
    block: new MemoryVectorRepository({ store, tableName: SOURCE_LAYERS.block.table }),
    diary: new MemoryVectorRepository({ store, tableName: SOURCE_LAYERS.diary.table }),
  };
  const activityId = fixture.activities.findIdByScreenshotId('shot-ask');
  await vectors.activity.upsert([
    vectorRow({
      id: `activity:${activityId}`,
      sourceId: String(activityId),
      vec: vector(1, 0, 0, 0),
      text: '项目：Life Lens 当前活动：开发记忆搜索',
    }),
  ]);
  await vectors.block.upsert([
    vectorRow({
      id: `block:${BLOCK_START}`,
      sourceId: BLOCK_START,
      vec: vector(0.9, 0.1, 0, 0),
      text: '项目：Life Lens 类型：coding',
    }),
  ]);
  await vectors.diary.upsert([
    vectorRow({
      id: `diary:${DIARY_DAY}`,
      sourceId: DIARY_DAY,
      vec: vector(0, 0, 1, 0),
      text: `日期：${DIARY_DAY}`,
      project: '',
      category: '',
      date: DIARY_DAY,
    }),
  ]);

  const search = new MemorySearchService({
    provider: queryProvider(vector(1, 0, 0, 0)),
    vectors,
    activities: fixture.activities,
    timeBlocks: fixture.timeBlocks,
    diaries: fixture.diaries,
    log: fixture.log,
  });
  return { search, fixture, activityId };
}

test('问答 3：真实检索链路把记忆字段拼进 Context，相关记忆原样返回', async (t) => {
  const { search } = await makeRealSearch(t);
  const chat = fakeChat();
  const service = new AskMyLifeService({ search, chat, ...CONFIG });

  const result = await service.ask('我最近在做什么？');
  const prompt = chat.calls[0].messages[1].content;

  // 三条记忆都进了 Context，且各自带上来源、时间、项目 / 分类与正文。
  assert.ok(prompt.includes(`[20秒记录] ${localDateTime('2026-09-18T20:10:01+08:00')}`));
  assert.ok(prompt.includes('项目：Life Lens ｜ 分类：coding'));
  assert.ok(prompt.includes('正在开发 Life Lens 的记忆搜索功能'));
  assert.ok(prompt.includes(`[10分钟汇总] ${localDateTime(BLOCK_START)}–${localClock(BLOCK_END)}`));
  assert.ok(prompt.includes('这 10 分钟在写问答服务的 Context 拼装'));
  assert.ok(prompt.includes(`[日记] ${DIARY_DAY}`), '日记只显示日期');
  assert.ok(prompt.includes('这一天主要在写 Life Lens 的问答链路'));

  // 相关记忆 = search() 的 items 原样返回（含跳转需要的 timelineId）。
  assert.deepEqual(result.memories.map((item) => item.sourceType), ['activity', 'block', 'diary']);
  // Timeline 的卡片 id 是截图 id，不是向量行的 source_id。
  assert.equal(result.memories[0].timelineId, 'shot-ask');
  assert.equal(result.memories[0].day, '2026-09-18');
  assert.equal(result.memories[1].endTime, BLOCK_END);
});

// ---- 4. Context 的截断与总长上限 ----

test('问答 4：单条 content 截断到 300 字，Context 总长不超过 8000 字', () => {
  const long = '很'.repeat(1000);
  const items = Array.from({ length: 40 }, (_, index) => memoryItem({
    key: `activity:${index}`,
    sourceId: String(index),
    content: long,
  }));

  const context = buildContext(items);
  assert.ok(context.length <= CONTEXT_MAX_CHARS, `Context 长度 ${context.length} 不应超过上限`);
  assert.equal(context.includes('很'.repeat(301)), false, '单条 content 截断到 300 字');
  assert.ok(context.split('很'.repeat(300)).length - 1 >= 1, '截断后的正文仍然在 Context 里');

  const blocks = context.split('\n\n');
  assert.ok(blocks.length < items.length, '超总长上限时按相关度顺序保留前面的');
  assert.ok(blocks[0].startsWith('[20秒记录] '), '最相关的一条在最前');

  // content 为空的条目（没正文可给模型看）不进 Context。
  assert.equal(buildContext([memoryItem({ content: '   ' })]), '');
  assert.equal(buildContext([]), '');

  // 时间格式化：日记只给日期，区块给起止区间。
  assert.equal(
    formatMemoryTime(memoryItem({ sourceType: 'diary', day: '2026-09-17', time: '2026-09-17' })),
    '2026-09-17',
  );
  assert.equal(
    formatMemoryTime(memoryItem({ sourceType: 'block', time: BLOCK_START, endTime: BLOCK_END })),
    `${localDateTime(BLOCK_START)}–${localClock(BLOCK_END)}`,
  );
});

// ---- 5. 回答解析 ----

test('问答 5：解析 { answer, confidence } 并与相关记忆一起返回', async () => {
  const chat = fakeChat({ content: '{"answer":"你最近在写记忆搜索，主要在 Life Lens 项目上。","confidence":"medium"}' });
  const { service } = makeService({ chat });

  const result = await service.ask('我最近在做什么？');
  assert.equal(result.answer, '你最近在写记忆搜索，主要在 Life Lens 项目上。');
  assert.equal(result.confidence, 'medium');
  assert.deepEqual(CONFIDENCE_LEVELS, ['high', 'medium', 'low']);
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].key, 'activity:1');
  assert.equal(result.memories[0].content, '正在开发 Life Lens 的记忆搜索功能');

  // 模型把 JSON 裹进 Markdown 代码块时同样要能解析（沿用 Phase 5 的容错）。
  const fenced = makeService({ chat: fakeChat({ content: '```json\n{"answer":"可以。","confidence":"low"}\n```' }) });
  const second = await fenced.service.ask('我最近在做什么？');
  assert.equal(second.answer, '可以。');
  assert.equal(second.confidence, 'low');
});

// ---- 6. 空结果短路 ----

test('问答 6：没有相关记忆时不调模型，返回固定文案', async () => {
  const { service, search, chat } = makeService({ items: [] });

  const result = await service.ask('我上周在做什么？');
  assert.equal(result.answer, '没有找到足够相关的历史记录，暂时无法准确回答这个问题。');
  assert.equal(result.answer, NO_MEMORY_ANSWER);
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.memories, []);
  assert.deepEqual(search.calls, [['我上周在做什么？', { limit: 20 }]], '检索照做');
  assert.deepEqual(chat.calls, [], '没有依据就不打扰模型');

  // 检索到记录、但一条正文都没有：同样不给模型硬编的机会。
  const blank = makeService({
    items: [memoryItem({ content: '' }), memoryItem({ key: 'block:1', sourceType: 'block', content: null })],
  });
  const blankResult = await blank.service.ask('我上周在做什么？');
  assert.equal(blankResult.answer, NO_MEMORY_ANSWER);
  assert.equal(blankResult.memories.length, 2, '相关记忆仍然原样返回，界面自己决定怎么显示');
  assert.deepEqual(blank.chat.calls, []);
});

// ---- 7. 检索失败 ----

test('问答 7：检索不可用转成「暂时无法搜索历史记忆…」', async () => {
  for (const code of ['EMBEDDING_UNAVAILABLE', 'VECTOR_UNAVAILABLE', 'INDEX_UNAVAILABLE']) {
    const cause = new MemorySearchError(`搜索失败：${code}`, { code });
    const { service, chat } = makeService({ searchError: cause });

    await assert.rejects(
      () => service.ask('我最近在做什么？'),
      (error) => {
        assert.ok(error instanceof AskMyLifeError);
        assert.equal(error.code, 'SEARCH_UNAVAILABLE');
        assert.ok(error.message.startsWith(SEARCH_ERROR_PREFIX), `实际：${error.message}`);
        assert.ok(error.message.includes(code), '把可读原因带给界面');
        assert.equal(error.cause, cause);
        return true;
      },
    );
    assert.deepEqual(chat.calls, [], '检索失败时不调模型');
  }

  // 检索服务根本没装配（Main 装配失败时是 null）。
  const bare = new AskMyLifeService({ search: null, chat: fakeChat(), ...CONFIG });
  await assert.rejects(() => bare.ask('我最近在做什么？'), new RegExp(SEARCH_ERROR_PREFIX));
});

// ---- 8. 生成失败 ----

test('问答 8：模型不可用 / 超时转成「已经找到相关记忆，但当前无法生成回答…」', async () => {
  const failures = [
    new AIError(ERROR_CODES.OLLAMA_UNAVAILABLE, '无法连接 Ollama (http://127.0.0.1:11434/api/chat)'),
    new AIError(ERROR_CODES.AI_TIMEOUT, 'AI 请求超时（300000ms）'),
    new Error('模型内部错误'),
  ];

  for (const failure of failures) {
    const { service } = makeService({ chat: fakeChat({ error: failure }) });
    await assert.rejects(
      () => service.ask('我最近在做什么？'),
      (error) => {
        assert.ok(error instanceof AskMyLifeError);
        assert.equal(error.code, 'ANSWER_UNAVAILABLE');
        assert.ok(error.message.startsWith(ANSWER_ERROR_PREFIX), `实际：${error.message}`);
        assert.ok(error.message.includes(failure.message), '把可读原因带给界面');
        return true;
      },
    );
  }

  // 没有注入 chat 函数（装配错误）也不能让页面拿到 undefined 之类的怪错。
  const noChat = new AskMyLifeService({ search: fakeSearch({ items: [memoryItem()] }), chat: null, ...CONFIG });
  await assert.rejects(() => noChat.ask('我最近在做什么？'), new RegExp(ANSWER_ERROR_PREFIX));
});

// ---- 9. 输出不合法 ----

test('问答 9：模型返回非法 JSON / 空回答 / 非法 confidence 都按生成失败处理', async () => {
  const contents = [
    '这不是 JSON',
    '',
    '{"answer":"   ","confidence":"high"}',
    '{"answer":"有回答","confidence":"very-high"}',
    '{"answer":"有回答"}',
    '{"confidence":"high"}',
  ];

  for (const content of contents) {
    const { service } = makeService({ chat: fakeChat({ content }) });
    await assert.rejects(
      () => service.ask('我最近在做什么？'),
      (error) => {
        assert.ok(error instanceof AskMyLifeError);
        assert.equal(error.code, 'ANSWER_UNAVAILABLE');
        assert.ok(error.message.startsWith(ANSWER_ERROR_PREFIX));
        return true;
      },
      `content=${JSON.stringify(content)} 应该按生成失败处理`,
    );
  }
});

// ---- 10. IPC -> Main -> MemorySearchService -> 模型 ----

test('问答 10：IPC 通道把问题交给服务，未装配时给出可读错误', async () => {
  const { service, search, chat } = makeService();

  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  registerAskIpc({ ipcMain, getAsk: () => service });
  assert.ok(handlers.has(ASK_CHANNEL));
  assert.equal(ASK_CHANNEL, 'lifelens:ask');

  const handler = handlers.get(ASK_CHANNEL);
  const result = await handler(null, { question: '我最近在做什么？' });
  assert.equal(result.answer, '回答');
  assert.equal(result.memories.length, 1);
  assert.deepEqual(search.calls, [['我最近在做什么？', { limit: 20 }]]);
  assert.equal(chat.calls.length, 1);

  // 字符串载荷也接受。
  const textOnly = await handler(null, '我最近在做什么？');
  assert.equal(textOnly.question, '我最近在做什么？');

  // 检索装配失败时 getAsk() 为 null：抛可读错误，而不是 undefined。
  registerAskIpc({ ipcMain, getAsk: () => null });
  await assert.rejects(
    () => handlers.get(ASK_CHANNEL)(null, { question: '我最近在做什么？' }),
    /问答不可用/,
  );
});
