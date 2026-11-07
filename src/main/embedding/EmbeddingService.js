'use strict';

const { formatLocalIso } = require('../time');
const { EVENTS } = require('../ai/jobEventLog');
const { ERROR_CODES } = require('../ai/errors');

// 三层记忆的 embedding 编排（Phase 10）。
// 定时扫描 SQLite 的待办池 -> 批量嵌入 -> 按 id upsert 进 LanceDB -> 回写状态。
// 与 Recorder / TimeBlockSummarizer 的分工一致：它只做编排，
// SQL 在 EmbeddingSourceRepository，向量读写在 MemoryVectorRepository。
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_SCAN_INTERVAL_MS = 60000;
// 一轮扫描最多连续处理多少批：首次启动的存量补齐与「删库重建」不必等几十个轮次。
const DEFAULT_MAX_BATCHES_PER_SCAN = 10;

class EmbeddingService {
  constructor({
    provider,
    sources,
    vectors,
    log = null,
    batchSize = DEFAULT_BATCH_SIZE,
    scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
    maxBatchesPerScan = DEFAULT_MAX_BATCHES_PER_SCAN,
    now = () => new Date(),
  }) {
    this.provider = provider;
    this.sources = sources;
    this.vectors = vectors;
    this.log = log;
    this.batchSize = Math.max(1, Math.floor(batchSize) || DEFAULT_BATCH_SIZE);
    this.scanIntervalMs = Math.max(1000, Math.floor(scanIntervalMs) || DEFAULT_SCAN_INTERVAL_MS);
    this.maxBatchesPerScan = Math.max(1, Math.floor(maxBatchesPerScan) || DEFAULT_MAX_BATCHES_PER_SCAN);
    this.now = now;
    this.layers = Object.keys(sources);

    this.running = false;
    this.scanning = false;
    this.inFlight = null;
    this.timer = null;
    // 模型可用性是状态而不是每轮日志：只在「可用 <-> 不可用」翻转时记一条。
    this.providerAvailable = null;
  }

  // 启动：先把崩溃遗留的 PROCESSING 退回 PENDING，再立刻扫一轮补历史存量。
  start() {
    if (this.running) return this.snapshot();
    this.running = true;

    const recovered = this.recover();
    if (recovered > 0) {
      this.log?.record(EVENTS.EMBEDDING_RECOVERED, {
        message: `启动补偿：${recovered} 条 PROCESSING 记录退回 PENDING`,
      });
    }

    this.scan().finally(() => {
      if (this.running) this.scheduleNext();
    });
    return this.snapshot();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    return this.snapshot();
  }

  // 三层各自的启动补偿（PROCESSING -> PENDING），返回退回的总行数。
  recover() {
    let total = 0;
    for (const name of this.layers) total += this.sources[name].resetProcessing();
    return total;
  }

  // 扫描一轮：重入时直接返回，不做第二次（定时器与手动触发可能叠在一起）。
  scan() {
    if (this.scanning) return Promise.resolve({ busy: true, layers: [] });
    this.scanning = true;

    const run = this._runScan().finally(() => {
      this.scanning = false;
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  // 等当前这一轮扫描结束（退出流程用）。
  async flush() {
    if (!this.inFlight) return;
    try {
      await this.inFlight;
    } catch {
      // _runScan 内部已经把所有异常收敛成日志，这里只是等它收尾。
    }
  }

  scheduleNext() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.scan().finally(() => {
        if (this.running) this.scheduleNext();
      });
    }, this.scanIntervalMs);
    // 定时器不应该拖住进程退出（Electron 的退出流程由 main.js 编排）。
    this.timer.unref?.();
  }

  // 一轮扫描：先看三层有没有待办，没有就不去打扰 Ollama；
  // 有空闲批次才做健康检查，模型不可用则整轮跳过，记录留在 PENDING（铁律二）。
  async _runScan() {
    const batches = new Map();
    let pending = 0;
    for (const name of this.layers) {
      const batch = this.sources[name].listPending(this.batchSize);
      batches.set(name, batch);
      pending += batch.length;
    }
    if (!pending) return { available: this.providerAvailable, pending: 0, layers: [] };

    const available = await this._checkProvider();
    if (!available) return { available: false, pending, layers: [] };

    const results = [];
    for (const name of this.layers) {
      if (!batches.get(name).length) continue;
      results.push(await this._processLayer(name, batches.get(name)));
    }

    const completed = results.reduce((sum, item) => sum + item.completed, 0);
    const failed = results.reduce((sum, item) => sum + item.failed, 0);
    if (completed || failed) {
      this.log?.record(EVENTS.EMBEDDING_SCAN, {
        message: `本轮嵌入完成 ${completed} 条，失败 ${failed} 条（${this.provider.model}）`,
      });
    }
    return { available: true, pending, completed, failed, layers: results };
  }

