'use strict';

const { chatWithOllama, checkHealth } = require('../analyzer');
const { AIError, ERROR_CODES } = require('./errors');
const { DIARY_SCHEMA, buildDiaryPrompt, normalizeDiaryResult, describeDiary } = require('./diaryOutput');

const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
// 日记要写六段中文：不显式给 token 上限时 Ollama 的默认值会把内容截断。
// 关掉思考后实测一篇日记约 600~900 token，2048 留了充足余量。
const DIARY_NUM_PREDICT = 2048;

// 一天的文本日记 Provider。
// 素材（这一天的区块汇总 + 上一天已生成的日记）通过 loadContext 注入：
// Provider 只认识「上下文 -> 提示词 -> 结构化结果」，不碰 SQL，也不认识数据库。
class OllamaDiaryProvider {
  constructor({
    ollamaHost,
    model,
    timeoutMs,
    loadContext,
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    numCtx = 0,
  }) {
    this.ollamaHost = ollamaHost;
    this.model = model;
    // Worker 的超时兜底会读这里：写一篇日记比单个区块汇总更慢，需要各自的时间预算。
    this.timeoutMs = timeoutMs;
    this.loadContext = loadContext;
    this.healthTimeoutMs = healthTimeoutMs;
    this.numCtx = numCtx;
  }

  health() {
    return checkHealth({
      ollamaHost: this.ollamaHost,
      model: this.model,
      timeoutMs: this.healthTimeoutMs,
    });
  }

  /**
   * 汇总一天的日记，返回结构化结果（summary / mainEvents / highlights / todos / suggestions / tips）。
   * Schema / 校验 / 上下文压缩都在这一层完成，Worker 与 Queue 不需要知道任何字段。
   * @param {{ id: string, payload: { day?: string, from?: string, to?: string } }} job
   */
  async analyze(job) {
    const day = job.payload?.day;
    if (!day) throw new AIError(ERROR_CODES.INVALID_RESULT, '任务里没有日期');

    // 上下文在执行时才读：这一天的区块可能还在汇总队列里。
    const context = this.loadContext({
      day,
      from: job.payload?.from ?? null,
      to: job.payload?.to ?? null,
      job,
    }) ?? {};
    const blocks = context.blocks ?? [];
    const prompt = buildDiaryPrompt({ day, blocks, previous: context.previous ?? null });

    const { content, model, analysisMs } = await chatWithOllama({
      ollamaHost: this.ollamaHost,
      model: this.model,
      timeoutMs: this.timeoutMs,
      messages: [{ role: 'user', content: prompt }],
      format: DIARY_SCHEMA,
      // 上下文与区块汇总共用同一个 num_ctx（见 config.numCtx）。
      numCtx: this.numCtx,
      // temperature 稍高一点：日记是叙述性文字，不需要像分类那样保守。
      options: { temperature: 0.4, num_predict: DIARY_NUM_PREDICT },
      // 必须关掉思考：开着思考时模型会把 num_predict 烧在思考上，正文一个字都写不出来。
      think: false,
    });

    const diary = normalizeDiaryResult(content);
    return {
      jobId: job.id,
      day,
      analysis: diary,
      // 这一天参与汇总的区块数（写进 diaries.block_count）。
      blockCount: Array.isArray(blocks) ? blocks.length : 0,
      // 交给日志的一行摘要：只有条目数量，不带正文。
      logLine: describeDiary(diary),
      model,
      analysisMs,
    };
  }
}

module.exports = { OllamaDiaryProvider, DEFAULT_HEALTH_TIMEOUT_MS, DIARY_NUM_PREDICT };