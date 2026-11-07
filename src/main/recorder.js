'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { formatLocalIso } = require('./time');
const defaultCapture = require('./capture');
const { AIJobType, JOB_PRIORITY } = require('./ai/job');
const { ERROR_CODES } = require('./ai/errors');
const { EVENTS } = require('./ai/jobEventLog');

// 定时截屏 -> 保存图片 -> 写入记录（PENDING）+ 入队（同一事务）-> 交给 AI 队列。
// 分析由后台的 AIWorker 完成，这里绝不等待 AI：Ollama 再慢也不会影响截图节奏。
class Recorder {
  constructor({ store, activities, config, onEvent, aiQueue = null, capture = defaultCapture, log = null }) {
    this.store = store;
    // Activity 的读写全部走 repository，Recorder 不直接碰 SQL / 数据库。
    this.activities = activities;
    this.config = config;
    this.onEvent = onEvent;
    this.aiQueue = aiQueue;
    this.capture = capture;
    this.log = log;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.count = 0;
    this.lastError = null;
    this.stats = { total: 0, analyzed: 0, errors: 0, pending: 0, lastCaptureAt: null };
    this.skipped = 0;
    this.lastFrameSignature = null;
    // 统计扫描完成后才能安全累加，避免启动瞬间的计数被覆盖。
    this.ready = this.loadStats();
    this.pending = Promise.resolve();
  }

  // 启动时从磁盘汇总历史统计，保证重启后总数依然准确。
  async loadStats() {
    try {
      this.stats = await this.activities.loadStats();
    } catch (error) {
      this.lastError = error.message;
    }
    this.emitStatus();
  }

  get status() {
    return {
      running: this.running,
      busy: this.busy,
      queue: this.stats.pending,
      count: this.count,
      total: this.stats.total,
      analyzed: this.stats.analyzed,
      errors: this.stats.errors,
      pending: this.stats.pending,
      skipped: this.skipped,
      lastCaptureAt: this.stats.lastCaptureAt,
      lastError: this.lastError,
      intervalMs: this.config.intervalMs,
      model: this.config.model,
      outputDir: this.config.outputDir,
    };
  }

  start() {
    if (this.running) return this.status;
    this.running = true;
    this.emitStatus();
    this.pending = this.tick();
    return this.status;
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.emitStatus();
    return this.status;
  }

  toggle() {
    return this.running ? this.stop() : this.start();
  }

  // 等待当前这一轮结束；退出时用它避免丢掉最后一条记录。
  whenIdle() {
    return this.pending;
  }

  // 事件统一从这里派发：监听方（窗口销毁、webContents.send 抛错）出错时绝不能把录制循环带停。
  emit(payload) {
    try {
      this.onEvent(payload);
    } catch {
      // 通知失败就忽略，录制继续。
    }
  }

  emitStatus() {
    this.emit({ type: 'status', status: this.status });
  }

  async tick() {
    if (!this.running || this.busy) return;
    // busy 必须在任何 await 之前置位，否则启动瞬间 stop()+start() 会开出第二条定时链。
    this.busy = true;
    let startedAt = null;

    try {
      this.emitStatus();
      await this.ready;
      if (!this.running) return;

      startedAt = new Date();
      const { image } = await this.capture.capturePrimaryDisplay();
      const signature = this.capture.frameSignature(image);

      // 与上一张已保存的截图几乎相同：不保存、不分析、不记录，直接丢弃这一帧。
      if (this.capture.isSimilarFrame(signature, this.lastFrameSignature)) {
        this.skipped += 1;
        return;
      }

      const png = image.toPNG();
      const imagePath = await this.store.saveImage(png, startedAt);
      this.lastFrameSignature = signature;

      // 截图 id 取自文件名（带毫秒时间戳），可以直接对应到磁盘上的图片。
      const screenshotId = path.basename(imagePath, path.extname(imagePath));
      const record = {
        id: screenshotId,
        time: formatLocalIso(startedAt),
        imagePath,
        analysis: null,
        model: this.config.model,
        analysisMs: null,
        analysisStatus: 'PENDING',
        error: null,
        errorCode: null,
      };

      // 记录与任务在同一个 SQLite 事务里落库：AI 失败或进程崩溃都不会丢这张截图，
      // 也不会出现「记录写了、任务没建」的 PENDING 孤儿。
      await this.enqueueWithActivity(record);
      this.count += 1;
      this.stats.total += 1;
      this.stats.pending += 1;
      this.stats.lastCaptureAt = record.time;
      this.emit({ type: 'record', record });
    } catch (error) {
      this.lastError = error.message;
      this.emit({ type: 'error', message: error.message });
    } finally {
      this.busy = false;
      this.emitStatus();
      if (this.running) {
        // 以本轮开始时刻对齐，尽量贴近 intervalMs 的节奏。
        const elapsed = startedAt ? Date.now() - startedAt.getTime() : 0;
        this.timer = setTimeout(() => {
          this.pending = this.tick();
        }, Math.max(0, this.config.intervalMs - elapsed));
      }
    }
  }

