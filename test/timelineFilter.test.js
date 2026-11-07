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

// 一份不含任何筛选关键词的默认结果；每条用例只覆盖自己关心的字段。
const ANALYZED = Object.freeze({
  activity: '写代码',
  summary: '正在写代码',
  category: 'coding',
  project: 'Life Lens',
  keywords: [],
  confidence: 0.9,
});

// 截图 + 结构化结果一次落库（COMPLETED）。overrides 覆盖默认结果里的字段。
function addAnalyzed(repo, id, date, overrides = {}) {
  repo.createActivity(makeRecord(id, date));
  repo.updateAnalysis(id, {
    analysisStatus: 'COMPLETED',
    analysis: { ...ANALYZED, ...overrides },
  });
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

test('筛选 1：关键词搜索命中 activity / summary / project / keywords 四列', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  addAnalyzed(repo, 'a', at(9), { activity: '正在写 SQLite 查询', summary: '查数据', project: 'P1', keywords: [] });
  addAnalyzed(repo, 'b', at(10), { activity: '写代码', summary: 'SQLite 索引调优', project: 'P1', keywords: [] });
  addAnalyzed(repo, 'c', at(11), { activity: '写代码', summary: '看文档', project: 'SQLite 项目', keywords: [] });
  addAnalyzed(repo, 'd', at(12), { activity: '写代码', summary: '看文档', project: 'P1', keywords: ['SQLite'] });
  addAnalyzed(repo, 'e', at(13), { activity: '写代码', summary: '看文档', project: 'P1', keywords: ['Ollama'] });

  assert.deepEqual(ids(repo.queryTimeline({ search: 'SQLite' })), ['d', 'c', 'b', 'a']);
  assert.equal(repo.queryTimeline({ search: 'SQLite' }).total, 4);
  // 关键词只在 keywords_json 里出现，也能命中。
  assert.deepEqual(ids(repo.queryTimeline({ search: 'Ollama' })), ['e']);
});

test('筛选 2：中文 / emoji / 大小写 / LIKE 通配符都被正确处理', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  addAnalyzed(repo, 'zh', at(9), { activity: '正在浏览知乎学堂', summary: '看回答', keywords: [] });
  addAnalyzed(repo, 'en', at(10), { activity: 'Watching YouTube', summary: '看视频', keywords: [] });
  addAnalyzed(repo, 'emoji', at(11), { summary: '状态正常 😀 无异常', keywords: [] });
  addAnalyzed(repo, 'pct', at(12), { summary: 'GPU 利用率 100% 卡住', keywords: [] });
  addAnalyzed(repo, 'pct2', at(13), { summary: 'GPU 利用率 1000 正常', keywords: [] });
  addAnalyzed(repo, 'under', at(14), { summary: '文件名 a_b 解析', keywords: [] });
  addAnalyzed(repo, 'under2', at(15), { summary: '文件名 axb 解析', keywords: [] });

  assert.deepEqual(ids(repo.queryTimeline({ search: '知乎' })), ['zh']);
  assert.deepEqual(ids(repo.queryTimeline({ search: '学堂' })), ['zh']);
  assert.deepEqual(ids(repo.queryTimeline({ search: 'zhihu' })), []);
  // ASCII 大小写不敏感（SQLite LIKE 默认行为）。
  assert.deepEqual(ids(repo.queryTimeline({ search: 'youtube' })), ['en']);
  assert.deepEqual(ids(repo.queryTimeline({ search: 'YOUTUBE' })), ['en']);
  assert.deepEqual(ids(repo.queryTimeline({ search: '😀' })), ['emoji']);
  // % 与 _ 是 LIKE 的通配符：转义后只按普通字符匹配。
  assert.deepEqual(ids(repo.queryTimeline({ search: '100%' })), ['pct']);
  assert.deepEqual(ids(repo.queryTimeline({ search: 'a_b' })), ['under']);
  assert.deepEqual(ids(repo.queryTimeline({ search: '_' })), ['under']);
  // 关键词里的反斜杠是转义字符本身，不能让它把后面的字符吃掉。
  assert.deepEqual(ids(repo.queryTimeline({ search: '\\' })), []);
});

