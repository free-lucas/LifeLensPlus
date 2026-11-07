'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store } = require('../src/main/store');
const { Recorder } = require('../src/main/recorder');
const { AIJobType, AIJobStatus, JOB_PRIORITY } = require('../src/main/ai/job');
const { AIJobRepository } = require('../src/main/db/repositories/AIJobRepository');
const { AIJobQueueService } = require('../src/main/ai/AIJobQueueService');
const { AIWorker } = require('../src/main/ai/AIWorker');
const { formatLocalIso } = require('../src/main/time');
const {
  tempDir, cleanup, makeQueue, fakeProvider, fakeCapture, waitFor, silentLog,
} = require('./support');

function pendingRecord(id, date) {
  return {
    id,
    time: formatLocalIso(date),
    imagePath: `C:/tmp/${id}.png`,
    model: 'fake-model',
    analysisMs: null,
    analysisStatus: 'PENDING',
    error: null,
    errorCode: null,
    analysis: null,
  };
}

function makeRecorder({ dir, store, activities, queue }) {
  return new Recorder({
    store,
    activities,
    config: { intervalMs: 20, model: 'fake-model', outputDir: dir, maxSummarySentences: 6 },
    onEvent: () => {},
    aiQueue: queue,
    capture: fakeCapture(),
    log: silentLog(),
  });
}

function analyzeJob(screenshotId, capturedAt) {
  return {
    type: AIJobType.SCREENSHOT_ANALYSIS,
    payload: { screenshotId, imagePath: `C:/tmp/${screenshotId}.png`, capturedAt },
  };
}

test('PENDING 记录没有对应 Job：启动补偿会补建任务', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();
  const recorder = makeRecorder({ dir, store, activities, queue });
  cleanup(t, dir, [recorder, queue]);

  const date = new Date(2026, 8, 11, 21, 6, 0);
  activities.createActivity(pendingRecord('shot-1', date));
  activities.createActivity(pendingRecord('shot-2', date));

  const result = await recorder.recoverPendingAnalyses();

  assert.deepEqual(result, { scanned: 2, created: 2, skipped: 0 });
  assert.equal(queue.getJobs().length, 2);
  const jobs = queue.getJobs();
  assert.deepEqual(jobs.map((job) => job.payload.screenshotId).sort(), ['shot-1', 'shot-2']);
  assert.equal(jobs[0].payload.imagePath, 'C:/tmp/shot-1.png');
  assert.equal(jobs[0].payload.capturedAt, formatLocalIso(date));
  assert.equal(jobs[0].priority, JOB_PRIORITY.LOW, '补偿任务优先级低于实时截图');
  assert.equal(jobs[0].status, AIJobStatus.PENDING);
});

test('已有 Job 的 PENDING 记录会被跳过，不会重复分析', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();
  const recorder = makeRecorder({ dir, store, activities, queue });
  cleanup(t, dir, [recorder, queue]);

  const date = new Date(2026, 8, 11, 21, 6, 0);
  activities.createActivity(pendingRecord('shot-1', date));
  await queue.enqueue(analyzeJob('shot-1', formatLocalIso(date)));

  const result = await recorder.recoverPendingAnalyses();

  assert.deepEqual(result, { scanned: 1, created: 0, skipped: 1 });
  assert.equal(queue.getJobs().length, 1);
});

test('已完成 / 已失败 / 已取消的 Job 也算「已有」，不重复建任务', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();
  const recorder = makeRecorder({ dir, store, activities, queue });
  cleanup(t, dir, [recorder, queue]);

  const date = new Date(2026, 8, 11, 21, 6, 0);
  const ids = ['done', 'failed', 'cancelled'];
  for (const id of ids) activities.createActivity(pendingRecord(id, date));

  const done = await queue.enqueue(analyzeJob('done', formatLocalIso(date)));
  queue.dequeue();
  queue.complete(done.job.id);

  const failed = await queue.enqueue(analyzeJob('failed', formatLocalIso(date)));
  queue.dequeue();
  queue.fail(failed.job.id, { code: 'MODEL_NOT_FOUND', message: '没有模型' });

  const cancelled = await queue.enqueue(analyzeJob('cancelled', formatLocalIso(date)));
  queue.cancel(cancelled.job.id);

  const result = await recorder.recoverPendingAnalyses();

  assert.deepEqual(result, { scanned: 3, created: 0, skipped: 3 });
  assert.equal(queue.getJobs().length, 3);
  assert.equal(queue.getPendingJobs().length, 0);
});

