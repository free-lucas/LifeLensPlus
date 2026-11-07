'use strict';

const { parseStructuredResult } = require('../ai/structuredOutput');
const { chatWithOllama } = require('../analyzer');

// Phase 12：Ask My Life v1（问答）。
//
// 一条链路：问题 -> MemorySearchService.search（检索 + 回查 SQLite 都在里面完成）
//          -> 用 items 拼紧凑 Context -> chatWithOllama（QA_SCHEMA 结构化输出）
//          -> 回答 + 相关记忆。
//
// 边界（与 Phase 10 / 11 的分层约定一致）：
// - 不依赖 SQLite repositories：search() 返回的 items 就是完整记录，这里不再查一次库；
// - 不碰 LanceDB / embedding Provider：那是 MemorySearchService 的事；
// - 这一版只回答一个问题：不做多轮、不做 Query Rewrite、不做流式、不走 AIJobQueueService
//   （后台队列只入队不等待结果，问答是同步 IPC 调用）。

const SEARCH_LIMIT = 20;
// 单条记忆进 Context 的截断长度与整个 Context 的总长上限：
// 20 条记忆全塞进提示词很容易超过 num_ctx，超出的部分会被 Ollama 静默截断。
const CONTENT_MAX_CHARS = 300;
const CONTEXT_MAX_CHARS = 8000;

const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

const QA_SYSTEM_PROMPT = [
  '你是 Life Lens 的本地个人记忆助手。',
  '',
  '你只能根据提供的历史记忆回答用户问题。',
  '',
  '要求：',
  '- 不要编造历史记录中不存在的信息。',
  '- 可以对已有记录进行总结和归纳。',
  '- 如果证据不足，请明确说明「现有记录不足以判断」。',
  '- 不要假装知道没有提供的内容。',
  '- 回答直接、清晰。',
  '- 如果结论来自多个记忆，请综合这些记忆。',
  '- 如果问题涉及时间范围，要明确区分不同时间的记录。',
].join('\n');

// 交给 Ollama format 参数的 JSON Schema：结构由 Ollama 约束，而不是靠 Prompt 求 JSON。
const QA_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: '基于给定历史记忆的简明回答，通常不超过 300 字。',
    },
    confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
});

// 空问题与「没有找到记忆」都在本地收口：不打扰模型，也不让它硬编一个答案。
const NO_QUESTION_ANSWER = '先输入一个问题，再开始提问。';
const NO_MEMORY_ANSWER = '没有找到足够相关的历史记录，暂时无法准确回答这个问题。';

// 两类失败分别给固定前缀：Renderer 只展示 message，不需要认识错误码。
const SEARCH_ERROR_PREFIX = '暂时无法搜索历史记忆，请检查本地 AI 服务';
const ANSWER_ERROR_PREFIX = '已经找到相关记忆，但当前无法生成回答';

class AskMyLifeError extends Error {
  constructor(message, { code = 'ASK_FAILED', cause } = {}) {
    super(message);
    this.name = 'AskMyLifeError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 与搜索页同一口径：时间按本地时区显示到分钟。
function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return String(value ?? '');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatClock(value) {
  const date = toDate(value);
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '';
}

// 日记只有日期；20 秒记录显示到分钟；10 分钟汇总再带上结束时刻。
function formatMemoryTime(item) {
  if (!item) return '';
  if (item.sourceType === 'diary') return String(item.day ?? item.time ?? '');

  const start = formatDateTime(item.time);
  if (!start) return String(item.time ?? '');
  const end = item.endTime ? formatClock(item.endTime) : '';
  return end ? `${start}–${end}` : start;
}

function sourceLabelOf(item) {
  return String(item?.sourceLabel ?? '').trim() || '记忆';
}

// 一条记忆 -> 一段紧凑文本。项目 / 分类都在才占一行，没有就不留空行。
function formatMemoryBlock(item, content) {
  const lines = [`[${sourceLabelOf(item)}] ${formatMemoryTime(item)}`];
  const meta = [];
  if (item?.project) meta.push(`项目：${item.project}`);
  if (item?.category) meta.push(`分类：${item.category}`);
  if (meta.length) lines.push(meta.join(' ｜ '));
  lines.push(content);
  return lines.join('\n');
}

// items（已按相关度排序）-> 提示词里的记忆清单。
// content 为空的条目不进 Context；单条过长截断；总长超上限时按相关度顺序保住前面的。
function buildContext(items, { contentMax = CONTENT_MAX_CHARS, contextMax = CONTEXT_MAX_CHARS } = {}) {
  const blocks = [];
  let total = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const content = String(item?.content ?? '').trim();
    if (!content) continue;

    const text = content.length > contentMax ? content.slice(0, contentMax) : content;
    const block = formatMemoryBlock(item, text);
    // 段落之间空一行，长度按 block + 分隔符算。
    if (total + block.length > contextMax) break;
    blocks.push(block);
    total += block.length + 2;
  }

  return blocks.join('\n\n');
}

// Ollama 已经用 Schema 约束过语法，这里做第二层最小业务校验：
// answer 必须是非空字符串，confidence 必须在枚举内；不合法就是「这次生成没生成好」。
function normalizeAnswer(raw) {
  const value = parseStructuredResult(raw);
  const answer = typeof value.answer === 'string' ? value.answer.trim() : '';
  if (!answer) throw new Error('模型没有返回回答内容');

  const confidence = String(value.confidence ?? '').trim();
  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    throw new Error(`confidence 不在允许的枚举里：${String(value.confidence)}`);
  }
  return { answer, confidence };
}

