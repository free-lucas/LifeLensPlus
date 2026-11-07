'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AIJobType, JOB_PRIORITY, createJob } = require('../src/main/ai/job');
const { createBlock, blockKeyOf, blockStartOf } = require('../src/main/summary/timeBlock');
const { formatLocalIso } = require('../src/main/time');
const { tempDir, cleanup, makeQueue } = require('./support');

function at(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second);
}

function makeRecord(id, date, overrides = {}) {
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
    ...overrides,
  };
}

function analysis(overrides = {}) {
  return {
    activity: '编写代码',
    summary: '在 VS Code 里编辑代码',
    category: 'coding',
    project: 'Life Lens',
    keywords: ['Electron'],
    confidence: 0.8,
    ...overrides,
  };
}

// ---- 区块记录与任务：同一事务 ----

test('区块仓储 1：区块记录与 AI Job 在同一事务里写入，activity_id 为 NULL', async (t) => {
  const dir = await tempDir();
  const { queue, timeBlocks, db } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();

  const block = createBlock(at(2026, 9, 15, 10, 7), { activityCount: 6 });
  const { job, created } = await queue.enqueueWithBlock(block, { priority: JOB_PRIORITY.LOW });
  await queue.flush();

  assert.equal(created, true);
  assert.equal(job.type, AIJobType.TIMEBLOCK_SUMMARY);
  assert.equal(job.priority, JOB_PRIORITY.LOW);
  assert.deepEqual(job.payload, { blockStart: block.id, blockEnd: block.end });

  const stored = timeBlocks.getByStart(block.id);
  assert.equal(stored.status, 'PENDING');
  assert.equal(stored.activityCount, 6);
  assert.deepEqual(stored.software, []);
  assert.deepEqual(stored.todos, []);

  const jobRow = db.prepare('SELECT type, activity_id, payload_json FROM ai_jobs WHERE id = ?').get(job.id);
  assert.equal(jobRow.type, AIJobType.TIMEBLOCK_SUMMARY);
  assert.equal(jobRow.activity_id, null, '区块任务不关联 activities');
  assert.equal(JSON.parse(jobRow.payload_json).blockStart, block.id);
});

test('区块仓储 2：同一个区块不会重复建任务（幂等）', async (t) => {
  const dir = await tempDir();
  const { queue, dir: base } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();

  const block = createBlock(at(2026, 9, 15, 10, 0));
  const first = await queue.enqueueWithBlock(block);
  const second = await queue.enqueueWithBlock(block);
  await queue.flush();

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.reason, 'DUPLICATE_ACTIVE');
  assert.equal(second.job.id, first.job.id);
  assert.equal(base.length > 0, true);
});

test('区块仓储 3：区块行写不进去时任务一起回滚', async (t) => {
  const dir = await tempDir();
  const { timeBlocks, db } = await makeQueue({ dir });
  cleanup(t, dir);

  const block = createBlock(at(2026, 9, 15, 10, 0));
  const job = createJob({ type: AIJobType.TIMEBLOCK_SUMMARY, payload: { blockStart: block.id } });
  timeBlocks.insertBlockWithJob(block, job);

  // 同一个 block_start 再插一次会撞 UNIQUE：整笔事务回滚，第二个任务不能留在库里。
  const duplicateJob = createJob({ type: AIJobType.TIMEBLOCK_SUMMARY, payload: { blockStart: block.id } });
  assert.throws(() => timeBlocks.insertBlockWithJob(block, duplicateJob), /UNIQUE/);

  const rows = db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get();
  assert.equal(Number(rows.n), 1, '回滚后只剩第一条任务');
});

// ---- 缺口扫描 ----

