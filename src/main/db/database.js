'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { migrate } = require('./migrations');

const DB_FILE_NAME = 'lifelens.db';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function defaultLog(message) {
  console.log(`[DB] ${message}`);
}

// 打开（必要时创建）主数据库：目录 -> PRAGMA -> schema migration。
// 只在 Electron Main Process 调用，Renderer 永远不碰数据库（第 34 节）。
function openDatabase({ file, log = defaultLog, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  // 外键约束默认是关的，必须每个连接显式打开。
  db.exec('PRAGMA foreign_keys = ON');
  // WAL：崩溃/断电后仍能恢复到一致状态，且读写不互相阻塞。
  // synchronous 保持 SQLite 默认（FULL），不为性能牺牲 durability。
  db.prepare('PRAGMA journal_mode = WAL').get();
  // 本地单写入者；偶发的锁竞争等待而不是立刻报 SQLITE_BUSY。
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);

  log(`Database opened: ${file}`);
  try {
    const { to, applied } = migrate(db, { log });
    if (applied > 0) log('Schema initialized');
    log(`Schema version: ${to}`);
  } catch (error) {
    // 初始化失败就把连接关掉，不要把文件一直占着。
    try {
      db.close();
    } catch {
      // 关不上也不影响抛出原始错误。
    }
    throw error;
  }
  return db;
}

function closeDatabase(db, { log = defaultLog } = {}) {
  if (!db) return;
  try {
    // close() 会顺带 checkpoint WAL，避免 -wal 文件长期膨胀。
    db.close();
  } catch (error) {
    log(`Database close failed: ${error.message}`);
    return;
  }
  log('Database closed');
}

// 单事务执行：要么整体提交，要么整体回滚。
// BEGIN IMMEDIATE 直接拿写锁，避免先读后写时升级锁失败。
function withTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务可能已经被 SQLite 自己回滚（例如约束错误），这里不再覆盖原始异常。
    }
    throw error;
  }
}

module.exports = { openDatabase, closeDatabase, withTransaction, DB_FILE_NAME, DEFAULT_BUSY_TIMEOUT_MS };
