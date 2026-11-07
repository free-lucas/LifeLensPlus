'use strict';

const { formatLocalIso } = require('../time');
const { withTransaction } = require('../db/database');
const { buildActivityText } = require('./textBuilder/activityText');
const { buildBlockText } = require('./textBuilder/blockText');
const { buildDiaryText } = require('./textBuilder/diaryText');

// 三层记忆的 embedding 状态仓储（Phase 10）。SQL 只出现在 repository 层：
// 这一层负责把 activity / block / diary 的差异翻译成 SQL，上层只认统一的 row 对象。
//
// embedding_status 就是待办池，不另建队列表：
//   PENDING（待嵌入）-> PROCESSING（本批正在处理）-> COMPLETED（已入库）
//   构建不出文本的记录直接 FAILED（永久性，只能手动重置）。
const EMBEDDING_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

// JSON 数组列（keywords / software / todos / main_events）容错解析：坏数据退化成 []。
function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 三层记忆的全部差异都在这里：表名 / 主键 / 时间列 / 行 ID 前缀 / 「什么算分析完成」/ 文本构造。
// project / category 为 null 表示这一层没有该列（日记没有项目与分类）。
const LAYERS = Object.freeze({
  activity: {
    name: 'activity',
    table: 'activities',
    primaryKey: 'id',
    capturedAtColumn: 'captured_at',
    idPrefix: 'activity',
    // 只嵌入「分析已完成」的记录：还没拿到结构化结果的截图没有可嵌入的文本。
    completedCondition: 'analysis_status = \'COMPLETED\'',
    selectColumns: 'id, captured_at, activity, summary, category, project, keywords_json',
    projectColumn: 'project',
    categoryColumn: 'category',
    toText: (row) => buildActivityText({
      project: row.project,
      activity: row.activity,
      summary: row.summary,
      keywords: parseJsonArray(row.keywords_json),
    }),
  },
  block: {
    name: 'block',
    table: 'time_blocks',
    primaryKey: 'block_start',
    capturedAtColumn: 'block_start',
    idPrefix: 'block',
    completedCondition: 'status = \'COMPLETED\'',
    selectColumns: 'block_start, project, category, description, software_json, todos_json',
    projectColumn: 'project',
    categoryColumn: 'category',
    toText: (row) => buildBlockText({
      project: row.project,
      category: row.category,
      description: row.description,
      software: parseJsonArray(row.software_json),
      todos: parseJsonArray(row.todos_json),
    }),
  },
  diary: {
    name: 'diary',
    table: 'diaries',
    primaryKey: 'day',
    capturedAtColumn: 'day',
    idPrefix: 'diary',
    completedCondition: 'status = \'COMPLETED\'',
    selectColumns: 'day, summary, main_events_json',
    projectColumn: null,
    categoryColumn: null,
    toText: (row) => buildDiaryText({
      day: row.day,
      summary: row.summary,
      mainEvents: parseJsonArray(row.main_events_json),
    }),
  },
});

class EmbeddingSourceRepository {
  constructor({ db, layer, log = null, now = () => new Date() }) {
    const config = LAYERS[layer];
    if (!config) throw new Error(`未知的 embedding 层：${layer}`);

    this.db = db;
    this.layer = config;
    this.log = log;
    this.now = now;

    // 待办扫描：分析已完成 + 状态 PENDING，按时间从旧到新（先补历史存量）。
    this.selectPendingStatement = db.prepare(
      `SELECT ${config.selectColumns} FROM ${config.table}
        WHERE ${config.completedCondition} AND embedding_status = '${EMBEDDING_STATUS.PENDING}'
        ORDER BY ${config.capturedAtColumn} ASC, ${config.primaryKey} ASC
        LIMIT ?`,
    );
    // 一个批次最多几百行，逐行 UPDATE 比动态拼 IN (?, ?, ...) 更简单，也更安全。
    this.markProcessingStatement = db.prepare(
      `UPDATE ${config.table} SET embedding_status = '${EMBEDDING_STATUS.PROCESSING}', updated_at = ?
        WHERE ${config.primaryKey} = ?`,
    );
    this.markCompletedStatement = db.prepare(
      `UPDATE ${config.table}
          SET embedding_status = '${EMBEDDING_STATUS.COMPLETED}', embedding_model = ?, embedding_version = ?, updated_at = ?
        WHERE ${config.primaryKey} = ?`,
    );
    this.markFailedStatement = db.prepare(
      `UPDATE ${config.table} SET embedding_status = '${EMBEDDING_STATUS.FAILED}', updated_at = ?
        WHERE ${config.primaryKey} = ?`,
    );
    // 临时故障（模型掉线 / 写入失败）退回 PENDING：下一轮扫描会重新捡起来。
    this.markPendingStatement = db.prepare(
      `UPDATE ${config.table} SET embedding_status = '${EMBEDDING_STATUS.PENDING}', updated_at = ?
        WHERE ${config.primaryKey} = ?`,
    );
    // 启动补偿：进程崩溃时留下的 PROCESSING 一律退回 PENDING（与 ai_jobs 的恢复口径一致）。
    this.resetProcessingStatement = db.prepare(
      `UPDATE ${config.table} SET embedding_status = '${EMBEDDING_STATUS.PENDING}', updated_at = ?
        WHERE embedding_status = '${EMBEDDING_STATUS.PROCESSING}'`,
    );
    // 手动重置：FAILED 重试 / 整个索引重建。只改状态列，绝不修改原始数据。
    this.resetFailedStatement = db.prepare(
      `UPDATE ${config.table}
          SET embedding_status = '${EMBEDDING_STATUS.PENDING}', embedding_model = NULL, embedding_version = NULL, updated_at = ?
        WHERE embedding_status = '${EMBEDDING_STATUS.FAILED}'`,
    );
    this.resetAllStatement = db.prepare(
      `UPDATE ${config.table}
          SET embedding_status = '${EMBEDDING_STATUS.PENDING}', embedding_model = NULL, embedding_version = NULL, updated_at = ?`,
    );
    this.countByStatusStatement = db.prepare(
      `SELECT embedding_status AS status, COUNT(*) AS n FROM ${config.table} GROUP BY embedding_status`,
    );
    this.countCompletedStatement = db.prepare(
      `SELECT COUNT(*) AS n FROM ${config.table} WHERE ${config.completedCondition}`,
    );
  }

