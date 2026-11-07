# 变更记录：Phase 7.1 — Timeline Data Layer

## 1. 这一阶段做了什么

给已积累在 SQLite 里的 Activity 数据加了一条稳定、规范的查询链路，供 Phase 7.2 的 Timeline UI 使用：

```text
Renderer -> Preload -> IPC(lifelens:timeline) -> Main -> ActivityRepository -> SQLite
```

能力：按时间范围查询（闭开区间）、按 `captured_at` 倒序、分页（`limit` / `offset`）、
返回 Timeline 所需的 Activity 信息（含结构化 `analysis` 与数组形态的 `keywords`）、
正确处理各种 `analysis_status`、单条脏数据不影响整次查询。

## 2. 修改文件

| 文件 | 变更 | 原因 |
| --- | --- | --- |
| `src/main/db/repositories/ActivityRepository.js` | 新增 `queryTimeline(options)`、`_toTimelineItem(row)`、`_timelineStatements(where)`，以及 `normalizeInstant` / `toInteger` / `normalizeTimelineQuery` 三个模块内辅助函数；构造函数新增 timeline 语句缓存 | 时间线查询是 activities 的单表读取，扩展已有 repository 即可，无需新层 |
| `src/main/timelineIpc.js` | **新增**：`TIMELINE_CHANNEL` / `registerTimelineIpc({ ipcMain, activities })` | IPC 契约单独成模块，可以不启动 Electron 就注入假 `ipcMain` 测试 |
| `src/main/main.js` | `registerIpc()` 里调用 `registerTimelineIpc({ ipcMain, activities })`；引入该模块 | 把通道接到主进程现有 IPC 注册流程里 |
| `src/preload.js` | 新增 `getTimeline: (query) => ipcRenderer.invoke('lifelens:timeline', query)` | Renderer 只能通过 preload 拿数据 |
| `test/timeline.test.js` | **新增**：13 个用例 | Timeline 数据层与 IPC 契约的自动化覆盖 |

没有改动截图、AI Worker、AI Provider、队列、migration 与表结构；`activities` / `ai_jobs` 的 schema 保持 version 1。

## 3. 新增测试

`test/timeline.test.js`（13 个用例）：

| 用例 | 覆盖 |
| --- | --- |
| Timeline 1 | 空库查询：空的 `items`、`total: 0`、默认 `limit: 20` / `offset: 0` |
| Timeline 2 | 按 `captured_at` 倒序；同一时间按 `id` 倒序 |
| Timeline 3 | 排序只看 `captured_at`，手动把 `updated_at` 推到很晚也不影响顺序 |
| Timeline 4 | 时间范围是闭开区间 `[from, to)`，单侧边界与越界边界 |
| Timeline 5 | 边界接受 `Date` / 毫秒时间戳 / 本地 ISO / UTC ISO；非法值只忽略该侧边界 |
| Timeline 6 | 分页 `limit` / `offset`、`hasMore`、越界 offset、分页与时间范围叠加、逐页取完不重不漏 |
| Timeline 7 | `limit` / `offset` 归一化：默认 20、上限 100、下限 1、非法值回退 |
| Timeline 8 | `PENDING` / `PROCESSING` / `COMPLETED` / `FAILED` / 未知状态都能返回 |
| Timeline 9 | 结构化结果（activity / summary / category / project / confidence / model / analysisMs）与 `keywords` 数组 |
| Timeline 10 | `keywords_json` 写坏（非数组 / 非 JSON）退化成 `[]`，其余记录不受影响 |
| Timeline 11 | 中文 / English / emoji / 特殊字符原样返回 |
| Timeline 12 | IPC：注册的通道是 `lifelens:timeline`，handler 返回时间线数据 |
| Timeline 13 | IPC：参数缺失 / `null` / `''` / 非法值按默认查询处理 |

## 4. 测试结果

```text
# tests 92
# pass 92
# fail 0
```

- Phase 6 的 79 个用例全部继续通过（79/79）。
- 新增 13 个用例，总数 92/92。
- 运行方式：`npm test`（等价于 `node --test test/*.test.js`），全部在临时目录建库，不需要 Ollama / GPU。

## 5. 真实 Electron 验证

验证链路：真实 `main.js` + 真实 `preload.js` + 真实窗口，通过 CDP 在 Renderer 里调用
`window.lifelens.getTimeline(...)`，最终落到 SQLite（`LIFELENS_DIR` 指向隔离临时目录，
`LIFELENS_AUTOSTART=0` 不启动截图循环，不依赖 Ollama）。

种子数据：同一小时窗口内有 1 条、窗口外 2 条；其中 1 条 `COMPLETED`（中文 + emoji keywords）、
1 条 `FAILED`、1 条 `PENDING`。

```text
REAL_APP_RESULT
{
  "sandboxed": true,
  "page1": { "ids": ["2026-09-11_11-00-00-000", "2026-09-11_10-00-00-000"], "total": 3, "limit": 2, "offset": 0, "hasMore": true },
  "page2": { "ids": ["2026-09-11_09-00-00-000"], "hasMore": false },
  "ranged": { "ids": ["2026-09-11_10-00-00-000"], "total": 1 },
  "noArgs": { "total": 3, "limit": 20 },
  "completed": {
    "id": "2026-09-11_10-00-00-000",
    "analysisStatus": "COMPLETED",
    "analysis": {
      "activity": "写代码",
      "summary": "在 VS Code 里实现 Timeline 数据层；emoji 也没问题。",
      "category": "coding",
      "project": "LifeLensPlus",
      "keywords": ["Electron", "SQLite", "数据层"],
      "confidence": 0.9
    },
    "model": "qwen3-vl:8b",
    "analysisMs": 4210
  }
}
```

结论：

- Renderer -> Preload -> IPC -> Main -> SQLite 全链路通畅，返回的数据与直接查库一致。
- 渲染进程仍然是沙箱（`typeof require === "undefined" && typeof process === "undefined"` 为 `true`）。
- 分页（`hasMore`）、时间范围、缺省参数都按设计工作；中文与 emoji 跨 IPC 边界没有损坏。
- 启动日志里正常的 `WORKER_STARTED` / `RECOVERY_SCAN` / `JOB_ENQUEUED` 说明其余功能未受影响。

## 6. 留给后续 Phase 的问题

- **游标分页**：现在是 `offset` 分页，翻页期间有新截图写入会让后续页的 `offset` 位置位移。
  若 Phase 7.2 做无限滚动，可以考虑基于 `(captured_at, id)` 的游标分页。
- **时区前提**：`captured_at` 是带本地时区偏移的字符串，排序依赖「所有记录使用同一偏移」。
  系统时区被改动的场景可能让历史记录与新记录的字符串比较失真，需要时再评估统一存 UTC 的 migration。
- **未做聚合**：跨日分组、按分类 / 项目统计、活跃时长等留给后续 Phase，当前只提供原始分页数据。
- **UI 未接**：`window.lifelens.getTimeline()` 已经可用，但界面仍是 Phase 6 的记录列表，
  Timeline UI 属于 Phase 7.2。