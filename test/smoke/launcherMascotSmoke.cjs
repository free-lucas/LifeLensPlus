'use strict';

// Phase 13.2 / 13.3 / 13.4 的真实 Electron 冒烟：小镜（三态 + 默认脸）与特效 / 持续态的联动。
//
//   node_modules\electron\dist\electron.exe test\smoke\launcherMascotSmoke.cjs
//
// 与 launcherEffectsSmoke.cjs 的分工：那一个引导整个应用、跑真实截图与真实 Ollama，
// 管的是「事件通道对不对」；这一个只开悬浮入口那一扇窗，管的是「小镜上台下台的时机对不对」，
// 所以不碰数据库、不碰 AI，几秒就能跑完。
//
// 用的是真实的 launcher.html + 真实的 src/launcherPreload.js + 真实的 IPC 通道，
// 事件从主进程按生产路径发出（webContents.send('lifelens:launcher-event', …)）。
//
// 窗口必须真的 show()：隐藏窗口里 Chromium 会把 CSS 动画节流掉，
// 光圈动画不动 -> animationend 不发 -> class 永远留在 body 上，测出来的全是假失败。
// （真实的悬浮入口也是可见的，这里不为了好看去隐藏它。）

const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.setName('lifelens-plus');
app.setPath('userData', path.join(require('node:os').tmpdir(), `lifelens-mascot-smoke-${Date.now()}`));

const ROOT = path.join(__dirname, '..', '..');
const LAUNCHER_HTML = path.join(ROOT, 'src', 'renderer', 'launcher.html');
const LAUNCHER_PRELOAD = path.join(ROOT, 'src', 'launcherPreload.js');
const CHANNEL = 'lifelens:launcher-event';

// 每个瞬时态：事件、class、小镜、驱动回收的那条光圈动画、期望存活时长。
// 容差 160ms 是按 Phase 13.1 冒烟实测的量级给的（400/600/500 实测 415/625/514）。
const CASES = [
  { type: 'record', effect: 'effect-shutter', state: 'smug', ring: 'shutter-ring', heldMs: 400, tolMs: 160 },
  { type: 'analysis', effect: 'effect-success', state: 'happy', ring: 'success-ring', heldMs: 600, tolMs: 160 },
  { type: 'error', effect: 'effect-error', state: 'thinking', ring: 'error-ring', heldMs: 500, tolMs: 160 },
];

// 四只小镜：三只瞬时态 + 一只待机（默认脸：录制中与暂停时都在台上）。
const STATES = ['smug', 'thinking', 'happy', 'idle'];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

// 三只小镜各自的时间轴状态：停没停、停在第几秒。
const PROBE = `(() => ${JSON.stringify(STATES)}.reduce((acc, state) => {
  const svg = document.querySelector('.mascot-' + state + ' > svg');
  acc[state] = svg ? { paused: svg.animationsPaused(), at: Math.round(svg.getCurrentTime() * 1000) / 1000 } : null;
  return acc;
}, {}))()`;

// 台上的是谁：待机小镜的 computed visibility，与光圈圆标（.glyph）的 opacity。
const FACE_PROBE = `(() => ({
  idle: getComputedStyle(document.querySelector('.mascot-idle')).visibility,
  glyph: getComputedStyle(document.querySelector('.glyph')).opacity,
}))()`;

// 记下 body 上每一次 class 变化与时刻，特效「出现 -> 消失」的时长从真实事件里量。
const INSTALL_PROBE = `(() => {
  window.__classes = [];
  new MutationObserver(() => window.__classes.push({ at: performance.now(), classes: document.body.className }))
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return true;
})()`;

const hasClass = (entry, name) => String(entry.classes ?? '').split(/\s+/).includes(name);

