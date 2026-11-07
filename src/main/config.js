'use strict';

const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  intervalMs: 20000,
  model: 'qwen3-vl:8b',
  ollamaHost: 'http://127.0.0.1:11434',
  analyzeTimeoutMs: 120000,
  autoStart: true,
  // AI 队列：默认并发 1（Qwen3-VL 8B 并发跑会抢显存），失败退避 2s/5s/15s，最多重试 3 次。
  aiConcurrency: 1,
  aiMaxRetries: 3,
  aiRetryDelaysMs: [2000, 5000, 15000],
  aiHealthPollMs: 15000,
  aiMaxTerminalJobs: 500,
  // 10 分钟区块汇总（Phase 8）：默认复用视觉模型，生成约 1000 字，比单张分析慢得多。
  summaryTimeoutMs: 300000,
  summaryScanLimit: 144,
  // 一天的日记（Phase 9）：二阶汇总，输入是一整天的区块，比单个区块汇总更慢。
  diaryTimeoutMs: 300000,
  diaryScanLimit: 30,
  // Ollama 上下文长度（输入与输出共享同一个窗口）。4096 的默认值减去汇总预留的
  // num_predict 2048 后只剩约 2048 个输入 token，而满员的 10 分钟区块（30 条记录）
  // 提示词实测约 2351 token，超出部分会被静默截断。16384 实测占 7.8 GB 显存，
  // 是 16 GB 显卡留有余量的上限；设为 0 表示不传，交回 Ollama 自己决定。
  numCtx: 16384,
  // 本地 embedding（Phase 10）：默认 bge-m3（1024 维，中文友好）。
  // 维度留 0 表示「还不知道」，由 Provider 在第一次调用后探测，不在配置里写死结论。
  embeddingModel: 'bge-m3',
  embeddingDimension: 0,
  embeddingTimeoutMs: 60000,
  embeddingBatchSize: 32,
  embeddingScanIntervalMs: 60000,
  embeddingMaxBatchesPerScan: 10,
};

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// 优先级：环境变量 > 默认值。必须先 app.whenReady() 之后再调用。
function loadConfig() {
  const env = process.env;
  const outputDir =
    env.LIFELENS_DIR || path.join(app.getPath('pictures'), 'LifeLensPlus');

  return {
    ...DEFAULTS,
    outputDir: path.resolve(outputDir),
    model: env.LIFELENS_MODEL || DEFAULTS.model,
    ollamaHost: env.LIFELENS_OLLAMA_HOST || DEFAULTS.ollamaHost,
    analyzeTimeoutMs: num(env.LIFELENS_ANALYZE_TIMEOUT_MS, DEFAULTS.analyzeTimeoutMs),
    intervalMs: Number(env.LIFELENS_INTERVAL_MS) || DEFAULTS.intervalMs,
    autoStart: env.LIFELENS_AUTOSTART ? env.LIFELENS_AUTOSTART !== '0' : DEFAULTS.autoStart,
    aiConcurrency: num(env.LIFELENS_AI_CONCURRENCY, DEFAULTS.aiConcurrency),
    aiMaxRetries: num(env.LIFELENS_AI_MAX_RETRIES, DEFAULTS.aiMaxRetries),
    aiHealthPollMs: num(env.LIFELENS_AI_HEALTH_POLL_MS, DEFAULTS.aiHealthPollMs),
    aiMaxTerminalJobs: num(env.LIFELENS_AI_MAX_TERMINAL_JOBS, DEFAULTS.aiMaxTerminalJobs),
    // 汇总默认沿用同一个模型：本地只拉了一个模型时不需要额外配置。
    summaryModel: env.LIFELENS_SUMMARY_MODEL || env.LIFELENS_MODEL || DEFAULTS.model,
    summaryTimeoutMs: num(env.LIFELENS_SUMMARY_TIMEOUT_MS, DEFAULTS.summaryTimeoutMs),
    summaryScanLimit: num(env.LIFELENS_SUMMARY_SCAN_LIMIT, DEFAULTS.summaryScanLimit),
    // 日记默认沿用汇总模型：本地只拉了一个模型时不需要额外配置。
    diaryModel: env.LIFELENS_DIARY_MODEL
      || env.LIFELENS_SUMMARY_MODEL
      || env.LIFELENS_MODEL
      || DEFAULTS.model,
    diaryTimeoutMs: num(env.LIFELENS_DIARY_TIMEOUT_MS, DEFAULTS.diaryTimeoutMs),
    diaryScanLimit: num(env.LIFELENS_DIARY_SCAN_LIMIT, DEFAULTS.diaryScanLimit),
    numCtx: num(env.LIFELENS_NUM_CTX, DEFAULTS.numCtx),
    // embedding 与视觉 / 汇总模型相互独立：不配就默认 bge-m3，缺模型只会让记录留在 PENDING。
    embeddingModel: env.LIFELENS_EMBEDDING_MODEL || DEFAULTS.embeddingModel,
    embeddingDimension: num(env.LIFELENS_EMBEDDING_DIMENSION, DEFAULTS.embeddingDimension),
    embeddingTimeoutMs: num(env.LIFELENS_EMBEDDING_TIMEOUT_MS, DEFAULTS.embeddingTimeoutMs),
    embeddingBatchSize: num(env.LIFELENS_EMBEDDING_BATCH_SIZE, DEFAULTS.embeddingBatchSize),
    embeddingScanIntervalMs: num(env.LIFELENS_EMBEDDING_SCAN_INTERVAL_MS, DEFAULTS.embeddingScanIntervalMs),
    embeddingMaxBatchesPerScan: num(env.LIFELENS_EMBEDDING_MAX_BATCHES, DEFAULTS.embeddingMaxBatchesPerScan),
  };
}

module.exports = { loadConfig, DEFAULTS };
