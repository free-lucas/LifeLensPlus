'use strict';

const { AIError, ERROR_CODES } = require('./ai/errors');
const {
  STRUCTURED_AI_SCHEMA,
  STRUCTURED_PROMPT,
  normalizeStructuredResult,
} = require('./ai/structuredOutput');

// Ollama 里 qwen3-vl 与 qwen3-vl:latest 是同一条，比较时补齐标签。
function normalizeModelName(name) {
  const value = String(name || '');
  if (!value) return '';
  return value.includes(':') ? value : `${value}:latest`;
}

// Ollama 明确表示不支持 JSON Schema 结构化输出时（400/422 且提到 format/schema），
// 问题出在当前模型或 Ollama 版本上：按永久失败处理，重试没有意义。
const UNSUPPORTED_FORMAT_HINT = /(format|schema|grammar|structured)/i;

function httpError(status, body, model) {
  if (status === 404) {
    return new AIError(ERROR_CODES.MODEL_NOT_FOUND, `Ollama 中找不到模型 ${model}：${body}`);
  }
  if ((status === 400 || status === 422) && UNSUPPORTED_FORMAT_HINT.test(body)) {
    return new AIError(
      ERROR_CODES.STRUCTURED_OUTPUT_UNSUPPORTED,
      `当前 Ollama 或模型不支持 JSON Schema 结构化输出：${body}`,
    );
  }
  if (status >= 500) {
    return new AIError(ERROR_CODES.OLLAMA_ERROR, `Ollama 返回 ${status}：${body}`);
  }
  // 其余 4xx 是请求本身有问题：都不值得重试。
  return new AIError(ERROR_CODES.OLLAMA_BAD_REQUEST, `Ollama 返回 ${status}：${body}`);
}

// 统一的 Ollama 对话调用：走 /api/chat，JSON Schema 通过 format 参数交给 Ollama 约束解码。
// 视觉分析（截图）与文本汇总（Phase 8 的区块总结）共用这一层，差别只在 messages / Schema / think。
// think 默认不传（沿用模型自己的默认），只有传了值才写进请求体。
// 截图分析与汇总都必须显式传 think:false：qwen3-vl 默认开思考，思考与答案共用同一个生成预算，
// 汇总会因此一个字都写不出来（详见 15-时间区块汇总），截图则会被拖到几十秒（详见 analyzeScreenshot）。
async function chatWithOllama({
  ollamaHost,
  model,
  messages,
  format = null,
  options = {},
  timeoutMs,
  think = null,
  numCtx = 0,
}) {
  const url = `${ollamaHost.replace(/\/+$/, '')}/api/chat`;
  const startedAt = Date.now();
  // num_ctx 只在显式给正值时才覆盖 Ollama 的默认上下文（默认 4096，只留约 2050 个输入 token）。
  // 提示词一旦超过这个预算会被静默截断，所以调用方按需要调高。
  const finalOptions = numCtx > 0 ? { ...options, num_ctx: numCtx } : options;
  const body = { model, messages, format, stream: false, options: finalOptions };
  if (think !== null) body.think = think;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      throw new AIError(ERROR_CODES.AI_TIMEOUT, `AI 请求超时（${timeoutMs}ms）：${url}`, { cause: error });
    }
    throw new AIError(ERROR_CODES.OLLAMA_UNAVAILABLE, `无法连接 Ollama (${url})：${error.message}`, { cause: error });
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw httpError(response.status, body, model);
  }

  const payload = await response.json();
  // Ollama 0.34 + qwen3-vl:8b 的实测行为（format 约束下）：
  //   think 打开  -> 思考写进 message.thinking，答案写进 message.content；
  //   think:false -> 整个约束输出落进 message.thinking，message.content 是空串。
  // 所以「content 非空就用 content，否则退到 thinking」，两种落点都能拿到结果。
  const message = payload?.message ?? {};
  return {
    content: String(message.content ?? '') || String(message.thinking ?? ''),
    model,
    analysisMs: Date.now() - startedAt,
  };
}

// 视觉分析：截图 + JSON Schema 交给 /api/chat，返回归一化后的结构化结果。
// 文本汇总（Phase 8 的区块总结）走同一个 chatWithOllama，只是 message 与 Schema 不同。
async function analyzeScreenshot(pngBuffer, options) {
  const {
    ollamaHost,
    model,
    analyzeTimeoutMs,
    prompt = STRUCTURED_PROMPT,
    numCtx = 0,
  } = options;

  const { content, analysisMs } = await chatWithOllama({
    ollamaHost,
    model,
    timeoutMs: analyzeTimeoutMs,
    numCtx,
    messages: [{ role: 'user', content: prompt, images: [pngBuffer.toString('base64')] }],
    format: STRUCTURED_AI_SCHEMA,
    // 实测（无竞争基线）：同一张截图，think 默认开启时生成 1250 个思考 token（13.0s），
    // 关掉只生成 72 个（0.74s）；不同画面差异极大，最坏单张实测 12132 个 token / 145.7s。
    // 截图任务不需要推理过程，这里必须显式关闭。
    think: false,
    options: { temperature: 0.2 },
  });

  // Ollama 已经用 Schema 约束过语法，这里再取文本做第二层业务校验与归一化。
  return { analysis: normalizeStructuredResult(content), model, analysisMs };
}

// 检查 Ollama 是否在跑、所需的模型是否已拉取（只访问 /api/tags，不触发推理）。
async function checkHealth({ ollamaHost, model, timeoutMs = 5000 }) {
  const url = `${ollamaHost.replace(/\/+$/, '')}/api/tags`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { online: false, modelAvailable: false, message: error.message };
  }
  if (!response.ok) {
    return { online: false, modelAvailable: false, message: `Ollama 返回 ${response.status}` };
  }

  let models = [];
  try {
    models = (await response.json()).models || [];
  } catch (error) {
    return { online: true, modelAvailable: false, message: error.message };
  }

  const names = models.map((item) => normalizeModelName(item.name || item.model));
  return { online: true, modelAvailable: names.includes(normalizeModelName(model)) };
}

module.exports = { analyzeScreenshot, chatWithOllama, checkHealth, normalizeModelName };
