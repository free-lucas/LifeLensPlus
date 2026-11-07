'use strict';

// 画面指纹：把截图缩成固定大小的灰度网格，用「平均绝对差」判断两帧是否几乎相同，
// 也就是「这一张和上一张是不是同一个画面」。
//
// 为什么不用 dHash：dHash 的每一位来自「左右相邻两格谁更亮」，只要这两格亮度接近，
// 这一位就会被噪声翻转。实测 3440x1440 的真实桌面上，同一个画面只滚动一屏文字就能
// 翻掉 6~16 位，而「换应用 / 换页面」这种真正的变化也只有 20~38 位 —— 两个区间重叠，
// 阈值取多少都会漏掉大量几乎相同的截图（实测旧规则平均只跳过 16%）。
// 灰度网格的平均绝对差把这两类分得很开：同一画面轻微变化 <= 5.4，真正换内容 >= 21，
// 中间是空的。数据与推导见 docs/38-相似帧过滤.md。
const SIGNATURE_WIDTH = 32;
const SIGNATURE_HEIGHT = 18;

// 平均绝对差 <= 8（0~255 灰度）视为「和上一张一样」。
// 阈值落在实测空隙 5.4 ~ 21 之间，离两侧都有 1.5 倍以上余量；
// 实测取 8 / 10 / 12 得到的判定结果完全一致，所以这个值不敏感。
const SIMILAR_FRAME_TOLERANCE = 8;

// BGRA 位图 -> 灰度网格。通道顺序只要前后一致即可比较，权重用标准亮度公式。
function graySignature(bitmap, width, height) {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    const offset = i * 4;
    gray[i] = bitmap[offset] * 0.114 + bitmap[offset + 1] * 0.587 + bitmap[offset + 2] * 0.299;
  }
  return gray;
}

function meanAbsoluteDifference(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// 长度不同说明两帧不是同一块屏幕（换了显示器或分辨率），一律按「不一样」处理。
function isSimilarSignature(a, b, tolerance = SIMILAR_FRAME_TOLERANCE) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return false;
  return meanAbsoluteDifference(a, b) <= tolerance;
}

module.exports = {
  SIGNATURE_WIDTH,
  SIGNATURE_HEIGHT,
  SIMILAR_FRAME_TOLERANCE,
  graySignature,
  meanAbsoluteDifference,
  isSimilarSignature,
};