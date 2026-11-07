'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ActivityRepository } = require('../src/main/db/repositories/ActivityRepository');
const {
  registerTimelineIpc,
  TIMELINE_CHANNEL,
  TIMELINE_FACETS_CHANNEL,
} = require('../src/main/timelineIpc');
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

// 固定用 2026-09-11 这一天，只关心时刻。
function at(hour, minute = 0, second = 0) {
  return new Date(2026, 8, 11, hour, minute, second);
}

function ids(result) {
  return result.items.map((item) => item.id);
}

// 假的 ipcMain：只记录注册了哪些通道，测试直接调用 handler，不需要启动 Electron。
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

test('Timeline 1：空库查询返回空列表与默认分页参数', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  assert.deepEqual(repo.queryTimeline(), {
    items: [],
    total: 0,
    limit: 20,
    offset: 0,
    hasMore: false,
  });
  // 空库 + 时间范围 + 分页，同样不报错。
  assert.deepEqual(repo.queryTimeline({ from: at(9), to: at(18), limit: 5, offset: 10 }), {
    items: [],
    total: 0,
    limit: 5,
    offset: 10,
    hasMore: false,
  });
});

test('Timeline 2：按 captured_at 倒序，同一时间按 id 倒序', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  repo.createActivity(makeRecord('a', at(9)));
  repo.createActivity(makeRecord('c', at(11)));
  repo.createActivity(makeRecord('b', at(10)));
  repo.createActivity(makeRecord('e', at(10, 30)));
  repo.createActivity(makeRecord('d', at(10, 30)));

  const result = repo.queryTimeline();
  // 同一 captured_at 内按 id（插入顺序）倒序：d 比 e 后插入，所以排在 e 前面。
  assert.deepEqual(ids(result), ['c', 'd', 'e', 'b', 'a']);
  assert.equal(result.total, 5);
});

test('Timeline 3：排序基于 captured_at，而不是 AI 完成时间', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { db, repo } = makeRepo(dir);

  // early 先截图、后完成分析；late 后截图、仍是 PENDING。
  repo.createActivity(makeRecord('early', at(9)));
  repo.createActivity(makeRecord('late', at(10)));
  repo.updateAnalysis('early', {
    analysis: {
      activity: '写代码',
      summary: '写代码',
      category: 'coding',
      project: null,
      keywords: [],
      confidence: 0.8,
    },
    analysisStatus: 'COMPLETED',
  });
  // 把 updated_at 推到记录时间之后，确保排序与「最后更新时间」无关。
  db.prepare('UPDATE activities SET updated_at = ? WHERE screenshot_id = ?')
    .run(formatLocalIso(new Date(2026, 9, 1, 0, 0, 0)), 'early');

  assert.deepEqual(ids(repo.queryTimeline()), ['late', 'early']);
});

test('Timeline 4：时间范围是闭开区间 [from, to)', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  repo.createActivity(makeRecord('nine', at(9)));
  repo.createActivity(makeRecord('ten', at(10)));
  repo.createActivity(makeRecord('eleven', at(11)));

  assert.deepEqual(ids(repo.queryTimeline({ from: at(10) })), ['eleven', 'ten']);
  assert.deepEqual(ids(repo.queryTimeline({ to: at(11) })), ['ten', 'nine']);
  // to 是开区间：11:00 的那条不算在内。
  assert.deepEqual(ids(repo.queryTimeline({ from: at(10), to: at(11) })), ['ten']);
  assert.deepEqual(ids(repo.queryTimeline({ from: at(12) })), []);
  assert.deepEqual(ids(repo.queryTimeline({ to: at(9) })), []);
});

test('Timeline 5：时间边界接受 Date / 毫秒时间戳 / 各种 ISO 字符串，非法值忽略', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  const low = at(10);
  const high = at(11);
  const inside = at(10, 30);
  repo.createActivity(makeRecord('t', inside));

  assert.deepEqual(ids(repo.queryTimeline({ from: low, to: high })), ['t']);
  assert.deepEqual(ids(repo.queryTimeline({ from: low.getTime(), to: high.getTime() })), ['t']);
  assert.deepEqual(ids(repo.queryTimeline({ from: formatLocalIso(low), to: formatLocalIso(high) })), ['t']);
  // UTC 形态（toISOString）也要归一化到同一个瞬间，与数据库里的本地时区形态可比。
  // 时间精度是秒，所以上界加 1 秒（加 1 毫秒会被抹掉）。
  assert.deepEqual(
    ids(repo.queryTimeline({ from: inside.toISOString(), to: new Date(inside.getTime() + 1000).toISOString() })),
    ['t'],
  );

  // 解析不出来的值只是这一侧不加边界，不能让查询整体失败。
  assert.deepEqual(ids(repo.queryTimeline({ from: '不是时间' })), ['t']);
  assert.deepEqual(ids(repo.queryTimeline({ to: '不是时间' })), ['t']);
  assert.deepEqual(ids(repo.queryTimeline({ from: null })), ['t']);
});

