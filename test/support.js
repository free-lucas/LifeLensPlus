'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, DB_FILE_NAME } = require('../src/main/db/database');
const { ActivityRepository } = require('../src/main/db/repositories/ActivityRepository');
const { AIJobRepository } = require('../src/main/db/repositories/AIJobRepository');
const { TimeBlockRepository } = require('../src/main/db/repositories/TimeBlockRepository');
const { DiaryRepository } = require('../src/main/db/repositories/DiaryRepository');
const { StatsRepository } = require('../src/main/db/repositories/StatsRepository');
const { AIJobQueueService } = require('../src/main/ai/AIJobQueueService');
const { JobEventLog } = require('../src/main/ai/jobEventLog');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lifelens-test-'));
}

// 测试里不需要看日志输出，但需要事件记录。
function silentLog() {
  return new JobEventLog({ sink: { log() {} } });
}

// 测试打开的数据库统一登记：cleanup 时先关库再删目录
// （Windows 上 SQLite 还占着文件时删不掉临时目录）。
const openDbs = new Set();

// 所有测试都用临时目录里的数据库文件，绝不碰真实用户数据库。
function openTestDb(dir) {
  const db = openDatabase({ file: path.join(dir, DB_FILE_NAME), log: () => {} });
  openDbs.add(db);
  return db;
}

function closeTestDbs() {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // 已经关过或连接已断开，收尾阶段不再抛错。
    }
  }
  openDbs.clear();
}

// 直接 openDatabase 的用例用它登记连接，收尾时同样会被关闭。
function trackDb(db) {
  openDbs.add(db);
  return db;
}

// db / activities / timeBlocks / diaries 可以传进来复用：模拟「进程重启」时在同一个数据库上重建队列。
async function makeQueue({
  dir, retryDelaysMs = [5, 5, 5], db = null, activities = null, timeBlocks = null, diaries = null, ...rest
} = {}) {
  const base = dir || (await tempDir());
  const log = silentLog();
  const connection = db || openTestDb(base);
  const activityRepo = activities || new ActivityRepository({ db: connection, log });
  const blockRepo = timeBlocks || new TimeBlockRepository({ db: connection, log });
  const diaryRepo = diaries || new DiaryRepository({ db: connection, log });
  const statsRepo = new StatsRepository({ db: connection, log });
  const repository = new AIJobRepository({ db: connection, activities: activityRepo, log });
  const queue = new AIJobQueueService({
    repository,
    activities: activityRepo,
    timeBlocks: blockRepo,
    diaries: diaryRepo,
    log,
    retryDelaysMs,
    ...rest,
  });
  return {
    queue,
    repository,
    activities: activityRepo,
    timeBlocks: blockRepo,
    diaries: diaryRepo,
    stats: statsRepo,
    db: connection,
    log,
    dir: base,
  };
}

// 一份合法的结构化结果：假 Provider 默认返回它。
const FAKE_ANALYSIS = Object.freeze({
  activity: '模拟活动',
  summary: '模拟分析结果',
  category: 'other',
  project: null,
  keywords: ['模拟'],
  confidence: 0.5,
});

// 假的 AI Provider：analyze/health 都可以按需替换。
function fakeProvider({ analyze, health, analysis = FAKE_ANALYSIS } = {}) {
  const provider = {
    model: 'fake-model',
    analyzeCalls: 0,
    healthCalls: 0,
    async health() {
      provider.healthCalls += 1;
      if (typeof health === 'function') return health();
      return health || { online: true, modelAvailable: true };
    },
    async analyze(job) {
      provider.analyzeCalls += 1;
      if (analyze) return analyze(job, provider.analyzeCalls);
      return { analysis, logLine: 'category=other', model: 'fake-model', analysisMs: 1 };
    },
  };
  return provider;
}

// 假的 embedding Provider（Phase 10）：health / embedTexts 都可以按需替换。
// 向量只是「文本长度 + 固定尾巴」，够用来验证编排与状态流转，不追求语义。
function fakeEmbeddingProvider(options = {}) {
  const provider = {
    model: 'fake-embed',
    version: 'v1',
    dimension: 0,
    available: true,
    error: null,
    calls: [],
    healthCalls: 0,
    async health() {
      provider.healthCalls += 1;
      return { online: provider.available, modelAvailable: provider.available, message: 'fake' };
    },
    async embedTexts(texts) {
      provider.calls.push(texts.slice());
      if (provider.error) throw provider.error;
      const dimension = provider.dimension || 4;
      provider.dimension = dimension;
      return texts.map((text) => [text.length, ...Array.from({ length: dimension - 1 }, (_, index) => index)]);
    },
  };
  return Object.assign(provider, options);
}

// 假的截图模块：每帧都不同，不会被相似度过滤掉。
function fakeCapture() {
  let frame = 0;
  return {
    capturePrimaryDisplay: async () => {
      frame += 1;
      return { image: { toPNG: () => Buffer.from(`frame-${frame}`) }, display: { id: 1 } };
    },
    // 每帧返回一个新数组，引用不同 -> isSimilarFrame 判定为「不相似」。
    frameSignature: () => new Uint8ClampedArray([frame, frame + 1, frame + 2]),
    isSimilarFrame: (a, b) => a === b,
  };
}

async function waitFor(check, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Windows 上后台还在写文件时删目录会 ENOTEMPTY，这里等落盘并重试。
async function removeDir(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

// 统一的测试收尾：先停掉后台循环，等落盘结束，关掉数据库，再删临时目录。
function cleanup(t, dir, items = []) {
  t.after(async () => {
    for (const item of items) {
      try {
        if (item && typeof item.stop === 'function') await item.stop({ timeoutMs: 200 });
      } catch {
        // 收尾失败不影响测试结论。
      }
    }
    for (const item of items) {
      try {
        if (item && typeof item.flush === 'function') await item.flush();
      } catch {
        // 同上。
      }
    }
    closeTestDbs();
    if (dir) await removeDir(dir);
  });
}

module.exports = {
  tempDir,
  silentLog,
  openTestDb,
  trackDb,
  makeQueue,
  fakeProvider,
  fakeEmbeddingProvider,
  fakeCapture,
  waitFor,
  removeDir,
  cleanup,
  FAKE_ANALYSIS,
};
