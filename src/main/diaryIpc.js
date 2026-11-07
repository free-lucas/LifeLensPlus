'use strict';

const { dayBounds, dayKeyOf } = require('./day');

// Phase 9：日记页的 IPC 通道。
// 与 Timeline / 动态页相同的约定：Renderer 只走 IPC，SQL 与日期口径都在 Main。

const DIARY_CHANNEL = 'lifelens:diary';
const DIARY_DAYS_CHANNEL = 'lifelens:diary-days';
const DIARY_STATUS_CHANNEL = 'lifelens:diary-status';
const DIARY_REGENERATE_CHANNEL = 'lifelens:diary-regenerate';

function registerDiaryIpc({ ipcMain, diaries, timeBlocks, activities, generator }) {
  // 某一天的日记 + 这一天的区块概况（界面据此区分「没有记录」「还在汇总」「生成失败」）。
  ipcMain.handle(DIARY_CHANNEL, (_event, day) => {
    const today = dayKeyOf(new Date());
    const key = dayKeyOf(day) ?? today;
    const bounds = dayBounds(key);
    return {
      day: key,
      today: key === today,
      diary: diaries.getByDay(key),
      blocks: timeBlocks.daySummary(bounds.from, bounds.to),
      activityCount: activities.countBetween(bounds.from, bounds.to),
    };
  });

  // 日历标记：一段日期里每一天的日记状态、区块数与主要分类。
  ipcMain.handle(DIARY_DAYS_CHANNEL, (_event, query) => {
    const from = dayKeyOf(query?.from);
    const to = dayKeyOf(query?.to);
    if (!from || !to) return [];
    return diaries.listDayMarks(from, to);
  });

  // 「正在生成 N 篇日记」的数据源。
  ipcMain.handle(DIARY_STATUS_CHANNEL, () => generator.snapshot());

  // 手动重新生成某一天（失败或想重写时用）。
  ipcMain.handle(DIARY_REGENERATE_CHANNEL, (_event, day) => generator.regenerate(day));
}

module.exports = {
  registerDiaryIpc,
  DIARY_CHANNEL,
  DIARY_DAYS_CHANNEL,
  DIARY_STATUS_CHANNEL,
  DIARY_REGENERATE_CHANNEL,
};