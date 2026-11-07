'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildActivityText } = require('../src/main/embedding/textBuilder/activityText');
const { buildBlockText } = require('../src/main/embedding/textBuilder/blockText');
const { buildDiaryText } = require('../src/main/embedding/textBuilder/diaryText');
const { LocalEmbeddingProvider } = require('../src/main/embedding/localProvider');
const { EmbeddingService } = require('../src/main/embedding/EmbeddingService');
const { EmbeddingSourceRepository, EMBEDDING_STATUS } = require('../src/main/embedding/EmbeddingSourceRepository');
const { createBlock } = require('../src/main/summary/timeBlock');
const { tempDir, cleanup, makeQueue, fakeEmbeddingProvider } = require('./support');

function at(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0);
}

// ---- 文本构造：嵌入的是构造过的语义文本，不是 JSON ----

test('文本构造 1：Activity 文本按「项目 / 活动 / 摘要 / 关键词」拼接', () => {
  const text = buildActivityText({
    project: 'Life Lens',
    activity: '开发 SQLite 数据层',
    summary: '正在实现 ActivityRepository 与事务封装。',
    keywords: ['SQLite', 'Repository'],
  });
  assert.equal(text, [
    '项目：Life Lens',
    '当前活动：开发 SQLite 数据层',
    '正在实现 ActivityRepository 与事务封装。',
    '关键词：SQLite、Repository',
  ].join('\n'));
});

test('文本构造 2：空字段不产生空行，全部为空时返回空串', () => {
  assert.equal(
    buildActivityText({ project: '   ', activity: '写代码', summary: null, keywords: [] }),
    '当前活动：写代码',
  );
  assert.equal(buildActivityText({}), '');
  assert.equal(buildActivityText(), '');
});

test('文本构造 3：Block 文本包含类型 / 软件 / 待办', () => {
  const text = buildBlockText({
    project: 'Life Lens',
    category: '工作',
    description: '这 10 分钟主要在开发 SQLite 数据层。',
    software: ['VS Code', 'Terminal'],
    todos: ['补充恢复测试', '更新文档'],
  });
  assert.equal(text, [
    '项目：Life Lens',
    '类型：工作',
    '这 10 分钟主要在开发 SQLite 数据层。',
    '软件：VS Code、Terminal',
    '待办：补充恢复测试；更新文档',
  ].join('\n'));
});

test('文本构造 4：Diary 文本以日期开头，主要事项用分号连接', () => {
  const text = buildDiaryText({
    day: '2026-09-17',
    summary: '今天主要围绕 Life Lens 项目开发。',
    mainEvents: ['Timeline 搜索', 'Dashboard'],
  });
  assert.equal(text, [
    '日期：2026-09-17',
    '今天主要围绕 Life Lens 项目开发。',
    '主要事项：Timeline 搜索；Dashboard',
  ].join('\n'));
  // day 是业务主键，永远存在：只有日期的日记也能嵌入。
  assert.equal(buildDiaryText({ day: '2026-09-17' }), '日期：2026-09-17');
});

// ---- 测试夹具：假 Provider + 内存向量库 + 真实的 SQLite 仓储 ----

// 内存版向量库：只验证服务的编排与状态流转，LanceDB 的真实读写在 memoryVectorRepository.test.js 里验证。
function fakeVectorRepository() {
  const repository = {
    rows: new Map(),
    failUpsert: false,
    upserts: 0,
    async upsert(list) {
      if (repository.failUpsert) throw new Error('向量库写入失败');
      repository.upserts += 1;
      for (const row of list) repository.rows.set(row.id, row);
      return list.length;
    },
    async deleteBySource(ids) {
      for (const id of ids) repository.rows.delete(id);
      return ids.length;
    },
    async findBySource(id) {
      return repository.rows.get(id) ?? null;
    },
    async count() {
      return repository.rows.size;
    },
    async ensureIndex() {
      return { created: false, reason: 'no-table', count: repository.rows.size };
    },
  };
  return repository;
}

