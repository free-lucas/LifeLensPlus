'use strict';

// Phase 13.1：Main -> 悬浮入口的事件转换层单测。
// 这一层是「最小暴露」的守门人：它必须证明发到 56x56 小窗口上的载荷里
// 只有类型与 running，没有图片路径、screenshotId、错误文本。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LAUNCHER_EVENT_CHANNEL,
  LAUNCHER_EVENT_TYPES,
  launcherEventOf,
} = require('../src/main/launcher/launcherEvents');

test('悬浮事件 1：四个类型的转换结果与通道名', () => {
  assert.equal(LAUNCHER_EVENT_CHANNEL, 'lifelens:launcher-event');
  assert.deepEqual([...LAUNCHER_EVENT_TYPES], ['status', 'record', 'analysis', 'error']);

  // status 只带走 running。
  assert.deepEqual(launcherEventOf({ type: 'status', status: { running: true } }), { type: 'status', running: true });
  assert.deepEqual(launcherEventOf({ type: 'status', status: { running: false } }), { type: 'status', running: false });
  // 三个瞬时事件只有类型。
  assert.deepEqual(launcherEventOf({ type: 'record' }), { type: 'record' });
  assert.deepEqual(launcherEventOf({ type: 'analysis' }), { type: 'analysis' });
  assert.deepEqual(launcherEventOf({ type: 'error' }), { type: 'error' });
});

test('悬浮事件 2：record / analysis / error 的详情一律不外发', () => {
  const record = launcherEventOf({
    type: 'record',
    record: { id: 7, path: 'C:/Users/me/Pictures/LifeLensPlus/2026-09/a.png', project: 'ide' },
  });
  assert.deepEqual(record, { type: 'record' });
  assert.deepEqual(Object.keys(record), ['type']);

  const analysis = launcherEventOf({
    type: 'analysis',
    screenshotId: 7,
    patch: { summary: '在写代码', tags: ['ide'] },
  });
  assert.deepEqual(analysis, { type: 'analysis' });
  assert.equal('screenshotId' in analysis, false);
  assert.equal('patch' in analysis, false);

  const error = launcherEventOf({ type: 'error', message: 'embedding 失败：ECONNREFUSED' });
  assert.deepEqual(error, { type: 'error' });
  assert.equal('message' in error, false);
});

test('悬浮事件 3：status 里的其余字段（含路径与错误）不外发', () => {
  const status = launcherEventOf({
    type: 'status',
    status: {
      running: true,
      queue: 3,
      lastError: 'Ollama 连接失败',
      model: 'qwen2.5vl',
      outputDir: 'C:/Users/me/Pictures/LifeLensPlus',
      intervalMs: 20000,
    },
  });
  assert.deepEqual(status, { type: 'status', running: true });

  // 没有 status 字段（或字段被清空）时按「没在录制」处理，不猜成录制中。
  assert.deepEqual(launcherEventOf({ type: 'status' }), { type: 'status', running: false });
  assert.deepEqual(launcherEventOf({ type: 'status', status: null }), { type: 'status', running: false });
  // running 必须是真布尔 true，'true' / 1 都不算。
  assert.deepEqual(launcherEventOf({ type: 'status', status: { running: 'true' } }), { type: 'status', running: false });
  assert.deepEqual(launcherEventOf({ type: 'status', status: { running: 1 } }), { type: 'status', running: false });
});

test('悬浮事件 4：与悬浮入口无关的事件返回 null（不发送）', () => {
  // ai 快照只给主界面；日记 / 区块汇总的状态与特效无关，一律不发。
  assert.equal(launcherEventOf({ type: 'ai', ai: { pending: 2 } }), null);
  assert.equal(launcherEventOf({ type: 'summary' }), null);
  assert.equal(launcherEventOf({ type: 'diary' }), null);
  assert.equal(launcherEventOf({ type: 'status2' }), null);
  assert.equal(launcherEventOf({}), null);
  assert.equal(launcherEventOf(null), null);
  assert.equal(launcherEventOf(undefined), null);
  // 坏输入不能抛错：广播链路在录制循环里，抛出去会打断截图。
  assert.equal(launcherEventOf('record'), null);
  assert.equal(launcherEventOf({ type: 42 }), null);
});