'use strict';

const { labeled, listText } = require('./lines');

// 20 秒 Activity 的 embedding 文本（Phase 10）。
// 嵌入的是「构造过的语义文本」，不是 JSON.stringify，也不是单字段：
// 项目 + 当前活动 + 摘要 + 关键词，回答「我当时具体在干什么」。
//
//   项目：Life Lens
//   当前活动：开发 SQLite 数据层
//   正在实现 ActivityRepository 与事务封装，关注事务一致性、AI Job 关联与崩溃恢复。
//   关键词：SQLite、Repository、Transaction、AI Job
//
// 返回空串表示这条记录没有可嵌入的内容，服务会把它标记为 FAILED，不写空向量。
function buildActivityText(record = {}) {
  return [
    labeled('项目', record.project),
    labeled('当前活动', record.activity),
    String(record.summary ?? '').trim() || null,
    labeled('关键词', listText(record.keywords)),
  ].filter(Boolean).join('\n');
}

module.exports = { buildActivityText };
