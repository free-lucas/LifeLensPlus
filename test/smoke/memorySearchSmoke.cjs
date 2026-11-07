'use strict';

// Phase 11 真实 Electron 冒烟：Renderer -> Preload -> IPC -> Main -> LanceDB -> SQLite。
//
// 与 npm test 分开：这条链路要真的起一个 Electron 进程，所以放在 test/smoke/ 下，
// 不会被 `node --test test/*.test.js` 收进常规测试。
//
// 运行：node test/smoke/memorySearchSmoke.cjs
// 依赖：本机没有 Ollama 也能跑（脚本自己起一个假的 Ollama，只实现 /api/tags 与 /api/embed）。
//
// 覆盖：应用启动 -> 三层记忆自动嵌入 -> 向量库落盘 -> 界面里搜索 -> 点结果跳转。

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { openDatabase } = require('../../src/main/db/database');
const { ActivityRepository } = require('../../src/main/db/repositories/ActivityRepository');
const { TimeBlockRepository } = require('../../src/main/db/repositories/TimeBlockRepository');
const { DiaryRepository } = require('../../src/main/db/repositories/DiaryRepository');
const { createJob, AIJobType } = require('../../src/main/ai/job');
const { formatLocalIso } = require('../../src/main/time');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DEBUG_PORT = 9333;
const DIMENSION = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 假的 Ollama：/api/tags 报告模型可用，/api/embed 按关键词给确定性向量 ----
// 关键词桶让「语义检索」在冒烟里可断言：查 SQLite 一定命中 SQLite 的记录。
const BUCKETS = [
  ['sqlite', '数据库', '数据层', '迁移', 'repository', '事务'],
  ['agent', '智能体', 'ai '],
  ['bge', 'embedding', '向量', '检索'],
  ['日记', '一天', '总结'],
  ['散步', '休息', '公园'],
];

function embed(text) {
  const lowered = String(text ?? '').toLowerCase();
  const vector = new Array(DIMENSION).fill(0);
  BUCKETS.forEach((words, index) => {
    if (words.some((word) => lowered.includes(word))) vector[index] = 1;
  });
  if (!vector.some((value) => value !== 0)) vector[DIMENSION - 1] = 1;
  return vector;
}

function startFakeOllama() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const send = (status, payload) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (request.url.startsWith('/api/tags')) {
        send(200, { models: [{ name: 'fake-embed:latest' }, { name: 'qwen3-vl:8b' }] });
        return;
      }
      if (request.url.startsWith('/api/embed')) {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          let inputs = [];
          try {
            const payload = JSON.parse(body || '{}');
            inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
          } catch {
            send(400, { error: 'bad json' });
            return;
          }
          send(200, { embeddings: inputs.map(embed) });
        });
        return;
      }
      send(404, { error: 'not found' });
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---- 预置三层记忆（都是「已完成」的真实形状）----