async function run(win) {
  // ---- 初始态：三只小镜都冻在第 0 帧 ----
  const initial = await win.webContents.executeJavaScript(PROBE);
  check(
    '1 初始态：四只小镜都停在第 0 帧（藏着的 SMIL 不空转）',
    STATES.every((state) => initial[state]?.paused === true && initial[state]?.at === 0),
    JSON.stringify(initial),
  );

  await win.webContents.executeJavaScript(INSTALL_PROBE);

  // ---- 三个瞬时态各走一遍完整的上台下台 ----
  for (const item of CASES) {
    await win.webContents.executeJavaScript('window.__classes.length = 0, true');
    const t0 = await win.webContents.executeJavaScript('performance.now()');
    win.webContents.send(CHANNEL, { type: item.type });

    // 特效正在演：class 挂上了，对应小镜的时间轴被放开，另外两只仍然冻着。
    await sleep(90);
    const during = await win.webContents.executeJavaScript(PROBE);
    const duringClass = await win.webContents.executeJavaScript('document.body.className');

    check(`${item.type} -> ${item.effect} 挂上 body class`, duringClass.split(/\s+/).includes(item.effect), `body="${duringClass}"`);
    check(`${item.effect} 期间 ${item.state} 的时间轴被放开`, during[item.state]?.paused === false, JSON.stringify(during[item.state]));
    check(
      `${item.effect} 期间另外三只小镜仍冻着`,
      STATES.filter((state) => state !== item.state).every((state) => during[state]?.paused === true),
    );

    // 演完：class 被回收、这只小镜重新冻住。
    await sleep(item.heldMs + item.tolMs + 160);
    const log = await win.webContents.executeJavaScript(`window.__classes.map((e) => ({ dt: Math.round(e.at - ${t0}), classes: e.classes }))`);
    const after = await win.webContents.executeJavaScript(PROBE);
    const afterClass = await win.webContents.executeJavaScript('document.body.className');

    const added = log.find((entry) => hasClass(entry, item.effect));
    const removed = log.find((entry) => !hasClass(entry, item.effect));
    const held = added && removed ? removed.dt - added.dt : null;

    check(`${item.ring} 之后 ${item.effect} 被回收`, !afterClass.split(/\s+/).includes(item.effect), `body="${afterClass}"`);
    check(
      `${item.effect} class 存活 ${held}ms（期望约 ${item.heldMs}ms）`,
      held !== null && Math.abs(held - item.heldMs) <= item.tolMs,
    );
    check(`${item.effect} 演完后 ${item.state} 重新冻住`, after[item.state]?.paused === true, JSON.stringify(after[item.state]));
  }

  // ---- 待机小镜（默认脸）：录制中与暂停时都在台上，只有瞬时态时让位 ----
  // 时间轴跟着录制状态走：录制中在演，暂停时冻回第 0 帧（「一暂停就完全静止」）。
  await win.webContents.executeJavaScript('window.__classes.length = 0, true');
  win.webContents.send(CHANNEL, { type: 'status', running: true });
  await sleep(200);
  const runningNow = await win.webContents.executeJavaScript(PROBE);
  const runningFace = await win.webContents.executeJavaScript(FACE_PROBE);
  const runningClass = await win.webContents.executeJavaScript('document.body.className');

  check('待机 1 录制中 -> state-running 挂上 body class', runningClass.split(/\s+/).includes('state-running'), `body="${runningClass}"`);
  check(
    '待机 2 录制中待机小镜在台上、光圈圆标让位',
    runningFace.idle === 'visible' && runningFace.glyph === '0',
    JSON.stringify(runningFace),
  );
  check('待机 3 录制中待机小镜的时间轴被放开', runningNow.idle?.paused === false, JSON.stringify(runningNow.idle));
  check(
    '待机 4 录制中三只瞬时态小镜仍冻着',
    ['smug', 'thinking', 'happy'].every((state) => runningNow[state]?.paused === true),
  );

  // 真的在演：时间轴要往前走，而不是放开后停在原地。
  await sleep(500);
  const moving = await win.webContents.executeJavaScript(PROBE);
  check(
    '待机 5 录制中待机小镜一直在演（时间轴在前进）',
    (moving.idle?.at ?? 0) > (runningNow.idle?.at ?? 0),
    `${runningNow.idle?.at}s -> ${moving.idle?.at}s`,
  );

  // 暂停：亮的那一套全停 —— 外围扫光停转、球体降亮，小镜也冻回第 0 帧。
  win.webContents.send(CHANNEL, { type: 'status', running: false });
  await sleep(200);
  const paused = await win.webContents.executeJavaScript(PROBE);
  const pausedFace = await win.webContents.executeJavaScript(FACE_PROBE);
  const pausedClass = await win.webContents.executeJavaScript('document.body.className');
  const pausedAnim = await win.webContents.executeJavaScript(
    "getComputedStyle(document.querySelector('.mascot-idle')).animationName",
  );

  check('待机 6 暂停 -> state-paused 挂上 body class', pausedClass.split(/\s+/).includes('state-paused'), `body="${pausedClass}"`);
  check(
    '待机 7 暂停时待机小镜冻回第 0 帧（一暂停就完全静止）',
    paused.idle?.paused === true && paused.idle?.at === 0,
    JSON.stringify(paused.idle),
  );
  check(
    '待机 8 暂停时它仍然在台上、圆标仍然让位',
    pausedFace.idle === 'visible' && pausedFace.glyph === '0',
    JSON.stringify(pausedFace),
  );
  check('待机 9 淡入用的是 mascot-in（不是演完会自己消失的 mascot-pop）', pausedAnim === 'mascot-in', `animationName=${pausedAnim}`);

  // 台上照样会来瞬时事件：瞬时态那只上场，待机这只退场（两个都铺满整颗球，不能叠着）。
  win.webContents.send(CHANNEL, { type: 'record' });
  await sleep(120);
  const overlap = await win.webContents.executeJavaScript(
    "({ idle: getComputedStyle(document.querySelector('.mascot-idle')).visibility,"
    + " smug: getComputedStyle(document.querySelector('.mascot-smug')).visibility })",
  );
  check(
    '待机 10 瞬时事件插进来：瞬时态那只上场、待机这只退场',
    overlap.smug === 'visible' && overlap.idle === 'hidden',
    JSON.stringify(overlap),
  );

  // 恢复录制：瞬时态演完回到台上，时间轴重新放开。
  await sleep(600);
  win.webContents.send(CHANNEL, { type: 'status', running: true });
  await sleep(200);
  const resumed = await win.webContents.executeJavaScript(PROBE);
  const resumedClass = await win.webContents.executeJavaScript('document.body.className');
  const resumedFace = await win.webContents.executeJavaScript(FACE_PROBE);
  check(
    '待机 11 恢复录制 -> state-running，待机小镜回到台上并被放开',
    resumedClass.split(/\s+/).includes('state-running')
      && resumedFace.idle === 'visible'
      && resumed.idle?.paused === false,
    `body="${resumedClass}" face=${JSON.stringify(resumedFace)} idle=${JSON.stringify(resumed.idle)}`,
  );

  // ---- prefers-reduced-motion：小镜只淡入淡出，时间轴一步都不走 ----
  await win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await win.webContents.reload();
  await sleep(800);

  win.webContents.send(CHANNEL, { type: 'record' });
  await sleep(120);
  const reduced = await win.webContents.executeJavaScript(PROBE);
  const reducedClass = await win.webContents.executeJavaScript('document.body.className');
  // 降级后的动画名只在 class 挂着的时候才有：要等事件发出去之后再读。
  const reducedAnim = await win.webContents.executeJavaScript(
    "getComputedStyle(document.querySelector('.mascot-smug')).animationName",
  );
  await sleep(800);
  const reducedAfter = await win.webContents.executeJavaScript('document.body.className');

  check('4 prefers-reduced-motion：出场动画降级成纯淡入淡出', reducedAnim === 'mascot-fade', `animationName=${reducedAnim}`);
  check('5 prefers-reduced-motion：小镜时间轴不放开（停在第 0 帧）', reduced.smug?.paused === true && reduced.smug?.at === 0, JSON.stringify(reduced.smug));
  check('6 prefers-reduced-motion：特效 class 照常挂上', reducedClass.split(/\s+/).includes('effect-shutter'), `body="${reducedClass}"`);
  check('7 prefers-reduced-motion：class 仍然被回收', !reducedAfter.split(/\s+/).includes('effect-shutter'), `body="${reducedAfter}"`);
  await win.webContents.debugger.detach();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 56,
    height: 56,
    x: 0,
    y: 0,
    show: true,
    useContentSize: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: LAUNCHER_PRELOAD, contextIsolation: true, nodeIntegration: false },
  });

  try {
    await win.loadFile(LAUNCHER_HTML);
    await sleep(400);
    await run(win);
  } catch (error) {
    check('冒烟执行完成', false, String(error?.stack ?? error));
  }

  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n--- 结果 ---  PASS ${results.length - failed} / FAIL ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
  app.quit();
});
