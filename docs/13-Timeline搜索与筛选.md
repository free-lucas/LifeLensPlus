# Timeline 搜索与筛选（Phase 7.3）

## 1. 目标与范围

在 Phase 7.2 的活动时间线之上加**结构化搜索 + 筛选**：关键词、时间范围、Category、Project、AI 状态可任意组合，让用户从大量 Activity 里快速定位记录。

搜索与筛选全部在 Main / SQLite 完成，Renderer 只负责收集条件与渲染结果——不会把历史数据整批拉到界面再过滤。

```text
Renderer 筛选栏（index.html + timeline.js）
  -> Preload: window.lifelens.getTimeline(query)
  -> IPC: lifelens:timeline
  -> Main: ActivityRepository.queryTimeline(options)
  -> SQLite: activities（WHERE + ORDER BY + LIMIT/OFFSET）

下拉选项来源
  -> Preload: window.lifelens.getTimelineFacets()
  -> IPC: lifelens:timeline-facets
  -> Main: ActivityRepository.listFacets()
```

不在本阶段：语义搜索 / Embedding / 向量库 / RAG / AI 搜索 / Memory / Agent / Daily Review / 统计仪表盘。

## 2. 数据层 API

### 2.1 queryTimeline(options)

在 Phase 7.1 的 `from` / `to` / `limit` / `offset` 之上扩展五个条件：

| 参数 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `search` | string | 无 | 关键词子串匹配，命中 activity / summary / project / keywords_json 任意一列 |
| `category` | string | 无 | 分类精确匹配 |
| `project` | string | 无 | 项目精确匹配 |
| `noProject` | boolean | `false` | 只看没有项目的记录 |
| `status` | string | 无 | `COMPLETED` / `PENDING` / `FAILED` |

参数归一化沿用 Phase 7.1 的取舍：**只有非空字符串才算条件**（`null` / 数字 / 全空白一律不筛）；`status` 先 `trim()` 再转大写，认不出的值不加条件，而不是让查询失败。

### 2.2 生成的 SQL

筛选条件的 SQL 片段固定，按固定顺序 `AND` 连接，再拼上 Phase 7.1 已有的 `captured_at` 边界：

```sql
-- 关键词：四列 OR，pattern 形如 %关键词%
(activity LIKE ? ESCAPE ? OR summary LIKE ? ESCAPE ? OR project LIKE ? ESCAPE ?
 OR keywords_json LIKE ? ESCAPE ?)

category = ?
project = ?
(project IS NULL OR project = '')      -- noProject
analysis_status = ?                    -- COMPLETED / FAILED
analysis_status NOT IN (?, ?)          -- PENDING：既没完成也没失败
```

- 排序、分页、COUNT 与 Phase 7.1 完全一致（`ORDER BY captured_at DESC, id DESC`）。
- 「分析中」取 `NOT IN (COMPLETED, FAILED)`：把 `PENDING` / `PROCESSING` 以及将来新增的中间状态都算进去，与渲染层 `statusOf()` 的兜底口径一致。
- `project` 与 `noProject` 互斥：同时传时以 `noProject` 为准，避免两个条件互相抵消成空结果。

### 2.3 LIKE 转义

用户输入直接进 LIKE 会把 `%` / `_` 当成通配符。`escapeLike()` 把 `\`、`%`、`_` 逐个前置反斜杠，SQL 统一写 `LIKE ? ESCAPE ?`，转义字符本身也走绑定参数（`LIKE_ESCAPE`），SQL 文本里不嵌引号。

因此输入 `100%` 只会命中真的包含 `100%` 的记录。

### 2.4 prepared statement 缓存

`WHERE` 组合数以条件种类为界。`_timelineStatements(where)` 以 **SQL 片段字符串为 key** 缓存「查询 + 计数」两条 prepared statement；条件值全部走绑定参数，所以同一个 SQL 形状不会因为关键词不同而重复 prepare。做法与 Phase 7.1 一致。

### 2.5 listFacets()

```js
{
  categories: ['browsing', 'coding', 'document', 'learning', 'media', 'shopping'],
  projects: ['Life Lens', 'Ollama'],
  hasUnassignedProject: true
}
```

- 选项来自**已有数据**的 `DISTINCT`，不在代码里另维护一份分类 / 项目定义。
- 只收非空值（`IS NOT NULL AND <> ''`）；`hasUnassignedProject` 决定界面要不要出现「无项目」这一项。

## 3. 界面

复用 Phase 7.2 的时间线容器，只在它上面加一条筛选栏（`#timeline-filters`），没有另起一套页面。

### 3.1 元素