async function makeEmbeddingFixture({ dir, provider = fakeEmbeddingProvider(), serviceOptions = {} } = {}) {
  const base = await makeQueue({ dir });
  const sources = {
    activity: new EmbeddingSourceRepository({ db: base.db, layer: 'activity', log: base.log }),
    block: new EmbeddingSourceRepository({ db: base.db, layer: 'block', log: base.log }),
    diary: new EmbeddingSourceRepository({ db: base.db, layer: 'diary', log: base.log }),
  };
  const vectors = {
    activity: fakeVectorRepository(),
    block: fakeVectorRepository(),
    diary: fakeVectorRepository(),
  };
  const service = new EmbeddingService({
    provider,
    sources,
    vectors,
    log: base.log,
    batchSize: 10,
    scanIntervalMs: 600000,
    ...serviceOptions,
  });
  return { ...base, sources, vectors, service, provider };
}

// ---- LocalEmbeddingProvider：只验证请求形状与响应校验，不依赖真实 Ollama ----

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

// 用假的 fetch 顶替 Ollama，用完必须还原（同一个测试文件里的用例串行执行）。
async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('Provider 1：批量调用 /api/embed，按同序返回向量并学到维度', async () => {
  const seen = [];
  await withFetch(async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return jsonResponse({ embeddings: [[1, 2, 3], [4, 5, 6]] });
  }, async () => {
    const provider = new LocalEmbeddingProvider({ ollamaHost: 'http://127.0.0.1:11434/', model: 'bge-m3' });
    assert.equal(provider.dimension, 0);

    const vectors = await provider.embedTexts(['第一段', '第二段']);
    assert.deepEqual(vectors, [[1, 2, 3], [4, 5, 6]]);
    assert.equal(provider.dimension, 3);
    assert.equal(provider.maxBatchSize, 64);
    assert.equal(seen[0].url, 'http://127.0.0.1:11434/api/embed');
    assert.equal(seen[0].body.model, 'bge-m3');
    assert.deepEqual(seen[0].body.input, ['第一段', '第二段']);

    // 空输入不发请求。
    assert.deepEqual(await provider.embedTexts([]), []);
    assert.equal(seen.length, 1);
  });
});

test('Provider 2：超过 maxBatchSize 时在 Provider 内部切块，顺序保持不变', async () => {
  const batches = [];
  await withFetch(async (_url, init) => {
    const inputs = JSON.parse(init.body).input;
    batches.push(inputs);
    return jsonResponse({ embeddings: inputs.map(() => [1, 0, 0, 0]) });
  }, async () => {
    const provider = new LocalEmbeddingProvider({
      ollamaHost: 'http://127.0.0.1:11434',
      model: 'bge-m3',
      maxBatchSize: 2,
    });
    const vectors = await provider.embedTexts(['a', 'b', 'c', 'd', 'e']);
    assert.equal(vectors.length, 5);
    assert.deepEqual(batches, [['a', 'b'], ['c', 'd'], ['e']]);
  });
});

test('Provider 3：维度与已建立的表不一致时抛永久性错误', async () => {
  await withFetch(async () => jsonResponse({ embeddings: [[1, 2]] }), async () => {
    const provider = new LocalEmbeddingProvider({
      ollamaHost: 'http://127.0.0.1:11434',
      model: 'bge-m3',
      dimension: 1024,
    });
    await assert.rejects(() => provider.embedTexts(['文本']), (error) => error.code === 'INVALID_RESULT');
  });
});

