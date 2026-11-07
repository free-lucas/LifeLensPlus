'use strict';

const { formatLocalIso } = require('../../time');
const { withTransaction } = require('../database');
const { INSERT_JOB_SQL, jobValues } = require('../jobRow');

// Phase 8：10 分钟区块（time_blocks）的读写。SQL 只出现在 repository 层。

// 区块键 = captured_at 的分钟位向下取整到 blockMinutes 的倍数。
// 例：2026-09-15T10:07:23+08:00 -> 2026-09-15T10:00:00+08:00
// 时区偏移从第 20 个字符开始，原样保留，所以与 timeBlock.blockKeyOf() 逐字符一致。
function blockStartExpression(blockMinutes) {
  return 'substr(captured_at, 1, 14) '
    + `|| printf('%02d:00', (CAST(substr(captured_at, 15, 2) AS INTEGER) / ${blockMinutes}) * ${blockMinutes}) `
    + '|| substr(captured_at, 20)';
}

const BLOCK_COLUMNS = [
  'block_start',
  'block_end',
  'status',
  'activity_count',
  'project',
  'category',
  'description',
  'software_json',
  'todos_json',
  'model',
  'analysis_ms',
  'error',
  'error_code',
  'created_at',
  'updated_at',
];

const INSERT_BLOCK_SQL = `INSERT INTO time_blocks (${BLOCK_COLUMNS.join(', ')}) `
  + `VALUES (${BLOCK_COLUMNS.map(() => '?').join(', ')})`;

const SELECT_COLUMNS = `id, ${BLOCK_COLUMNS.join(', ')}`;

// 时间线分页的默认 / 最大页大小，与 Timeline 的约定保持一致。
const BLOCK_DEFAULT_LIMIT = 20;
const BLOCK_MAX_LIMIT = 100;
// 热力图一次读一整段连续时间，不分页，但同样要有上限。
const BLOCK_RANGE_MAX_LIMIT = 288;

