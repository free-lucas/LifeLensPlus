'use strict';

const { formatLocalIso } = require('../../time');
const { dayBounds, dayKeyOf, parseDayKey } = require('../../day');
const { withTransaction } = require('../database');
const { INSERT_JOB_SQL, jobValues } = require('../jobRow');

// Phase 9：一天的日记（diaries 表）的读写。SQL 只出现在 repository 层。
//
// 日记是「这一天所有 10 分钟区块」的二阶汇总：区块回答「这 10 分钟在做什么」，
// 日记回答「这一天过得怎么样」。day 是业务主键（本地日期 YYYY-MM-DD）。

const DIARY_COLUMNS = [
  'day',
  'status',
  'block_count',
  'summary',
  'main_events_json',
  'highlights_json',
  'todos_json',
  'suggestions_json',
  'tips_json',
  'model',
  'analysis_ms',
  'error',
  'error_code',
  'created_at',
  'updated_at',
];

const INSERT_DIARY_SQL = `INSERT INTO diaries (${DIARY_COLUMNS.join(', ')}) `
  + `VALUES (${DIARY_COLUMNS.map(() => '?').join(', ')})`;

// 重新生成同一天时走 UPDATE 分支：只重置状态与错误，正文保留到新结果落库，
// 所以「重新生成中」不会把上一次的日记先清空。
const UPSERT_DIARY_SQL = `${INSERT_DIARY_SQL}
  ON CONFLICT(day) DO UPDATE SET
      status = excluded.status,
      block_count = excluded.block_count,
      error = excluded.error,
      error_code = excluded.error_code,
      updated_at = excluded.updated_at`;

const SELECT_COLUMNS = `id, ${DIARY_COLUMNS.join(', ')}`;

// 一天最多 144 个 10 分钟区块；一次扫描最多补 30 天，避免首次启动把队列灌爆。
const DIARY_DEFAULT_SCAN_LIMIT = 30;
const DIARY_MAX_SCAN_LIMIT = 365;

// 日历标记：一天最多列出多少种分类（实际只有四种）。
function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// prepared statement 不接受 undefined / 布尔：可空字段统一收敛成 null。
function diaryValues(entry, now) {
  return [
    entry.day,
    entry.status ?? 'PENDING',
    Number(entry.blockCount) || 0,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    now,
    now,
  ];
}

