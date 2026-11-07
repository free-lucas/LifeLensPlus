'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

const { Store } = require('../src/main/store');
const { Recorder } = require('../src/main/recorder');
const { AIWorker } = require('../src/main/ai/AIWorker');
const { AIError, ERROR_CODES } = require('../src/main/ai/errors');
const { makeQueue, fakeProvider, fakeCapture, waitFor, tempDir, silentLog, cleanup } = require('./support');

function configFor(dir) {
  return { intervalMs: 20, model: 'fake-model', outputDir: dir, maxSummarySentences: 6 };
}

function analysis(overrides = {}) {
  return {
    activity: '编写代码',
    summary: '正在用 VS Code 编写 Electron 代码',
    category: 'coding',
    project: 'Life Lens',
    keywords: ['VS Code', 'Electron'],
    confidence: 0.9,
    ...overrides,
  };
}

// 按 main.js 的方式接线：Worker 的分析结果回填到 Recorder 的记录里。
function makeHarness({ dir, store, activities, queue, provider, workerOptions = {} }) {
  const recorder = new Recorder({
    store,
    activities,
    config: configFor(dir),
    onEvent: () => {},
    aiQueue: queue,
    capture: fakeCapture(),
  });
  const worker = new AIWorker({
    queue,
    provider,
    log: silentLog(),
    healthPollMs: 10,
    onCompleted: (job, result) => recorder.handleAnalysisResult(job, result),
    onFailed: (job, error) => recorder.handleAnalysisFailure(job, error),
    ...workerOptions,
  });
  return { recorder, worker };
}

test('Test 6/7：AI 很慢时截图照常产生，记录先落盘为 PENDING', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();

  // 模拟「分析一次要 60 秒」：analyze 永远不返回。
  const provider = fakeProvider({ analyze: () => new Promise(() => {}) });
  const { recorder, worker } = makeHarness({
    dir, store, activities, queue, provider, workerOptions: { timeoutMs: 30000 },
  });
  cleanup(t, dir, [recorder, worker, queue]);
  worker.start();
  recorder.start();

  await waitFor(() => recorder.status.total >= 3);

  assert.equal(queue.getStats().processing, 1, '第一个任务仍在 AI 处理中');
  assert.ok(queue.getStats().pending >= 1, '后续任务老老实实排队，没有阻塞截图');
  assert.equal(provider.analyzeCalls, 1, '并发为 1：同一时刻只跑一次推理');

  const records = await activities.listRecent(10);
  assert.ok(records.length >= 3, '截图记录没有被 AI 拖住');
  assert.ok(records.every((record) => record.analysisStatus === 'PENDING'));

  const images = await fs.readdir(store.imageDir(new Date()));
  assert.ok(images.length >= 3, '截图文件都已保存到磁盘');
});

test('Test 7：AI 永久失败也不影响截图继续记录', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir, retryDelaysMs: [5, 5, 5] });
  await queue.start();

  const provider = fakeProvider({
    analyze: async () => {
      throw new AIError(ERROR_CODES.IMAGE_INVALID, '截图损坏');
    },
  });
  const { recorder, worker } = makeHarness({ dir, store, activities, queue, provider });
  cleanup(t, dir, [recorder, worker, queue]);
  worker.start();
  recorder.start();

  await waitFor(() => queue.getStats().failed >= 3);

  assert.ok(recorder.status.total >= 3, 'AI 失败时截图仍然继续');
  assert.equal(recorder.status.errors, queue.getStats().failed, '失败计数同步到界面统计');
  assert.equal(recorder.status.pending, 0, '失败的任务不再计入待分析');
});

test('分析成功后把结果回填到记录（PENDING -> COMPLETED）', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();

  const structured = analysis();
  const provider = fakeProvider({
    analyze: async () => ({
      analysis: structured,
      logLine: 'category=coding',
      model: 'fake-model',
      analysisMs: 12,
    }),
  });
  const { recorder, worker } = makeHarness({ dir, store, activities, queue, provider });
  cleanup(t, dir, [recorder, worker, queue]);
  worker.start();
  recorder.start();

  await waitFor(async () => {
    const [record] = await activities.listRecent(1);
    return Boolean(record) && record.analysisStatus === 'COMPLETED';
  });

  const [record] = await activities.listRecent(1);
  assert.deepEqual(record.analysis, structured);
  assert.equal(record.summary, structured.summary, '顶层 summary 与结构化结果一致');
  assert.equal(record.analysisMs, 12);
  assert.equal(record.error, null);
  assert.equal(record.id, record.imagePath.split(/[\\/]/).pop().replace(/\.png$/, ''));
  assert.ok((await fs.stat(record.imagePath)).isFile(), 'AI 完成后截图仍然保留');
  assert.ok(recorder.status.analyzed >= 1);
  assert.equal(recorder.status.pending, 0);
});

test('AI 永久失败时记录标记 FAILED，截图不删除', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir, retryDelaysMs: [5, 5, 5] });
  await queue.start();

  const provider = fakeProvider({
    analyze: async () => {
      throw new AIError(ERROR_CODES.MODEL_NOT_FOUND, '模型不存在');
    },
  });
  const { recorder, worker } = makeHarness({ dir, store, activities, queue, provider });
  cleanup(t, dir, [recorder, worker, queue]);
  worker.start();
  recorder.start();

  await waitFor(async () => {
    const [record] = await activities.listRecent(1);
    return Boolean(record) && record.analysisStatus === 'FAILED';
  });

  const [record] = await activities.listRecent(1);
  assert.equal(record.error, '模型不存在');
  assert.equal(record.errorCode, ERROR_CODES.MODEL_NOT_FOUND);
  assert.equal(record.analysis, null, '失败时没有结构化结果');
  assert.ok((await fs.stat(record.imagePath)).isFile(), 'AI 失败不删除截图');
});

test('Test 1：截图与 AI 解耦——enqueue 不会等待分析结果', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();

  let released;
  const gate = new Promise((resolve) => { released = resolve; });
  const provider = fakeProvider({ analyze: () => gate });
  const { recorder, worker } = makeHarness({
    dir, store, activities, queue, provider, workerOptions: { timeoutMs: 30000 },
  });
  cleanup(t, dir, [recorder, worker, queue]);
  worker.start();

  const startedAt = Date.now();
  recorder.start();
  await waitFor(() => recorder.status.total >= 1);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 1500, `截图流程没有被 AI 阻塞（耗时 ${elapsed}ms）`);
  assert.equal(queue.getStats().processing, 1, '任务已经交给 Worker');
  released();
});
