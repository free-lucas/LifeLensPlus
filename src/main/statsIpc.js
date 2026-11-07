'use strict';

// Phase 9：看板的 IPC 通道。
// 一个周期（日 / 周 / 月 / 年）只走一次查询，Main 把聚合结果整体交给界面，
// 界面因此不需要自己算日期边界、占比或时长。

const STATS_CHANNEL = 'lifelens:stats';

function registerStatsIpc({ ipcMain, stats }) {
  ipcMain.handle(STATS_CHANNEL, (_event, query) => stats.summarize(query));
}

module.exports = { registerStatsIpc, STATS_CHANNEL };