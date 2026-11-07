'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ActivityRepository } = require('../src/main/db/repositories/ActivityRepository');
const { formatLocalIso } = require('../src/main/time');
const { tempDir, cleanup, openTestDb, silentLog } = require('./support');

function makeRepo(dir) {
  const db = openTestDb(dir);
  return { db, repo: new ActivityRepository({ db, log: silentLog() }) };
}

function makeRecord(id, date, extra = {}) {
  return {
    id,
    time: formatLocalIso(date),
    imagePath: `C:/tmp/${id}.png`,
    model: 'fake-model',
    analysisMs: null,
    analysisStatus: 'PENDING',
    error: null,
    errorCode: null,
    analysis: null,
    ...extra,
  };
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

test('记录按时间排序：listRecent 从新到旧，listPendingRecords 从旧到新', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  const first = new Date(2026, 8, 11, 21, 6, 0);
  const second = new Date(2026, 8, 11, 21, 30, 0);
  const nextMonth = new Date(2026, 9, 1, 9, 0, 0);

  repo.createActivity(makeRecord('a', first));
  repo.createActivity(makeRecord('b', second));
  repo.createActivity(makeRecord('c', nextMonth));

  assert.deepEqual(repo.listRecent(10).map((record) => record.id), ['c', 'b', 'a']);
  assert.deepEqual(repo.listPendingRecords().map((record) => record.id), ['a', 'b', 'c']);
});

test('updateAnalysis：只回填指定的那条记录，其余记录不受影响', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  const date = new Date(2026, 8, 11, 21, 6, 0);
  repo.createActivity(makeRecord('a', date));
  repo.createActivity(makeRecord('b', date));

  const saved = repo.updateAnalysis('b', {
    analysis: {
      activity: '写代码',
      summary: '写代码',
      category: 'coding',
      project: null,
      keywords: ['代码'],
      confidence: 0.8,
    },
    analysisStatus: 'COMPLETED',
    error: null,
    errorCode: null,
  });
  assert.equal(saved, true);

  const a = repo.getByScreenshotId('a');
  const b = repo.getByScreenshotId('b');
  assert.equal(a.analysisStatus, 'PENDING');
  assert.equal(a.summary, null);
  assert.equal(a.analysis, null);
  assert.equal(b.analysisStatus, 'COMPLETED');
  assert.equal(b.summary, '写代码');

  assert.equal(repo.updateAnalysis('不存在', { analysisStatus: 'FAILED' }), false);
});

test('updateAnalysis：失败回填不会抹掉上一次成功的结构化结果', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  const date = new Date(2026, 8, 11, 21, 6, 0);
  repo.createActivity(makeRecord('a', date));

  const analysis = {
    activity: '写代码',
    summary: '写代码',
    category: 'coding',
    project: null,
    keywords: [],
    confidence: 0.7,
  };
  repo.updateAnalysis('a', { analysis, analysisStatus: 'COMPLETED' });
  // 重新分析失败：只改状态与错误，不动已有的 analysis。
  repo.updateAnalysis('a', {
    analysisStatus: 'FAILED',
    error: '模型不存在',
    errorCode: 'MODEL_NOT_FOUND',
    analysisMs: null,
  });

  const saved = repo.getByScreenshotId('a');
  assert.equal(saved.analysisStatus, 'FAILED');
  assert.equal(saved.errorCode, 'MODEL_NOT_FOUND');
  assert.deepEqual(saved.analysis, analysis);
});

test('loadStats 按 analysisStatus 统计总数 / 已分析 / 失败 / 待分析', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  const date = new Date(2026, 8, 11, 21, 6, 0);

  repo.createActivity(makeRecord('pending', date));
  repo.createActivity(makeRecord('done', date));
  repo.createActivity(makeRecord('failed', date));
  repo.updateAnalysis('done', { analysisStatus: 'COMPLETED' });
  repo.updateAnalysis('failed', { analysisStatus: 'FAILED', error: '失败' });
  // 回填过程不能改变 captured_at，否则 lastCaptureAt 会漂移。
  repo.createActivity(makeRecord('later', new Date(2026, 8, 11, 22, 0, 0)));

  assert.deepEqual(repo.loadStats(), {
    total: 4,
    analyzed: 1,
    errors: 1,
    pending: 2,
    lastCaptureAt: formatLocalIso(new Date(2026, 8, 11, 22, 0, 0)),
  });
});

test('listPendingRecords：只返回还没拿到分析结果的记录', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  const date = new Date(2026, 8, 11, 21, 6, 0);

  repo.createActivity(makeRecord('p1', date));
  repo.createActivity(makeRecord('done', date, { analysisStatus: 'COMPLETED' }));
  repo.createActivity(makeRecord('p2', date));
  repo.createActivity(makeRecord('failed', date, { analysisStatus: 'FAILED', error: 'x' }));

  const pending = repo.listPendingRecords();
  assert.deepEqual(pending.map((record) => record.id).sort(), ['p1', 'p2']);
});

test('空数据库：统计为 0，列表为空', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  assert.deepEqual(repo.loadStats(), {
    total: 0, analyzed: 0, errors: 0, pending: 0, lastCaptureAt: null,
  });
  assert.deepEqual(repo.listRecent(5), []);
  assert.deepEqual(repo.listPendingRecords(), []);
  assert.equal(repo.getByScreenshotId('不存在'), null);
});

