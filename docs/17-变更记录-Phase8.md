# 变更记录：Phase 8 — 10 分钟区块汇总与「动态」标签页

## 1. 这一阶段做了什么

**A. 每 10 分钟汇总（新数据层 + 新 AI Job 类型）**

- 新增 `time_blocks` 表（schema v2）：一段已结束的 10 分钟区块一行，`block_start` 是业务主键；
- 汇总的结构化输出：项目名称（沿用上一时段则同名）、四个中文分类之一、约 1000 字描述、
  用到的软件列表、可能遗漏的待办（可空）；
- 新增 Job 类型 `TIMEBLOCK_SUMMARY`，走**独立的文本 Provider**（`LIFELENS_SUMMARY_MODEL`，默认复用视觉模型）；
- 应用启动时补扫「有记录、没汇总」的历史区块并排队（每次最多 144 个），之后每 10 分钟边界扫一次；
- 区块行与 AI Job 在**同一个事务**里落库，所以「行存在 = 处理过」，扫描天然幂等，崩溃后也能正确恢复。

**B. 「动态」标签页（新 UI）**

- 顶部标签页：`记录`（原有内容整体搬进 `#view-overview`）/ `动态`；
- GitHub 风格热力图：最近 12 小时、6 行 × 12 列 = **72 个点**，每点 10 分钟，按活动分类着色，
  点选查看当时的活动详情；
- 纵向滑动加载的动态时间线：项目名 + 描述 + 软件 tag + 待办，每 20 条一页；
- 按项目 / 软件 / 时间范围（全部 / 今天 / 昨天 / 最近 7 天 / 自定义）筛选，条件组合生效；
- 头部的「汇总中」标记：有排队或正在扫描时显示 `汇总中 N`。

没有改动 Recorder 的截图链路，没有改 `activities` / `ai_jobs` 的任何列，
也没有改 Phase 7 已定的 Timeline 查询与筛选语义。

## 2. 修改文件

### 新增

| 文件 | 内容 |
| --- | --- |
| `src/main/db/repositories/TimeBlockRepository.js` | `time_blocks` 的全部读写；SQL 对齐表达式、缺口扫描、分页查询、facets |
| `src/main/summary/timeBlock.js` | 10 分钟区块的时间口径（对齐、区间、业务键） |
| `src/main/summary/TimeBlockSummarizer.js` | 扫描 → 入队 → 回填 → 快照的编排 |
| `src/main/ai/summaryOutput.js` | 汇总的 JSON Schema、提示词、第二层校验 |
| `src/main/ai/summaryProvider.js` | `OllamaSummaryProvider`（文本汇总） |
| `src/main/summaryIpc.js` | 通道 `lifelens:time-blocks` / `-facets` / `lifelens:summary-status` |
| `src/renderer/dynamics.js` | 动态页渲染层（纯函数 + 视图装配） |
| `test/timeBlock.test.js` | 16 例：时间口径、Schema、校验、提示词、Provider（打桩 fetch） |
| `test/timeBlockRepository.test.js` | 12 例：事务写入、幂等、回滚、缺口扫描、回填、查询筛选、facets |
| `test/timeBlockSummarizer.test.js` | 10 例：扫描、并发保护、调度延迟、回填、端到端、快照、IPC 契约、崩溃恢复 |
| `test/dynamicsView.test.js` | 14 例：热力图槽位与配色、卡片渲染、转义、查询构造、全局作用域、DOM 装配 |

### 修改

