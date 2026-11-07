'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AIJobType, AIJobStatus, JOB_PRIORITY } = require('../src/main/ai/job');
const { ERROR_CODES } = require('../src/main/ai/errors');
const { AIWorker } = require('../src/main/ai/AIWorker');
const { OllamaSummaryProvider } = require('../src/main/ai/summaryProvider');
const { SUMMARY_SCHEMA } = require('../src/main/ai/summaryOutput');
const { TimeBlockSummarizer, DEFAULT_SCAN_LIMIT } = require('../src/main/summary/TimeBlockSummarizer');
const { createBlock, blockKeyOf, blockStartOf } = require('../src/main/summary/timeBlock');
const { registerSummaryIpc, TIME_BLOCKS_CHANNEL, TIME_BLOCKS_FACETS_CHANNEL, SUMMARY_STATUS_CHANNEL } = require('../src/main/summaryIpc');
const { formatLocalIso } = require('../src/main/time');
const { tempDir, cleanup, makeQueue, fakeProvider, silentLog, waitFor } = require('./support');

function at(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second);
}

const ANALYSIS = {
  activity: '编写代码',
  summary: '在 VS Code 里编辑 recorder.js',
  category: 'coding',
  project: 'Life Lens',
  keywords: ['Electron'],
  confidence: 0.8,
};

const SUMMARY = {
  project: '写《2026 年中报告》',
  category: '工作',
  description: '这一时段主要在整理上半年数据。'.repeat(20),
  software: ['VS Code', 'Chrome'],
  todos: ['补充上半年的数据'],
};

// 一条已经分析完成的截图记录。
function completedRecord(id, date, overrides = {}) {
  return {
    id,
    time: formatLocalIso(date),
    imagePath: `C:/tmp/${id}.png`,
    model: 'fake-model',
    analysisMs: 5,
    analysisStatus: 'COMPLETED',
    error: null,
    errorCode: null,
    analysis: ANALYSIS,
    ...overrides,
  };
}

// 汇总链路的接线（与 main.js 里的一致），便于在测试里逐段断言。
function makeSummarizer({ queue, timeBlocks, activities, events = [] }) {
  const summarizer = new TimeBlockSummarizer({
    queue,
    timeBlocks,
    log: silentLog(),
    onEvent: (payload) => events.push(payload),
  });
  const provider = new OllamaSummaryProvider({
    ollamaHost: 'http://127.0.0.1:11434',
    model: 'qwen3-vl:8b',
    timeoutMs: 5000,
    loadContext: ({ blockStart, blockEnd }) => ({
      records: activities.listSummaryContext(blockStart, blockEnd),
      previous: timeBlocks.findPreviousSummary(blockStart),
    }),
  });
  return { summarizer, provider };
}

// Ollama 的两个入口都要应答：/api/tags 是健康检查，/api/chat 才是推理。
function stubOllama(t, { onChat, model = 'qwen3-vl:8b' } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/tags')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { models: [{ name: model }] };
        },
        async text() {
          return '';
        },
      };
    }
    return onChat(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

function chatResponse(content) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { message: { role: 'assistant', content } };
    },
    async text() {
      return '';
    },
  };
}

// ---- 扫描与入队 ----