  // 截图路径：Activity + AI Job 交给队列在同一个事务里写入。
  // SQLite 事务回滚不了已经写到磁盘的 PNG，所以事务失败要把这张图删掉，
  // 避免留下「有图片、没有记录」的孤儿截图（第 23 节）。
  async enqueueWithActivity(record, { priority = JOB_PRIORITY.NORMAL } = {}) {
    if (!this.aiQueue) return null;
    try {
      const { job } = await this.aiQueue.enqueueWithActivity(record, { priority });
      return job;
    } catch (error) {
      await this.discardScreenshot(record.imagePath, error);
      throw error;
    }
  }

  // 只建 Job（截图记录已经存在）：启动补偿走这条路，失败时绝不能删掉已有截图。
  async enqueueAnalysis(record, { priority = JOB_PRIORITY.NORMAL } = {}) {
    if (!this.aiQueue) return null;
    const { job } = await this.aiQueue.enqueue({
      type: AIJobType.SCREENSHOT_ANALYSIS,
      priority,
      payload: {
        screenshotId: record.id,
        imagePath: record.imagePath,
        capturedAt: record.time,
      },
    });
    return job;
  }

  // 数据库写入失败后的补偿：删掉刚保存的截图。删除失败只记录，不假装删除成功。
  async discardScreenshot(imagePath, cause) {
    try {
      await fs.rm(imagePath, { force: true });
    } catch (error) {
      this.log?.record(EVENTS.STORAGE_ERROR, {
        errorCode: ERROR_CODES.STORAGE_ERROR,
        message: `数据库写入失败，且无法删除截图 ${imagePath}：${error.message}`,
      });
      return;
    }
    this.log?.record(EVENTS.STORAGE_ERROR, {
      errorCode: ERROR_CODES.STORAGE_ERROR,
      message: `数据库写入失败（${cause.message}），已删除这张截图`,
    });
  }

  // 启动补偿（Phase 5.1）：把「记录已落盘、却没有对应 AI Job」的截图找出来补建任务。
  // 典型来源是「记录写完、入队之前」进程被关闭。
  // 已经有 Job 的（含已完成 / 已失败 / 已取消）一律跳过：既不重复分析，
  // 也不让失败的任务每次启动都复活。
  async recoverPendingAnalyses() {
    if (!this.aiQueue) return { scanned: 0, created: 0, skipped: 0 };

    try {
      const records = await this.activities.listPendingRecords();
      let created = 0;
      let skipped = 0;

      for (const record of records) {
        if (!record.id || this.aiQueue.findJobForScreenshot(record.id)) {
          skipped += 1;
          continue;
        }
        // 补偿任务优先级低于实时截图，保证新截图的记录先被分析。
        const job = await this.enqueueAnalysis(record, { priority: JOB_PRIORITY.LOW });
        if (job) created += 1;
      }

      this.log?.record(EVENTS.RECOVERY_SCAN, {
        message: `扫描 ${records.length} 条 PENDING 记录，补建 ${created} 个任务，跳过 ${skipped} 个`,
      });
      this.emitStatus();
      return { scanned: records.length, created, skipped };
    } catch (error) {
      this.log?.record(EVENTS.RECOVERY_SCAN, {
        errorCode: error.code || 'RECOVERY_FAILED',
        message: `启动补偿失败：${error.message}`,
      });
      return { scanned: 0, created: 0, skipped: 0, error: error.message };
    }
  }

  // AI 分析成功：把结果回填到记录里。
  // 结构化结果按字段存进 activities（activity / summary / category / project / keywords / confidence）。
  async handleAnalysisResult(job, result) {
    const analysis = result.analysis ?? null;
    const patch = {
      analysis,
      model: result.model,
      analysisMs: result.analysisMs,
      analysisStatus: 'COMPLETED',
      error: null,
      errorCode: null,
    };
    const saved = await this.activities.updateAnalysis(job.payload.screenshotId, patch);
    if (!saved) {
      // 记录被清理时不要把任务判失败，但要留下痕迹。
      this.emit({ type: 'error', message: `找不到截图记录 ${job.payload.screenshotId}，分析结果未写回` });
    }
    this.noteAnalysis('COMPLETED');
    this.emit({ type: 'analysis', screenshotId: job.payload.screenshotId, patch });
  }

  // AI 永久失败：截图保留，记录标记为分析失败，之后可以重新分析。
  async handleAnalysisFailure(job, error) {
    const patch = {
      analysisStatus: 'FAILED',
      error: error.message,
      errorCode: error.code,
      analysisMs: null,
    };
    await this.activities.updateAnalysis(job.payload.screenshotId, patch);
    this.lastError = error.message;
    this.noteAnalysis('FAILED');
    this.emit({ type: 'analysis', screenshotId: job.payload.screenshotId, patch });
  }

  // 分析结束后更新界面上的「待分析 / 已分析 / 错误数」。
  noteAnalysis(status) {
    if (this.stats.pending > 0) this.stats.pending -= 1;
    if (status === 'FAILED') {
      this.stats.errors += 1;
    } else {
      this.stats.analyzed += 1;
      this.lastError = null;
    }
    this.emitStatus();
  }
}

module.exports = { Recorder };
