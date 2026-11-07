'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AIJobType, AIJobStatus, JOB_PRIORITY } = require('../src/main/ai/job');
const { AIError, ERROR_CODES } = require('../src/main/ai/errors');
const { AIWorker } = require('../src/main/ai/AIWorker');
const { OllamaDiaryProvider, DIARY_NUM_PREDICT } = require('../src/main/ai/diaryProvider');
const {
  DIARY_SCHEMA,
  MAX_MAIN_EVENTS,
  MAX_CONTEXT_CHARS,
  MIN_SUMMARY_LENGTH,
  buildDiarySegments,
  buildDiaryPrompt,
  buildContextLines,
  normalizeDiaryResult,
  describeDiary,
  describeDistribution,
  formatMinutes,
} = require('../src/main/ai/diaryOutput');
const { DiaryGenerator, DEFAULT_SCAN_LIMIT } = require('../src/main/diary/DiaryGenerator');
const {
  registerDiaryIpc,
  DIARY_CHANNEL,
  DIARY_DAYS_CHANNEL,
  DIARY_STATUS_CHANNEL,
  DIARY_REGENERATE_CHANNEL,
} = require('../src/main/diaryIpc');
const { dayBounds, dayKeyOf, dayLabel, dayEndOf, parseDayKey, shiftDayKey } = require('../src/main/day');
const { createBlock, BLOCK_MINUTES } = require('../src/main/summary/timeBlock');
const { formatLocalIso } = require('../src/main/time');
const { tempDir, cleanup, makeQueue, silentLog, waitFor } = require('./support');

function at(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second);
}

const DIARY = {
  summary: '这一天主要在写《2026 年中报告》，上午整理数据，下午把结论补进报告里，中途被打断了两次。',
  mainEvents: ['写《2026 年中报告》', '整理上半年数据'],
  highlights: ['一口气写完了报告初稿'],
  todos: ['补充上半年的数据'],
  suggestions: ['把整理数据挪到上午做'],
  tips: ['记得每小时起来活动一下'],
};

function validDiary(overrides = {}) {
  return JSON.stringify({ ...DIARY, ...overrides });
}