test('汇总调度 1：启动补扫把「有记录、没汇总」的已结束区块排队', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();

  activities.createActivity(completedRecord('a', at(2026, 9, 15, 10, 3)));
  activities.createActivity(completedRecord('b', at(2026, 9, 15, 10, 12)));
  activities.createActivity(completedRecord('c', at(2026, 9, 15, 10, 29)));

  const events = [];
  const { summarizer } = makeSummarizer({ queue, timeBlocks, activities, events });
  // 「现在」固定在 10:25：当前区块是 10:20，所以它还没结束、不参与这次扫描。
  summarizer.now = () => at(2026, 9, 15, 10, 25);

  const result = await summarizer.scan();
  await queue.flush();

  assert.equal(result.scanned, 2);
  assert.equal(result.created, 2);
  assert.equal(result.skipped, 0);

  const jobs = queue.getJobs().filter((job) => job.type === AIJobType.TIMEBLOCK_SUMMARY);
  assert.deepEqual(jobs.map((job) => job.payload.blockStart), [
    formatLocalIso(at(2026, 9, 15, 10, 0)),
    formatLocalIso(at(2026, 9, 15, 10, 10)),
  ]);
  assert.deepEqual(jobs.map((job) => job.priority), [JOB_PRIORITY.LOW, JOB_PRIORITY.LOW]);

  // 区块行与任务一起落库：10:20 那个还没结束的区块不在这里。
  assert.equal(timeBlocks.getByStart(blockKeyOf(at(2026, 9, 15, 10, 0))).activityCount, 1);
  assert.equal(timeBlocks.getByStart(blockKeyOf(at(2026, 9, 15, 10, 10))).activityCount, 1);
  assert.equal(timeBlocks.getByStart(blockKeyOf(at(2026, 9, 15, 10, 20))), null);

  // 事件里带上「汇总中」需要的统计。
  const last = events.at(-1);
  assert.equal(last.type, 'summary');
  assert.equal(last.summary.stats.pending, 2);
});

test('汇总调度 2：重复扫描不会给同一个区块排两次队', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();

  activities.createActivity(completedRecord('a', at(2026, 9, 15, 10, 3)));

  const { summarizer } = makeSummarizer({ queue, timeBlocks, activities });
  summarizer.now = () => at(2026, 9, 15, 10, 30);

  const first = await summarizer.scan();
  const second = await summarizer.scan();

  assert.equal(first.created, 1);
  assert.deepEqual(second, { scanned: 0, created: 0, skipped: 0 });
  assert.equal(queue.getJobs().length, 1);
});

test('汇总调度 3：扫描并发保护（同一时刻只跑一次）', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();
  activities.createActivity(completedRecord('a', at(2026, 9, 15, 10, 3)));

  const { summarizer } = makeSummarizer({ queue, timeBlocks, activities });
  summarizer.now = () => at(2026, 9, 15, 10, 30);

  const [first, second] = await Promise.all([summarizer.scan(), summarizer.scan()]);
  const busy = [first, second].filter((result) => result.busy === true);
  assert.equal(busy.length, 1);
  assert.equal(queue.getJobs().length, 1);
});

test('汇总调度 4：扫描延迟对齐下一个区块边界', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  const { summarizer } = makeSummarizer({ queue, timeBlocks, activities });

  summarizer.scanDelayMs = 1000;
  summarizer.now = () => at(2026, 9, 15, 10, 7, 30);
  assert.equal(summarizer.nextDelayMs(), 2 * 60 * 1000 + 30 * 1000 + 1000, '10:10 + 1s');

  summarizer.now = () => at(2026, 9, 15, 10, 10, 0);
  assert.equal(summarizer.nextDelayMs(), 10 * 60 * 1000 + 1000, '正好在边界上：等下一个完整区块');
});

// ---- 结果回填 ----

test('汇总调度 5：handleResult / handleFailure 回填区块并更新统计', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();

  const events = [];
  const { summarizer } = makeSummarizer({ queue, timeBlocks, activities, events });
  summarizer.now = () => at(2026, 9, 15, 10, 30);

  const ok = createBlock(at(2026, 9, 15, 10, 0), { activityCount: 3 });
  const { job } = await queue.enqueueWithBlock(ok);

  summarizer.handleResult(job, { analysis: SUMMARY, model: 'qwen3-vl:8b', analysisMs: 1234 });
  const stored = timeBlocks.getByStart(ok.id);
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.project, SUMMARY.project);
  assert.equal(stored.category, SUMMARY.category);
  assert.deepEqual(stored.software, SUMMARY.software);
  assert.deepEqual(stored.todos, SUMMARY.todos);
  assert.equal(stored.analysisMs, 1234);

  const failed = createBlock(at(2026, 9, 15, 10, 10));
  const second = await queue.enqueueWithBlock(failed);
  summarizer.handleFailure(second.job, { message: 'AI 请求超时', code: ERROR_CODES.AI_TIMEOUT });
  const failedBlock = timeBlocks.getByStart(failed.id);
  assert.equal(failedBlock.status, 'FAILED');
  assert.equal(failedBlock.error, 'AI 请求超时');
  assert.equal(failedBlock.errorCode, ERROR_CODES.AI_TIMEOUT);

  assert.deepEqual(summarizer.snapshot().stats, { total: 2, completed: 1, failed: 1, pending: 0 });
  assert.equal(events.at(-1).summary.stats.failed, 1);
});

