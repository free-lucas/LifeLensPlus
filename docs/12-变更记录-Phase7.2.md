# 变更记录：Phase 7.2 — Timeline UI

## 1. 这一阶段做了什么

把页面第 3 个 section 的「最近分析结果」升级成**活动时间线**：

- 按 `captured_at` 倒序回看活动，按本地自然日分组（组头 `YYYY-MM-DD 周X`，当天显示「今天」）；
- 截图内嵌成缩略图（纯 CSS 压缩，不生成小图文件）；
- 每张卡片展示 时间 / Activity / Summary / 分类 · 项目 · 把握% / 关键词 / AI 状态 / 查看截图；
- 「加载更多」分页；`record` / `analysis` 事件驱动实时前插与就地回填；
- Loading / Empty / Error 三态都在时间线区域内表达。

数据层没有改动：仍然只走 Phase 7.1 的 `window.lifelens.getTimeline(query)`。

## 2. 修改文件

| 文件 | 变更 | 原因 |
| --- | --- | --- |
| `src/renderer/timeline.js` | **新增**：纯函数（`imagePathToFileUrl` / `formatClock` / `formatDayLabel` / `groupByDay` / `statusOf`）+ 视图工厂 `createTimelineView` + DOM 初始化 | 时间线的全部逻辑独立成文件，纯函数可单测 |
| `src/renderer/index.html` | CSP：`img-src 'self'` → `img-src 'self' file:`；`#list` 区域替换为 `#timeline` + `#timeline-more`；新增 `<script src="timeline.js">` | 内嵌截图 + 时间线容器 + 脚本顺序 |
| `src/renderer/renderer.js` | 删除 `records` 状态、`renderRecords()`、`renderAnalysisBody()`、`#list` 点击处理与 `listRecent` 调用；`record` / `analysis` 事件转发给时间线；「刷新」触发 `timeline.reload()` | 列表逻辑迁移到时间线，事件流保持不变 |
| `src/renderer/styles.css` | 新增 `.timeline-*` / `.timeline-status-*` / `.timeline-thumb*` / `.record.failed`；删除因本次替换而失效的 `.record-badge` / `.record-path` / `.records li.empty` | 复用既有玻璃卡片语言，不留死样式 |
| `test/timelineView.test.js` | **新增**：11 个用例 | 覆盖 file URL 转换、时间格式、分组、状态映射、全局作用域隔离 |

没有改动 Main Process、Recorder、AI Worker、AI Queue、SQLite schema，也没有改 Phase 7.1 的 `queryTimeline` / `getTimeline` 契约。

## 3. 相对现有 UI 的改动清单

1. `#list`（`<ol>` + `.record` 列表）被 `#timeline`（按日分组的卡片流）替换，仍在同一位置、同一 section 序号 3。
2. section 标题「最近分析结果」→「活动时间线」。
3. CSP 只放开一项：`img-src 'self' file:`。
4. 卡片新增缩略图与 AI 状态标识；时间从 `YYYY-MM-DD HH:mm:ss` 变成 `HH:mm`（分组头承担日期）。
5. 卡片不再显示截图绝对路径（缩略图可见 + 「查看截图」按钮仍在，路径变成冗余信息）。
6. 内存列表 `records.slice(0, 30)` 被分页状态替代：首屏 20 条 + 「加载更多」。
7. 事件处理迁移：`record` 由「unshift 到数组」改为「前插 DOM 到顶部（按 id 去重）」；
   `analysis` 由「整表重渲染」改为「只替换对应卡片」。
8. 「查看截图」按钮、`openImage` 白名单校验、系统查看器行为全部保持原样。

## 4. 截图加载方案

- `imagePath`（Windows 绝对路径）→ `file:///` URL：

