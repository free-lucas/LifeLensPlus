# Timeline 数据层（Phase 7.1）

## 1. 目标与范围

让 SQLite 里已经积累的 Activity 数据能被**稳定、规范地查询**，供 Phase 7.2 的 Timeline UI 直接使用。

本阶段只做「查询 + IPC」这一层，不做 UI：Timeline Card、Dashboard、统计、RAG、Embedding、向量库、
语义搜索、Memory、AI Agent、Todo、Focus、Productivity Score 都不在范围内。

```text
SQLite: activities
  ↓  ActivityRepository.queryTimeline()
Main Process: src/main/timelineIpc.js
  ↓  IPC channel: lifelens:timeline
Preload: window.lifelens.getTimeline(query)
  ↓
Renderer
```

Renderer 不碰数据库、不拼 SQL，只通过 preload 暴露的方法拿数据。

## 2. 查询 API

`ActivityRepository.queryTimeline(options)`：同步方法（`node:sqlite` 是同步驱动），单表查询，不需要 Service 层。

### 参数

| 参数 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `from` | `Date` / 毫秒时间戳 / 时间字符串 | 无 | 起始时间，**含**：`captured_at >= from` |
| `to` | `Date` / 毫秒时间戳 / 时间字符串 | 无 | 结束时间，**不含**：`captured_at < to` |
| `limit` | number | `20` | 页大小，收敛到 `1..100` |
| `offset` | number | `0` | 跳过的记录数，负数按 `0` |

时间范围是闭开区间 `[from, to)`：查「2026-09-11 10 点这一小时」就是 `from=10:00`、`to=11:00`，
不会把 11:00 那条重复算进两个窗口。

### 参数归一化

- 时间输入统一转成与 `captured_at` 同格式的本地 ISO（`formatLocalIso`），
  因此 `Date`、毫秒时间戳、`2026-09-11T10:00:00+08:00`、甚至 UTC 形态的 `2026-09-11T02:00:00.000Z`
  都能落到同一个瞬间，字符串比较即时间比较。
- 解析不出来的时间（`'不是时间'` / `null` / `''`）只表示**这一侧不加边界**，不会让查询失败。
- `limit` / `offset` 非数字、`null`、`''` 一律退回默认值；`limit` 超范围收敛到 `1..100`。

### 返回

```js
{
  items: [ /* Activity Record */ ],
  total: 128,        // 满足时间范围的记录总数（不受 limit / offset 影响）
  limit: 20,
  offset: 40,
  hasMore: true      // offset + 本页取到的行数 < total
}
```

`items` 里的每条记录与 `listRecent()` 完全同构，Phase 7.2 不需要再写一套映射：

| 字段 | 说明 |
| --- | --- |
| `id` | `screenshot_id`（截图文件名去扩展名） |
| `time` | `captured_at`，带时区偏移的本地 ISO |
| `imagePath` | 截图绝对路径 |
| `analysisStatus` | `PENDING` / `PROCESSING` / `COMPLETED` / `FAILED`，未知值原样返回 |
| `analysis` | 结构化结果对象，没有结果时为 `null` |
| `analysis.activity` / `summary` / `category` / `project` / `confidence` | 结构化字段 |
| `analysis.keywords` | **始终是数组**（最多是空数组） |
| `summary` | 摘要（与 `analysis.summary` 同值，兼容旧渲染代码） |
| `model` / `analysisMs` | 分析用的模型与耗时 |
| `error` / `errorCode` | 失败原因（失败记录保留截图与记录，可重新分析） |

## 3. SQL

```sql
-- 分页查询
SELECT <activities 列> FROM activities
 WHERE captured_at >= ? AND captured_at < ?
 ORDER BY captured_at DESC, id DESC
 LIMIT ? OFFSET ?;

-- 同一个 WHERE 下的总数
SELECT COUNT(*) AS total FROM activities WHERE captured_at >= ? AND captured_at < ?;
```

- 排序**只看 `captured_at`（截图时间）**，与 AI 完成时间（`updated_at`）无关；
  同一 `captured_at` 内按 `id` 倒序，保证翻页顺序稳定。
- 走已有索引 `idx_activities_captured_at`，没有为本阶段新增表、列或索引。
- `WHERE` 组合只有四种（无 / 只有 from / 只有 to / 两者都有），
  prepared statement 按 SQL 片段缓存，做法与 `updateAnalysis()` 的语句缓存一致。

## 4. 状态与脏数据

- **状态**：`analysis_status` 原样返回，怎么展示由上层决定。当前 Recorder 写入的只有
  `PENDING` / `COMPLETED` / `FAILED`；将来新增的状态（例如 `PROCESSING`）也一样照原样返回，不会因为不认识而报错。
- **结构化结果**：`analysis` 是否存在只看结构化列有没有值，不看 `analysis_status` 字符串，
  因此「失败但保留了上一次成功结果」的记录依然能拿到 `analysis`。
- **keywords**：`keywords_json` 不是数组、不是合法 JSON、为 `NULL` 时统一退化成 `[]`，
  单条数据损坏不会让整条时间线读不出来。
- **单行异常**：行 → 业务对象的映射包了一层 `try/catch`，坏行被跳过并记 `STORAGE_ERROR` 事件，
  其余记录照常返回，查询整体不失败。

## 5. IPC

| 通道 | 参数 | 返回 |
| --- | --- | --- |
| `lifelens:timeline` | 与 `queryTimeline(options)` 同构的对象（可省略） | 查询结果对象 |

```js
// Renderer
const page = await window.lifelens.getTimeline({ from, to, limit, offset });
```

`src/main/timelineIpc.js` 单独成一个模块，是为了能在不启动 Electron 的情况下注入一个假的 `ipcMain`
直接测 IPC 契约；`main.js` 只负责在 `registerIpc()` 里调用一次。

## 6. 取舍与已知限制

- **不引入新抽象**：单表查询 + 已有 repository 足够，没有新增 ORM / Query Layer / Service。
- **用 offset 分页而不是游标**：与「时间范围 + 分页」的使用方式匹配，实现最小、接口最好理解。
  代价是翻页期间写入新截图会让后续页的 `offset` 位置发生位移（Phase 7.2 若做无限滚动，可再评估游标分页）。
- **依赖字符串时间排序**：`captured_at` 是带本地时区偏移的 ISO 字符串，字符串比较即时间比较，
  前提是「所有记录用同一个时区偏移」。这是 Phase 6 起就存在的存储约定，本阶段不改变存储格式；
  系统时区被改动后，历史记录与新记录的字符串比较会失真。
- **不做聚合**：跨日分组、统计、图表留给后续 Phase，本阶段只提供原始分页数据。

## 7. Phase 7.3 扩展：搜索与筛选条件

`queryTimeline(options)` 在本文第 2 节的参数之上新增 `search` / `category` / `project` / `noProject` / `status`，
WHERE 仍按 SQL 片段缓存 prepared statement；同时新增 `listFacets()`（分类 / 项目选项）与 IPC 通道 `lifelens:timeline-facets`。

筛选语义、生成的 SQL、LIKE 转义与界面交互见《[13-Timeline搜索与筛选](13-Timeline搜索与筛选.md)》。
