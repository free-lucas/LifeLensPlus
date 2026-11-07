'use strict';

const { AIError, ERROR_CODES } = require('./errors');
const { parseStructuredResult } = require('./structuredOutput');

// Phase 8：10 分钟区块汇总的结构化输出。
//
// 需求固定的四个分类（中文枚举）；与单张截图的英文 category 是两套口径：
// 截图分类回答「这一帧在做什么」，区块分类回答「这 10 分钟属于哪类活动」。
const SUMMARY_CATEGORIES = Object.freeze(['娱乐', '工作', '学习', '社交']);

const MAX_PROJECT_LENGTH = 60;
const MIN_DESCRIPTION_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_SOFTWARE = 20;
const MAX_SOFTWARE_LENGTH = 60;
const MAX_TODOS = 10;
const MAX_TODO_LENGTH = 200;
// 上一个区块的描述只作为上下文，在提示词里截断，不必占满上下文窗口。
const PREVIOUS_DESCRIPTION_LENGTH = 300;

// 交给 Ollama format 参数的 JSON Schema：结构由 Ollama 约束，而不是靠 Prompt 求 JSON。
const SUMMARY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    project: {
      type: 'string',
      description: 'Project name as an action phrase, e.g. 玩《荒野大镖客》 or 写《2026 年中报告》.',
    },
    category: {
      type: 'string',
      enum: [...SUMMARY_CATEGORIES],
      description: 'The single best matching activity category.',
    },
    description: {
      type: 'string',
      description: 'About 1000 Chinese characters describing what the user did in this time block.',
    },
    software: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_SOFTWARE,
      description: 'Software names used in this time block, without duplicates.',
    },
    todos: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_TODOS,
      description: 'Important todos that may have been missed. Empty array when there is none.',
    },
  },
  required: ['project', 'category', 'description', 'software', 'todos'],
  additionalProperties: false,
});

function invalidResult(message) {
  return new AIError(ERROR_CODES.INVALID_RESULT, message);
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string') throw invalidResult(`${field} 必须是字符串`);
  const text = value.trim();
  if (!text) throw invalidResult(`${field} 不能为空`);
  if (text.length > maxLength) throw invalidResult(`${field} 超过 ${maxLength} 字`);
  return text;
}

// 1000 字左右是需求的硬要求：太短说明模型没按要求写（可重试），
// 太长只截断不判失败——重试也未必更短，而内容本身是有价值的。
function requireDescription(value) {
  if (typeof value !== 'string') throw invalidResult('description 必须是字符串');
  const text = value.trim();
  if (text.length < MIN_DESCRIPTION_LENGTH) {
    throw invalidResult(`description 只有 ${text.length} 字，少于要求的 ${MIN_DESCRIPTION_LENGTH} 字`);
  }
  return text.length > MAX_DESCRIPTION_LENGTH ? text.slice(0, MAX_DESCRIPTION_LENGTH) : text;
}

// trim -> 去空 -> 去重，超出 maxItems 按顺序截断；单条过长直接截断（不判失败）。
function normalizeStringList(value, { field, maxItems, maxLength }) {
  if (!Array.isArray(value)) throw invalidResult(`${field} 必须是数组`);

  const seen = new Set();
  const items = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalidResult(`${field} 里的每一项都必须是字符串`);
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text.length > maxLength ? text.slice(0, maxLength) : text);
    if (items.length === maxItems) break;
  }
  return items;
}

// Provider 返回后的第二层校验：Schema 约束的是语法，不代表业务数据一定合法。
function normalizeSummaryResult(raw) {
  const value = parseStructuredResult(raw);
  const category = value.category;
  if (!SUMMARY_CATEGORIES.includes(category)) {
    throw invalidResult(`category 不在允许的枚举里：${String(category)}`);
  }

  return {
    project: requireText(value.project, 'project', MAX_PROJECT_LENGTH),
    category,
    description: requireDescription(value.description),
    software: normalizeStringList(value.software, {
      field: 'software',
      maxItems: MAX_SOFTWARE,
      maxLength: MAX_SOFTWARE_LENGTH,
    }),
    todos: normalizeStringList(value.todos, {
      field: 'todos',
      maxItems: MAX_TODOS,
      maxLength: MAX_TODO_LENGTH,
    }),
  };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// 本地 ISO（2026-09-15T09:50:00+08:00）或 Date -> 09:50 / 09:50:00；认不出来就原样返回。
function clockOf(value, length = 5) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const clock = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    return clock.slice(0, length);
  }
  const text = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? text.slice(11, 11 + length) : text;
}