test('Provider 4：模型缺失 / 连不上 / 超时分别映射成对应的错误码', async () => {
  const provider = new LocalEmbeddingProvider({ ollamaHost: 'http://127.0.0.1:11434', model: 'bge-m3' });

  await withFetch(async () => jsonResponse({ error: 'model not found' }, 404), async () => {
    await assert.rejects(() => provider.embedTexts(['文本']), (error) => error.code === 'MODEL_NOT_FOUND');
  });

  await withFetch(async () => {
    throw new TypeError('fetch failed');
  }, async () => {
    await assert.rejects(() => provider.embedTexts(['文本']), (error) => error.code === 'OLLAMA_UNAVAILABLE');
  });

  await withFetch(async () => {
    const error = new Error('超时');
    error.name = 'TimeoutError';
    throw error;
  }, async () => {
    await assert.rejects(() => provider.embedTexts(['文本']), (error) => error.code === 'AI_TIMEOUT');
  });
});

// ---- EmbeddingService：编排、状态流转与崩溃恢复 ----

// 三层各造一条「已完成」的记录；另外造一条还在分析的截图，用来验证扫描条件。
async function seedCompletedRecords({ activities, timeBlocks, diaries, queue }) {
  activities.createActivity({
    id: 'shot-1',
    time: '2026-09-17T10:00:00+08:00',
    imagePath: 'C:/tmp/shot-1.png',
    analysisStatus: 'COMPLETED',
    analysis: {
      activity: '写代码',
      summary: '在 VS Code 里写代码',
      category: 'coding',
      project: 'Life Lens',
      keywords: ['Electron'],
      confidence: 0.8,
    },
  });
  activities.createActivity({
    id: 'shot-2',
    time: '2026-09-17T10:00:20+08:00',
    imagePath: 'C:/tmp/shot-2.png',
    analysisStatus: 'PENDING',
    analysis: null,
  });

  const block = createBlock(at(2026, 9, 17, 10, 0), { activityCount: 3 });
  await queue.enqueueWithBlock(block);
  timeBlocks.updateSummary(block.id, {
    status: 'COMPLETED',
    summary: {
      project: 'Life Lens',
      category: 'coding',
      description: '开发记忆索引',
      software: ['VS Code'],
      todos: ['补测试'],
    },
  });

  await queue.enqueueWithDiary({
    day: '2026-09-17',
    status: 'PENDING',
    blockCount: 1,
    from: '2026-09-17T00:00:00+08:00',
    to: '2026-09-18T00:00:00+08:00',
  });
  diaries.updateDiary('2026-09-17', {
    status: 'COMPLETED',
    diary: {
      summary: '今天开发记忆索引',
      mainEvents: ['写代码'],
      highlights: [],
      todos: [],
      suggestions: [],
      tips: [],
    },
  });

  return block;
}

test('服务 1：三层记录各自嵌入并写入对应向量表，状态回写 COMPLETED', async (t) => {
  const dir = await tempDir();
  const fixture = await makeEmbeddingFixture({ dir });
  cleanup(t, dir, [fixture.service, fixture.queue]);
  await fixture.queue.start();
  const block = await seedCompletedRecords(fixture);

  const result = await fixture.service.scan();
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 0);

  const activityRow = await fixture.vectors.activity.findBySource('activity:1');
  assert.equal(activityRow.source_id, '1');
  assert.equal(activityRow.captured_at, '2026-09-17T10:00:00+08:00');
  assert.equal(activityRow.date, '2026-09-17');
  assert.equal(activityRow.project, 'Life Lens');
  assert.equal(activityRow.embedding_model, 'fake-embed');
  assert.equal(activityRow.embedding_version, 'v1');
  assert.match(activityRow.text, /^项目：Life Lens/);
  assert.equal(activityRow.vector.length, 4);

  const blockRow = await fixture.vectors.block.findBySource(`block:${block.id}`);
  assert.equal(blockRow.category, 'coding');
  assert.match(blockRow.text, /软件：VS Code/);

  const diaryRow = await fixture.vectors.diary.findBySource('diary:2026-09-17');
  // 日记没有项目 / 分类：写空串而不是 null（LanceDB 无法从全 NULL 列推断 Arrow 类型）。
  assert.equal(diaryRow.project, '');
  assert.equal(diaryRow.category, '');
  assert.match(diaryRow.text, /^日期：2026-09-17/);

  // 状态与 SQLite 的「分析已完成」数量一致（验收标准 1）。
  for (const name of ['activity', 'block', 'diary']) {
    const counts = fixture.sources[name].countByStatus();
    assert.equal(counts[EMBEDDING_STATUS.COMPLETED], 1);
    assert.equal(counts[EMBEDDING_STATUS.PROCESSING], 0);
    assert.equal(await fixture.vectors[name].count(), 1);
    assert.equal(fixture.sources[name].countReady(), 1);
  }
  // 还在分析中的截图不动（PENDING 保持在 SQLite，不占用向量库）。
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.PENDING], 1);

  // 写进向量库的 project / category 必须是字符串：LanceDB 建表时要推断 Arrow 类型，
  // 全 NULL 的列推断不出类型（真实 Electron 冒烟时踩到过，见 23-变更记录-Phase10）。
  for (const name of ['activity', 'block', 'diary']) {
    for (const row of fixture.vectors[name].rows.values()) {
      assert.equal(typeof row.project, 'string', `${name} 的 project 不能是 null`);
      assert.equal(typeof row.category, 'string', `${name} 的 category 不能是 null`);
    }
  }
});

