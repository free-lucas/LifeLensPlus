'use strict';

// Phase 12 的真实 Electron 冒烟：问答页跑完整链路。
//
//   Renderer（真实 index.html + 真实 preload，靠 executeJavaScript 驱动）
//     -> lifelens:ask
//     -> AskMyLifeService（真实）
//     -> MemorySearchService（真实：BGE-M3 embedding -> 3 张 LanceDB 表 -> SQLite 回查）
//     -> chatWithOllama（真实 Ollama）
//
// 数据：把真实的 lifelens.db 与 lancedb 复制到临时目录再读，全程不碰真实数据。
// 运行：npx electron test/smoke/askMyLifeSmoke.cjs

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { app, BrowserWindow, ipcMain } = require('electron');

const { openDatabase, DB_FILE_NAME } = require('../../src/main/db/database');
const { ActivityRepository } = require('../../src/main/db/repositories/ActivityRepository');
const { TimeBlockRepository } = require('../../src/main/db/repositories/TimeBlockRepository');
const { DiaryRepository } = require('../../src/main/db/repositories/DiaryRepository');
const { StatsRepository } = require('../../src/main/db/repositories/StatsRepository');
const { JobEventLog } = require('../../src/main/ai/jobEventLog');
const { LocalEmbeddingProvider } = require('../../src/main/embedding/localProvider');
const { LanceStore } = require('../../src/main/embedding/lanceStore');
const { MemoryVectorRepository } = require('../../src/main/embedding/MemoryVectorRepository');
const { MemorySearchService } = require('../../src/main/search/MemorySearchService');
const { AskMyLifeService } = require('../../src/main/ask/AskMyLifeService');
const { BLOCK_MINUTES } = require('../../src/main/summary/timeBlock');
const { registerTimelineIpc } = require('../../src/main/timelineIpc');
const { registerSummaryIpc } = require('../../src/main/summaryIpc');
const { registerDiaryIpc } = require('../../src/main/diaryIpc');
const { registerStatsIpc } = require('../../src/main/statsIpc');
const { registerSearchIpc } = require('../../src/main/searchIpc');

// 真实应用的 userData 是 %APPDATA%/lifelens-plus：脚本里要显式指定，
// 否则 Electron 会按「无 package.json 的入口脚本」把它算成 %APPDATA%/Electron。
app.setName('lifelens-plus');

const REAL_OUTPUT_DIR = process.env.LIFELENS_DIR
  || path.join(app.getPath('pictures'), 'LifeLensPlus');

