'use strict';

// Phase 13 的真实 Electron 冒烟：悬浮入口 + 主窗口的生命周期。
//
//   npx electron test/smoke/launcherSmoke.cjs --user-data-dir=<临时目录>
//
// 与其它冒烟脚本不同，这个脚本直接引导真实应用（require src/main/main.js），
// 再用真实窗口 + 真实 IPC + 真实渲染进程驱动，结论全部来自真实进程：
//   - 启动前先写一份越界位置，验证启动时的越界校正；
//   - 点击 / 拖动都用真实鼠标事件（executeJavaScript 派发 MouseEvent）；
//   - 关闭主窗口、点退出按钮都走真实的 close 事件与 IPC。
//
// 数据隔离：LIFELENS_DIR 指向临时目录，--user-data-dir 指向临时目录，
// 位置文件写在 userData 下，全程不碰真实数据。
//
// 「重启后恢复上次位置」要跨两个进程，分两次运行：
//   第一次：脚本结束时打印 SAVED_POSITION=x,y
//   第二次：LIFELENS_SMOKE_EXPECT_POSITION=x,y 再跑一次同一个目录

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { app, BrowserWindow, screen } = require('electron');

app.setName('lifelens-plus');

const ROOT = path.join(__dirname, '..', '..');
const RUN_DIR = process.env.LIFELENS_SMOKE_DIR
  || path.join(os.tmpdir(), `lifelens-launcher-smoke-${Date.now()}`);
const DATA_DIR = path.join(RUN_DIR, 'data');
const EXPECT_POSITION = process.env.LIFELENS_SMOKE_EXPECT_POSITION || '';

fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.LIFELENS_DIR = DATA_DIR;
// 不自动截屏：这一阶段测的是窗口壳，截图链路在第 5 步用界面按钮单独打开。
process.env.LIFELENS_AUTOSTART = '0';
process.env.LIFELENS_INTERVAL_MS = process.env.LIFELENS_INTERVAL_MS || '3000';

const USER_DATA = app.getPath('userData');
const POSITION_FILE = path.join(USER_DATA, 'launcher-position.json');

if (!EXPECT_POSITION) {
  // 故意写一个屏幕外的坐标：启动后应该被自动校正回可见区域。
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(POSITION_FILE, `${JSON.stringify({ x: 99999, y: 99999 })}\n`, 'utf8');
}

// 真实应用：它的 whenReady 流程会打开数据库、建主窗口、最后建悬浮入口。
require('../../src/main/main.js');

const results = [];
let shutdownError = null;
let secondInstanceSeen = false;

process.on('uncaughtException', (error) => { shutdownError = error; });
app.on('second-instance', () => { secondInstanceSeen = true; });
// 退出按钮走的就是 app.quit()：能收到 quit 事件就说明 before-quit 的收尾流程走完了。
app.once('quit', () => {
  check('7 主窗口「退出」按钮结束整个应用', true, 'quit 事件已触发（before-quit 收尾流程走完）');
  finish();
});

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

