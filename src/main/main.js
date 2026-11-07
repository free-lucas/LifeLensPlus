'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } = require('electron');

const { loadConfig } = require('./config');
const { Store } = require('./store');
const { Recorder } = require('./recorder');
const { prepareBufferForAnalysis } = require('./capture');
const { openDatabase, closeDatabase, DB_FILE_NAME } = require('./db/database');
const { ActivityRepository } = require('./db/repositories/ActivityRepository');
const { AIJobRepository } = require('./db/repositories/AIJobRepository');
const { TimeBlockRepository } = require('./db/repositories/TimeBlockRepository');
const { DiaryRepository } = require('./db/repositories/DiaryRepository');
const { StatsRepository } = require('./db/repositories/StatsRepository');
const { AIJobQueueService } = require('./ai/AIJobQueueService');
const { AIWorker } = require('./ai/AIWorker');
const { OllamaVisionProvider } = require('./ai/visionProvider');
const { OllamaSummaryProvider } = require('./ai/summaryProvider');
const { OllamaDiaryProvider } = require('./ai/diaryProvider');
const { AIJobType } = require('./ai/job');
const { ERROR_CODES } = require('./ai/errors');
const { JobEventLog, EVENTS } = require('./ai/jobEventLog');
const { BLOCK_MINUTES } = require('./summary/timeBlock');
const { TimeBlockSummarizer } = require('./summary/TimeBlockSummarizer');
const { DiaryGenerator } = require('./diary/DiaryGenerator');
const { LocalEmbeddingProvider } = require('./embedding/localProvider');
const { LanceStore } = require('./embedding/lanceStore');
const { MemoryVectorRepository } = require('./embedding/MemoryVectorRepository');
const { EmbeddingSourceRepository } = require('./embedding/EmbeddingSourceRepository');
const { EmbeddingService } = require('./embedding/EmbeddingService');
const { MemorySearchService } = require('./search/MemorySearchService');
const { AskMyLifeService } = require('./ask/AskMyLifeService');
const { registerTimelineIpc } = require('./timelineIpc');
const { registerSummaryIpc } = require('./summaryIpc');
const { registerDiaryIpc } = require('./diaryIpc');
const { registerStatsIpc } = require('./statsIpc');
const { registerSearchIpc } = require('./searchIpc');
const { registerAskIpc } = require('./askIpc');
const {
  LAUNCHER_SIZE, createLauncherWindow, registerLauncherIpc, showOrFocusMainWindow,
} = require('./launcher/launcherWindow');
const {
  POSITION_FILE_NAME, clampToWorkArea, createPositionStore, defaultLauncherPosition,
} = require('./launcher/launcherPosition');
const { LAUNCHER_EVENT_CHANNEL, launcherEventOf } = require('./launcher/launcherEvents');

let mainWindow = null;
let recorder = null;
let config = null;
let store = null;
let db = null;
let activities = null;
let timeBlocks = null;
let diaries = null;
let stats = null;
let aiQueue = null;
let aiWorker = null;
let summarizer = null;
let diaryGenerator = null;
let embedding = null;
let search = null;
let ask = null;
let vectorStore = null;
let jobLog = null;
let launcherWindow = null;
let launcherStore = null;

// 只允许单实例：两个进程会同时截屏、同时写同一个 SQLite 库。
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

// Phase 13.1：悬浮入口的事件通道。只把特效需要的字段发过去（见 launcherEventOf），
// 不转发 record / analysis 详情，也不发 ai 快照——56x56 的窗口不需要知道这些。
// 位置信息一律不进这条通道。
function broadcastLauncher(payload) {
  const event = launcherEventOf(payload);
  if (!event) return;
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  try {
    launcherWindow.webContents.send(LAUNCHER_EVENT_CHANNEL, event);
  } catch {
    // 与 broadcast 同理：通知失败不能影响录制循环。
  }
}

function broadcast(payload) {
  // 主窗口：完整事件（行为不变）。
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('lifelens:event', payload);
    } catch {
      // 窗口正在销毁时 send 会抛错，忽略即可：不能让录制循环因此中断。
    }
  }
  // 悬浮入口：裁剪后的特效事件。主窗口关掉（隐藏或销毁）时它仍然要收到。
  broadcastLauncher(payload);
}