| 元素 | 作用 |
| --- | --- |
| `#timeline-search` | 关键词输入（type=search，占位符写明搜索范围） |
| `#timeline-range` | 时间范围：全部 / 今天 / 昨天 / 最近 7 天 / 自定义 |
| `#timeline-custom-range` | 自定义日期（起止两个 type=date），仅在选择「自定义」时显示 |
| `#timeline-category` | 分类下拉，选项来自 `listFacets()` |
| `#timeline-project` | 项目下拉，选项来自 `listFacets()`，含「无项目」 |
| `#timeline-status` | AI 状态：全部 / 已完成 / 分析中 / 失败 |
| `#timeline-clear` | 一键清除全部筛选 |

### 3.2 交互约定

- **搜索框防抖 300ms**（`SEARCH_DEBOUNCE_MS`），回车立即生效；下拉与日期 change 立即生效。
- 每次条件变化都 `reload()`：重查第一页并刷新 facets（新分析出的分类 / 项目会进入下拉，且保留当前选择）。
- 分页：`limit` 固定 20，加载更多时带上**同一组筛选条件**与递增的 `offset`，翻页结果不会跳出筛选范围。
- 清除筛选回到「全部时间 + 无关键词」的首屏状态。
- 空状态区分两种文案：还没有活动记录 vs 没有符合条件的记录。
- 布局保持单行不换行（搜索框可伸缩，清除按钮靠右）。

### 3.3 时间范围的换算

时间范围在渲染层换算成与数据层一致的闭开区间 `[from, to)`，按**本地自然日**计算：

| 预设 | from | to |
| --- | --- | --- |
| 今天 | 今天 00:00 | 明天 00:00 |
| 昨天 | 昨天 00:00 | 今天 00:00 |
| 最近 7 天 | 6 天前 00:00 | 明天 00:00（含今天共 7 天） |
| 自定义 | 起始日期 00:00 | 结束日期次日 00:00（结束日含当天） |

`<input type=date>` 的 `YYYY-MM-DD` 必须按本地时间解析（`parseDateInput`）；直接 `new Date('2026-09-11')` 会按 UTC 解析，在东八区会整体差一天。

### 3.4 实时事件的处理

`record`（新截图）与 `analysis`（结果回填）两类事件仍由时间线就地处理，但会先用 `matchesFilters(record, filters)` 过一遍：

- 不符合当前筛选的新记录不插入；
- 回填后不再符合条件的卡片会被移除。

`matchesFilters` 的判定语义（闭开区间、分类 / 项目精确相等、关键词四字段、状态三档）与 `queryTimeline` 保持一致；它**只服务于实时事件**，正式查询仍然全部走 SQLite。

## 4. IPC 与 Preload

| 通道 | 参数 | 返回 |
| --- | --- | --- |
| `lifelens:timeline` | 与 `queryTimeline(options)` 同构 | 分页查询结果 |
| `lifelens:timeline-facets` | 无 | `listFacets()` 的结果 |

```js
// Renderer
const page = await window.lifelens.getTimeline({
  search, category, project, noProject, status, from, to, limit, offset,
});
const facets = await window.lifelens.getTimelineFacets();
```

## 5. 已知取舍与限制

- **关键词搜索是 LIKE 子串匹配，不是语义搜索**：不涉及 Embedding / 向量库（本阶段明确不做）。
- **LIKE 会全表扫描**：当前数据量下无感；记录规模上来后应考虑 FTS5 虚拟表。
- **关键词四列取并集**：`keywords_json` 是原始 JSON 文本，搜关键词时理论上也可能命中 JSON 结构片段，属预期行为。
- **未分析的记录搜不到**：PENDING / FAILED 记录的四个可搜字段都是 NULL，任何关键词都不会命中；按状态筛选它们仍然可见。语义正确，但用户可能觉得意外。
- **「无项目」只看 NULL 与空串**：不覆盖全空白字符串的项目。
- **自定义范围只到「天」**：没有小时级选择，与时间线的自然日分组保持一致。

## 6. 测试覆盖

`test/timelineFilter.test.js`（12 例）覆盖数据层与 IPC：

- 关键词命中四列、中文 / emoji / 大小写、`%` 与 `_` 通配符转义
- 时间范围与关键词组合、空搜索、非法参数
- Category / Project（含 NULL 与空串、`noProject` 与 `project` 互斥）
- AI 状态三档、多条件组合、无结果、筛选下的分页
- `listFacets()` 输出、两个 IPC 通道的注册契约

`test/timelineView.test.js` 覆盖渲染层纯函数：`parseDateInput`、`resolveTimeRange`（含跨月）、`buildTimelineQuery` / `hasActiveFilters`、`matchesFilters` 与数据层语义一致，以及全局作用域不被污染。