```text
C:\Users\a b\中文#1.png → file:///C:/Users/a%20b/%E4%B8%AD%E6%96%87%231.png
```

  规则：反斜杠 → 正斜杠；盘符冒号保留字面量（`file:///C:/...`，不是 `file://C:/...`，也不是 `file:///C%3A/...`）；
  其余路径段逐段 `encodeURIComponent`（中文 / 空格 / `#` 都不会截断 URL）；写进 HTML 前统一 `escapeHtml`。
- 缩略图是纯 CSS 限制尺寸（`168 × 104` + `object-fit: cover`）并 `loading="lazy"`，没有缩略图生成管线。
- 加载失败（文件被移动 / 删除）：`addEventListener('error')` 把该 `<img>` 换成「截图不可用」占位块。
  没有用内联 `onerror`——CSP 的 `script-src 'self'` 会拦掉内联事件处理器。
- 实测：真实窗口里 `<img>` 的 `naturalWidth = 3440`（原图 3440×1440），说明 `file:` 没有被 CSP 拦截；
  控制台没有 CSP 违规记录；缺失文件的卡片只显示占位块，其余卡片与页面正常。

## 5. 分页与实时更新

- 首屏与「加载更多」都用 `getTimeline({ limit: 20 })`；`hasMore === false` 时按钮隐藏。
- **offset 不缓存**：下一次请求的 `offset` 就是当前已加载条数。新记录前插后这个数字自然 +1，
  服务端返回的页正好接在后面。
- 追加时按 `id` 去重；`patchRecord` 只替换命中的那张卡片，其余 DOM 不动。
- 实测（见第 7 节 PAGING）：20 条 → 前插 1 条（21）→ 翻页 41 → 46，46 条全部唯一、顺序与服务端一致、无遗漏。

## 6. 关键决策遵守情况

| 决策 | 状态 |
| --- | --- |
| 1 Timeline 替换「最近分析结果」，不建平行列表、不加导航 | 遵守（同一 section 位置，页面只有一个活动列表） |
| 2 截图内嵌：CSP 只加 `file:` + 正确的 `file:///` URL + 保留「查看截图」 | 遵守（`file:` 实测可用，未启用 privileged scheme，未放开到 `*`） |
| 3 缩略图纯 CSS + `loading="lazy"` + onerror 占位，不做缩略图管线 | 遵守（用 `addEventListener` 而非内联 onerror，见第 4 节） |
| 4 实时更新接入现有事件流；offset = 当前已加载条数 | 遵守（实测见第 7 节） |
| 5 时间用 `record.time`；按自然日分组；`HH:mm`；不用相对时间；无定时器 | 遵守（组头当天显示「今天」前缀） |
| 6 本阶段不做 reanalyze 按钮 | 遵守（卡片上没有「重新分析」） |
| 7 无框架 / 无打包器 / 无 ESM / CSS 追加；页大小等不做成设置 | 遵守（`timeline.js` 用普通 `<script>`，常量写死在文件里） |

## 7. Electron 实际验证（第十二节 8 项）

方式：真实 `main.js` + `preload.js` + 真实窗口，通过 CDP 读窗口 DOM 与截图；
`--user-data-dir` 指向独立目录以避开单实例锁。

