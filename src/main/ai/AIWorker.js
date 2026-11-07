'use strict';

const { AIError, ERROR_CODES, isRetryable, toAIError } = require('./errors');
const { EVENTS } = require('./jobEventLog');

// 默认并发 1：Qwen3-VL 8B 同时跑多个请求会抢显存，反而拖慢整体。
const DEFAULT_CONCURRENCY = 1;
// Ollama 不在线时的轮询间隔：队列保留 PENDING，不疯狂重试。
const DEFAULT_HEALTH_POLL_MS = 15000;
const DEFAULT_JOB_TIMEOUT_MS = 120000;

// 长期运行的 Worker：一直循环「取任务 -> 交给 AI Provider -> 写回状态」。
// 不是每张截图新建一个 Worker。
class AIWorker {
  constructor({
    queue,
    provider,
    providers = null,
    log = null,
    onCompleted = null,
    onFailed = null,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    healthPollMs = DEFAULT_HEALTH_POLL_MS,
  }) {
    this.queue = queue;
    // 默认 Provider 处理所有任务；providers 按 Job 类型覆盖（Phase 8 的区块汇总走文本 Provider）。
    this.provider = provider;
    this.providers = providers && typeof providers === 'object' ? { ...providers } : {};
    this.log = log;
    this.onCompleted = onCompleted;
    this.onFailed = onFailed;
    this.concurrency = Math.max(1, concurrency);
    this.timeoutMs = timeoutMs;
    this.healthPollMs = healthPollMs;

    this.started = false;
    this.loops = [];
    this.offline = false;
    this.modelAvailable = true;
    // 每个 Provider 的模型可用性，按引用作为键（Provider 是长期对象）。
    this.modelAvailability = new Map();
    this.activeTimer = null;
  }

  // 重复调用 start() 也只会有一个 Worker（避免重复注册 Listener / 重复取任务）。
  start() {
    if (this.started) return;
    this.started = true;
    this.loops = Array.from({ length: this.concurrency }, () => this._loop());
    this.log?.record(EVENTS.WORKER_STARTED, { message: `并发 ${this.concurrency}` });
  }

