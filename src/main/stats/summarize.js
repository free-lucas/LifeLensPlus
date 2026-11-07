'use strict';

const { addDays, dayStartOf } = require('../day');
const { BLOCK_MINUTES } = require('../summary/timeBlock');
const { buildBuckets, normalizePeriod } = require('./period');

// Phase 9：「看板」的数据聚合。输入是一批很小的 SQL 结果，输出是界面直接可画的完整结构。
//
// 纯函数、不碰数据库、不碰 DOM：
// - 聚合规则（占比、时长、分桶、排行）都在这里，SQL 只负责把行读出来；
// - 时长口径统一是「区块数 × 10 分钟」，与 time_blocks 的区块长度一致；
// - 没有任何记录的周期也要返回完整骨架（4 个分类、24 个小时槽、空排行），
//   界面因此不需要写一遍空态判断。

// 与 SUMMARY_CATEGORIES 是同一份口径（区块分类的四个中文枚举）。
// 这里独立列一份是为了让统计层不依赖 AI 层，测试里有用例守住两者一致。
const CATEGORY_ORDER = Object.freeze(['娱乐', '工作', '学习', '社交']);

const DEFAULT_LIMITS = Object.freeze({
  projects: 12,
  software: 12,
  keywords: 20,
  todos: 20,
});

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// from -> to 之间的自然日数（用日期加法，避免夏令时当天算出 23/25 小时）。
function countDays(from, to) {
  let days = 0;
  for (let date = dayStartOf(from); date.getTime() < to.getTime(); date = addDays(date, 1)) {
    days += 1;
    if (days > 400) break;
  }
  return days;
}

// 排行（项目 / 软件）：区块数换算成时长，再算占总时长的比例。
function buildRanking(rows, { key, totalMinutes, blockMinutes, limit }) {
  const items = [];
  for (const row of rows ?? []) {
    const label = row[key];
    if (typeof label !== 'string' || label === '') continue;
    const blocks = toCount(row.blocks);
    if (!blocks) continue;
    const minutes = blocks * blockMinutes;
    items.push({
      label,
      blocks,
      minutes,
      share: totalMinutes ? minutes / totalMinutes : 0,
    });
  }
  items.sort((a, b) => b.minutes - a.minutes || (a.label < b.label ? -1 : 1));
  return items.slice(0, limit);
}

function buildStats({
  period,
  from,
  to,
  rows = {},
  blockMinutes = BLOCK_MINUTES,
  now = new Date(),
  limits = {},
}) {
  const kind = normalizePeriod(period);
  const size = { ...DEFAULT_LIMITS, ...limits };

  // ---- 分类：固定的四类 + 数据里可能出现的其它值 ----
  const counts = new Map();
  for (const row of rows.categories ?? []) {
    counts.set(row.category, toCount(row.blocks));
  }
  const categorizedBlocks = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const totalMinutes = categorizedBlocks * blockMinutes;

  const categories = CATEGORY_ORDER.map((category) => {
    const blocks = counts.get(category) ?? 0;
    counts.delete(category);
    return {
      category,
      blocks,
      minutes: blocks * blockMinutes,
      share: totalMinutes ? blocks / categorizedBlocks : 0,
    };
  });
  for (const [category, blocks] of counts) {
    if (!category) continue;
    categories.push({
      category,
      blocks,
      minutes: blocks * blockMinutes,
      share: totalMinutes ? blocks / categorizedBlocks : 0,
    });
  }

  // ---- 趋势：按周期分桶（日 = 小时，周 / 月 / 年 = 天，年再合并成月）----
  const buckets = buildBuckets(kind, from, to, { now });
  const bucketIndex = new Map(buckets.map((bucket, index) => [bucket.key, index]));
  const trend = buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    startMs: bucket.startMs,
    future: bucket.future,
    blocks: 0,
    minutes: 0,
    activities: 0,
    byCategory: {},
  }));

  // 日视图的桶是小时，其余视图的桶是天（年视图再归到月）。
  const perHour = kind === 'day';
  const keyOfDay = (day) => (kind === 'year' ? String(day).slice(0, 7) : String(day));
  const bucketKey = (row) => (perHour ? String(row.hour).padStart(2, '0') : keyOfDay(row.day));

  for (const row of perHour ? (rows.hours ?? []) : (rows.daily ?? [])) {
    const index = bucketIndex.get(bucketKey(row));
    if (index === undefined) continue;
    const blocks = toCount(row.blocks);
    const bucket = trend[index];
    bucket.blocks += blocks;
    bucket.minutes += blocks * blockMinutes;
    if (row.category) {
      bucket.byCategory[row.category] = (bucket.byCategory[row.category] ?? 0) + blocks * blockMinutes;
    }
  }
  for (const row of perHour ? (rows.hourlyActivities ?? []) : (rows.dailyActivities ?? [])) {
    const index = bucketIndex.get(bucketKey(row));
    if (index === undefined) continue;
    trend[index].activities += toCount(row.count);
  }

  // ---- 时段分布：固定 24 个槽，含分类构成 ----
  const hourly = Array.from({ length: 24 }, (_value, hour) => ({
    hour,
    blocks: 0,
    minutes: 0,
    byCategory: {},
  }));
  for (const row of rows.hours ?? []) {
    const hour = Number(row.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const blocks = toCount(row.blocks);
    hourly[hour].blocks += blocks;
    hourly[hour].minutes += blocks * blockMinutes;
    if (row.category) {
      hourly[hour].byCategory[row.category] = (hourly[hour].byCategory[row.category] ?? 0) + blocks * blockMinutes;
    }
  }

  // ---- 活跃天数：区块与截图记录都算「这一天有数据」 ----
  const activeDays = new Set();
  for (const row of rows.daily ?? []) activeDays.add(String(row.day));
  for (const row of rows.dailyActivities ?? []) activeDays.add(String(row.day));

  const totals = {
    blocks: toCount(rows.totals?.blocks),
    completed: toCount(rows.totals?.completed),
    pending: toCount(rows.totals?.pending),
    failed: toCount(rows.totals?.failed),
    minutes: totalMinutes,
    activities: toCount(rows.activityCount),
    activeDays: activeDays.size,
    days: countDays(from, to),
  };

  return {
    period: kind,
    blockMinutes,
    totals,
    categories,
    projects: buildRanking(rows.projects, {
      key: 'project',
      totalMinutes,
      blockMinutes,
      limit: size.projects,
    }),
    software: buildRanking(rows.software, {
      key: 'name',
      totalMinutes,
      blockMinutes,
      limit: size.software,
    }),
    hourly,
    trend,
    keywords: (rows.keywords ?? [])
      .map((row) => ({ keyword: String(row.keyword), count: toCount(row.count) }))
      .filter((row) => row.keyword && row.count)
      .slice(0, size.keywords),
    todos: (rows.todos ?? [])
      .map((row) => ({ todo: String(row.todo), day: row.day ?? null, count: toCount(row.count) }))
      .filter((row) => row.todo)
      .slice(0, size.todos),
    counts: {
      projects: toCount(rows.projectCount),
      software: toCount(rows.softwareCount),
    },
  };
}

module.exports = { CATEGORY_ORDER, DEFAULT_LIMITS, countDays, buildStats };