test('区块仓储 4：缺口扫描的区块键与 JS 对齐结果逐字符一致', async (t) => {
  const dir = await tempDir();
  const { activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir);

  // 覆盖整点、跨小时、跨天、不同秒的边界。
  const times = [
    at(2026, 9, 15, 0, 0, 0),
    at(2026, 9, 15, 0, 59, 59),
    at(2026, 9, 15, 9, 59, 59),
    at(2026, 9, 15, 10, 7, 23),
    at(2026, 9, 15, 23, 59, 0),
    at(2026, 9, 16, 10, 7, 23),
  ];
  times.forEach((time, index) => activities.createActivity(makeRecord(`shot-${index}`, time)));

  const missing = timeBlocks.listMissingBlocks({
    before: formatLocalIso(at(2026, 9, 17, 0, 0)),
    limit: 100,
  });

  assert.deepEqual(missing.map((item) => item.blockStart), times.map((time) => blockKeyOf(time)));
  assert.deepEqual(missing.map((item) => item.activityCount), [1, 1, 1, 1, 1, 1]);
  assert.equal(missing[0].blockStart, formatLocalIso(at(2026, 9, 15, 0, 0)));
});

test('区块仓储 5：只扫描已结束的区块，已有区块行的不再返回', async (t) => {
  const dir = await tempDir();
  const { queue, activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();

  activities.createActivity(makeRecord('a', at(2026, 9, 15, 10, 3)));
  activities.createActivity(makeRecord('b', at(2026, 9, 15, 10, 12)));
  activities.createActivity(makeRecord('c', at(2026, 9, 15, 10, 25)));

  // 只处理已经结束的区块：当前区块的起点是 10:10，所以 10:00 那个区块还算「已结束」。
  const before = formatLocalIso(blockStartOf(at(2026, 9, 15, 10, 10)));
  const missing = timeBlocks.listMissingBlocks({ before });
  assert.deepEqual(missing.map((item) => item.blockStart), [formatLocalIso(at(2026, 9, 15, 10, 0))]);
  assert.equal(missing[0].activityCount, 1);

  // 处理过（有区块行）的区块不会再被扫出来。
  await queue.enqueueWithBlock(createBlock(at(2026, 9, 15, 10, 0)));
  assert.deepEqual(timeBlocks.listMissingBlocks({ before }), []);

  // b（10:12）属于 10:10 区块、c（10:25）属于 10:20 区块，两个都还没汇总。
  assert.deepEqual(
    timeBlocks.listMissingBlocks({ before: formatLocalIso(at(2026, 9, 15, 10, 30)) })
      .map((item) => item.blockStart),
    [formatLocalIso(at(2026, 9, 15, 10, 10)), formatLocalIso(at(2026, 9, 15, 10, 20))],
  );
});

test('区块仓储 6：缺口扫描按时间从前到后，且受 limit 限制', async (t) => {
  const dir = await tempDir();
  const { activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir);

  for (const minute of [0, 10, 20, 30]) {
    activities.createActivity(makeRecord(`shot-${minute}`, at(2026, 9, 15, 10, minute + 1)));
  }

  const all = timeBlocks.listMissingBlocks({ before: formatLocalIso(at(2026, 9, 15, 11, 0)) });
  assert.deepEqual(all.map((item) => item.blockStart), [
    formatLocalIso(at(2026, 9, 15, 10, 0)),
    formatLocalIso(at(2026, 9, 15, 10, 10)),
    formatLocalIso(at(2026, 9, 15, 10, 20)),
    formatLocalIso(at(2026, 9, 15, 10, 30)),
  ]);

  const limited = timeBlocks.listMissingBlocks({ before: formatLocalIso(at(2026, 9, 15, 11, 0)), limit: 2 });
  assert.deepEqual(limited.map((item) => item.blockStart), [
    formatLocalIso(at(2026, 9, 15, 10, 0)),
    formatLocalIso(at(2026, 9, 15, 10, 10)),
  ]);
});

// ---- 结果的读写 ----

// 造 4 条已经汇总好的区块记录，供查询 / 筛选 / facets 用例复用。
async function seedBlocks({ timeBlocks }) {
  const blocks = [
    { start: at(2026, 9, 15, 9, 0), project: '写《2026 年中报告》', category: '工作', software: ['Word', 'Chrome'] },
    { start: at(2026, 9, 15, 9, 10), project: '写《2026 年中报告》', category: '工作', software: ['Word'] },
    { start: at(2026, 9, 15, 9, 20), project: '玩《荒野大镖客》', category: '娱乐', software: ['Steam'] },
    { start: at(2026, 9, 16, 9, 0), project: '看《三体》', category: '娱乐', software: ['Chrome'] },
  ];
  for (const item of blocks) {
    const block = createBlock(item.start, { activityCount: 3 });
    timeBlocks.insertBlockWithJob(block, createJob({
      type: AIJobType.TIMEBLOCK_SUMMARY,
      payload: { blockStart: block.id, blockEnd: block.end },
    }));
    timeBlocks.updateSummary(block.id, {
      status: 'COMPLETED',
      summary: {
        project: item.project,
        category: item.category,
        description: `描述 ${item.project}`,
        software: item.software,
        todos: item.software.includes('Word') ? ['补充上半年数据'] : [],
      },
      model: 'fake-model',
      analysisMs: 12,
    });
  }
  return blocks;
}

test('区块仓储 7：汇总结果回填（结构化字段 + JSON 数组）', async (t) => {
  const dir = await tempDir();
  const { timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir);
  const [seed] = await seedBlocks({ timeBlocks });

  const stored = timeBlocks.getByStart(blockKeyOf(seed.start));
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.project, '写《2026 年中报告》');
  assert.equal(stored.category, '工作');
  assert.equal(stored.description, '描述 写《2026 年中报告》');
  assert.deepEqual(stored.software, ['Word', 'Chrome']);
  assert.deepEqual(stored.todos, ['补充上半年数据']);
  assert.equal(stored.model, 'fake-model');
  assert.equal(stored.analysisMs, 12);
  assert.equal(stored.error, null);

  // 失败回填只改状态与错误，不会把上一次的汇总结果抹掉。
  timeBlocks.updateSummary(stored.id, { status: 'FAILED', error: 'AI 请求超时', errorCode: 'AI_TIMEOUT' });
  const failed = timeBlocks.getByStart(stored.id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'AI_TIMEOUT');
  assert.equal(failed.project, '写《2026 年中报告》');

  assert.equal(timeBlocks.updateSummary('不存在的区块', { status: 'FAILED' }), false);
  assert.equal(timeBlocks.updateSummary(stored.id, {}), false, '空 patch 不动任何字段');
});

