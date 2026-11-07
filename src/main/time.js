'use strict';

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

// 本地时间的 ISO 字符串，例如 2026-09-11T21:06:00+08:00
function formatLocalIso(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day}T${clock}${offset}`;
}

// 2026-09
function monthKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

// 2026-09-11
function dayKey(date) {
  return `${monthKey(date)}-${pad(date.getDate())}`;
}

// 2026-09-11_21
function hourKey(date) {
  return `${dayKey(date)}_${pad(date.getHours())}`;
}

// 2026-09-11_21-06-00-123
function imageStamp(date) {
  const clock = [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('-');
  return `${dayKey(date)}_${clock}-${pad(date.getMilliseconds(), 3)}`;
}

module.exports = { pad, formatLocalIso, monthKey, dayKey, hourKey, imageStamp };