test('Test 3：createActivity 写入 id / captured_at / image_path / analysis_status', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  const date = new Date(2026, 8, 13, 13, 30, 0);
  const record = makeRecord('2026-09-13_13-30-00-000', date);

  const id = repo.createActivity(record);
  assert.ok(Number.isInteger(id) && id > 0, 'createActivity 返回自增主键');

  const saved = repo.getByScreenshotId(record.id);
  assert.equal(saved.id, record.id);
  assert.equal(saved.time, formatLocalIso(date));
  assert.equal(saved.imagePath, record.imagePath);
  assert.equal(saved.analysisStatus, 'PENDING');
  assert.equal(saved.analysis, null);
  assert.equal(saved.error, null);
});

test('Test 4：结构化分析结果按字段落库，读回完全一致', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { db, repo } = makeRepo(dir);
  const date = new Date(2026, 8, 13, 13, 30, 0);
  repo.createActivity(makeRecord('s1', date));

  const analysis = {
    activity: '学习技术文档',
    summary: '正在学习 AI 服务相关内容',
    category: 'learning',
    project: null,
    keywords: ['AI', 'Ollama'],
    confidence: 0.9,
  };
  repo.updateAnalysis('s1', {
    analysis,
    analysisStatus: 'COMPLETED',
    model: 'qwen3-vl:8b',
    analysisMs: 4210,
    error: null,
    errorCode: null,
  });

  assert.deepEqual(repo.getByScreenshotId('s1').analysis, analysis);

  // 结构化字段是分开的列，而不是一坨 JSON；keywords 以 JSON 字符串存放。
  const row = db.prepare(
    'SELECT activity, summary, category, project, keywords_json, confidence, model, analysis_ms'
    + ' FROM activities WHERE screenshot_id = ?',
  ).get('s1');
  assert.equal(row.activity, '学习技术文档');
  assert.equal(row.summary, '正在学习 AI 服务相关内容');
  assert.equal(row.category, 'learning');
  assert.equal(row.project, null);
  assert.equal(row.keywords_json, JSON.stringify(['AI', 'Ollama']));
  assert.equal(row.confidence, 0.9);
  assert.equal(row.model, 'qwen3-vl:8b');
  assert.equal(row.analysis_ms, 4210);

  // confidence 的业务约束（0 <= x <= 1）在 Database 层也拦一道。
  assert.throws(() => {
    db.prepare('UPDATE activities SET confidence = ? WHERE screenshot_id = ?').run(1.5, 's1');
  });
});

test('Test 9：中文 / English / emoji / 特殊字符都能正确存取', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  const date = new Date(2026, 8, 13, 13, 30, 0);
  repo.createActivity(makeRecord('s1', date));

  const emoji = '\u{1F600}\u{1F680}';
  const analysis = {
    activity: '正在浏览知乎学堂',
    summary: `GPU利用率 100%，AI 服务 <Ollama> 正在跑；emoji ${emoji} 也没问题。`,
    category: 'browsing',
    project: 'Life Lens 测试',
    keywords: ['中文', 'English', emoji, 'C:\\path\\to\\file', '双引号 " 与反斜杠 \\ 结尾'],
    confidence: 1,
  };
  repo.updateAnalysis('s1', { analysis, analysisStatus: 'COMPLETED' });

  const saved = repo.getByScreenshotId('s1');
  assert.deepEqual(saved.analysis, analysis);
  assert.equal(saved.analysis.keywords[2], emoji);
});

test('Test 10：时间统一是带时区偏移的 ISO-8601 字符串', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { db, repo } = makeRepo(dir);
  const date = new Date(2026, 8, 13, 13, 30, 0);
  repo.createActivity(makeRecord('s1', date));
  repo.updateAnalysis('s1', { analysisStatus: 'COMPLETED' });

  const row = db.prepare(
    'SELECT captured_at, created_at, updated_at FROM activities WHERE screenshot_id = ?',
  ).get('s1');
  assert.equal(row.captured_at, formatLocalIso(date));
  assert.match(row.captured_at, ISO_WITH_OFFSET);
  assert.match(row.created_at, ISO_WITH_OFFSET);
  assert.match(row.updated_at, ISO_WITH_OFFSET);
  // 同一张表里不混用 UTC 与本地两种形态。
  assert.ok(!row.captured_at.endsWith('Z'), '不写入 UTC 形态');

  // 字符串排序即时间排序。
  repo.createActivity(makeRecord('s2', new Date(2026, 8, 13, 14, 0, 0)));
  assert.deepEqual(repo.listRecent(2).map((record) => record.id), ['s2', 's1']);
});

test('Test 11：1000 条记录：没有损坏，查询与排序正常', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { db, repo } = makeRepo(dir);

  const total = 1000;
  for (let i = 0; i < total; i += 1) {
    repo.createActivity(makeRecord(`shot-${String(i).padStart(4, '0')}`, new Date(2026, 0, 1, 0, i)));
  }

  assert.equal(repo.loadStats().total, total);
  assert.equal(repo.listPendingRecords().length, total);

  const recent = repo.listRecent(10);
  assert.deepEqual(
    recent.map((record) => record.id),
    Array.from({ length: 10 }, (_unused, index) => `shot-${String(total - 1 - index).padStart(4, '0')}`),
  );
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
