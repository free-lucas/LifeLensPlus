'use strict';

const fs = require('node:fs');

// LanceDB 连接与表句柄的薄封装（Phase 10）。
//
// 两点约定：
// 1. 原生模块按需加载：@lancedb/lancedb 缺失或与本机 ABI 不兼容时只抛错，
//    绝不在 require 阶段把整个应用拖下水（铁律二：Embedding 不阻塞主链路）。
// 2. 表句柄在这里缓存：批量写入时不必每次都去列一遍目录，表名是固定常量，不会变。
class LanceStore {
  constructor({ dir, log = null }) {
    this.dir = dir;
    this.log = log;
    this.db = null;
    this.tables = new Map();
  }

  async open() {
    if (this.db) return this.db;
    // LanceDB 通常会自动建目录，这里显式建好，顺便让权限问题在读表之前暴露。
    fs.mkdirSync(this.dir, { recursive: true });
    const lancedb = require('@lancedb/lancedb');
    this.db = await lancedb.connect(this.dir);
    this.log?.(`LanceDB opened: ${this.dir}`);
    return this.db;
  }

  // 已存在的表返回句柄，不存在返回 null（调用方决定是建表还是跳过）。
  async openTable(name) {
    const cached = this.tables.get(name);
    if (cached) return cached;

    const db = await this.open();
    const names = await db.tableNames();
    if (!names.includes(name)) return null;

    const table = await db.openTable(name);
    this.tables.set(name, table);
    return table;
  }

  // 用第一批数据建表：向量维度由这一批数据确定，之后所有行必须同维度。
  async createTable(name, rows) {
    const db = await this.open();
    const table = await db.createTable(name, rows);
    this.tables.set(name, table);
    this.log?.(`LanceDB table created: ${name}`);
    return table;
  }

  // IVF_PQ 索引配置由 store 构造：存储层之外的模块不需要 require 原生模块。
  ivfPq(options) {
    const { Index } = require('@lancedb/lancedb');
    return Index.ivfPq(options);
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (error) {
      this.log?.(`LanceDB close failed: ${error.message}`);
    }
    this.db = null;
    this.tables.clear();
  }
}

module.exports = { LanceStore };
