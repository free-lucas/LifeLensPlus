'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { Store } = require('../src/main/store');
const { Recorder } = require('../src/main/recorder');
const { AIWorker } = require('../src/main/ai/AIWorker');
const {
  AIJobType, AIJobStatus, JOB_PRIORITY, createJob,
} = require('../src/main/ai/job');
const {
  tempDir, cleanup, makeQueue, fakeProvider, fakeCapture, waitFor, silentLog,
} = require('./support');

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

test('Test 6：Activity 与 Job 是同一个事务，Job 写失败时 Activity 一起回滚', async (t) => {
  const dir = await tempDir();
  const { activities } = await makeQueue({ dir });
  cleanup(t, dir);

  const job = createJob({
    type: AIJobType.SCREENSHOT_ANALYSIS,
    payload: { screenshotId: 's1', imagePath: 'C:/tmp/s1.png' },
  });
  const activityId = activities.insertActivityWithJob(activityRecord('s1'), job);
  assert.ok(activityId > 0);

  // 再用同一个 Job（主键冲突）写一条新记录：Activity 已经插进去了，也必须整体回滚。
  assert.throws(() => activities.insertActivityWithJob(activityRecord('s2'), job), /UNIQUE/);

  assert.equal(activities.getByScreenshotId('s2'), null, '失败事务里的 Activity 不留在库里');
  assert.equal(activities.listRecent(10).length, 1, '只有第一次成功的那条记录');
});

test('Test 6b：数据库写入失败时删掉刚保存的截图，截图循环不中断', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();

  // 固定截图路径，并预先占掉这个 screenshot_id：事务一定在 UNIQUE 约束上失败。
  const imagePath = path.join(store.imageDir(new Date()), 'fixed-shot.png');
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, 'png');
  activities.createActivity({ ...activityRecord('fixed-shot'), imagePath });

  const failingStore = {
    imageDir: store.imageDir.bind(store),
    saveImage: async () => imagePath,
  };
  const recorder = new Recorder({
    store: failingStore,
    activities,
    config: { intervalMs: 20, model: 'fake-model', outputDir: dir },
    onEvent: () => {},
    aiQueue: queue,
    capture: fakeCapture(),
    log: silentLog(),
  });
  cleanup(t, dir, [recorder, queue]);
  recorder.start();

  await waitFor(() => recorder.lastError && recorder.status.busy === false);

  assert.match(recorder.lastError, /UNIQUE/);
  assert.equal(recorder.count, 0, '失败的那一轮不算新记录');
  assert.equal(activities.listRecent(10).length, 1, '库里只有预置的那条记录');
  assert.equal(recorder.status.running, true, '截图循环继续运行，没有被数据库故障拖死');
  await assert.rejects(fs.stat(imagePath), '数据库失败后刚写的截图被删除，不留孤儿');
});

test('Test 7：重启后 PROCESSING / RETRYING 恢复为 PENDING，并最终完成', async (t) => {
  const dir = await tempDir();
  const { queue, activities, db } = await makeQueue({ dir, retryDelaysMs: [10000, 10000, 10000] });
  await queue.start();

  const first = await queue.enqueue(jobRequest('a', JOB_PRIORITY.HIGH));
  const second = await queue.enqueue(jobRequest('b', JOB_PRIORITY.HIGH));
  queue.dequeue();
  queue.dequeue();
  queue.scheduleRetry(second.job.id, { code: 'AI_TIMEOUT', message: '超时' });
  await queue.flush();

  const before = new Map(db.prepare('SELECT id, status FROM ai_jobs').all().map((row) => [row.id, row.status]));
  assert.equal(before.get(first.job.id), AIJobStatus.PROCESSING);
  assert.equal(before.get(second.job.id), AIJobStatus.RETRYING);

  // 模拟被强杀：进程结束，内存里的队列与退避计时器一起消失。
  queue.stop();

  // 重新启动：同一个数据库上重建队列。
  const restarted = await makeQueue({ dir, db, activities });
  await restarted.queue.start();

  assert.equal(restarted.queue.getJob(first.job.id).status, AIJobStatus.PENDING);
  assert.equal(restarted.queue.getJob(second.job.id).status, AIJobStatus.PENDING);
  assert.equal(restarted.queue.getJob(first.job.id).startedAt, null, 'PROCESSING 的痕迹被清掉');

  const recovered = new Map(
    restarted.repository.load().map((job) => [job.id, job.status]),
  );
  assert.equal(recovered.get(first.job.id), AIJobStatus.PENDING, '恢复状态也写回了磁盘');
  assert.equal(recovered.get(second.job.id), AIJobStatus.PENDING);

  // 恢复之后 Worker 能正常把它们跑完。
  const worker = new AIWorker({
    queue: restarted.queue,
    provider: fakeProvider(),
    log: silentLog(),
    healthPollMs: 10,
  });
  cleanup(t, dir, [worker, restarted.queue, queue]);
  worker.start();

  await waitFor(() => restarted.queue.getStats().completed === 2);
  await restarted.queue.flush();
  const finished = new Map(
    restarted.repository.load().map((job) => [job.id, job.status]),
  );
  assert.equal(finished.get(first.job.id), AIJobStatus.COMPLETED);
  assert.equal(finished.get(second.job.id), AIJobStatus.COMPLETED);
});

test('Test 8：重新分析会为同一张截图新建 Job，不被数据库约束挡住', async (t) => {
  const dir = await tempDir();
  const { queue, activities, db } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();

  const { job } = await queue.enqueueWithActivity(activityRecord('s1'));
  queue.dequeue();
  queue.complete(job.id);
  await queue.flush();

  const again = await queue.reanalyzeScreenshot('s1');
  assert.equal(again.created, true, '重新分析不会被 UNIQUE constraint 阻止');
  assert.equal(again.job.status, AIJobStatus.PENDING);
  assert.equal(again.job.priority, JOB_PRIORITY.HIGH);
  assert.equal(again.job.payload.imagePath, 'C:/tmp/s1.png', '沿用原 Job 的 payload');
  await queue.flush();

  const activityId = activities.findIdByScreenshotId('s1');
  const rows = db.prepare('SELECT status, activity_id FROM ai_jobs ORDER BY rowid').all();
  assert.equal(rows.length, 2, '同一张截图可以有多条分析任务');
  assert.deepEqual(rows.map((row) => row.activity_id), [activityId, activityId]);
  assert.deepEqual(rows.map((row) => row.status), [AIJobStatus.COMPLETED, AIJobStatus.PENDING]);
});
