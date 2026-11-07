'use strict';

// Phase 13.1：Main -> 悬浮入口的事件通道。
//
// 为什么不能把 lifelens:event 原样转发给 launcher：那条通道上是完整的业务事件
// （record 带图片路径、analysis 带 screenshotId 与回填字段、error 带错误文本），
// 而收件人是一个 56x56 的圆标，它只需要「要不要闪一下」。所以这里做一次白名单转换：
//
//   status   -> { type: 'status', running }   持续态：只带走 running 这一个布尔值
//   record   -> { type: 'record' }            瞬时态：只有类型，没有图片路径
//   analysis -> { type: 'analysis' }          瞬时态：没有 screenshotId / patch
//   error    -> { type: 'error' }             瞬时态：没有错误文本
//   其它类型 -> null（不发给 launcher）
//
// 纯函数，零 Electron 依赖：转换规则可以在 node --test 里直接断言。

const LAUNCHER_EVENT_CHANNEL = 'lifelens:launcher-event';

// 白名单：只有这四个类型会到达悬浮入口。
const LAUNCHER_EVENT_TYPES = Object.freeze(['status', 'record', 'analysis', 'error']);

// 返回 null 表示「这个事件与悬浮入口无关」，调用方据此跳过发送。
function launcherEventOf(payload) {
  const type = payload?.type;
  if (!LAUNCHER_EVENT_TYPES.includes(type)) return null;
  // status 事件里只有 running 是特效需要的：status 对象本身（含 outputDir、model、
  // lastError 等）一律不外发。缺 status 字段时按「没在录制」处理，不猜。
  if (type === 'status') return { type, running: payload?.status?.running === true };
  return { type };
}

module.exports = {
  LAUNCHER_EVENT_CHANNEL,
  LAUNCHER_EVENT_TYPES,
  launcherEventOf,
};
