'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lifelens', {
  getStatus: () => ipcRenderer.invoke('lifelens:status'),
  start: () => ipcRenderer.invoke('lifelens:start'),
  stop: () => ipcRenderer.invoke('lifelens:stop'),
  toggle: () => ipcRenderer.invoke('lifelens:toggle'),
  listRecent: (limit) => ipcRenderer.invoke('lifelens:recent', limit),
  getTimeline: (query) => ipcRenderer.invoke('lifelens:timeline', query),
  getTimelineFacets: () => ipcRenderer.invoke('lifelens:timeline-facets'),
  // 动态页（Phase 8）：10 分钟区块的查询、筛选选项与汇总状态。
  getTimeBlocks: (query) => ipcRenderer.invoke('lifelens:time-blocks', query),
  getTimeBlockFacets: () => ipcRenderer.invoke('lifelens:time-blocks-facets'),
  getSummaryStatus: () => ipcRenderer.invoke('lifelens:summary-status'),
  // 日记页（Phase 9）：某一天的日记、日历标记、生成状态与手动重新生成。
  getDiary: (day) => ipcRenderer.invoke('lifelens:diary', day),
  getDiaryDays: (query) => ipcRenderer.invoke('lifelens:diary-days', query),
  getDiaryStatus: () => ipcRenderer.invoke('lifelens:diary-status'),
  regenerateDiary: (day) => ipcRenderer.invoke('lifelens:diary-regenerate', day),
  // 看板（Phase 9）：一个周期的全部统计。
  getStats: (query) => ipcRenderer.invoke('lifelens:stats', query),
  // 搜索（Phase 11）：跨 20 秒记录 / 10 分钟汇总 / 日记三层记忆的语义检索。
  searchMemories: (query, limit) => ipcRenderer.invoke('lifelens:memory-search', { query, limit }),
  // 问答（Phase 12）：用一个关于过去的问题，换取基于检索到记忆的回答。
  ask: (question) => ipcRenderer.invoke('lifelens:ask', { question }),
  openOutputDir: () => ipcRenderer.invoke('lifelens:open-output-dir'),
  openImage: (file) => ipcRenderer.invoke('lifelens:open-image', file),
  // 悬浮入口常驻后，关窗口只是隐藏，所以主界面需要一个显式退出入口（Phase 13）。
  quit: () => ipcRenderer.invoke('lifelens:quit'),
  getAiStatus: () => ipcRenderer.invoke('lifelens:ai-status'),
  pauseAi: () => ipcRenderer.invoke('lifelens:ai-pause'),
  resumeAi: () => ipcRenderer.invoke('lifelens:ai-resume'),
  reanalyze: (screenshotId) => ipcRenderer.invoke('lifelens:ai-reanalyze', screenshotId),
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('lifelens:event', handler);
    return () => ipcRenderer.removeListener('lifelens:event', handler);
  },
});
