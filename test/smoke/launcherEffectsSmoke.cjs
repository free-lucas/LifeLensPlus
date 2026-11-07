'use strict';

// Phase 13.1 的真实 Electron 冒烟：悬浮窗特效、事件通道与右键菜单。
//
//   $dir = "$env:TEMP\lifelens-p13-1-smoke-<时间戳>"
//   $env:LIFELENS_SMOKE_DIR = $dir
//   node_modules\electron\dist\electron.exe test\smoke\launcherEffectsSmoke.cjs --user-data-dir="$dir\user-data"
//
// 与 launcherSmoke.cjs 同一套路：直接引导真实应用（require src/main/main.js），
// 用真实窗口 + 真实 IPC + 真实渲染进程驱动。能真实跑的链路就真实跑：
//   - status / record / analysis 全部来自真实的录制与 AI 链路（本机 Ollama 有 qwen3-vl:8b）；
//   - error 需要一个可复现的失败，冒烟里造不出来：用真实的转换函数 launcherEventOf 生成载荷、
//     沿真实通道推入，输出里标注这一点；
//   - 右键菜单用真实的 Electron Menu，只把 popup 换成记录（原生菜单会挡住自动化）。
//
// 视觉本身（颜色、光圈扩散）没有断言 —— 断言的是「class 在正确的时刻出现与消失」，
// 以及 prefers-reduced-motion 下降级后的 animation-name / transform。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { app, BrowserWindow, Menu } = require('electron');

app.setName('lifelens-plus');

const RUN_DIR = process.env.LIFELENS_SMOKE_DIR
  || path.join(os.tmpdir(), `lifelens-launcher-effects-smoke-${Date.now()}`);
const DATA_DIR = path.join(RUN_DIR, 'data');
const ANALYSIS_TIMEOUT_MS = Number(process.env.LIFELENS_SMOKE_ANALYSIS_TIMEOUT_MS) || 240000;

fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.LIFELENS_DIR = DATA_DIR;
// 不自动截屏：先验证「未录制 = 暂停态」，再手动开始录制。
process.env.LIFELENS_AUTOSTART = '0';
process.env.LIFELENS_INTERVAL_MS = process.env.LIFELENS_INTERVAL_MS || '1500';

// ---- 真实的 Menu，只把弹窗换成记录 ----
// buildFromTemplate 之后拿到的是真 Menu（items 的 label 就是用户看到的文案），
// popup 会让原生菜单真的弹在屏幕上并等待用户操作，自动化里必须替换掉。
const popups = [];
const templates = [];
const originalBuild = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => {
  templates.push(template);
  return originalBuild(template);
};
Menu.prototype.popup = function popup(options) {
  popups.push({ menu: this, options });
};

// 真实应用：它的 whenReady 流程会打开数据库、建主窗口、最后建悬浮入口。
require('../../src/main/main.js');
const { launcherEventOf } = require('../../src/main/launcher/launcherEvents');

const results = [];
let shutdownError = null;

process.on('uncaughtException', (error) => { shutdownError = error; });
app.once('quit', () => {
  check('8 菜单「退出应用」结束整个应用', true, 'quit 事件已触发（before-quit 收尾流程走完）');
  finish();
});

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

