'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { LanceStore } = require('../src/main/embedding/lanceStore');
const { MemoryVectorRepository } = require('../src/main/embedding/MemoryVectorRepository');
const {
  MemorySearchService,
  MemorySearchError,
  resolveSource,
  sourceIdOfRowId,
  SOURCE_LAYERS,
} = require('../src/main/search/MemorySearchService');
const { registerSearchIpc, MEMORY_SEARCH_CHANNEL } = require('../src/main/searchIpc');
const { createJob } = require('../src/main/ai/job');
const { tempDir, cleanup, makeQueue } = require('./support');

// Phase 11 的检索链路：查询文本 -> embedding -> 三张向量表 -> 合并排序 -> 回查 SQLite。
// 三张表都是真实的 LanceDB 文件，SQLite 也是真实的库：只有「查询向量」由测试给定。

const DIMENSION = 4;

function vector(a, b, c, d) {
  return [a, b, c, d];
}

// 只控制「查询向量」的假 Provider：把文本原样记下来，返回测试指定的向量。
function queryProvider(queryVector) {
  const provider = {
    model: 'bge-m3',
    version: 'v1',
    dimension: DIMENSION,
    calls: [],
    error: null,
    async health() {
      return { online: true, modelAvailable: true };
    },
    // 与真实的 LocalEmbeddingProvider 同形状：单条入口委托给批量入口。
    async embedText(text) {
      const [first] = await provider.embedTexts([text]);
      return first;
    },
    async embedTexts(texts) {
      provider.calls.push(texts.slice());
      if (provider.error) throw provider.error;
      return texts.map(() => queryVector.slice());
    },
  };
  return provider;
}

function vectorRow({ id, sourceId, vec, text = '文本', project = 'Life Lens', category = 'coding', date = '2026-09-17' }) {
  return {
    id,
    source_id: sourceId,
    text,
    vector: vec,
    captured_at: `${date}T13:00:01+08:00`,
    date,
    project,
    category,
    embedding_model: 'bge-m3',
    embedding_version: 'v1',
    created_at: '2026-09-17T13:00:01+08:00',
  };
}

const SQLITE_BLOCK_START = '2026-09-17T13:00:00+08:00';
const SQLITE_BLOCK_END = '2026-09-17T13:10:00+08:00';
const SQLITE_DAY = '2026-09-17';

// SQLite 侧的数据：两条 20 秒记录、一个 10 分钟区块、一篇日记（都是「已完成」的真实形状）。
function seedMemory(fixture) {
  fixture.activities.createActivity({
    id: 'shot-sqlite',
    time: '2026-09-17T13:00:01+08:00',
    imagePath: 'C:/tmp/shot-sqlite.png',
    analysisStatus: 'COMPLETED',
    analysis: {
      activity: '开发 SQLite 数据层',
      summary: '写 ActivityRepository 与事务封装',
      category: 'coding',
      project: 'Life Lens',
      keywords: ['SQLite', '事务'],
      confidence: 0.9,
    },
  });
  fixture.activities.createActivity({
    id: 'shot-walk',
    time: '2026-09-17T14:20:01+08:00',
    imagePath: 'C:/tmp/shot-walk.png',
    analysisStatus: 'COMPLETED',
    analysis: {
      activity: '在公园散步',
      summary: '午休时间出去走了一圈',
      category: 'life',
      project: null,
      keywords: [],
      confidence: 0.8,
    },
  });

  fixture.timeBlocks.insertBlockWithJob(
    { id: SQLITE_BLOCK_START, end: SQLITE_BLOCK_END, status: 'PENDING', activityCount: 3 },
    createJob({ type: 'TIMEBLOCK_SUMMARY', payload: { blockStart: SQLITE_BLOCK_START } }),
  );
  fixture.timeBlocks.updateSummary(SQLITE_BLOCK_START, {
    status: 'COMPLETED',
    summary: {
      project: 'Life Lens',
      category: 'coding',
      description: '这 10 分钟在写 SQLite 迁移与记忆索引',
      software: ['VS Code', 'Node'],
      todos: ['补检索测试'],
    },
  });

  fixture.diaries.upsertDiaryWithJob(
    { day: SQLITE_DAY, status: 'PENDING', blockCount: 5 },
    createJob({ type: 'DIARY_GENERATION', payload: { day: SQLITE_DAY } }),
  );
  fixture.diaries.updateDiary(SQLITE_DAY, {
    status: 'COMPLETED',
    diary: {
      summary: '这一天主要在写 Life Lens 的记忆检索链路',
      mainEvents: ['完成语义检索', '跑通端到端冒烟'],
      highlights: [],
      todos: [],
      suggestions: [],
      tips: [],
    },
  });

  return {
    sqliteActivityId: fixture.activities.findIdByScreenshotId('shot-sqlite'),
    walkActivityId: fixture.activities.findIdByScreenshotId('shot-walk'),
  };
}

