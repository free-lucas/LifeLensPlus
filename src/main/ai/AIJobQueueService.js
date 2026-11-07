'use strict';

const { EventEmitter } = require('node:events');

const {
  AIJobType,
  AIJobStatus,
  JOB_PRIORITY,
  DEFAULT_MAX_RETRIES,
  canTransition,
  createJob,
  isActive,
  isTerminal,
  jobPayloadKey,
} = require('./job');
const { ERROR_CODES } = require('./errors');
const { EVENTS } = require('./jobEventLog');
const { formatLocalIso } = require('../time');

// 失败后的退避等待：2s -> 5s -> 15s，用完仍然失败就 FAILED（绝不无限重试）。
const DEFAULT_RETRY_DELAYS_MS = [2000, 5000, 15000];

// 终态 Job 会保留下来做去重与统计，但需要封顶，避免文件无限增长。
const DEFAULT_MAX_TERMINAL_JOBS = 500;

// 队列服务：只负责有什么活要干，不关心活怎么干（那是 Worker/Provider 的事）。
// 所有状态变更都会立即持久化，Electron 崩溃后可以恢复。
class AIJobQueueService extends EventEmitter {
  constructor({
    repository,
    activities = null,
    timeBlocks = null,
    diaries = null,
    log = null,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    maxTerminalJobs = DEFAULT_MAX_TERMINAL_JOBS,
    now = () => new Date(),
  } = {}) {
    super();
    this.repository = repository;
    // Activity 的写入入口（截图的「记录 + 任务」同一事务，见 enqueueWithActivity）。
    this.activities = activities;
    // 时间区块的写入入口（Phase 8：区块的「记录 + 任务」同一事务，见 enqueueWithBlock）。
    this.timeBlocks = timeBlocks;
    // 日记的写入入口（Phase 9：日记的「记录 + 任务」同一事务，见 enqueueWithDiary）。
    this.diaries = diaries;
    this.log = log;
    this.retryDelaysMs = retryDelaysMs.length ? retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
    this.maxTerminalJobs = maxTerminalJobs;
    this.now = now;

    this.jobs = [];
    this.retryTimers = new Map();
    this.running = false;
    this.paused = false;
    this.currentJobId = null;
    this.writeChain = Promise.resolve();
  }

  // 载入磁盘上的 Job 并恢复上次没跑完的任务。调用一次即可。
  async start() {
    if (this.running) return this.snapshot();

    const loaded = await this.repository.load();
    this.jobs = loaded.filter(isUsableJob).map(normalizeJob);
    this.running = true;

    const recovered = this._recoverStuckJobs();
    await this._persist();

    if (recovered) this._emitChange();
    return this.snapshot();
  }

  stop() {
    if (!this.running && !this.retryTimers.size) return this.snapshot();
    this.running = false;
    this._clearRetryTimers();
    // RETRYING 的任务保留在磁盘上，下次 start() 会恢复成 PENDING。
    this._emitChange();
    return this.snapshot();
  }

  pause() {
    if (this.paused) return this.snapshot();
    this.paused = true;
    this.log?.record(EVENTS.WORKER_PAUSED);
    this._emit('paused');
    this._emitChange();
    return this.snapshot();
  }

  resume() {
    if (!this.paused) return this.snapshot();
    this.paused = false;
    this.log?.record(EVENTS.WORKER_RESUMED);
    this._emit('resumed');
    this._emit('wake');
    this._emitChange();
    return this.snapshot();
  }

  /**
   * 入队。enqueue 只做持久化，不会等待 AI 分析，绝不阻塞截图流程。
   * @returns {Promise<{ job: object|null, created: boolean, reason?: string }>}
   */
  async enqueue({ type, payload = {}, priority = JOB_PRIORITY.NORMAL, maxRetries = DEFAULT_MAX_RETRIES, force = false } = {}) {
    const duplicate = this._dedupe(type, jobPayloadKey(payload), force);
    if (duplicate) return duplicate;

    const job = createJob({ type, payload, priority, maxRetries, now: this.now() });
    this.jobs.push(job);
    this.log?.record(EVENTS.JOB_ENQUEUED, { job });
    await this._persist();
    this._emit('wake');
    this._emitChange();
    return { job, created: true };
  }

