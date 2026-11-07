'use strict';

const { addDays, dayKeyOf, dayStartOf, parseDayKey, WEEKDAY_NAMES } = require('../day');

// Phase 9：看板的「周期」口径。
//
// 一个周期 = 一段闭开区间 [from, to)，外加一个「锚点日」——锚点只用来记住用户看到哪一天，
// 具体边界由周期决定（周一是一周的第一天，月与年都是自然月 / 自然年）。
// 上一期 / 下一期也在这里算好，界面拿到 prevAnchor / nextAnchor 直接回传即可，
// 所以渲染层不需要任何日期数学。

const PERIODS = Object.freeze(['day', 'week', 'month', 'year']);
// 默认看「本周」：日视图在上午打开往往几乎是空的。
const DEFAULT_PERIOD = 'week';
// 一周从周一开始（中文习惯）。
const WEEK_START = 1;

function normalizePeriod(value) {
  return PERIODS.includes(value) ? value : DEFAULT_PERIOD;
}

function startOfWeek(date) {
  const weekday = (date.getDay() + 7 - WEEK_START) % 7;
  return addDays(dayStartOf(date), -weekday);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function startOfYear(date) {
  return new Date(date.getFullYear(), 0, 1, 0, 0, 0, 0);
}

function monthDay(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

// 周标题：同月 / 同年 / 跨年三种写法。
function weekLabel(from) {
  const last = addDays(from, 6);
  if (from.getFullYear() === last.getFullYear() && from.getMonth() === last.getMonth()) {
    return `${from.getFullYear()}年${monthDay(from)} – ${last.getDate()}日`;
  }
  if (from.getFullYear() === last.getFullYear()) {
    return `${from.getFullYear()}年${monthDay(from)} – ${monthDay(last)}`;
  }
  return `${from.getFullYear()}年${monthDay(from)} – ${last.getFullYear()}年${monthDay(last)}`;
}

// 周期起点按单位平移（月 / 年不能简单加减毫秒）。
function shiftStart(from, period, step) {
  if (period === 'day') return addDays(from, step);
  if (period === 'week') return addDays(from, step * 7);
  if (period === 'month') return new Date(from.getFullYear(), from.getMonth() + step, 1, 0, 0, 0, 0);
  return new Date(from.getFullYear() + step, 0, 1, 0, 0, 0, 0);
}

/**
 * 周期 -> 边界、标题与前后锚点。
 * @param {'day'|'week'|'month'|'year'} period
 * @param {string|null} anchor YYYY-MM-DD；为空或非法时用 now 当天
 */
function resolvePeriod(period, anchor = null, { now = new Date() } = {}) {
  const kind = normalizePeriod(period);
  const today = dayStartOf(now);
  const base = parseDayKey(dayKeyOf(anchor)) ?? today;

  let from;
  let to;
  let label;
  if (kind === 'day') {
    from = base;
    to = addDays(base, 1);
    label = `${base.getFullYear()}年${base.getMonth() + 1}月${base.getDate()}日 ${WEEKDAY_NAMES[base.getDay()]}`;
  } else if (kind === 'week') {
    from = startOfWeek(base);
    to = addDays(from, 7);
    label = weekLabel(from);
  } else if (kind === 'month') {
    from = startOfMonth(base);
    to = new Date(base.getFullYear(), base.getMonth() + 1, 1, 0, 0, 0, 0);
    label = `${base.getFullYear()}年${base.getMonth() + 1}月`;
  } else {
    from = startOfYear(base);
    to = new Date(base.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
    label = `${base.getFullYear()}年`;
  }

  return {
    period: kind,
    anchor: dayKeyOf(base),
    from,
    to,
    label,
    prevAnchor: dayKeyOf(shiftStart(from, kind, -1)),
    nextAnchor: dayKeyOf(shiftStart(from, kind, 1)),
    // 整段都在未来 / 今天就在这一段里：界面用它决定「下一期」能不能点。
    // future 只表示「这一期还没开始」，已经过完的周期不算 future（否则看板会锁死「下一期」）。
    future: from.getTime() > now.getTime(),
    hasToday: from.getTime() <= now.getTime() && now.getTime() < to.getTime(),
  };
}

// 趋势图的分桶：日 = 24 小时，周 = 7 天，月 = 当月天数，年 = 12 个月。
// 每个桶都带 startMs / endMs 与 future 标记（未来的桶在图上画成浅色占位）。
function buildBuckets(period, from, to, { now = new Date() } = {}) {
  const kind = normalizePeriod(period);
  const nowMs = now.getTime();
  const buckets = [];

  const push = (key, label, start, end) => {
    buckets.push({
      key,
      label,
      startMs: start.getTime(),
      endMs: end.getTime(),
      future: start.getTime() > nowMs,
    });
  };

  if (kind === 'day') {
    for (let hour = 0; hour < 24; hour += 1) {
      push(
        String(hour).padStart(2, '0'),
        String(hour).padStart(2, '0'),
        new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, 0, 0, 0),
        new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour + 1, 0, 0, 0),
      );
    }
    return buckets;
  }

  if (kind === 'week') {
    for (let index = 0; index < 7; index += 1) {
      const start = addDays(from, index);
      push(dayKeyOf(start), WEEKDAY_NAMES[start.getDay()].slice(1), start, addDays(start, 1));
    }
    return buckets;
  }

  if (kind === 'month') {
    for (let date = from; date.getTime() < to.getTime(); date = addDays(date, 1)) {
      push(dayKeyOf(date), String(date.getDate()), date, addDays(date, 1));
    }
    return buckets;
  }

  for (let month = 0; month < 12; month += 1) {
    const start = new Date(from.getFullYear(), month, 1, 0, 0, 0, 0);
    const end = new Date(from.getFullYear(), month + 1, 1, 0, 0, 0, 0);
    push(
      `${from.getFullYear()}-${String(month + 1).padStart(2, '0')}`,
      `${month + 1}月`,
      start,
      end,
    );
  }
  return buckets;
}

module.exports = {
  PERIODS,
  DEFAULT_PERIOD,
  WEEK_START,
  normalizePeriod,
  startOfWeek,
  shiftStart,
  resolvePeriod,
  buildBuckets,
};
