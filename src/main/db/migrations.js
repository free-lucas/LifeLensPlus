'use strict';

const { SCHEMA_VERSION, MIGRATIONS } = require('./schema');

function currentVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row.user_version) || 0;
}

// 轻量 migration runner：按 user_version 找到还没跑过的版本，逐个执行。
// 每一版都在一个事务里完成（DDL 与 user_version 一起提交），失败整体回滚，
// 下一次启动会从同一个版本重新开始，不会留下半套 schema。
function migrate(db, { log = null } = {}) {
  const from = currentVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(`数据库 schema 版本 ${from} 高于当前程序支持的 ${SCHEMA_VERSION}`);
  }

  let applied = 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    if (!Number.isInteger(migration.version)) {
      throw new Error(`非法的 migration version：${migration.version}`);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) db.exec(statement);
      // user_version 不接受绑定参数，这里的值只来自代码里的常量，已校验为整数。
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    applied += 1;
    log?.(`Schema migrated to version ${migration.version}`);
  }

  return { from, to: currentVersion(db), applied };
}

module.exports = { migrate, currentVersion };
