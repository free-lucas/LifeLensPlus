# 变更记录：Phase 11 — 记忆搜索

## 1. 这一阶段做了什么

**A. 新增 `MemorySearchService`（Main 层唯一的新组件）**

- 查询文本 → `provider.embedText` → 三张向量表各 `search()` 一次 → 按 `_distance` 合并排序
  → 截取前 `limit` 条 → 回 SQLite 取完整记录；
- 来源类型由「查的是哪张表」决定（向量表没有 `source_type` 列），`source_id` 优先取行内列、
  缺失时按行 ID 前缀（`activity:` / `block:` / `diary:`）解析；
- 回查全部走现有 Repository：`activities.getById` / `timeBlocks.getByStart` / `diaries.getByDay`，
  这一层不 require LanceDB 原生模块、不写一条 SQL；
- 错误语义：`INDEX_UNAVAILABLE`（未装配）、`EMBEDDING_UNAVAILABLE`、`VECTOR_UNAVAILABLE`（三层全挂）、
  `INVALID_RESULT`（向量非法）；单层失败降级继续，单条缺失记 `missing`、坏行记 `invalid`。

**B. IPC 通道**

- `src/main/searchIpc.js` 暴露 `lifelens:memory-search`，`getSearch()` 为 `null` 时抛可读错误
  （「记忆搜索不可用：本地向量索引没有启动」），而不是让渲染层拿到 `undefined`；
- `preload.js` 增加 `searchMemories(query, limit)`。

**C. 渲染层搜索页**

- 新增 `src/renderer/search.js`（IIFE，纯函数部分可被 `node --test` 直接 require）：
  搜索框 / Enter / 按钮、Loading（「正在搜索记忆…」）、结果卡片、空结果与错误态、
  最近搜索、跳转指令；
- `index.html` 新增「搜索」标签页与 `view-search` 面板（badge 9）；
- `renderer.js` 的 `TAB_VIEWS` 加入 `search`，并把 `selectTab` 以 `window.lifelensTabs` 暴露出去，
  供搜索页切页复用。

**D. 时间线定位模式（结果跳转的落地部分）**

- `timeline.js` 新增 `focus(range, id)` / `clearFocus()` / `isFocused()`：
  用给定窗口查询（而不是当前筛选条件）、顶部画「已定位到搜索结果的记录」横幅、
  命中卡片加 `.timeline-card-focus` 高亮；
- 定位模式下 `prependRecord` 直接返回（新记录不插进这个历史窗口的切片），
  点「查看完整时间线」或改动筛选即退出定位；
- 定位窗口：`block` 用 `[start, end)`，`activity` 用 `[captured_at, captured_at + 1s)`，闭开区间与 Timeline 一致。

**E. 没动的东西**

- 截图链路、AI 队列、区块汇总、日记生成、看板统计一行没改；
- 三张向量表的写入路径（Phase 10 的 `EmbeddingService`）没改，只共用同一批 `MemoryVectorRepository` 实例；
- Timeline / Diary / Dynamic / Dashboard 的原有查询与渲染口径没改（只新增定位模式）。

## 2. 修改文件

### 新增

| 文件 | 内容 |
| --- | --- |
| `src/main/search/MemorySearchService.js` | 三表聚合、`_distance` 合并排序、来源类型解析、回查 SQLite、异常语义 |
| `src/main/searchIpc.js` | `lifelens:memory-search` 通道与未装配时的可读错误 |
| `src/renderer/search.js` | 搜索页：输入 / Loading / 结果卡片 / 空与错误态 / 最近搜索 / 跳转指令 |
| `test/memorySearch.test.js` | 11 例：真实 LanceDB + 真实 SQLite，覆盖需求列的 10 条 + 单条异常隔离 |
| `test/searchView.test.js` | 12 例：最近搜索、结果整形、定位窗口、跳转指令、渲染与转义、作用域隔离、DOM 装配 |
| `test/timelineFocus.test.js` | 3 例：定位窗口与横幅高亮、退出定位、非法窗口与定位模式不插新记录 |
| `test/smoke/memorySearchSmoke.cjs` | 21 项断言的真实 Electron 冒烟（假 Ollama + 真实 LanceDB + CDP），不被 `npm test` 收集 |
| `docs/24-记忆搜索.md` | 本阶段的功能与设计文档 |

### 修改