function finish() {
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n--- 结果 ---  PASS ${results.length - failed} / FAIL ${failed}`);
  console.log(`RUN_DIR=${RUN_DIR}`);
  if (shutdownError) console.error(`退出期间出现异常：${shutdownError.stack ?? shutdownError}`);
  process.exitCode = failed === 0 && !shutdownError ? 0 : 1;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(checkFn, { timeoutMs = 20000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await checkFn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

const findLauncher = () => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.getSize()[0] === 56);
const findMain = () => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.getSize()[0] > 500);

// ---- 渲染层探针 ----

// 装一个 MutationObserver，把 body 上每一次 class 变化连时间戳记下来：
// 特效「出现 → 消失」的时长是从真实事件里量出来的，不是靠 sleep 猜的。
const INSTALL_PROBE = `(() => {
  window.__lifelensEffects = [];
  const snapshot = () => window.__lifelensEffects.push({ at: Date.now(), classes: document.body.className });
  new MutationObserver(snapshot).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  snapshot();
  return document.body.className;
})()`;

const bodyClassOf = (win) => win.webContents.executeJavaScript('document.body.className');
const readLog = (win) => win.webContents.executeJavaScript('window.__lifelensEffects');
const clearLog = (win) => win.webContents.executeJavaScript('window.__lifelensEffects.length = 0, true');

const hasClass = (entry, name) => String(entry?.classes ?? '').split(/\s+/).includes(name);

// 等一个特效出现并消失，返回两个时间戳（毫秒）。
async function waitForEffect(win, name, { timeoutMs = 20000, goneMs = 5000 } = {}) {
  const appearedAt = await waitFor(async () => {
    const log = await readLog(win);
    const hit = log.find((entry) => hasClass(entry, name));
    return hit ? hit.at : null;
  }, { timeoutMs, intervalMs: 40 });
  if (!appearedAt) return null;

  const goneAt = await waitFor(async () => {
    const log = await readLog(win);
    const last = log.at(-1);
    return last && !hasClass(last, name) ? last.at : null;
  }, { timeoutMs: goneMs, intervalMs: 20 });
  return { appearedAt, goneAt };
}

// 监听 Main 真正发到 launcher 的载荷：这是「最小暴露」的运行时证据。
const sentEvents = [];
function spyLauncherEvents(win) {
  const original = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    if (channel === 'lifelens:launcher-event') sentEvents.push(payload);
    return original(channel, payload);
  };
}

async function readStatus(main) {
  return main.webContents.executeJavaScript('window.lifelens.getStatus()');
}

// ---- 主流程 ----

async function run() {
  // ---- 1. 两个窗口 ----
  const launcher = await waitFor(findLauncher);
  const main = await waitFor(findMain);
  check('1 launcher 与主窗口同时出现', Boolean(launcher && main),
    `launcher=${launcher?.getSize().join('x')}，主窗口=${main?.getSize().join('x')}`);
  if (!launcher || !main) return;
  spyLauncherEvents(launcher);

  // ---- 2. 未录制 = 暂停态（验证首帧补发的那次 status）----
  const initial = await launcher.webContents.executeJavaScript(INSTALL_PROBE);
  const paused = await waitFor(async () => {
    const classes = await bodyClassOf(launcher);
    return classes.includes('state-paused') ? classes : null;
  }, { timeoutMs: 5000, intervalMs: 50 });
  check('2 启动时（autostart=0）圆标是暂停态', Boolean(paused),
    `首帧 body class = "${initial}"，最终 = "${await bodyClassOf(launcher)}"`);

  // ---- 3. 开始录制：真实 status -> state-running ----
  await clearLog(launcher);
  await main.webContents.executeJavaScript("document.getElementById('start').click(), true");
  const running = await waitFor(async () => {
    const classes = await bodyClassOf(launcher);
    return classes.includes('state-running') ? classes : null;
  }, { timeoutMs: 5000, intervalMs: 50 });
  check('3 录制中 -> state-running（真实 status 事件）', Boolean(running),
    `body class = "${await bodyClassOf(launcher)}"，录制状态 running=${(await readStatus(main)).running}`);

  // ---- 4. 真实 record 事件 -> 快门闪光 ----
  const shutter = await waitForEffect(launcher, 'effect-shutter', { timeoutMs: 15000 });
  check('4 真实截图 -> 快门特效出现并自动结束', Boolean(shutter?.goneAt),
    shutter
      ? `出现 -> 消失 ${shutter.goneAt - shutter.appearedAt}ms（期望约 400ms，不含 CSS 动画排队的几帧）`
      : '15 秒内没有等到 record 事件');

  // ---- 5. 真实 analysis 事件 -> 成功特效 ----
  await clearLog(launcher);
  const success = await waitForEffect(launcher, 'effect-success', { timeoutMs: ANALYSIS_TIMEOUT_MS });
  const status = await readStatus(main);
  check('5 真实 AI 分析 -> 成功特效出现并自动结束', Boolean(success?.goneAt),
    success
      ? `出现 -> 消失 ${success.goneAt - success.appearedAt}ms（期望约 600ms）；已分析 ${status.analyzed} 张，队列 ${status.queue}，错误 ${status.errors}`
      : `${ANALYSIS_TIMEOUT_MS}ms 内没有等到 analysis 事件（analysed=${status.analyzed}，errors=${status.errors}）`);

  // ---- 6. 最小暴露：Main 真正发出去的载荷（只含真实事件）----
  const kinds = new Set(sentEvents.map((item) => item.type));
  const leaked = sentEvents.filter((item) => Object.keys(item).some((key) => key !== 'type' && key !== 'running'));
  check('6 launcher 只收到 type（+ status 的 running），没有截图 / 分析详情', leaked.length === 0,
    `共 ${sentEvents.length} 条：${[...kinds].join(' / ')}；字段示例 ${JSON.stringify(sentEvents.at(-1))}`
    + (leaked.length ? `；越界载荷 ${JSON.stringify(leaked[0])}` : ''));

  // ---- 7. error -> 红色闪烁（合成事件，走真实转换函数 + 真实通道）----
  await clearLog(launcher);
  launcher.webContents.send('lifelens:launcher-event', launcherEventOf({
    type: 'error', message: '冒烟合成的错误（真实 error 需要可复现的失败，冒烟里造不出来）',
  }));
  const error = await waitForEffect(launcher, 'effect-error', { timeoutMs: 5000 });
  check('7 error -> 红色闪烁出现并自动结束（载荷由真实转换函数生成）', Boolean(error?.goneAt),
    error ? `出现 -> 消失 ${error.goneAt - error.appearedAt}ms（期望约 500ms）` : '5 秒内没有出现 error 特效');

  // ---- 8. 右键菜单 ----
  await clearLog(launcher);
  await launcher.webContents.executeJavaScript(`(() => {
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  })()`);
  const popped = await waitFor(() => (popups.length ? popups.at(-1) : null), { timeoutMs: 5000, intervalMs: 50 });
  const labels = popped?.menu.items.map((item) => item.label || item.type) ?? [];
  check('8 右键弹出原生菜单（三项 + 分隔线，文案跟当前状态）', Boolean(popped)
    && JSON.stringify(labels) === JSON.stringify(['打开主界面', '暂停录制', 'separator', '退出应用']),
  popped ? `menu 项 = ${JSON.stringify(labels)}，popup 挂在 launcher=${popped.options.window === launcher}` : '没有弹出菜单');

  // 暂停：走真实的 recorder.toggle()，视觉要跟着切到暂停态
  templates.at(-1)[1].click();
  const stopped = await waitFor(async () => {
    const current = await readStatus(main);
    const classes = await bodyClassOf(launcher);
    return current.running === false && classes.includes('state-paused') ? current : null;
  }, { timeoutMs: 5000, intervalMs: 50 });
  check('8 菜单「暂停录制」真的停了录制，视觉同步切到暂停态', Boolean(stopped),
    stopped ? `running=${stopped.running}，body class = "${await bodyClassOf(launcher)}"` : '录制没有停下');

  // 恢复：菜单文案应该已经变成「恢复录制」
  await launcher.webContents.executeJavaScript(`(() => {
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  })()`);
  const again = await waitFor(() => (popups.length >= 2 ? popups.at(-1) : null), { timeoutMs: 5000, intervalMs: 50 });
  const resumeLabel = again?.menu.items[1]?.label;
  templates.at(-1)[1].click();
  const resumed = await waitFor(async () => {
    const current = await readStatus(main);
    const classes = await bodyClassOf(launcher);
    return current.running === true && classes.includes('state-running') ? current : null;
  }, { timeoutMs: 5000, intervalMs: 50 });
  check('8 菜单「恢复录制」文案正确且真的恢复录制', Boolean(resumed) && resumeLabel === '恢复录制',
    `第二次菜单第二项 = "${resumeLabel}"，恢复后 running=${resumed?.running}`);

  // 打开主界面：先隐藏主窗口，再点菜单第一项
  main.hide();
  await sleep(300);
  templates.at(-1)[0].click();
  const reopened = await waitFor(() => main.isVisible(), { timeoutMs: 5000, intervalMs: 100 });
  check('8 菜单「打开主界面」唤起主窗口', Boolean(reopened), `主窗口 visible=${main.isVisible()}`);

  // ---- 9. prefers-reduced-motion 降级 ----
  const reduced = await checkReducedMotion(launcher);
  check('9 prefers-reduced-motion：光圈只闪颜色（不缩放），class 仍能被回收', reduced.ok, reduced.detail);

  // ---- 10. 退出 ----
  console.log('\n--- 退出 ---');
  const stuck = setTimeout(() => {
    check('8 菜单「退出应用」结束整个应用', false, '60 秒内没有退出');
    finish();
    app.exit(1);
  }, 60000);
  stuck.unref?.();
  templates.at(-1)[3].click();
}

// 用 CDP 模拟「系统开启减少动态效果」，验证降级后的 keyframes 与 class 回收。
// 这里不派发应用事件，而是直接在页面里挂上特效 class：
// 要证明的是「CSS 降级了，而且动画仍然会结束、class 仍然会被摘掉」。
async function checkReducedMotion(launcher) {
  const debuggerer = launcher.webContents.debugger;
  try {
    debuggerer.attach('1.3');
    await debuggerer.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });

    // 录制中：轨道环应当已被 media query 停掉。
    const orbitAnimation = await launcher.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('.orbit')).animationName",
    );

    const applied = await launcher.webContents.executeJavaScript(`(() => {
      document.body.classList.add('effect-shutter');
      const style = getComputedStyle(document.querySelector('.ball'), '::after');
      return { animationName: style.animationName, transform: style.transform };
    })()`);

    // 500ms 特效只有 400ms，这里给足 3 秒：class 被摘掉说明 animationend 正常触发。
    const reclaimed = await waitFor(async () => {
      const classes = await bodyClassOf(launcher);
      return !classes.includes('effect-shutter');
    }, { timeoutMs: 3000, intervalMs: 20 });

    return {
      ok: applied.animationName === 'shutter-ring-flash' && applied.transform === 'none' && Boolean(reclaimed),
      detail: `动画名 = ${applied.animationName}（降级后）／${orbitAnimation}（轨道环，期望 none）；`
        + `transform = ${applied.transform}；class 回收 = ${Boolean(reclaimed)}`,
    };
  } catch (error) {
    return { ok: false, detail: `CDP 模拟失败：${error.message}` };
  } finally {
    try {
      await debuggerer.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      debuggerer.detach();
    } catch { /* 已经断开就算了 */ }
  }
}

app.whenReady().then(async () => {
  // 硬超时：正常情况下 60 秒内跑完，首张截图的真实 AI 分析可能需要更久。
  const guard = setTimeout(() => {
    console.error('FAIL  冒烟超时（420 秒）');
    process.exitCode = 2;
    app.exit(2);
  }, 420000);
  guard.unref?.();

  try {
    await run();
  } catch (error) {
    check('冒烟异常', false, `${error?.stack ?? error}`);
    finish();
    app.exit(1);
  }
});