test('服务 2：模型不可用时整轮跳过，记录保持 PENDING，恢复后自动补齐', async (t) => {
  const dir = await tempDir();
  const provider = fakeEmbeddingProvider({ available: false });
  const fixture = await makeEmbeddingFixture({ dir, provider });
  cleanup(t, dir, [fixture.service, fixture.queue]);
  await fixture.queue.start();
  await seedCompletedRecords(fixture);

  const skipped = await fixture.service.scan();
  assert.equal(skipped.available, false);
  assert.equal(skipped.layers.length, 0);
  assert.equal(provider.calls.length, 0);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.PENDING], 2);
  assert.equal(await fixture.vectors.activity.count(), 0);

  // 模型恢复：下一轮扫描自动补齐，不需要人工干预。
  provider.available = true;
  const filled = await fixture.service.scan();
  assert.equal(filled.completed, 3);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.COMPLETED], 1);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.PENDING], 1);
});

test('服务 3：启动补偿把崩溃遗留的 PROCESSING 退回 PENDING 并完成嵌入', async (t) => {
  const dir = await tempDir();
  const fixture = await makeEmbeddingFixture({ dir });
  cleanup(t, dir, [fixture.service, fixture.queue]);
  await fixture.queue.start();
  await seedCompletedRecords(fixture);

  // 模拟上一次进程崩在批次中间：三张表都有 PROCESSING 残留。
  for (const table of ['activities', 'time_blocks', 'diaries']) {
    fixture.db.prepare(`UPDATE ${table} SET embedding_status = 'PROCESSING'`).run();
  }

  fixture.service.start();
  await fixture.service.flush();
  fixture.service.stop();

  for (const name of ['activity', 'block', 'diary']) {
    const counts = fixture.sources[name].countByStatus();
    assert.equal(counts[EMBEDDING_STATUS.PROCESSING], 0, `${name} 不该留下 PROCESSING`);
    assert.equal(counts[EMBEDDING_STATUS.COMPLETED], 1, `${name} 补跑后完成`);
  }
  assert.equal(await fixture.vectors.diary.count(), 1);
});

test('服务 4：构建不出文本的记录标记 FAILED，不写空向量，可手动重置', async (t) => {
  const dir = await tempDir();
  const fixture = await makeEmbeddingFixture({ dir });
  cleanup(t, dir, [fixture.service, fixture.queue]);
  await fixture.queue.start();

  fixture.activities.createActivity({
    id: 'shot-empty',
    time: '2026-09-17T11:00:00+08:00',
    imagePath: 'C:/tmp/shot-empty.png',
    analysisStatus: 'COMPLETED',
    analysis: { activity: null, summary: null, category: null, project: null, keywords: [], confidence: null },
  });

  const result = await fixture.service.scan();
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.FAILED], 1);
  assert.equal(await fixture.vectors.activity.count(), 0);

  // FAILED 是永久状态，只能手动重置回 PENDING（状态机里的那一条回边）。
  assert.equal(fixture.sources.activity.resetFailed(), 1);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.PENDING], 1);
});

