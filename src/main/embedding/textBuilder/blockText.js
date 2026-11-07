'use strict';

const { labeled, listText } = require('./lines');

// 10 分钟 Block 的 embedding 文本（Phase 10）。
// 项目 + 类型 + 描述 + 软件 + 待办，回答「这 10 分钟主要做了什么」：
//
//   项目：Life Lens
//   类型：工作
//   这 10 分钟主要在开发 Life Lens 的 SQLite 数据层，完成了 ActivityRepository 设计，验证了事务一致性。
//   软件：VS Code、Chrome、Terminal
//   待办：补充数据库恢复测试。
//
// 返回空串表示这条区块没有可嵌入的内容（服务标记 FAILED）。
function buildBlockText(block = {}) {
  return [
    labeled('项目', block.project),
    labeled('类型', block.category),
    String(block.description ?? '').trim() || null,
    labeled('软件', listText(block.software)),
    labeled('待办', listText(block.todos, '；')),
  ].filter(Boolean).join('\n');
}

module.exports = { buildBlockText };