  /**
   * 截图路径专用：Activity 与 AI Job 在同一个 SQLite 事务里落库，
   * 任意一步失败都整体回滚，不会留下「有记录、没任务」的 PENDING 孤儿（第 22 节）。
   * 去重逻辑与 enqueue() 共用，返回值与 enqueue() 同构。
   * @returns {Promise<{ job: object|null, created: boolean, reason?: string }>}
   */
  async enqueueWithActivity(record, { priority = JOB_PRIORITY.NORMAL, maxRetries = DEFAULT_MAX_RETRIES } = {}) {
    if (!this.activities) throw new Error('队列没有配置 ActivityRepository，无法写入截图记录');

    const payload = {
      screenshotId: record.id,
      imagePath: record.imagePath,
      capturedAt: record.time,
    };
    const duplicate = this._dedupe(AIJobType.SCREENSHOT_ANALYSIS, payload.screenshotId, false);
    if (duplicate) return duplicate;

    const job = createJob({
      type: AIJobType.SCREENSHOT_ANALYSIS,
      payload,
      priority,
      maxRetries,
      now: this.now(),
    });

    // 先落库（单事务），成功了才注册进内存队列：失败时内存里也不会凭空多出一个任务。
    await this.activities.insertActivityWithJob(record, job);
    this.jobs.push(job);
    this.log?.record(EVENTS.JOB_ENQUEUED, { job });
    this._emit('wake');
    this._emitChange();
    return { job, created: true };
  }

  /**
   * 10 分钟区块汇总（Phase 8）专用：区块记录与 AI Job 在同一个 SQLite 事务里落库，
   * 与截图路径（enqueueWithActivity）同构，去重逻辑也共用。
   * @returns {Promise<{ job: object|null, created: boolean, reason?: string }>}
   */
  async enqueueWithBlock(block, { priority = JOB_PRIORITY.LOW, maxRetries = DEFAULT_MAX_RETRIES } = {}) {
    if (!this.timeBlocks) throw new Error('队列没有配置 TimeBlockRepository，无法写入区块记录');

    const payload = { blockStart: block.id, blockEnd: block.end };
    const duplicate = this._dedupe(AIJobType.TIMEBLOCK_SUMMARY, payload.blockStart, false);
    if (duplicate) return duplicate;

    const job = createJob({
      type: AIJobType.TIMEBLOCK_SUMMARY,
      payload,
      priority,
      maxRetries,
      now: this.now(),
    });

    // 先落库（单事务），成功了才注册进内存队列。
    await this.timeBlocks.insertBlockWithJob(block, job);
    this.jobs.push(job);
    this.log?.record(EVENTS.JOB_ENQUEUED, { job });
    this._emit('wake');
    this._emitChange();
    return { job, created: true };
  }

  /**
   * 一天的日记生成（Phase 9）专用：日记记录与 AI Job 在同一个 SQLite 事务里落库，
   * 与截图 / 区块路径同构。同一天已经有任务时不会重复排队；force 用于手动重新生成，
   * 会把同一天还在排队（PENDING / RETRYING）的旧任务取消掉再建新任务，
   * 否则用户点了「重新生成」会被去重悄悄吞掉。
   * @param {{ day: string, from: string, to: string, status?: string, blockCount?: number }} entry
   * @returns {Promise<{ job: object|null, created: boolean, reason?: string }>}
   */
  async enqueueWithDiary(entry, { priority = JOB_PRIORITY.LOW, maxRetries = DEFAULT_MAX_RETRIES, force = false } = {}) {
    if (!this.diaries) throw new Error('队列没有配置 DiaryRepository，无法写入日记记录');
    if (!entry?.day) throw new Error('日记任务缺少日期');

    const payload = { day: entry.day, from: entry.from, to: entry.to };
    if (force) this._cancelQueuedFor(AIJobType.DIARY_GENERATION, payload.day);
    const duplicate = this._dedupe(AIJobType.DIARY_GENERATION, payload.day, force);
    if (duplicate) return duplicate;

    const job = createJob({
      type: AIJobType.DIARY_GENERATION,
      payload,
      priority,
      maxRetries,
      now: this.now(),
    });

    // 先落库（单事务），成功了才注册进内存队列。
    await this.diaries.upsertDiaryWithJob(entry, job);
    this.jobs.push(job);
    this.log?.record(EVENTS.JOB_ENQUEUED, { job });
    this._emit('wake');
    this._emitChange();
    return { job, created: true };
  }

