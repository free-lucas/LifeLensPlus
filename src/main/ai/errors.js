'use strict';

// AI 相关错误统一携带 code：Worker 依据 code 判断能否重试。
// 临时性故障（超时、Ollama 未启动、模型忙）才重试；
// 永久性错误（模型不存在、图片缺失/损坏、参数错误）直接 FAILED，重试没有意义。
const ERROR_CODES = Object.freeze({
  AI_TIMEOUT: 'AI_TIMEOUT',
  OLLAMA_UNAVAILABLE: 'OLLAMA_UNAVAILABLE',
  OLLAMA_ERROR: 'OLLAMA_ERROR',
  OLLAMA_BAD_REQUEST: 'OLLAMA_BAD_REQUEST',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  IMAGE_NOT_FOUND: 'IMAGE_NOT_FOUND',
  IMAGE_INVALID: 'IMAGE_INVALID',
  // 结构化输出解析/校验失败属于「这次生成没生成好」，值得重试。
  INVALID_RESULT: 'INVALID_RESULT',
  // 当前 Ollama 版本或模型不支持 JSON Schema 结构化输出：重试多少次都没用。
  STRUCTURED_OUTPUT_UNSUPPORTED: 'STRUCTURED_OUTPUT_UNSUPPORTED',
  JOB_CANCELLED: 'JOB_CANCELLED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  UNKNOWN: 'UNKNOWN',
});

const PERMANENT_CODES = new Set([
  ERROR_CODES.MODEL_NOT_FOUND,
  ERROR_CODES.IMAGE_NOT_FOUND,
  ERROR_CODES.IMAGE_INVALID,
  ERROR_CODES.OLLAMA_BAD_REQUEST,
  ERROR_CODES.STRUCTURED_OUTPUT_UNSUPPORTED,
  ERROR_CODES.JOB_CANCELLED,
]);

class AIError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code || ERROR_CODES.UNKNOWN;
    this.retryable = options.retryable ?? !PERMANENT_CODES.has(this.code);
    if (options.cause) this.cause = options.cause;
  }
}

// 把任意异常收敛成 AIError：未知异常按“临时故障”处理，最多重试 maxRetries 次后仍会 FAILED。
function toAIError(error, fallbackCode = ERROR_CODES.UNKNOWN) {
  if (error instanceof AIError) return error;
  return new AIError(fallbackCode, error?.message || String(error), {
    retryable: true,
    cause: error,
  });
}

function isRetryable(error) {
  if (!error) return false;
  if (typeof error.retryable === 'boolean') return error.retryable;
  return !PERMANENT_CODES.has(error.code);
}

module.exports = { AIError, ERROR_CODES, PERMANENT_CODES, isRetryable, toAIError };
