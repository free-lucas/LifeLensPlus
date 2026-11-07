'use strict';

const { formatLocalIso } = require('../../time');
const { BLOCK_MINUTES } = require('../../summary/timeBlock');
const { resolvePeriod } = require('../../stats/period');
const { buildStats, DEFAULT_LIMITS } = require('../../stats/summarize');

// Phase 9：看板的聚合查询。SQL 只出现在 repository 层，
// 聚合规则（占比、时长、分桶）在 stats/summarize.js 里，两边职责不重叠。
//
// 所有查询都是「一段时间内的若干行」，没有大表整表读：
// 年视图最坏情况下 group by 出 366 行 / 12 行，交给纯函数做二次汇总。

// 汇总统一只统计分类已经落库的区块（status = COMPLETED 且有 category）。
const COMPLETED = "status = 'COMPLETED'";

class StatsRepository {
  constructor({ db, log = null, blockMinutes = BLOCK_MINUTES }) {
    this.db = db;
    this.log = log;
    this.blockMinutes = blockMinutes;
    this.limits = { ...DEFAULT_LIMITS };

    this.totalsStatement = db.prepare(`
      SELECT COUNT(*) AS blocks,
             SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
        FROM time_blocks
       WHERE block_start >= ? AND block_start < ?
    `);
    this.categoryStatement = db.prepare(`
      SELECT category, COUNT(*) AS blocks
        FROM time_blocks
       WHERE block_start >= ? AND block_start < ? AND ${COMPLETED} AND category IS NOT NULL
       GROUP BY category
    `);
    this.projectStatement = db.prepare(`
      SELECT project, COUNT(*) AS blocks
        FROM time_blocks
       WHERE block_start >= ? AND block_start < ? AND ${COMPLETED}
         AND project IS NOT NULL AND project <> ''
       GROUP BY project
       ORDER BY blocks DESC, project ASC
       LIMIT ?
    `);
    // 软件名存在 JSON 数组里：json_each 展开后按名字分组，同一条区块里的重复名字只算一次。
    this.softwareStatement = db.prepare(`
      SELECT value AS name, COUNT(*) AS blocks
        FROM time_blocks, json_each(time_blocks.software_json)
       WHERE block_start >= ? AND block_start < ? AND ${COMPLETED}
         AND software_json IS NOT NULL AND json_valid(software_json)
       GROUP BY name
       ORDER BY blocks DESC, name ASC
       LIMIT ?
    `);
    // 时段分布 / 日视图的趋势：按小时 × 分类。
    this.hourStatement = db.prepare(`
      SELECT substr(block_start, 12, 2) AS hour, category, COUNT(*) AS blocks
        FROM time_blocks
       WHERE block_start >= ? AND block_start < ? AND ${COMPLETED} AND category IS NOT NULL
       GROUP BY hour, category
    `);
    // 周 / 月 / 年视图的趋势：按天 × 分类。
    this.dailyStatement = db.prepare(`
      SELECT substr(block_start, 1, 10) AS day, category, COUNT(*) AS blocks
        FROM time_blocks
       WHERE block_start >= ? AND block_start < ? AND ${COMPLETED} AND category IS NOT NULL
       GROUP BY day, category
    `);
    // 截图记录数：与区块时长是两个维度（趋势图上的一条折线）。
    this.dailyActivityStatement = db.prepare(`
      SELECT substr(captured_at, 1, 10) AS day, COUNT(*) AS n
        FROM activities
       WHERE captured_at >= ? AND captured_at < ?
       GROUP BY day
    `);
    this.hourlyActivityStatement = db.prepare(`
      SELECT substr(captured_at, 12, 2) AS hour, COUNT(*) AS n
        FROM activities
       WHERE captured_at >= ? AND captured_at < ?
       GROUP BY hour
    `);
    this.keywordStatement = db.prepare(`
      SELECT value AS keyword, COUNT(*) AS n
        FROM activities, json_each(activities.keywords_json)
       WHERE captured_at >= ? AND captured_at < ?
         AND keywords_json IS NOT NULL AND json_valid(keywords_json)
       GROUP BY keyword
       ORDER BY n DESC, keyword ASC
       LIMIT ?
    `);
    // 待办：同一个待办只留一行，带上最早出现的那一天，最近的排在前面。
    this.todoStatement = db.prepare(`
      SELECT value AS todo, MIN(substr(block_start, 1, 10)) AS day, COUNT(*) AS n
        FROM time_blocks, json_each(time_blocks.todos_json)
       WHERE block_start >= ? AND block_start < ? AND ${COMPLETED}
         AND todos_json IS NOT NULL AND json_valid(todos_json)
       GROUP BY todo
       ORDER BY day DESC, n DESC
       LIMIT ?
    `);
    this.activityCountStatement = db.prepare(
      'SELECT COUNT(*) AS n FROM activities WHERE captured_at >= ? AND captured_at < ?',
    );
    this.projectCountStatement = db.prepare(`
      SELECT COUNT(DISTINCT project) AS n
        FROM time_blocks
       WHERE block_start >= ? AND block_start < ? AND ${COMPLETED}
         AND project IS NOT NULL AND project <> ''
    `);
    this.softwareCountStatement = db.prepare(`
      SELECT COUNT(DISTINCT value) AS n
        FROM time_blocks, json_each(time_blocks.software_json)
       WHERE block_start >= ? AND block_start < ? AND ${COMPLETED}
         AND software_json IS NOT NULL AND json_valid(software_json)
    `);
  }

  /**
   * 一个周期的完整聚合结果：总量 + 分类 + 排行 + 趋势 + 关键词 + 待办。
   * @param {{ period?: string, anchor?: string }} query
   */
  summarize(query = {}, { now = new Date() } = {}) {
    const range = resolvePeriod(query.period, query.anchor, { now });
    const from = formatLocalIso(range.from);
    const to = formatLocalIso(range.to);

    const rows = {
      totals: this.totalsStatement.get(from, to),
      categories: this.categoryStatement.all(from, to),
      projects: this.projectStatement.all(from, to, this.limits.projects),
      software: this.softwareStatement.all(from, to, this.limits.software),
      hours: this.hourStatement.all(from, to),
      daily: this.dailyStatement.all(from, to),
      dailyActivities: this.dailyActivityStatement.all(from, to)
        .map((row) => ({ day: row.day, count: row.n })),
      hourlyActivities: this.hourlyActivityStatement.all(from, to)
        .map((row) => ({ hour: row.hour, count: row.n })),
      keywords: this.keywordStatement.all(from, to, this.limits.keywords)
        .map((row) => ({ keyword: row.keyword, count: row.n })),
      todos: this.todoStatement.all(from, to, this.limits.todos)
        .map((row) => ({ todo: row.todo, day: row.day, count: row.n })),
      activityCount: Number(this.activityCountStatement.get(from, to).n) || 0,
      projectCount: Number(this.projectCountStatement.get(from, to).n) || 0,
      softwareCount: Number(this.softwareCountStatement.get(from, to).n) || 0,
    };

    const stats = buildStats({
      period: range.period,
      from: range.from,
      to: range.to,
      rows,
      blockMinutes: this.blockMinutes,
      now,
      limits: this.limits,
    });

    return {
      ...stats,
      anchor: range.anchor,
      label: range.label,
      prevAnchor: range.prevAnchor,
      nextAnchor: range.nextAnchor,
      future: range.future,
      hasToday: range.hasToday,
      from,
      to,
    };
  }
}

module.exports = { StatsRepository };