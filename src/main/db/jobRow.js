'use strict';

const { DEFAULT_MAX_RETRIES, JOB_PRIORITY } = require('../ai/job');

// ai_jobs 的列顺序与取值映射：ActivityRepository（事务里插入新 Job）与
// AIJobRepository（快照 upsert）共用，避免两边各写一份列清单导致漂移。
const JOB_COLUMNS = [
  'id',
  'type',
  'activity_id',
  'status',
  'priority',
  'retry_count',
  'max_retries',
  'error_code',
  'error_message',
  'last_error',
  'payload_json',
  'created_at',
  'started_at',
  'completed_at',
  'failed_at',
  'updated_at',
];

const INSERT_JOB_SQL = `INSERT INTO ai_jobs (${JOB_COLUMNS.join(', ')}) VALUES (${JOB_COLUMNS
  .map(() => '?')
  .join(', ')})`;

// prepared statement 不接受 undefined / 布尔，所有可空字段统一收敛成 null。
function jobValues(job, { activityId = null, now }) {
  const priority = Number(job.priority);
  const maxRetries = Number(job.maxRetries);
  return [
    job.id,
    job.type,
    activityId ?? null,
    job.status,
    Number.isFinite(priority) ? priority : JOB_PRIORITY.NORMAL,
    Number(job.retryCount) || 0,
    Number.isFinite(maxRetries) ? maxRetries : DEFAULT_MAX_RETRIES,
    job.error?.code ?? null,
    job.error?.message ?? null,
    job.lastError ?? null,
    JSON.stringify(job.payload ?? {}),
    job.createdAt,
    job.startedAt ?? null,
    job.completedAt ?? null,
    job.failedAt ?? null,
    now,
  ];
}

module.exports = { JOB_COLUMNS, INSERT_JOB_SQL, jobValues };
