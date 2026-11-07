'use strict';

const { AIError, ERROR_CODES } = require('./errors');
const { parseStructuredResult } = require('./structuredOutput');
const { dayLabel } = require('../day');
const { BLOCK_MINUTES } = require('../summary/timeBlock');

// Phase 9：一天的日记（二阶汇总）的结构化输出。
//
// 输入是这一天所有 10 分钟区块的汇总，输出是六段内容：
// 简短总结 / 主要事项 / 高光 / 待办 / 优化建议 / 温馨提示。
// 与区块汇总同样是「Schema 约束结构 + 第二层业务校验」，Prompt 里不描述 JSON 格式。

const MIN_SUMMARY_LENGTH = 40;
const MAX_SUMMARY_LENGTH = 400;
// 需求是「三件做的最主要的事情」：最多三件，实在没有三件就写实际件数。
const MAX_MAIN_EVENTS = 3;
const MAX_EVENT_LENGTH = 80;
const MAX_HIGHLIGHTS = 5;
const MAX_HIGHLIGHT_LENGTH = 120;
const MAX_TODOS = 10;
const MAX_TODO_LENGTH = 200;
const MAX_SUGGESTIONS = 5;
const MAX_SUGGESTION_LENGTH = 200;
const MAX_TIPS = 3;
const MAX_TIP_LENGTH = 150;

// 提示词预算：一天最多 144 个区块，逐条塞进提示词会远远超出 Ollama 的上下文窗口，
// 所以先把相邻的同项目区块合并成「时段」，再按字符预算逐段降级
// （先去掉描述，再去掉整段，并在末尾如实说明漏了多少段）。
const MAX_CONTEXT_CHARS = 12000;
const SEGMENT_DESCRIPTION_LENGTH = 160;
const SEGMENT_DESCRIPTIONS = 2;
const PREVIOUS_SUMMARY_LENGTH = 200;

// 交给 Ollama format 参数的 JSON Schema：结构由 Ollama 约束，而不是靠 Prompt 求 JSON。
const DIARY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'A 2-4 sentence Chinese summary of the whole day, about 150 characters.',
    },
    mainEvents: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_MAIN_EVENTS,
      description: 'The most important things done that day, at most three, one sentence each.',
    },
    highlights: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_HIGHLIGHTS,
      description: 'Memorable highlights of the day. Empty array when there is none.',
    },
    todos: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_TODOS,
      description: 'Todos spotted in the records that may have been missed. Empty array when none.',
    },
    suggestions: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_SUGGESTIONS,
      description: 'Concrete and actionable suggestions to improve this kind of day.',
    },
    tips: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_TIPS,
      description: 'Gentle reminders about health, rest or mood.',
    },
  },
  required: ['summary', 'mainEvents', 'highlights', 'todos', 'suggestions', 'tips'],
  additionalProperties: false,
});

function invalidResult(message) {
  return new AIError(ERROR_CODES.INVALID_RESULT, message);
}

