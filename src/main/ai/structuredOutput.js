'use strict';

const { AIError, ERROR_CODES } = require('./errors');

// 第一版固定分类枚举：模型只能从中选一个，避免出现无穷无尽的自造分类，
// 后续统计（Timeline / 报表）也才有稳定的口径。
const AI_CATEGORIES = Object.freeze([
  'coding',
  'browsing',
  'communication',
  'meeting',
  'document',
  'media',
  'design',
  'shopping',
  'finance',
  'learning',
  'entertainment',
  'system',
  'other',
]);

const MAX_KEYWORDS = 8;
const MAX_ACTIVITY_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 500;

// 交给 Ollama format 参数的 JSON Schema：结构由 Ollama 约束，而不是靠 Prompt 求 JSON。
const STRUCTURED_AI_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    activity: {
      type: 'string',
      description: 'A short phrase describing what the user is doing right now.',
    },
    summary: {
      type: 'string',
      description: 'One or two sentences describing the current activity.',
    },
    category: {
      type: 'string',
      enum: [...AI_CATEGORIES],
      description: 'The single best matching category.',
    },
    // Ollama 0.34 支持 type 数组；project 为 null 表示截图里没有明确证据。
    project: {
      type: ['string', 'null'],
      description: 'Project name only when the screenshot gives clear evidence, otherwise null.',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_KEYWORDS,
      description: 'Up to 8 short and useful terms.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'How certain the classification is, from 0 to 1.',
    },
  },
  required: ['activity', 'summary', 'category', 'project', 'keywords', 'confidence'],
  additionalProperties: false,
});

// 提示词只负责「怎么判断用户正在做什么」，JSON 结构由 Schema 负责，不在 Prompt 里描述格式。
// 输出质量几乎全压在这里：只要求概括、不要求带上画面里具体的对象时，模型会把 activity
// 收敛成「编写代码」「浏览网页」这类通用短语，任何两张沾边的截图都长得一样。
// 所以用正反例强制「动作 + 具体对象」，并要求 summary 说清 软件 / 做了什么 / 涉及什么。
// 这不会拖慢分析：实测生成约 95 tok/s，只占单张墙钟的 15%~20%，而最贵的图像编码
// 只跟图片大小有关、与提示词长度无关（见《37-截图分析性能》）。
const STRUCTURED_PROMPT = [
  '你是一个生活记录助手。下面是一张电脑屏幕截图，请判断用户此刻正在做什么。',
  '',
  '要求：',
  '1. 先看清画面再下结论。只描述截图中确实能看到的内容；看不清或不确定的地方不要编造，也不要猜测用户的私人意图或动机。',
  '2. activity 用简短短语说明当前动作，但必须带上画面里具体的对象，不能只写动作大类。',
  '   不合格：编写代码、浏览网页、看视频、处理文档',
  '   合格：在 VS Code 中改 analyzer.js 的 chatWithOllama、在 Chrome 里查 Tailwind grid 文档',
  '3. summary 用 2 到 3 句话，按「用什么软件 / 在做什么具体的事 / 涉及什么内容」说清楚，直接描述，不要写「根据图片可以看出」。',
  `4. category 必须从以下分类中选一个最贴近的：${AI_CATEGORIES.join(' / ')}。`,
  '5. project 只有在截图中有明确证据（标题栏、文件名、网页标题里出现项目名）时才填写，否则为 null。注意区分软件名与项目名：VS Code 是软件，不是项目。',
  '6. keywords 填 3 到 8 个具体关键词，优先专有名词（软件名、文件名、技术名词、站点名），不要写完整句子，也不要写「电脑」「工作」这类没有区分度的词。',
  '7. confidence 表示你对本次判断的把握，范围 0 到 1。画面被遮挡或主体看不清时给低分。',
].join('\n');

function invalidResult(message) {
  return new AIError(ERROR_CODES.INVALID_RESULT, message);
}

// 只做最小限度的防御：模型偶尔会把 JSON 裹在 Markdown 代码块里。
function stripCodeFence(text) {
  const matched = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return matched ? matched[1] : text;
}

// 把 Ollama 返回的 message.content 解析成对象；解析不出来就是一次失败的分析。
function parseStructuredResult(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') throw invalidResult('AI 结果既不是对象也不是字符串');

  const text = stripCodeFence(raw.trim()).trim();
  if (!text) throw invalidResult('AI 返回了空结果');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidResult(`AI 返回的不是合法 JSON：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidResult('AI 返回的 JSON 不是对象');
  }
  return parsed;
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string') throw invalidResult(`${field} 必须是字符串`);
  const text = value.trim();
  if (!text) throw invalidResult(`${field} 不能为空`);
  if (text.length > maxLength) throw invalidResult(`${field} 超过 ${maxLength} 字`);
  return text;
}

// 模型常用空字符串表示「不知道」，统一按 null 处理，避免把空项目名写进记录。
function normalizeProject(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalidResult('project 只能是字符串或 null');
  return value.trim() || null;
}

// trim -> 去空 -> 去重，超出 8 个按顺序截断。
function normalizeKeywords(value) {
  if (!Array.isArray(value)) throw invalidResult('keywords 必须是数组');

  const seen = new Set();
  const keywords = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalidResult('keywords 里的每一项都必须是字符串');
    const word = item.trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    keywords.push(word);
    if (keywords.length === MAX_KEYWORDS) break;
  }
  return keywords;
}

function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidResult('confidence 必须是数字');
  }
  if (value < 0 || value > 1) {
    throw invalidResult(`confidence 必须在 0 到 1 之间（收到 ${value}）`);
  }
  return value;
}

// Provider 返回后的第二层校验：Schema 约束的是语法，不代表业务数据一定合法。
function normalizeStructuredResult(raw) {
  const value = parseStructuredResult(raw);
  const result = {
    activity: requireText(value.activity, 'activity', MAX_ACTIVITY_LENGTH),
    summary: requireText(value.summary, 'summary', MAX_SUMMARY_LENGTH),
    category: value.category,
    project: normalizeProject(value.project),
    keywords: normalizeKeywords(value.keywords),
    confidence: normalizeConfidence(value.confidence),
  };
  if (!AI_CATEGORIES.includes(result.category)) {
    throw invalidResult(`category 不在允许的枚举里：${String(result.category)}`);
  }
  return result;
}

// 日志用的一行摘要：只有分类、项目、置信度，不带截图内容，也不打印完整 JSON。
function describeAnalysis(analysis) {
  if (!analysis) return null;
  return `category=${analysis.category} project=${analysis.project ?? '-'} confidence=${analysis.confidence}`;
}

module.exports = {
  AI_CATEGORIES,
  STRUCTURED_AI_SCHEMA,
  STRUCTURED_PROMPT,
  MAX_KEYWORDS,
  parseStructuredResult,
  normalizeStructuredResult,
  describeAnalysis,
};
