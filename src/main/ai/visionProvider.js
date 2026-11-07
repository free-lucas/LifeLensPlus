'use strict';

const fs = require('node:fs/promises');

const { analyzeScreenshot, checkHealth } = require('../analyzer');
const { AIError, ERROR_CODES } = require('./errors');
const { describeAnalysis } = require('./structuredOutput');

const DEFAULT_HEALTH_TIMEOUT_MS = 5000;

// 统一的 AI Provider：AIWorker 只依赖 analyze()/health()。
// Ollama + Qwen3-VL 只是当前实现，将来换模型不用动 Queue/Worker。
class OllamaVisionProvider {
  constructor({
    ollamaHost,
    model,
    timeoutMs,
    prompt,
    prepareImage = null,
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    numCtx = 0,
  }) {
    this.ollamaHost = ollamaHost;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.prompt = prompt;
    this.prepareImage = prepareImage;
    this.healthTimeoutMs = healthTimeoutMs;
    // 与汇总共用同一个模型实例：两边的 num_ctx 必须一致，否则 Ollama 会为每次切换重载模型。
    this.numCtx = numCtx;
  }

  // Ollama 是否在跑、模型是否已拉取。只访问 /api/tags，不会触发推理。
  health() {
    return checkHealth({
      ollamaHost: this.ollamaHost,
      model: this.model,
      timeoutMs: this.healthTimeoutMs,
    });
  }

  /**
   * 读取截图并交给视觉模型分析，返回结构化结果。
   * Schema / 校验都在这一层完成，Worker 与 Queue 不需要知道任何字段。
   * @param {{ payload: { imagePath?: string, screenshotId?: string } }} job
   */
  async analyze(job) {
    const imagePath = job.payload?.imagePath;
    if (!imagePath) {
      throw new AIError(ERROR_CODES.IMAGE_NOT_FOUND, '任务里没有截图路径');
    }

    let buffer;
    try {
      buffer = await fs.readFile(imagePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new AIError(ERROR_CODES.IMAGE_NOT_FOUND, `截图文件不存在：${imagePath}`, { cause: error });
      }
      throw new AIError(ERROR_CODES.IMAGE_INVALID, `读取截图失败：${error.message}`, { cause: error });
    }

    // prepareImage 负责把原图缩到模型能接受的大小；失败说明图片本身有问题。
    const pngBuffer = this.prepareImage ? this.prepareImage(buffer) : buffer;

    const result = await analyzeScreenshot(pngBuffer, {
      ollamaHost: this.ollamaHost,
      model: this.model,
      analyzeTimeoutMs: this.timeoutMs,
      prompt: this.prompt,
      numCtx: this.numCtx,
    });

    return {
      jobId: job.id,
      screenshotId: job.payload?.screenshotId ?? null,
      analysis: result.analysis,
      // 交给日志的一行摘要：Worker 只当字符串透传，不解析字段。
      logLine: describeAnalysis(result.analysis),
      model: result.model,
      analysisMs: result.analysisMs,
    };
  }
}

module.exports = { OllamaVisionProvider, DEFAULT_HEALTH_TIMEOUT_MS };