function expectInvalidResult(raw) {
  assert.throws(
    () => normalizeDiaryResult(raw),
    (error) => error.code === ERROR_CODES.INVALID_RESULT,
  );
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

// 一条已经汇总完成的 10 分钟区块（直接写库，不经过 AI）。
async function completeBlock(queue, timeBlocks, date, summary = {}) {
  const block = createBlock(date, { activityCount: 2 });
  await queue.enqueueWithBlock(block, { priority: JOB_PRIORITY.LOW });
  timeBlocks.updateSummary(block.id, {
    status: 'COMPLETED',
    summary: {
      project: '写《2026 年中报告》',
      category: '工作',
      description: '这一时段主要在整理上半年数据，并把结论补进报告里。'.repeat(3),
      software: ['Word'],
      todos: [],
      ...summary,
    },
    model: 'fake-model',
    analysisMs: 10,
  });
  return block;
}

// ---- 日期口径 ----

test('日记 1：本地日期键的口径与 block_start / captured_at 一致', () => {
  assert.equal(dayKeyOf(at(2026, 9, 15, 23, 59)), '2026-09-15');
  assert.equal(dayKeyOf('2026-09-15T10:07:23+08:00'), '2026-09-15', '本地 ISO 取前 10 个字符');
  assert.equal(dayKeyOf('2026-09-15'), '2026-09-15');
  assert.equal(dayKeyOf(null), null);
  assert.equal(dayKeyOf('不是时间'), null);

  const bounds = dayBounds('2026-09-15');
  assert.deepEqual(bounds, {
    from: '2026-09-15T00:00:00+08:00',
    to: '2026-09-16T00:00:00+08:00',
  });
  assert.equal(dayEndOf(at(2026, 9, 15, 8)).getDate(), 16);
  assert.equal(dayEndOf(at(2026, 12, 31, 8)).getFullYear(), 2027, '跨年');
  assert.equal(dayEndOf(at(2026, 1, 31, 8)).getMonth(), 1, '跨月');

  assert.equal(dayLabel('2026-09-15'), '2026年9月15日 周二');
  assert.equal(shiftDayKey('2026-09-01', -1), '2026-08-31');
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31');

  // 严格校验：不放过宽松写法与不存在的日期。
  assert.equal(parseDayKey('2026-9-5'), null);
  assert.equal(parseDayKey('2026-02-31'), null);
  assert.ok(parseDayKey('2026-02-28') instanceof Date);
});

// ---- Schema 与校验 ----

test('日记 2：Schema 的字段与需求一一对应', () => {
  assert.deepEqual(DIARY_SCHEMA.required, [
    'summary', 'mainEvents', 'highlights', 'todos', 'suggestions', 'tips',
  ]);
  assert.equal(DIARY_SCHEMA.properties.mainEvents.maxItems, MAX_MAIN_EVENTS);
  assert.equal(MAX_MAIN_EVENTS, 3, '需求要的是「三件做的最主要的事情」');
  assert.equal(DIARY_SCHEMA.additionalProperties, false);
});

test('日记 3：合法结果被归一化（trim / 去重 / 截断）', () => {
  const result = normalizeDiaryResult(validDiary({
    mainEvents: [' 写报告 ', '写报告', '整理数据', '第三件事', '第四件事'],
    highlights: [],
    tips: ['  记得喝水  '],
  }));

  assert.deepEqual(result.mainEvents, ['写报告', '整理数据', '第三件事'], '最多三条且去重');
  assert.deepEqual(result.highlights, []);
  assert.deepEqual(result.tips, ['记得喝水']);
  assert.ok(result.summary.length >= MIN_SUMMARY_LENGTH);
});

test('日记 4：非法结果按 INVALID_RESULT 处理（可重试）', () => {
  expectInvalidResult(validDiary({ summary: '太短' }));
  expectInvalidResult(validDiary({ summary: 123 }));
  expectInvalidResult(validDiary({ mainEvents: [] }));
  expectInvalidResult(validDiary({ mainEvents: '写报告' }));
  expectInvalidResult(validDiary({ highlights: [123] }));
  expectInvalidResult('不是 JSON');
  expectInvalidResult('');

  // 单条过长只截断，不判失败。
  const long = normalizeDiaryResult(validDiary({ tips: ['提'.repeat(500)] }));
  assert.ok(long.tips[0].length < 500);
});

// ---- 上下文压缩 ----

test('日记 5：相邻的同项目区块合并成时段，跨项目 / 断档各自成段', () => {
  const make = (hour, minute, project, category = '工作') => ({
    id: 'x',
    start: formatLocalIso(at(2026, 9, 15, hour, minute)),
    end: formatLocalIso(at(2026, 9, 15, hour, minute + BLOCK_MINUTES)),
    status: 'COMPLETED',
    category,
    project,
    software: ['Word'],
    todos: [],
    description: `${project} 的说明`,
  });

  const segments = buildDiarySegments([
    make(9, 0, '写《报告》'),
    make(9, 10, '写《报告》'),
    make(9, 20, '写《报告》'),
    make(9, 30, '看文档', '学习'),
    make(9, 40, '看文档', '学习'),
    // 中间缺了 10 分钟：断档不再合并
    make(10, 0, '看文档', '学习'),
    // 没有分类的区块（还没汇总完 / 汇总失败）不进日记
    { start: '2026-09-15T10:10:00+08:00', end: '2026-09-15T10:20:00+08:00', status: 'FAILED', category: null, project: null },
  ]);

  assert.equal(segments.length, 3);
  assert.equal(segments[0].blocks, 3);
  assert.equal(segments[0].minutes, 3 * BLOCK_MINUTES);
  assert.equal(segments[1].blocks, 2);
  assert.equal(segments[2].blocks, 1, '断档之后是新的时段');
  assert.equal(segments[0].software.length, 1, '软件名去重');
  assert.equal(
    new Date(segments[0].startMs).getHours() * 60 + new Date(segments[0].startMs).getMinutes(),
    9 * 60,
  );
  assert.equal(formatMinutes(segments[0].minutes), '30 分钟');
  assert.deepEqual(buildDiarySegments([]), []);
});

test('日记 6：提示词带时长分布、上一天摘要与要求；超预算时逐段降级', () => {
  const blocks = [];
  for (let index = 0; index < 30; index += 1) {
    const start = at(2026, 9, 15, 9, 0);
    const from = new Date(start.getTime() + index * BLOCK_MINUTES * 60000);
    blocks.push({
      id: `b${index}`,
      start: formatLocalIso(from),
      end: formatLocalIso(new Date(from.getTime() + BLOCK_MINUTES * 60000)),
      status: 'COMPLETED',
      category: index < 20 ? '工作' : '娱乐',
      project: index < 20 ? '写《报告》' : '玩《游戏》',
      software: ['Word'],
      todos: [],
      description: '描述内容'.repeat(20),
    });
  }
  blocks.push({ start: '2026-09-15T14:00:00+08:00', end: '2026-09-15T14:10:00+08:00', status: 'FAILED', category: null });

  const prompt = buildDiaryPrompt({
    day: '2026-09-15',
    blocks,
    previous: { day: '2026-09-14', summary: '昨天在整理数据。', mainEvents: ['整理数据'] },
  });

  assert.ok(prompt.includes('日期：2026年9月15日 周二'));
  assert.ok(prompt.includes('【这一天的时长分布】工作 3 小时 20 分（20 段）、娱乐 1 小时 40 分（10 段）'));
  assert.ok(prompt.includes('【上一天（2026-09-14）的日记】'));
  assert.ok(prompt.includes('【这一天的记录】共 2 段'));
  assert.ok(prompt.includes('09:00–12:20'), '同时段合并成一段');
  assert.ok(prompt.includes('这一天还有 1 个时间段汇总失败'));
  assert.ok(prompt.includes('mainEvents'));
  assert.ok(!prompt.includes('"summary"'), 'Prompt 里不描述 JSON 结构');

  // 字符预算：满员的一天（144 段、每段都有描述）也不能超出预算太多。
  const dense = [];
  for (let index = 0; index < 144; index += 1) {
    const from = new Date(at(2026, 9, 15, 0, 0).getTime() + index * BLOCK_MINUTES * 60000);
    dense.push({
      start: formatLocalIso(from),
      end: formatLocalIso(new Date(from.getTime() + BLOCK_MINUTES * 60000)),
      status: 'COMPLETED',
      category: '工作',
      project: `项目${index}`,
      software: ['Word'],
      todos: [],
      description: '很长的描述'.repeat(60),
    });
  }
  const densePrompt = buildDiaryPrompt({ day: '2026-09-15', blocks: dense });
  assert.ok(densePrompt.length < MAX_CONTEXT_CHARS + 4000, `提示词 ${densePrompt.length} 应受预算约束`);
  assert.ok(
    (densePrompt.match(/描述：/g) ?? []).length < 144,
    '预算不够时后面的时段不再带描述',
  );

  // 预算极小时直接丢掉整段，并如实说明。
  const { lines, dropped } = buildContextLines(buildDiarySegments(dense), 300);
  assert.ok(dropped > 100);
  assert.ok(lines.length > 0);
  assert.equal(describeDistribution(buildDiarySegments([])), '这一天没有可用的汇总数据');
});

// ---- Provider ----

test('日记 7：Provider 走文本 Schema、关掉思考并返回结构化结果', async (t) => {
  const requests = [];
  stubOllama(t, {
    onChat: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return chatResponse(validDiary());
    },
  });

  const activityBlocks = [1, 2].map((index) => ({
    id: `b${index}`,
    start: formatLocalIso(at(2026, 9, 15, 9, index * 10)),
    end: formatLocalIso(at(2026, 9, 15, 9, index * 10 + 10)),
    status: 'COMPLETED',
    category: '工作',
    project: '写《报告》',
    software: ['Word'],
    todos: [],
    description: '整理数据',
  }));

  const provider = new OllamaDiaryProvider({
    ollamaHost: 'http://127.0.0.1:11434',
    model: 'qwen3-vl:8b',
    timeoutMs: 5000,
    numCtx: 16384,
    loadContext: () => ({ blocks: activityBlocks, previous: null }),
  });

  const result = await provider.analyze({
    id: 'job-1',
    payload: { day: '2026-09-15', from: '2026-09-15T00:00:00+08:00', to: '2026-09-16T00:00:00+08:00' },
  });

  assert.equal(requests.length, 1);
  const body = requests[0].body;
  assert.equal(body.model, 'qwen3-vl:8b');
  assert.deepEqual(body.format.required, DIARY_SCHEMA.required);
  assert.equal(body.think, false, '必须关掉思考，否则正文写不出来');
  assert.equal(body.options.num_predict, DIARY_NUM_PREDICT);
  assert.equal(body.options.num_ctx, 16384);
  assert.equal(body.messages[0].images, undefined, '日记是纯文本任务，不带图片');
  assert.ok(body.messages[0].content.includes('2026年9月15日'));

  assert.deepEqual(result.analysis, DIARY);
  assert.equal(result.day, '2026-09-15');
  assert.equal(result.blockCount, 2);
  assert.equal(result.logLine, describeDiary(DIARY));
  assert.ok(!result.logLine.includes(DIARY.summary), '日志不带正文');
});

