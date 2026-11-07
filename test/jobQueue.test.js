'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AIJobStatus, AIJobType } = require('../src/main/ai/job');
const { AIJobRepository } = require('../src/main/db/repositories/AIJobRepository');
const { AIJobQueueService } = require('../src/main/ai/AIJobQueueService');
const { ActivityRepository } = require('../src/main/db/repositories/ActivityRepository');
const { makeQueue, silentLog, cleanup, openTestDb } = require('./support');

function shot(overrides = {}) {
  return {
    type: AIJobType.SCREENSHOT_ANALYSIS,
    payload: {
      screenshotId: 'shot-1',
      imagePath: 'C:/tmp/shot-1.png',
      capturedAt: '2026-09-13T10:00:00+08:00',
    },
    ...overrides,
  };
}

test('Test 1：PENDING -> PROCESSING -> COMPLETED，统计与落盘都正确', async (t) => {
  const { queue, repository, dir } = await makeQueue();
  cleanup(t, dir, [queue]);
  await queue.start();

  const { job, created } = await queue.enqueue(shot());
  assert.equal(created, true);
  assert.equal(job.status, AIJobStatus.PENDING);
  assert.equal(job.priority, 5);
  assert.deepEqual(queue.getStats(), {
    pending: 1, processing: 0, completed: 0, failed: 0, retrying: 0, cancelled: 0, total: 1,
  });

  const taken = queue.dequeue();
  assert.equal(taken.id, job.id);
  assert.equal(taken.status, AIJobStatus.PROCESSING);
  assert.equal(queue.getStats().processing, 1);
  assert.equal(queue.getPendingJobs().length, 0);

  assert.equal(queue.complete(job.id).status, AIJobStatus.COMPLETED);
  assert.equal(queue.getStats().completed, 1);
  assert.equal(queue.snapshot().current, null);

  // 状态变更必须已经写进磁盘（重启恢复依赖它）。
  await queue.flush();
  const saved = repository.load();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, AIJobStatus.COMPLETED);
});

test('高优先级任务先被取出', async (t) => {
  const { queue, dir } = await makeQueue();
  cleanup(t, dir, [queue]);
  await queue.start();

  await queue.enqueue(shot({ payload: { screenshotId: 'low' }, priority: 1 }));
  await queue.enqueue(shot({ payload: { screenshotId: 'high' }, priority: 10 }));
  await queue.enqueue(shot({ payload: { screenshotId: 'normal' }, priority: 5 }));

  assert.equal(queue.dequeue().payload.screenshotId, 'high');
  assert.equal(queue.dequeue().payload.screenshotId, 'normal');
  assert.equal(queue.dequeue().payload.screenshotId, 'low');
});

test('Test 4：同一张截图不会产生重复 Job，完成后的重复入队需要显式 force', async (t) => {
  const { queue, dir } = await makeQueue();
  cleanup(t, dir, [queue]);
  await queue.start();

  const first = await queue.enqueue(shot());
  const second = await queue.enqueue(shot());
  assert.equal(second.created, false);
  assert.equal(second.reason, 'DUPLICATE_ACTIVE');
  assert.equal(second.job.id, first.job.id);
  assert.equal(queue.getJobs().length, 1);

  queue.dequeue();
  const third = await queue.enqueue(shot());
  assert.equal(third.created, false);
  assert.equal(third.reason, 'DUPLICATE_ACTIVE', 'PROCESSING 中也不能重复创建');

  queue.complete(first.job.id);
  const fourth = await queue.enqueue(shot());
  assert.equal(fourth.created, false);
  assert.equal(fourth.reason, 'ALREADY_COMPLETED');
  assert.equal(queue.getPendingJobs().length, 0);

  const forced = await queue.enqueue(shot({ force: true }));
  assert.equal(forced.created, true);
  assert.notEqual(forced.job.id, first.job.id);
});

test('非法状态跳转一律被拒绝（COMPLETED 不能回到 PROCESSING）', async (t) => {
  const { queue, dir } = await makeQueue();
  cleanup(t, dir, [queue]);
  await queue.start();

  const { job } = await queue.enqueue(shot());
  assert.equal(queue.complete(job.id), null, 'PENDING 不能直接 COMPLETED');
  assert.equal(queue.getJob(job.id).status, AIJobStatus.PENDING);

  queue.dequeue();
  queue.complete(job.id);
  assert.equal(queue.cancel(job.id).status, AIJobStatus.COMPLETED, 'COMPLETED 不能取消');
  assert.equal(queue.fail(job.id, { code: 'X', message: 'x' }), null);
  assert.equal(queue.dequeue(), null);
});

test('重试：PROCESSING -> RETRYING -> 退避后回到 PENDING', async (t) => {
  const { queue, dir } = await makeQueue({ retryDelaysMs: [10, 10, 10] });
  cleanup(t, dir, [queue]);
  await queue.start();

  const { job } = await queue.enqueue(shot());
  queue.dequeue();
  const retrying = queue.scheduleRetry(job.id, { code: 'AI_TIMEOUT', message: '超时' });
  assert.equal(retrying.status, AIJobStatus.RETRYING);
  assert.equal(retrying.retryCount, 1);
  assert.equal(queue.getStats().retrying, 1);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(queue.getJob(job.id).status, AIJobStatus.PENDING);
  assert.equal(queue.getJob(job.id).retryCount, 1);
});