  // 数据库行 -> 统一的待嵌入记录：id / sourceId / capturedAt / date / project / category / text。
  // text 为空串表示这条记录构建不出可嵌入文本，由服务层标记 FAILED。
  toEmbeddingRow(row) {
    const { layer } = this;
    const capturedAt = String(row[layer.capturedAtColumn] ?? '');
    const sourceId = row[layer.primaryKey];
    return {
      id: `${layer.idPrefix}:${sourceId}`,
      sourceId,
      capturedAt,
      // 与 SQLite 的口径一致：时间字符串的前 10 个字符就是本地日期。
      date: capturedAt.slice(0, 10),
      project: layer.projectColumn ? row[layer.projectColumn] ?? null : null,
      category: layer.categoryColumn ? row[layer.categoryColumn] ?? null : null,
      text: layer.toText(row),
    };
  }

  // 取一批待嵌入记录（分析已完成、状态 PENDING）。
  listPending(limit) {
    const size = Math.max(1, Math.floor(Number(limit)) || 1);
    return this.selectPendingStatement.all(size).map((row) => this.toEmbeddingRow(row));
  }

  markProcessing(sourceIds) {
    return this._updateBatch(this.markProcessingStatement, sourceIds, []);
  }

  markCompleted(sourceIds, { model, version } = {}) {
    return this._updateBatch(this.markCompletedStatement, sourceIds, [model ?? null, version ?? null]);
  }

  markFailed(sourceIds) {
    return this._updateBatch(this.markFailedStatement, sourceIds, []);
  }

  markPending(sourceIds) {
    return this._updateBatch(this.markPendingStatement, sourceIds, []);
  }

  // 启动补偿：返回被退回 PENDING 的行数。
  resetProcessing() {
    return this.resetProcessingStatement.run(formatLocalIso(this.now())).changes;
  }

  resetFailed() {
    return this.resetFailedStatement.run(formatLocalIso(this.now())).changes;
  }

  resetAll() {
    return this.resetAllStatement.run(formatLocalIso(this.now())).changes;
  }

  countByStatus() {
    const counts = {
      [EMBEDDING_STATUS.PENDING]: 0,
      [EMBEDDING_STATUS.PROCESSING]: 0,
      [EMBEDDING_STATUS.COMPLETED]: 0,
      [EMBEDDING_STATUS.FAILED]: 0,
    };
    for (const row of this.countByStatusStatement.all()) {
      if (row.status in counts) counts[row.status] = Number(row.n) || 0;
    }
    counts.total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return counts;
  }

  // SQLite 侧「分析已完成」的行数：用来核对向量库是否补齐（验收标准 1）。
  countReady() {
    return Number(this.countCompletedStatement.get().n) || 0;
  }

  // 一批状态更新放在同一个事务里：一次 fsync，且不会留下改了一半的批次。
  _updateBatch(statement, sourceIds, leadingValues) {
    const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
    if (!ids.length) return 0;

    const now = formatLocalIso(this.now());
    return withTransaction(this.db, () => {
      let changes = 0;
      for (const id of ids) {
        changes += statement.run(...leadingValues, now, id).changes;
      }
      return changes;
    });
  }
}

module.exports = { EmbeddingSourceRepository, EMBEDDING_STATUS, LAYERS };
