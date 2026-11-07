# 变更记录：Phase 7.3 — Timeline 搜索与筛选

## 1. 这一阶段做了什么

在 Phase 7.2 的活动时间线上加**结构化搜索 + 筛选**：

- 关键词搜索：Activity / Summary / Project / Keywords 四列子串匹配，支持中文与 emoji；
- 时间范围：全部 / 今天 / 昨天 / 最近 7 天 / 自定义起止日期；
- Category、Project 筛选（Project 含「无项目」），AI 状态三档（已完成 / 分析中 / 失败）；
- 以上条件可任意组合，结果只在 Main / SQLite 层筛，界面不整批加载历史数据；
- 筛选栏复用 Phase 7.2 的时间线容器，空状态区分「没有记录」与「没有符合条件的记录」。

没有改动 Recorder、AI Worker、AI Queue、SQLite schema，也没有改 Phase 7.1 已定的 `queryTimeline` 参数含义（只做加法）。

## 2. 修改文件

| 文件 | 变更 | 原因 |
| --- | --- | --- |
| `src/main/db/repositories/ActivityRepository.js` | 扩展 `normalizeTimelineQuery`（search / category / project / noProject / status）；新增 `normalizeFilterText`、`escapeLike`、`TIMELINE_STATUS_FILTERS`、`TIMELINE_SEARCH_*`；新增 `listFacets()` 与三条 facet prepared statement | 筛选逻辑全部下沉到数据层，复用 Phase 7.1 的 WHERE 片段缓存 |
| `src/main/timelineIpc.js` | 新增通道 `lifelens:timeline-facets` | 下拉选项由 Main 提供，Renderer 不拼数据 |
| `src/preload.js` | 新增 `getTimelineFacets()` | 沿用既有 preload 白名单风格 |
| `src/renderer/timeline.js` | 新增纯函数 `startOfDay` / `addDays` / `parseDateInput` / `resolveTimeRange` / `buildTimelineQuery` / `hasActiveFilters` / `matchesFilters`，新增 `createFilterBar`；`createTimelineView` 接 `filterRoot` 与 `getFacets` | 筛选栏与查询构造集中在时间线模块，纯函数可单测 |
| `src/renderer/index.html` | 时间线上方新增 `#timeline-filters` 筛选栏 | 复用既有容器，不另起页面 |
| `src/renderer/styles.css` | 新增 `.timeline-filters` / `.timeline-search` / `.timeline-select` / `.timeline-custom-range` / `.timeline-clear` 样式 | 与既有玻璃卡片视觉语言一致 |
| `test/timelineFilter.test.js` | **新增**：12 个用例 | 覆盖搜索 / 各维筛选 / 组合 / 分页 / facets / IPC 契约 |
| `test/timelineView.test.js` | **新增** 4 个用例（12~15），全局污染守卫名单加长 | 覆盖新增的渲染层纯函数 |
| `test/timeline.test.js` | 用例 12 的通道断言改为两个通道 | IPC 注册表新增通道后同步断言 |

## 3. 搜索 / 筛选 API 设计

- `ActivityRepository.queryTimeline(options)` 新增 `search` / `category` / `project` / `noProject` / `status`，与原有时间边界、分页参数合并成同一条 `WHERE`；
- 关键词走 `col LIKE ? ESCAPE ?` 四列 OR，`%` / `_` / `\` 由 `escapeLike()` 转义后再绑定，用户输入的 `%` 不会变成通配符；
- 「分析中」= `analysis_status NOT IN ('COMPLETED', 'FAILED')`，与渲染层 `statusOf()` 的兜底口径一致；
- `project` 与 `noProject` 互斥，同时给时以 `noProject` 为准；
- 认不出的 `status` 与空字符串条件一律不加约束，不抛错；
- 新增 `listFacets()` 返回 `{ categories, projects, hasUnassignedProject }`，选项从已有数据 `DISTINCT` 取。

接口参数表、SQL 与语义细节见《[13-Timeline搜索与筛选](13-Timeline搜索与筛选.md)》。

## 4. UI 实现

- 筛选栏固定单行：搜索框（可伸缩）+ 时间范围 + 分类 + 项目 + 状态 + 清除筛选；
- 搜索框 300ms 防抖、回车立即生效；其余控件 change 立即生效；
- 选择「自定义时间」才显示两个日期输入，日期按本地时间解析（避免 UTC 差一天），结束日期含当天；
- 每次条件变化重新查第一页并刷新下拉选项（保留当前选择）；
- 加载更多携带同一组筛选条件，翻页不越界；
- 新截图前插与 AI 结果回填先经 `matchesFilters()`：不符合当前筛选的不插入，回填后不再符合条件的卡片移除；
- 清除筛选回到首屏状态。

## 5. 新增测试

```text
test/timelineFilter.test.js    12 例（新增文件）
test/timelineView.test.js      +4 例（11 -> 15）
test/timeline.test.js          1 例断言同步（通道列表）
```

## 6. 测试结果

```text
Before（Phase 7.2 结束）: # tests 103  # pass 103  # fail 0
After （Phase 7.3）     : # tests 119  # pass 119  # fail 0
```

`npm test` = `node --test test/*.test.js`，全部 mock，不需要 Ollama / GPU。

## 7. Electron 真实验证

真实启动 `electron.exe .`（`LIFELENS_DIR` 指向 42 条种子数据、`LIFELENS_AUTOSTART=0`、独立 `--user-data-dir` 与调试端口），经 CDP 操作界面并读回 DOM，链路是 Renderer -> Preload -> IPC -> Main -> SQLite。

```text
通过 47/47
```

覆盖：首屏 20 条与加载更多、下拉选项来自真实数据、搜索 SQLite（33 条，翻页取完）、中文搜索、无结果空状态、清除筛选、今天 10 / 昨天 6 / 最近 7 天 34、自定义范围 10 与 16、分类 learning 11、项目 Life Lens 12、无项目 13、分析中 2、失败 1、已完成 + 今天 7、组合筛选（最近 7 天 + coding + SQLite）17，以及筛选栏单行不换行的布局断言。

## 8. 本阶段发现并修复的问题

- **`.timeline-custom-range` 的 `display: flex` 盖掉了 `hidden`**：自定义日期输入在未选择「自定义」时也会显示。补 `.timeline-custom-range[hidden] { display: none; }` 后恢复。
- **筛选栏在窄窗口换行**：搜索框固定宽度导致整条换行。改为可伸缩宽度 + 清除按钮 `margin-left: auto`，实测单行。
- 以上两条都是真实 Electron 测量发现的，单元测试覆盖不到。
- 另外，`test/timeline.test.js` 里断言 IPC 通道清单的用例在注册表变化后会失败，本次同步更新为两个通道。

## 9. Scope Check

```text
语义搜索 / Embedding / 向量库 / RAG / AI 搜索 / Memory / Agent /
Daily Review / 统计仪表盘 / 保存的筛选视图 / 高级查询语法 / 时间线导出 : NOT IMPLEMENTED
```

## 10. 留给后续 Phase 的问题

- **LIKE 全表扫描**：数据量上来后应换 FTS5 虚拟表（本阶段按最小实现不做）。
- **「无项目」只看 NULL 与空串**：全空白字符串的项目不算「无项目」。
- **未分析的记录搜不到**：PENDING / FAILED 记录的四个可搜字段都为 NULL，关键词搜索不会命中；按状态筛选仍能看到它们。
- **自定义范围只到天**：没有小时级粒度。
- **分页仍是 offset 语义**：与 Phase 7.2 一样，长时间录制下的窗口化策略仍待后续处理。