test('日记 8：Provider 缺日期或返回空内容时按可重试错误处理', async (t) => {
  const provider = new OllamaDiaryProvider({
    ollamaHost: 'http://127.0.0.1:11434',
    model: 'qwen3-vl:8b',
    timeoutMs: 5000,
    loadContext: () => ({ blocks: [], previous: null }),
  });

  await assert.rejects(
    () => provider.analyze({ id: 'job-1', payload: {} }),
    (error) => error.code === ERROR_CODES.INVALID_RESULT,
  );

  stubOllama(t, { onChat: async () => chatResponse('') });
  await assert.rejects(
    () => provider.analyze({ id: 'job-2', payload: { day: '2026-09-15' } }),
    (error) => error.code === ERROR_CODES.INVALID_RESULT,
  );
});

// ---- 生成器 ----

async function makeDiaryRig(t) {
  const dir = await tempDir();
  const rig = await makeQueue({ dir });
  cleanup(t, dir, [rig.queue]);
  await rig.queue.start();

  const generator = new DiaryGenerator({
    queue: rig.queue,
    diaries: rig.diaries,
    timeBlocks: rig.timeBlocks,
    log: rig.log,
    scanLimit: DEFAULT_SCAN_LIMIT,
    notifyDelayMs: 1,
  });
  return { ...rig, generator };
}