test('Timeline 6：分页 limit / offset 与 hasMore', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  for (let i = 1; i <= 5; i += 1) {
    repo.createActivity(makeRecord(`s${i}`, at(8 + i)));
  }

  const first = repo.queryTimeline({ limit: 2 });
  assert.deepEqual(ids(first), ['s5', 's4']);
  assert.deepEqual(
    { total: first.total, limit: first.limit, offset: first.offset, hasMore: first.hasMore },
    { total: 5, limit: 2, offset: 0, hasMore: true },
  );

  const second = repo.queryTimeline({ limit: 2, offset: 2 });
  assert.deepEqual(ids(second), ['s3', 's2']);
  assert.equal(second.hasMore, true);

  const third = repo.queryTimeline({ limit: 2, offset: 4 });
  assert.deepEqual(ids(third), ['s1']);
  assert.equal(third.hasMore, false);

  // 越界 offset：空列表，但总数仍然真实。
  const beyond = repo.queryTimeline({ limit: 2, offset: 10 });
  assert.deepEqual(ids(beyond), []);
  assert.equal(beyond.total, 5);
  assert.equal(beyond.hasMore, false);

  // 分页与时间范围叠加。
  const ranged = repo.queryTimeline({ from: at(10), limit: 1, offset: 1 });
  assert.deepEqual(ids(ranged), ['s4']);
  assert.equal(ranged.total, 4);

  // 逐页取完 = 全部记录，且不重不漏。
  const paged = [
    ...ids(repo.queryTimeline({ limit: 2 })),
    ...ids(repo.queryTimeline({ limit: 2, offset: 2 })),
    ...ids(repo.queryTimeline({ limit: 2, offset: 4 })),
  ];
  assert.deepEqual(paged, ids(repo.queryTimeline({ limit: 10 })));
});

test('Timeline 7：limit / offset 非法值归一化（默认 20、最大 100、最小 1）', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  repo.createActivity(makeRecord('a', at(9)));

  assert.equal(repo.queryTimeline(undefined).limit, 20);
  assert.equal(repo.queryTimeline(null).limit, 20);
  assert.equal(repo.queryTimeline({}).limit, 20);
  assert.equal(repo.queryTimeline({ limit: null }).limit, 20);
  assert.equal(repo.queryTimeline({ limit: 'abc' }).limit, 20);
  assert.equal(repo.queryTimeline({ limit: 1000 }).limit, 100);
  assert.equal(repo.queryTimeline({ limit: 0 }).limit, 1);
  assert.equal(repo.queryTimeline({ limit: -3 }).limit, 1);
  assert.equal(repo.queryTimeline({ limit: 2.9 }).limit, 2);

  assert.equal(repo.queryTimeline({ offset: -5 }).offset, 0);
  assert.equal(repo.queryTimeline({ offset: 'abc' }).offset, 0);
  assert.equal(repo.queryTimeline({ offset: 3.7 }).offset, 3);
});

test('Timeline 8：PENDING / PROCESSING / COMPLETED / FAILED 等状态都能正常返回', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  repo.createActivity(makeRecord('pending', at(9)));
  repo.createActivity(makeRecord('processing', at(9, 1)));
  repo.createActivity(makeRecord('completed', at(9, 2)));
  repo.createActivity(makeRecord('failed', at(9, 3)));
  repo.createActivity(makeRecord('unknown', at(9, 4)));

  repo.updateAnalysis('processing', { analysisStatus: 'PROCESSING' });
  repo.updateAnalysis('completed', {
    analysis: {
      activity: '写代码',
      summary: '写代码',
      category: 'coding',
      project: null,
      keywords: ['代码'],
      confidence: 0.9,
    },
    analysisStatus: 'COMPLETED',
  });
  repo.updateAnalysis('failed', {
    analysisStatus: 'FAILED',
    error: '模型不存在',
    errorCode: 'MODEL_NOT_FOUND',
  });
  // 未来可能出现的新状态：原样返回，不能因为不认识就报错。
  repo.updateAnalysis('unknown', { analysisStatus: 'SOMETHING_ELSE' });

  const items = new Map(repo.queryTimeline().items.map((item) => [item.id, item]));
  assert.equal(items.size, 5);

  assert.equal(items.get('pending').analysisStatus, 'PENDING');
  assert.equal(items.get('pending').analysis, null);

  assert.equal(items.get('processing').analysisStatus, 'PROCESSING');
  assert.equal(items.get('processing').analysis, null);

  assert.equal(items.get('completed').analysisStatus, 'COMPLETED');
  assert.equal(items.get('completed').analysis.activity, '写代码');

  assert.equal(items.get('failed').analysisStatus, 'FAILED');
  assert.equal(items.get('failed').errorCode, 'MODEL_NOT_FOUND');
  assert.equal(items.get('failed').error, '模型不存在');
  assert.equal(items.get('failed').analysis, null);

  assert.equal(items.get('unknown').analysisStatus, 'SOMETHING_ELSE');
});