function toDiary(row) {
  return {
    id: row.day,
    day: row.day,
    status: row.status,
    blockCount: Number(row.block_count) || 0,
    summary: row.summary,
    mainEvents: parseJsonArray(row.main_events_json),
    highlights: parseJsonArray(row.highlights_json),
    todos: parseJsonArray(row.todos_json),
    suggestions: parseJsonArray(row.suggestions_json),
    tips: parseJsonArray(row.tips_json),
    model: row.model,
    analysisMs: row.analysis_ms,
    error: row.error,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 日历 / 详情只认合法的日期键；其余输入返回 null，由调用方决定兜底。
function normalizeDayKey(value) {
  return parseDayKey(dayKeyOf(value)) ? dayKeyOf(value) : null;
}

class DiaryRepository {
  constructor({ db, log = null }) {
    this.db = db;
    this.log = log;
    this.upsertDiaryStatement = db.prepare(UPSERT_DIARY_SQL);
    this.insertJobStatement = db.prepare(INSERT_JOB_SQL);
    this.selectByDayStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM diaries WHERE day = ?`,
    );
    // 上一天有日记：只取最近一条 COMPLETED，作为「今天」的上下文（中间没记录的日子自然跳过）。
    this.selectPreviousStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM diaries
        WHERE day < ? AND status = 'COMPLETED'
        ORDER BY day DESC LIMIT 1`,
    );
    this.statusCountStatement = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending
        FROM diaries
    `);
    // 缺口扫描：已经有区块、却没有日记行、并且没有区块还卡在汇总中的历史日期。
    // 「有没有生成过」靠日记行的存在性判断，所以扫描幂等。
    this.missingDaysStatement = db.prepare(`
      SELECT b.day_key AS day, b.n AS block_count
        FROM (
          SELECT substr(block_start, 1, 10) AS day_key,
                 COUNT(*) AS n,
                 SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending
            FROM time_blocks
           WHERE block_start < ?
           GROUP BY day_key
        ) b
        LEFT JOIN diaries d ON d.day = b.day_key
       WHERE d.day IS NULL AND b.pending = 0 AND b.n > 0
       ORDER BY b.day_key ASC
       LIMIT ?
    `);
    this.selectBetweenStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM diaries
        WHERE day >= ? AND day <= ?
        ORDER BY day ASC`,
    );
    // 日历上的「这一天有多少个时间段」：按天统计区块行，含还没汇总完的。
    this.blockDaysStatement = db.prepare(`
      SELECT substr(block_start, 1, 10) AS day,
             COUNT(*) AS n,
             SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending
        FROM time_blocks
       WHERE block_start >= ? AND block_start < ?
       GROUP BY day
    `);
    // 日历点颜色：这一天时长最长的活动分类。
    this.blockCategoriesStatement = db.prepare(`
      SELECT substr(block_start, 1, 10) AS day, category, COUNT(*) AS n
        FROM time_blocks
       WHERE block_start >= ? AND block_start < ? AND category IS NOT NULL
       GROUP BY day, category
    `);
    this.updateStatements = new Map();
  }

  // 日记任务入队：日记行与 AI Job 在同一个事务里落库（与截图 / 区块路径同构）。
  // 任意一步失败都整体回滚，不会留下「有日记行、没任务」或反过来的半成功状态。
  upsertDiaryWithJob(entry, job) {
    const now = formatLocalIso(new Date());
    return withTransaction(this.db, () => {
      this.upsertDiaryStatement.run(...diaryValues(entry, now));
      // 日记任务关联的是 diaries.day，由 payload 承载，activity_id 固定为 NULL。
      this.insertJobStatement.run(...jobValues(job, { activityId: null, now }));
      return entry.day;
    });
  }

  getByDay(day) {
    const key = normalizeDayKey(day);
    if (!key) return null;
    const row = this.selectByDayStatement.get(key);
    return row ? toDiary(row) : null;
  }

  // 上一天（更早的最近一条）已完成的日记，作为本次生成的上下文。
  findPreviousDiary(day) {
    const key = normalizeDayKey(day);
    if (!key) return null;
    const row = this.selectPreviousStatement.get(key);
    return row ? toDiary(row) : null;
  }

  // 日记统计：驱动界面上的「正在生成 N 篇日记」提示。
  countByStatus() {
    const row = this.statusCountStatement.get();
    return {
      total: Number(row.total) || 0,
      completed: Number(row.completed) || 0,
      failed: Number(row.failed) || 0,
      pending: Number(row.pending) || 0,
    };
  }

  // 启动补扫 / 定时扫描：返回还没生成日记的历史日期（只含日期与区块数）。
  // beforeDay 不含当天：今天还没过完，不生成日记。
  listMissingDays({ beforeDay, limit = DIARY_DEFAULT_SCAN_LIMIT } = {}) {
    const bounds = dayBounds(beforeDay);
    if (!bounds) return [];
    const size = Math.min(
      Math.max(Math.floor(Number(limit) || DIARY_DEFAULT_SCAN_LIMIT), 1),
      DIARY_MAX_SCAN_LIMIT,
    );
    return this.missingDaysStatement.all(bounds.from, size).map((row) => ({
      day: row.day,
      blockCount: Number(row.block_count) || 0,
    }));
  }

  // 日历标记：一段日期内每一天的日记状态、区块数与主要分类。
  // fromDay / toDay 都是闭区间的日期键（调用方按整月网格传入）。
  listDayMarks(fromDay, toDay) {
    const from = dayBounds(fromDay);
    const to = dayBounds(toDay);
    if (!from || !to) return [];

    const marks = new Map();
    const ensure = (day) => {
      let mark = marks.get(day);
      if (!mark) {
        mark = { day, status: null, blockCount: 0, pending: 0, category: null, categoryBlocks: 0 };
        marks.set(day, mark);
      }
      return mark;
    };

    for (const row of this.selectBetweenStatement.all(fromDay, toDay)) {
      ensure(row.day).status = row.status;
    }
    for (const row of this.blockDaysStatement.all(from.from, to.to)) {
      const mark = ensure(row.day);
      mark.blockCount = Number(row.n) || 0;
      mark.pending = Number(row.pending) || 0;
    }
    for (const row of this.blockCategoriesStatement.all(from.from, to.to)) {
      const mark = ensure(row.day);
      const count = Number(row.n) || 0;
      if (count > mark.categoryBlocks) {
        mark.category = row.category;
        mark.categoryBlocks = count;
      }
    }

    return [...marks.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // 日记内容回填：只更新 patch 里出现的字段（与 activities / time_blocks 的回填语义一致）。
  updateDiary(day, patch = {}) {
    const key = normalizeDayKey(day);
    if (!key) return false;

    const assignments = [];
    const values = [];
    const put = (column, value) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if ('status' in patch) put('status', patch.status ?? null);
    if ('blockCount' in patch) put('block_count', Number(patch.blockCount) || 0);
    if ('error' in patch) put('error', patch.error ?? null);
    if ('errorCode' in patch) put('error_code', patch.errorCode ?? null);
    if ('model' in patch) put('model', patch.model ?? null);
    if ('analysisMs' in patch) put('analysis_ms', patch.analysisMs ?? null);
    if ('diary' in patch) {
      const diary = patch.diary ?? null;
      put('summary', diary?.summary ?? null);
      put('main_events_json', diary ? JSON.stringify(diary.mainEvents ?? []) : null);
      put('highlights_json', diary ? JSON.stringify(diary.highlights ?? []) : null);
      put('todos_json', diary ? JSON.stringify(diary.todos ?? []) : null);
      put('suggestions_json', diary ? JSON.stringify(diary.suggestions ?? []) : null);
      put('tips_json', diary ? JSON.stringify(diary.tips ?? []) : null);
    }

    if (!assignments.length) return false;
    put('updated_at', formatLocalIso(new Date()));

    const result = this._updateStatement(assignments).run(...values, key);
    return result.changes > 0;
  }

  _updateStatement(assignments) {
    const columns = assignments.join(', ');
    let statement = this.updateStatements.get(columns);
    if (!statement) {
      statement = this.db.prepare(`UPDATE diaries SET ${columns} WHERE day = ?`);
      this.updateStatements.set(columns, statement);
    }
    return statement;
  }
}

module.exports = {
  DiaryRepository,
  normalizeDayKey,
  DIARY_DEFAULT_SCAN_LIMIT,
  DIARY_MAX_SCAN_LIMIT,
};