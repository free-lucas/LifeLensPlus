'use strict';

// 一张向量表的统一仓储（Phase 10）：activity / block / diary 三张表各实例化一个。
// LanceDB 的读写只出现在这一层，与「SQL 只出现在 repository 层」是同一个约定。

// 行数低于阈值走暴力扫描（延迟可接受，且小数据集上 ANN 反而不准），
// 到阈值以上才建 IVF_PQ 索引。阈值可由调用方覆盖：测试里灌 5 万行不现实。
const DEFAULT_INDEX_THRESHOLD = 5000;
const DEFAULT_SEARCH_LIMIT = 10;

// LanceDB 的过滤条件是 SQL 片段，字符串值里的单引号要写成两个单引号。
const SINGLE_QUOTE = '\u0027';

function quote(value) {
  const text = String(value).split(SINGLE_QUOTE).join(SINGLE_QUOTE + SINGLE_QUOTE);
  return SINGLE_QUOTE + text + SINGLE_QUOTE;
}

// IVF_PQ 的 num_sub_vectors 必须能整除向量维度，否则建索引会失败：
// 从 dim / 64 往下找到第一个能整除的因子（1024 -> 16，768 -> 12）；维度未知时交给 LanceDB 自己决定。
function subVectorCount(dimension) {
  if (!(Number(dimension) > 0)) return 0;
  let count = Math.max(2, Math.floor(Number(dimension) / 64));
  while (count > 1 && Number(dimension) % count !== 0) count -= 1;
  return count;
}

class MemoryVectorRepository {
  constructor({ store, tableName, log = null, indexThreshold = DEFAULT_INDEX_THRESHOLD }) {
    this.store = store;
    this.tableName = tableName;
    this.log = log;
    this.indexThreshold = Math.max(1, Math.floor(indexThreshold) || DEFAULT_INDEX_THRESHOLD);
  }

  // 按 id 覆盖写入（批量）：表不存在时用这一批建表，否则走 merge insert。
  // 同一条记录重复嵌入只会覆盖同一行，不会产生重复（验收标准 4）。
  async upsert(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;

    const existing = await this.store.openTable(this.tableName);
    if (!existing) {
      await this.store.createTable(this.tableName, list);
      return list.length;
    }

    await existing
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(list);
    return list.length;
  }

  // 按行 ID 删除（id 形如 activity:123 / block:2026-09-17T10:00:00+08:00 / diary:2026-09-17）。
  async deleteBySource(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => id !== null && id !== undefined);
    if (!list.length) return 0;

    const table = await this.store.openTable(this.tableName);
    if (!table) return 0;

    await table.delete(`id IN (${list.map(quote).join(', ')})`);
    return list.length;
  }

  // 查单条（校验是否已入库）：没有表或没有这一行都返回 null。
  async findBySource(id) {
    const table = await this.store.openTable(this.tableName);
    if (!table) return null;

    const rows = await table.query().where(`id = ${quote(id)}`).limit(1).toArray();
    return rows[0] ?? null;
  }

  async count() {
    const table = await this.store.openTable(this.tableName);
    if (!table) return 0;
    return table.countRows();
  }

  // 行数达标且还没有向量索引时创建 IVF_PQ；已经有索引就跳过（每次批量写入后调用是幂等的）。
  // 建索引失败只记日志：索引是加速手段，不能因为索引建不出来就让写入结果作废。
  async ensureIndex(dimension = 0) {
    const table = await this.store.openTable(this.tableName);
    if (!table) return { created: false, reason: 'no-table', count: 0 };

    const count = await table.countRows();
    if (count < this.indexThreshold) return { created: false, reason: 'below-threshold', count };

    const indices = await table.listIndices();
    if (indices.some((index) => (index.columns ?? []).includes('vector'))) {
      return { created: false, reason: 'exists', count };
    }

    const options = { numPartitions: Math.max(2, Math.floor(Math.sqrt(count))) };
    const numSubVectors = subVectorCount(dimension);
    if (numSubVectors > 0) options.numSubVectors = numSubVectors;

    try {
      await table.createIndex('vector', { config: this.store.ivfPq(options) });
      this.log?.(`LanceDB index created: ${this.tableName} (${count} rows)`);
      return { created: true, count };
    } catch (error) {
      this.log?.(`LanceDB index failed: ${this.tableName} (${count} rows): ${error.message}`);
      return { created: false, reason: 'error', count, error: error.message };
    }
  }

  // 最简向量检索（Phase 10 只用于验证链路；跨表聚合检索是 Phase 11 的事）。
  // filter 是 LanceDB 的下推条件，例如 project = 'Life Lens' 或 date >= '2026-09-01'。
  async search(vector, { limit = DEFAULT_SEARCH_LIMIT, filter = null } = {}) {
    const table = await this.store.openTable(this.tableName);
    if (!table) return [];

    const size = Math.max(1, Math.floor(Number(limit)) || DEFAULT_SEARCH_LIMIT);
    const query = table.search(vector).limit(size);
    const filtered = filter ? query.where(filter) : query;
    return filtered.toArray();
  }
}

module.exports = { MemoryVectorRepository, DEFAULT_INDEX_THRESHOLD, subVectorCount };