test('筛选 3：时间范围与关键词叠加，边界是闭开区间', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  addAnalyzed(repo, 'nine', at(9), { summary: '任务 nine' });
  addAnalyzed(repo, 'ten', at(10), { summary: '任务 ten' });
  addAnalyzed(repo, 'eleven', at(11), { summary: '任务 eleven' });

  assert.deepEqual(ids(repo.queryTimeline({ from: at(10), to: at(11) })), ['ten']);
  assert.deepEqual(ids(repo.queryTimeline({ search: '任务', from: at(10) })), ['eleven', 'ten']);
  // 关键词 + 上界：eleven 被 to 排除，剩下 ten 与 nine。
  assert.deepEqual(ids(repo.queryTimeline({ search: '任务', to: at(11) })), ['ten', 'nine']);
  assert.deepEqual(ids(repo.queryTimeline({ search: '任务 eleven', to: at(11) })), []);
  assert.deepEqual(ids(repo.queryTimeline({ search: '任务', from: at(12) })), []);
});

test('筛选 4：Category 精确匹配，未分析的记录不会被分类筛出来', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  addAnalyzed(repo, 'code', at(9), { category: 'coding' });
  addAnalyzed(repo, 'learn', at(10), { category: 'learning' });
  addAnalyzed(repo, 'other', at(11), { category: 'other' });
  repo.createActivity(makeRecord('pending', at(12)));

  assert.deepEqual(ids(repo.queryTimeline({ category: 'coding' })), ['code']);
  assert.deepEqual(ids(repo.queryTimeline({ category: 'learning' })), ['learn']);
  // 精确匹配，不做前缀 / 子串。
  assert.deepEqual(ids(repo.queryTimeline({ category: 'cod' })), []);
  assert.deepEqual(ids(repo.queryTimeline({ category: '不存在' })), []);
  // 首尾空白收敛后仍然是同一个分类。
  assert.deepEqual(ids(repo.queryTimeline({ category: ' coding ' })), ['code']);
});

test('筛选 5：Project 精确匹配，project 为 NULL / 空串都算「无项目」', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  addAnalyzed(repo, 'lens', at(9), { project: 'Life Lens' });
  addAnalyzed(repo, 'ollama', at(10), { project: 'Ollama' });
  addAnalyzed(repo, 'none', at(11), { project: null });
  addAnalyzed(repo, 'blank', at(12), { project: '' });
  repo.createActivity(makeRecord('pending', at(13)));

  assert.deepEqual(ids(repo.queryTimeline({ project: 'Life Lens' })), ['lens']);
  assert.deepEqual(ids(repo.queryTimeline({ project: '不存在' })), []);
  // 无项目 = NULL 或空串，未分析的记录（project 也是 NULL）同样算在里面。
  assert.deepEqual(ids(repo.queryTimeline({ noProject: true })), ['pending', 'blank', 'none']);
  // 两个条件互斥，同时传时以 noProject 为准。
  assert.deepEqual(ids(repo.queryTimeline({ project: 'Life Lens', noProject: true })), ['pending', 'blank', 'none']);
  // 只有 noProject 严格等于 true 才生效。
  assert.deepEqual(ids(repo.queryTimeline({ noProject: false })), ['pending', 'blank', 'none', 'ollama', 'lens']);
});

test('筛选 6：AI 状态三档（已完成 / 分析中 / 失败）', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  addAnalyzed(repo, 'done', at(9));
  repo.createActivity(makeRecord('pending', at(10)));
  repo.createActivity(makeRecord('processing', at(11)));
  repo.updateAnalysis('processing', { analysisStatus: 'PROCESSING' });
  repo.createActivity(makeRecord('failed', at(12)));
  repo.updateAnalysis('failed', { analysisStatus: 'FAILED', error: '请求超时', errorCode: 'AI_TIMEOUT' });

  assert.deepEqual(ids(repo.queryTimeline({ status: 'COMPLETED' })), ['done']);
  assert.deepEqual(ids(repo.queryTimeline({ status: 'FAILED' })), ['failed']);
  // 「分析中」涵盖 PENDING / PROCESSING 这些中间状态。
  assert.deepEqual(ids(repo.queryTimeline({ status: 'PENDING' })), ['processing', 'pending']);
  assert.deepEqual(ids(repo.queryTimeline({ status: ' pending ' })), ['processing', 'pending']);
  assert.deepEqual(ids(repo.queryTimeline({ status: 'FaiLed' })), ['failed']);
  // 认不出来的状态不加条件。
  assert.equal(repo.queryTimeline({ status: '什么状态' }).total, 4);
  assert.equal(repo.queryTimeline({ status: null }).total, 4);
});