async function makeSearchFixture(t, { indexThreshold } = {}) {
  const dir = await tempDir();
  const fixture = await makeQueue({ dir });
  const store = new LanceStore({ dir: path.join(dir, 'lancedb') });
  await store.open();
  cleanup(t, dir, [fixture.queue, { stop: () => store.close() }]);

  const vectors = {
    activity: new MemoryVectorRepository({ store, tableName: SOURCE_LAYERS.activity.table, indexThreshold }),
    block: new MemoryVectorRepository({ store, tableName: SOURCE_LAYERS.block.table, indexThreshold }),
    diary: new MemoryVectorRepository({ store, tableName: SOURCE_LAYERS.diary.table, indexThreshold }),
  };
  const ids = seedMemory(fixture);

  // 三张表各一条命中，距离各不相同：activity 最近、block 次之、diary 再次、walk 最远。
  await vectors.activity.upsert([
    vectorRow({
      id: `activity:${ids.sqliteActivityId}`,
      sourceId: String(ids.sqliteActivityId),
      vec: vector(1, 0, 0, 0),
      text: '项目：Life Lens 当前活动：开发 SQLite 数据层',
    }),
    vectorRow({
      id: `activity:${ids.walkActivityId}`,
      sourceId: String(ids.walkActivityId),
      vec: vector(0, 1, 0, 0),
      text: '当前活动：在公园散步',
      project: '',
      category: 'life',
    }),
  ]);
  await vectors.block.upsert([
    vectorRow({
      id: `block:${SQLITE_BLOCK_START}`,
      sourceId: SQLITE_BLOCK_START,
      vec: vector(0.9, 0.1, 0, 0),
      text: '项目：Life Lens 类型：coding',
    }),
  ]);
  await vectors.diary.upsert([
    vectorRow({
      id: `diary:${SQLITE_DAY}`,
      sourceId: SQLITE_DAY,
      vec: vector(0, 0, 1, 0),
      text: `日期：${SQLITE_DAY}`,
      project: '',
      category: '',
    }),
  ]);

  return { dir, fixture, store, vectors, ids };
}

function makeService(rig, { queryVector = vector(1, 0, 0, 0), ...options } = {}) {
  const provider = queryProvider(queryVector);
  const service = new MemorySearchService({
    provider,
    vectors: rig.vectors,
    activities: rig.fixture.activities,
    timeBlocks: rig.fixture.timeBlocks,
    diaries: rig.fixture.diaries,
    log: rig.fixture.log,
    ...options,
  });
  return { service, provider };
}

// ---- 1. 自然语言 -> Embedding -> Vector Search ----

test('搜索 1：查询文本先过 embedding，再用同一个向量在三张表里检索', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service, provider } = makeService(rig);

  const result = await service.search('我最近什么时候研究过 SQLite？');

  // 查询文本原样交给 Provider（换模型 / 改 Prompt 都在 Provider 里，服务层不碰）。
  assert.deepEqual(provider.calls, [['我最近什么时候研究过 SQLite？']]);
  // 距离最近的 activity 排在第一条。
  assert.equal(result.items[0].sourceType, 'activity');
  assert.equal(result.items[0].sourceId, String(rig.ids.sqliteActivityId));
  assert.equal(result.model, 'bge-m3');
  assert.equal(result.query, '我最近什么时候研究过 SQLite？');
});

// ---- 2. 三表合并排序 ----