test('日记 9：启动补扫把「有区块、没日记」的历史日期排队（幂等）', async (t) => {
  const rig = await makeDiaryRig(t);
  const yesterday = shiftDayKey(dayKeyOf(new Date()), -1);
  const { from } = dayBounds(yesterday);

  await completeBlock(rig.queue, rig.timeBlocks, new Date(from), { category: '学习' });
  await completeBlock(rig.queue, rig.timeBlocks, new Date(new Date(from).getTime() + 10 * 60000));

  const first = await rig.generator.scan();
  assert.deepEqual(
    { scanned: first.scanned, created: first.created, skipped: first.skipped, deferred: first.deferred },
    { scanned: 1, created: 1, skipped: 0, deferred: 0 },
  );

  const row = rig.diaries.getByDay(yesterday);
  assert.equal(row.status, 'PENDING');
  assert.equal(row.blockCount, 2);

  const job = rig.queue.getJobs().find((item) => item.type === AIJobType.DIARY_GENERATION);
  assert.ok(job, '应该建出日记任务');
  assert.deepEqual(job.payload, { day: yesterday, from, to: dayBounds(yesterday).to });
  assert.equal(job.priority, JOB_PRIORITY.LOW);

  // 再扫一次：日记行已经存在，这一天不再是缺口，既不会重复排队也不会有任务被跳过。
  const second = await rig.generator.scan();
  assert.deepEqual(second, { scanned: 0, created: 0, skipped: 0, deferred: 0 });
  assert.equal(
    rig.queue.getJobs().filter((item) => item.type === AIJobType.DIARY_GENERATION).length,
    1,
  );
});

