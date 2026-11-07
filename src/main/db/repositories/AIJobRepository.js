'use strict';

const { formatLocalIso } = require('../../time');
const { AIJobType } = require('../../ai/job');
const { ERROR_CODES } = require('../../ai/errors');
const { EVENTS } = require('../../ai/jobEventLog');
const { withTransaction } = require('../database');
const { JOB_COLUMNS, jobValues } = require('../jobRow');

const SELECT_JOBS_SQL = `
  SELECT id, type, status, priority, retry_count, max_retries,
         error_code, error_message, last_error, payload_json,
         created_at, started_at, completed_at, failed_at
    FROM ai_jobs
   ORDER BY created_at ASC, rowid ASC
`;

// upsert：状态变更（重试次数 / 时间戳 / 错误 / payload）全部覆盖，
// type 与 created_at 是创建后不再变的事实，保持原值。
const UPSERT_JOB_SQL = `
  INSERT INTO ai_jobs (${JOB_COLUMNS.join(', ')})
  VALUES (${JOB_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET
      activity_id = excluded.activity_id,
      status = excluded.status,
      priority = excluded.priority,
      retry_count = excluded.retry_count,
      max_retries = excluded.max_retries,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      last_error = excluded.last_error,
      payload_json = excluded.payload_json,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      failed_at = excluded.failed_at,
      updated_at = excluded.updated_at
`;

function parsePayload(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 单行 payload 损坏时不让整个队列加载失败。
    return {};
  }
}

// 数据库行 -> AIJob（与 JSON 时代完全一致的对象结构，Worker / Recorder 零改动）。
function toJob(row) {
  const hasError = row.error_code !== null || row.error_message !== null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    priority: Number(row.priority),
    payload: parsePayload(row.payload_json),
    retryCount: Number(row.retry_count),
    maxRetries: Number(row.max_retries),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    error: hasError ? { code: row.error_code, message: row.error_message ?? '' } : null,
    lastError: row.last_error,
  };
}

// Job 的持久化：Electron 崩溃/重启后队列不能凭空消失。
// 队列每次把内存里的完整列表交给 save()，这里在同一个事务里做快照同步：
// upsert 列表里的每一行，再删掉已经不在列表里的行（终态裁剪因此也发生在这个事务里），
// 所以 ai_jobs 不会无限增长，也不会出现 SQLite 与内存两份状态不一致。
class AIJobRepository {
  constructor({ db, activities, log = null }) {
    this.db = db;
    this.activities = activities;
    this.log = log;
    this.selectJobsStatement = db.prepare(SELECT_JOBS_SQL);
    this.upsertJobStatement = db.prepare(UPSERT_JOB_SQL);
    this.deleteAllStatement = db.prepare('DELETE FROM ai_jobs');
    // 删除语句的占位符数量随快照长度变化，按长度缓存。
    this.deleteMissingStatements = new Map();
  }

  load() {
    return this.selectJobsStatement.all().map(toJob);
  }

  async save(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    const now = formatLocalIso(new Date());

    withTransaction(this.db, () => {
      for (const job of list) {
        this.upsertJobStatement.run(...jobValues(job, { activityId: this._activityId(job), now }));
      }
      this._deleteMissing(list.map((job) => job.id));
    });

    return list.length;
  }

  // SCREENSHOT_ANALYSIS 的 Job 关联到 activities.id，用于外键约束与关系查询。
  // 事务保证正常情况下一定找得到；找不到（例如记录已被清理）就存 NULL 并留下 warning。
  _activityId(job) {
    if (job.type !== AIJobType.SCREENSHOT_ANALYSIS) return null;
    const screenshotId = job.payload?.screenshotId;
    if (!screenshotId) return null;

    const activityId = this.activities.findIdByScreenshotId(screenshotId);
    if (activityId === null) {
      this.log?.record(EVENTS.STORAGE_ERROR, {
        job,
        errorCode: ERROR_CODES.STORAGE_ERROR,
        message: `找不到对应的截图记录 ${screenshotId}，activity_id 记为 NULL`,
      });
    }
    return activityId;
  }

  _deleteMissing(ids) {
    if (!ids.length) return this.deleteAllStatement.run();

    let statement = this.deleteMissingStatements.get(ids.length);
    if (!statement) {
      const placeholders = ids.map(() => '?').join(', ');
      statement = this.db.prepare(`DELETE FROM ai_jobs WHERE id NOT IN (${placeholders})`);
      this.deleteMissingStatements.set(ids.length, statement);
    }
    return statement.run(...ids);
  }
}

module.exports = { AIJobRepository, UPSERT_JOB_SQL };
