'use strict';

const { formatLocalIso } = require('../../time');
const { withTransaction } = require('../database');
const { INSERT_JOB_SQL, jobValues } = require('../jobRow');
const { ERROR_CODES } = require('../../ai/errors');
const { EVENTS } = require('../../ai/jobEventLog');

// SQL 只出现在 repository 层：Recorder / Queue / Worker / IPC 都不直接写 SQL（第 14 节）。
const INSERT_ACTIVITY_SQL = `
  INSERT INTO activities (
      screenshot_id, captured_at, image_path, analysis_status,
      activity, summary, category, project, keywords_json, confidence,
      model, analysis_ms, error, error_code, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// 结构化结果只要有任何一列有值，就还原成 analysis 对象。
const ANALYSIS_COLUMNS = ['activity', 'summary', 'category', 'project', 'keywords_json', 'confidence'];

const SELECT_COLUMNS = 'id, screenshot_id, captured_at, image_path, analysis_status, '
  + 'activity, summary, category, project, keywords_json, confidence, '
  + 'model, analysis_ms, error, error_code, created_at, updated_at';

// Timeline 分页的默认 / 最大页大小，与 IPC 里 recent 的上限保持一致。
const TIMELINE_DEFAULT_LIMIT = 20;
const TIMELINE_MAX_LIMIT = 100;

// 截图记录（业务对象）-> activities 的列值。
// record.imagePath 沿用绝对路径：Worker 靠它读图、Renderer 靠它打开截图。
function activityValues(record, now) {
  const analysis = record.analysis ?? null;
  return [
    record.id,
    record.time,
    record.imagePath,
    record.analysisStatus ?? 'PENDING',
    analysis?.activity ?? null,
    analysis?.summary ?? null,
    analysis?.category ?? null,
    analysis?.project ?? null,
    analysis ? JSON.stringify(analysis.keywords ?? []) : null,
    analysis?.confidence ?? null,
    record.model ?? null,
    record.analysisMs ?? null,
    record.error ?? null,
    record.errorCode ?? null,
    now,
    now,
  ];
}

function parseKeywords(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 单行数据损坏不应该让整份列表读不出来。
    return [];
  }
}

function hasAnalysis(row) {
  return ANALYSIS_COLUMNS.some((column) => row[column] !== null);
}

// 任意时间输入（Date / 毫秒时间戳 / 可解析的时间字符串）-> 与 captured_at 同格式的本地 ISO。
// 解析不出来就返回 null：这一侧不加时间边界，而不是让整次查询失败。
function normalizeInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? null : formatLocalIso(date);
}

// 空值 / 非数字 -> null，由调用方决定默认值。
function toInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? parsed : null;
}

// 筛选文本：只有非空字符串才算条件，其余（null / undefined / 数字 / 全空白）一律不筛。
function normalizeFilterText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// LIKE 的通配符转义：用户输入的 % / _ 只按普通字符匹配（SQL 侧配 ESCAPE）。
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => '\\' + char);
}

// AI 状态筛选（Phase 7.3）：与界面上「已完成 / 分析中 / 失败」三个档位一一对应。
// 「分析中」= 既没完成也没失败，涵盖 PENDING / PROCESSING 与将来新增的中间状态，
// 与渲染层 statusOf() 的兜底口径一致。
const TIMELINE_STATUS_FILTERS = Object.freeze({
  COMPLETED: { sql: 'analysis_status = ?', values: ['COMPLETED'] },
  FAILED: { sql: 'analysis_status = ?', values: ['FAILED'] },
  PENDING: { sql: 'analysis_status NOT IN (?, ?)', values: ['COMPLETED', 'FAILED'] },
});

// 关键词搜索命中的列：活动 / 摘要 / 项目 / 关键词（keywords_json 存的是 JSON 字符串）。
const TIMELINE_SEARCH_COLUMNS = ['activity', 'summary', 'project', 'keywords_json'];

// LIKE 的转义字符用绑定参数传，SQL 里就不需要嵌引号；转义字符本身是一个反斜杠。
const LIKE_ESCAPE = '\\';
const TIMELINE_SEARCH_CLAUSES = TIMELINE_SEARCH_COLUMNS
  .map((column) => `${column} LIKE ? ESCAPE ?`)
  .join(' OR ');

// 时间边界、筛选条件与分页参数统一在这里收敛成可以直接绑定给 SQL 的形式。
function normalizeTimelineQuery(options) {
  const { from, to, limit, offset, search, category, project, noProject, status } = options ?? {};
  const size = toInteger(limit) ?? TIMELINE_DEFAULT_LIMIT;
  return {
    from: normalizeInstant(from),
    to: normalizeInstant(to),
    search: normalizeFilterText(search),
    category: normalizeFilterText(category),
    project: normalizeFilterText(project),
    noProject: noProject === true,
    // 认不出来的状态不加条件（与时间解析失败的处理一致），而不是让查询失败。
    status: typeof status === 'string' ? status.trim().toUpperCase() : null,
    limit: Math.min(Math.max(size, 1), TIMELINE_MAX_LIMIT),
    offset: Math.max(toInteger(offset) ?? 0, 0),
  };
}

// 数据库行 -> 业务对象（普通对象，不是 null-prototype），字段名与 Phase 5 一致。
function toRecord(row) {
  return {
    id: row.screenshot_id,
    time: row.captured_at,
    imagePath: row.image_path,
    analysisStatus: row.analysis_status,
    analysis: hasAnalysis(row)
      ? {
          activity: row.activity,
          summary: row.summary,
          category: row.category,
          project: row.project,
          keywords: parseKeywords(row.keywords_json),
          confidence: row.confidence,
        }
      : null,
    summary: row.summary,
    model: row.model,
    analysisMs: row.analysis_ms,
    error: row.error,
    errorCode: row.error_code,
  };
}

class ActivityRepository {
  constructor({ db, log = null }) {
    this.db = db;
    this.log = log;
    this.insertActivityStatement = db.prepare(INSERT_ACTIVITY_SQL);
    this.insertJobStatement = db.prepare(INSERT_JOB_SQL);
    this.selectByScreenshotStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM activities WHERE screenshot_id = ?`,
    );
    // 记忆搜索回查用：向量行的 source_id 就是 activities.id（Phase 10 的 activity: 前缀）。
    this.selectByIdStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM activities WHERE id = ?`,
    );
    this.selectIdStatement = db.prepare('SELECT id FROM activities WHERE screenshot_id = ?');
    this.selectRecentStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM activities ORDER BY captured_at DESC, id DESC LIMIT ?`,
    );
    this.selectPendingStatement = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM activities
        WHERE analysis_status = 'PENDING'
        ORDER BY captured_at ASC, id ASC`,
    );
    this.statsStatement = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN analysis_status = 'COMPLETED' THEN 1 ELSE 0 END) AS analyzed,
             SUM(CASE WHEN analysis_status = 'FAILED' THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN analysis_status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
             MAX(captured_at) AS last_capture_at
        FROM activities
    `);
    // 筛选选项（Phase 7.3）：分类 / 项目清单从已有数据里取，不在代码里另维护一份定义。
    this.facetCategoryStatement = db.prepare(
      `SELECT DISTINCT category FROM activities
        WHERE category IS NOT NULL AND category <> '' ORDER BY category`,
    );
    this.facetProjectStatement = db.prepare(
      `SELECT DISTINCT project FROM activities
        WHERE project IS NOT NULL AND project <> '' ORDER BY project`,
    );
    this.facetUnassignedStatement = db.prepare(
      `SELECT EXISTS(
        SELECT 1 FROM activities WHERE project IS NULL OR project = ''
      ) AS found`,
    );
    // 区块汇总的上下文（Phase 8）：只取汇总需要的字段，不整行读出来。
    this.summaryContextStatement = db.prepare(
      `SELECT captured_at, analysis_status, activity, summary, category, project, keywords_json
         FROM activities
        WHERE captured_at >= ? AND captured_at < ?
        ORDER BY captured_at ASC, id ASC`,
    );
    // 日记页的「这一天有多少条记录」：只数数，不读内容（走 captured_at 索引）。
    this.countBetweenStatement = db.prepare(
      'SELECT COUNT(*) AS n FROM activities WHERE captured_at >= ? AND captured_at < ?',
    );
    // 回填的字段组合只有固定几种，按列名缓存 prepared statement。
    this.updateStatements = new Map();
    // Timeline 的 WHERE 组合同样只有固定几种，按 SQL 片段缓存「查询 + 计数」两条语句。
    this.timelineStatements = new Map();
  }

  // 只写 Activity（不建 Job 的路径，例如测试或未来的其他来源）。
  createActivity(record) {
    const now = formatLocalIso(new Date());
    const result = this.insertActivityStatement.run(...activityValues(record, now));
    return Number(result.lastInsertRowid);
  }

  // Recorder 的截图路径：Activity 与 AI Job 必须在同一个事务里落库。
  // 任意一步失败都整体回滚，不会留下「有记录、没任务」的半成功状态（第 22 节）。
  insertActivityWithJob(record, job) {
    const now = formatLocalIso(new Date());
    return withTransaction(this.db, () => {
      const result = this.insertActivityStatement.run(...activityValues(record, now));
      const activityId = Number(result.lastInsertRowid);
      this.insertJobStatement.run(...jobValues(job, { activityId, now }));
      return activityId;
    });
  }

  // AI 分析结束后的回填：只更新 patch 里出现的字段（与 JSON 时代 Object.assign 语义一致），
  // 所以失败回填不会把上一次成功的结构化结果抹掉。
  updateAnalysis(screenshotId, patch = {}) {
    const assignments = [];
    const values = [];
    const put = (column, value) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if ('analysisStatus' in patch) put('analysis_status', patch.analysisStatus ?? null);
    if ('error' in patch) put('error', patch.error ?? null);
    if ('errorCode' in patch) put('error_code', patch.errorCode ?? null);
    if ('model' in patch) put('model', patch.model ?? null);
    if ('analysisMs' in patch) put('analysis_ms', patch.analysisMs ?? null);
    if ('analysis' in patch) {
      const analysis = patch.analysis ?? null;
      put('activity', analysis?.activity ?? null);
      put('summary', analysis?.summary ?? null);
      put('category', analysis?.category ?? null);
      put('project', analysis?.project ?? null);
      put('keywords_json', analysis ? JSON.stringify(analysis.keywords ?? []) : null);
      put('confidence', analysis?.confidence ?? null);
    }

    if (!assignments.length) return false;
    put('updated_at', formatLocalIso(new Date()));

    const result = this._updateStatement(assignments).run(...values, screenshotId);
    return result.changes > 0;
  }

  getByScreenshotId(screenshotId) {
    const row = this.selectByScreenshotStatement.get(screenshotId);
    return row ? toRecord(row) : null;
  }

  // 按自增主键取一条：搜索结果的回查入口（主键不是整数就当作找不到）。
  getById(id) {
    const numeric = toInteger(id);
    if (numeric === null) return null;
    const row = this.selectByIdStatement.get(numeric);
    return row ? toRecord(row) : null;
  }

  // Job 关联 Activity 用：只需要主键，不用把整行读出来。
  findIdByScreenshotId(screenshotId) {
    const row = this.selectIdStatement.get(screenshotId);
    return row ? Number(row.id) : null;
  }

  // 最近的记录，按时间从新到旧（界面用）。
  listRecent(limit = 20) {
    const size = Number.isFinite(limit) ? Math.max(1, Math.floor(Number(limit))) : 20;
    return this.selectRecentStatement.all(size).map(toRecord);
  }

  // 启动补偿用：所有还没拿到分析结果的记录（Phase 5.1）。
  listPendingRecords() {
    return this.selectPendingStatement.all().map(toRecord);
  }

  // 界面上的历史统计，跨会话保留。
  loadStats() {
    const row = this.statsStatement.get();
    return {
      total: Number(row.total) || 0,
      analyzed: Number(row.analyzed) || 0,
      errors: Number(row.errors) || 0,
      pending: Number(row.pending) || 0,
      lastCaptureAt: row.last_capture_at ?? null,
    };
  }

  // 筛选选项（Phase 7.3）：当前数据里出现过的分类与项目，供界面填下拉框。
  // 只返回非空值；hasUnassignedProject 表示存在没有项目的记录，界面上才有「无项目」这一项。
  listFacets() {
    return {
      categories: this.facetCategoryStatement.all().map((row) => row.category),
      projects: this.facetProjectStatement.all().map((row) => row.project),
      hasUnassignedProject: Number(this.facetUnassignedStatement.get().found) > 0,
    };
  }

  // 10 分钟区块汇总的原始素材：这段时间里的每条记录（含还没分析出结果的）。
  // 与 listRecent 不同，这里用的是面向汇总的紧凑读模型，不需要图片路径等字段。
  listSummaryContext(blockStart, blockEnd) {
    return this.summaryContextStatement.all(blockStart, blockEnd).map((row) => ({
      time: row.captured_at,
      status: row.analysis_status,
      activity: row.activity,
      summary: row.summary,
      category: row.category,
      project: row.project,
      keywords: parseKeywords(row.keywords_json),
    }));
  }

  // 一段时间里的截图条数（日记页用）：只数数，不读内容。
  countBetween(from, to) {
    const row = this.countBetweenStatement.get(normalizeInstant(from), normalizeInstant(to));
    return Number(row?.n) || 0;
  }

  // Timeline 查询（Phase 7.1）：按截图时间倒序分页读取活动记录。
  // from 为闭区间、to 为开区间（[from, to)），两者都接受 Date / 毫秒时间戳 / 可解析的时间字符串；
  // 排序只看 captured_at（截图时间），与 AI 完成时间无关。
  // 返回 { items, total, limit, offset, hasMore }，items 的字段与 listRecent 完全一致。
  queryTimeline(options) {
    const query = normalizeTimelineQuery(options);
    const conditions = [];
    const values = [];
    if (query.from) {
      conditions.push('captured_at >= ?');
      values.push(query.from);
    }
    if (query.to) {
      conditions.push('captured_at < ?');
      values.push(query.to);
    }
    if (query.search) {
      // 关键词同时匹配活动 / 摘要 / 项目 / 关键词四列；LIKE 对 ASCII 不分大小写，中文按子串匹配。
      const pattern = `%${escapeLike(query.search)}%`;
      conditions.push(`(${TIMELINE_SEARCH_CLAUSES})`);
      for (let index = 0; index < TIMELINE_SEARCH_COLUMNS.length; index += 1) {
        values.push(pattern, LIKE_ESCAPE);
      }
    }
    if (query.category) {
      conditions.push('category = ?');
      values.push(query.category);
    }
    // 「只看没有项目」与具体项目互斥：同时传时以 noProject 为准（避免两个条件互相抵消）。
    if (query.noProject) {
      conditions.push(`(project IS NULL OR project = '')`);
    } else if (query.project) {
      conditions.push('project = ?');
      values.push(query.project);
    }
    const statusFilter = TIMELINE_STATUS_FILTERS[query.status];
    if (statusFilter) {
      conditions.push(statusFilter.sql);
      values.push(...statusFilter.values);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    const statements = this._timelineStatements(where);
    const total = Number(statements.count.get(...values).total) || 0;
    const rows = statements.select.all(...values, query.limit, query.offset);
    const items = [];
    for (const row of rows) {
      const record = this._toTimelineItem(row);
      if (record) items.push(record);
    }

    return {
      items,
      total,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + rows.length < total,
    };
  }

  // 单条记录损坏（例如 keywords_json 被外部写坏）只跳过这一行，不能让整条时间线查询失败。
  _toTimelineItem(row) {
    try {
      return toRecord(row);
    } catch (error) {
      this.log?.record(EVENTS.STORAGE_ERROR, {
        errorCode: ERROR_CODES.STORAGE_ERROR,
        message: `时间线跳过无法解析的记录 ${row?.screenshot_id ?? '?'}：${error.message}`,
      });
      return null;
    }
  }

  _timelineStatements(where) {
    let statements = this.timelineStatements.get(where);
    if (!statements) {
      statements = {
        count: this.db.prepare(`SELECT COUNT(*) AS total FROM activities${where}`),
        select: this.db.prepare(
          `SELECT ${SELECT_COLUMNS} FROM activities${where}`
          + ' ORDER BY captured_at DESC, id DESC LIMIT ? OFFSET ?',
        ),
      };
      this.timelineStatements.set(where, statements);
    }
    return statements;
  }

  _updateStatement(assignments) {
    const columns = assignments.join(', ');
    let statement = this.updateStatements.get(columns);
    if (!statement) {
      statement = this.db.prepare(`UPDATE activities SET ${columns} WHERE screenshot_id = ?`);
      this.updateStatements.set(columns, statement);
    }
    return statement;
  }
}

module.exports = { ActivityRepository };