  // 模型可用时才处理；不可用时本轮整体跳过，不做任何状态变更。
  async _checkProvider() {
    let health;
    try {
      health = await this.provider.health();
    } catch (error) {
      health = { online: false, modelAvailable: false, message: error.message };
    }

    const available = Boolean(health?.online && health?.modelAvailable);
    if (available !== this.providerAvailable) {
      this.providerAvailable = available;
      this.log?.record(available ? EVENTS.EMBEDDING_ONLINE : EVENTS.EMBEDDING_OFFLINE, {
        message: available
          ? `Embedding 模型可用：${this.provider.model}`
          : `Embedding 模型不可用（${this.provider.model}）：${health?.message ?? '未知原因'}；本轮跳过，记录保持 PENDING`,
      });
    }
    return available;
  }

  // 一层记忆连续处理若干批（默认最多 10 批 = 320 条，可覆盖首次启动的存量补齐）。
  async _processLayer(name, firstBatch) {
    const source = this.sources[name];
    let completed = 0;
    let failed = 0;
    let batches = 0;
    let batch = firstBatch;

    while (batch.length) {
      batches += 1;
      const result = await this._processBatch(name, batch);
      completed += result.completed;
      failed += result.failed;

      // 整批都没能完成（模型掉线 / 写入失败）就停手，留着下一轮再来。
      if (!result.completed && !result.failed) break;
      if (batches >= this.maxBatchesPerScan) break;
      batch = source.listPending(this.batchSize);
    }

    return { layer: name, batches, completed, failed };
  }

  // 一批记录：标记 PROCESSING -> 构建文本 -> 批量嵌入 -> 写 LanceDB -> 回写状态。
  async _processBatch(name, batch) {
    const source = this.sources[name];
    const vectorRepo = this.vectors[name];

    // 先标记：崩在这一步之后，下次启动的补偿会把这些行退回 PENDING。
    source.markProcessing(batch.map((row) => row.sourceId));

    // 文本为空的记录构建不出向量，属于永久性失败；同批其他记录照常处理。
    const ready = [];
    const empty = [];
    for (const row of batch) {
      if (String(row.text ?? '').trim()) ready.push(row);
      else empty.push(row);
    }
    if (empty.length) source.markFailed(empty.map((row) => row.sourceId));
    if (!ready.length) return { completed: 0, failed: empty.length };

    let vectors;
    try {
      vectors = await this.provider.embedTexts(ready.map((row) => row.text));
    } catch (error) {
      return this._revert(source, ready, empty.length, error, '嵌入');
    }

    const createdAt = formatLocalIso(this.now());
    const rows = ready.map((row, index) => ({
      id: row.id,
      source_id: String(row.sourceId),
      text: row.text,
      vector: vectors[index],
      captured_at: row.capturedAt,
      date: row.date,
      // 空串而不是 null：LanceDB 建表时要从数据推断 Arrow 类型，
      // 全 NULL 的列推断不出类型（日记表没有项目 / 分类，必然命中）。
      // 过滤侧的口径是 project = '' 表示「没有项目」。
      project: row.project ?? '',
      category: row.category ?? '',
      embedding_model: this.provider.model,
      embedding_version: this.provider.version,
      created_at: createdAt,
    }));

    try {
      await vectorRepo.upsert(rows);
    } catch (error) {
      return this._revert(source, ready, empty.length, error, '写入向量库');
    }

    source.markCompleted(ready.map((row) => row.sourceId), {
      model: this.provider.model,
      version: this.provider.version,
    });

    // 行数到阈值才真正建索引；已经有索引时这一步是空操作。
    await vectorRepo.ensureIndex(this.provider.dimension);
    return { completed: ready.length, failed: empty.length };
  }

  // 临时故障：这批退回 PENDING，下一轮重试；向量库是可重建的，绝不因此丢状态。
  _revert(source, ready, failedCount, error, action) {
    source.markPending(ready.map((row) => row.sourceId));
    this.log?.record(EVENTS.EMBEDDING_ERROR, {
      errorCode: error?.code ?? ERROR_CODES.UNKNOWN,
      message: `${action}失败，${ready.length} 条退回 PENDING：${error?.message ?? error}`,
    });
    return { completed: 0, failed: failedCount };
  }

  snapshot() {
    const stats = {};
    for (const name of this.layers) stats[name] = this.sources[name].countByStatus();
    return {
      running: this.running,
      scanning: this.scanning,
      batchSize: this.batchSize,
      scanIntervalMs: this.scanIntervalMs,
      model: this.provider.model,
      version: this.provider.version,
      dimension: this.provider.dimension,
      providerAvailable: this.providerAvailable,
      stats,
    };
  }
}

module.exports = { EmbeddingService, DEFAULT_BATCH_SIZE, DEFAULT_SCAN_INTERVAL_MS };