function finish() {
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n--- 结果 ---  PASS ${results.length - failed} / FAIL ${failed}`);
  const position = readPosition();
  console.log(`SAVED_POSITION=${position ? `${position.x},${position.y}` : ''}`);
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

const findLauncher = () => BrowserWindow.getAllWindows().find((win) => win.getSize()[0] === 56);
const findMain = () => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.getSize()[0] > 500);

// 在渲染进程里派发一串真实鼠标事件（screenX / screenY 就是屏幕坐标）。
function mouseScript(events) {
  const init = events.map((event) => JSON.stringify({
    type: event.type, screenX: event.x, screenY: event.y, button: event.button ?? 0, bubbles: true,
  })).join(',');
  return `(() => {
    for (const options of [${init}]) document.dispatchEvent(new MouseEvent(options.type, options));
    return true;
  })()`;
}

const clickEvents = [{ type: 'mousedown', x: 10, y: 10 }, { type: 'mouseup', x: 10, y: 10 }];

function readPosition() {
  try {
    return JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function countImages() {
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.png')) count += 1;
    }
  };
  walk(DATA_DIR);
  return count;
}

async function run() {
  // ---- 1. 启动：两个窗口同时出现，launcher 置顶、位置被校正到可见区域 ----
  const launcher = await waitFor(findLauncher);
  const main = await waitFor(findMain);
  check('1 启动时 launcher 与主窗口同时出现', Boolean(launcher && main),
    main
      ? `launcher=${launcher?.getSize().join('x')}，主窗口=${main.getSize().join('x')}`
      : '有一侧没出现');
  if (!launcher || !main) return;

  check('1 launcher 置顶（alwaysOnTop）', launcher.isAlwaysOnTop() === true,
    'skipTaskbar / 无边框 / 透明没有回读接口，靠肉眼确认');

  const [startX, startY] = launcher.getPosition();
  const workArea = screen.getPrimaryDisplay().workArea;
  const inside = startX >= workArea.x && startY >= workArea.y
    && startX + 56 <= workArea.x + workArea.width && startY + 56 <= workArea.y + workArea.height;

  if (EXPECT_POSITION) {
    const [expectX, expectY] = EXPECT_POSITION.split(',').map(Number);
    check('8 重启后恢复到上次保存的位置', startX === expectX && startY === expectY,
      `期望 ${expectX},${expectY}，实际 ${startX},${startY}`);
  } else {
    check('9 越界坐标启动后自动回到可见区域', inside && startX !== 99999,
      `文件里是 99999,99999，实际落在 ${startX},${startY}（workArea ${workArea.width}x${workArea.height}）`);
  }

  // ---- 2. 点击：显示 / 聚焦主窗口，launcher 仍然在 ----
  main.hide();
  await sleep(400);
  await launcher.webContents.executeJavaScript(mouseScript(clickEvents));
  const reopened = await waitFor(() => main.isVisible(), { timeoutMs: 5000 });
  check('2 点击 launcher 后主窗口显示 / 聚焦', Boolean(reopened) && !launcher.isDestroyed(),
    `主窗口 visible=${main.isVisible()} focused=${main.isFocused()}，launcher 仍在=${!launcher.isDestroyed()}`);

  // ---- 3. 拖动：跟手、松手落盘、不误开主窗口 ----
  launcher.setPosition(300, 300);
  await sleep(400);
  const screenBase = await launcher.webContents.executeJavaScript('[window.screenX, window.screenY]');
  main.hide();
  await launcher.webContents.executeJavaScript(mouseScript([
    { type: 'mousedown', x: 500, y: 500 },
    { type: 'mousemove', x: 502, y: 501 },   // 阈值内：仍然算点击
    { type: 'mousemove', x: 600, y: 560 },   // 超过阈值：进入拖动
    { type: 'mouseup', x: 600, y: 560 },
  ]));
  const expected = [screenBase[0] + 100, screenBase[1] + 60];
  const moved = await waitFor(() => {
    const position = launcher.getPosition();
    return position[0] === expected[0] && position[1] === expected[1] ? position : null;
  }, { timeoutMs: 5000 });
  check('3 拖动 launcher：位置跟手', Boolean(moved),
    `按下时窗口位置 ${screenBase.join(',')} + 位移 100,60 => 期望 ${expected.join(',')}，实际 ${launcher.getPosition().join(',')}`);
  check('3 拖动没有误开主窗口', main.isVisible() === false, `主窗口 visible=${main.isVisible()}`);

  const [finalX, finalY] = launcher.getPosition();
  // 松手才写盘：这里等文件内容真正变成窗口当前位置，而不是只要读得出来就算过。
  const saved = await waitFor(() => {
    const position = readPosition();
    return position?.x === finalX && position?.y === finalY ? position : null;
  }, { timeoutMs: 5000 });
  check('3 拖动结束才写盘，写入窗口当前位置', Boolean(saved),
    `窗口=${finalX},${finalY}，文件=${JSON.stringify(readPosition())}`);

  // ---- 4. 拖动之后再单击：仍然正常打开主窗口 ----
  await launcher.webContents.executeJavaScript(mouseScript(clickEvents));
  const afterClick = await waitFor(() => main.isVisible(), { timeoutMs: 5000 });
  check('4 拖动之后再单击仍能打开主窗口', Boolean(afterClick), `主窗口 visible=${main.isVisible()}`);

  // ---- 5. 关闭主窗口：应用不退出、后台照常截图、launcher 继续存在 ----
  main.show();
  await main.webContents.executeJavaScript("document.getElementById('start').click(), true").catch(() => {});
  await sleep(1000);
  const imagesBefore = countImages();

  main.close();
  const hidden = await waitFor(() => !main.isVisible() && !main.isDestroyed(), { timeoutMs: 5000 });
  check('5 关闭主窗口 = 隐藏而不是销毁，应用继续运行', Boolean(hidden),
    `isDestroyed=${main.isDestroyed()} visible=${main.isVisible()}，launcher 仍在=${!launcher.isDestroyed()}`);

  const captured = await waitFor(() => countImages() > imagesBefore, { timeoutMs: 15000, intervalMs: 500 });
  check('5 主窗口隐藏后后台仍在截图', Boolean(captured),
    `关闭前 ${imagesBefore} 张，等待后 ${countImages()} 张`);

  // ---- 6. 再点 launcher：主窗口恢复 ----
  await launcher.webContents.executeJavaScript(mouseScript(clickEvents));
  const restored = await waitFor(() => main.isVisible(), { timeoutMs: 5000 });
  check('6 再点 launcher 主窗口恢复', Boolean(restored), `主窗口 visible=${main.isVisible()}`);

  // ---- 10. 第二个实例：单实例锁生效，已有实例的主窗口被唤起 ----
  main.hide();
  await sleep(400);
  const child = spawn(process.execPath, ['.', `--user-data-dir=${USER_DATA}`], {
    cwd: ROOT,
    env: { ...process.env, LIFELENS_DIR: DATA_DIR },
    stdio: 'ignore',
  });
  const seen = await waitFor(() => secondInstanceSeen, { timeoutMs: 20000, intervalMs: 250 });
  const woken = await waitFor(() => main.isVisible(), { timeoutMs: 5000 });
  check('10 第二个实例唤起已有实例的主窗口', Boolean(seen && woken),
    `second-instance=${secondInstanceSeen}，主窗口 visible=${main.isVisible()}（子进程 pid=${child.pid}）`);

  // ---- 7. 退出按钮：走 app.quit()，before-quit 原样执行 ----
  console.log('\n--- 退出 ---');
  // 等 recorder 收尾最长 5 秒、AIWorker 最长 8 秒，这里给 30 秒；超时说明退出流程卡住。
  const stuck = setTimeout(() => {
    check('7 主窗口「退出」按钮结束整个应用', false, '30 秒内没有退出');
    finish();
    app.exit(1);
  }, 30000);
  stuck.unref?.();
  await main.webContents.executeJavaScript("document.getElementById('quit').click(), true");
}

app.whenReady().then(async () => {
  // 硬超时：整套流程正常应该在 60 秒内跑完。
  const guard = setTimeout(() => {
    console.error('FAIL  冒烟超时（150 秒）');
    process.exitCode = 2;
    app.exit(2);
  }, 150000);
  guard.unref?.();

  try {
    await run();
  } catch (error) {
    check('冒烟异常', false, `${error?.stack ?? error}`);
    finish();
    app.exit(1);
  }
});
