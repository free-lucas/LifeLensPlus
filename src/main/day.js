'use strict';

const { formatLocalIso, pad } = require('./time');

// Phase 9：本地「日」的口径。日记与看板都以自然日为边界。
//
// 日期键是 YYYY-MM-DD（本地日期），与 block_start / captured_at 的前 10 个字符完全一致
// （那些字符串里的日期就是当时当地的日期），所以「一条记录属于哪一天」在 SQL 里
// 就是 substr(时间, 1, 10)，不需要额外列，也不怕时区偏移被改写。
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function toDate(value) {
  // null / undefined / 空串都会变成 1970-01-01 或 Invalid Date，这里统一当成「没有日期」。
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 本地日期的 00:00:00.000。
function dayStartOf(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

// 下一天的 00:00。用日期加法而不是 +24 小时：夏令时切换的日子不是 24 小时。
function dayEndOf(value) {
  const start = dayStartOf(value);
  if (!start) return null;
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0);
}

// 按天平移，保留时分秒（日期加法同样避开夏令时陷阱）。
function addDays(value, days) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + (Number(days) || 0),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

// YYYY-MM-DD。传入字符串时直接取前 10 个字符：本地 ISO（带偏移）的前缀就是
// 当时当地的日期，再按当前时区解析一次反而可能差一天。
function dayKeyOf(value) {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const date = toDate(value);
  if (!date) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// YYYY-MM-DD -> 当天 00:00。严格校验，不放过 '2026-9-5' 与 '2026-02-31'
// （后者会被 Date 宽松解析成 3 月 3 日，回读一次就能发现）。
function parseDayKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return dayKeyOf(date) === `${match[1]}-${match[2]}-${match[3]}` ? date : null;
}

// 日期键按天平移：2026-09-15 + 1 -> 2026-09-16。
function shiftDayKey(value, days) {
  const date = parseDayKey(dayKeyOf(value));
  const next = date ? addDays(date, days) : null;
  return next ? dayKeyOf(next) : null;
}

// 一天的边界，返回与 block_start / captured_at 同格式的本地 ISO（闭开区间 [from, to)）。
function dayBounds(value) {
  const start = parseDayKey(dayKeyOf(value));
  if (!start) return null;
  return { from: formatLocalIso(start), to: formatLocalIso(dayEndOf(start)) };
}

// 2026年9月15日 周二
function dayLabel(value) {
  const date = parseDayKey(dayKeyOf(value));
  if (!date) return String(value ?? '');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_NAMES[date.getDay()]}`;
}

module.exports = {
  DAY_MS,
  WEEKDAY_NAMES,
  dayStartOf,
  dayEndOf,
  addDays,
  dayKeyOf,
  parseDayKey,
  shiftDayKey,
  dayBounds,
  dayLabel,
};
