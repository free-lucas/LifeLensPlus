'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { LanceStore } = require('../src/main/embedding/lanceStore');
const { MemoryVectorRepository } = require('../src/main/embedding/MemoryVectorRepository');
const { EmbeddingSourceRepository, EMBEDDING_STATUS } = require('../src/main/embedding/EmbeddingSourceRepository');
const { EmbeddingService } = require('../src/main/embedding/EmbeddingService');
const { tempDir, cleanup, makeQueue, removeDir, fakeEmbeddingProvider } = require('./support');

// LanceDB 的集成测试：真实的向量表读写（无 Ollama 依赖，向量由测试直接构造）。
const TABLE = 'activity_vectors';

async function makeVectorRepo(dir, { tableName = TABLE, indexThreshold } = {}) {
  const store = new LanceStore({ dir: path.join(dir, 'lancedb') });
  await store.open();
  return { store, repo: new MemoryVectorRepository({ store, tableName, indexThreshold }) };
}

// 每个 seed 给一条不同的向量，避免索引训练时出现大量重复点。
function vector(size = 4, seed = 0) {
  return Array.from({ length: size }, (_, index) => ((seed * 7 + index * 13) % 97) / 97);
}

function vectorRow(id, options = {}) {
  const {
    text = '文本',
    seed = 0,
    project = 'Life Lens',
    category = 'coding',
    date = '2026-09-17',
    size = 4,
  } = options;
  return {
    id,
    source_id: id.split(':')[1],
    text,
    vector: vector(size, seed),
    captured_at: `${date}T10:00:00+08:00`,
    date,
    project,
    category,
    embedding_model: 'bge-m3',
    embedding_version: 'v1',
    created_at: '2026-09-17T10:00:00+08:00',
  };
}

test('向量仓储 1：upsert 建表并写入，count / findBySource 能读回同一行', async (t) => {
  const dir = await tempDir();
  const { store, repo } = await makeVectorRepo(dir);
  cleanup(t, dir, [{ stop: () => store.close() }]);

  assert.equal(await repo.count(), 0);
  assert.equal(await repo.findBySource('activity:1'), null);

  assert.equal(await repo.upsert([vectorRow('activity:1', { text: '第一版' })]), 1);
  assert.equal(await repo.count(), 1);

  const found = await repo.findBySource('activity:1');
  assert.equal(found.text, '第一版');
  assert.equal(found.source_id, '1');
  assert.equal(found.date, '2026-09-17');
  assert.equal(found.project, 'Life Lens');
  assert.equal(found.vector.length, 4);
});

test('向量仓储 2：同一条记录重复 upsert 按 id 覆盖，不产生重复行', async (t) => {
  const dir = await tempDir();
  const { store, repo } = await makeVectorRepo(dir);
  cleanup(t, dir, [{ stop: () => store.close() }]);

  await repo.upsert([vectorRow('activity:1', { text: '第一版' }), vectorRow('activity:2')]);
  await repo.upsert([vectorRow('activity:1', { text: '第二版' })]);

  assert.equal(await repo.count(), 2);
  assert.equal((await repo.findBySource('activity:1')).text, '第二版');
});

test('向量仓储 3：deleteBySource 按行 ID 删除', async (t) => {
  const dir = await tempDir();
  const { store, repo } = await makeVectorRepo(dir);
  cleanup(t, dir, [{ stop: () => store.close() }]);

  await repo.upsert([vectorRow('activity:1'), vectorRow('activity:2')]);
  assert.equal(await repo.deleteBySource(['activity:1']), 1);
  assert.equal(await repo.count(), 1);
  assert.equal(await repo.findBySource('activity:1'), null);
  assert.equal(await repo.deleteBySource([]), 0);
});

