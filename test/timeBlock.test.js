'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BLOCK_MINUTES,
  BLOCK_MS,
  blockStartOf,
  blockEndOf,
  blockKeyOf,
  createBlock,
} = require('../src/main/summary/timeBlock');
const {
  SUMMARY_CATEGORIES,
  SUMMARY_SCHEMA,
  MAX_PROJECT_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_SOFTWARE,
  MAX_TODOS,
  normalizeSummaryResult,
  buildSummaryPrompt,
  describeSummary,
} = require('../src/main/ai/summaryOutput');
const { OllamaSummaryProvider } = require('../src/main/ai/summaryProvider');
const { ERROR_CODES } = require('../src/main/ai/errors');
const { formatLocalIso } = require('../src/main/time');

function at(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second);
}

// 一份合法的区块汇总结果，各用例按需覆盖某个字段。
function validSummary(overrides = {}) {
  return {
    project: '玩《荒野大镖客》',
    category: '娱乐',
    description: '这一时段主要在推进游戏主线，'.repeat(20),
    software: ['Steam', 'Discord'],
    todos: [],
    ...overrides,
  };
}
function expectInvalidResult(value) {
  assert.throws(
    () => normalizeSummaryResult(value),
    (error) => {
      assert.equal(error.name, 'AIError');
      assert.equal(error.code, ERROR_CODES.INVALID_RESULT);
      return true;
    },
  );
}

// ---- 时间口径 ----

test('区块 1：10 分钟对齐（起点、结束、业务键）', () => {
  assert.equal(BLOCK_MINUTES, 10);
  assert.equal(blockStartOf(at(2026, 9, 15, 10, 0)).getMinutes(), 0);
  assert.equal(blockStartOf(at(2026, 9, 15, 10, 7, 23)).getMinutes(), 0);
  assert.equal(blockStartOf(at(2026, 9, 15, 10, 9, 59)).getMinutes(), 0);
  assert.equal(blockStartOf(at(2026, 9, 15, 10, 10)).getMinutes(), 10);
  assert.equal(blockStartOf(at(2026, 9, 15, 10, 59, 59)).getMinutes(), 50);
  assert.equal(blockStartOf(at(2026, 9, 15, 23, 59, 59)).getMinutes(), 50);

  // 秒与毫秒归零，跨天也不会串到上一天。
  const start = blockStartOf(at(2026, 9, 15, 0, 3, 30));
  assert.equal(formatLocalIso(start), formatLocalIso(at(2026, 9, 15, 0, 0)));
  assert.equal(blockEndOf(start).getTime() - start.getTime(), BLOCK_MS);
});

