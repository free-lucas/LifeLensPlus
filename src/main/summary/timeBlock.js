'use strict';

const { formatLocalIso } = require('../time');

// Phase 8：10 分钟区块的时间口径。
// 区块键是「区块起点的本地 ISO 字符串」，与 activities.captured_at 同一格式，
// 所以 SQL 里可以直接用字符串比较做范围查询（与 Phase 7 的时间约定一致）。
const BLOCK_MINUTES = 10;
const BLOCK_MS = BLOCK_MINUTES * 60 * 1000;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 对齐到所属区块的起点（本地时间，秒与毫秒归零）。
function blockStartOf(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    Math.floor(date.getMinutes() / BLOCK_MINUTES) * BLOCK_MINUTES,
    0,
    0,
  );
}

function blockEndOf(value) {
  const start = blockStartOf(value);
  return start ? new Date(start.getTime() + BLOCK_MS) : null;
}

// 区块业务键；解析不出时间时返回 null（调用方决定是跳过还是报错）。
function blockKeyOf(value) {
  const start = blockStartOf(value);
  return start ? formatLocalIso(start) : null;
}

// 区块业务对象：id 与 start 同值（block_start 是业务主键）。
// status 起步是 PENDING ——「有记录、还没汇总」的时间段在界面上的标记。
function createBlock(value, { activityCount = 0, status = 'PENDING' } = {}) {
  const start = blockStartOf(value);
  if (!start) throw new Error(`无法解析区块时间：${value}`);
  const key = formatLocalIso(start);
  return {
    id: key,
    start: key,
    end: formatLocalIso(new Date(start.getTime() + BLOCK_MS)),
    status,
    activityCount: Number(activityCount) || 0,
  };
}

module.exports = {
  BLOCK_MINUTES,
  BLOCK_MS,
  blockStartOf,
  blockEndOf,
  blockKeyOf,
  createBlock,
};
