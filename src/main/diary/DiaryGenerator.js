'use strict';

const { JOB_PRIORITY } = require('../ai/job');
const { ERROR_CODES } = require('../ai/errors');
const { EVENTS } = require('../ai/jobEventLog');
const { dayBounds, dayEndOf, dayKeyOf } = require('../day');
const { normalizeDayKey } = require('../db/repositories/DiaryRepository');

// 一天最多 144 个区块；一次扫描最多补 30 天，避免首次启动把队列一次性灌爆。
const DEFAULT_SCAN_LIMIT = 30;
// 过了午夜等一会儿再扫：让这一天最后几个 10 分钟区块先汇总完。
const DEFAULT_SCAN_DELAY_MS = 5000;
// 区块汇总完成后的合并延迟：一个区块完成就扫一次日记，但连续完成时只扫最后一次。
const DEFAULT_NOTIFY_DELAY_MS = 2000;

// 日记的生成编排（与 TimeBlockSummarizer 在区块链路上的角色对称）：
// 扫描缺口 -> 入队 -> 结果回填 -> 快照给界面显示「正在生成」。
//
// 触发时机有三个：
// 1. 应用启动时补扫（需求 1.2「每次打开时，都会处理之前没有生成的日记」）；
// 2. 每个本地午夜之后（跨天时不重启应用也能生成昨天的日记）；
// 3. 区块汇总状态变化时（那一天所有区块都汇总完的那一刻，日记立刻排队）。
class DiaryGenerator {
  constructor({
    queue,
    diaries,
    timeBlocks,
    log = null,
    onEvent = null,
    scanLimit = DEFAULT_SCAN_LIMIT,
    scanDelayMs = DEFAULT_SCAN_DELAY_MS,
    notifyDelayMs = DEFAULT_NOTIFY_DELAY_MS,
    now = () => new Date(),
  }) {
    this.queue = queue;
    this.diaries = diaries;
    this.timeBlocks = timeBlocks;
    this.log = log;
    this.onEvent = onEvent;
    this.scanLimit = scanLimit;
    this.scanDelayMs = scanDelayMs;
    this.notifyDelayMs = notifyDelayMs;
    this.now = now;

    this.running = false;
    this.scanning = false;
    this.timer = null;
    this.notifyTimer = null;
  }

