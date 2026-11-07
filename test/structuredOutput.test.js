'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  AI_CATEGORIES,
  STRUCTURED_AI_SCHEMA,
  STRUCTURED_PROMPT,
  MAX_KEYWORDS,
  normalizeStructuredResult,
} = require('../src/main/ai/structuredOutput');
const { OllamaVisionProvider } = require('../src/main/ai/visionProvider');
const { AIWorker } = require('../src/main/ai/AIWorker');
const { AIError, ERROR_CODES } = require('../src/main/ai/errors');
const { Store } = require('../src/main/store');
const { Recorder } = require('../src/main/recorder');
const {
  tempDir,
  makeQueue,
  fakeProvider,
  fakeCapture,
  waitFor,
  silentLog,
  cleanup,
} = require('./support');

// 一份合法的结构化结果，各用例按需覆盖其中某个字段。
function validResult(overrides = {}) {
  return {
    activity: '编写代码',
    summary: '正在使用 VS Code 开发 Electron 项目。',
    category: 'coding',
    project: 'Life Lens',
    keywords: ['Electron', 'JavaScript'],
    confidence: 0.94,
    ...overrides,
  };
}

function expectInvalidResult(value) {
  assert.throws(
    () => normalizeStructuredResult(value),
    (error) => {
      assert.equal(error.name, 'AIError');
      assert.equal(error.code, ERROR_CODES.INVALID_RESULT);
      return true;
    },
  );
}

// 只在测试进程里替换 fetch：真实的 Ollama、GPU、Qwen3-VL 都不参与测试。
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

// ---- Schema ----

test('Schema：必填字段、枚举、project 可为 null、confidence 上下限', () => {
  assert.deepEqual(STRUCTURED_AI_SCHEMA.required.slice().sort(), [
    'activity',
    'category',
    'confidence',
    'keywords',
    'project',
    'summary',
  ]);
  assert.equal(STRUCTURED_AI_SCHEMA.additionalProperties, false);
  assert.deepEqual(STRUCTURED_AI_SCHEMA.properties.project.type, ['string', 'null']);
  assert.deepEqual(STRUCTURED_AI_SCHEMA.properties.category.enum, [...AI_CATEGORIES]);
  assert.equal(STRUCTURED_AI_SCHEMA.properties.keywords.maxItems, MAX_KEYWORDS);
  assert.equal(STRUCTURED_AI_SCHEMA.properties.confidence.minimum, 0);
  assert.equal(STRUCTURED_AI_SCHEMA.properties.confidence.maximum, 1);
  // Schema 负责结构，Prompt 不再描述 JSON 格式。
  assert.ok(!/json/i.test(STRUCTURED_PROMPT), 'Prompt 里不应该出现 JSON 格式说明');
});

// ---- Validation / Normalization ----

test('Test 1：合法结果通过校验并保持原值', () => {
  assert.deepEqual(normalizeStructuredResult(validResult()), validResult());
});

test('Test 2：缺少必填字段直接失败', () => {
  expectInvalidResult({ activity: '编写代码' });
  expectInvalidResult(validResult({ summary: undefined }));
  expectInvalidResult(validResult({ confidence: undefined }));
});

test('Test 3：非法 category 失败（不允许模型自由造分类）', () => {
  expectInvalidResult(validResult({ category: 'gaming123' }));
  expectInvalidResult(validResult({ category: 'CODING' }));
  expectInvalidResult(validResult({ category: 3 }));
});

test('Test 4 / Test 9：confidence 必须是 0 到 1 的数字', () => {
  for (const value of [0, 0.5, 1, 0.94]) {
    assert.equal(normalizeStructuredResult(validResult({ confidence: value })).confidence, value);
  }
  expectInvalidResult(validResult({ confidence: 1.5 }));
  expectInvalidResult(validResult({ confidence: -0.1 }));
  expectInvalidResult(validResult({ confidence: '0.9' }));
  expectInvalidResult(validResult({ confidence: Number.NaN }));
});

test('Test 5：project 允许 null，空字符串按 null 处理', () => {
  assert.equal(normalizeStructuredResult(validResult({ project: null })).project, null);
  assert.equal(normalizeStructuredResult(validResult({ project: '   ' })).project, null);
  assert.equal(normalizeStructuredResult(validResult({ project: ' Life Lens ' })).project, 'Life Lens');
  expectInvalidResult(validResult({ project: 42 }));
});

test('Test 6：空 keywords 合法', () => {
  assert.deepEqual(normalizeStructuredResult(validResult({ keywords: [] })).keywords, []);
});

test('Test 7：重复与空白关键词会被清理', () => {
  const result = normalizeStructuredResult(
    validResult({ keywords: ['Electron', 'Electron', ' JavaScript ', '', '  ', 'JavaScript'] }),
  );
  assert.deepEqual(result.keywords, ['Electron', 'JavaScript']);
});