test('向量仓储 4：search 返回最近邻，filter 走列下推', async (t) => {
  const dir = await tempDir();
  const { store, repo } = await makeVectorRepo(dir);
  cleanup(t, dir, [{ stop: () => store.close() }]);

  await repo.upsert([
    vectorRow('activity:1', { seed: 0, project: 'Life Lens' }),
    vectorRow('activity:2', { seed: 3, project: 'Other' }),
    vectorRow('activity:3', { seed: 1, project: 'Life Lens', category: 'writing', date: '2026-09-16' }),
  ]);

  const hits = await repo.search(vector(4, 0), { limit: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'activity:1');

  const filtered = await repo.search(vector(4, 0), { limit: 5, filter: 'project = \'Other\'' });
  assert.deepEqual(filtered.map((row) => row.id), ['activity:2']);

  // 没有表时搜索返回空数组，而不是抛错。
  const emptyRepo = new MemoryVectorRepository({ store, tableName: 'diary_vectors' });
  assert.deepEqual(await emptyRepo.search(vector(4, 0), { limit: 3 }), []);
  assert.equal(await emptyRepo.count(), 0);
});

test('向量仓储 5：行数到阈值才建 IVF_PQ 索引，已有索引时跳过', async (t) => {
  const dir = await tempDir();
  const { store, repo } = await makeVectorRepo(dir, { tableName: 'index_vectors', indexThreshold: 50 });
  cleanup(t, dir, [{ stop: () => store.close() }]);

  const rows = (start, count) => Array.from(
    { length: count },
    (_, index) => vectorRow(`activity:${start + index}`, { seed: start + index, size: 8 }),
  );

  await repo.upsert(rows(0, 20));
  const below = await repo.ensureIndex(8);
  assert.equal(below.created, false);
  assert.equal(below.reason, 'below-threshold');

  // LanceDB 训练 IVF_PQ 至少需要 256 行（生产的阈值 5000 远高于它，不会命中这个下限）。
  await repo.upsert(rows(20, 280));
  const created = await repo.ensureIndex(8);
  assert.equal(created.created, true, created.error ?? '');

  // 幂等：已经有向量索引就不再重复建。
  const again = await repo.ensureIndex(8);
  assert.equal(again.created, false);
  assert.equal(again.reason, 'exists');

  const table = await store.openTable('index_vectors');
  const indices = await table.listIndices();
  assert.equal(indices.filter((index) => index.indexType === 'IvfPq').length, 1);

  // 有索引时检索照常可用（搜索侧对上层透明）。
  const hits = await repo.search(vector(8, 0), { limit: 3 });
  assert.equal(hits.length, 3);
});

test('向量仓储 6：端到端——向量行数与 SQLite 完成数一致，删库重置后能全量重建', async (t) => {
  const dir = await tempDir();
  const fixture = await makeQueue({ dir });
  const lanceDir = path.join(dir, 'lancedb');
  const store = new LanceStore({ dir: lanceDir });
  await store.open();
  cleanup(t, dir, [fixture.queue, { stop: () => store.close() }]);
  await fixture.queue.start();

  for (const index of [0, 1]) {
    fixture.activities.createActivity({
      id: `shot-${index}`,
      time: `2026-09-17T13:00:0${index}+08:00`,
      imagePath: `C:/tmp/shot-${index}.png`,
      analysisStatus: 'COMPLETED',
      analysis: {
        activity: `活动 ${index}`,
        summary: '摘要',
        category: 'coding',
        project: 'Life Lens',
        keywords: ['Electron'],
        confidence: 0.7,
      },
    });
  }

  const provider = fakeEmbeddingProvider();
  const sources = {
    activity: new EmbeddingSourceRepository({ db: fixture.db, layer: 'activity', log: fixture.log }),
  };
  const vectors = { activity: new MemoryVectorRepository({ store, tableName: TABLE }) };
  const service = new EmbeddingService({
    provider,
    sources,
    vectors,
    log: fixture.log,
    batchSize: 10,
  });

  const first = await service.scan();
  assert.equal(first.completed, 2);
  assert.equal(sources.activity.countByStatus()[EMBEDDING_STATUS.COMPLETED], 2);
  assert.equal(await vectors.activity.count(), sources.activity.countReady());

  // 删掉 LanceDB 目录 + 重置状态 = 全量重建；SQLite 原始数据不受影响。
  store.close();
  await removeDir(lanceDir);
  assert.equal(await vectors.activity.count(), 0);
  sources.activity.resetAll();

  const rebuilt = await service.scan();
  assert.equal(rebuilt.completed, 2);
  assert.equal(await vectors.activity.count(), 2);
  assert.equal(fixture.activities.getByScreenshotId('shot-0').analysisStatus, 'COMPLETED');
  assert.equal(fixture.activities.getByScreenshotId('shot-0').analysis.activity, '活动 0');
});