function truncate(text, maxLength) {
  const value = String(text ?? '');
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

// trim -> 去空 -> 去重，超出 maxItems 按顺序截断；单条过长直接截断（不判失败）。
function normalizeStringList(value, { field, maxItems, maxLength, minItems = 0 }) {
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
  if (items.length < minItems) {
    throw invalidResult(`${field} 至少要有一条，实际 ${items.length} 条`);
  }
  return items;
}

function requireSummary(value) {
  if (typeof value !== 'string') throw invalidResult('summary 必须是字符串');
  const text = value.trim();
  if (text.length < MIN_SUMMARY_LENGTH) {
    throw invalidResult(`summary 只有 ${text.length} 字，少于要求的 ${MIN_SUMMARY_LENGTH} 字`);
  }
  return text.length > MAX_SUMMARY_LENGTH ? text.slice(0, MAX_SUMMARY_LENGTH) : text;
}

// Provider 返回后的第二层校验：Schema 约束的是语法，不代表业务数据一定合法。
function normalizeDiaryResult(raw) {
  const value = parseStructuredResult(raw);
  return {
    summary: requireSummary(value.summary),
    mainEvents: normalizeStringList(value.mainEvents, {
      field: 'mainEvents',
      maxItems: MAX_MAIN_EVENTS,
      maxLength: MAX_EVENT_LENGTH,
      minItems: 1,
    }),
    highlights: normalizeStringList(value.highlights, {
      field: 'highlights',
      maxItems: MAX_HIGHLIGHTS,
      maxLength: MAX_HIGHLIGHT_LENGTH,
    }),
    todos: normalizeStringList(value.todos, {
      field: 'todos',
      maxItems: MAX_TODOS,
      maxLength: MAX_TODO_LENGTH,
    }),
    suggestions: normalizeStringList(value.suggestions, {
      field: 'suggestions',
      maxItems: MAX_SUGGESTIONS,
      maxLength: MAX_SUGGESTION_LENGTH,
    }),
    tips: normalizeStringList(value.tips, {
      field: 'tips',
      maxItems: MAX_TIPS,
      maxLength: MAX_TIP_LENGTH,
    }),
  };
}

// ---- 上下文压缩 ----

function pad(value) {
  return String(value).padStart(2, '0');
}

function toMs(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const parsed = Date.parse(String(value ?? ''));
  return Number.isNaN(parsed) ? null : parsed;
}

function clockOf(ms) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 相邻区块合并成「时段」：时间连续、分类与项目都相同时算同一段。
// 一天 144 个区块通常能压到十几段，日记提示词才有可能装进 16k 上下文。
function buildDiarySegments(blocks = []) {
  const items = [];
  for (const block of blocks ?? []) {
    // 没汇总出分类的区块（PENDING / FAILED）不进日记。
    if (!block || !block.category) continue;
    const startMs = toMs(block.start);
    const endMs = toMs(block.end) ?? (startMs === null ? null : startMs + BLOCK_MINUTES * 60000);
    if (startMs === null || endMs === null) continue;
    items.push({
      startMs,
      endMs,
      category: block.category,
      project: block.project ?? null,
      software: Array.isArray(block.software) ? block.software.filter(Boolean) : [],
      todos: Array.isArray(block.todos) ? block.todos.filter(Boolean) : [],
      description: typeof block.description === 'string' ? block.description.trim() : '',
    });
  }
  items.sort((a, b) => a.startMs - b.startMs);

  const segments = [];
  for (const item of items) {
    const last = segments.at(-1);
    const mergeable = last
      && last.endMs === item.startMs
      && last.category === item.category
      && last.project === item.project;
    if (mergeable) {
      last.endMs = item.endMs;
      last.blocks += 1;
      for (const name of item.software) last.software.add(name);
      for (const todo of item.todos) last.todos.add(todo);
      if (item.description) last.descriptions.push(item.description);
      continue;
    }
    segments.push({
      startMs: item.startMs,
      endMs: item.endMs,
      blocks: 1,
      category: item.category,
      project: item.project,
      software: new Set(item.software),
      todos: new Set(item.todos),
      descriptions: item.description ? [item.description] : [],
    });
  }

  return segments.map((segment) => ({
    ...segment,
    minutes: segment.blocks * BLOCK_MINUTES,
    software: [...segment.software],
    todos: [...segment.todos],
  }));
}

function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

// 分类时长分布：工作 3 小时 20 分（20 段）、学习 50 分钟（5 段）
function describeDistribution(segments) {
  const byCategory = new Map();
  for (const segment of segments) {
    const entry = byCategory.get(segment.category) ?? { minutes: 0, blocks: 0 };
    entry.minutes += segment.minutes;
    entry.blocks += segment.blocks;
    byCategory.set(segment.category, entry);
  }
  const parts = [...byCategory.entries()]
    .sort((a, b) => b[1].minutes - a[1].minutes)
    .map(([category, entry]) => `${category} ${formatMinutes(entry.minutes)}（${entry.blocks} 段）`);
  return parts.length ? parts.join('、') : '这一天没有可用的汇总数据';
}

// 每段最多带两条最长的描述，避免把整天的描述原样塞进提示词。
function sampleDescriptions(segment) {
  return [...new Set(segment.descriptions)]
    .sort((a, b) => b.length - a.length)
    .slice(0, SEGMENT_DESCRIPTIONS)
    .map((text) => truncate(text, SEGMENT_DESCRIPTION_LENGTH));
}

function renderSegmentLine(segment, { withDescription }) {
  const parts = [
    `${clockOf(segment.startMs)}–${clockOf(segment.endMs)}`,
    segment.category,
    segment.project || '未记录项目',
    formatMinutes(segment.minutes),
  ];
  if (segment.software.length) parts.push(`软件 ${segment.software.join('、')}`);
  let line = parts.join(' | ');
  if (withDescription) {
    const descriptions = sampleDescriptions(segment);
    if (descriptions.length) line += `\n    描述：${descriptions.join(' / ')}`;
  }
  return line;
}

// 在字符预算内铺开时段列表：先给完整行，行放不下就退化成精简行，再放不下就丢掉并计数。
function buildContextLines(segments, budget = MAX_CONTEXT_CHARS) {
  const lines = [];
  let used = 0;
  let dropped = 0;
  for (const segment of segments) {
    const full = renderSegmentLine(segment, { withDescription: true });
    if (used + full.length <= budget) {
      lines.push(full);
      used += full.length + 1;
      continue;
    }
    const compact = renderSegmentLine(segment, { withDescription: false });
    if (used + compact.length <= budget) {
      lines.push(compact);
      used += compact.length + 1;
      continue;
    }
    dropped += 1;
  }
  return { lines, dropped };
}

// 提示词只负责「怎么汇总」，JSON 结构由 Schema 负责，不在 Prompt 里描述格式。
function buildDiaryPrompt({ day, blocks = [], previous = null }) {
  const segments = buildDiarySegments(blocks);
  const failed = (blocks ?? []).filter((block) => block?.status === 'FAILED').length;
  const { lines: contextLines, dropped } = buildContextLines(segments);

  const lines = [
    '你是生活记录助手。下面是一个自然日里每 10 分钟的活动汇总，请把它们二次汇总成这一天的日记。',
    `日期：${dayLabel(day)}`,
    '',
    `【这一天的时长分布】${describeDistribution(segments)}`,
  ];

  if (previous) {
    lines.push(
      '',
      `【上一天（${previous.day}）的日记】`,
      truncate(previous.summary, PREVIOUS_SUMMARY_LENGTH) || '（无）',
    );
    if (Array.isArray(previous.mainEvents) && previous.mainEvents.length) {
      lines.push(`主要事项：${previous.mainEvents.join('；')}`);
    }
  }

  lines.push('', `【这一天的记录】共 ${segments.length} 段，按时间从早到晚：`);
  if (contextLines.length) lines.push(...contextLines);
  else lines.push('（这一天没有可用的汇总数据）');
  if (dropped) lines.push(`（还有 ${dropped} 段时间没有在这里列出）`);
  if (failed) lines.push(`（这一天还有 ${failed} 个时间段汇总失败，没有包含在上面）`);

  lines.push(
    '',
    '要求：',
    '1. summary 用 2~4 句话概括这一天主要在做什么、推进到哪里，150 字左右；不要逐条罗列时间点。',
    '2. mainEvents 写这一天最主要的、最多三件事情，每件一句话（不超过 40 字）；确实不足三件就写实际件数。',
    '3. highlights 写值得记住的高光时刻（明显推进、状态好的时段、完成的事），没有就填空数组。',
    '4. todos 只写记录里能看出的待办（写了一半的任务、提到的截止时间、还没回复的消息），没有就填空数组。',
    '5. suggestions 给 1~3 条针对这一天的优化建议（作息、专注方式、任务安排），要具体可执行。',
    '6. tips 给 1~2 条温馨提示（健康、休息、情绪），语气温和，不要重复 suggestions。',
    '只写记录里能看到的内容，不要编造；也不要输出 JSON 结构以外的任何文字。',
  );

  return lines.join('\n');
}

// 日志用的一行摘要：只带条目数量，不带正文。
function describeDiary(diary) {
  if (!diary) return null;
  return `events=${(diary.mainEvents ?? []).length} highlights=${(diary.highlights ?? []).length}`
    + ` todos=${(diary.todos ?? []).length} suggestions=${(diary.suggestions ?? []).length}`;
}

module.exports = {
  DIARY_SCHEMA,
  MIN_SUMMARY_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_MAIN_EVENTS,
  MAX_HIGHLIGHTS,
  MAX_TODOS,
  MAX_SUGGESTIONS,
  MAX_TIPS,
  MAX_CONTEXT_CHARS,
  SEGMENT_DESCRIPTION_LENGTH,
  normalizeDiaryResult,
  buildDiarySegments,
  buildDiaryPrompt,
  describeDiary,
  describeDistribution,
  formatMinutes,
  buildContextLines,
};