test('汇总调度 6：找不到区块时的回填只记日志，不抛错', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);

  const { summarizer } = makeSummarizer({ queue, timeBlocks, activities });
  assert.doesNotThrow(() => summarizer.handleResult(
    { id: 'job-x', payload: { blockStart: formatLocalIso(at(2026, 9, 15, 10, 0)) } },
    { analysis: SUMMARY },
  ));
  assert.doesNotThrow(() => summarizer.handleFailure(
    { id: 'job-x', payload: { blockStart: formatLocalIso(at(2026, 9, 15, 10, 0)) } },
    { message: '失败', code: ERROR_CODES.UNKNOWN },
  ));
});

// ---- 端到端：扫描 -> 任务 -> 文本 Provider -> 回填 ----

test('汇总调度 7：区块任务走文本 Provider，素材来自数据库', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir, retryDelaysMs: [5, 5, 5] });
  await queue.start();

  activities.createActivity(completedRecord('a', at(2026, 9, 15, 10, 3)));
  activities.createActivity(completedRecord('b', at(2026, 9, 15, 10, 6), {
    analysis: { ...ANALYSIS, activity: '阅读文档' },
  }));

  const { summarizer, provider } = makeSummarizer({ queue, timeBlocks, activities });
  summarizer.now = () => at(2026, 9, 15, 10, 30);

  let prompt = null;
  stubOllama(t, {
    onChat: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.format, SUMMARY_SCHEMA, '汇总请求带上自己的 Schema');
      prompt = body.messages[0].content;
      return chatResponse(JSON.stringify(SUMMARY));
    },
  });

  const worker = new AIWorker({
    queue,
    // 截图分析用假 Provider（本用例不会用到），区块汇总走真实 Provider + 打桩的 HTTP。
    provider: fakeProvider(),
    providers: { [AIJobType.TIMEBLOCK_SUMMARY]: provider },
    log: silentLog(),
    healthPollMs: 10,
    onCompleted: (job, result) => summarizer.handleResult(job, result),
    onFailed: (job, error) => summarizer.handleFailure(job, error),
  });
  cleanup(t, dir, [worker, queue]);
  worker.start();

  const scan = await summarizer.scan();
  assert.equal(scan.created, 1);

  const key = blockKeyOf(at(2026, 9, 15, 10, 0));
  await waitFor(() => timeBlocks.getByStart(key).status === 'COMPLETED');
  await waitFor(() => queue.getJob(queue.getJobs()[0].id).status === AIJobStatus.COMPLETED);

  // 提示词里的素材确实来自 activities 表。
  assert.ok(prompt.includes('时间段：10:00–10:10'));
  assert.ok(prompt.includes('编写代码'));
  assert.ok(prompt.includes('阅读文档'));

  const stored = timeBlocks.getByStart(key);
  assert.equal(stored.project, SUMMARY.project);
  assert.equal(stored.analysisMs >= 0, true);
});

// ---- 快照与 IPC ----

test('汇总调度 8：snapshot 的扫描标记与汇总中统计', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);

  const { summarizer } = makeSummarizer({ queue, timeBlocks, activities });
  assert.deepEqual(summarizer.snapshot(), {
    running: false,
    scanning: false,
    blockMinutes: 10,
    stats: { total: 0, completed: 0, failed: 0, pending: 0 },
  });

  summarizer.running = true;
  assert.equal(summarizer.snapshot().running, true);
  assert.equal(DEFAULT_SCAN_LIMIT, 144);
});