test('搜索 2：三张表的结果按 _distance 合并排序，相关度最高的在前', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service } = makeService(rig);

  const result = await service.search('SQLite', { limit: 10 });

  assert.deepEqual(result.layerCounts, { activity: 2, block: 1, diary: 1 });
  assert.deepEqual(
    result.items.map((item) => item.sourceType),
    ['activity', 'block', 'activity', 'diary'],
    '距离 0 < 0.14 < 1.41（activity 与 diary 同距时按层顺序）',
  );

  // 距离被带出来了，并且是递增的。
  const distances = result.items.map((item) => item.distance);
  for (let index = 1; index < distances.length; index += 1) {
    assert.ok(distances[index] >= distances[index - 1], '按 _distance 升序');
  }

  // 换一个查询向量：顺序跟着相关度变，而不是固定按表顺序返回。
  const { service: diaryFirst } = makeService(rig, { queryVector: vector(0, 0, 1, 0) });
  const second = await diaryFirst.search('那天整体在做什么', { limit: 10 });
  assert.equal(second.items[0].sourceType, 'diary');
});

// ---- 3. 来源类型解析 ----

test('搜索 3：表名与行 ID 前缀解析出来源类型与 source_id', () => {
  assert.equal(SOURCE_LAYERS.activity.table, 'activity_vectors');
  assert.equal(SOURCE_LAYERS.block.table, 'block_vectors');
  assert.equal(SOURCE_LAYERS.diary.table, 'diary_vectors');

  assert.deepEqual(
    resolveSource('activity_vectors', { id: 'activity:12', source_id: '12' }),
    { sourceType: 'activity', sourceLabel: '20秒记录', sourceId: '12' },
  );
  assert.deepEqual(
    resolveSource('block_vectors', { id: `block:${SQLITE_BLOCK_START}`, source_id: SQLITE_BLOCK_START }),
    { sourceType: 'block', sourceLabel: '10分钟汇总', sourceId: SQLITE_BLOCK_START },
  );
  assert.deepEqual(
    resolveSource('diary_vectors', { id: `diary:${SQLITE_DAY}`, source_id: SQLITE_DAY }),
    { sourceType: 'diary', sourceLabel: '日记', sourceId: SQLITE_DAY },
  );

  // source_id 缺失（老数据 / 手工写入）时退回按行 ID 前缀解析。
  assert.equal(resolveSource('diary_vectors', { id: `diary:${SQLITE_DAY}` }).sourceId, SQLITE_DAY);
  // 前缀对不上、表名不认识、id 为空：都返回 null（这一条跳过），而不是抛错。
  assert.equal(resolveSource('diary_vectors', { id: 'block:2026-09-17', source_id: '' }), null);
  assert.equal(resolveSource('memory_vectors', { id: 'activity:1', source_id: '1' }), null);
  assert.equal(resolveSource('activity_vectors', { id: '', source_id: '' }), null);
  assert.equal(sourceIdOfRowId('activity:', 'activity'), null);
});

// ---- 4 / 5 / 6. 回查 SQLite ----

test('搜索 4：20 秒记录的结果回 SQLite 取到完整活动', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service } = makeService(rig);

  const item = (await service.search('SQLite', { limit: 10 })).items[0];

  assert.equal(item.time, '2026-09-17T13:00:01+08:00');
  assert.equal(item.day, '2026-09-17');
  assert.equal(item.title, '开发 SQLite 数据层');
  assert.equal(item.content, '写 ActivityRepository 与事务封装');
  assert.equal(item.project, 'Life Lens');
  assert.equal(item.category, 'coding');
  assert.deepEqual(item.keywords, ['SQLite', '事务']);
  assert.equal(item.keywordsLabel, '关键词');
  assert.equal(item.timelineId, 'shot-sqlite', 'Timeline 的卡片 id 是 screenshot_id');
  assert.equal(item.sourceLabel, '20秒记录');
});