test('筛选 7：时间 + 分类 + 项目 + 关键词多条件同时生效', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  const inRange = (day, hour) => new Date(2026, 8, day, hour);
  // 完全命中：范围内 + coding + Life Lens + 关键词 SQLite。
  addAnalyzed(repo, 'hit', inRange(11, 10), { category: 'coding', project: 'Life Lens', summary: '调 SQLite 索引' });
  // 只差时间（10 天前）。
  addAnalyzed(repo, 'old', inRange(1, 10), { category: 'coding', project: 'Life Lens', summary: '调 SQLite 索引' });
  // 只差分类。
  addAnalyzed(repo, 'cat', inRange(11, 11), { category: 'learning', project: 'Life Lens', summary: '调 SQLite 索引' });
  // 只差项目。
  addAnalyzed(repo, 'proj', inRange(11, 12), { category: 'coding', project: 'Ollama', summary: '调 SQLite 索引' });
  // 只差关键词。
  addAnalyzed(repo, 'kw', inRange(11, 13), { category: 'coding', project: 'Life Lens', summary: '看文档' });

  const query = {
    from: inRange(5, 0),
    to: inRange(12, 0),
    search: 'SQLite',
    category: 'coding',
    project: 'Life Lens',
  };
  assert.deepEqual(ids(repo.queryTimeline(query)), ['hit']);
  assert.equal(repo.queryTimeline(query).total, 1);

  // 少一个条件，命中集合随之变大：说明每个条件都真的参与了过滤。
  assert.deepEqual(ids(repo.queryTimeline({ ...query, search: '' })), ['kw', 'hit']);
  assert.deepEqual(ids(repo.queryTimeline({ ...query, category: '' })), ['cat', 'hit']);
  assert.deepEqual(ids(repo.queryTimeline({ ...query, project: '' })), ['proj', 'hit']);
  assert.deepEqual(ids(repo.queryTimeline({ ...query, from: null, to: null })), ['hit', 'old']);
});

test('筛选 8：空搜索与非法筛选值等于不筛（时间 / 分页行为不变）', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  addAnalyzed(repo, 'a', at(9));
  repo.createActivity(makeRecord('b', at(10)));
  const all = ids(repo.queryTimeline());
  assert.deepEqual(all, ['b', 'a']);

  for (const search of ['', '   ', null, undefined, 123, {}, []]) {
    assert.deepEqual(ids(repo.queryTimeline({ search })), all, `search=${String(search)} 不应筛选`);
  }
  assert.deepEqual(ids(repo.queryTimeline({ category: '' })), all);
  assert.deepEqual(ids(repo.queryTimeline({ category: null })), all);
  assert.deepEqual(ids(repo.queryTimeline({ project: '   ' })), all);
  assert.deepEqual(ids(repo.queryTimeline({ status: '' })), all);
  assert.deepEqual(ids(repo.queryTimeline({ noProject: 'yes' })), all);

  // 关键词首尾空白不影响命中。
  assert.deepEqual(ids(repo.queryTimeline({ search: '  写代码  ' })), ['a']);
  // 只筛状态时，其它参数仍是默认值。
  const page = repo.queryTimeline({ status: 'COMPLETED' });
  assert.deepEqual({ limit: page.limit, offset: page.offset }, { limit: 20, offset: 0 });
});

test('筛选 9：没有命中的组合返回空列表（不是报错）', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);
  addAnalyzed(repo, 'a', at(9));

  assert.deepEqual(repo.queryTimeline({ search: '不存在的关键词' }), {
    items: [],
    total: 0,
    limit: 20,
    offset: 0,
    hasMore: false,
  });
  assert.deepEqual(repo.queryTimeline({ category: 'coding', project: '不存在' }).items, []);
  assert.equal(repo.queryTimeline({ search: '写代码', status: 'FAILED' }).total, 0);
});