test('区块仓储 8：countByStatus 与 findPreviousSummary', async (t) => {
  const dir = await tempDir();
  const { timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir);
  await seedBlocks({ timeBlocks });

  const pending = createBlock(at(2026, 9, 15, 9, 30));
  timeBlocks.insertBlockWithJob(pending, createJob({
    type: AIJobType.TIMEBLOCK_SUMMARY,
    payload: { blockStart: pending.id },
  }));

  assert.deepEqual(timeBlocks.countByStatus(), { total: 5, completed: 4, failed: 0, pending: 1 });

  // 上一个已汇总的区块：跳过还没汇总的 09:30，取 09:20。
  const previous = timeBlocks.findPreviousSummary(formatLocalIso(at(2026, 9, 15, 9, 40)));
  assert.equal(previous.project, '玩《荒野大镖客》');
  assert.equal(timeBlocks.findPreviousSummary(formatLocalIso(at(2026, 9, 15, 8, 0))), null);
});

test('区块仓储 9：queryBlocks 的时间 / 项目 / 软件筛选与分页', async (t) => {
  const dir = await tempDir();
  const { timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir);
  await seedBlocks({ timeBlocks });

  const all = timeBlocks.queryBlocks({});
  assert.equal(all.total, 4);
  assert.equal(all.items[0].project, '看《三体》', '默认按区块起点倒序');
  assert.equal(all.hasMore, false);

  const today = timeBlocks.queryBlocks({ from: at(2026, 9, 15, 0, 0), to: at(2026, 9, 16, 0, 0) });
  assert.deepEqual(today.items.map((item) => item.id), [
    formatLocalIso(at(2026, 9, 15, 9, 20)),
    formatLocalIso(at(2026, 9, 15, 9, 10)),
    formatLocalIso(at(2026, 9, 15, 9, 0)),
  ]);

  const byProject = timeBlocks.queryBlocks({ project: '写《2026 年中报告》' });
  assert.equal(byProject.total, 2);

  // 软件是 JSON 数组：按名字精确匹配，不是一个长串的 LIKE。
  const bySoftware = timeBlocks.queryBlocks({ software: 'Word' });
  assert.equal(bySoftware.total, 2);
  assert.equal(timeBlocks.queryBlocks({ software: 'Chrome' }).total, 2);
  assert.equal(timeBlocks.queryBlocks({ software: 'Chro' }).total, 0, '不做子串匹配');

  const page = timeBlocks.queryBlocks({ limit: 2, offset: 0 });
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, true);
  const next = timeBlocks.queryBlocks({ limit: 2, offset: 2 });
  assert.equal(next.items.length, 2);
  assert.equal(next.hasMore, false);
  assert.notEqual(next.items[0].id, page.items[0].id);

  // 认不出来的条件不影响查询：空字符串 / 非字符串一律不筛。
  assert.equal(timeBlocks.queryBlocks({ project: '', software: '  ', limit: 'abc' }).total, 4);
  assert.equal(timeBlocks.queryBlocks({ from: '不是时间' }).total, 4);
});