function truncate(text, maxLength) {
  const value = String(text ?? '');
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

// 一条记录压缩成一行上下文。没分析出结果的记录也要如实带上，不能凭空跳过。
function describeRecord(record) {
  const clock = clockOf(record?.time, 8);
  const activity = record?.activity ?? record?.summary ?? null;
  if (!activity && !record?.project) return `${clock} （还没有分析结果）`;

  const parts = [activity ?? '（无活动描述）'];
  if (record?.summary && record.summary !== activity) parts.push(record.summary);
  if (record?.category) parts.push(`分类 ${record.category}`);
  if (record?.project) parts.push(`项目 ${record.project}`);
  if (Array.isArray(record?.keywords) && record.keywords.length) {
    parts.push(`关键词 ${record.keywords.join('、')}`);
  }
  return `${clock} ${parts.join(' | ')}`;
}

// 提示词只负责「怎么汇总」，JSON 结构由 Schema 负责，不在 Prompt 里描述格式。
function buildSummaryPrompt({ blockStart, blockEnd, records = [], previous = null }) {
  const lines = [
    '你是生活记录助手。下面是一个 10 分钟时间段里的屏幕截图分析记录，请把它们汇总成这个时间段的活动说明。',
    `时间段：${clockOf(blockStart)}–${clockOf(blockEnd)}`,
    '',
  ];

  if (previous) {
    lines.push(
      '【上一个 10 分钟的汇总】',
      `项目：${previous.project || '无'}`,
      `分类：${previous.category || '无'}`,
      `软件：${(previous.software ?? []).join('、') || '无'}`,
      `描述：${truncate(previous.description, PREVIOUS_DESCRIPTION_LENGTH) || '无'}`,
      '',
    );
  }

  lines.push(`【本时段的记录】共 ${records.length} 条，按时间从早到晚：`);
  if (records.length) {
    for (const record of records) lines.push(describeRecord(record));
  } else {
    lines.push('（这一时段没有记录）');
  }

  lines.push(
    '',
    '要求：',
    '1. project 写用户正在做的项目名称，用「动作 +《名称》」的短句，例如 玩《荒野大镖客》、写《2026 年中报告》；'
      + '如果这段时间是上一个 10 分钟的延续，必须沿用完全相同的项目名称；看不出具体项目时用「浏览网页」这类通用说法。',
    `2. category 必须从 娱乐 / 工作 / 学习 / 社交 中选一个最贴近的。`,
    '3. description 用中文说明这 10 分钟具体做了什么，1000 字左右：做了什么、用什么软件做的、进展到哪一步、'
      + '有没有卡住或反复的地方。只写记录里能看到的内容，不要编造。',
    '4. software 列出这段时间用到的软件名称（去重）；没有就填空数组。',
    '5. todos 只在记录里确实出现待办线索时填写（例如写了一半的任务、提到的截止时间、还没回复的消息）；'
      + '没有就填空数组。',
  );

  return lines.join('\n');
}

// 日志用的一行摘要：只带分类 / 项目 / 数量，不带描述正文。
function describeSummary(summary) {
  if (!summary) return null;
  return `category=${summary.category} project=${truncate(summary.project, 40)}`
    + ` software=${(summary.software ?? []).length} todos=${(summary.todos ?? []).length}`;
}

module.exports = {
  SUMMARY_CATEGORIES,
  SUMMARY_SCHEMA,
  MAX_PROJECT_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_SOFTWARE,
  MAX_TODOS,
  normalizeSummaryResult,
  buildSummaryPrompt,
  describeSummary,
  describeRecord,
  clockOf,
};
