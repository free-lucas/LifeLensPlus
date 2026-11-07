'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { JOB_PRIORITY } = require('../src/main/ai/job');
const { createBlock } = require('../src/main/summary/timeBlock');
const { PERIODS, DEFAULT_PERIOD, resolvePeriod } = require('../src/main/stats/period');
const { DEFAULT_LIMITS, CATEGORY_ORDER, buildStats } = require('../src/main/stats/summarize');
const { registerStatsIpc, STATS_CHANNEL } = require('../src/main/statsIpc');
const { formatLocalIso } = require('../src/main/time');
const { tempDir, cleanup, makeQueue } = require('./support');

function at(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute);
}

// 一条已经汇总完成的 10 分钟区块（直接写库，不经过 AI）。
async function addBlock(rig, date, summary = {}) {
  const block = createBlock(date, { activityCount: 2 });
  await rig.queue.enqueueWithBlock(block, { priority: JOB_PRIORITY.LOW });
  rig.timeBlocks.updateSummary(block.id, {
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

function addActivity(rig, date, keywords = []) {
  const time = formatLocalIso(date);
  return rig.activities.createActivity({
    id: time,
    time,
    imagePath: 'C:/tmp/shot.png',
    analysisStatus: 'COMPLETED',
    analysis: {
      activity: '写代码',
      summary: null,
      category: 'coding',
      project: null,
      keywords,
      confidence: 0.5,
    },
  });
}

async function makeStatsRig(t) {
  const dir = await tempDir();
  const rig = await makeQueue({ dir });
  cleanup(t, dir, [rig.queue]);
  await rig.queue.start();
  return rig;
}

// 2026-09-14 是周一；下面所有用例都用这一周当样本。
const WEEK_ANCHOR = '2026-09-16';

test('统计 1：日 / 周 / 月 / 年的边界、标题与前后锚点', () => {
  const now = at(2026, 9, 16, 10, 30);
  assert.deepEqual([...PERIODS], ['day', 'week', 'month', 'year']);
  assert.equal(DEFAULT_PERIOD, 'week');

  const day = resolvePeriod('day', '2026-09-15', { now });
  assert.equal(day.from.getTime(), at(2026, 9, 15, 0).getTime());
  assert.equal(day.to.getTime(), at(2026, 9, 16, 0).getTime(), '日周期的 to 是开区间');
  assert.equal(day.label, '2026年9月15日 周二');
  assert.equal(day.prevAnchor, '2026-09-14');
  assert.equal(day.nextAnchor, '2026-09-16');
  assert.equal(day.hasToday, false);

  const week = resolvePeriod('week', WEEK_ANCHOR, { now });
  assert.equal(week.from.getTime(), at(2026, 9, 14, 0).getTime(), '一周从周一开始');
  assert.equal(week.to.getTime(), at(2026, 9, 21, 0).getTime());
  assert.equal(week.label, '2026年9月14日 – 20日');
  assert.equal(week.prevAnchor, '2026-09-07');
  assert.equal(week.nextAnchor, '2026-09-21');
  assert.equal(week.hasToday, true);
  assert.equal(week.future, false);

  // 跨月的周标题要把两个月份都写出来。
  const crossMonth = resolvePeriod('week', '2026-10-01', { now });
  assert.equal(crossMonth.label, '2026年9月28日 – 10月4日');

  const month = resolvePeriod('month', '2026-09-15', { now });
  assert.equal(month.from.getTime(), at(2026, 9, 1, 0).getTime());
  assert.equal(month.to.getTime(), at(2026, 10, 1, 0).getTime());
  assert.equal(month.label, '2026年9月');
  assert.equal(month.prevAnchor, '2026-08-01');
  assert.equal(month.nextAnchor, '2026-10-01');

  const year = resolvePeriod('year', '2026-05-05', { now });
  assert.equal(year.from.getTime(), at(2026, 1, 1, 0).getTime());
  assert.equal(year.to.getTime(), at(2027, 1, 1, 0).getTime());
  assert.equal(year.label, '2026年');
  assert.equal(year.prevAnchor, '2025-01-01');
  assert.equal(year.nextAnchor, '2027-01-01');

  // 非法输入：周期退回默认、锚点退回今天、整段在未来时 future = true。
  assert.equal(resolvePeriod('周', null, { now }).period, 'week');
  assert.equal(resolvePeriod(null, '不是日期', { now }).anchor, '2026-09-16');
  const ahead = resolvePeriod('month', '2030-03-01', { now });
  assert.equal(ahead.future, true);
  assert.equal(ahead.hasToday, false);
});

test('统计 2：没有数据的周期也返回完整骨架（四个分类 / 24 个小时槽 / 空排行）', async (t) => {
  const rig = await makeStatsRig(t);
  const stats = rig.stats.summarize({ period: 'week', anchor: WEEK_ANCHOR }, { now: at(2026, 9, 16, 10) });

  assert.deepEqual(stats.categories.map((item) => item.category), [...CATEGORY_ORDER]);
  assert.deepEqual(stats.categories.map((item) => item.minutes), [0, 0, 0, 0]);
  assert.equal(stats.hourly.length, 24);
  assert.equal(stats.trend.length, 7);
  assert.deepEqual(stats.projects, []);
  assert.deepEqual(stats.software, []);
  assert.deepEqual(stats.keywords, []);
  assert.deepEqual(stats.todos, []);
  assert.deepEqual(stats.totals, {
    blocks: 0,
    completed: 0,
    pending: 0,
    failed: 0,
    minutes: 0,
    activities: 0,
    activeDays: 0,
    days: 7,
  });
  assert.deepEqual(stats.counts, { projects: 0, software: 0 });
  assert.equal(stats.anchor, WEEK_ANCHOR);
  assert.equal(stats.label, '2026年9月14日 – 20日');
  assert.equal(stats.from, '2026-09-14T00:00:00+08:00');
  assert.equal(stats.to, '2026-09-21T00:00:00+08:00');
});

test('统计 3：时长口径是「区块数 × 10 分钟」，占比只算已汇总的区块', async (t) => {
  const rig = await makeStatsRig(t);
  await addBlock(rig, at(2026, 9, 15, 9, 0));
  await addBlock(rig, at(2026, 9, 15, 9, 10));
  await addBlock(rig, at(2026, 9, 15, 9, 20), { category: '学习', project: '刷题' });
  // 还没汇总的区块算「时间段」但不算时长。
  await rig.queue.enqueueWithBlock(createBlock(at(2026, 9, 15, 9, 30)), { priority: JOB_PRIORITY.LOW });

  const stats = rig.stats.summarize({ period: 'day', anchor: '2026-09-15' }, { now: at(2026, 9, 16, 10) });
  assert.equal(stats.totals.blocks, 4);
  assert.equal(stats.totals.completed, 3);
  assert.equal(stats.totals.pending, 1);
  assert.equal(stats.totals.minutes, 30);
  assert.equal(stats.blockMinutes, 10);
  assert.deepEqual(
    stats.categories.map((item) => [item.category, item.blocks, item.minutes]),
    [['娱乐', 0, 0], ['工作', 2, 20], ['学习', 1, 10], ['社交', 0, 0]],
  );
  assert.equal(Math.round(stats.categories[1].share * 100), 67);

  assert.deepEqual(
    stats.projects.map((item) => [item.label, item.blocks, item.minutes]),
    [['写《2026 年中报告》', 2, 20], ['刷题', 1, 10]],
  );
  assert.deepEqual(stats.software.map((item) => [item.label, item.blocks]), [['Word', 3]]);
  assert.deepEqual(stats.counts, { projects: 2, software: 1 });

  // 日视图的趋势桶是 24 个小时，9 点这一格有 3 个区块。
  assert.equal(stats.trend.length, 24);
  assert.deepEqual(stats.trend.map((item) => item.key).slice(0, 3), ['00', '01', '02']);
  assert.equal(stats.trend[9].minutes, 30);
  assert.deepEqual(stats.trend[9].byCategory, { 工作: 20, 学习: 10 });
  assert.deepEqual(stats.hourly[9].byCategory, { 工作: 20, 学习: 10 });
  assert.equal(stats.hourly[10].blocks, 0);
});

test('统计 4：软件按出现次数排序，项目按时长排序', async (t) => {
  const rig = await makeStatsRig(t);
  await addBlock(rig, at(2026, 9, 15, 9, 0), { software: ['Word', 'Chrome'] });
  await addBlock(rig, at(2026, 9, 15, 9, 10), { software: ['Chrome', 'WeChat'] });
  await addBlock(rig, at(2026, 9, 15, 9, 20), { software: ['Chrome'], project: '开会' });

  const stats = rig.stats.summarize({ period: 'day', anchor: '2026-09-15' }, { now: at(2026, 9, 16, 10) });
  assert.deepEqual(
    stats.software.map((item) => [item.label, item.blocks, item.minutes]),
    [['Chrome', 3, 30], ['WeChat', 1, 10], ['Word', 1, 10]],
  );
  assert.equal(stats.counts.software, 3);
  // 项目并列时时长相同，按名字升序排：写《2026 年中报告》 2 个区块排在最前。
  assert.deepEqual(stats.projects.map((item) => item.label), ['写《2026 年中报告》', '开会']);
});

test('统计 5：关键词与待办来自 JSON 数组，待办带上最早出现的那一天', async (t) => {
  const rig = await makeStatsRig(t);
  addActivity(rig, at(2026, 9, 15, 10, 0), ['报告', '数据']);
  addActivity(rig, at(2026, 9, 15, 11, 0), ['报告']);
  await addBlock(rig, at(2026, 9, 14, 9, 0), { todos: ['补充上半年数据'] });
  await addBlock(rig, at(2026, 9, 15, 9, 0), { todos: ['补充上半年数据', '预约体检'] });

  const stats = rig.stats.summarize({ period: 'week', anchor: WEEK_ANCHOR }, { now: at(2026, 9, 16, 10) });
  assert.deepEqual(stats.keywords, [{ keyword: '报告', count: 2 }, { keyword: '数据', count: 1 }]);
  assert.deepEqual(
    stats.todos.map((item) => [item.todo, item.day, item.count]),
    [['预约体检', '2026-09-15', 1], ['补充上半年数据', '2026-09-14', 2]],
  );
  assert.equal(stats.totals.activities, 2);
  assert.equal(stats.totals.activeDays, 2, '区块与截图记录都算活跃天');
  assert.equal(stats.trend[0].activities, 0);
  assert.equal(stats.trend[1].activities, 2, '9 月 15 日有两张截图');
});

test('统计 6：周期边界是闭开区间，边界上的区块不会重复统计', async (t) => {
  const rig = await makeStatsRig(t);
  await addBlock(rig, at(2026, 9, 14, 0, 0), { category: '学习' });
  await addBlock(rig, at(2026, 9, 13, 23, 50), { category: '娱乐' });
  await addBlock(rig, at(2026, 9, 21, 0, 0), { category: '社交' });

  const week = rig.stats.summarize({ period: 'week', anchor: WEEK_ANCHOR }, { now: at(2026, 9, 16, 10) });
  assert.equal(week.totals.blocks, 1, '只有周一 00:00 落在本周');
  assert.deepEqual(week.categories.map((item) => item.category), [...CATEGORY_ORDER]);
  assert.equal(week.categories[2].blocks, 1);
  assert.equal(week.trend[0].minutes, 10);

  const previous = rig.stats.summarize({ period: 'week', anchor: week.prevAnchor }, { now: at(2026, 9, 16, 10) });
  assert.equal(previous.totals.blocks, 1, '上一周的最后一个 10 分钟算上一周');
  assert.equal(previous.categories[0].blocks, 1);

  const next = rig.stats.summarize({ period: 'week', anchor: week.nextAnchor }, { now: at(2026, 9, 16, 10) });
  assert.equal(next.totals.blocks, 1, '下一周的第一格算下一周');
  assert.equal(next.future, true);
});

test('统计 7：年视图合并成 12 个月的桶，月视图按当月天数分桶', async (t) => {
  const rig = await makeStatsRig(t);
  await addBlock(rig, at(2026, 3, 5, 9, 0));
  await addBlock(rig, at(2026, 3, 5, 9, 10));

  const year = rig.stats.summarize({ period: 'year', anchor: '2026-09-16' }, { now: at(2026, 9, 16, 10) });
  assert.equal(year.trend.length, 12);
  assert.deepEqual(year.trend.map((item) => item.key).slice(0, 3), ['2026-01', '2026-02', '2026-03']);
  assert.equal(year.trend[2].label, '3月');
  assert.equal(year.trend[2].minutes, 20);
  assert.equal(year.totals.days, 365);
  assert.equal(year.future, false, '今年还没过完');

  const month = rig.stats.summarize({ period: 'month', anchor: '2026-03-10' }, { now: at(2026, 9, 16, 10) });
  assert.equal(month.trend.length, 31);
  assert.equal(month.trend[4].key, '2026-03-05');
  assert.equal(month.trend[4].minutes, 20);
  assert.equal(month.future, false, '3 月已经过完，不算「还没开始的周期」');
  assert.equal(month.hasToday, false);

  const ahead = rig.stats.summarize({ period: 'month', anchor: '2027-03-10' }, { now: at(2026, 9, 16, 10) });
  assert.equal(ahead.future, true, '整段在未来的周期才会被标成 future');
});

test('统计 8：排行与关键词都有条数上限', () => {
  const rows = {
    categories: [],
    projects: Array.from({ length: 5 }, (_value, index) => ({ project: `项目${index}`, blocks: 5 - index })),
    software: [],
    keywords: Array.from({ length: 30 }, (_value, index) => ({ keyword: `关键词${index}`, count: 30 - index })),
    todos: [],
  };
  const stats = buildStats({
    period: 'week',
    from: at(2026, 9, 14, 0),
    to: at(2026, 9, 21, 0),
    rows,
    limits: { projects: 2, keywords: 3 },
  });
  assert.deepEqual(stats.projects.map((item) => item.label), ['项目0', '项目1']);
  assert.deepEqual(stats.keywords.map((item) => item.keyword), ['关键词0', '关键词1', '关键词2']);
  assert.deepEqual(DEFAULT_LIMITS, { projects: 12, software: 12, keywords: 20, todos: 20 });
});

test('统计 9：IPC 只暴露一个通道，查询参数原样交给统计层', async (t) => {
  const rig = await makeStatsRig(t);
  await addBlock(rig, at(2026, 9, 15, 9, 0));

  const handlers = new Map();
  registerStatsIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    stats: rig.stats,
  });
  assert.deepEqual([...handlers.keys()], [STATS_CHANNEL]);

  const payload = await handlers.get(STATS_CHANNEL)(null, { period: 'month', anchor: WEEK_ANCHOR });
  assert.equal(payload.period, 'month');
  assert.equal(payload.label, '2026年9月');
  assert.equal(payload.trend.length, 30);
  assert.equal(payload.totals.minutes, 10);
});