function dayKeyOf(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function seedDatabase(dataDir) {
  const db = openDatabase({ file: path.join(dataDir, 'lifelens.db'), log: () => {} });
  const activities = new ActivityRepository({ db });
  const timeBlocks = new TimeBlockRepository({ db, blockMinutes: 10 });
  const diaries = new DiaryRepository({ db });

  // 「昨天」的区块与日记：日记页默认打开前一天，冒烟里点的也是这一天。
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(13, 0, 0, 0);
  const blockStart = formatLocalIso(yesterday);
  const blockEnd = formatLocalIso(new Date(yesterday.getTime() + 10 * 60000));
  const day = dayKeyOf(yesterday);

  const records = [
    {
      id: 'smoke-agent',
      time: formatLocalIso(new Date(yesterday.getTime() + 1000)),
      analysis: {
        activity: '研究 AI Agent 的记忆架构',
        summary: '对比几种记忆分层方案，记下要验证的问题',
        category: 'coding',
        project: 'AI Agent 研究',
        keywords: ['AI Agent', '记忆架构'],
        confidence: 0.9,
      },
    },
    {
      id: 'smoke-sqlite',
      time: blockStart,
      analysis: {
        activity: '调试 SQLite 向量检索',
        summary: '把 LanceDB 的检索结果与 SQLite 记录对齐',
        category: 'coding',
        project: 'Life Lens',
        keywords: ['SQLite', 'LanceDB'],
        confidence: 0.85,
      },
    },
    {
      id: 'smoke-walk',
      time: formatLocalIso(new Date(yesterday.getTime() + 4 * 3600000)),
      analysis: {
        activity: '在公园散步',
        summary: '午休出去走了一圈',
        category: 'life',
        project: null,
        keywords: ['散步'],
        confidence: 0.8,
      },
    },
  ];

  for (const record of records) {
    activities.createActivity({
      id: record.id,
      time: record.time,
      imagePath: path.join(dataDir, `${record.id}.png`),
      analysisStatus: 'COMPLETED',
      analysis: record.analysis,
      model: 'fake-model',
      analysisMs: 10,
    });
  }

  timeBlocks.insertBlockWithJob(
    { id: blockStart, end: blockEnd, status: 'PENDING', activityCount: records.length },
    createJob({ type: AIJobType.TIMEBLOCK_SUMMARY, payload: { blockStart } }),
  );
  timeBlocks.updateSummary(blockStart, {
    status: 'COMPLETED',
    model: 'fake-model',
    summary: {
      project: 'Life Lens',
      category: 'coding',
      description: '这 10 分钟在写 SQLite 迁移与向量检索的对齐',
      software: ['VS Code', 'Ollama'],
      todos: ['补检索测试'],
    },
  });

  diaries.upsertDiaryWithJob(
    { day, status: 'PENDING', blockCount: 1 },
    createJob({ type: AIJobType.DIARY_GENERATION, payload: { day } }),
  );
  diaries.updateDiary(day, {
    status: 'COMPLETED',
    model: 'fake-model',
    diary: {
      summary: '这一天在研究 AI Agent 的记忆架构，并把 SQLite 向量检索链路跑通',
      mainEvents: ['对比记忆分层方案', '对齐检索结果'],
      highlights: ['检索链路跑通'],
      todos: [],
      suggestions: [],
      tips: [],
    },
  });

  db.close();
  return { day, blockStart, screenshotId: 'smoke-sqlite' };
}

// ---- 读 SQLite 等待应用把三层记忆嵌入完 ----

// 只看预置的那几条记忆：应用自己还会汇总「当前这个 10 分钟」区块，
// 那一条汇总在假 Ollama 下会失败、永远留在 PENDING，不能拿全表完成数当就绪条件。
function readSeedStatus(file, seeded) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const completed = (table, where, params = []) => db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN embedding_status = 'COMPLETED' THEN 1 ELSE 0 END) AS done
         FROM ${table} WHERE ${where}`,
    ).get(...params);
    return {
      activities: completed(
        'activities',
        "screenshot_id IN ('smoke-agent', 'smoke-sqlite', 'smoke-walk')",
      ),
      block: completed('time_blocks', 'block_start = ?', [seeded.blockStart]),
      diary: completed('diaries', 'day = ?', [seeded.day]),
    };
  } finally {
    db.close();
  }
}

async function waitFor(check, { timeoutMs = 60000, intervalMs = 300, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

// ---- 极简 CDP 客户端：在渲染进程里执行表达式 ----

function connectCdp(port, { timeoutMs = 30000 } = {}) {
  return waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (!page) return null;
      return openSocket(page.webSocketDebuggerUrl);
    } catch {
      return null;
    }
  }, { timeoutMs, label: 'Electron 调试端口' });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;

    socket.addEventListener('open', () => resolve({
      async send(method, params) {
        const id = ++nextId;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => socket.close(),
    }));
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.rej(new Error(message.error.message));
      else entry.res(message.result);
    });
  });
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`渲染进程执行失败：${detail}`);
  }
  return result.result.value;
}

// ---- 冒烟主体 ----

async function main() {
  const checks = [];
  const check = (label, passed, detail = '') => {
    checks.push({ label, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelens-smoke11-'));
  const dataDir = path.join(root, 'data');
  const userDataDir = path.join(root, 'userdata');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const { server, port } = await startFakeOllama();
  const seeded = seedDatabase(dataDir);
  console.log(`数据目录：${dataDir}`);
  console.log(`假 Ollama：http://127.0.0.1:${port}`);

  const logs = [];
  const child = spawn(
    ELECTRON,
    ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${DEBUG_PORT}`],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        LIFELENS_DIR: dataDir,
        LIFELENS_OLLAMA_HOST: `http://127.0.0.1:${port}`,
        LIFELENS_EMBEDDING_MODEL: 'fake-embed:latest',
        LIFELENS_EMBEDDING_SCAN_INTERVAL_MS: '2000',
        LIFELENS_AUTOSTART: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk) => { logs.push(String(chunk)); });
  child.stderr.on('data', (chunk) => { logs.push(String(chunk)); });
  // 失败时的兜底输出（main 的 catch 里拿不到局部变量）。
  Object.defineProperty(globalThis, '__lifelensSmokeLogs', {
    get: () => logs.join('').split('\n').slice(-40).join('\n'),
    configurable: true,
  });

  let client = null;
  try {
    client = await connectCdp(DEBUG_PORT);

    // 1) 应用自己把三层记忆嵌入进 LanceDB（不是脚本直接写向量库）。
    const counts = await waitFor(() => {
      let current;
      try {
        current = readSeedStatus(path.join(dataDir, 'lifelens.db'), seeded);
      } catch (error) {
        if (process.env.LIFELENS_SMOKE_DEBUG) console.log('[debug] 读状态失败：', error.message);
        return null;
      }
      if (process.env.LIFELENS_SMOKE_DEBUG) console.log('[debug] 嵌入状态：', JSON.stringify(current));
      const done = (layer) => Number(layer.done) === Number(layer.total) && Number(layer.total) > 0;
      return done(current.activities) && done(current.block) && done(current.diary) ? current : null;
    }, { label: '三层 embedding 完成', timeoutMs: process.env.LIFELENS_SMOKE_DEBUG ? 25000 : 60000 });
    check(
      '启动后三层记忆自动嵌入（SQLite 状态 COMPLETED）',
      true,
      `20秒记录 ${counts.activities.done}/${counts.activities.total}，10分钟汇总 ${counts.block.done}/${counts.block.total}，日记 ${counts.diary.done}/${counts.diary.total}`,
    );

    // 2) Renderer -> Preload -> IPC -> Main -> LanceDB -> SQLite
    const result = await evaluate(client, "window.lifelens.searchMemories('我最近什么时候研究过 SQLite 向量检索？', 10)");
    const types = result.items.map((item) => item.sourceType);
    check(
      'IPC 搜索返回三张表聚合后的结果',
      types.includes('activity') && types.includes('block') && types.includes('diary'),
      `命中 ${result.returned} 条：${JSON.stringify(result.layerCounts)}`,
    );
    check(
      '结果按相关度排序（_distance 升序）',
      result.items.every((item, index) => index === 0 || item.distance >= result.items[index - 1].distance),
      result.items.map((item) => `${item.sourceType}:${item.distance.toFixed(3)}`).join(' '),
    );
    check(
      '最相关的是「调试 SQLite 向量检索」这条 20 秒记录',
      result.items[0].sourceType === 'activity' && result.items[0].title.includes('SQLite'),
      `${result.items[0].sourceType} / ${result.items[0].title}`,
    );
    check(
      '回查 SQLite 拿到了完整字段（项目 / 分类 / 关键词 / Timeline id）',
      result.items[0].project === 'Life Lens'
        && result.items[0].category === 'coding'
        && result.items[0].keywords.includes('SQLite')
        && result.items[0].timelineId === seeded.screenshotId,
      JSON.stringify({ project: result.items[0].project, keywords: result.items[0].keywords, timelineId: result.items[0].timelineId }),
    );

    // 3) 搜索页真的能用：切标签 -> 输入 -> 点搜索 -> 出卡片 -> 记最近搜索
    const ui = await evaluate(client, `(async () => {
      document.querySelector('.tab[data-tab="search"]').click();
      const visible = !document.getElementById('view-search').hidden;
      document.getElementById('search-input').value = '我最近什么时候研究过 AI Agent？';
      document.getElementById('search-submit').click();
      const started = document.getElementById('search-status').textContent;
      for (let i = 0; i < 100; i += 1) {
        if (!document.getElementById('search-status').textContent.includes('正在搜索')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        visible,
        started,
        status: document.getElementById('search-status').textContent,
        cards: document.querySelectorAll('#search-results .search-card').length,
        firstSource: document.querySelector('#search-results .search-source')?.textContent ?? '',
        recent: [...document.querySelectorAll('#search-recent .search-recent-item')].map((item) => item.textContent),
      };
    })()`);
    check('「搜索」标签页可以打开', ui.visible === true);
    check('点搜索时先显示「正在搜索记忆…」', ui.started.includes('正在搜索记忆'), ui.started);
    check('结果卡片画到了页面上', ui.cards > 0, `${ui.cards} 张卡片，首条来源：${ui.firstSource}`);
    check('状态栏给出命中统计', ui.status.includes('找到') && ui.status.includes('各层候选'), ui.status);
    check(
      '最近搜索记下了这次关键词',
      ui.recent[0] === '我最近什么时候研究过 AI Agent？',
      JSON.stringify(ui.recent),
    );
    check(
      '首条结果（20 秒记录）的时间与来源标签正确',
      ui.firstSource === '20秒记录',
      ui.firstSource,
    );

    // 4) 点 20 秒记录的结果 -> 切到时间线并高亮定位
    const activityJump = await evaluate(client, `(async () => {
      const card = [...document.querySelectorAll('#search-results .search-card')]
        .find((item) => item.querySelector('.search-source-activity'));
      const title = card.querySelector('.record-activity')?.textContent ?? '';
      card.click();
      for (let i = 0; i < 50; i += 1) {
        if (document.querySelector('.timeline-card-focus')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        tab: document.querySelector('.tab.active')?.dataset.tab ?? '',
        focused: window.lifelensTimeline.isFocused(),
        banner: Boolean(document.querySelector('.timeline-focus')),
        highlighted: document.querySelector('.timeline-card-focus')?.dataset.id ?? '',
        title,
        highlightText: document.querySelector('.timeline-card-focus')?.textContent ?? '',
        status: document.getElementById('search-status').textContent,
      };
    })()`);
    check('点结果切到了「记录」标签页', activityJump.tab === 'overview', activityJump.tab);
    check('时间线进入定位模式并画出横幅', activityJump.banner && activityJump.focused, JSON.stringify(activityJump));
    check(
      '定位到的是搜索结果里的那条记录',
      activityJump.highlighted.startsWith('smoke-') && activityJump.highlightText.includes(activityJump.title),
      `highlighted=${activityJump.highlighted} title=${activityJump.title}`,
    );
    check('搜索页给出了跳转提示', activityJump.status.includes('已跳转到时间线'), activityJump.status);

    // 5) 点日记的结果 -> 切到日记页的那一天
    const diaryJump = await evaluate(client, `(async () => {
      document.querySelector('.tab[data-tab="search"]').click();
      const card = [...document.querySelectorAll('#search-results .search-card')]
        .find((item) => item.querySelector('.search-source-diary'));
      card.click();
      for (let i = 0; i < 50; i += 1) {
        if (document.querySelector('.cal-cell.selected')?.dataset.day) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        tab: document.querySelector('.tab.active')?.dataset.tab ?? '',
        selected: window.lifelensDiary.read().selectedDay,
        status: document.getElementById('search-status').textContent,
      };
    })()`);
    check('点日记结果切到了「日记」标签页', diaryJump.tab === 'diary', diaryJump.tab);
    check(
      '日记页选中的就是搜索结果那一天',
      diaryJump.selected === seeded.day,
      `selected=${diaryJump.selected} day=${seeded.day}`,
    );

    // 6) 空查询与错误提示不会白屏
    const emptyState = await evaluate(client, `(async () => {
      document.querySelector('.tab[data-tab="search"]').click();
      document.getElementById('search-input').value = '   ';
      document.getElementById('search-submit').click();
      for (let i = 0; i < 50; i += 1) {
        if (document.getElementById('search-results').textContent.includes('先输入一句话')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return document.getElementById('search-results').textContent.trim();
    })()`);
    check('空查询给出提示而不是白屏', emptyState.includes('先输入一句话'), emptyState);

    // 7) 主进程日志留下了命中统计（只记元信息，不记查询文本）
    const text = logs.join('');
    check(
      '主进程记下了 MEMORY_SEARCH 事件与命中条数',
      text.includes('MEMORY_SEARCH') && /MEMORY_SEARCH.*记忆搜索命中 \d+ 条/.test(text),
      (text.split('\n').find((line) => line.includes('MEMORY_SEARCH')) ?? '').trim(),
    );
    check('日志里没有出现查询文本', text.includes('研究过 SQLite 向量检索') === false);
    check(
      'embedding 扫描确实用了假的本地模型',
      text.includes('fake-embed:latest'),
      (text.split('\n').find((line) => line.includes('EMBEDDING_ONLINE')) ?? '').trim(),
    );
  } finally {
    client?.close();
    child.kill();
    await sleep(500);
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failed = checks.filter((item) => !item.passed);
  console.log(`\n冒烟结果：${checks.length - failed.length} / ${checks.length} 通过`);
  if (failed.length) {
    console.log('未通过：');
    for (const item of failed) console.log(`  - ${item.label} ${item.detail}`);
    // 失败时把应用输出带出来：冒烟跑在临时目录里，事后无法复现现场。
    console.log('\n---- Electron 输出（最后 40 行）----');
    console.log(logs.join('').split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('冒烟失败：', error);
  console.error('\n---- Electron 输出（最后 40 行）----');
  console.error(globalThis.__lifelensSmokeLogs ?? '（没有捕获到输出）');
  process.exitCode = 1;
});
