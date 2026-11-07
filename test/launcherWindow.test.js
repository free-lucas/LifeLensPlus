'use strict';

// Phase 13：悬浮入口的窗口逻辑与 IPC 绑定的单测。
// 真的 BrowserWindow 跑不了（node --test 里没有 Electron），所以这里全部用假窗口 / 假 ipcMain：
// 「不存在 -> 创建」「隐藏 -> 显示并聚焦」「可见 -> 只聚焦」三个分支，
// 以及三个通道各自做了什么，都能在纯 Node 里断言。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LAUNCHER_CHANNELS,
  showOrFocusMainWindow,
  moveLauncherWindow,
  launcherMenuTemplate,
  registerLauncherIpc,
} = require('../src/main/launcher/launcherWindow');

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const SCREENS = [PRIMARY];

// 假主窗口：只记录被调用的动作，用来判断走了哪个分支。
function fakeWindow({ destroyed = false, visible = true, minimized = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    show: () => calls.push('show'),
    hide: () => calls.push('hide'),
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus'),
  };
}

// 假 launcher 窗口：只需要 getSize / getPosition / setPosition。
function fakeLauncherWindow({ position = [0, 0], destroyed = false } = {}) {
  let current = position;
  const calls = [];
  return {
    setPositionCalls: calls,
    isDestroyed: () => destroyed,
    getSize: () => [56, 56],
    getPosition: () => current,
    setPosition: (x, y) => {
      current = [x, y];
      calls.push([x, y]);
    },
  };
}

// ---- showOrFocusMainWindow：三个分支 ----

test('悬浮窗口 1：主窗口不存在（或已销毁）时重建', () => {
  let created = 0;
  assert.equal(showOrFocusMainWindow({ getWindow: () => null, createWindow: () => { created += 1; } }), 'created');
  assert.equal(created, 1);

  // 窗口对象还在但已经销毁：同样按「不存在」处理，不能对死窗口调 show/focus。
  const dead = fakeWindow({ destroyed: true });
  assert.equal(showOrFocusMainWindow({ getWindow: () => dead, createWindow: () => { created += 1; } }), 'created');
  assert.equal(created, 2);
  assert.deepEqual(dead.calls, []);
});

test('悬浮窗口 2：主窗口隐藏时显示并聚焦', () => {
  const win = fakeWindow({ visible: false });
  assert.equal(showOrFocusMainWindow({ getWindow: () => win, createWindow: () => assert.fail('不该重建') }), 'shown');
  assert.deepEqual(win.calls, ['show', 'focus']);
});

test('悬浮窗口 3：主窗口可见时只聚焦，不做多余的 show', () => {
  const win = fakeWindow({ visible: true });
  assert.equal(showOrFocusMainWindow({ getWindow: () => win, createWindow: () => assert.fail('不该重建') }), 'focused');
  assert.deepEqual(win.calls, ['focus']);
});

test('悬浮窗口 4：最小化的主窗口先还原再聚焦', () => {
  // Windows 上最小化窗口的 isVisible() 仍然可能是 true，所以还原与显示是两件事。
  const minimized = fakeWindow({ visible: true, minimized: true });
  assert.equal(showOrFocusMainWindow({ getWindow: () => minimized, createWindow: () => assert.fail('不该重建') }), 'shown');
  assert.deepEqual(minimized.calls, ['restore', 'focus']);

  const minimizedHidden = fakeWindow({ visible: false, minimized: true });
  showOrFocusMainWindow({ getWindow: () => minimizedHidden, createWindow: () => assert.fail('不该重建') });
  assert.deepEqual(minimizedHidden.calls, ['restore', 'show', 'focus']);
});

// ---- 拖动中的位置更新 ----

test('悬浮窗口 5：拖动位置在 Main 侧被 clamp 后再 setPosition', () => {
  const win = fakeLauncherWindow({ position: [100, 100] });
  assert.deepEqual(moveLauncherWindow({ window: win, x: 5000, y: 5000, workAreas: SCREENS }), { x: 1864, y: 984 });
  assert.deepEqual(win.setPositionCalls, [[1864, 984]]);
  assert.deepEqual(win.getPosition(), [1864, 984]);

  // 可见范围内的位置原样下发。
  moveLauncherWindow({ window: win, x: 300, y: 200, workAreas: SCREENS });
  assert.deepEqual(win.setPositionCalls[1], [300, 200]);
});