test('筛选 10：筛选条件下分页 / 加载更多，total 与 hasMore 都按筛选后计算', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  for (let i = 1; i <= 5; i += 1) {
    addAnalyzed(repo, `m${i}`, at(8 + i), { summary: `SQLite 任务 ${i}` });
  }
  for (let i = 1; i <= 3; i += 1) {
    addAnalyzed(repo, `n${i}`, at(16 + i), { summary: `无关任务 ${i}` });
  }

  const first = repo.queryTimeline({ search: 'SQLite', limit: 2 });
  assert.deepEqual(ids(first), ['m5', 'm4']);
  assert.deepEqual(
    { total: first.total, limit: first.limit, offset: first.offset, hasMore: first.hasMore },
    { total: 5, limit: 2, offset: 0, hasMore: true },
  );

  const second = repo.queryTimeline({ search: 'SQLite', limit: 2, offset: 2 });
  assert.deepEqual(ids(second), ['m3', 'm2']);
  assert.equal(second.hasMore, true);

  const third = repo.queryTimeline({ search: 'SQLite', limit: 2, offset: 4 });
  assert.deepEqual(ids(third), ['m1']);
  assert.equal(third.hasMore, false);

  // 逐页取完 = 一次取完，不重不漏。
  const paged = [...ids(first), ...ids(second), ...ids(third)];
  assert.deepEqual(paged, ids(repo.queryTimeline({ search: 'SQLite', limit: 10 })));

  // 越界 offset：空页，但总数仍是筛选后的真实值。
  const beyond = repo.queryTimeline({ search: 'SQLite', limit: 2, offset: 10 });
  assert.deepEqual(ids(beyond), []);
  assert.equal(beyond.total, 5);
  assert.equal(beyond.hasMore, false);

  // 筛选 + 时间范围 + 分页叠加。
  const ranged = repo.queryTimeline({ search: 'SQLite', from: at(10), limit: 1, offset: 1 });
  assert.deepEqual(ids(ranged), ['m4']);
  assert.equal(ranged.total, 4);
});

test('筛选 11：listFacets 返回已有数据里的分类 / 项目，并标记是否存在无项目记录', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  assert.deepEqual(repo.listFacets(), {
    categories: [],
    projects: [],
    hasUnassignedProject: false,
  });

  addAnalyzed(repo, 'a', at(9), { category: 'learning', project: 'Ollama' });
  addAnalyzed(repo, 'b', at(10), { category: 'coding', project: 'Life Lens' });
  addAnalyzed(repo, 'c', at(11), { category: 'coding', project: null });
  addAnalyzed(repo, 'd', at(12), { category: 'coding', project: '' });
  // 未分析的记录没有任何分类 / 项目，只影响 hasUnassignedProject。
  repo.createActivity(makeRecord('pending', at(13)));

  assert.deepEqual(repo.listFacets(), {
    categories: ['coding', 'learning'],
    projects: ['Life Lens', 'Ollama'],
    hasUnassignedProject: true,
  });

  // 全部记录都有项目后，「无项目」这一项消失。
  for (const id of ['c', 'd', 'pending']) {
    repo.updateAnalysis(id, { analysis: { ...ANALYZED, project: 'Ollama' } });
  }
  assert.equal(repo.listFacets().hasUnassignedProject, false);
});

test('筛选 12：IPC 契约（筛选查询与筛选选项两个通道）', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const { repo } = makeRepo(dir);

  addAnalyzed(repo, 'a', at(9), { category: 'coding', project: 'Life Lens', summary: '调 SQLite' });
  repo.createActivity(makeRecord('b', at(10)));

  const ipcMain = fakeIpcMain();
  registerTimelineIpc({ ipcMain, activities: repo });

  assert.equal(TIMELINE_CHANNEL, 'lifelens:timeline');
  assert.equal(TIMELINE_FACETS_CHANNEL, 'lifelens:timeline-facets');
  assert.deepEqual([...ipcMain.handlers.keys()], [TIMELINE_CHANNEL, TIMELINE_FACETS_CHANNEL]);

  const timeline = ipcMain.handlers.get(TIMELINE_CHANNEL);
  const filtered = timeline({}, { search: 'SQLite', category: 'coding', status: 'COMPLETED' });
  assert.deepEqual(filtered.items.map((item) => item.id), ['a']);
  assert.equal(filtered.total, 1);

  // 参数缺失 / null / 空对象 / 空字符串都按默认查询处理。
  for (const query of [undefined, null, {}, '']) {
    assert.equal(timeline({}, query).items.length, 2);
    assert.equal(timeline({}, query).limit, 20);
  }

  const facets = ipcMain.handlers.get(TIMELINE_FACETS_CHANNEL);
  assert.deepEqual(facets({}), {
    categories: ['coding'],
    projects: ['Life Lens'],
    hasUnassignedProject: true,
  });
});
