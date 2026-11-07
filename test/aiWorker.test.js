'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

const { AIJobType, AIJobStatus } = require('../src/main/ai/job');
const { AIError, ERROR_CODES } = require('../src/main/ai/errors');
const { AIWorker } = require('../src/main/ai/AIWorker');
const { makeQueue, fakeProvider, waitFor, silentLog, cleanup } = require('./support');

function analysisJob(screenshotId = 'shot-1') {
  return {
    type: AIJobType.SCREENSHOT_ANALYSIS,
    payload: { screenshotId, imagePath: 'C:/tmp/shot.png', capturedAt: '2026-09-13T10:00:00+08:00' },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('Worker 正常处理任务：COMPLETED 并回调分析结果', async (t) => {
  const { queue, dir } = await makeQueue();
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const provider = fakeProvider();
  const completed = [];
  const worker = new AIWorker({
    queue,
    provider,
    log: silentLog(),
    healthPollMs: 10,
    onCompleted: (job, result) => completed.push({ job, result }),
  });
  cleaners.push(worker);
  worker.start();

  const { job } = await queue.enqueue(analysisJob());
  await waitFor(() => queue.getJob(job.id).status === AIJobStatus.COMPLETED);

  assert.equal(completed.length, 1);
  assert.equal(completed[0].job.id, job.id);
  assert.equal(completed[0].result.analysis.summary, '模拟分析结果');
});

test('Test 3：start() 幂等，重复调用只会有一个 Worker', async (t) => {
  const { queue, dir } = await makeQueue();
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const worker = new AIWorker({ queue, provider: fakeProvider(), healthPollMs: 10 });
  cleaners.push(worker);
  worker.start();
  worker.start();
  worker.start();

  assert.equal(worker.loops.length, 1);
  assert.equal(worker.getSnapshot().workerRunning, true);
});

test('Test 2：可重试错误会自动重试，最终成功', async (t) => {
  const { queue, dir } = await makeQueue({ retryDelaysMs: [5, 5, 5] });
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const provider = fakeProvider({
    analyze: async (_job, call) => {
      if (call === 1) throw new AIError(ERROR_CODES.OLLAMA_UNAVAILABLE, '暂时连不上 Ollama');
      return { text: '恢复了', sentences: ['恢复了'], model: 'fake-model', analysisMs: 2 };
    },
  });
  const worker = new AIWorker({ queue, provider, log: silentLog(), healthPollMs: 10 });
  cleaners.push(worker);
  worker.start();

  const { job } = await queue.enqueue(analysisJob());
  await waitFor(() => queue.getJob(job.id).status === AIJobStatus.COMPLETED);

  const stored = queue.getJob(job.id);
  assert.equal(stored.retryCount, 1);
  assert.equal(stored.error, null);
  assert.equal(provider.analyzeCalls, 2, '第一次失败后重试了一次');
});

test('永久错误不重试，直接 FAILED 并带上 errorCode', async (t) => {
  const { queue, dir } = await makeQueue({ retryDelaysMs: [5, 5, 5] });
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const provider = fakeProvider({
    analyze: async () => {
      throw new AIError(ERROR_CODES.IMAGE_NOT_FOUND, '截图文件不存在');
    },
  });
  const failed = [];
  const worker = new AIWorker({ queue, provider, log: silentLog(), healthPollMs: 10, onFailed: (job, error) => failed.push(error) });
  cleaners.push(worker);
  worker.start();

  const { job } = await queue.enqueue(analysisJob());
  await waitFor(() => queue.getJob(job.id).status === AIJobStatus.FAILED);

  assert.equal(provider.analyzeCalls, 1, '永久性错误只尝试一次');
  assert.equal(queue.getJob(job.id).error.code, ERROR_CODES.IMAGE_NOT_FOUND);
  assert.equal(failed.length, 1);
});

test('失败次数用尽后保留 FAILED，不会无限重试', async (t) => {
  const { queue, dir } = await makeQueue({ retryDelaysMs: [5, 5, 5] });
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const provider = fakeProvider({
    analyze: async () => {
      throw new AIError(ERROR_CODES.OLLAMA_UNAVAILABLE, '连不上');
    },
  });
  const worker = new AIWorker({ queue, provider, log: silentLog(), healthPollMs: 10 });
  cleaners.push(worker);
  worker.start();

  const { job } = await queue.enqueue(analysisJob({ screenshotId: 'never' }));
  await waitFor(() => queue.getJob(job.id).status === AIJobStatus.FAILED);

  assert.equal(provider.analyzeCalls, 4, '1 次原始尝试 + maxRetries(3) 次重试');
  assert.equal(queue.getJob(job.id).status, AIJobStatus.FAILED);
});

test('Test 2：超时不会让任务永远停在 PROCESSING', async (t) => {
  const { queue, dir } = await makeQueue({ retryDelaysMs: [5, 5, 5] });
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const provider = fakeProvider({ analyze: () => new Promise(() => {}) });
  const worker = new AIWorker({ queue, provider, log: silentLog(), healthPollMs: 10, timeoutMs: 20 });
  cleaners.push(worker);
  worker.start();

  const { job } = await queue.enqueue(analysisJob({ screenshotId: 'slow' }));
  await waitFor(() => queue.getJob(job.id).status === AIJobStatus.FAILED);

  const stored = queue.getJob(job.id);
  assert.equal(stored.error.code, ERROR_CODES.AI_TIMEOUT);
  assert.equal(stored.retryCount, 3);
  assert.equal(provider.analyzeCalls, 4);
});

test('Ollama 离线：任务保持 PENDING，恢复后自动继续', async (t) => {
  const { queue, dir } = await makeQueue();
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  let online = false;
  const provider = fakeProvider({ health: () => ({ online, modelAvailable: true }) });
  const worker = new AIWorker({ queue, provider, log: silentLog(), healthPollMs: 10 });
  cleaners.push(worker);
  worker.start();

  const { job } = await queue.enqueue(analysisJob());
  await sleep(60);

  assert.equal(queue.getJob(job.id).status, AIJobStatus.PENDING, '离线时队列保留任务');
  assert.equal(provider.analyzeCalls, 0, '离线时不发起推理请求');
  assert.equal(worker.getSnapshot().offline, true);

  online = true;
  await waitFor(() => queue.getJob(job.id).status === AIJobStatus.COMPLETED);
  assert.equal(worker.getSnapshot().offline, false);
});

test('模型不存在：直接 MODEL_NOT_FOUND 失败，且不发起推理', async (t) => {
  const { queue, dir } = await makeQueue();
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const provider = fakeProvider({ health: () => ({ online: true, modelAvailable: false }) });
  const worker = new AIWorker({ queue, provider, log: silentLog(), healthPollMs: 10 });
  cleaners.push(worker);
  worker.start();

  const { job } = await queue.enqueue(analysisJob());
  await waitFor(() => queue.getJob(job.id).status === AIJobStatus.FAILED);

  assert.equal(queue.getJob(job.id).error.code, ERROR_CODES.MODEL_NOT_FOUND);
  assert.equal(provider.analyzeCalls, 0);
});

test('Test 8：暂停 AI 时任务不处理，恢复后继续', async (t) => {
  const { queue, dir } = await makeQueue();
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const provider = fakeProvider();
  const worker = new AIWorker({ queue, provider, log: silentLog(), healthPollMs: 10 });
  cleaners.push(worker);
  worker.start();

  queue.pause();
  const { job } = await queue.enqueue(analysisJob());
  await sleep(40);
  assert.equal(queue.getJob(job.id).status, AIJobStatus.PENDING);
  assert.equal(provider.analyzeCalls, 0);

  queue.resume();
  await waitFor(() => queue.getJob(job.id).status === AIJobStatus.COMPLETED);
});

test('并发默认 1，可通过配置调整', async (t) => {
  const { queue, dir } = await makeQueue();
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const single = new AIWorker({ queue, provider: fakeProvider(), healthPollMs: 10 });
  assert.equal(single.concurrency, 1);
  const parallel = new AIWorker({ queue, provider: fakeProvider(), concurrency: 3, healthPollMs: 10 });
  parallel.start();
  assert.equal(parallel.loops.length, 3);
  await parallel.stop({ timeoutMs: 100 });
});