| # | 项目 | 结果 |
| --- | --- | --- |
| 1 | 首屏加载 + 缩略图真实渲染 | 通过：CSP 为 `img-src 'self' file:`，缩略图 `complete=true / naturalWidth=3440`，控制台无 CSP 违规 |
| 2 | 卡片信息完整 | 通过：`21:12 / 编写代码 / 用户正在编写代码并参考项目文档 / 分类 coding · 项目 LifelinePlus · 把握 90% / 关键词：… / 查看截图` |
| 3 | 按自然日分组、倒序 | 通过：`今天 · 2026-09-14 周一(50)`、`2026-09-13 周日(8)`；id 序列严格倒序 |
| 4 | PENDING 显示「分析中」、FAILED 存在且显示原因 | 通过（种子数据）：`⏳ 分析中 / 分析中…`、`⚠ 分析失败 / 分析失败：Ollama 请求超时（120s） · AI_TIMEOUT`、`✓ 已分析 / 把握 94%` |
| 5 | 「加载更多」翻页不重不漏 | 通过：20 → 40 → 58，58 条唯一，`hasMore=false` 时按钮隐藏 |
| 6 | 录制中新卡片自动出现在顶部 + AI 完成后就地变更 | 通过（真实录制约 3 分钟，间隔 15s）：t=0 出现 PENDING 卡片 → t=15 同一张卡就地变成 `✓ 已分析` 并填上结构化结果 → t=20 新截图前插到顶部 → t=150 第三张前插 → t=195 它就地变成 `✓ 已分析`；全程没有手动刷新 |
| 7 | 空数据库显示空状态 | 通过：`还没有活动记录` + `Life Lens 会自动记录你的活动。` |
| 8 | 图片缺失显示占位、页面不崩 | 通过：该卡片显示「截图不可用」，其余卡片正常渲染，无未捕获异常 |

补充验证（分页 + 前插组合）：种 45 条历史记录（3 页）→ 首屏 20 条 → 开始监控 → 新截图前插（21 条）→
翻页 41 → 46 条，46 条唯一、顺序与服务端一致、`missing: [] / extra: []`。

## 8. 本阶段发现并修复的 bug

**`formatClock` 被 `renderer.js` 覆盖。** `renderer.js` 与 `timeline.js` 都是 classic script，共享全局作用域；
两边都定义了 `formatClock`，先加载的 `timeline.js` 的版本（`HH:mm`）被后加载的 `renderer.js` 版本
（`HH:mm:ss`，本来只给 AI 日志用）覆盖，组内时间被渲染成 `21:12:52`，违反决策 5。

- 修复：`timeline.js` 整个文件包进 IIFE，内部函数不再挂到全局。
- 回归测试：`test/timelineView.test.js` 用 `vm` 把 `timeline.js` 当 classic script 执行，断言 `pad` /
  `escapeHtml` / `formatClock` 等没有污染全局作用域。
- 由 Electron 实测发现（单元测试覆盖不到），修复后重新跑了全部场景。

## 9. 测试结果

```text
Before（Phase 7.1）: # tests 92  # pass 92  # fail 0
After （Phase 7.2）: # tests 103 # pass 103 # fail 0
```

- 新增 `test/timelineView.test.js` 11 个用例，未删改任何既有测试。
- `npm test` = `node --test test/*.test.js`，全部 mock，不需要 Ollama / GPU。

## 10. Scope Check

```text
搜索 / 筛选 / 统计仪表盘 / RAG / Embedding / Memory / Daily Review / Todo / Focus /
Productivity Score / Agent / 导航（Tab·Sidebar）/ reanalyze UI / 缩略图生成管线 /
主题切换 / 多语言 : NOT IMPLEMENTED
```

## 11. 留给后续 Phase 的问题

- **游标分页**：现在是 `offset` 分页。本次实测在「前插 + 翻页」下不重不漏，但依赖「offset = 已加载条数」
  这条规则；真正稳定的是基于 `(captured_at, id)` 的游标分页。
- **长会话内存**：前插的记录只增不减（为了不破坏 offset 语义），长时间录制后 DOM 节点会持续增长，
  需要时再做窗口化 / 上限策略。
- **缩略图性能**：现在每次都解码原图（3440×1440）再用 CSS 缩小；截图数量变大后应考虑生成缩略图文件
  （属于后续阶段）。
- **远端图片未被用到**：`imagePath` 指向的文件被移走时只能显示占位；「查看截图」仍会走系统查看器报错。
- **未接入的能力**：`lifelens:ai-reanalyze` 的 UI、按分类 / 项目筛选、搜索都还空着；Timeline 已经提供了
  稳定的渲染与事件接入口，后续加这些不需要重写渲染层。