test('Test 8：超过 8 个关键词按顺序截断', () => {
  const many = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10'];
  const result = normalizeStructuredResult(validResult({ keywords: many }));
  assert.equal(result.keywords.length, MAX_KEYWORDS);
  assert.deepEqual(result.keywords, many.slice(0, MAX_KEYWORDS));
});

test('keywords 不是数组或元素不是字符串时失败', () => {
  expectInvalidResult(validResult({ keywords: 'Electron' }));
  expectInvalidResult(validResult({ keywords: ['Electron', 3] }));
});

test('activity / summary 会 trim，空串与超长内容失败', () => {
  const result = normalizeStructuredResult(validResult({ activity: '  编写代码  ' }));
  assert.equal(result.activity, '编写代码');

  expectInvalidResult(validResult({ activity: '   ' }));
  expectInvalidResult(validResult({ summary: '' }));
  expectInvalidResult(validResult({ activity: 'x'.repeat(101) }));
  expectInvalidResult(validResult({ summary: 'x'.repeat(501) }));
});

test('防御性解析：容忍 Markdown 代码块，其余非法输入一律失败', () => {
  const fenced = normalizeStructuredResult('```json\n' + JSON.stringify(validResult()) + '\n```');
  assert.deepEqual(fenced, validResult());

  expectInvalidResult('');
  expectInvalidResult('   ');
  expectInvalidResult('这不是 JSON');
  expectInvalidResult('[1, 2, 3]');
  expectInvalidResult('null');
  expectInvalidResult(undefined);
});

test('result 之外的字段会被丢弃', () => {
  const result = normalizeStructuredResult(validResult({ extra: '不应该出现' }));
  assert.equal('extra' in result, false);
});

// ---- Provider ----

async function makeProviderHarness(t, { handler, imageExists = true } = {}) {
  const dir = await tempDir();
  cleanup(t, dir);
  const imagePath = path.join(dir, 'shot.png');
  if (imageExists) await fs.writeFile(imagePath, Buffer.from('fake-png'));
  stubFetch(t, handler);
  const provider = new OllamaVisionProvider({
    ollamaHost: 'http://127.0.0.1:11434',
    model: 'qwen3-vl:8b',
    timeoutMs: 1000,
    prepareImage: null,
  });
  const job = {
    id: 'job-1',
    payload: { screenshotId: 'shot-1', imagePath, capturedAt: '2026-09-13T10:00:00+08:00' },
  };
  return { provider, job, imagePath };
}

test('Test 10：请求真正带上 JSON Schema，而不是只在 Prompt 里要求 JSON', async (t) => {
  let captured = null;
  const { provider, job } = await makeProviderHarness(t, {
    handler: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return chatResponse(JSON.stringify(validResult()));
    },
  });

  await provider.analyze(job);

  assert.equal(captured.url, 'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(captured.body.format, STRUCTURED_AI_SCHEMA);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.model, 'qwen3-vl:8b');
  // 截图分析必须关思考：开着思考时 qwen3-vl 会先生成上千个思考 token，把单张分析拖到几十秒。
  // （think:false 下 JSON 落在 message.thinking、content 为空，analyzer 已做回退。）
  assert.equal(captured.body.think, false);
  assert.equal(captured.body.messages[0].images[0], Buffer.from('fake-png').toString('base64'));
  assert.ok(!/json/i.test(captured.body.messages[0].content));
});

test('Provider：合法结构化结果被归一化，并带上一行日志摘要', async (t) => {
  const { provider, job } = await makeProviderHarness(t, {
    handler: async () => chatResponse(JSON.stringify(validResult({ activity: ' 编写代码 ' }))),
  });

  const result = await provider.analyze(job);
  assert.deepEqual(result.analysis, validResult());
  assert.equal(result.jobId, 'job-1');
  assert.equal(result.screenshotId, 'shot-1');
  assert.equal(result.model, 'qwen3-vl:8b');
  assert.equal(result.logLine, 'category=coding project=Life Lens confidence=0.94');
});

test('Provider：结构化结果不合法时按 INVALID_RESULT 处理（可重试）', async (t) => {
  const { provider, job } = await makeProviderHarness(t, {
    handler: async () => chatResponse(JSON.stringify(validResult({ category: 'gaming' }))),
  });
  await expectProviderError(provider.analyze(job), ERROR_CODES.INVALID_RESULT, true);
});

test('Provider：content 为空（例如 JSON 全落在 thinking 里）算失败', async (t) => {
  const { provider, job } = await makeProviderHarness(t, {
    handler: async () => chatResponse(''),
  });
  await expectProviderError(provider.analyze(job), ERROR_CODES.INVALID_RESULT, true);
});