  // 取出优先级最高、创建最早的 PENDING 任务并置为 PROCESSING。
  dequeue() {
    if (!this.running || this.paused) return null;
    const job = this._nextPendingJob();
    if (!job || !this._transition(job, AIJobStatus.PROCESSING)) return null;

    job.startedAt = formatLocalIso(this.now());
    job.error = null;
    this.currentJobId = job.id;
    this.log?.record(EVENTS.JOB_STARTED, { job });
    this._persist();
    this._emitChange();
    return job;
  }

  complete(jobId, { message = null } = {}) {
    const job = this.getJob(jobId);
    if (!job || !this._transition(job, AIJobStatus.COMPLETED)) return null;

    job.completedAt = formatLocalIso(this.now());
    job.error = null;
    job.lastError = null;
    if (this.currentJobId === jobId) this.currentJobId = null;
    this.log?.record(EVENTS.JOB_COMPLETED, { job, message });
    this._persist();
    this._emitChange();
    return job;
  }

  fail(jobId, { code = ERROR_CODES.UNKNOWN, message = '' } = {}) {
    const job = this.getJob(jobId);
    if (!job || !this._transition(job, AIJobStatus.FAILED)) return null;

    job.failedAt = formatLocalIso(this.now());
    job.error = { code, message };
    job.lastError = message || null;
    if (this.currentJobId === jobId) this.currentJobId = null;
    this.log?.record(EVENTS.JOB_FAILED, { job, errorCode: code, message });
    this._persist();
    this._emitChange();
    return job;
  }

  // PROCESSING -> RETRYING -> （退避等待）-> PENDING。
  // 等待期间 Worker 可以继续处理其他任务，不会阻塞队列。
  scheduleRetry(jobId, { code = ERROR_CODES.UNKNOWN, message = '' } = {}) {
    const job = this.getJob(jobId);
    if (!job || !this._transition(job, AIJobStatus.RETRYING)) return null;

    const index = Math.min(job.retryCount, this.retryDelaysMs.length - 1);
    const delayMs = this.retryDelaysMs[index];
    job.retryCount += 1;
    job.error = { code, message };
    job.lastError = message || null;
    if (this.currentJobId === jobId) this.currentJobId = null;
    this.log?.record(EVENTS.JOB_RETRY, {
      job,
      errorCode: code,
      message: `第 ${job.retryCount} 次重试，${delayMs}ms 后重排队`,
    });

    const timer = setTimeout(() => {
      this.retryTimers.delete(jobId);
      const target = this.getJob(jobId);
      if (!this.running || !target || target.status !== AIJobStatus.RETRYING) return;
      if (!this._transition(target, AIJobStatus.PENDING)) return;
      this._emit('wake');
      this._persist();
      this._emitChange();
    }, delayMs);
    this.retryTimers.set(jobId, timer);

    this._persist();
    this._emitChange();
    return job;
  }

  // 手动重试失败的任务（不等待退避，并重置重试次数）。
  retry(jobId) {
    const job = this.getJob(jobId);
    if (!job || !this._transition(job, AIJobStatus.PENDING)) return job;

    job.retryCount = 0;
    job.error = null;
    job.failedAt = null;
    this.log?.record(EVENTS.JOB_ENQUEUED, { job, message: '手动重试' });
    this._persist();
    this._emit('wake');
    this._emitChange();
    return job;
  }