| 文件 | 变更 |
| --- | --- |
| `src/main/db/schema.js` | `SCHEMA_VERSION` 1 → 2；新增 `TIME_BLOCKS_TABLE`、`idx_time_blocks_status` 与 version 2 migration |
| `src/main/db/repositories/ActivityRepository.js` | 新增 `listSummaryContext()`（汇总素材的紧凑读模型）+ 一条 prepared statement |
| `src/main/ai/job.js` | 新增并导出 `jobPayloadKey(payload)`（截图按 `screenshotId`、区块按 `blockStart`） |
| `src/main/ai/AIJobQueueService.js` | 构造新增 `timeBlocks`；新增 `enqueueWithBlock()`；`_dedupe` / `_findByScreenshot` 改用通用幂等键 |
| `src/main/ai/AIWorker.js` | 构造新增 `providers`（按 Job 类型覆盖）；超时按 Provider 走；健康检查并发探测多个 Provider |
| `src/main/ai/jobEventLog.js` | 新增事件 `SUMMARY_SCAN` |
| `src/main/analyzer.js` | 抽出并导出 `chatWithOllama()`，视觉分析改为复用它（超时文案改为「AI 请求超时（…）」）；新增 `numCtx`，只在正值时写进 `options.num_ctx` |
| `src/main/ai/visionProvider.js` | 构造与 `analyze()` 透传 `numCtx`（与汇总共用同一个模型实例，`num_ctx` 必须一致） |
| `src/main/config.js` | 新增 `summaryModel` / `summaryTimeoutMs`（300000）/ `summaryScanLimit`（144）/ `numCtx`（16384） |
| `src/main/main.js` | 装配 `TimeBlockRepository` / `OllamaSummaryProvider` / `TimeBlockSummarizer`；按 Job 类型分流回填；退出时 `summarizer.stop()` |
| `src/preload.js` | 新增 `getTimeBlocks` / `getTimeBlockFacets` / `getSummaryStatus` |
| `src/renderer/index.html` | 标签页、`#view-overview` / `#view-dynamics`、热力图、筛选栏、时间线、哨兵 |
| `src/renderer/styles.css` | `.tabs` / `.header-pills` / `.heatmap*` / `.heat-cell` / `.cat-*` / `.dynamics-*` |
| `src/renderer/renderer.js` | 标签页切换；`renderSummary()` 与「汇总中」标记；`{ type: 'summary' }` 事件处理 |
| `test/database.test.js` | 断言 `time_blocks` 表与 `idx_time_blocks_status`；`user_version` 断言改用 `SCHEMA_VERSION` |
| `test/support.js` | `makeQueue()` 返回 `timeBlocks` |

## 3. 关键设计决定

| 决定 | 理由 |
| --- | --- |
| 区块行与 Job 同一事务写入 | 不需要「已处理 / 未处理」状态列，区块行的存在性就是判据，扫描天然幂等 |
| 区块键用本地 ISO 字符串 | 与 `captured_at` 同格式，SQL 里字符串比较即时间比较，对齐可以直接在 SQL 里做 |
| 汇总走独立 Provider 与独立超时 | 生成 1000 字比单张截图分析慢得多；模型缺失时也不该把截图分析一起判失败 |
| 汇总优先级 `LOW` | 同一时段的截图先分析完，汇总才更有内容 |
| 上下文在执行时才读 | 区块刚结束时最后几张截图可能还在分析队列里 |
| 分类用四个中文枚举，不与截图分类共用 | 两套分类回答不同层次的问题，强行映射会压扁信息 |
| 描述 < 200 字判失败、> 4000 字只截断 | 太短说明模型没按要求写（重试有意义），太长则重试也未必更短 |
| 软件筛选用 `json_each` 精确匹配 | `LIKE` 会把「Code」误判成命中「Visual Studio Code」 |
| 热力图固定最近 12 小时 | 需求是「最近的几十个点」，72 个点一屏放得下，不需要缩放窗口 |

## 4. 新增测试

```text
test/timeBlock.test.js               16 例（新增文件）
test/timeBlockRepository.test.js     12 例（新增文件）
test/timeBlockSummarizer.test.js     10 例（新增文件）
test/dynamicsView.test.js            14 例（新增文件）
test/database.test.js                 1 例断言同步（time_blocks 表 + 索引）
test/support.js                       makeQueue 增加 timeBlocks（不新增用例）
```

