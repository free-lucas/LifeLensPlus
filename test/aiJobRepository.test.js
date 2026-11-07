'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AIJobType, AIJobStatus, JOB_PRIORITY, createJob } = require('../src/main/ai/job');
const { tempDir, cleanup, makeQueue } = require('./support');

function jobRequest(screenshotId, priority = JOB_PRIORITY.NORMAL) {
  return {
    type: AIJobType.SCREENSHOT_ANALYSIS,
    priority,
    payload: {
      screenshotId,
      imagePath: `C:/tmp/${screenshotId}.png`,
      capturedAt: '2026-09-13T10:00:00+08:00',
    },
  };
}

function activityRecord(id) {
  return {
    id,
    time: '2026-09-13T10:00:00+08:00',
    imagePath: `C:/tmp/${id}.png`,
    model: 'fake-model',
    analysisMs: null,
    analysisStatus: 'PENDING',
    error: null,
    errorCode: null,
    analysis: null,
  };
}

test('Test 5：六种 Job 状态都正确落库', async (t) => {
  const dir = await tempDir();
  const { queue, repository } = await makeQueue({ dir, retryDelaysMs: [10000, 10000, 10000] });
  cleanup(t, dir, [queue]);
  await queue.start();

  const statusOf = async (id) => (await queue.enqueue(jobRequest(id, JOB_PRIORITY.HIGH))).job;

  // PENDING：入队后什么都不做，用低优先级保证它不会被后面的 dequeue 取走。
  await queue.enqueue(jobRequest('pending', JOB_PRIORITY.LOW));

  const processing = await statusOf('processing');
  queue.dequeue();
  assert.equal(processing.status, AIJobStatus.PROCESSING);

  const completed = await statusOf('completed');
  queue.dequeue();
  queue.complete(completed.id);

  const failed = await statusOf('failed');
  queue.dequeue();
  queue.fail(failed.id, { code: 'MODEL_NOT_FOUND', message: '没有模型' });

  const retrying = await statusOf('retrying');
  queue.dequeue();
  queue.scheduleRetry(retrying.id, { code: 'AI_TIMEOUT', message: '超时' });

  const cancelled = await statusOf('cancelled');
  queue.cancel(cancelled.id);

  await queue.flush();

  const byScreenshot = new Map(repository.load().map((job) => [job.payload.screenshotId, job]));
  assert.deepEqual(
    [...byScreenshot.entries()].map(([id, job]) => [id, job.status]),
    [
      ['pending', AIJobStatus.PENDING],
      ['processing', AIJobStatus.PROCESSING],
      ['completed', AIJobStatus.COMPLETED],
      ['failed', AIJobStatus.FAILED],
      ['retrying', AIJobStatus.RETRYING],
      ['cancelled', AIJobStatus.CANCELLED],
    ],
  );

  // 失败的任务连错误码、错误信息、失败时间一起存下来。
  const storedFailed = byScreenshot.get('failed');
  assert.deepEqual(storedFailed.error, { code: 'MODEL_NOT_FOUND', message: '没有模型' });
  assert.equal(typeof storedFailed.failedAt, 'string');
  assert.equal(byScreenshot.get('retrying').retryCount, 1);
  assert.equal(byScreenshot.get('cancelled').completedAt, null);
});

test('Test 15：save(jobs) -> load() 快照往返一致，payload 还原成对象并关联 activity_id', async (t) => {
  const dir = await tempDir();
  const { activities, repository, db } = await makeQueue({ dir });
  cleanup(t, dir);

  const activityId = activities.createActivity(activityRecord('s1'));
  const job = createJob({
    type: AIJobType.SCREENSHOT_ANALYSIS,
    priority: JOB_PRIORITY.HIGH,
    payload: {
      screenshotId: 's1',
      imagePath: 'C:/tmp/s1.png',
      capturedAt: '2026-09-13T10:00:00+08:00',
    },
  });
  await repository.save([job]);

  const [loaded] = repository.load();
  assert.equal(loaded.id, job.id);
  assert.equal(loaded.type, job.type);
  assert.equal(loaded.status, job.status);
  assert.equal(loaded.priority, job.priority);
  assert.equal(loaded.retryCount, job.retryCount);
  assert.equal(loaded.maxRetries, job.maxRetries);
  assert.equal(loaded.createdAt, job.createdAt);
  assert.deepEqual(loaded.payload, job.payload, 'payload_json 还原成对象');
  assert.equal(loaded.error, null);
  assert.equal(loaded.lastError, null);

  const row = db.prepare('SELECT activity_id, payload_json FROM ai_jobs WHERE id = ?').get(job.id);
  assert.equal(row.activity_id, activityId, 'SCREENSHOT_ANALYSIS 的 Job 关联到 activities.id');
  assert.equal(typeof row.payload_json, 'string', 'payload 以 JSON 字符串存列');

  // 不关联截图记录的类型，activity_id 为 NULL。
  const other = createJob({ type: AIJobType.TIMEBLOCK_SUMMARY, payload: { screenshotId: 's1' } });
  await repository.save([job, other]);
  assert.equal(
    db.prepare('SELECT activity_id FROM ai_jobs WHERE id = ?').get(other.id).activity_id,
    null,
  );

  // 快照同步：不在列表里的行会被删掉。
  await repository.save([]);
  assert.deepEqual(repository.load(), []);
});

test('Test 16：终态裁剪在 save 事务里删掉最老的终态行，活跃 Job 不受影响', async (t) => {
  const dir = await tempDir();
  const { queue, repository } = await makeQueue({ dir, maxTerminalJobs: 2 });
  cleanup(t, dir, [queue]);
  await queue.start();

  // 一个一直保持活跃的 Job（低优先级，不会被后面的 dequeue 取走）。
  await queue.enqueue(jobRequest('active', JOB_PRIORITY.LOW));

  for (const id of ['a', 'b', 'c']) {
    const { job } = await queue.enqueue(jobRequest(id, JOB_PRIORITY.HIGH));
    queue.dequeue();
    queue.complete(job.id);
  }
  await queue.flush();

  const loaded = repository.load();
  assert.deepEqual(
    loaded.map((job) => job.payload.screenshotId).sort(),
    ['active', 'b', 'c'],
    '最老的终态行 a 被裁剪，活跃 Job 保留',
  );
  assert.equal(loaded.filter((job) => job.status === AIJobStatus.COMPLETED).length, 2);
  assert.equal(queue.getJobs().length, 3, '内存与磁盘状态一致');
  assert.deepEqual(repository.load(), repository.load(), 'load() 是幂等的');
});