const QUESTION = '最近一段时间我主要在做什么？';
const GENERATE_TIMEOUT_MS = 240000;

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function copyRealData(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const dbFile = path.join(REAL_OUTPUT_DIR, DB_FILE_NAME);
  if (!fs.existsSync(dbFile)) {
    throw new Error(`找不到真实数据库：${dbFile}`);
  }
  // WAL / SHM 一起复制，未 checkpoint 的数据才不会丢。
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${dbFile}${suffix}`;
    if (fs.existsSync(from)) await fsp.copyFile(from, path.join(dir, `${DB_FILE_NAME}${suffix}`));
  }

  const realLance = path.join(app.getPath('userData'), 'lancedb');
  if (!fs.existsSync(realLance)) {
    throw new Error(`找不到真实向量库：${realLance}`);
  }
  await fsp.cp(realLance, path.join(dir, 'lancedb'), { recursive: true });
  return path.join(dir, 'lancedb');
}

async function buildMain({ dir }) {
  const lancedbDir = await copyRealData(dir);
  const log = new JobEventLog({ sink: { log: (line) => console.log(line) } });
  const db = openDatabase({ file: path.join(dir, DB_FILE_NAME), log: () => {} });
  const activities = new ActivityRepository({ db, log });
  const timeBlocks = new TimeBlockRepository({ db, log, blockMinutes: BLOCK_MINUTES });
  const diaries = new DiaryRepository({ db, log });
  const stats = new StatsRepository({ db, log, blockMinutes: BLOCK_MINUTES });

  const provider = new LocalEmbeddingProvider({
    ollamaHost: process.env.LIFELENS_OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: process.env.LIFELENS_EMBEDDING_MODEL || 'bge-m3',
    timeoutMs: 60000,
  });
  const store = new LanceStore({ dir: lancedbDir });
  await store.open();
  const vectors = {
    activity: new MemoryVectorRepository({ store, tableName: 'activity_vectors' }),
    block: new MemoryVectorRepository({ store, tableName: 'block_vectors' }),
    diary: new MemoryVectorRepository({ store, tableName: 'diary_vectors' }),
  };

  const search = new MemorySearchService({
    provider, vectors, activities, timeBlocks, diaries, log,
  });
  const askService = new AskMyLifeService({
    search,
    ollamaHost: process.env.LIFELENS_OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: process.env.LIFELENS_SUMMARY_MODEL || 'qwen3-vl:8b',
    timeoutMs: 300000,
    numCtx: 16384,
  });

  return { db, store, activities, timeBlocks, diaries, stats, search, askService };
}

function registerIpc({ activities, timeBlocks, diaries, stats, search, askService, mode }) {
  const status = {
    running: false,
    busy: false,
    queue: 0,
    count: 0,
    total: 0,
    analyzed: 0,
    errors: 0,
    skipped: 0,
    lastCaptureAt: null,
    lastError: null,
    outputDir: REAL_OUTPUT_DIR,
    model: 'qwen3-vl:8b',
    intervalMs: 20000,
  };

  // 录制与 AI 队列在这个冒烟里没有意义，给最小可用的形状即可。
  ipcMain.handle('lifelens:status', () => status);
  ipcMain.handle('lifelens:start', () => status);
  ipcMain.handle('lifelens:stop', () => status);
  ipcMain.handle('lifelens:toggle', () => status);
  ipcMain.handle('lifelens:recent', () => []);
  ipcMain.handle('lifelens:ai-status', () => null);
  ipcMain.handle('lifelens:ai-pause', () => null);
  ipcMain.handle('lifelens:ai-resume', () => null);
  ipcMain.handle('lifelens:ai-reanalyze', () => ({ created: false, reason: 'smoke' }));
  ipcMain.handle('lifelens:open-output-dir', () => '');
  ipcMain.handle('lifelens:open-image', () => '');

  // 页面用到的数据通道全部走真实实现（真实 IPC 注册函数 + 真实仓储）。
  registerTimelineIpc({ ipcMain, activities });
  registerSummaryIpc({ ipcMain, timeBlocks, summarizer: { snapshot: () => null } });
  registerDiaryIpc({
    ipcMain,
    diaries,
    timeBlocks,
    activities,
    generator: { snapshot: () => null, regenerate: () => ({ created: false }) },
  });
  registerStatsIpc({ ipcMain, stats });
  registerSearchIpc({ ipcMain, getSearch: () => search });

  // 问答通道：mode='broken' 用来把「生成失败」这条路径也真跑一遍。
  ipcMain.handle('lifelens:ask', async (_event, payload) => {
    if (mode.value === 'broken') {
      throw new Error('已经找到相关记忆，但当前无法生成回答：模拟的模型故障');
    }
    return askService.ask(payload?.question);
  });
}

// 生成一次要十几秒到几十秒：轮询到回答或失败为止。
async function waitForAnswer(win) {
  const deadline = Date.now() + GENERATE_TIMEOUT_MS;
  for (;;) {
    const state = await win.webContents.executeJavaScript(`(() => {
      const answer = document.getElementById('ask-answer');
      return { text: answer ? answer.textContent : '', html: answer ? answer.innerHTML : '' };
    })()`);
    const done = state.text.includes('依据充分程度') || state.text.includes('提问失败');
    if (done || Date.now() > deadline) return state;
    await sleep(1000);
  }
}

async function run() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lifelens-ask-smoke-'));
  const main = await buildMain({ dir });
  const mode = { value: 'real' };
  registerIpc({ ...main, mode });

  const win = new BrowserWindow({
    width: 1040,
    height: 880,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));
  // 等渲染层的两个视图对象挂上去（search.js 先、ask.js 后）。
  for (let index = 0; index < 100; index += 1) {
    const ready = await win.webContents.executeJavaScript(
      'Boolean(window.lifelensAsk && window.lifelensTimeline && window.lifelensTabs)',
    );
    if (ready) break;
    await sleep(100);
  }

  console.log(`\n=== 真实 Electron 冒烟：问答页 ===\n问题：${QUESTION}\n`);

  // 1. 标签页
  const beforeTabs = await win.webContents.executeJavaScript(`(() => {
    const tab = document.querySelector('.tab[data-tab="ask"]');
    return { exists: Boolean(tab), label: tab ? tab.textContent.trim() : '' };
  })()`);
  check('「问答」标签页存在', beforeTabs.exists, `标签文案：${beforeTabs.label}`);

  const opened = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.tab[data-tab="ask"]').click();
    return {
      askVisible: !document.getElementById('view-ask').hidden,
      overviewHidden: document.getElementById('view-overview').hidden,
    };
  })()`);
  check('点标签页切到问答页', opened.askVisible && opened.overviewHidden);

  // 2. 直接走一次 IPC：服务层返回结构（相关记忆的字段也从这里确认）
  const payload = await win.webContents.executeJavaScript(
    `window.lifelens.ask(${JSON.stringify(QUESTION)})`,
  );
  check('IPC 返回回答', typeof payload?.answer === 'string' && payload.answer.trim() !== '',
    `confidence=${payload?.confidence}`);
  check('confidence 在枚举内', ['high', 'medium', 'low'].includes(payload?.confidence));
  check('IPC 返回相关记忆', Array.isArray(payload?.memories) && payload.memories.length > 0,
    `相关记忆 ${payload?.memories?.length ?? 0} 条，用时 ${payload?.elapsedMs}ms，模型 ${payload?.model}`);
  const first = payload?.memories?.[0];
  check('相关记忆带跳转所需字段',
    Boolean(first?.sourceType && first?.sourceLabel && first?.time && first?.day),
    `首条：${first?.sourceType} / ${first?.sourceLabel} / ${first?.time} / timelineId=${first?.timelineId}`);
  console.log(`\n--- 服务层回答 ---\n${payload?.answer}\n`);

  // 3. 页面交互：loading
  const loading = await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('ask-input');
    const submit = document.getElementById('ask-submit');
    input.value = ${JSON.stringify(QUESTION)};
    submit.click();
    return {
      disabled: submit.disabled,
      answer: document.getElementById('ask-answer').textContent,
      status: document.getElementById('ask-status').textContent,
    };
  })()`);
  check('生成期间按钮禁用、出现 loading 文案',
    loading.disabled === true && loading.answer.includes('正在检索记忆并生成回答'),
    `按钮 disabled=${loading.disabled}，状态栏：${loading.status}`);

  // 4. 等真实模型出结果
  const answerState = await waitForAnswer(win);
  check('回答渲染到页面上',
    answerState.text.includes('依据充分程度') && !answerState.html.includes('Error invoking remote method'),
    `页面文本：${answerState.text.replace(/\s+/g, ' ').trim()}`);
  console.log(`\n--- 页面上的回答 ---\n${answerState.text.replace(/\s+/g, ' ').trim()}\n`);

  const memories = await win.webContents.executeJavaScript(`(() => {
    const wrap = document.getElementById('ask-memories-wrap');
    const cards = Array.from(document.querySelectorAll('#ask-memories .search-card'));
    return {
      hidden: wrap.hidden,
      count: cards.length,
      firstText: cards[0] ? cards[0].textContent.replace(/\\s+/g, ' ').trim() : '',
      firstSource: cards[0] ? (cards[0].querySelector('.search-source') || {}).className : '',
    };
  })()`);
  check('相关记忆列表画出来了', memories.hidden === false && memories.count > 0,
    `${memories.count} 张卡片，首条：${memories.firstText}`);

  // 5. 点相关记忆跳转（activity/block -> 时间线定位，diary -> 日记页）
  const jump = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#ask-memories .search-card');
    card.click();
    return {
      source: (card.querySelector('.search-source') || {}).textContent || '',
      onOverview: !document.getElementById('view-overview').hidden,
      onDiary: !document.getElementById('view-diary').hidden,
      hasFocusBanner: Boolean(document.querySelector('.timeline-focus')),
      status: document.getElementById('ask-status').textContent,
    };
  })()`);
  const jumped = memories.firstSource.includes('search-source-diary')
    ? jump.onDiary
    : jump.onOverview && jump.hasFocusBanner;
  check('点相关记忆跳转到对应页面', jumped,
    `来源=${jump.source} 记录页=${jump.onOverview} 日记页=${jump.onDiary} 定位横幅=${jump.hasFocusBanner}`);

  // 6. 失败路径：模型不可用时页面给可读原因，且不白屏
  mode.value = 'broken';
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.tab[data-tab="ask"]').click();
    document.getElementById('ask-submit').click();
  })()`);
  const failed = await waitForAnswer(win);
  const afterFailure = await win.webContents.executeJavaScript(`(() => ({
    submitDisabled: document.getElementById('ask-submit').disabled,
    statusClass: document.getElementById('ask-status').className,
    askVisible: !document.getElementById('view-ask').hidden,
    memoriesHidden: document.getElementById('ask-memories-wrap').hidden,
  }))()`);
  check('生成失败给可读原因且页面不白屏',
    failed.text.includes('提问失败')
      && failed.text.includes('已经找到相关记忆，但当前无法生成回答')
      && afterFailure.askVisible
      && afterFailure.submitDisabled === false,
    `页面文本：${failed.text.replace(/\s+/g, ' ').trim()}，状态栏 class=${afterFailure.statusClass}`);

  // 7. 主进程日志（真实输出）
  console.log('\n--- 结果 ---');
  console.log(`PASS ${results.filter((item) => item.ok).length} / FAIL ${failures}`);

  win.destroy();
  main.store.close();
  main.db.close();
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  return failures;
}

app.whenReady().then(async () => {
  // 硬超时：真实模型再慢也不该超过这个时间。
  const guard = setTimeout(() => {
    console.error('FAIL  冒烟超时');
    app.exit(2);
  }, 420000);
  guard.unref?.();

  try {
    const failures = await run();
    app.exit(failures === 0 ? 0 : 1);
  } catch (error) {
    console.error(`FAIL  冒烟异常：${error?.stack ?? error}`);
    app.exit(2);
  }
});