  // 启动即扫一次（补上应用没运行的那些天），之后在每个午夜边界再扫。
  start() {
    if (this.running) return this.snapshot();
    this.running = true;
    this.scan().finally(() => {
      if (this.running) this.scheduleNext();
    });
    return this.snapshot();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.notifyTimer);
    this.timer = null;
    this.notifyTimer = null;
    this.emit();
    return this.snapshot();
  }

  // 区块汇总状态变化时的通知：合并成一次扫描，避免连续完成时反复查库。
  notifyBlocksChanged() {
    if (!this.running || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (!this.running) return;
      this.scan().catch(() => {});
    }, this.notifyDelayMs);
    // 定时器不应该拖住进程退出。
    this.notifyTimer.unref?.();
  }

  /**
   * 找出「有区块、还没有日记」的历史日期并排队。
   * @returns {Promise<{ scanned: number, created: number, skipped: number, deferred: number }>}
   */
  async scan() {
    if (this.scanning) return { scanned: 0, created: 0, skipped: 0, deferred: 0, busy: true };
    this.scanning = true;

    try {
      const now = this.now();
      // 今天还没过完，不生成日记：只处理今天之前的日期。
      const todayKey = dayKeyOf(now);
      const candidates = this.diaries.listMissingDays({
        beforeDay: todayKey,
        limit: this.scanLimit,
      });

      const ceiling = this.backfillCeiling(todayKey);
      let created = 0;
      let skipped = 0;
      let deferred = 0;
      for (const candidate of candidates) {
        // 这一天还有记录没变成区块（历史上限之外的回填）：等区块补齐再生成，
        // 否则日记只看得见这一天的一部分。
        if (ceiling && candidate.day >= ceiling) {
          deferred += 1;
          continue;
        }
        const bounds = dayBounds(candidate.day);
        if (!bounds) {
          deferred += 1;
          continue;
        }
        const result = await this.queue.enqueueWithDiary(
          {
            day: candidate.day,
            status: 'PENDING',
            blockCount: candidate.blockCount,
            from: bounds.from,
            to: bounds.to,
          },
          { priority: JOB_PRIORITY.LOW },
        );
        if (result?.created) created += 1;
        else skipped += 1;
      }

      if (candidates.length) {
        this.log?.record(EVENTS.DIARY_SCAN, {
          message: `扫描到 ${candidates.length} 天待生成日记，新建 ${created} 个任务，`
            + `跳过 ${skipped} 个，等待区块回填 ${deferred} 天`,
        });
      }
      if (created) this.emit();
      return { scanned: candidates.length, created, skipped, deferred };
    } catch (error) {
      this.log?.record(EVENTS.STORAGE_ERROR, {
        errorCode: error.code || ERROR_CODES.STORAGE_ERROR,
        message: `日记扫描失败：${error.message}`,
      });
      return { scanned: 0, created: 0, skipped: 0, deferred: 0, error: error.message };
    } finally {
      this.scanning = false;
    }
  }

  // 手动重新生成某一天：强制新建任务（不受「已完成」去重限制），界面上的重新生成按钮用它。
  async regenerate(day) {
    const key = normalizeDayKey(day);
    if (!key) return { created: false, reason: 'INVALID_DAY' };

    const existing = this.diaries.getByDay(key);
    if (!existing) return { created: false, reason: 'NOT_FOUND' };

    const bounds = dayBounds(key);
    try {
      const result = await this.queue.enqueueWithDiary(
        {
          day: key,
          status: 'PENDING',
          blockCount: existing.blockCount,
          from: bounds.from,
          to: bounds.to,
        },
        { priority: JOB_PRIORITY.NORMAL, force: true },
      );
      this.emit();
      return { created: Boolean(result?.created), reason: result?.reason ?? null };
    } catch (error) {
      this.log?.record(EVENTS.STORAGE_ERROR, {
        errorCode: error.code || ERROR_CODES.STORAGE_ERROR,
        message: `重新生成 ${key} 的日记失败：${error.message}`,
      });
      return { created: false, reason: 'STORAGE_ERROR' };
    }
  }

  // 生成成功：把六段内容回填到日记记录。
  async handleResult(job, result) {
    const day = job.payload?.day;
    const saved = this.diaries.updateDiary(day, {
      status: 'COMPLETED',
      diary: result?.analysis ?? null,
      blockCount: Number(result?.blockCount) || 0,
      model: result?.model ?? null,
      analysisMs: result?.analysisMs ?? null,
      error: null,
      errorCode: null,
    });
    if (!saved) {
      this.log?.record(EVENTS.STORAGE_ERROR, {
        job,
        errorCode: ERROR_CODES.STORAGE_ERROR,
        message: `找不到 ${day} 的日记记录，生成结果未写回`,
      });
    }
    this.emit();
  }

  // 生成永久失败：行保留并标记失败，界面上给出「重新生成」入口。
  handleFailure(job, error) {
    this.diaries.updateDiary(job.payload?.day, {
      status: 'FAILED',
      error: error?.message ?? null,
      errorCode: error?.code ?? ERROR_CODES.UNKNOWN,
      analysisMs: null,
    });
    this.emit();
  }

  // 界面上的「正在生成日记」提示与统计。
  snapshot() {
    return {
      running: this.running,
      scanning: this.scanning,
      stats: this.diaries.countByStatus(),
    };
  }

  // 还有记录没变成区块的最早日期（没有就返回 null）。
  // 回填严格按时间从前到后推进，所以「这一天还有缺口」等价于「这一天不早于这个日期」。
  backfillCeiling(todayKey) {
    const bounds = dayBounds(todayKey);
    if (!bounds) return null;
    const missing = this.timeBlocks.listMissingBlocks({ before: bounds.from, limit: 1 });
    if (!missing.length) return null;
    return dayKeyOf(missing[0].blockStart);
  }

  emit() {
    if (!this.onEvent) return;
    try {
      this.onEvent({ type: 'diary', diary: this.snapshot() });
    } catch {
      // 通知失败不影响生成流程。
    }
  }

  // 到下一个本地午夜（再等 scanDelayMs，让最后几个区块先汇总完）。
  nextDelayMs() {
    const now = this.now();
    const end = dayEndOf(now);
    return Math.max(end.getTime() - now.getTime(), 0) + this.scanDelayMs;
  }

  scheduleNext() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.scan().finally(() => {
        if (this.running) this.scheduleNext();
      });
    }, this.nextDelayMs());
    this.timer.unref?.();
  }
}

module.exports = {
  DiaryGenerator,
  DEFAULT_SCAN_LIMIT,
  DEFAULT_SCAN_DELAY_MS,
  DEFAULT_NOTIFY_DELAY_MS,
};