// 界面上的 AI 状态 = 队列快照 + Worker 快照。
function aiStatus() {
  if (!aiQueue) return null;
  return { ...aiQueue.snapshot(), ...aiWorker.getSnapshot() };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 880,
    title: 'LifeLensPlus',
    backgroundColor: '#12161f',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Phase 13：关闭主窗口不再销毁它（也不再销毁进程），只隐藏；悬浮入口继续留在桌面上。
  // 显式退出时 quitting 已经置位，这里放行，让 before-quit 的收尾流程原样走完。
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 三处共用（launcher 点击 / second-instance / macOS activate）：
// 窗口没了就重建，隐藏或最小化就显示并聚焦，已经可见就只聚焦。
function showMainWindow() {
  return showOrFocusMainWindow({ getWindow: () => mainWindow, createWindow });
}

// Phase 13：悬浮入口常驻桌面。
// 位置写在 userData 下的 launcher-position.json（不是 outputDir，也不进 SQLite）；
// 读不到就用主屏右下角的默认位置，能读到的一律先按当前显示器校正一次。
async function createLauncher() {
  launcherStore = createPositionStore({
    filePath: path.join(app.getPath('userData'), POSITION_FILE_NAME),
    fs,
  });
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const saved = await launcherStore.load();
  const fallback = defaultLauncherPosition(screen.getPrimaryDisplay().workArea, LAUNCHER_SIZE);

  launcherWindow = createLauncherWindow({
    ...clampToWorkArea(saved ?? fallback, LAUNCHER_SIZE, workAreas),
    isQuitting: () => quitting,
  });

  registerLauncherIpc({
    ipcMain,
    getLauncherWindow: () => launcherWindow,
    showOrFocusMainWindow: showMainWindow,
    savePosition: (position) => launcherStore.save(position),
    getWorkAreas: () => screen.getAllDisplays().map((display) => display.workArea),
    // 右键菜单：录制状态现取现用；暂停 / 恢复复用已有的 recorder.toggle()；
    // 退出走 app.quit()，before-quit 的优雅收尾流程一行都不用改。
    getRecording: () => recorder?.running === true,
    toggleRecording: () => recorder?.toggle(),
    quitApp: () => app.quit(),
    menu: Menu,
  });

  // 启动时 recorder 已经发过一次 status，但那时 launcher 还没创建。
  // 首帧画完补发一次当前状态，否则圆标会显示出与实际不符的「录制中」。
  launcherWindow.webContents.once('did-finish-load', () => {
    broadcastLauncher({ type: 'status', status: recorder?.status ?? { running: false } });
  });
}

function registerIpc() {
  ipcMain.handle('lifelens:status', () => recorder.status);

  ipcMain.handle('lifelens:start', () => recorder.start());
  ipcMain.handle('lifelens:stop', () => recorder.stop());
  ipcMain.handle('lifelens:toggle', () => recorder.toggle());

  ipcMain.handle('lifelens:recent', async (_event, limit) => {
    const size = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
    return activities.listRecent(size);
  });

  // ---- Timeline（Phase 7.1）：按时间范围 / 分页读取 Activity ----
  registerTimelineIpc({ ipcMain, activities });

  // ---- 动态（Phase 8）：10 分钟区块查询、筛选选项与汇总状态 ----
  registerSummaryIpc({ ipcMain, timeBlocks, summarizer });

  // ---- 日记（Phase 9）：某一天的日记、日历标记、生成状态与重新生成 ----
  registerDiaryIpc({ ipcMain, diaries, timeBlocks, activities, generator: diaryGenerator });

  // ---- 看板（Phase 9）：日 / 周 / 月 / 年的多维度统计 ----
  registerStatsIpc({ ipcMain, stats });

  // ---- 搜索（Phase 11）：跨三层记忆的语义检索 ----
  registerSearchIpc({ ipcMain, getSearch: () => search });

  // ---- 问答（Phase 12）：检索相关记忆后由本地模型基于这些记忆回答 ----
  registerAskIpc({ ipcMain, getAsk: () => ask });

  ipcMain.handle('lifelens:open-output-dir', async () => {
    await fs.mkdir(config.outputDir, { recursive: true });
    const error = await shell.openPath(config.outputDir);
    if (error) throw new Error(error);
    return config.outputDir;
  });

  ipcMain.handle('lifelens:open-image', async (_event, file) => {
    const target = path.resolve(String(file || ''));
    const root = path.resolve(config.outputDir);
    if (!target.startsWith(root + path.sep)) {
      throw new Error('只能打开保存目录内的图片');
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return target;
  });

  // ---- AI 队列 ----
  ipcMain.handle('lifelens:ai-status', () => aiStatus());

  ipcMain.handle('lifelens:ai-pause', () => {
    aiQueue.pause();
    return aiStatus();
  });

  ipcMain.handle('lifelens:ai-resume', () => {
    aiQueue.resume();
    return aiStatus();
  });

  // 重新分析：为历史截图重建一个高优先级任务（UI 由后续阶段接入）。
  ipcMain.handle('lifelens:ai-reanalyze', async (_event, screenshotId) => {
    const result = await aiQueue.reanalyzeScreenshot(String(screenshotId || ''));
    return { created: result.created, reason: result.reason ?? null };
  });

  // ---- 退出（Phase 13）----
  // 悬浮入口常驻之后，关窗口不再等于退出，主界面需要一个显式入口。
  // 这里只调 app.quit()：录制收尾 / 向量库 / SQLite 的关闭全部由 before-quit 原样执行。
  ipcMain.handle('lifelens:quit', () => {
    app.quit();
  });
}

// 本地记忆索引（Phase 10 写入 / Phase 11 检索）：三层记忆的向量索引。
// SQLite 仍是唯一事实来源，LanceDB 只是可随时重建的语义索引；
// 装配失败（原生模块装不上 / 目录不可写）只记日志并降级为 null，截图与 AI 链路照常工作。
async function createMemoryIndex() {
  const provider = new LocalEmbeddingProvider({
    ollamaHost: config.ollamaHost,
    model: config.embeddingModel,
    dimension: config.embeddingDimension,
    timeoutMs: config.embeddingTimeoutMs,
  });

  vectorStore = new LanceStore({
    dir: path.join(app.getPath('userData'), 'lancedb'),
    log: (message) => console.log(`[LanceDB] ${message}`),
  });
  // 提前打开一次：原生模块与目录的问题在这里就暴露出来，而不是等到第一次写入。
  await vectorStore.open();

  const sources = {
    activity: new EmbeddingSourceRepository({ db, layer: 'activity', log: jobLog }),
    block: new EmbeddingSourceRepository({ db, layer: 'block', log: jobLog }),
    diary: new EmbeddingSourceRepository({ db, layer: 'diary', log: jobLog }),
  };
  const vectors = {
    activity: new MemoryVectorRepository({ store: vectorStore, tableName: 'activity_vectors' }),
    block: new MemoryVectorRepository({ store: vectorStore, tableName: 'block_vectors' }),
    diary: new MemoryVectorRepository({ store: vectorStore, tableName: 'diary_vectors' }),
  };

  return {
    embedding: new EmbeddingService({
      provider,
      sources,
      vectors,
      log: jobLog,
      batchSize: config.embeddingBatchSize,
      scanIntervalMs: config.embeddingScanIntervalMs,
      maxBatchesPerScan: config.embeddingMaxBatchesPerScan,
    }),
    // 检索与写入共用同一个 Provider 与同一批向量仓储：维度校验、换模型的语义完全一致。
    search: new MemorySearchService({
      provider,
      vectors,
      activities,
      timeBlocks,
      diaries,
      log: jobLog,
    }),
  };
}

app.whenReady().then(async () => {
  if (!singleInstance) return;
  config = loadConfig();
  jobLog = new JobEventLog();

  // 启动顺序（第 26 / 32 节）：打开数据库 -> schema migration -> repositories ->
  // 恢复未完成的 Job（queue.start()）-> 启动 Worker。
  try {
    db = openDatabase({ file: path.join(config.outputDir, DB_FILE_NAME) });
    activities = new ActivityRepository({ db, log: jobLog });
    timeBlocks = new TimeBlockRepository({ db, log: jobLog, blockMinutes: BLOCK_MINUTES });
    diaries = new DiaryRepository({ db, log: jobLog });
    stats = new StatsRepository({ db, log: jobLog, blockMinutes: BLOCK_MINUTES });
  } catch (error) {
    jobLog.record(EVENTS.STORAGE_ERROR, {
      errorCode: ERROR_CODES.STORAGE_ERROR,
      message: `数据库初始化失败：${error.message}`,
    });
    // 没有主存储就继续运行只会安静地丢数据，这里明确失败并告诉用户。
    dialog.showErrorBox('LifeLensPlus 无法启动', `本地数据库初始化失败：\n${error.message}`);
    app.quit();
    return;
  }

  store = new Store(config.outputDir);

  aiQueue = new AIJobQueueService({
    repository: new AIJobRepository({ db, activities, log: jobLog }),
    activities,
    timeBlocks,
    diaries,
    log: jobLog,
    retryDelaysMs: config.aiRetryDelaysMs,
    maxTerminalJobs: config.aiMaxTerminalJobs,
  });

  const visionProvider = new OllamaVisionProvider({
    ollamaHost: config.ollamaHost,
    model: config.model,
    timeoutMs: config.analyzeTimeoutMs,
    prepareImage: prepareBufferForAnalysis,
    numCtx: config.numCtx,
  });

  // 区块汇总的素材在执行时才读：区块刚结束时，最后几张截图可能还在分析队列里。
  const summaryProvider = new OllamaSummaryProvider({
    ollamaHost: config.ollamaHost,
    model: config.summaryModel,
    timeoutMs: config.summaryTimeoutMs,
    numCtx: config.numCtx,
    loadContext: ({ blockStart, blockEnd }) => ({
      records: activities.listSummaryContext(blockStart, blockEnd),
      previous: timeBlocks.findPreviousSummary(blockStart),
    }),
  });

  // 日记的素材同样在执行时才读：一整天的区块 + 上一天已生成的日记。
  const diaryProvider = new OllamaDiaryProvider({
    ollamaHost: config.ollamaHost,
    model: config.diaryModel,
    timeoutMs: config.diaryTimeoutMs,
    numCtx: config.numCtx,
    loadContext: ({ day, from, to }) => ({
      blocks: timeBlocks.listBlocksBetween(from, to),
      previous: diaries.findPreviousDiary(day),
    }),
  });

  recorder = new Recorder({ store, activities, config, onEvent: broadcast, aiQueue, log: jobLog });

  summarizer = new TimeBlockSummarizer({
    queue: aiQueue,
    timeBlocks,
    log: jobLog,
    // 区块汇总状态变化时顺手通知日记生成器：那一天所有区块刚汇总完的那一刻，
    // 就是生成这一天日记的最佳时机（不必等下一次扫描）。
    onEvent: (payload) => {
      broadcast(payload);
      diaryGenerator?.notifyBlocksChanged();
    },
    scanLimit: config.summaryScanLimit,
  });

  diaryGenerator = new DiaryGenerator({
    queue: aiQueue,
    diaries,
    timeBlocks,
    log: jobLog,
    onEvent: broadcast,
    scanLimit: config.diaryScanLimit,
  });

  // 记忆索引：三层记忆各自扫描待嵌入记录。装配失败只降级，不影响主链路。
  try {
    const memoryIndex = await createMemoryIndex();
    embedding = memoryIndex.embedding;
    search = memoryIndex.search;
  } catch (error) {
    jobLog.record(EVENTS.EMBEDDING_ERROR, {
      errorCode: error.code ?? ERROR_CODES.UNKNOWN,
      message: `Embedding 服务未能启动，记录保持 PENDING：${error.message}`,
    });
    vectorStore?.close();
    vectorStore = null;
    embedding = null;
    search = null;
  }

  // 问答复用检索那一个 search 实例（检索 + 回查 SQLite 都在它内部完成，不注入任何 Repository）；
  // 检索装配失败时它是 null，askIpc 会给出可读错误。chat 默认是 analyzer.js 的 chatWithOllama。
  ask = search
    ? new AskMyLifeService({
      search,
      ollamaHost: config.ollamaHost,
      model: config.summaryModel,
      timeoutMs: config.summaryTimeoutMs,
      numCtx: config.numCtx,
    })
    : null;

  aiWorker = new AIWorker({
    queue: aiQueue,
    provider: visionProvider,
    // 汇总任务走文本 Provider，截图分析仍然走视觉 Provider。
    providers: {
      [AIJobType.TIMEBLOCK_SUMMARY]: summaryProvider,
      [AIJobType.DIARY_GENERATION]: diaryProvider,
    },
    log: jobLog,
    concurrency: config.aiConcurrency,
    timeoutMs: config.analyzeTimeoutMs,
    healthPollMs: config.aiHealthPollMs,
    onCompleted: (job, result) => {
      if (job.type === AIJobType.TIMEBLOCK_SUMMARY) return summarizer.handleResult(job, result);
      if (job.type === AIJobType.DIARY_GENERATION) return diaryGenerator.handleResult(job, result);
      return recorder.handleAnalysisResult(job, result);
    },
    onFailed: (job, error) => {
      if (job.type === AIJobType.TIMEBLOCK_SUMMARY) return summarizer.handleFailure(job, error);
      if (job.type === AIJobType.DIARY_GENERATION) return diaryGenerator.handleFailure(job, error);
      return recorder.handleAnalysisFailure(job, error);
    },
  });

  aiQueue.on('change', () => broadcast({ type: 'ai', ai: aiStatus() }));

  registerIpc();
  createWindow();

  // 先恢复队列再启动 Worker：上次没跑完的任务会重新变成 PENDING 并继续执行。
  await aiQueue.start();
  aiWorker.start();

  // 启动补偿：记录已经落盘、但没有对应 AI Job 的截图，在这里补建任务。
  // 历史记录可能很多，放到后台扫描，不阻塞窗口和截图。
  recorder.recoverPendingAnalyses();

  // 区块汇总：先补上应用没运行时留下的时间段，再按 10 分钟边界持续扫描。
  summarizer.start();

  // 日记：先补上应用没运行时留下的日期，之后在每个午夜边界再扫一次。
  diaryGenerator.start();

  // 记忆索引：启动补偿 + 立刻补一轮历史存量，之后按固定间隔持续扫描。
  embedding?.start();

  if (config.autoStart) recorder.start();

  // 悬浮入口：主窗口照常显示，两个窗口同时出现（启动行为不变）。
  await createLauncher();

  app.on('activate', () => {
    // launcher 常驻后 getAllWindows() 永远不为空，所以交给 showMainWindow() 判断。
    showMainWindow();
  });
});

app.on('second-instance', () => {
  // 主窗口可能是隐藏的（关窗口只是隐藏），只 focus 唤不出来，统一走 showMainWindow()。
  showMainWindow();
});

let quitting = false;

app.on('before-quit', async (event) => {
  if (quitting || !recorder) return;
  quitting = true;
  // 停止排期，并等在途的这一轮写完记录，避免退出时丢掉最后一条。
  event.preventDefault();
  recorder.stop();
  try {
    await Promise.race([
      recorder.whenIdle(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    // 停止接受新任务；在途任务来不及完成就保留 PROCESSING，下次启动恢复为 PENDING。
    summarizer.stop();
    diaryGenerator.stop();
    embedding?.stop();
    aiQueue.stop();
    await aiWorker.stop({ timeoutMs: 8000 });
    await aiQueue.flush();
    // 等在途的 embedding 批次收尾，再关向量库；最后才关 SQLite（状态回写都依赖它）。
    await embedding?.flush();
    vectorStore?.close();
    vectorStore = null;
    // Worker / Recorder 都停了，flush 也完成了，这时才关库：
    // 保证 close() 之后不会再有 UPDATE ai_jobs。
    closeDatabase(db);
    db = null;
  } catch {
    // 退出流程不再抛错。
  } finally {
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