test('区块 2：区块键与 captured_at 同格式（字符串比较即时间比较）', () => {
  assert.equal(blockKeyOf(at(2026, 9, 15, 10, 7, 23)), formatLocalIso(at(2026, 9, 15, 10, 0)));
  assert.match(blockKeyOf(at(2026, 9, 15, 10, 7, 23)), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
  assert.equal(blockKeyOf('不是时间'), null);
  assert.equal(blockStartOf(undefined), null);
});

test('区块 3：createBlock 生成业务对象（id 与 start 同为区块键）', () => {
  const block = createBlock(at(2026, 9, 15, 10, 7), { activityCount: 6 });
  assert.equal(block.id, block.start);
  assert.equal(block.status, 'PENDING');
  assert.equal(block.activityCount, 6);
  assert.equal(
    new Date(block.end).getTime() - new Date(block.start).getTime(),
    BLOCK_MS,
    '结束时间比起点晚一个区块',
  );
  assert.throws(() => createBlock('不是时间'), /无法解析区块时间/);
});
// ---- Schema 与校验 ----

test('汇总 1：分类枚举固定为需求给的四个取值', () => {
  assert.deepEqual([...SUMMARY_CATEGORIES], ['娱乐', '工作', '学习', '社交']);
  assert.deepEqual(SUMMARY_SCHEMA.properties.category.enum, [...SUMMARY_CATEGORIES]);
  assert.deepEqual(SUMMARY_SCHEMA.required, ['project', 'category', 'description', 'software', 'todos']);
});

test('汇总 2：合法结果被归一化（trim / 去重 / 截断）', () => {
  const result = normalizeSummaryResult(validSummary({
    project: '  写《2026 年中报告》  ',
    software: [' VS Code ', 'VS Code', '', 'Chrome'],
    todos: [' 回复邮件 '],
  }));

  assert.equal(result.project, '写《2026 年中报告》');
  assert.equal(result.category, '娱乐');
  assert.deepEqual(result.software, ['VS Code', 'Chrome']);
  assert.deepEqual(result.todos, ['回复邮件']);
});

test('汇总 3：非法结果按 INVALID_RESULT 处理（可重试）', () => {
  expectInvalidResult(validSummary({ category: '摸鱼' }));
  expectInvalidResult(validSummary({ project: '' }));
  expectInvalidResult(validSummary({ project: 'x'.repeat(MAX_PROJECT_LENGTH + 1) }));
  expectInvalidResult(validSummary({ description: '太短了' }));
  expectInvalidResult(validSummary({ software: 'Steam' }));
  expectInvalidResult(validSummary({ todos: [123] }));
  expectInvalidResult('不是 JSON');
  expectInvalidResult('');
});

test('汇总 4：描述过短算失败、过长只截断；软件与待办按上限截断', () => {
  // 需求要求 1000 字左右：明显写短了说明模型没按要求写，可重试。
  assert.throws(
    () => normalizeSummaryResult(validSummary({ description: '短' })),
    (error) => error.code === ERROR_CODES.INVALID_RESULT,
  );
  assert.ok(MIN_DESCRIPTION_LENGTH >= 200);

  const long = normalizeSummaryResult(validSummary({ description: '字'.repeat(9000) })).description;
  assert.equal(long.length, 4000);

  const software = normalizeSummaryResult(validSummary({
    software: Array.from({ length: MAX_SOFTWARE + 5 }, (unused, index) => `软件${index}`),
  })).software;
  assert.equal(software.length, MAX_SOFTWARE);

  const todos = normalizeSummaryResult(validSummary({
    todos: Array.from({ length: MAX_TODOS + 5 }, (unused, index) => `待办${index}`),
  })).todos;
  assert.equal(todos.length, MAX_TODOS);
});

test('汇总 5：提示词带上本时段记录与上一个区块的汇总（沿用同一个项目名）', () => {
  const prompt = buildSummaryPrompt({
    blockStart: at(2026, 9, 15, 10, 0),
    blockEnd: at(2026, 9, 15, 10, 10),
    records: [
      {
        time: formatLocalIso(at(2026, 9, 15, 10, 0, 20)),
        status: 'COMPLETED',
        activity: '编写代码',
        summary: '在 VS Code 里编辑 recorder.js',
        category: 'coding',
        project: 'Life Lens',
        keywords: ['Electron', 'SQLite'],
      },
      {
        time: formatLocalIso(at(2026, 9, 15, 10, 5, 40)),
        status: 'PENDING',
        activity: null,
        summary: null,
        category: null,
        project: null,
        keywords: [],
      },
    ],
    previous: {
      project: '写《2026 年中报告》',
      category: '工作',
      description: '继续整理上半年数据。',
      software: ['Word'],
    },
  });

  assert.match(prompt, /10:00–10:10/);
  assert.match(prompt, /共 2 条/);
  assert.ok(prompt.includes('10:00:20 编写代码 | 在 VS Code 里编辑 recorder.js | 分类 coding | 项目 Life Lens | 关键词 Electron、SQLite'));
  assert.match(prompt, /10:05:40 （还没有分析结果）/);
  assert.match(prompt, /上一个 10 分钟的汇总/);
  assert.match(prompt, /写《2026 年中报告》/);
  assert.match(prompt, /必须沿用完全相同的项目名称/);
  assert.match(prompt, /娱乐 \/ 工作 \/ 学习 \/ 社交/);
  // 提示词只讲「怎么汇总」，不描述 JSON 结构（结构由 Schema 负责）。
  assert.equal(/json/i.test(prompt), false);
});

test('汇总 6：没有上一个区块时不出现「上一个 10 分钟」段落', () => {
  const prompt = buildSummaryPrompt({
    blockStart: at(2026, 9, 15, 10, 0),
    blockEnd: at(2026, 9, 15, 10, 10),
    records: [],
  });
  assert.equal(prompt.includes('上一个 10 分钟的汇总'), false);
  assert.match(prompt, /（这一时段没有记录）/);
});

test('汇总 7：日志摘要只带分类 / 项目 / 数量，不带描述正文', () => {
  const summary = normalizeSummaryResult(validSummary());
  const line = describeSummary(summary);
  assert.equal(line, 'category=娱乐 project=玩《荒野大镖客》 software=2 todos=0');
  assert.equal(line.includes(summary.description.slice(0, 10)), false);
  assert.equal(describeSummary(null), null);
});
// ---- Provider ----

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function chatResponse(content, status = 200) {
  return {
    ok: true,
    status,
    async json() {
      return { message: { role: 'assistant', content } };
    },
    async text() {
      return '';
    },
  };
}

// 关了思考的 Ollama 0.34 + qwen3-vl:8b：约束输出落在 thinking，content 是空串。
function thinkingOnlyResponse(content, status = 200) {
  return {
    ok: true,
    status,
    async json() {
      return { message: { role: 'assistant', content: '', thinking: content } };
    },
    async text() {
      return '';
    },
  };
}

function errorResponse(status, body) {
  return {
    ok: false,
    status,
    async json() {
      return { error: body };
    },
    async text() {
      return body;
    },
  };
}

async function expectProviderError(promise, code, retryable) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'AIError');
    assert.equal(error.code, code);
    if (retryable !== undefined) assert.equal(error.retryable, retryable);
    return true;
  });
}