test('汇总调度 9：IPC 契约（通道与委派）', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();

  activities.createActivity(completedRecord('a', at(2026, 9, 15, 10, 3)));
  const { summarizer } = makeSummarizer({ queue, timeBlocks, activities });
  summarizer.now = () => at(2026, 9, 15, 10, 30);
  await summarizer.scan();

  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  registerSummaryIpc({ ipcMain, timeBlocks, summarizer });

  assert.deepEqual([...handlers.keys()], [TIME_BLOCKS_CHANNEL, TIME_BLOCKS_FACETS_CHANNEL, SUMMARY_STATUS_CHANNEL]);
  assert.equal(TIME_BLOCKS_CHANNEL, 'lifelens:time-blocks');

  const page = handlers.get(TIME_BLOCKS_CHANNEL)({}, { limit: 5 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].status, 'PENDING');
  assert.equal(page.total, 1);

  const facets = handlers.get(TIME_BLOCKS_FACETS_CHANNEL)({});
  assert.deepEqual(facets, { projects: [], software: [] });

  const status = handlers.get(SUMMARY_STATUS_CHANNEL)({});
  assert.equal(status.stats.pending, 1);
  assert.equal(status.blockMinutes, 10);
});

test('汇总调度 10：汇总任务被强杀后重启能恢复完成，且不会重复排队', async (t) => {
  const dir = await tempDir();
  const key = blockKeyOf(at(2026, 9, 15, 10, 0));

  // ---- 第一次运行：区块排队后被强杀，任务停在 PROCESSING ----
  const first = await makeQueue({ dir });
  await first.queue.start();
  first.activities.createActivity(completedRecord('a', at(2026, 9, 15, 10, 3)));

  const { summarizer } = makeSummarizer({
    queue: first.queue, timeBlocks: first.timeBlocks, activities: first.activities,
  });
  summarizer.now = () => at(2026, 9, 15, 10, 30);
  assert.equal((await summarizer.scan()).created, 1);

  const killed = first.queue.dequeue();
  assert.equal(killed.type, AIJobType.TIMEBLOCK_SUMMARY);
  // 区块行是在入队事务里写的：任务还没跑完，区块已经存在，状态是 PENDING（界面上的「汇总中」）。
  assert.equal(first.timeBlocks.getByStart(key).status, 'PENDING');
  first.queue.stop();

  // ---- 第二次运行：同一个数据库上重建队列，队列启动时恢复未完成的任务 ----
  const second = await makeQueue({ dir });
  await second.queue.start();

  const recovered = second.queue.getJobs().find((job) => job.type === AIJobType.TIMEBLOCK_SUMMARY);
  assert.equal(recovered.status, AIJobStatus.PENDING, '停在 PROCESSING 的汇总任务恢复为 PENDING');
  assert.deepEqual(recovered.payload, killed.payload, 'payload（区块起点）跟着任务一起落了库');
  assert.equal(recovered.payload.blockStart, key);

  const resumed = makeSummarizer({
    queue: second.queue, timeBlocks: second.timeBlocks, activities: second.activities,
  });
  resumed.summarizer.now = () => at(2026, 9, 15, 10, 30);
  // 区块行已经存在，缺口扫描不该再给同一个区块排一次队。
  assert.equal((await resumed.summarizer.scan()).scanned, 0);
  assert.equal(second.queue.getJobs().length, 1);

  stubOllama(t, { onChat: async () => chatResponse(JSON.stringify(SUMMARY)) });
  const worker = new AIWorker({
    queue: second.queue,
    provider: fakeProvider(),
    providers: { [AIJobType.TIMEBLOCK_SUMMARY]: resumed.provider },
    log: silentLog(),
    healthPollMs: 10,
    onCompleted: (job, result) => resumed.summarizer.handleResult(job, result),
    onFailed: (job, error) => resumed.summarizer.handleFailure(job, error),
  });
  cleanup(t, dir, [worker, second.queue]);
  worker.start();

  await waitFor(() => second.timeBlocks.getByStart(key).status === 'COMPLETED');
  const stored = second.timeBlocks.getByStart(key);
  assert.equal(stored.project, SUMMARY.project);
  assert.deepEqual(stored.software, SUMMARY.software);
  assert.equal(stored.analysisMs >= 0, true);
});
