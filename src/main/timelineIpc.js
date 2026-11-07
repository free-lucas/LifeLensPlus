'use strict';

// Timeline 数据的 IPC 入口（Phase 7.1）。
// Renderer 拿 Timeline 数据只有一条链路：Renderer -> Preload -> IPC -> 这里 -> SQLite，
// 参数怎么校验、SQL 怎么写都在数据层（ActivityRepository.queryTimeline）里。
//
// 单独成模块是为了能在不启动 Electron 的情况下测 IPC 契约：测试注入一个假的 ipcMain。
const TIMELINE_CHANNEL = 'lifelens:timeline';
const TIMELINE_FACETS_CHANNEL = 'lifelens:timeline-facets';

function registerTimelineIpc({ ipcMain, activities }) {
  ipcMain.handle(TIMELINE_CHANNEL, (_event, query) => activities.queryTimeline(query));
  // 筛选选项（分类 / 项目）也走同一条链路：Renderer 不自己维护一份清单。
  ipcMain.handle(TIMELINE_FACETS_CHANNEL, () => activities.listFacets());
}

module.exports = { registerTimelineIpc, TIMELINE_CHANNEL, TIMELINE_FACETS_CHANNEL };
