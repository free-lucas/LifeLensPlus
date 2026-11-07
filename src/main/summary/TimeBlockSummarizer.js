'use strict';

const { JOB_PRIORITY } = require('../ai/job');
const { ERROR_CODES } = require('../ai/errors');
const { EVENTS } = require('../ai/jobEventLog');
const { formatLocalIso } = require('../time');
const { BLOCK_MINUTES, BLOCK_MS, blockStartOf, createBlock } = require('./timeBlock');

// 区块结束后等一小会儿再汇总：让这个时间段最后几张截图的记录先落库。
const DEFAULT_SCAN_DELAY_MS = 2000;
// 一次扫描最多补多少个区块（144 个 = 24 小时），避免首次启动把队列一次性灌爆。
const DEFAULT_SCAN_LIMIT = 144;

// 10 分钟区块的汇总编排（与 Recorder 在截图链路上的角色对称）：
// 定时扫描缺口 -> 入队 -> 结果回填 -> 快照给界面显示「汇总中」。
class TimeBlockSummarizer {
  constructor({
    queue,
    timeBlocks,
    log = null,
    onEvent = null,
    scanLimit = DEFAULT_SCAN_LIMIT,
    scanDelayMs = DEFAULT_SCAN_DELAY_MS,
    now = () => new Date(),
  }) {
    this.queue = queue;
    this.timeBlocks = timeBlocks;
    this.log = log;
    this.onEvent = onEvent;
    this.scanLimit = scanLimit;
    this.scanDelayMs = scanDelayMs;
    this.now = now;

    this.running = false;
    this.scanning = false;
    this.timer = null;
  }

  // 启动即扫一次（补上应用没运行时留下的区块），之后每个区块边界再扫。
  start() {
    if (this.running) return this.snapshot();
    this.running = true;
    this.emit();
    // 先补扫历史缺口，再对齐到下一个区块边界。
    this.scan().finally(() => {
      if (this.running) this.scheduleNext();
    });
    return this.snapshot();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.emit();
    return this.snapshot();
  }

  /**
   * 找出「有记录、还没有汇总」的已结束区块并排队。
   * 已经处理过的区块一定有时间区块行（行与任务是同一事务写入），所以查不到行就是没处理过。
   * @returns {Promise<{ scanned: number, created: number, skipped: number }>}
   */
  async scan() {
    if (this.scanning) return { scanned: 0, created: 0, skipped: 0, busy: true };
    this.scanning = true;

    try {
      const now = this.now();
      // 只处理已经结束的区块：captured_at 落在当前区块起点之前的记录才属于已结束区块。
      const before = formatLocalIso(blockStartOf(now));
      const candidates = this.timeBlocks.listMissingBlocks({ before, limit: this.scanLimit });

      let created = 0;
      let skipped = 0;
      for (const candidate of candidates) {
        const block = createBlock(candidate.blockStart, { activityCount: candidate.activityCount });
        // 汇总优先级低于实时截图：同一个区块里的截图先分析完，汇总才更有内容。
        const result = await this.queue.enqueueWithBlock(block, { priority: JOB_PRIORITY.LOW });
        if (result?.created) created += 1;
        else skipped += 1;
      }

      this.log?.record(EVENTS.SUMMARY_SCAN, {
        message: `扫描到 ${candidates.length} 个待汇总区块，新建 ${created} 个任务，跳过 ${skipped} 个`,
      });
      this.emit();
      return { scanned: candidates.length, created, skipped };
    } catch (error) {
      this.log?.record(EVENTS.STORAGE_ERROR, {
        errorCode: error.code || ERROR_CODES.STORAGE_ERROR,
        message: `区块汇总扫描失败：${error.message}`,
      });
      return { scanned: 0, created: 0, skipped: 0, error: error.message };
    } finally {
      this.scanning = false;
    }
  }

  // 汇总成功：把结构化结果回填到区块记录。
  async handleResult(job, result) {
    const saved = this.timeBlocks.updateSummary(job.payload?.blockStart, {
      status: 'COMPLETED',
      summary: result?.analysis ?? null,
      model: result?.model ?? null,
      analysisMs: result?.analysisMs ?? null,
      error: null,
      errorCode: null,
    });
    if (!saved) {
      this.log?.record(EVENTS.STORAGE_ERROR, {
        job,
        errorCode: ERROR_CODES.STORAGE_ERROR,
        message: `找不到区块 ${job.payload?.blockStart}，汇总结果未写回`,
      });
    }
    this.emit();
  }

  // 汇总永久失败：区块保留，标记失败，之后可以重新汇总（不会被扫描重复排队）。
  handleFailure(job, error) {
    this.timeBlocks.updateSummary(job.payload?.blockStart, {
      status: 'FAILED',
      error: error?.message ?? null,
      errorCode: error?.code ?? ERROR_CODES.UNKNOWN,
      analysisMs: null,
    });
    this.emit();
  }

  // 界面上的「汇总中」标记与区块统计。
  snapshot() {
    return {
      running: this.running,
      scanning: this.scanning,
      blockMinutes: BLOCK_MINUTES,
      stats: this.timeBlocks.countByStatus(),
    };
  }

  emit() {
    if (!this.onEvent) return;
    try {
      this.onEvent({ type: 'summary', summary: this.snapshot() });
    } catch {
      // 通知失败不影响汇总流程。
    }
  }

  // 下一个区块边界 + 扫描延迟；now 正好落在边界上时，刚结束的区块由本次扫描处理，
  // 所以这里直接等下一个完整区块。
  nextDelayMs() {
    const now = this.now();
    const elapsed = now.getTime() - blockStartOf(now).getTime();
    const untilBoundary = elapsed <= 0 ? BLOCK_MS : BLOCK_MS - elapsed;
    return untilBoundary + this.scanDelayMs;
  }

  scheduleNext() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.scan().finally(() => {
        if (this.running) this.scheduleNext();
      });
    }, this.nextDelayMs());
    // 定时器不应该拖住进程退出（Electron 的退出流程由 main.js 编排）。
    this.timer.unref?.();
  }
}

module.exports = {
  TimeBlockSummarizer,
  DEFAULT_SCAN_DELAY_MS,
  DEFAULT_SCAN_LIMIT,
};