test('非 PENDING 的记录不参与补偿', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();
  const recorder = makeRecorder({ dir, store, activities, queue });
  cleanup(t, dir, [recorder, queue]);

  const date = new Date(2026, 8, 11, 21, 6, 0);
  activities.createActivity({ ...pendingRecord('done', date), analysisStatus: 'COMPLETED' });
  activities.createActivity({ ...pendingRecord('failed', date), analysisStatus: 'FAILED', error: '失败' });

  const result = await recorder.recoverPendingAnalyses();
  assert.deepEqual(result, { scanned: 0, created: 0, skipped: 0 });
  assert.equal(queue.getJobs().length, 0);
});

test('补偿出来的任务会被 Worker 正常分析并回填记录', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();
  const recorder = makeRecorder({ dir, store, activities, queue });
  const provider = fakeProvider({
    analyze: async () => ({
      analysis: {
        activity: '补偿分析',
        summary: '补偿后补上的分析结果',
        category: 'other',
        project: null,
        keywords: [],
        confidence: 0.4,
      },
      logLine: 'category=other',
      model: 'fake-model',
      analysisMs: 3,
    }),
  });
  const worker = new AIWorker({
    queue,
    provider,
    log: silentLog(),
    healthPollMs: 10,
    onCompleted: (job, result) => recorder.handleAnalysisResult(job, result),
    onFailed: (job, error) => recorder.handleAnalysisFailure(job, error),
  });
  cleanup(t, dir, [recorder, worker, queue]);

  const date = new Date(2026, 8, 11, 21, 6, 0);
  activities.createActivity(pendingRecord('shot-1', date));

  const result = await recorder.recoverPendingAnalyses();
  assert.equal(result.created, 1);

  worker.start();
  await waitFor(async () => {
    const [record] = await activities.listRecent(1);
    return Boolean(record) && record.analysisStatus === 'COMPLETED';
  });

  const [record] = await activities.listRecent(1);
  assert.equal(record.summary, '补偿后补上的分析结果');
});

test('模拟崩溃重启：记录写了但没入队，重启后由补偿补上', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);

  // 第一次运行：给 shot-a 建了任务，随后进程结束。
  const { queue: firstRun, activities, db } = await makeQueue({ dir });
  await firstRun.start();
  const date = new Date(2026, 8, 11, 21, 6, 0);
  await firstRun.enqueue(analyzeJob('shot-a', formatLocalIso(date)));
  await firstRun.flush();
  firstRun.stop();

  // 崩溃点：两条记录都落了盘，但 shot-b 还来不及入队。
  activities.createActivity(pendingRecord('shot-a', date));
  activities.createActivity(pendingRecord('shot-b', date));

  // 重新启动：同一个数据库上用新的 Queue 重新加载。
  const restarted = await makeQueue({ dir, db, activities });
  await restarted.queue.start();
  const recorder = makeRecorder({
    dir, store, activities, queue: restarted.queue,
  });
  cleanup(t, dir, [recorder, restarted.queue]);

  const result = await recorder.recoverPendingAnalyses();

  assert.deepEqual(result, { scanned: 2, created: 1, skipped: 1 });
  assert.equal(restarted.queue.getJobs().length, 2);

  const compensated = restarted.queue
    .getPendingJobs()
    .find((job) => job.payload.screenshotId === 'shot-b');
  assert.ok(compensated, 'shot-b 由启动补偿补建');
  assert.equal(compensated.priority, JOB_PRIORITY.LOW);

  const untouched = restarted.queue
    .getJobs()
    .find((job) => job.payload.screenshotId === 'shot-a');
  assert.equal(untouched.priority, JOB_PRIORITY.NORMAL, '上次运行已入队的任务保持原样，不重复建');
});

test('没有 aiQueue 时补偿是空操作', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { activities } = await makeQueue({ dir });
  const recorder = new Recorder({
    store,
    activities,
    config: { intervalMs: 20, model: 'fake-model', outputDir: dir },
    onEvent: () => {},
    capture: fakeCapture(),
  });
  cleanup(t, dir, [recorder]);

  assert.deepEqual(await recorder.recoverPendingAnalyses(), { scanned: 0, created: 0, skipped: 0 });
});