| 文件 | 变更 |
| --- | --- |
| `src/main/main.js` | `createEmbedding()` → `createMemoryIndex()`，返回 `{ embedding, search }`；两者共用同一个 Provider 与同一批 vectors；装配失败时一起降级为 `null`；新增 `registerSearchIpc` |
| `src/main/db/repositories/ActivityRepository.js` | 新增 `selectByIdStatement` 与 `getById(id)`（向量行的 `source_id` 就是 `activities.id`） |
| `src/main/ai/jobEventLog.js` | 新增事件 `MEMORY_SEARCH` / `MEMORY_SEARCH_ERROR`（只记元信息，不记查询文本） |
| `src/preload.js` | 新增 `searchMemories(query, limit)` |
| `src/renderer/index.html` | 新增「搜索」标签页与 `view-search` 面板（badge 9）、`<script src="search.js">` |
| `src/renderer/renderer.js` | `TAB_VIEWS` 加入 `search`；导出 `window.lifelensTabs = { select: selectTab }` |
| `src/renderer/timeline.js` | 定位模式（`focus` / `clearFocus` / `isFocused`）、定位横幅、高亮卡片；`renderCard` / `renderGroup` 增加 `focusId` 参数 |
| `src/renderer/styles.css` | 搜索页样式与 `.timeline-focus` / `.timeline-card-focus`（无内联样式，符合 CSP） |

## 3. 关键设计决策

1. **跨三表的聚合只加一层编排，不加表、不新写一套向量查询**。三张表各查一次，
   排序在内存里做；检索一律走 `MemoryVectorRepository.search()`，这一层不认识 LanceDB。
2. **检索与写入共用同一个 Provider 实例**。`createMemoryIndex()` 里建一次、两处引用，
   查询向量的维度校验与「写读同模型」的口径天然一致，不会出现「写入用 A 模型、查询用 B 模型」。
3. **可用性优先的降级**：单层检索失败 → 少一层候选（记日志继续）；单条回查失败或缺失 →
   少一条结果（记 `missing` / `invalid`）。只有「一层都没装配」与「三层全挂」才是整页失败。
4. **日志不记查询文本**。搜索日志只记命中数、各层候选数、耗时、缺失 / 跳过条数——
   与「日志不含截图内容 / Prompt」的既有口径一致。
5. **跳转复用现有视图，不新建详情页**。搜索页只算出「去哪个标签页、定位到哪里」，
   真正的切页与定位交给 `window.lifelensTabs` / `lifelensTimeline` / `lifelensDiary`。
6. **定位模式不插入新记录**。列表是「搜索命中的那一段」的切片，插入新记录会让
   「看到的就是搜索结果」这个前提失效，所以 `prependRecord` 在定位模式下直接返回。
7. **最近搜索放 localStorage**。界面状态不进 SQLite，去重、上限 8 条；
   读写都容错，坏数据不影响搜索本身。

## 4. 数据流

```text
Renderer(search.js) -> preload -> searchIpc(lifelens:memory-search)
  -> MemorySearchService.search(query, { limit })
       -> provider.embedText(query)                      查询向量（与写入同一个 Provider）
       -> vectors.{activity,block,diary}.search(vec, { limit })   三表各查一次
       -> 按 _distance 升序合并 + 截取前 limit 条
       -> activities.getById / timeBlocks.getByStart / diaries.getByDay    回查完整记录
  -> items[] -> 搜索结果卡片
  -> 点卡片：activity/block -> lifelensTabs.select('overview') + lifelensTimeline.focus(range, id)
             diary          -> lifelensTabs.select('diary')    + lifelensDiary.selectDay(day)
```

## 5. 验证

```text
npm test                                        267 / 267（新增 26 例）
node --test test/memorySearch.test.js            11 / 11
node --test test/searchView.test.js              12 / 12
node --test test/timelineFocus.test.js            3 / 3
node test/smoke/memorySearchSmoke.cjs            21 / 21
```

真实 Electron 冒烟（假 Ollama + 真实 LanceDB，`node test/smoke/memorySearchSmoke.cjs`，21 项断言）：

