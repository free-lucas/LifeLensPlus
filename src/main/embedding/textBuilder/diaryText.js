'use strict';

const { labeled, listText } = require('./lines');

// 1 天 Diary 的 embedding 文本（Phase 10）。
// 日期 + 总结 + 主要事项，回答「这一天整体发生了什么」，是三层里最粗的长期记忆节点：
//
//   日期：2026-09-17
//   今天主要围绕 Life Lens 项目开发，完成 Timeline、Dynamic、Diary、Dashboard，并开始设计个人生活问答。
//   主要事项：Timeline 搜索；Dashboard；Q&A 设计
//
// day 是日记的业务主键，永远存在，所以日记文本至少有一行。
function buildDiaryText(diary = {}) {
  return [
    labeled('日期', diary.day),
    String(diary.summary ?? '').trim() || null,
    labeled('主要事项', listText(diary.mainEvents, '；')),
  ].filter(Boolean).join('\n');
}

module.exports = { buildDiaryText };