  // 优雅停止：等在途任务处理完；超时则保留 PROCESSING，下次启动恢复为 PENDING。
  async stop({ timeoutMs = 5000 } = {}) {
    if (!this.started) return;
    this.started = false;
    // 先清掉在途任务的兜底计时器，避免它拖住退出；
    // 该任务会保持 PROCESSING，下次启动时恢复为 PENDING。
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
    const loops = this.loops;
    this.loops = [];
    this.queue.emitWake();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.all(loops.map((loop) => loop.catch(() => {}))), timeout]);
    } finally {
      clearTimeout(timer);
    }
    this.log?.record(EVENTS.WORKER_STOPPED);
  }

  getSnapshot() {
    return {
      workerRunning: this.started,
      offline: this.offline,
      modelAvailable: this.modelAvailable,
    };
  }

  async _loop() {
    while (this.started) {
      if (!this.queue.running || this.queue.paused) {
        await this._waitForWork();
        continue;
      }

      const health = await this._checkHealth();
      if (!health.online) {
        await this._waitForWork();
        continue;
      }

      const job = this.queue.dequeue();
      if (!job) {
        await this._waitForWork();
        continue;
      }

      // 模型不存在是永久性错误：不重试、不阻塞截图，直接把任务判失败。
      const provider = this._providerFor(job);
      if (this.modelAvailability.get(provider) === false) {
        const message = provider.model
          ? `Ollama 中找不到模型 ${provider.model}`
          : 'Ollama 中找不到所需模型';
        await this._failJob(job, new AIError(ERROR_CODES.MODEL_NOT_FOUND, message));
        continue;
      }

      await this._process(job);
    }
  }

  async _process(job) {
    let result;
    try {
      result = await this._runWithTimeout(job);
    } catch (error) {
      await this._handleFailure(job, toAIError(error));
      return;
    }

    try {
      if (this.onCompleted) await this.onCompleted(job, result);
    } catch (error) {
      await this._handleFailure(job, toAIError(error, ERROR_CODES.STORAGE_ERROR));
      return;
    }

    // result.logLine 是 Provider 给的一行摘要，Worker 只负责透传给日志，不解析内容。
    this.queue.complete(job.id, { message: result?.logLine ?? null });
  }

  // 兜底超时：即使 Provider 自己不守时，任务也不会永久卡在 PROCESSING。
  async _runWithTimeout(job) {
    const provider = this._providerFor(job);
    const timeoutMs = this._timeoutFor(job);
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(provider.analyze(job)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new AIError(ERROR_CODES.AI_TIMEOUT, `AI 处理超过 ${timeoutMs}ms`));
          }, timeoutMs);
          this.activeTimer = timer;
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.activeTimer === timer) this.activeTimer = null;
    }
  }

  // 任务用哪个 Provider：按 Job 类型覆盖，没配就退回默认 Provider。
  _providerFor(job) {
    return this.providers[job?.type] ?? this.provider;
  }

  // 兜底超时按 Provider 走：汇总生成约 1000 字，比单张截图分析需要更长的时间预算。
  _timeoutFor(job) {
    const timeoutMs = this._providerFor(job)?.timeoutMs;
    return Number.isFinite(timeoutMs) ? timeoutMs : this.timeoutMs;
  }

  _allProviders() {
    return [this.provider, ...new Set(Object.values(this.providers))];
  }

  async _handleFailure(job, error) {
    if (isRetryable(error) && job.retryCount < job.maxRetries) {
      this.queue.scheduleRetry(job.id, { code: error.code, message: error.message });
      return;
    }
    await this._failJob(job, error);
  }

  async _failJob(job, error) {
    if (this.onFailed) {
      try {
        await this.onFailed(job, error);
      } catch (notifyError) {
        this.log?.record(EVENTS.STORAGE_ERROR, {
          job,
          errorCode: ERROR_CODES.STORAGE_ERROR,
          message: `写入失败状态时出错：${notifyError.message}`,
        });
      }
    }
    this.queue.fail(job.id, { code: error.code, message: error.message });
  }

  async _checkHealth() {
    const providers = this._allProviders();
    const healths = await Promise.all(providers.map((provider) => this._healthOf(provider)));

    // 模型可用性按 Provider 分开判断：汇总模型缺失时不该把截图分析一起判失败（反之亦然）。
    this.modelAvailability = new Map(
      providers.map((provider, index) => [provider, healths[index].modelAvailable]),
    );
    // 所有 Provider 都是同一个 host，任一能连上就说明 Ollama 在线。
    const online = healths.some((health) => health.online);
    // 快照里的 modelAvailable 仍然表示主 Provider（视觉模型）的可用性。
    this.modelAvailable = healths[0].modelAvailable;

    if (online === this.offline) {
      this.offline = !online;
      this.log?.record(this.offline ? EVENTS.AI_OFFLINE : EVENTS.AI_ONLINE);
      this.queue.notifyChange();
    }
    return { online };
  }

  async _healthOf(provider) {
    try {
      const health = await provider.health();
      return {
        online: Boolean(health && health.online),
        modelAvailable: Boolean(health && health.modelAvailable),
      };
    } catch (error) {
      return { online: false, modelAvailable: false, message: error.message };
    }
  }

  _waitForWork(ms = this.healthPollMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.queue.off('wake', finish);
        this.queue.off('paused', finish);
        this.queue.off('resumed', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.queue.once('wake', finish);
      this.queue.once('paused', finish);
      this.queue.once('resumed', finish);
    });
  }
}

module.exports = { AIWorker, DEFAULT_CONCURRENCY, DEFAULT_HEALTH_POLL_MS, DEFAULT_JOB_TIMEOUT_MS };