test('取消：PENDING 可以取消，取消后不会被取出', async (t) => {
  const { queue, dir } = await makeQueue();
  cleanup(t, dir, [queue]);
  await queue.start();

  const { job } = await queue.enqueue(shot());
  assert.equal(queue.cancel(job.id).status, AIJobStatus.CANCELLED);
  assert.equal(queue.getStats().cancelled, 1);
  assert.equal(queue.dequeue(), null);
});

test('手动 retry：FAILED 回到 PENDING 并重置重试次数', async (t) => {
  const { queue, dir } = await makeQueue();
  cleanup(t, dir, [queue]);
  await queue.start();

  const { job } = await queue.enqueue(shot());
  queue.dequeue();
  queue.fail(job.id, { code: 'MODEL_NOT_FOUND', message: '没有模型' });
  assert.equal(queue.getJob(job.id).status, AIJobStatus.FAILED);

  const retried = queue.retry(job.id);
  assert.equal(retried.status, AIJobStatus.PENDING);
  assert.equal(retried.retryCount, 0);
  assert.equal(retried.error, null);
  assert.equal(queue.getStats().pending, 1);
});

test('Test 5：Electron 重启后 PROCESSING / RETRYING 恢复为 PENDING', async (t) => {
  const { queue, dir } = await makeQueue();
  const cleaners = [queue];
  cleanup(t, dir, cleaners);
  await queue.start();

  const first = await queue.enqueue(shot({ payload: { screenshotId: 'a' } }));
  const second = await queue.enqueue(shot({ payload: { screenshotId: 'b' } }));
  queue.dequeue();
  queue.dequeue();
  queue.scheduleRetry(second.job.id, { code: 'AI_TIMEOUT', message: '超时' });
  await queue.flush();
  queue.stop();

  // 模拟进程重启：同一个数据库文件上用新的连接与 Queue 重新加载。
  const db = openTestDb(dir);
  const activities = new ActivityRepository({ db, log: silentLog() });
  const restarted = new AIJobQueueService({
    repository: new AIJobRepository({ db, activities, log: silentLog() }),
    activities,
    log: silentLog(),
    retryDelaysMs: [5, 5, 5],
  });
  cleaners.push(restarted);
  await restarted.start();

  assert.equal(restarted.getJob(first.job.id).status, AIJobStatus.PENDING);
  assert.equal(restarted.getJob(second.job.id).status, AIJobStatus.PENDING);
  assert.equal(restarted.getJob(first.job.id).startedAt, null);
  assert.equal(restarted.getStats().pending, 2);
});

test('Pause / Resume：暂停时取不出任务，恢复后可以继续', async (t) => {
  const { queue, dir } = await makeQueue();
  cleanup(t, dir, [queue]);
  await queue.start();
  await queue.enqueue(shot());

  queue.pause();
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.getStats().pending, 1, '暂停期间任务保留在队列里');

  let woken = false;
  queue.once('wake', () => { woken = true; });
  queue.resume();
  assert.equal(woken, true);
  assert.ok(queue.dequeue());
});

test('reanalyzeScreenshot：为历史截图重建高优先级任务', async (t) => {
  const { queue, dir } = await makeQueue();
  cleanup(t, dir, [queue]);
  await queue.start();

  const { job } = await queue.enqueue(shot());
  queue.dequeue();
  queue.complete(job.id);

  const again = await queue.reanalyzeScreenshot('shot-1');
  assert.equal(again.created, true);
  assert.equal(again.job.priority, 10);
  assert.equal(again.job.payload.imagePath, 'C:/tmp/shot-1.png');

  const missing = await queue.reanalyzeScreenshot('不存在');
  assert.equal(missing.created, false);
  assert.equal(missing.reason, 'SCREENSHOT_NOT_FOUND');
});

test('whenIdle：队列清空后立即返回', async (t) => {
  const { queue, dir } = await makeQueue();
  cleanup(t, dir, [queue]);
  await queue.start();
  await queue.whenIdle();

  const { job } = await queue.enqueue(shot());
  let idle = false;
  const waiting = queue.whenIdle().then(() => { idle = true; });
  assert.equal(idle, false);
  queue.dequeue();
  queue.complete(job.id);
  await waiting;
  assert.equal(idle, true);
});

test('终态任务过多时按上限裁剪，活跃任务不受影响', async (t) => {
  const { queue, dir } = await makeQueue({ maxTerminalJobs: 2 });
  cleanup(t, dir, [queue]);
  await queue.start();

  for (const id of ['a', 'b', 'c']) {
    const { job } = await queue.enqueue(shot({ payload: { screenshotId: id } }));
    queue.dequeue();
    queue.complete(job.id);
  }
  assert.equal(queue.getStats().completed, 2);
  assert.equal(queue.getJob(queue.getJobs()[0].id).status, AIJobStatus.COMPLETED);
  assert.equal(queue.getJobs().length, 2);
});