test('搜索 5：10 分钟汇总的结果回 SQLite 取到区块', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service } = makeService(rig);

  const item = (await service.search('SQLite', { limit: 10 })).items
    .find((hit) => hit.sourceType === 'block');

  assert.equal(item.sourceId, SQLITE_BLOCK_START);
  assert.equal(item.time, SQLITE_BLOCK_START);
  assert.equal(item.endTime, SQLITE_BLOCK_END, '区块的定位窗口是 [start, end)');
  assert.equal(item.content, '这 10 分钟在写 SQLite 迁移与记忆索引');
  assert.equal(item.project, 'Life Lens');
  assert.equal(item.category, 'coding');
  assert.deepEqual(item.keywords, ['VS Code', 'Node']);
  assert.equal(item.keywordsLabel, '软件');
  assert.equal(item.title, '');
});

test('搜索 6：日记的结果回 SQLite 取到那一天', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service } = makeService(rig);

  const item = (await service.search('SQLite', { limit: 10 })).items
    .find((hit) => hit.sourceType === 'diary');

  assert.equal(item.sourceId, SQLITE_DAY);
  assert.equal(item.day, SQLITE_DAY);
  assert.equal(item.content, '这一天主要在写 Life Lens 的记忆检索链路');
  assert.deepEqual(item.keywords, ['完成语义检索', '跑通端到端冒烟']);
  assert.equal(item.keywordsLabel, '主要事项');
  assert.equal(item.project, null, '日记没有项目与分类');
  assert.equal(item.timelineId, null);
});

// ---- 7. 空结果 ----

test('搜索 7：空查询不打扰 embedding，没有数据时返回空结果', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service, provider } = makeService(rig);

  const blank = await service.search('   ');
  assert.equal(blank.items.length, 0);
  assert.equal(blank.query, '');
  assert.deepEqual(provider.calls, [], '空查询不应该调用 embedding');

  // 三张表都还没有数据（没有表文件）：返回空结果，不是错误。
  const emptyVectors = {
    activity: new MemoryVectorRepository({ store: rig.store, tableName: 'empty_activity_vectors' }),
    block: new MemoryVectorRepository({ store: rig.store, tableName: 'empty_block_vectors' }),
    diary: new MemoryVectorRepository({ store: rig.store, tableName: 'empty_diary_vectors' }),
  };
  const emptyService = new MemorySearchService({
    provider: queryProvider(vector(1, 0, 0, 0)),
    vectors: emptyVectors,
    activities: rig.fixture.activities,
    timeBlocks: rig.fixture.timeBlocks,
    diaries: rig.fixture.diaries,
    log: rig.fixture.log,
  });
  const blank2 = await emptyService.search('随便搜点什么');
  assert.equal(blank2.items.length, 0);
  assert.equal(blank2.hits, 0);
  assert.deepEqual(blank2.layerCounts, { activity: 0, block: 0, diary: 0 });
});

// ---- 8. 异常 ----

test('搜索 8：embedding 失败 / 单层失败 / 三层全失败 / 未装配都有明确语义', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service, provider } = makeService(rig);

  // 模型不可用：整次搜索失败，错误码可用于界面提示。
  provider.error = new Error('Ollama 连不上');
  await assert.rejects(
    () => service.search('SQLite'),
    (error) => error instanceof MemorySearchError && error.code === 'EMBEDDING_UNAVAILABLE'
      && error.message.includes('Ollama 连不上'),
  );
  provider.error = null;

  // 只有一层坏掉：其余两层照常返回，失败记进事件日志。
  const broken = new MemorySearchService({
    provider: queryProvider(vector(1, 0, 0, 0)),
    vectors: {
      activity: rig.vectors.activity,
      block: { search: async () => { throw new Error('向量库这一层坏了'); } },
      diary: rig.vectors.diary,
    },
    activities: rig.fixture.activities,
    timeBlocks: rig.fixture.timeBlocks,
    diaries: rig.fixture.diaries,
    log: rig.fixture.log,
  });
  const partial = await broken.search('SQLite', { limit: 10 });
  assert.deepEqual(partial.items.map((item) => item.sourceType), ['activity', 'activity', 'diary']);
  assert.ok(
    rig.fixture.log.list(10).some((entry) => entry.event === 'MEMORY_SEARCH_ERROR'
      && entry.message.includes('block')),
    '单层失败要留痕',
  );

  // 三张表都失败：整次搜索失败，错误码是向量库不可用。
  const deadVectors = { search: async () => { throw new Error('LanceDB 打不开'); } };
  const dead = new MemorySearchService({
    provider: queryProvider(vector(1, 0, 0, 0)),
    vectors: { activity: deadVectors, block: deadVectors, diary: deadVectors },
    activities: rig.fixture.activities,
    log: rig.fixture.log,
  });
  await assert.rejects(
    () => dead.search('SQLite'),
    (error) => error instanceof MemorySearchError && error.code === 'VECTOR_UNAVAILABLE',
  );

  // 一层都没装配（不是「没有结果」而是「不可用」）。
  const unassembled = new MemorySearchService({ provider: queryProvider(vector(1, 0, 0, 0)), vectors: {} });
  await assert.rejects(
    () => unassembled.search('SQLite'),
    (error) => error instanceof MemorySearchError && error.code === 'INDEX_UNAVAILABLE',
  );
});