class AskMyLifeService {
  constructor({
    search,
    chat = chatWithOllama,
    ollamaHost,
    model,
    timeoutMs,
    // 默认不传：Ollama 的 4096 连 20 条记忆的 Context 都装不下，装配时必须显式给值。
    numCtx = 0,
    now = () => Date.now(),
  }) {
    this.search = search ?? null;
    this.chat = chat;
    this.ollamaHost = ollamaHost;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.numCtx = numCtx;
    this.now = now;
  }

  // 问题 -> 检索 -> Context -> 回答。返回 { question, answer, confidence, memories, model, elapsedMs }。
  // 空问题与「没有可用记忆」不报错（不是失败）；检索失败与生成失败抛 AskMyLifeError，由 IPC 转给界面。
  async ask(question) {
    const startedAt = this.now();
    const text = String(question ?? '').trim();
    if (!text) {
      return this._result({ question: '', answer: NO_QUESTION_ANSWER, memories: [], elapsedMs: 0 });
    }

    const result = await this._search(text);
    const memories = Array.isArray(result?.items) ? result.items : [];
    const context = buildContext(memories);
    // 一条能进 Context 的记忆都没有（没检索到，或检索到的记录都没有正文）：
    // 省一次推理，也避免模型在没有依据时硬编。
    if (!context) {
      return this._result({ question: text, answer: NO_MEMORY_ANSWER, memories, elapsedMs: this._elapsed(startedAt) });
    }

    let parsed;
    try {
      const { content } = await this.chat({
        ollamaHost: this.ollamaHost,
        // 复用现有配置：问答与汇总同为长生成任务。
        model: this.model,
        timeoutMs: this.timeoutMs,
        messages: [
          { role: 'system', content: QA_SYSTEM_PROMPT },
          { role: 'user', content: `问题：${text}\n\n以下是检索到的历史记忆：\n${context}` },
        ],
        format: QA_SCHEMA,
        // 必须显式传：默认 4096 会把超预算的记忆静默截断，表现为模型「看不到」部分记忆。
        numCtx: this.numCtx,
        options: { temperature: 0.3, num_predict: 1024 },
        think: false,
      });
      parsed = normalizeAnswer(content);
    } catch (error) {
      throw new AskMyLifeError(`${ANSWER_ERROR_PREFIX}：${error?.message ?? error}`, {
        code: 'ANSWER_UNAVAILABLE',
        cause: error,
      });
    }

    return this._result({
      question: text,
      answer: parsed.answer,
      confidence: parsed.confidence,
      memories,
      elapsedMs: this._elapsed(startedAt),
    });
  }

  // 检索层面的失败（Embedding / 向量索引不可用）统一转成可读前缀。
  async _search(text) {
    if (typeof this.search?.search !== 'function') {
      throw new AskMyLifeError(`${SEARCH_ERROR_PREFIX}：记忆检索没有装配`, { code: 'SEARCH_UNAVAILABLE' });
    }
    try {
      return await this.search.search(text, { limit: SEARCH_LIMIT });
    } catch (error) {
      throw new AskMyLifeError(`${SEARCH_ERROR_PREFIX}：${error?.message ?? error}`, {
        code: 'SEARCH_UNAVAILABLE',
        cause: error,
      });
    }
  }

  _elapsed(startedAt) {
    return Math.max(0, this.now() - startedAt);
  }

  // IPC 返回结构：memories 原样使用 search() 的 items（含跳转所需的 time / day / endTime / timelineId / sourceType）。
  _result({ question, answer, confidence = 'low', memories, elapsedMs }) {
    return { question, answer, confidence, memories, model: this.model ?? null, elapsedMs };
  }
}

module.exports = {
  AskMyLifeService,
  AskMyLifeError,
  QA_SYSTEM_PROMPT,
  QA_SCHEMA,
  CONFIDENCE_LEVELS,
  SEARCH_LIMIT,
  CONTENT_MAX_CHARS,
  CONTEXT_MAX_CHARS,
  NO_QUESTION_ANSWER,
  NO_MEMORY_ANSWER,
  SEARCH_ERROR_PREFIX,
  ANSWER_ERROR_PREFIX,
  buildContext,
  formatMemoryTime,
  normalizeAnswer,
};