test('Timeline 9：结构化 AI 结果与 keywords（数组）完整返回', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  repo.createActivity(makeRecord('s1', at(13, 30)));

  const analysis = {
    activity: '学习技术文档',
    summary: '正在学习 AI 服务相关内容',
    category: 'learning',
    project: 'Life Lens',
    keywords: ['AI', 'Ollama'],
    confidence: 0.9,
  };
  repo.updateAnalysis('s1', {
    analysis,
    analysisStatus: 'COMPLETED',
    model: 'qwen3-vl:8b',
    analysisMs: 4210,
  });

  const item = repo.queryTimeline().items[0];
  assert.deepEqual(item.analysis, analysis);
  assert.ok(Array.isArray(item.analysis.keywords), 'keywords 以数组形式给上层');
  assert.equal(item.id, 's1');
  assert.equal(item.time, formatLocalIso(at(13, 30)));
  assert.equal(item.imagePath, 'C:/tmp/s1.png');
  assert.equal(item.summary, analysis.summary);
  assert.equal(item.model, 'qwen3-vl:8b');
  assert.equal(item.analysisMs, 4210);
  assert.equal(item.error, null);
});

test('Timeline 10：keywords_json 损坏或不是数组时退化成空数组，不影响其它记录', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { db, repo } = makeRepo(dir);

  for (const [id, hour] of [['a', 9], ['b', 10], ['c', 11]]) {
    repo.createActivity(makeRecord(id, at(hour)));
    repo.updateAnalysis(id, {
      analysis: {
        activity: `活动 ${id}`,
        summary: `摘要 ${id}`,
        category: 'other',
        project: null,
        keywords: ['k'],
        confidence: 0.5,
      },
      analysisStatus: 'COMPLETED',
    });
  }

  // 外力写坏 keyword（合法 JSON 但不是数组 / 根本不是 JSON）：只让这一行的 keywords 变空。
  db.prepare('UPDATE activities SET keywords_json = ? WHERE screenshot_id = ?').run('{a:1}', 'b');
  db.prepare('UPDATE activities SET keywords_json = ? WHERE screenshot_id = ?').run('这不是 JSON', 'c');

  const items = new Map(repo.queryTimeline().items.map((item) => [item.id, item]));
  assert.equal(items.size, 3, '坏数据不能让整条时间线读不出来');
  assert.deepEqual(items.get('b').analysis.keywords, []);
  assert.deepEqual(items.get('c').analysis.keywords, []);
  assert.deepEqual(items.get('a').analysis.keywords, ['k']);
  // 其它字段照常返回，说明只有 keywords 退化了。
  assert.equal(items.get('c').analysis.activity, '活动 c');
  assert.equal(items.get('b').analysis.summary, '摘要 b');
});

test('Timeline 11：中文 / English / emoji / 特殊字符原样返回', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  repo.createActivity(makeRecord('s1', at(13, 30)));

  const emoji = '\u{1F600}\u{1F680}';
  const analysis = {
    activity: '正在浏览知乎学堂',
    summary: `GPU利用率 100%，AI 服务 <Ollama> 正在跑；emoji ${emoji} 也没问题。`,
    category: 'browsing',
    project: 'Life Lens 测试',
    keywords: ['中文', 'English', emoji, 'C:\\path\\to\\file'],
    confidence: 1,
  };
  repo.updateAnalysis('s1', { analysis, analysisStatus: 'COMPLETED' });

  const item = repo.queryTimeline().items[0];
  assert.deepEqual(item.analysis, analysis);
  assert.equal(item.analysis.keywords[2], emoji);
});

test('Timeline 12：IPC lifelens:timeline 返回时间线数据（预加载暴露的通道）', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  repo.createActivity(makeRecord('a', at(9)));
  repo.createActivity(makeRecord('b', at(10)));

  const ipcMain = fakeIpcMain();
  registerTimelineIpc({ ipcMain, activities: repo });

  // Phase 7.3 起同一个模块还注册筛选选项通道。
  assert.deepEqual([...ipcMain.handlers.keys()], [TIMELINE_CHANNEL, TIMELINE_FACETS_CHANNEL]);
  assert.equal(TIMELINE_CHANNEL, 'lifelens:timeline');

  const handler = ipcMain.handlers.get(TIMELINE_CHANNEL);
  const result = handler({}, { from: at(9, 30), limit: 5 });
  assert.deepEqual(result.items.map((item) => item.id), ['b']);
  assert.deepEqual(
    { total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore },
    { total: 1, limit: 5, offset: 0, hasMore: false },
  );
});

test('Timeline 13：IPC 参数缺失或为 null 时按默认查询处理', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  repo.createActivity(makeRecord('a', at(9)));

  const ipcMain = fakeIpcMain();
  registerTimelineIpc({ ipcMain, activities: repo });
  const handler = ipcMain.handlers.get(TIMELINE_CHANNEL);

  assert.equal(handler({}, undefined).items.length, 1);
  assert.equal(handler({}, null).items.length, 1);
  assert.equal(handler({}, '').items.length, 1);
  assert.equal(handler({}, { limit: 'abc' }).limit, 20);
});