test('服务 5：临时故障（模型报错 / 向量库写入失败）退回 PENDING 而不是 FAILED', async (t) => {
  const dir = await tempDir();
  const provider = fakeEmbeddingProvider();
  const fixture = await makeEmbeddingFixture({ dir, provider });
  cleanup(t, dir, [fixture.service, fixture.queue]);
  await fixture.queue.start();
  await seedCompletedRecords(fixture);

  // 只关心 activity 这一层：区块与日记在第二轮会正常完成，不影响这里的结论。
  const activityLayer = (scan) => scan.layers.find((item) => item.layer === 'activity');

  provider.error = new Error('模型掉线');
  let result = await fixture.service.scan();
  assert.equal(activityLayer(result).completed, 0);
  // shot-1 退回 PENDING，shot-2 本来就在等分析结果，所以有 2 条待嵌入。
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.PENDING], 2);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.PROCESSING], 0);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.FAILED], 0);

  provider.error = null;
  fixture.vectors.activity.failUpsert = true;
  result = await fixture.service.scan();
  assert.equal(activityLayer(result).completed, 0);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.PENDING], 2);

  fixture.vectors.activity.failUpsert = false;
  result = await fixture.service.scan();
  assert.equal(activityLayer(result).completed, 1);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.COMPLETED], 1);
});

test('服务 6：重复嵌入按 id 覆盖，不产生重复行，也不动 SQLite 原始数据', async (t) => {
  const dir = await tempDir();
  const fixture = await makeEmbeddingFixture({ dir });
  cleanup(t, dir, [fixture.service, fixture.queue]);
  await fixture.queue.start();
  await seedCompletedRecords(fixture);

  await fixture.service.scan();
  assert.equal(await fixture.vectors.activity.count(), 1);

  // 已经没有待办：第二轮是空操作。
  const idle = await fixture.service.scan();
  assert.equal(idle.pending, 0);
  assert.equal(await fixture.vectors.activity.count(), 1);

  // 全量重建：状态重置后重跑同一批，LanceDB 里仍然是同一行（按 id 覆盖）。
  fixture.sources.activity.resetAll();
  await fixture.service.scan();
  assert.equal(await fixture.vectors.activity.count(), 1);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.COMPLETED], 1);
  assert.equal(fixture.activities.getByScreenshotId('shot-1').analysisStatus, 'COMPLETED');
});

test('服务 7：一轮扫描最多连续处理 maxBatchesPerScan 批，剩下的留给下一轮', async (t) => {
  const dir = await tempDir();
  const fixture = await makeEmbeddingFixture({ dir, serviceOptions: { batchSize: 2, maxBatchesPerScan: 3 } });
  cleanup(t, dir, [fixture.service, fixture.queue]);
  await fixture.queue.start();

  for (let index = 0; index < 10; index += 1) {
    fixture.activities.createActivity({
      id: `shot-${index}`,
      time: `2026-09-17T12:00:${String(index).padStart(2, '0')}+08:00`,
      imagePath: `C:/tmp/shot-${index}.png`,
      analysisStatus: 'COMPLETED',
      analysis: {
        activity: `活动 ${index}`,
        summary: '摘要',
        category: 'coding',
        project: 'Life Lens',
        keywords: [],
        confidence: 0.5,
      },
    });
  }

  const first = await fixture.service.scan();
  assert.equal(first.completed, 6);
  assert.equal(first.layers[0].batches, 3);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.PENDING], 4);

  const second = await fixture.service.scan();
  assert.equal(second.completed, 4);
  assert.equal(fixture.sources.activity.countByStatus()[EMBEDDING_STATUS.PENDING], 0);
  assert.equal(await fixture.vectors.activity.count(), 10);
});
