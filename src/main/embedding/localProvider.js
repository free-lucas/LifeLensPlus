'use strict';

const { checkHealth } = require('../analyzer');
const { AIError, ERROR_CODES } = require('../ai/errors');

// 本地 Embedding Provider（Phase 10）：基于 Ollama 的 /api/embed。
// 与视觉 / 汇总 Provider 的分工一致：上层（EmbeddingService）只依赖 embedTexts() 和几个只读属性，
// 换模型（bge-m3 → nomic-embed-text → …）只需要换一个 Provider 实例，不动 LanceDB 结构。
const DEFAULT_MODEL = 'bge-m3';
const DEFAULT_VERSION = 'v1';
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5000;

// 维度未知时先探一次：bge-m3 是 1024、nomic-embed-text 是 768，
// 所以这里不硬编码，等第一次真实调用拿到响应再确定（配置里显式指定则直接用配置值）。
const DIMENSION_PROBE_TEXT = '维度探测';

function httpError(status, body, model) {
  if (status === 404) {
    return new AIError(ERROR_CODES.MODEL_NOT_FOUND, `Ollama 中找不到 embedding 模型 ${model}：${body}`);
  }
  if (status >= 500) {
    return new AIError(ERROR_CODES.OLLAMA_ERROR, `Ollama 返回 ${status}：${body}`);
  }
  return new AIError(ERROR_CODES.OLLAMA_BAD_REQUEST, `Ollama 返回 ${status}：${body}`);
}

class LocalEmbeddingProvider {
  constructor({
    ollamaHost,
    model = DEFAULT_MODEL,
    version = DEFAULT_VERSION,
    dimension = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  }) {
    this.ollamaHost = ollamaHost;
    this.model = model;
    this.version = version;
    this.timeoutMs = timeoutMs;
    this.maxBatchSize = Math.max(1, Math.floor(maxBatchSize) || DEFAULT_MAX_BATCH_SIZE);
    this.healthTimeoutMs = healthTimeoutMs;
    // 0 表示「还不知道」，第一次调用成功后写入实际维度。
    this._dimension = Number(dimension) > 0 ? Math.floor(Number(dimension)) : 0;
  }

  // 向量维度：建表 / 建索引必需。0 表示还没探测出来。
  get dimension() {
    return this._dimension;
  }

  // Ollama 是否在跑、embedding 模型是否已拉取（只访问 /api/tags，不触发推理）。
  health() {
    return checkHealth({
      ollamaHost: this.ollamaHost,
      model: this.model,
      timeoutMs: this.healthTimeoutMs,
    });
  }

  async embedText(text, options = {}) {
    const [vector] = await this.embedTexts([text], options);
    return vector;
  }

  // 单条 / 批量都走同一个入口；超过 maxBatchSize 时在 Provider 内部切块，调用方不用关心。
  // 失败一律抛 AIError：临时故障（超时 / 连不上）重试有意义，永久故障（模型缺失）留给上层降级。
  async embedTexts(texts, { timeoutMs = this.timeoutMs } = {}) {
    const inputs = (texts ?? []).map((text) => String(text ?? ''));
    if (!inputs.length) return [];

    const vectors = [];
    for (let start = 0; start < inputs.length; start += this.maxBatchSize) {
      const chunk = inputs.slice(start, start + this.maxBatchSize);
      vectors.push(...await this._embedChunk(chunk, timeoutMs));
    }
    return vectors;
  }

  // 维度探测：Provider 知道自己该是多少维时返回该值，否则用一次真实调用换出来。
  async ensureDimension(options = {}) {
    if (this._dimension > 0) return this._dimension;
    await this.embedText(DIMENSION_PROBE_TEXT, options);
    return this._dimension;
  }

  async _embedChunk(inputs, timeoutMs) {
    const url = `${String(this.ollamaHost).replace(/\/+$/, '')}/api/embed`;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model: this.model, input: inputs, truncate: true }),
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        throw new AIError(ERROR_CODES.AI_TIMEOUT, `Embedding 请求超时（${timeoutMs}ms）：${url}`, { cause: error });
      }
      throw new AIError(ERROR_CODES.OLLAMA_UNAVAILABLE, `无法连接 Ollama (${url})：${error.message}`, { cause: error });
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw httpError(response.status, body, this.model);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AIError(ERROR_CODES.INVALID_RESULT, `Embedding 响应不是合法 JSON：${error.message}`, { cause: error });
    }

    const embeddings = payload?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
      throw new AIError(
        ERROR_CODES.INVALID_RESULT,
        `Embedding 返回条数与请求不一致：请求 ${inputs.length} 条，返回 ${Array.isArray(embeddings) ? embeddings.length : 0} 条`,
      );
    }

    // 逐条校验：非空、全是有限数字、维度与已建立的表一致（不一致说明模型被换了，属于永久故障）。
    const dimension = this._dimension;
    for (const vector of embeddings) {
      if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => Number.isFinite(value))) {
        throw new AIError(ERROR_CODES.INVALID_RESULT, 'Embedding 返回了空向量或非法数值');
      }
      if (dimension > 0 && vector.length !== dimension) {
        throw new AIError(
          ERROR_CODES.INVALID_RESULT,
          `Embedding 维度变了：期望 ${dimension}，实际 ${vector.length}（模型是否被替换？）`,
        );
      }
    }

    if (!this._dimension) this._dimension = embeddings[0].length;
    return embeddings;
  }
}

module.exports = {
  LocalEmbeddingProvider,
  DEFAULT_MODEL,
  DEFAULT_VERSION,
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_TIMEOUT_MS,
};