  cancel(jobId) {
    const job = this.getJob(jobId);
    if (!job || !this._transition(job, AIJobStatus.CANCELLED)) return job;

    const timer = this.retryTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(jobId);
    }
    this.log?.record(EVENTS.JOB_CANCELLED, { job });
    this._persist();
    this._emitChange();
    return job;
  }

  // 对历史截图重新分析：复用原任务信息，新建一个高优先级任务。
  async reanalyzeScreenshot(screenshotId, overrides = {}) {
    const previous = this._findByKey(null, screenshotId);
    if (!previous) return { job: null, created: false, reason: 'SCREENSHOT_NOT_FOUND' };

    return this.enqueue({
      type: previous.type,
      payload: { ...previous.payload, ...overrides, screenshotId },
      priority: JOB_PRIORITY.HIGH,
      maxRetries: previous.maxRetries,
      force: true,
    });
  }

  getJob(jobId) {
    return this.jobs.find((job) => job.id === jobId) || null;
  }

  getJobs() {
    return this.jobs.slice();
  }

  getPendingJobs() {
    return this.jobs.filter((job) => job.status === AIJobStatus.PENDING);
  }

  // 这张截图是否已经有任务（任何状态）。启动补偿用它判断要不要补建。
  findJobForScreenshot(screenshotId) {
    return this._findByKey(AIJobType.SCREENSHOT_ANALYSIS, screenshotId);
  }

  getStats() {
    const stats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      retrying: 0,
      cancelled: 0,
      total: this.jobs.length,
    };
    for (const job of this.jobs) {
      if (job.status === AIJobStatus.PENDING) stats.pending += 1;
      else if (job.status === AIJobStatus.PROCESSING) stats.processing += 1;
      else if (job.status === AIJobStatus.COMPLETED) stats.completed += 1;
      else if (job.status === AIJobStatus.FAILED) stats.failed += 1;
      else if (job.status === AIJobStatus.RETRYING) stats.retrying += 1;
      else if (job.status === AIJobStatus.CANCELLED) stats.cancelled += 1;
    }
    return stats;
  }

  snapshot() {
    const current = this.currentJobId ? this.getJob(this.currentJobId) : null;
    return {
      running: this.running,
      paused: this.paused,
      stats: this.getStats(),
      current: current
        ? { id: current.id, type: current.type, startedAt: current.startedAt }
        : null,
      events: this.log ? this.log.list(20) : [],
    };
  }

  isIdle() {
    return !this.jobs.some((job) => isActive(job.status));
  }

  // 等待队列清空（退出前使用）。
  whenIdle() {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (!this.isIdle()) return;
        this.off('change', check);
        resolve();
      };
      this.on('change', check);
    });
  }

  flush() {
    return this.writeChain;
  }

  // 唤醒正在等待任务的 Worker（Worker 与队列之间的事件约定）。
  emitWake() {
    this._emit('wake');
  }

  // 通知外部（IPC 广播）刷新 AI 状态。
  notifyChange() {
    this._emitChange();
  }

  // ---- 内部实现 ----

  // 重复 Job 防护：同一个业务键（截图 / 区块）在跑（或已完成）时不再新建，
  // 除非显式重新分析。enqueue / enqueueWithActivity / enqueueWithBlock 共用这一份实现。
  _dedupe(type, key, force) {
    const existing = this._findByKey(type, key);
    if (!existing) return null;

    const active = isActive(existing.status);
    if (!active && (existing.status !== AIJobStatus.COMPLETED || force)) return null;

    this.log?.record(EVENTS.JOB_SKIPPED, { job: existing });
    return {
      job: existing,
      created: false,
      reason: active ? 'DUPLICATE_ACTIVE' : 'ALREADY_COMPLETED',
    };
  }

  _nextPendingJob() {
    let best = null;
    for (const job of this.jobs) {
      if (job.status !== AIJobStatus.PENDING) continue;
      if (!best || job.priority > best.priority) best = job;
    }
    return best;
  }

  // 手动重新生成用的兜底：同一天还在排队或等重试的任务无法被新任务取代（去重会拦住），
  // 先把它们取消掉。正在推理（PROCESSING）的任务按状态机不可取消，此时去重会照常生效。
  _cancelQueuedFor(type, key) {
    for (const job of this.jobs) {
      if (job.type !== type) continue;
      if (jobPayloadKey(job.payload) !== key) continue;
      if (job.status === AIJobStatus.PENDING || job.status === AIJobStatus.RETRYING) {
        this.cancel(job.id);
      }
    }
  }

  // 按幂等键找任务：key 的含义由 jobPayloadKey() 决定（截图 = screenshotId，区块 = blockStart）。
  _findByKey(type, key) {
    if (!key) return null;
    for (let i = this.jobs.length - 1; i >= 0; i -= 1) {
      const job = this.jobs[i];
      if (jobPayloadKey(job.payload) !== key) continue;
      if (type && job.type !== type) continue;
      return job;
    }
    return null;
  }

  _transition(job, status) {
    if (!canTransition(job.status, status)) return false;
    job.status = status;
    return true;
  }

  // 崩溃恢复专用的强制改状态：PROCESSING 不在正常状态机里允许回到 PENDING。
  _recoverStuckJobs() {
    let recovered = 0;
    for (const job of this.jobs) {
      if (job.status !== AIJobStatus.PROCESSING && job.status !== AIJobStatus.RETRYING) continue;
      job.status = AIJobStatus.PENDING;
      job.startedAt = null;
      job.error = null;
      job.lastError = null;
      recovered += 1;
      this.log?.record(EVENTS.JOB_RECOVERED, { job, message: '上次运行未正常结束，恢复为 PENDING' });
    }
    return recovered;
  }

  _pruneTerminalJobs() {
    const terminal = this.jobs.filter((job) => isTerminal(job.status));
    if (terminal.length <= this.maxTerminalJobs) return;
    const drop = new Set(
      terminal.slice(0, terminal.length - this.maxTerminalJobs).map((job) => job.id),
    );
    for (let i = this.jobs.length - 1; i >= 0; i -= 1) {
      if (drop.has(this.jobs[i].id)) this.jobs.splice(i, 1);
    }
  }

  _clearRetryTimers() {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  _persist() {
    // 每次状态变更后都裁剪一次终态历史，避免文件无限增长。
    this._pruneTerminalJobs();
    // 浅拷贝数组：写入总是取最新状态，但不会被后续的数组增删影响。
    this.writeChain = this.repository.save(this.jobs.slice()).catch((error) => {
      this.log?.record(EVENTS.STORAGE_ERROR, {
        errorCode: ERROR_CODES.STORAGE_ERROR,
        message: `Job 持久化失败：${error.message}`,
      });
    });
    return this.writeChain;
  }

  _emit(event, payload) {
    try {
      this.emit(event, payload);
    } catch {
      // 监听方出错不能影响队列自身。
    }
  }

  _emitChange() {
    this._emit('change', this.snapshot());
  }
}

function isUsableJob(job) {
  return Boolean(job && typeof job.id === 'string' && Object.values(AIJobStatus).includes(job.status));
}

function normalizeJob(job) {
  return {
    ...job,
    payload: job.payload || {},
    retryCount: Number.isFinite(job.retryCount) ? job.retryCount : 0,
    maxRetries: Number.isFinite(job.maxRetries) ? job.maxRetries : DEFAULT_MAX_RETRIES,
    priority: Number.isFinite(job.priority) ? job.priority : JOB_PRIORITY.NORMAL,
    error: job.error || null,
    lastError: job.lastError || null,
  };
}

module.exports = {
  AIJobQueueService,
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_MAX_TERMINAL_JOBS,
};