test('悬浮窗口 6：窗口已销毁时拖动什么也不做', () => {
  const win = fakeLauncherWindow({ destroyed: true });
  assert.equal(moveLauncherWindow({ window: win, x: 10, y: 10, workAreas: SCREENS }), null);
  assert.equal(moveLauncherWindow({ window: null, x: 10, y: 10, workAreas: SCREENS }), null);
  assert.deepEqual(win.setPositionCalls, []);
});

// ---- IPC 注册 ----

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle(channel, handler) { handlers.set(channel, handler); },
    on(channel, listener) { listeners.set(channel, listener); },
    hasHandle: (channel) => handlers.has(channel),
    hasListener: (channel) => listeners.has(channel),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    emit: (channel, ...args) => listeners.get(channel)({}, ...args),
  };
}

// 假 Menu：只记录「收到什么模板、弹了几次、弹在哪个窗口上」。
// 真的原生菜单需要一个真实显示器，而这里要断言的是模板与动作编排。
function fakeMenu({ built = true } = {}) {
  const templates = [];
  const popups = [];
  return {
    templates,
    popups,
    buildFromTemplate(template) {
      templates.push(template);
      if (!built) return null;
      return { popup: (options) => popups.push(options) };
    },
  };
}

function makeIpc({
  launcher = fakeLauncherWindow(),
  onOpen = () => {},
  running = false,
  onToggle = () => {},
  onQuit = () => {},
  menu = fakeMenu(),
} = {}) {
  const ipcMain = fakeIpcMain();
  const saved = [];
  registerLauncherIpc({
    ipcMain,
    getLauncherWindow: () => launcher,
    showOrFocusMainWindow: onOpen,
    savePosition: async (position) => { saved.push(position); return position; },
    getWorkAreas: () => SCREENS,
    getRecording: () => running,
    toggleRecording: onToggle,
    quitApp: onQuit,
    menu,
  });
  return { ipcMain, launcher, saved, menu };
}

test('悬浮窗口 7：注册四条通道，channel 名与触发方式正确', async () => {
  const { ipcMain } = makeIpc();

  assert.deepEqual(LAUNCHER_CHANNELS, {
    open: 'lifelens:launcher-open',
    move: 'lifelens:launcher-move',
    end: 'lifelens:launcher-end',
    contextMenu: 'lifelens:launcher-context-menu',
  });
  assert.equal(ipcMain.hasHandle('lifelens:launcher-context-menu'), true);
  assert.equal(ipcMain.hasListener('lifelens:launcher-context-menu'), false);
  // open / end 需要返回值，用 handle；move 是高频单向事件，用 on。
  assert.equal(ipcMain.hasHandle('lifelens:launcher-open'), true);
  assert.equal(ipcMain.hasHandle('lifelens:launcher-end'), true);
  assert.equal(ipcMain.hasListener('lifelens:launcher-move'), true);
  assert.equal(ipcMain.hasHandle('lifelens:launcher-move'), false);
});

test('悬浮窗口 8：lifelens:launcher-open 调 showOrFocusMainWindow', async () => {
  let opened = 0;
  const { ipcMain, saved } = makeIpc({ onOpen: () => { opened += 1; } });

  assert.equal(await ipcMain.invoke('lifelens:launcher-open'), true);
  assert.equal(opened, 1);
  // 只是打开主窗口：不写位置。
  assert.deepEqual(saved, []);
});

test('悬浮窗口 9：lifelens:launcher-move 直接下发位置，结束才保存', async () => {
  const { ipcMain, launcher, saved } = makeIpc();

  ipcMain.emit('lifelens:launcher-move', { x: 4000, y: 4000 });
  assert.deepEqual(launcher.getPosition(), [1864, 984]);
  assert.deepEqual(saved, [], '拖动过程中不写盘');

  ipcMain.emit('lifelens:launcher-move', { x: 250.4, y: 120.6 });
  assert.deepEqual(launcher.getPosition(), [250, 121]);

  assert.deepEqual(await ipcMain.invoke('lifelens:launcher-end'), { x: 250, y: 121 });
  assert.deepEqual(saved, [{ x: 250, y: 121 }]);
});