// ---- 9. 数量限制 ----

test('搜索 9：每张表最多取 limit 条，合并后截取前 limit 条', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service } = makeService(rig);

  const limited = await service.search('SQLite', { limit: 2 });
  assert.equal(limited.layerCounts.activity, 2, 'activity 表最多查 limit 条');
  assert.equal(limited.hits, 2);
  assert.equal(limited.items.length, 2);
  assert.deepEqual(limited.items.map((item) => item.sourceType), ['activity', 'block']);

  const defaultLimit = await service.search('SQLite');
  assert.equal(defaultLimit.limit, 20, '默认 20 条');

  const tooBig = await service.search('SQLite', { limit: 1000 });
  assert.equal(tooBig.limit, 50, '上限 50：不要一次把历史数据全拉到界面');
});

// ---- 10. IPC -> Main -> LanceDB -> SQLite ----

test('搜索 10：IPC 通道把请求交给服务，未装配时给出可读错误', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service } = makeService(rig);

  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  registerSearchIpc({ ipcMain, getSearch: () => service });
  assert.ok(handlers.has(MEMORY_SEARCH_CHANNEL));

  const handler = handlers.get(MEMORY_SEARCH_CHANNEL);
  const result = await handler(null, { query: 'SQLite', limit: 5 });
  assert.equal(result.items[0].sourceType, 'activity');
  assert.equal(result.items[0].timelineId, 'shot-sqlite');
  assert.equal(result.query, 'SQLite');

  // 字符串载荷也接受（Renderer 只传一个关键词时不必包成对象）。
  const textOnly = await handler(null, 'SQLite');
  assert.equal(textOnly.returned > 0, true);
  assert.equal(textOnly.limit, 20);

  // embedding / LanceDB 装配失败时 getSearch() 为 null：抛可读错误，而不是 undefined。
  registerSearchIpc({ ipcMain, getSearch: () => null });
  await assert.rejects(
    () => handlers.get(MEMORY_SEARCH_CHANNEL)(null, { query: 'SQLite' }),
    /记忆搜索不可用/,
  );
});

// ---- 11. 单条异常隔离 ----

test('搜索 11：SQLite 里已删除的记录与坏行只跳过自己，不影响其它结果', async (t) => {
  const rig = await makeSearchFixture(t);
  const { service } = makeService(rig);

  // 向量还在、SQLite 记录已经没了（search 与删除不同步），以及一条前缀对不上的坏行。
  await rig.vectors.activity.upsert([
    vectorRow({ id: 'activity:999999', sourceId: '999999', vec: vector(0.95, 0.05, 0, 0) }),
    vectorRow({ id: 'orphan:1', sourceId: '', vec: vector(0.94, 0.06, 0, 0) }),
  ]);

  const result = await service.search('SQLite', { limit: 10 });

  assert.equal(result.missing, 1, 'source_id 在 SQLite 里不存在的记录被跳过');
  assert.equal(result.invalid, 1, '行 ID 前缀解析不出 source_id 的记录被跳过');
  // 合并进来的每一条要么出结果、要么被记为 missing，不会凭空消失；invalid 是压根没进合并的坏行。
  assert.equal(result.items.length + result.missing, result.hits);
  // 正常的那几条照常返回，页面不会因为一条坏数据白屏。
  assert.deepEqual(result.items.map((item) => item.sourceType), ['activity', 'block', 'activity', 'diary']);
});
