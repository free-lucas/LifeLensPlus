'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { openDatabase, closeDatabase, DB_FILE_NAME } = require('../src/main/db/database');
const { SCHEMA_VERSION, MIGRATIONS } = require('../src/main/db/schema');
const { currentVersion } = require('../src/main/db/migrations');
const { tempDir, cleanup, openTestDb, trackDb, makeQueue } = require('./support');

const INDEXES = [
  'idx_activities_captured_at',
  'idx_activities_analysis_status',
  'idx_ai_jobs_status',
  'idx_ai_jobs_activity_id',
  'idx_time_blocks_status',
  'idx_diaries_status',
];

function objectNames(db, type) {
  return db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type).map((row) => row.name);
}

test('Test 1：打开数据库会创建文件、schema 与两张核心表', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const file = path.join(dir, DB_FILE_NAME);
  assert.equal(fs.existsSync(file), false, '打开之前没有数据库文件');

  const db = openTestDb(dir);
  assert.ok(fs.existsSync(file), '数据库文件已创建');

  const tables = objectNames(db, 'table');
  assert.ok(tables.includes('activities'), 'activities 表存在');
  assert.ok(tables.includes('ai_jobs'), 'ai_jobs 表存在');
  assert.ok(tables.includes('time_blocks'), 'time_blocks 表存在（Phase 8）');
  assert.ok(tables.includes('diaries'), 'diaries 表存在（Phase 9）');

  const indexes = objectNames(db, 'index');
  for (const index of INDEXES) assert.ok(indexes.includes(index), `${index} 索引存在`);

  // 每个连接都必须显式打开外键，并启用 WAL 与 busy_timeout。
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.ok(db.prepare('PRAGMA busy_timeout').get().timeout > 0);
});

test('Test 2：PRAGMA user_version 记录 schema 版本，重复打开不会重跑 migration', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const file = path.join(dir, DB_FILE_NAME);

  const first = trackDb(openDatabase({ file, log: () => {} }));
  assert.equal(currentVersion(first), SCHEMA_VERSION);
  assert.equal(first.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  closeDatabase(first, { log: () => {} });

  const logs = [];
  const second = trackDb(openDatabase({ file, log: (message) => logs.push(message) }));
  assert.equal(currentVersion(second), SCHEMA_VERSION);
  assert.ok(!logs.some((message) => message.includes('migrated')), '版本已是最新时不重复执行 migration');
  assert.ok(logs.includes(`Schema version: ${SCHEMA_VERSION}`));
});

test('schema 版本高于当前程序支持时直接报错，不猜测结构', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const file = path.join(dir, DB_FILE_NAME);
  const db = trackDb(openDatabase({ file, log: () => {} }));
  db.exec('PRAGMA user_version = 99');
  closeDatabase(db, { log: () => {} });

  assert.throws(() => openDatabase({ file, log: () => {} }), /高于当前程序支持的/);
});

test('Test 3：Phase 8 时代的库（v2）升级到当前版本时补上新表与新列，原有数据保留', async (t) => {
  const dir = await tempDir();
  cleanup(t, dir);
  const file = path.join(dir, DB_FILE_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // 手工造一个 v2 的库：只跑前两版 migration，再写一条区块（模拟老用户的现状）。
  const legacy = new DatabaseSync(file);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 2)) {
    for (const statement of migration.statements) legacy.exec(statement);
  }
  legacy.exec('PRAGMA user_version = 2');
  legacy.prepare(
    `INSERT INTO time_blocks
       (block_start, block_end, status, activity_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    '2026-09-14T09:50:00+08:00',
    '2026-09-14T10:00:00+08:00',
    'COMPLETED',
    3,
    '2026-09-14T10:00:01+08:00',
    '2026-09-14T10:00:01+08:00',
  );
  legacy.close();

  assert.equal(SCHEMA_VERSION, 4);
  const db = trackDb(openDatabase({ file, log: () => {} }));
  assert.equal(currentVersion(db), SCHEMA_VERSION);
  assert.ok(objectNames(db, 'table').includes('diaries'), '升级后补上 diaries 表');
  assert.ok(objectNames(db, 'index').includes('idx_diaries_status'), '升级后补上 diaries 索引');
  // Phase 10：三张表各补三列 embedding 状态，老数据随默认值进入待嵌入队列。
  const columns = db.prepare('PRAGMA table_info(time_blocks)').all().map((row) => row.name);
  for (const column of ['embedding_status', 'embedding_model', 'embedding_version']) {
    assert.ok(columns.includes(column), `升级后补上 ${column} 列`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM time_blocks').get().n, 1, '老数据留在库里');
  assert.equal(
    db.prepare('SELECT embedding_status FROM time_blocks').get().embedding_status,
    'PENDING',
    '存量记录初始化为 PENDING',
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('Test 12：PRAGMA integrity_check = ok', async (t) => {
  const dir = await tempDir();
  const { queue, activities, db } = await makeQueue({ dir });
  cleanup(t, dir, [queue]);
  await queue.start();

  for (let i = 0; i < 20; i += 1) {
    await queue.enqueueWithActivity({
      id: `shot-${i}`,
      time: `2026-09-13T10:${String(i).padStart(2, '0')}:00+08:00`,
      imagePath: `C:/tmp/shot-${i}.png`,
      model: 'fake-model',
      analysisStatus: 'PENDING',
      analysisMs: null,
      error: null,
      errorCode: null,
      analysis: null,
    });
  }
  activities.updateAnalysis('shot-3', {
    analysisStatus: 'COMPLETED',
    analysis: {
      activity: '写代码',
      summary: '写代码',
      category: 'coding',
      project: null,
      keywords: ['代码'],
      confidence: 0.6,
    },
  });
  await queue.flush();

  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('Test 13：ai_jobs.activity_id 指向不存在的 Activity 会被外键拒绝', async (t) => {
  const dir = await tempDir();
  const { activities, db } = await makeQueue({ dir });
  cleanup(t, dir);

  const activityId = activities.createActivity({
    id: 'shot-1',
    time: '2026-09-13T10:00:00+08:00',
    imagePath: 'C:/tmp/shot-1.png',
    model: 'fake-model',
    analysisStatus: 'PENDING',
    analysis: null,
  });
  assert.ok(activityId > 0);

  const insertJob = db.prepare(
    'INSERT INTO ai_jobs (id, type, status, priority, retry_count, max_retries, created_at, updated_at, activity_id)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const values = (id, foreignId) => [
    id, 'SCREENSHOT_ANALYSIS', 'PENDING', 5, 0, 3,
    '2026-09-13T10:00:00+08:00', '2026-09-13T10:00:00+08:00', foreignId,
  ];

  insertJob.run(...values('job-ok', activityId));
  assert.throws(() => insertJob.run(...values('job-bad', 99999)), /FOREIGN KEY/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
