'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SIGNATURE_WIDTH,
  SIGNATURE_HEIGHT,
  SIMILAR_FRAME_TOLERANCE,
  graySignature,
  meanAbsoluteDifference,
  isSimilarSignature,
} = require('../src/main/frameSignature');

// 造一段灰度：base 加上每格偏移，用来精确控制两帧之间的平均绝对差。
function signature(base, offsets = []) {
  const grid = new Uint8ClampedArray(SIGNATURE_WIDTH * SIGNATURE_HEIGHT).fill(base);
  offsets.forEach(([index, delta]) => {
    grid[index] += delta;
  });
  return grid;
}

// 让整段灰度整体抬升 delta，得到「平均绝对差正好是 delta」的两帧。
function shifted(grid, delta) {
  const next = new Uint8ClampedArray(grid.length);
  for (let i = 0; i < grid.length; i += 1) next[i] = grid[i] + delta;
  return next;
}

test('相同指纹判定为相似', () => {
  const frame = signature(120);
  assert.equal(isSimilarSignature(frame, frame), true);
  assert.equal(meanAbsoluteDifference(frame, frame), 0);
});

test('小幅变化（实测同一画面的抖动 5.4）判为相似', () => {
  const frame = signature(120);
  // 长度 10 的样本：6 格差 5、4 格差 6 -> 平均 5.4。
  const wobble = new Uint8ClampedArray(10).fill(0);
  for (let i = 0; i < 6; i += 1) wobble[i] = 5;
  for (let i = 6; i < 10; i += 1) wobble[i] = 6;
  assert.equal(meanAbsoluteDifference(wobble, new Uint8ClampedArray(10)), 5.4);
  assert.equal(isSimilarSignature(new Uint8ClampedArray(10), wobble), true);
  assert.equal(isSimilarSignature(frame, shifted(frame, 5)), true);
});

test('真正换画面（实测 21 以上）判为不相似', () => {
  const frame = signature(120);
  assert.equal(meanAbsoluteDifference(frame, shifted(frame, 21)), 21);
  assert.equal(isSimilarSignature(frame, shifted(frame, 21)), false);
  assert.equal(isSimilarSignature(frame, shifted(frame, 190)), false);
});

test('平均绝对差正好等于容差算相似，超过一点就不算', () => {
  assert.equal(SIMILAR_FRAME_TOLERANCE, 8);
  const frame = signature(120);
  assert.equal(isSimilarSignature(frame, shifted(frame, 8)), true);
  assert.equal(isSimilarSignature(frame, shifted(frame, 9)), false);
});

test('变亮变暗混合时取绝对值，不会互相抵消', () => {
  const a = new Uint8ClampedArray([100, 100, 100, 100]);
  const b = new Uint8ClampedArray([108, 92, 108, 92]);
  assert.equal(meanAbsoluteDifference(a, b), 8);
  assert.equal(isSimilarSignature(a, b), true);
});

test('长度不同视为不同显示器，判为不相似', () => {
  assert.equal(isSimilarSignature(new Uint8ClampedArray(4), new Uint8ClampedArray(5)), false);
});

test('缺失或空指纹判为不相似', () => {
  assert.equal(isSimilarSignature(null, new Uint8ClampedArray(4)), false);
  assert.equal(isSimilarSignature(new Uint8ClampedArray(4), undefined), false);
  assert.equal(isSimilarSignature(null, null), false);
  assert.equal(isSimilarSignature(new Uint8ClampedArray(0), new Uint8ClampedArray(0)), false);
});

test('graySignature 按灰度公式换算 BGRA，并做 0~255 截断', () => {
  const bitmap = new Uint8ClampedArray([
    0, 0, 0, 255, // 纯黑 -> 0
    255, 255, 255, 255, // 纯白 -> 255
    0, 0, 255, 255, // 红 -> 0.299*255 = 76.245 -> 76
    255, 0, 0, 255, // 蓝 -> 0.114*255 = 29.07 -> 29
  ]);
  const gray = graySignature(bitmap, 4, 1);
  assert.deepEqual(Array.from(gray), [0, 255, 76, 29]);
});

test('指纹尺寸由常量决定', () => {
  assert.equal(SIGNATURE_WIDTH, 32);
  assert.equal(SIGNATURE_HEIGHT, 18);
  const bitmap = new Uint8ClampedArray(SIGNATURE_WIDTH * SIGNATURE_HEIGHT * 4).fill(200);
  assert.equal(graySignature(bitmap, SIGNATURE_WIDTH, SIGNATURE_HEIGHT).length, 576);
});