test('Provider：Ollama 不可达 / 超时 / 模型缺失的错误分类', async (t) => {
  const offline = await makeProviderHarness(t, {
    handler: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await expectProviderError(offline.provider.analyze(offline.job), ERROR_CODES.OLLAMA_UNAVAILABLE, true);

  const timeout = await makeProviderHarness(t, {
    handler: async () => {
      const error = new Error('超时');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  await expectProviderError(timeout.provider.analyze(timeout.job), ERROR_CODES.AI_TIMEOUT, true);

  const missing = await makeProviderHarness(t, {
    handler: async () => errorResponse(404, 'model not found'),
  });
  await expectProviderError(missing.provider.analyze(missing.job), ERROR_CODES.MODEL_NOT_FOUND, false);

  const serverError = await makeProviderHarness(t, {
    handler: async () => errorResponse(500, 'internal'),
  });
  await expectProviderError(serverError.provider.analyze(serverError.job), ERROR_CODES.OLLAMA_ERROR, true);
});

test('Provider：模型不支持结构化输出时不重试，直接永久失败', async (t) => {
  let calls = 0;
  const { provider, job } = await makeProviderHarness(t, {
    handler: async () => {
      calls += 1;
      return errorResponse(400, 'invalid format: json schema is not supported by this model');
    },
  });
  await expectProviderError(
    provider.analyze(job),
    ERROR_CODES.STRUCTURED_OUTPUT_UNSUPPORTED,
    false,
  );
  assert.equal(calls, 1);
});

test('Provider：截图不存在时直接 IMAGE_NOT_FOUND，不发起推理', async (t) => {
  let calls = 0;
  const { provider, job } = await makeProviderHarness(t, {
    imageExists: false,
    handler: async () => {
      calls += 1;
      return chatResponse(JSON.stringify(validResult()));
    },
  });
  await expectProviderError(provider.analyze(job), ERROR_CODES.IMAGE_NOT_FOUND, false);
  assert.equal(calls, 0);
});

// ---- 应用层 ----

function configFor(dir) {
  return { intervalMs: 20, model: 'fake-model', outputDir: dir };
}

function makeHarness({ dir, store, activities, queue, provider, workerOptions = {} }) {
  const recorder = new Recorder({
    store,
    activities,
    config: configFor(dir),
    onEvent: () => {},
    aiQueue: queue,
    capture: fakeCapture(),
  });
  const worker = new AIWorker({
    queue,
    provider,
    log: silentLog(),
    healthPollMs: 10,
    onCompleted: (job, result) => recorder.handleAnalysisResult(job, result),
    onFailed: (job, error) => recorder.handleAnalysisFailure(job, error),
    ...workerOptions,
  });
  return { recorder, worker };
}

test('Test 11：结构化结果完整写入 Activity Record（PENDING -> COMPLETED）', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir });
  await queue.start();

  const analysis = validResult();
  const provider = fakeProvider({
    analyze: async () => ({ analysis, logLine: 'category=coding', model: 'fake-model', analysisMs: 7 }),
  });
  const { recorder, worker } = makeHarness({ dir, store, activities, queue, provider });
  cleanup(t, dir, [recorder, worker, queue]);
  worker.start();
  recorder.start();

  await waitFor(async () => {
    const [record] = await activities.listRecent(1);
    return Boolean(record) && record.analysisStatus === 'COMPLETED';
  });

  const [record] = await activities.listRecent(1);
  assert.deepEqual(record.analysis, analysis);
  assert.equal(record.summary, analysis.summary, '顶层 summary 与结构化结果保持一致（向后兼容）');
  assert.equal(record.analysisMs, 7);
  assert.equal(record.error, null);
});

test('Test 12：结构化输出失败不会停止截图', async (t) => {
  const dir = await tempDir();
  const store = new Store(dir);
  const { queue, activities } = await makeQueue({ dir, retryDelaysMs: [5, 5, 5] });
  await queue.start();

  const provider = fakeProvider({
    analyze: async () => {
      throw new AIError(ERROR_CODES.INVALID_RESULT, 'AI 返回的不是合法 JSON');
    },
  });
  const { recorder, worker } = makeHarness({ dir, store, activities, queue, provider });
  cleanup(t, dir, [recorder, worker, queue]);
  worker.start();
  recorder.start();

  await waitFor(() => queue.getStats().failed >= 2);

  assert.ok(recorder.status.total >= 3, 'AI 一直失败，截图仍然继续');
  const images = await fs.readdir(store.imageDir(new Date()));
  assert.ok(images.length >= 3, '失败的截图文件仍然保留在磁盘上');

  const failed = (await activities.listRecent(10)).find((record) => record.analysisStatus === 'FAILED');
  assert.equal(failed.errorCode, ERROR_CODES.INVALID_RESULT);
  assert.equal(failed.analysis, null, '失败时不会写入任何结构化结果');
});