test('悬浮窗口 10：非法位置不改变窗口，销毁后 end 不保存', async () => {
  const launcher = fakeLauncherWindow({ position: [120, 80] });
  const { ipcMain, saved } = makeIpc({ launcher });

  ipcMain.emit('lifelens:launcher-move', null);
  ipcMain.emit('lifelens:launcher-move', { x: 'abc', y: undefined });
  assert.deepEqual(launcher.setPositionCalls, []);

  const dead = makeIpc({ launcher: fakeLauncherWindow({ position: [1, 2], destroyed: true }) });
  assert.equal(await dead.ipcMain.invoke('lifelens:launcher-end'), null);
  assert.deepEqual(dead.saved, []);
  assert.deepEqual(saved, []);
});

// ---- Phase 13.1：右键菜单 ----

test('悬浮窗口 11：菜单模板三项 + 分隔线，文案跟着 running 走', () => {
  const idle = launcherMenuTemplate({ running: false, openMain() {}, toggleRecording() {}, quitApp() {} });
  assert.deepEqual(idle.map((item) => item.label ?? item.type), ['打开主界面', '恢复录制', 'separator', '退出应用']);

  const running = launcherMenuTemplate({ running: true, openMain() {}, toggleRecording() {}, quitApp() {} });
  assert.deepEqual(running.map((item) => item.label ?? item.type), ['打开主界面', '暂停录制', 'separator', '退出应用']);
  // 极简菜单：没有二级菜单、没有多余的项。
  assert.equal(idle.every((item) => !item.submenu), true);
});

test('悬浮窗口 12：右键通道弹出菜单，popup 挂在 launcher 窗口上', async () => {
  const menu = fakeMenu();
  const { ipcMain, launcher } = makeIpc({ menu, running: true });

  assert.equal(await ipcMain.invoke('lifelens:launcher-context-menu'), true);
  assert.equal(menu.templates.length, 1);
  assert.deepEqual(menu.popups, [{ window: launcher }]);
  assert.equal(menu.templates[0][1].label, '暂停录制');
});

test('悬浮窗口 13：菜单三项分别打开主窗口 / 切换录制 / 退出应用', async () => {
  let opened = 0;
  let toggled = 0;
  let quit = 0;
  const menu = fakeMenu();
  const { ipcMain } = makeIpc({
    menu,
    running: false,
    onOpen: () => { opened += 1; },
    onToggle: () => { toggled += 1; },
    onQuit: () => { quit += 1; },
  });

  await ipcMain.invoke('lifelens:launcher-context-menu');
  const [, resume, , exit] = menu.templates[0];
  assert.equal(resume.label, '恢复录制');

  menu.templates[0][0].click();
  resume.click();
  exit.click();
  assert.equal(opened, 1);
  assert.equal(toggled, 1);
  assert.equal(quit, 1);
});

test('悬浮窗口 14：窗口已销毁或拿不到 Menu 时不弹菜单', async () => {
  const dead = fakeMenu();
  const deadIpc = makeIpc({ launcher: fakeLauncherWindow({ destroyed: true }), menu: dead });
  assert.equal(await deadIpc.ipcMain.invoke('lifelens:launcher-context-menu'), false);
  assert.deepEqual(dead.templates, []);

  // 没注入 menu（或注入了一个构建失败的对象）：清 false，不抛错。
  // 显式传 null：undefined 会被解构默认值替换成假 Menu。
  const empty = makeIpc({ menu: null });
  assert.equal(await empty.ipcMain.invoke('lifelens:launcher-context-menu'), false);
  const broken = makeIpc({ menu: fakeMenu({ built: false }) });
  assert.equal(await broken.ipcMain.invoke('lifelens:launcher-context-menu'), false);
});