```text
PASS  启动后三层记忆自动嵌入（SQLite 状态 COMPLETED）  20秒记录 3/3，10分钟汇总 1/1，日记 1/1
PASS  IPC 搜索返回三张表聚合后的结果                  命中 5 条：{"activity":3,"block":1,"diary":1}
PASS  结果按相关度排序（_distance 升序）              activity:0.000 block:0.000 diary:2.000 activity:3.000 activity:3.000
PASS  回查 SQLite 拿到了完整字段（项目 / 分类 / 关键词 / Timeline id）
PASS  「搜索」标签页可以打开
PASS  点搜索时先显示「正在搜索记忆…」
PASS  结果卡片画到了页面上                            5 张卡片，首条来源：20秒记录
PASS  状态栏给出命中统计                              找到 5 条相关记忆 · 各层候选：20秒记录 3 · 10分钟汇总 1 · 日记 1
PASS  最近搜索记下了这次关键词
PASS  点结果切到了「记录」标签页，时间线进入定位模式并画出横幅
PASS  定位到的是搜索结果里的那条记录                  highlighted=smoke-agent
PASS  点日记结果切到了「日记」标签页                   selected=2026-09-18
PASS  空查询给出提示而不是白屏                        先输入一句话，再开始搜索。
PASS  主进程记下了 MEMORY_SEARCH 事件与命中条数
PASS  日志里没有出现查询文本
```

主进程日志（真实输出）：

```text
[AI-JOB] 2026-09-19T16:49:25+08:00 MEMORY_SEARCH job=- type=- status=- 记忆搜索命中 5 条（20秒记录 3 / 10分钟汇总 1 / 日记 1，29ms，缺失 0，跳过 0）
[AI-JOB] 2026-09-19T16:49:24+08:00 EMBEDDING_ONLINE job=- type=- status=- Embedding 模型可用：fake-embed:latest
```

## 6. 踩到的问题与修法

- **`ipcMain.handle` 的 handler 必须是 `async`**。写成同步函数时 `throw` 是同步抛出的，
  单测里直接调用 handler 时 `assert.rejects` 抓不到（拿到的是同步异常而不是 rejected promise）。
  统一写成 `async` 后，单测与 Electron 的行为一致。
- **不能用「全表状态」当就绪条件**。冒烟里应用启动后还会汇总「当前这个 10 分钟」区块，
  而假 Ollama 不提供 `/api/chat`，那条汇总永远停在 `PENDING`；一开始等「三张表全部 COMPLETED」
  会一直等到超时。改成只盯预置的那几条记录（`readSeedStatus`）。
  教训与 Phase 8 / 10 同类：**假外部依赖会掩盖真实条件**，就绪判断必须锚定自己造的数据。
- **`embedText` 与 `embedTexts` 不是一回事**。写入走批量 `embedTexts`（返回二维数组），
  查询走单条 `embedText`；用错会把 `[vector]` 套成 `[[vector]]`，检索直接报维度不匹配。
- **数据库里已删除的记录，向量还在**。这是 Phase 10 遗留的同步缺口（本阶段不补），
  所以回查必须把「找不到」当成正常分支计数（`missing`），而不是异常。

## 7. Scope Check

```text
AI 问答 / Chat UI / Agentic Search / 多轮搜索 / RAG / Query Rewrite / Reranker /
Hybrid Search / 查询向量缓存 / 结果分页 / 删除记录时同步删向量 /
Embedding 模型更换 / 新的 Vector Database / Timeline 搜索功能重构 /
Dashboard 与 Diary 与 Dynamic 功能重构                    : NOT IMPLEMENTED
```

## 8. 留给后续 Phase 的问题

- **失效同步**：记录删除或文本变化时不删向量，搜索只把它算作 `missing`；
  需要一条「按 `source_id` 清理」的路径（Phase 10 就列出的欠账）；
- **查询向量缓存**：同一个关键词重复搜索会重复嵌入，可以做一层短 TTL 的 LRU；
- **结果分页 / 加载更多**：目前一次只给 `limit` 条；
- **候选名额分配**：每层各查 `limit` 条再合并，密集层会占掉大部分名额，
  可以考虑按层配额或对 `_distance` 做归一化后合并；
- **Hybrid / Reranker**：向量一层之外叠加关键词（FTS）或加一个 Reranker，
  是这一页最自然的下一步；
- **搜索日志接界面**：`MEMORY_SEARCH` 已经记了命中数、各层候选数与耗时，
  可以像「看板」那样把可观测性接到页面上（Phase 10 也提过 `snapshot()` 未上界面）。