test('日记 10：区块没汇总完 / 还有更早的缺口时都不会生成日记', async (t) => {
  const rig = await makeDiaryRig(t);
  const today = dayKeyOf(new Date());
  const yesterday = shiftDayKey(today, -1);
  const dayBefore = shiftDayKey(today, -2);

  // 1. 昨天还有一个区块卡在 PENDING：不生成。
  const pending = createBlock(new Date(dayBounds(yesterday).from), { activityCount: 1 });
  await rig.queue.enqueueWithBlock(pending, { priority: JOB_PRIORITY.LOW });
  assert.equal((await rig.generator.scan()).created, 0);

  // 汇总完成后就排上了。
  rig.timeBlocks.updateSummary(pending.id, {
    status: 'COMPLETED',
    summary: { project: '写《报告》', category: '工作', description: 'x'.repeat(210), software: [], todos: [] },
  });
  assert.equal((await rig.generator.scan()).created, 1);
  assert.ok(rig.diaries.getByDay(yesterday));

  // 2. 前天有截图记录但还没变成区块：更晚的日期要等回填完。
  await completeBlock(rig.queue, rig.timeBlocks, new Date(dayBounds(today).from), {});
  const older = createBlock(new Date(dayBounds(dayBefore).from), { activityCount: 1 });
  await rig.queue.enqueueWithBlock(older, { priority: JOB_PRIORITY.LOW });
  rig.timeBlocks.updateSummary(older.id, {
    status: 'COMPLETED',
    summary: { project: '写《报告》', category: '工作', description: 'x'.repeat(210), software: [], todos: [] },
  });
  // 造一条「有记录、没区块」的更早记录：它前面的日子才算回填完。
  rig.activities.createActivity({
    id: 'old-shot',
    time: formatLocalIso(new Date(new Date(dayBefore).getTime() - 86400000)),
    imagePath: 'C:/tmp/old.png',
    analysisStatus: 'COMPLETED',
    analysis: { activity: '编写代码', summary: null, category: 'coding', project: null, keywords: [], confidence: 0.5 },
  });

  const scan = await rig.generator.scan();
  assert.equal(scan.created, 0);
  assert.equal(scan.deferred, 1, '今天之前还有缺口，昨天的日记要等回填');
  assert.equal(rig.diaries.getByDay(today), null, '今天还没过完，永远不生成');
});