// 假的上下文加载器：记录被问到的区块参数，返回固定的素材。
function fakeContext({ records = [], previous = null } = {}) {
  const calls = [];
  return {
    calls,
    load: ({ blockStart, blockEnd }) => {
      calls.push({ blockStart, blockEnd });
      return { records, previous };
    },
  };
}

function makeProvider(context, { numCtx = 0 } = {}) {
  return new OllamaSummaryProvider({
    ollamaHost: 'http://127.0.0.1:11434',
    model: 'qwen3-vl:8b',
    timeoutMs: 1000,
    loadContext: context.load,
    numCtx,
  });
}

const BLOCK_JOB = {
  id: 'job-1',
  payload: { blockStart: '2026-09-15T10:00:00+08:00', blockEnd: '2026-09-15T10:10:00+08:00' },
};

// 回归：线上出现过的「汇总失败：AI 返回了空结果」。
// 关掉思考后 Ollama 0.34 把整个 JSON 放进了 message.thinking，content 是空串，
// 于是 parseStructuredResult('') 直接判 INVALID_RESULT。汇总必须能读 thinking。
test('Provider 1b：JSON 落在 thinking 里（content 为空）时照样能汇总', async (t) => {
  const context = fakeContext({ records: [{ time: formatLocalIso(at(2026, 9, 15, 10, 0, 20)), activity: '编写代码' }] });
  const provider = makeProvider(context);

  stubFetch(t, async () => thinkingOnlyResponse(JSON.stringify(validSummary())));

  const result = await provider.analyze(BLOCK_JOB);
  assert.equal(result.analysis.category, '娱乐');
  assert.equal(result.analysis.project, validSummary().project);
  assert.equal(result.analysis.description, validSummary().description);
  assert.match(result.logLine, /^category=娱乐/);
});

