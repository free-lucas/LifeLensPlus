'use strict';

// 动态页（Phase 8）的 IPC 入口：10 分钟区块的查询、筛选选项与汇总状态。
// Renderer 拿数据仍然只有一条链路：Renderer -> Preload -> IPC -> 这里 -> SQLite。
// 与 timelineIpc 一样单独成模块，测试注入假的 ipcMain 就能测 IPC 契约。
const TIME_BLOCKS_CHANNEL = 'lifelens:time-blocks';
const TIME_BLOCKS_FACETS_CHANNEL = 'lifelens:time-blocks-facets';
const SUMMARY_STATUS_CHANNEL = 'lifelens:summary-status';

function registerSummaryIpc({ ipcMain, timeBlocks, summarizer }) {
  ipcMain.handle(TIME_BLOCKS_CHANNEL, (_event, query) => timeBlocks.queryBlocks(query));
  // 筛选选项（项目 / 软件）同样由 Main 提供，Renderer 不自己维护一份清单。
  ipcMain.handle(TIME_BLOCKS_FACETS_CHANNEL, () => timeBlocks.listFacets());
  // 「汇总中」标记的数据源。
  ipcMain.handle(SUMMARY_STATUS_CHANNEL, () => summarizer.snapshot());
}

module.exports = {
  registerSummaryIpc,
  TIME_BLOCKS_CHANNEL,
  TIME_BLOCKS_FACETS_CHANNEL,
  SUMMARY_STATUS_CHANNEL,
};