test('日记 11：重入保护、结果回填、失败标记与手动重新生成', async (t) => {
  const rig = await makeDiaryRig(t);
  const day = shiftDayKey(dayKeyOf(new Date()), -1);
  const { from } = dayBounds(day);
  const diaryJobs = () => rig.queue.getJobs().filter((item) => item.type === AIJobType.DIARY_GENERATION);

  await completeBlock(rig.queue, rig.timeBlocks, new Date(from));

  // 重入保护：上一次扫描还卡在入队上时，第二次扫描直接返回 busy，不会重复建任务。
  let release = null;
  const slow = new DiaryGenerator({
    queue: { enqueueWithDiary: () => new Promise((resolve) => { release = resolve; }) },
    diaries: rig.diaries,
    timeBlocks: rig.timeBlocks,
    log: silentLog(),
    notifyDelayMs: 1,
  });
  const pendingScan = slow.scan();
  assert.equal((await slow.scan()).busy, true);
  release({ created: false });
  assert.deepEqual(await pendingScan, { scanned: 1, created: 0, skipped: 1, deferred: 0 });

  await rig.generator.scan();
  const job = diaryJobs()[0];

  await rig.generator.handleResult(job, {
    analysis: DIARY,
    blockCount: 3,
    model: 'fake-model',
    analysisMs: 20,
  });
  rig.queue.complete(job.id, { message: 'diary' });
  const saved = rig.diaries.getByDay(day);
  assert.equal(saved.status, 'COMPLETED');
  assert.equal(saved.summary, DIARY.summary);
  assert.deepEqual(saved.mainEvents, DIARY.mainEvents);
  assert.deepEqual(saved.suggestions, DIARY.suggestions);
  assert.equal(saved.blockCount, 3);

  // 失败：正文保留，状态与错误码写回，缺口扫描不会重复排队。
  rig.generator.handleFailure(job, new AIError(ERROR_CODES.AI_TIMEOUT, 'AI 请求超时'));
  const failed = rig.diaries.getByDay(day);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, ERROR_CODES.AI_TIMEOUT);
  assert.equal(failed.error, 'AI 请求超时');
  assert.equal(failed.analysisMs, null);
  assert.equal(failed.summary, DIARY.summary, '失败不会清空已经写好的正文');
  const rescan = await rig.generator.scan();
  assert.equal(rescan.created, 0, '失败的行不会被缺口扫描重复排队');

  // 手动重新生成：强制新建任务并把状态改回 PENDING。
  const regenerated = await rig.generator.regenerate(day);
  assert.equal(regenerated.created, true);
  assert.equal(rig.diaries.getByDay(day).status, 'PENDING');
  assert.equal(rig.diaries.getByDay(day).summary, DIARY.summary, '重新生成不会先清空正文');
  assert.equal(diaryJobs().length, 2);

  // 再点一次：还在排队的旧任务被取代，不会有两个任务同时写同一天。
  assert.equal((await rig.generator.regenerate(day)).created, true);
  assert.equal(diaryJobs().length, 3);
  assert.equal(diaryJobs().filter((item) => item.status === AIJobStatus.PENDING).length, 1);

  const missingDay = shiftDayKey(dayKeyOf(new Date()), -30);
  assert.deepEqual(await rig.generator.regenerate(missingDay), { created: false, reason: 'NOT_FOUND' });
  assert.deepEqual(await rig.generator.regenerate('不是日期'), { created: false, reason: 'INVALID_DAY' });
});

test('日记 12：端到端（打桩 Ollama）—— 区块汇总完成后自动生成这一天的日记', async (t) => {
  const rig = await makeDiaryRig(t);
  const day = shiftDayKey(dayKeyOf(new Date()), -1);
  const { from, to } = dayBounds(day);

  const requests = [];
  stubOllama(t, {
    onChat: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return chatResponse(validDiary());
    },
  });

  await completeBlock(rig.queue, rig.timeBlocks, new Date(from));
  await completeBlock(rig.queue, rig.timeBlocks, new Date(new Date(from).getTime() + 10 * 60000));

  const provider = new OllamaDiaryProvider({
    ollamaHost: 'http://127.0.0.1:11434',
    model: 'qwen3-vl:8b',
    timeoutMs: 5000,
    loadContext: ({ from: start, to: end }) => ({
      blocks: rig.timeBlocks.listBlocksBetween(start, end),
      previous: rig.diaries.findPreviousDiary(day),
    }),
  });

  rig.generator.onEvent = (payload) => rig.events.push(payload);
  rig.events = [];

  // 两个区块已经直接写库汇总完成，这里只给 Worker 留日记任务：
  // 否则区块任务会被同一个 Provider 吃掉，测的就不是日记这条路了。
  await rig.generator.scan();
  for (const job of rig.queue.getJobs()) {
    if (job.type !== AIJobType.DIARY_GENERATION) rig.queue.cancel(job.id);
  }

  const worker = new AIWorker({
    queue: rig.queue,
    provider,
    log: rig.log,
    concurrency: 1,
    // 与 main.js 的装配一致：日记结果回填到 diaries 行。
    onCompleted: (job, result) => (
      job.type === AIJobType.DIARY_GENERATION ? rig.generator.handleResult(job, result) : undefined
    ),
  });
  worker.start();
  t.after(() => worker.stop({ timeoutMs: 500 }));

  await waitFor(() => rig.diaries.getByDay(day)?.status === 'COMPLETED');
  const row = rig.diaries.getByDay(day);
  assert.equal(row.summary, DIARY.summary);
  assert.equal(row.blockCount, 2);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].messages[0].content.includes('【这一天的记录】'));

  const job = rig.queue.getJobs().find((item) => item.type === AIJobType.DIARY_GENERATION);
  assert.equal(job.status, AIJobStatus.COMPLETED);
  assert.ok(
    rig.events.some((payload) => payload.type === 'diary'),
    '生成完成后要广播 diary 事件',
  );
  assert.equal(to, dayBounds(day).to);
});