test('Provider 1：请求带上汇总 Schema 与文本提示词，结果是结构化对象', async (t) => {
  const context = fakeContext({
    records: [{ time: formatLocalIso(at(2026, 9, 15, 10, 0, 20)), activity: '编写代码' }],
  });
  const provider = makeProvider(context, { numCtx: 8192 });

  let captured = null;
  stubFetch(t, async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return chatResponse(JSON.stringify(validSummary()));
  });

  const result = await provider.analyze(BLOCK_JOB);

  assert.equal(captured.url, 'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(captured.body.format, SUMMARY_SCHEMA);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.model, 'qwen3-vl:8b');
  // 汇总要写约 1000 字：token 上限必须显式给，否则会被默认值截断。
  assert.ok(captured.body.options.num_predict >= 1024);
  // 汇总必须关掉思考：开着思考时 num_predict 会被思考吃光，message.content 是空的。
  assert.equal(captured.body.think, false);
  // 汇总提示词（满员区块约 2388 token）超过 Ollama 默认上下文留给输入的份额，必须显式抬高。
  assert.equal(captured.body.options.num_ctx, 8192);
  assert.equal(captured.body.messages.length, 1);
  assert.equal('images' in captured.body.messages[0], false);
  assert.ok(captured.body.messages[0].content.includes('编写代码'));

  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].blockStart, '2026-09-15T10:00:00+08:00');
  assert.equal(result.blockStart, '2026-09-15T10:00:00+08:00');
  assert.equal(result.analysis.category, '娱乐');
  assert.equal(result.model, 'qwen3-vl:8b');
  assert.match(result.logLine, /^category=娱乐/);
  // Worker 的超时兜底读 provider.timeoutMs：汇总需要自己的时间预算。
  assert.equal(provider.timeoutMs, 1000);
});

test('Provider 1c：numCtx 为 0 时不传 num_ctx（交回 Ollama 自己决定）', async (t) => {
  const context = fakeContext();
  let captured = null;
  stubFetch(t, async (url, init) => {
    captured = JSON.parse(init.body);
    return chatResponse(JSON.stringify(validSummary()));
  });

  await makeProvider(context, { numCtx: 0 }).analyze(BLOCK_JOB);
  assert.equal('num_ctx' in captured.options, false);

  // 传正值时必须落到 options.num_ctx 上。
  await makeProvider(context, { numCtx: 16384 }).analyze(BLOCK_JOB);
  assert.equal(captured.options.num_ctx, 16384);
});

test('Provider 2：错误分类（不可达 / 超时 / 模型缺失 / 服务端错误）', async (t) => {
  const context = fakeContext();

  stubFetch(t, async () => { throw new TypeError('fetch failed'); });
  await expectProviderError(makeProvider(context).analyze(BLOCK_JOB), ERROR_CODES.OLLAMA_UNAVAILABLE, true);

  stubFetch(t, async () => {
    const error = new Error('超时');
    error.name = 'TimeoutError';
    throw error;
  });
  await expectProviderError(makeProvider(context).analyze(BLOCK_JOB), ERROR_CODES.AI_TIMEOUT, true);

  stubFetch(t, async () => errorResponse(404, 'model not found'));
  await expectProviderError(makeProvider(context).analyze(BLOCK_JOB), ERROR_CODES.MODEL_NOT_FOUND, false);

  stubFetch(t, async () => errorResponse(500, 'internal'));
  await expectProviderError(makeProvider(context).analyze(BLOCK_JOB), ERROR_CODES.OLLAMA_ERROR, true);
});

test('Provider 3：结果不合法按 INVALID_RESULT 处理（可重试）', async (t) => {
  const context = fakeContext();

  stubFetch(t, async () => chatResponse(JSON.stringify(validSummary({ category: '摸鱼' }))));
  await expectProviderError(makeProvider(context).analyze(BLOCK_JOB), ERROR_CODES.INVALID_RESULT, true);

  stubFetch(t, async () => chatResponse(''));
  await expectProviderError(makeProvider(context).analyze(BLOCK_JOB), ERROR_CODES.INVALID_RESULT, true);
});

test('Provider 4：任务缺少区块起点时直接失败，不发起请求', async (t) => {
  const context = fakeContext();
  let calls = 0;
  stubFetch(t, async () => {
    calls += 1;
    return chatResponse('{}');
  });

  await expectProviderError(
    makeProvider(context).analyze({ id: 'job-1', payload: {} }),
    ERROR_CODES.INVALID_RESULT,
    true,
  );
  assert.equal(calls, 0);
  assert.equal(context.calls.length, 0);
});