## 5. 测试结果

```text
Before（Phase 7.3 结束）: # tests 119  # pass 119  # fail 0
After （Phase 8）       : # tests 171  # pass 171  # fail 0
```

`npm test` = `node --test test/*.test.js`，全部 mock，不需要 Ollama / GPU。

## 6. Electron 真实验证

环境：Windows + Electron 44.3.0，隔离数据目录 `%TEMP%\lifelens-p8-smoke\data`
（`LIFELENS_DIR` + `LIFELENS_AUTOSTART=0` + 独立 `--user-data-dir` + 调试端口），
用一个假 Ollama（`/api/tags` + `/api/chat`，每次延迟 2.5s，四个区块依次返回娱乐 / 工作 / 学习 / 社交）
替代真实模型，通过 CDP 操作界面并读回 DOM。

种子数据：4 个已结束的 10 分钟区块 × 2 条已分析记录，全部没有 `time_blocks` 行。

启动日志（节选）：

```text
[DB] Schema version: 2
[AI-JOB] WORKER_STARTED job=- type=- status=- 并发 1
[AI-JOB] JOB_ENQUEUED job=TIMEBLOCK_SUMMARY_mu2pp1q8_325db4cc type=TIMEBLOCK_SUMMARY status=PENDING
[AI-JOB] JOB_ENQUEUED job=TIMEBLOCK_SUMMARY_mu2pp1qd_49a2a6bf type=TIMEBLOCK_SUMMARY status=PENDING
[AI-JOB] JOB_ENQUEUED job=TIMEBLOCK_SUMMARY_mu2pp1qe_e74057be type=TIMEBLOCK_SUMMARY status=PENDING
[AI-JOB] SUMMARY_SCAN job=- type=- status=- 扫描到 3 个待汇总区块，新建 3 个任务，跳过 0 个
[AI-JOB] JOB_COMPLETED job=... type=TIMEBLOCK_SUMMARY status=COMPLETED category=工作 project=写《2026 年中报告》 software=3 todos=1
```

界面侧（CDP 读回的 DOM 结果）：

| 检查项 | 结果 |
| --- | --- |
| 标签页 | `["记录", "动态"]`，切换后 `#view-dynamics.hidden=false` / `#view-overview.hidden=true` |
| 「汇总中」标记 | 依次出现过 `汇总中 4` → `汇总中 3` → `汇总中 2` → `汇总中 1`，全部完成后 `hidden=true` |
| 热力图 | 72 个 `.heat-cell`、6 个行标、12 个小时标；`cat-fun`/`cat-work`/`cat-study`/`cat-social` 各 1 个；2 个未来槽位 `disabled` |
| 时间线 | 4 张卡片；项目名 4 个互不相同；软件 tag 去重后 6 个；2 张卡片带待办 |
| 点选详情 | 点「学习」方块后 `#heatmap-detail` 展开，文案 `2026-09-15 21:10–21:20 学习 读《数据库系统概念》…`，选中态只有 1 个 |
| 按项目筛选 | 选「玩《荒野大镖客》」→ 1 张卡片，项目名一致 |
| 按软件筛选 | 选 `Slack` → 1 张卡片，tag 为 `[Slack, Chrome]` |
| 时间范围筛选 | 选「昨天」→ 0 张卡片 + 空态「没有符合条件的动态」 |
| 自定义范围 | 选「自定义时间」后日期输入显示，清除筛选后隐藏 |
| 清除筛选 | 回到 4 张卡片，三个控件都复位 |
| 数据库侧 | 4 条区块全部 `COMPLETED`，`activity_count` 都是 2，`description` 长度 231，`software` / `todos` 按区块各自不同 |

另外单独验证了 schema 升级：造一个 `user_version = 1` 的 Phase 7 库（含 1 条活动记录），
用当前代码打开后 `user_version` 变成 2、`time_blocks` 表建好、原有活动记录不变，
缺口扫描正确地把那条旧记录所在的区块（`2026-01-01T09:00:00+08:00`）识别为待汇总。