test('日记 13：快照与调度延迟', async (t) => {
  const rig = await makeDiaryRig(t);
  const snapshot = rig.generator.snapshot();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.scanning, false);
  assert.deepEqual(snapshot.stats, { total: 0, completed: 0, failed: 0, pending: 0 });

  // 到下一个本地午夜的毫秒数 + 扫描延迟。
  const now = at(2026, 9, 15, 23, 0);
  const isolated = new DiaryGenerator({
    queue: rig.queue,
    diaries: rig.diaries,
    timeBlocks: rig.timeBlocks,
    log: silentLog(),
    scanDelayMs: 5000,
    now: () => now,
  });
  assert.equal(isolated.nextDelayMs(), 60 * 60 * 1000 + 5000);

  isolated.start();
  assert.equal(isolated.snapshot().running, true);
  isolated.stop();
  assert.equal(isolated.snapshot().running, false);
});

test('日记 14：IPC 契约（某一天 / 日历标记 / 状态 / 重新生成）', async (t) => {
  const rig = await makeDiaryRig(t);
  const day = shiftDayKey(dayKeyOf(new Date()), -1);
  await completeBlock(rig.queue, rig.timeBlocks, new Date(dayBounds(day).from));
  await rig.generator.scan();

  const handlers = new Map();
  registerDiaryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    diaries: rig.diaries,
    timeBlocks: rig.timeBlocks,
    activities: rig.activities,
    generator: rig.generator,
  });

  assert.deepEqual([...handlers.keys()], [
    DIARY_CHANNEL, DIARY_DAYS_CHANNEL, DIARY_STATUS_CHANNEL, DIARY_REGENERATE_CHANNEL,
  ]);

  const detail = await handlers.get(DIARY_CHANNEL)(null, day);
  assert.equal(detail.day, day);
  assert.equal(detail.today, false);
  assert.equal(detail.diary.status, 'PENDING');
  assert.equal(detail.blocks.total, 1);
  assert.equal(detail.blocks.completed, 1);
  assert.deepEqual(detail.blocks.categories, [{ category: '工作', blocks: 1 }]);
  assert.equal(detail.activityCount, 0);

  // 非法日期退回今天，而不是抛错。
  const fallback = await handlers.get(DIARY_CHANNEL)(null, '不是日期');
  assert.equal(fallback.day, dayKeyOf(new Date()));

  const marks = await handlers.get(DIARY_DAYS_CHANNEL)(null, { from: day, to: day });
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0], {
    day,
    status: 'PENDING',
    blockCount: 1,
    pending: 0,
    category: '工作',
    categoryBlocks: 1,
  });
  assert.deepEqual(await handlers.get(DIARY_DAYS_CHANNEL)(null, { from: null, to: null }), []);

  const status = await handlers.get(DIARY_STATUS_CHANNEL)(null);
  assert.equal(status.stats.total, 1);

  const regenerated = await handlers.get(DIARY_REGENERATE_CHANNEL)(null, day);
  assert.equal(regenerated.created, true);
});

test('日记 15：日期与分类口径必须和 Summary 的四个中文分类一致', () => {
  const { SUMMARY_CATEGORIES } = require('../src/main/ai/summaryOutput');
  const { CATEGORY_ORDER } = require('../src/main/stats/summarize');
  assert.deepEqual([...SUMMARY_CATEGORIES], [...CATEGORY_ORDER]);

  // 一个 AIError 走的是可重试路径：失败行保留，界面上能重新生成。
  const error = new AIError(ERROR_CODES.INVALID_RESULT, '模型输出跑偏');
  assert.equal(error.code, ERROR_CODES.INVALID_RESULT);
});