test('区块仓储 10：listBlocksBetween 取一段连续时间（正序、含分页上限）', async (t) => {
  const dir = await tempDir();
  const { timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir);
  await seedBlocks({ timeBlocks });

  const window = timeBlocks.listBlocksBetween(at(2026, 9, 15, 9, 10), at(2026, 9, 15, 9, 30));
  assert.deepEqual(window.map((item) => item.id), [
    formatLocalIso(at(2026, 9, 15, 9, 10)),
    formatLocalIso(at(2026, 9, 15, 9, 20)),
  ]);
  assert.equal(timeBlocks.listBlocksBetween(at(2026, 9, 15, 9, 10), at(2026, 9, 15, 9, 30), { limit: 1 }).length, 1);
});

test('区块仓储 11：listFacets 从已有数据取项目与软件', async (t) => {
  const dir = await tempDir();
  const { timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir);
  await seedBlocks({ timeBlocks });

  const facets = timeBlocks.listFacets();
  // SQLite 的 ORDER BY 是字节序：中文按 UTF-8 码点排，不是拼音。
  assert.deepEqual(facets.projects, ['写《2026 年中报告》', '玩《荒野大镖客》', '看《三体》']);
  assert.deepEqual(facets.software, ['Chrome', 'Steam', 'Word']);
  assert.equal(facets.software.includes(''), false);
});

// ---- 汇总素材（activities 侧）----

test('区块仓储 12：listSummaryContext 只在本区块范围内、按时间正序、带上分析状态', async (t) => {
  const dir = await tempDir();
  const { activities, timeBlocks } = await makeQueue({ dir });
  cleanup(t, dir);

  activities.createActivity(makeRecord('before', at(2026, 9, 15, 9, 59), {
    analysis: analysis(), analysisStatus: 'COMPLETED',
  }));
  activities.createActivity(makeRecord('first', at(2026, 9, 15, 10, 0, 20), {
    analysis: analysis({ activity: '阅读文档' }), analysisStatus: 'COMPLETED',
  }));
  activities.createActivity(makeRecord('pending', at(2026, 9, 15, 10, 5)));
  activities.createActivity(makeRecord('after', at(2026, 9, 15, 10, 10)));

  const block = createBlock(at(2026, 9, 15, 10, 5));
  const records = activities.listSummaryContext(block.start, block.end);

  assert.deepEqual(records.map((record) => record.time.slice(11, 19)), ['10:00:20', '10:05:00']);
  assert.equal(records[0].activity, '阅读文档');
  assert.deepEqual(records[0].keywords, ['Electron']);
  assert.equal(records[1].status, 'PENDING');
  assert.equal(records[1].activity, null);
  assert.deepEqual(records[1].keywords, []);
});
