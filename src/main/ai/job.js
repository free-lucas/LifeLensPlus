'use strict';

const { randomUUID } = require('node:crypto');

const { formatLocalIso } = require('../time');

/**
 * AI Job 数据模型。
 *
 * @typedef {object} AIJob
 * @property {string} id
 * @property {string} type                 见 AIJobType
 * @property {string} status               见 AIJobStatus
 * @property {number} priority             越大越先执行
 * @property {{ screenshotId?: string, imagePath?: string, capturedAt?: string, activityId?: string }} payload
 * @property {number} retryCount           已经重试的次数
 * @property {number} maxRetries           允许的最大重试次数
 * @property {string} createdAt
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {string|null} failedAt
 * @property {{ code: string, message: string }|null} error
 * @property {string|null} lastError
 */

// 本阶段只实现 SCREENSHOT_ANALYSIS，其余类型只预留，Worker 目前不认识它们。
const AIJobType = Object.freeze({
  SCREENSHOT_ANALYSIS: 'SCREENSHOT_ANALYSIS',
  TIMEBLOCK_SUMMARY: 'TIMEBLOCK_SUMMARY',
  DIARY_GENERATION: 'DIARY_GENERATION',
  EMBEDDING: 'EMBEDDING',
  INSIGHT_GENERATION: 'INSIGHT_GENERATION',
});

const AIJobStatus = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING',
  CANCELLED: 'CANCELLED',
});

const JOB_PRIORITY = Object.freeze({ HIGH: 10, NORMAL: 5, LOW: 1 });

// 状态机：只允许下列跳转，其余（例如 COMPLETED -> PROCESSING）一律拒绝。
const ALLOWED_TRANSITIONS = Object.freeze({
  PENDING: [AIJobStatus.PROCESSING, AIJobStatus.CANCELLED],
  PROCESSING: [
    AIJobStatus.COMPLETED,
    AIJobStatus.FAILED,
    AIJobStatus.RETRYING,
  ],
  RETRYING: [AIJobStatus.PENDING, AIJobStatus.CANCELLED],
  COMPLETED: [],
  FAILED: [AIJobStatus.PENDING],
  CANCELLED: [],
});

const ACTIVE_STATUSES = new Set([
  AIJobStatus.PENDING,
  AIJobStatus.PROCESSING,
  AIJobStatus.RETRYING,
]);

const TERMINAL_STATUSES = new Set([
  AIJobStatus.COMPLETED,
  AIJobStatus.FAILED,
  AIJobStatus.CANCELLED,
]);

const DEFAULT_MAX_RETRIES = 3;

function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function isActive(status) {
  return ACTIVE_STATUSES.has(status);
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

function createJobId(type, date) {
  return `${type}_${date.getTime().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function createJob({
  type,
  payload = {},
  priority = JOB_PRIORITY.NORMAL,
  maxRetries = DEFAULT_MAX_RETRIES,
  now = new Date(),
}) {
  return {
    id: createJobId(type, now),
    type,
    status: AIJobStatus.PENDING,
    priority,
    payload: { ...payload },
    retryCount: 0,
    maxRetries,
    createdAt: formatLocalIso(now),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    error: null,
    lastError: null,
  };
}

// 同一张截图的同类任务视为同一个任务，用于重复 Job 防护。
function screenshotKey(type, screenshotId) {
  return screenshotId ? `${type}:${screenshotId}` : null;
}

// Job 的幂等键：截图任务按 screenshotId，10 分钟区块（Phase 8）按 blockStart，
// 一天的日记（Phase 9）按 day。同类任务里键相同的只保留一条，
// enqueue 与 enqueueWithActivity / enqueueWithBlock / enqueueWithDiary 共用。
function jobPayloadKey(payload) {
  return payload?.screenshotId ?? payload?.blockStart ?? payload?.day ?? null;
}

module.exports = {
  AIJobType,
  AIJobStatus,
  JOB_PRIORITY,
  ALLOWED_TRANSITIONS,
  DEFAULT_MAX_RETRIES,
  canTransition,
  isActive,
  isTerminal,
  createJob,
  createJobId,
  screenshotKey,
  jobPayloadKey,
};