// prepared statement 不接受 undefined / 布尔：可空字段统一收敛成 null。
function blockValues(block, now) {
  return [
    block.id,
    block.end ?? null,
    block.status ?? 'PENDING',
    Number(block.activityCount) || 0,
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

// JSON 数组列（software / todos）容错解析：不是数组、不是合法 JSON、为 NULL 都退化成 []。
function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toBlock(row) {
  return {
    id: row.block_start,
    start: row.block_start,
    end: row.block_end,
    status: row.status,
    activityCount: Number(row.activity_count) || 0,
    project: row.project,
    category: row.category,
    description: row.description,
    software: parseJsonArray(row.software_json),
    todos: parseJsonArray(row.todos_json),
    model: row.model,
    analysisMs: row.analysis_ms,
    error: row.error,
    errorCode: row.error_code,
  };
}

// 任意时间输入 -> 与 block_start 同格式的本地 ISO；解析不出来就不加这一侧的边界。
function normalizeInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? null : formatLocalIso(date);
}

function toInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFilterText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeBlockQuery(options) {
  const { from, to, project, software, limit, offset } = options ?? {};
  const size = toInteger(limit) ?? BLOCK_DEFAULT_LIMIT;
  return {
    from: normalizeInstant(from),
    to: normalizeInstant(to),
    project: normalizeFilterText(project),
    software: normalizeFilterText(software),
    limit: Math.min(Math.max(size, 1), BLOCK_MAX_LIMIT),
    offset: Math.max(toInteger(offset) ?? 0, 0),
  };
}

class TimeBlockRepository {
  constructor({ db, log = null, blockMinutes = 10 }) {
    this.db = db;
    this.log = log;
    this.blockMinutes = blockMinutes;
    this.insertBlockStatement = db.prepare(INSERT_BLOCK_SQL);
    this.insertJobStatement = db.prepare(INSERT_JOB_SQL);
    this.selectByStartStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM time_blocks WHERE block_start = ?`,
    );
    // 上一个已汇总的区块：取它之前最近的一条 COMPLETED（中间的空档与失败区块自然跳过）。
    this.selectPreviousStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM time_blocks
        WHERE block_start < ? AND status = 'COMPLETED'
        ORDER BY block_start DESC LIMIT 1`,
    );
    this.statusCountStatement = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending
        FROM time_blocks
    `);
    // 缺口扫描：有记录、却还没有区块行的已结束区块（按时间从前到后）。
    this.missingBlocksStatement = db.prepare(`
      SELECT b.block_start AS block_start, b.n AS activity_count
        FROM (
          SELECT ${blockStartExpression(blockMinutes)} AS block_start, COUNT(*) AS n
            FROM activities
           WHERE captured_at < ?
           GROUP BY block_start
        ) b
        LEFT JOIN time_blocks t ON t.block_start = b.block_start
       WHERE t.block_start IS NULL
       ORDER BY b.block_start ASC
       LIMIT ?
    `);
    // 筛选选项：项目与软件都从已有数据里取（软件名从 JSON 数组里展开）。
    this.facetProjectStatement = db.prepare(
      `SELECT DISTINCT project FROM time_blocks
        WHERE project IS NOT NULL AND project <> '' ORDER BY project`,
    );
    this.facetSoftwareStatement = db.prepare(
      `SELECT DISTINCT value AS name
         FROM time_blocks, json_each(time_blocks.software_json)
        WHERE software_json IS NOT NULL AND json_valid(software_json)
        ORDER BY name`,
    );
    this.rangeSelectStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM time_blocks
        WHERE block_start >= ? AND block_start < ?
        ORDER BY block_start ASC LIMIT ?`,
    );
    // 日记页的「这一天有多少个时间段」：按状态与分类数，不读正文。
    this.daySummaryStatement = db.prepare(`
      SELECT status, category, COUNT(*) AS n
        FROM time_blocks
       WHERE block_start >= ? AND block_start < ?
       GROUP BY status, category
    `);
    this.updateStatements = new Map();
    this.queryStatements = new Map();
  }

  // 汇总任务入队：区块记录与 AI Job 在同一个事务里落库。
  // 任意一步失败都整体回滚，不会留下「有区块行、没任务」或反过来的半成功状态。
  insertBlockWithJob(block, job) {
    const now = formatLocalIso(new Date());
    return withTransaction(this.db, () => {
      const result = this.insertBlockStatement.run(...blockValues(block, now));
      // 区块任务不关联 activities，activity_id 固定为 NULL。
      this.insertJobStatement.run(...jobValues(job, { activityId: null, now }));
      return Number(result.lastInsertRowid);
    });
  }

  getByStart(blockStart) {
    const row = this.selectByStartStatement.get(blockStart);
    return row ? toBlock(row) : null;
  }

  // 上一个 10 分钟的汇总，作为本次汇总的上下文。
  findPreviousSummary(blockStart) {
    const row = this.selectPreviousStatement.get(blockStart);
    return row ? toBlock(row) : null;
  }

  // 汇总中标记 / 状态统计。
  countByStatus() {
    const row = this.statusCountStatement.get();
    return {
      total: Number(row.total) || 0,
      completed: Number(row.completed) || 0,
      failed: Number(row.failed) || 0,
      pending: Number(row.pending) || 0,
    };
  }

  // 启动补扫 / 定时扫描：返回还没汇总的已结束区块（只含区块起点与记录数）。
  listMissingBlocks({ before, limit = 144 } = {}) {
    const size = Math.max(1, Math.floor(Number(limit) || 144));
    return this.missingBlocksStatement.all(before, size).map((row) => ({
      blockStart: row.block_start,
      activityCount: Number(row.activity_count) || 0,
    }));
  }

  // 汇总结果回填：只更新 patch 里出现的字段（与 activities.updateAnalysis 语义一致）。
  updateSummary(blockStart, patch = {}) {
    const assignments = [];
    const values = [];
    const put = (column, value) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if ('status' in patch) put('status', patch.status ?? null);
    if ('error' in patch) put('error', patch.error ?? null);
    if ('errorCode' in patch) put('error_code', patch.errorCode ?? null);
    if ('model' in patch) put('model', patch.model ?? null);
    if ('analysisMs' in patch) put('analysis_ms', patch.analysisMs ?? null);
    if ('summary' in patch) {
      const summary = patch.summary ?? null;
      put('project', summary?.project ?? null);
      put('category', summary?.category ?? null);
      put('description', summary?.description ?? null);
      put('software_json', summary ? JSON.stringify(summary.software ?? []) : null);
      put('todos_json', summary ? JSON.stringify(summary.todos ?? []) : null);
    }

    if (!assignments.length) return false;
    put('updated_at', formatLocalIso(new Date()));

    const result = this._updateStatement(assignments).run(...values, blockStart);
    return result.changes > 0;
  }

  // 动态时间线查询：按区块起点倒序分页，from 为闭区间、to 为开区间。
  queryBlocks(options) {
    const query = normalizeBlockQuery(options);
    const { where, values } = this._buildWhere(query);

    const statements = this._queryStatements(where);
    const total = Number(statements.count.get(...values).total) || 0;
    const rows = statements.select.all(...values, query.limit, query.offset);

    return {
      items: rows.map(toBlock),
      total,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + rows.length < total,
    };
  }

  // 热力图：一段连续时间内的全部区块，按时间正序。
  listBlocksBetween(from, to, { limit = BLOCK_RANGE_MAX_LIMIT } = {}) {
    const size = Math.min(
      Math.max(Math.floor(Number(limit) || BLOCK_RANGE_MAX_LIMIT), 1),
      BLOCK_RANGE_MAX_LIMIT,
    );
    return this.rangeSelectStatement
      .all(normalizeInstant(from), normalizeInstant(to), size)
      .map(toBlock);
  }

  listFacets() {
    return {
      projects: this.facetProjectStatement.all().map((row) => row.project),
      software: this.facetSoftwareStatement.all().map((row) => row.name),
    };
  }

  // 某一天的区块概况（日记页用）：时段总数、各状态数量与分类构成。
  // from 为闭区间、to 为开区间，与其余查询一致。
  daySummary(from, to) {
    const rows = this.daySummaryStatement.all(normalizeInstant(from), normalizeInstant(to));
    const summary = {
      total: 0,
      completed: 0,
      pending: 0,
      failed: 0,
      categorized: 0,
      categories: [],
    };
    const categories = new Map();
    for (const row of rows) {
      const count = Number(row.n) || 0;
      summary.total += count;
      if (row.status === 'COMPLETED') summary.completed += count;
      else if (row.status === 'FAILED') summary.failed += count;
      else summary.pending += count;
      if (row.category) {
        summary.categorized += count;
        categories.set(row.category, (categories.get(row.category) ?? 0) + count);
      }
    }
    summary.categories = [...categories.entries()]
      .map(([category, blocks]) => ({ category, blocks }))
      .sort((a, b) => b.blocks - a.blocks || (a.category < b.category ? -1 : 1));
    return summary;
  }

  _buildWhere(query) {
    const conditions = [];
    const values = [];
    if (query.from) {
      conditions.push('block_start >= ?');
      values.push(query.from);
    }
    if (query.to) {
      conditions.push('block_start < ?');
      values.push(query.to);
    }
    if (query.project) {
      conditions.push('project = ?');
      values.push(query.project);
    }
    if (query.software) {
      // 软件名存在 JSON 数组里：用 json_each 精确匹配单个名字，
      // 避免 LIKE 把「Code」这类子串误判成命中。
      conditions.push(
        'EXISTS (SELECT 1 FROM json_each(time_blocks.software_json) WHERE value = ?)',
      );
      values.push(query.software);
    }
    return {
      where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
      values,
    };
  }

  _queryStatements(where) {
    let statements = this.queryStatements.get(where);
    if (!statements) {
      statements = {
        count: this.db.prepare(`SELECT COUNT(*) AS total FROM time_blocks${where}`),
        select: this.db.prepare(
          `SELECT ${SELECT_COLUMNS} FROM time_blocks${where}`
          + ' ORDER BY block_start DESC LIMIT ? OFFSET ?',
        ),
      };
      this.queryStatements.set(where, statements);
    }
    return statements;
  }

  _updateStatement(assignments) {
    const columns = assignments.join(', ');
    let statement = this.updateStatements.get(columns);
    if (!statement) {
      statement = this.db.prepare(`UPDATE time_blocks SET ${columns} WHERE block_start = ?`);
      this.updateStatements.set(columns, statement);
    }
    return statement;
  }
}

module.exports = {
  TimeBlockRepository,
  blockStartExpression,
  BLOCK_DEFAULT_LIMIT,
  BLOCK_MAX_LIMIT,
  BLOCK_RANGE_MAX_LIMIT,
};
