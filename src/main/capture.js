'use strict';

const { desktopCapturer, screen, nativeImage } = require('electron');

const { AIError, ERROR_CODES } = require('./ai/errors');
const {
  SIGNATURE_WIDTH,
  SIGNATURE_HEIGHT,
  SIMILAR_FRAME_TOLERANCE,
  graySignature,
  isSimilarSignature,
} = require('./frameSignature');

// 截取主显示器，返回 NativeImage。
async function capturePrimaryDisplay() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  if (!sources.length) {
    throw new Error('没有找到可截取的屏幕，请检查系统的屏幕录制权限');
  }

  const source =
    sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
  const image = source.thumbnail;
  if (!image || image.isEmpty()) {
    throw new Error('截屏失败：图像为空，可能未授予屏幕录制权限');
  }
  return { image, display };
}

// 分辨率决定模型能不能读出界面上的文字（标签页、文件名、函数名）。读不出来时它不会
// 老实说“看不清”，而是照着提示词里的示例编一个像样的名字 —— 同一张 3440x1440 的图，
// 压到 1600 / 2400 输出的是不存在的 analyzer.js/chatWithOllama，按原尺寸送入才读对
// 真实的 codex.lanced.gitnexus用法.md。所以这里只做「超大屏兜底」，不为了省 token 主动缩小：
// 上限 3840，4K 及以下一律原样送入。代价是图像 token 明显上升，num_ctx 必须够大
// （默认 16384；若把 LIFELENS_NUM_CTX 调回 0，Ollama 默认的 4096 上下文装不下 4K 截图会报 400）。
// 详见《docs/39-截图分辨率与识别准确度.md》。
const ANALYSIS_MAX_SIDE = 3840;

function prepareForAnalysis(image, maxSide = ANALYSIS_MAX_SIDE) {
  const { width, height } = image.getSize();
  const longest = Math.max(width, height);
  if (!longest || longest <= maxSide) return image.toPNG();
  const scale = maxSide / longest;
  return image
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good',
    })
    .toPNG();
}

// 画面指纹：把截图缩成固定大小的灰度网格，交给 frameSignature 做平均绝对差比较。
// 用于判断这一帧和上一张已保存的截图是否几乎相同（挂机、静止桌面、同一页面停留等）。
// 为什么不用 dHash、阈值怎么定，见 docs/38-相似帧过滤.md。
function frameSignature(image) {
  const small = image.resize({ width: SIGNATURE_WIDTH, height: SIGNATURE_HEIGHT, quality: 'good' });
  const { width, height } = small.getSize();
  return graySignature(small.toBitmap(), width, height);
}

// 解耦后 AI Worker 拿到的是磁盘上的 PNG 文件，这里负责解码并按同一规则缩放。
function prepareBufferForAnalysis(buffer, maxSide = ANALYSIS_MAX_SIDE) {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    throw new AIError(ERROR_CODES.IMAGE_INVALID, '截图文件无法解码，可能已经损坏');
  }
  return prepareForAnalysis(image, maxSide);
}

module.exports = {
  capturePrimaryDisplay,
  prepareForAnalysis,
  prepareBufferForAnalysis,
  frameSignature,
  // 相似判定挂在 capture 上：Recorder 只用注入的 capture，测试里可以整体换成假实现。
  isSimilarFrame: isSimilarSignature,
  SIMILAR_FRAME_TOLERANCE,
};
