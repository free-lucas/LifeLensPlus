'use strict';

const { chatWithOllama, checkHealth } = require('../analyzer');
const { AIError, ERROR_CODES } = require('./errors');
const { SUMMARY_SCHEMA, buildSummaryPrompt, normalizeSummaryResult, describeSummary } = require('./summaryOutput');

const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
// 汇总要生成约 1000 字中文：不显式给 token 上限，Ollama 的默认值会把描述截断。
// 关掉思考后实测一次汇总只花 200~300 token（13~23 秒），2048 留了充足余量。
const SUMMARY_NUM_PREDICT = 2048;

// 10 分钟区块的文本汇总 Provider。
// 素材（本区块的记录 + 上一个区块的汇总）通过 loadContext 注入：
// Provider 只认识「上下文 -> 提示词 -> 结构化结果」，不碰 SQL，也不认识数据库。
class OllamaSummaryProvider {
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
    // Worker 的超时兜底会读这里：汇总比单张截图分析慢得多，需要各自的时间预算。
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
   * 汇总一个 10 分钟区块，返回结构化结果（project / category / description / software / todos）。
   * Schema / 校验都在这一层完成，Worker 与 Queue 不需要知道任何字段。
   * @param {{ id: string, payload: { blockStart?: string, blockEnd?: string } }} job
   */
  async analyze(job) {
    const blockStart = job.payload?.blockStart;
    const blockEnd = job.payload?.blockEnd ?? null;
    if (!blockStart) {
      throw new AIError(ERROR_CODES.INVALID_RESULT, '任务里没有区块起始时间');
    }

    // 上下文在执行时才读：区块刚结束时，最后几张截图可能还在分析队列里。
    const context = this.loadContext({ blockStart, blockEnd, job }) ?? {};
    const prompt = buildSummaryPrompt({
      blockStart,
      blockEnd,
      records: context.records ?? [],
      previous: context.previous ?? null,
    });

    const { content, model, analysisMs } = await chatWithOllama({
      ollamaHost: this.ollamaHost,
      model: this.model,
      timeoutMs: this.timeoutMs,
      messages: [{ role: 'user', content: prompt }],
      format: SUMMARY_SCHEMA,
      // 上下文显式抬高：默认 4096 只留约 2050 个输入 token，
      // 一个满员的 10 分钟区块（30 条记录）提示词实测约 2388 token，会被静默截断。
      numCtx: this.numCtx,
      // temperature 略高一点：汇总是叙述性文字，不需要像分类那样保守。
      options: { temperature: 0.3, num_predict: SUMMARY_NUM_PREDICT },
      // 必须关掉思考：开着思考时模型会先把 num_predict 烧在思考上，
      // message.content 一直是空的，汇总只会得到「AI 返回了空结果」。
      think: false,
    });

    const summary = normalizeSummaryResult(content);
    return {
      jobId: job.id,
      blockStart,
      analysis: summary,
      // 交给日志的一行摘要：只有分类 / 项目 / 数量，不带描述正文。
      logLine: describeSummary(summary),
      model,
      analysisMs,
    };
  }
}

module.exports = { OllamaSummaryProvider, DEFAULT_HEALTH_TIMEOUT_MS, SUMMARY_NUM_PREDICT };
