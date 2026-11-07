'use strict';

// Phase 13：悬浮入口专用的 preload（Phase 13.1 加了右键菜单与事件订阅）。
// 不复用 src/preload.js：那个暴露了全部业务 API，而 56x56 的圆标只需要几个窗口操作。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lifelensLauncher', {
  // 点击：打开 / 聚焦主界面。
  openMain: () => ipcRenderer.invoke('lifelens:launcher-open'),
  // 拖动中：位置交给 Main 校正（clamp）后 setPosition。高频调用，不需要返回值。
  dragMove: (position) => ipcRenderer.send('lifelens:launcher-move', position),
  // 拖动结束：让 Main 保存当前位置。
  dragEnd: () => ipcRenderer.invoke('lifelens:launcher-end'),
  // 右键：让 Main 弹出原生菜单（菜单内容与动作都在主进程，这里只发一个信号）。
  showContextMenu: () => ipcRenderer.invoke('lifelens:launcher-context-menu'),
  // 事件：Main 侧的 broadcastLauncher 只发特效需要的字段（status.running / 类型）。
  // 返回取消订阅函数，页面销毁时能干净解绑。
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('lifelens:launcher-event', handler);
    return () => ipcRenderer.removeListener('lifelens:launcher-event', handler);
  },
});