```text
v1 db ready:   {"version":1,"activities":1}
after upgrade: {"version":2,"activities":1,"hasTimeBlocks":1,"timeBlocks":0}
missing blocks: [{"blockStart":"2026-01-01T09:00:00+08:00","activityCount":1}]
```

## 7. 本阶段发现并修复的问题

- **汇总全部失败「AI 返回了空结果」**（收尾后真实环境报出来的）：`qwen3-vl` 是混合思考模型，
  开着思考时 `num_predict: 2048` 会被思考全部吃光，`message.content` 始终为空，
  `parseStructuredResult('')` 直接判 `INVALID_RESULT`。
  修复分两步：汇总请求传 `think: false`；`chatWithOllama()` 在 `content` 为空时退到
  `message.thinking`（关掉思考后 Ollama 0.34 把约束输出放在 thinking 里）。
  实测数据与对照见《[15-时间区块汇总](15-时间区块汇总.md)》第 5 节。
- **内部函数遮蔽模块级纯函数导致无限递归**：`createDynamicsView` 里的内部画图函数叫
  `renderHeatmap()`，调用 `renderHeatmap(slots, blocks, selectedMs)` 时解析到自己，
  首屏渲染动态页直接 `RangeError: Maximum call stack size exceeded`，整块白掉。
  纯函数单测全绿，因为没有任何用例真的跑过装配。修复为 `paintHeatmap()`，并补了
  两个跑真实 `createDynamicsView().reload()` 的 DOM 桩用例（动态 13 / 14）。
- **`schema.js` 被写入 BOM**：`SCHEMA_VERSION` 的改动带进了 `\uFEFF`，已在收尾时去掉。
- **`.view { display: block; }` 让 `hidden` 失效**：标签页切换只改了属性，两个页面一直同时显示
  （作者样式表的 `display` 压过 UA 样式表的 `[hidden] { display: none }`）。
  只看 `element.hidden` 发现不了，要用 `getComputedStyle(el).display` 判断。
  修复：删掉这条多余的规则。与 Phase 7.3 的 `.timeline-custom-range` 是同一类坑。
- **`analyzer.js` 的超时文案**：抽出 `chatWithOllama()` 时从「分析超时」改成「AI 请求超时」，
  因为现在视觉分析与文本汇总共用这一层。
- **上下文装不下时被静默截断**（收尾后补测出来的）：不传 `num_ctx` 时 Ollama 用默认窗口 4096，
  提示词一旦装不进，Ollama **只保留末尾约 2050 token**，前面半段记录整段消失且不报错、不重试。
  修复：新增 `LIFELENS_NUM_CTX`（默认 16384），截图分析与汇总共用同一个值。
  实测数据见《[15-时间区块汇总](15-时间区块汇总.md)》第 5.1 节。

## 8. Scope Check

```text
焦点 / 键鼠统计 / 进程占用统计 / 日汇总 / 周汇总 / 月汇报 / 区块导出 / 区块重新汇总 /
手动触发汇总 / 热力图缩放与平移 / 日视图 / 周视图 / 向量检索 / 云端同步 : NOT IMPLEMENTED
```

## 9. 留给后续 Phase 的问题

见《[15-时间区块汇总](15-时间区块汇总.md)》第 11 节与《[16-动态页界面](16-动态页界面.md)》第 9 节。
主要几条：

- 时段内多数截图还没分析完时，汇总质量会下降（没有「等这一时段分析完再汇总」的等待条件）；
- `FAILED` 区块不会自动重试，也没有手动重新汇总的入口；
- 软件名是自由文本，同一软件的不同写法会在筛选下拉里各占一行；
- 分页仍是 `offset` 语义，长时间录制下的窗口化策略待后续处理；
- `summaryModel` 默认与视觉模型共用，未做「文本模型做汇总」的默认拆分。
