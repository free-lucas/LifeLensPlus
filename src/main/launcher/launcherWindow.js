'use strict';

// Phase 13：悬浮入口窗口与它的 IPC 通道（Phase 13.1 起加了第四个：右键菜单）。
// 与 searchIpc 等同构：ipcMain / 窗口对象 / 依赖全部由调用方（main.js）注入，
// 这里不持有任何全局状态，所以测试可以用假窗口与假 ipcMain 直接覆盖。

const path = require('node:path');
const { BrowserWindow } = require('electron');

const { clampToWorkArea } = require('./launcherPosition');

// 56x56 的圆标：够小、不挡视线，也够大能按住拖动。
const LAUNCHER_SIZE = Object.freeze({ width: 56, height: 56 });

const LAUNCHER_CHANNELS = Object.freeze({
  open: 'lifelens:launcher-open',
  move: 'lifelens:launcher-move',
  end: 'lifelens:launcher-end',
  // Phase 13.1：右键极简菜单。用 invoke（而不是 send）是为了让 Renderer 能拿到
  // 「菜单到底弹出来没有」，将来要加提示也有地方挂。
  contextMenu: 'lifelens:launcher-context-menu',
});

function isUsableWindow(win) {
  if (!win) return false;
  return !(typeof win.isDestroyed === 'function' && win.isDestroyed());
}

// 拖动是高频输入：坐标必须是真数字才动窗口，
// 不能因为一个坏包（undefined / 字符串 / NaN）把圆标瞬间挪到别处。
function isFinitePoint(position) {
  return typeof position?.x === 'number' && Number.isFinite(position.x)
    && typeof position?.y === 'number' && Number.isFinite(position.y);
}

// 三处共用（launcher 点击 / second-instance / macOS activate）：
// 主窗口不存在（已销毁）-> 重建；隐藏或最小化 -> 显示并聚焦；已经可见 -> 只聚焦。
// 写成注入 getWindow / createWindow 的形态，三个分支都能用假窗口单测。
function showOrFocusMainWindow({ getWindow, createWindow }) {
  const win = getWindow?.();
  if (!isUsableWindow(win)) {
    createWindow?.();
    return 'created';
  }

  const minimized = typeof win.isMinimized === 'function' && win.isMinimized();
  const hidden = typeof win.isVisible === 'function' && !win.isVisible();
  if (minimized) win.restore();
  if (hidden) win.show();
  win.focus();
  // 返回值只给测试与日志看：调用方不需要分支处理。
  return hidden || minimized ? 'shown' : 'focused';
}

// 拖动中的位置更新：clamp 放在 Main 侧，所以窗口不可能被拖到看不见的地方，
// 也不必信任 Renderer 传来的坐标。
function moveLauncherWindow({ window: win, x, y, workAreas }) {
  if (!isUsableWindow(win)) return null;
  if (!isFinitePoint({ x, y })) return null;
  const [width, height] = win.getSize();
  const target = clampToWorkArea({ x, y }, { width, height }, workAreas);
  win.setPosition(target.x, target.y);
  return target;
}

function createLauncherWindow({ x, y, isQuitting, size = LAUNCHER_SIZE } = {}) {
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
    title: 'LifeLensPlus 悬浮入口',
    // 无边框 + 透明 + 置顶 + 不进任务栏：一个贴在桌面上的小圆标。
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      // launcher 有自己的 preload：现有 preload.js 暴露了全部业务 API，这里只要三个窗口操作。
      preload: path.join(__dirname, '..', '..', 'launcherPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'launcher.html'));

  // 透明窗口先不显示，等首帧画好再出现，避免闪一下白底。
  win.once('ready-to-show', () => {
    if (isUsableWindow(win)) win.show();
  });

  // 与主窗口用同一个 quitting 标志：退出时放行销毁，平时只是藏起来。
  win.on('close', (event) => {
    if (isQuitting?.()) return;
    event.preventDefault();
    win.hide();
  });

  return win;
}

// Phase 13.1：右键菜单的模板。抽成纯函数是为了能在 node --test 里断言文案与动作，
// 不必真的弹出一个原生菜单（那需要 Electron 与真实显示器）。
//   openMain / toggleRecording / quitApp 三个动作由调用方注入，这里只负责编排。
function launcherMenuTemplate({ running, openMain, toggleRecording, quitApp }) {
  return [
    { label: '打开主界面', click: () => openMain?.() },
    // 文案跟着当前录制状态走：菜单里看到的就是点下去会发生的事。
    { label: running === true ? '暂停录制' : '恢复录制', click: () => toggleRecording?.() },
    { type: 'separator' },
    { label: '退出应用', click: () => quitApp?.() },
  ];
}

// launcher 的通道，只做四件事：打开主窗口 / 拖动中的 setPosition / 松手保存位置 / 右键菜单。
// menu 由调用方注入（main.js 传 Electron 的 Menu），测试传假对象：
// 这样「菜单里有什么、点了点谁」都能在纯 Node 里断言。
function registerLauncherIpc({
  ipcMain, getLauncherWindow, showOrFocusMainWindow, savePosition, getWorkAreas,
  getRecording, toggleRecording, quitApp, menu,
}) {
  ipcMain.handle(LAUNCHER_CHANNELS.open, () => {
    showOrFocusMainWindow();
    return true;
  });

  // 拖动中高频触发：用 on（不需要返回值），Renderer 侧是 send。
  ipcMain.on(LAUNCHER_CHANNELS.move, (_event, position) => {
    moveLauncherWindow({
      window: getLauncherWindow?.(),
      x: position?.x,
      y: position?.y,
      workAreas: getWorkAreas?.(),
    });
  });

  // 松手才写盘：拖动过程不碰磁盘。
  ipcMain.handle(LAUNCHER_CHANNELS.end, async () => {
    const win = getLauncherWindow?.();
    if (!isUsableWindow(win)) return null;
    const [x, y] = win.getPosition();
    return savePosition({ x, y });
  });

  // 右键菜单：原生 Menu，三项，没有二级菜单。
  // running 是「此刻」的真实状态，不是缓存的：菜单文案与实际行为不会错位。
  ipcMain.handle(LAUNCHER_CHANNELS.contextMenu, () => {
    const win = getLauncherWindow?.();
    if (!isUsableWindow(win)) return false;
    const built = menu?.buildFromTemplate?.(launcherMenuTemplate({
      running: getRecording?.() === true,
      openMain: () => showOrFocusMainWindow?.(),
      toggleRecording: () => toggleRecording?.(),
      quitApp: () => quitApp?.(),
    }));
    if (!built) return false;
    built.popup({ window: win });
    return true;
  });
}

module.exports = {
  LAUNCHER_SIZE,
  LAUNCHER_CHANNELS,
  showOrFocusMainWindow,
  moveLauncherWindow,
  launcherMenuTemplate,
  createLauncherWindow,
  registerLauncherIpc,
};
