'use strict';

const { formatLocalIso } = require('../time');

// Job 生命周期事件。日志只记录元信息（jobId / 类型 / 状态 / 错误码），
// 绝不记录截图内容、图片路径、Prompt 等敏感信息。
const EVENTS = Object.freeze({
  JOB_ENQUEUED: 'JOB_ENQUEUED',
  JOB_STARTED: 'JOB_STARTED',
  JOB_COMPLETED: 'JOB_COMPLETED',
  JOB_FAILED: 'JOB_FAILED',
  JOB_RETRY: 'JOB_RETRY',
  JOB_CANCELLED: 'JOB_CANCELLED',
  JOB_SKIPPED: 'JOB_SKIPPED',
  JOB_RECOVERED: 'JOB_RECOVERED',
  JOB_RESULT_NOT_PERSISTED: 'JOB_RESULT_NOT_PERSISTED',
  WORKER_STARTED: 'WORKER_STARTED',
  WORKER_STOPPED: 'WORKER_STOPPED',
  WORKER_PAUSED: 'WORKER_PAUSED',
  WORKER_RESUMED: 'WORKER_RESUMED',
  AI_OFFLINE: 'AI_OFFLINE',
  AI_ONLINE: 'AI_ONLINE',
  STORAGE_ERROR: 'STORAGE_ERROR',
  RECOVERY_SCAN: 'RECOVERY_SCAN',
  SUMMARY_SCAN: 'SUMMARY_SCAN',
  DIARY_SCAN: 'DIARY_SCAN',
  // Phase 10：embedding 扫描 / 启动补偿 / 模型降级与恢复 / 批次失败。
  EMBEDDING_SCAN: 'EMBEDDING_SCAN',
  EMBEDDING_RECOVERED: 'EMBEDDING_RECOVERED',
  EMBEDDING_OFFLINE: 'EMBEDDING_OFFLINE',
  EMBEDDING_ONLINE: 'EMBEDDING_ONLINE',
  EMBEDDING_ERROR: 'EMBEDDING_ERROR',
  // Phase 11：记忆搜索的命中统计与单层 / 单条失败（只记元信息，不记查询文本）。
  MEMORY_SEARCH: 'MEMORY_SEARCH',
  MEMORY_SEARCH_ERROR: 'MEMORY_SEARCH_ERROR',
});

const MAX_ENTRIES = 100;

class JobEventLog {
  constructor({ max = MAX_ENTRIES, sink = console, now = () => new Date() } = {}) {
    this.max = max;
    this.sink = sink;
    this.now = now;
    this.entries = [];
  }

  record(event, { job = null, jobId, jobType, status, errorCode, message } = {}) {
    const entry = {
      at: formatLocalIso(this.now()),
      event,
      jobId: jobId ?? job?.id ?? null,
      jobType: jobType ?? job?.type ?? null,
      status: status ?? job?.status ?? null,
      errorCode: errorCode ?? null,
      message: message ?? null,
    };

    this.entries.push(entry);
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }

    const parts = [
      `[AI-JOB] ${entry.at} ${event}`,
      `job=${entry.jobId || '-'}`,
      `type=${entry.jobType || '-'}`,
      `status=${entry.status || '-'}`,
    ];
    if (entry.errorCode) parts.push(`error=${entry.errorCode}`);
    if (entry.message) parts.push(entry.message);
    try {
      this.sink.log(parts.join(' '));
    } catch {
      // 日志失败绝不能影响 Job 处理。
    }

    return entry;
  }

  // 最近的日志，新的在前。
  list(limit = 20) {
    return this.entries.slice(-limit).reverse();
  }
}

module.exports = { JobEventLog, EVENTS, MAX_ENTRIES };
