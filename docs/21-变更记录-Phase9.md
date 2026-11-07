# 变更记录：Phase 9 — 日记与看板

## 1. 这一阶段做了什么

**A. 一天的日记（新数据层 + 新 AI Job 类型）**

- 新增 `diaries` 表（schema v3）：一天一行，`day` 是业务主键（本地日期 `YYYY-MM-DD`）；
- 日记是对这一天所有 10 分钟区块的**二阶汇总**，输出六段：简短总结 / 主要事项（最多三件）/
  高光 / 待办 / 优化建议 / 温馨提示；
- 新增 Job 类型 `DIARY_GENERATION`，走**独立的文本 Provider**（`LIFELENS_DIARY_MODEL`，默认沿用汇总模型）；
- 应用启动时补扫「有区块、没日记」的历史日期并排队（每次最多 30 天），之后每个本地午夜再扫一次，
  区块汇总状态变化时合并 2s 内再通知一次；
- 日记行与 AI Job 在**同一个事务**里落库，扫描天然幂等；
  区块回填还没补完时（这一天不早于最早缺口）先不动，避免生成半篇日记；
- **今天从不生成日记**（这一天还没过完）。

**B. 「日记」标签页（新 UI）**

- 月历（周一起始）+ 每天的状态点：生成中 / 失败 / 已完成（按主要分类着色）/ 有区块无日记 / 无记录；
- **默认打开前一天的日记**；
- 详情按数据状态分级：没有记录 / 还没汇总成区块 / 还有区块在汇总 / 日记还没生成 / 正在生成 / 生成失败 / 正常；
- 「重新生成」按钮：强制重建任务，正文不会先被清空；
- 顶部「正在生成 N 天的日记 · 正在检查有没有漏掉的日记 · N 天生成失败」。

**C. 「看板」标签页（新 UI + 新统计层）**

- 周期：日 / 周 / 月 / 年，支持上一期 / 下一期 / 回到今天 / 跳到某一天；
- 图表：时间分配环形图、活动趋势（分类堆叠柱 + 截图记录折线）、时段分布、
  项目专注时长排行、软件使用次数排行、关键词、待办线索、五个统计卡片；
- 新增只读统计层 `StatsRepository` + 纯函数 `stats/summarize.js`，一个周期只走一次 IPC。

**D. 没动的东西**

- 截图链路（Recorder / capture / store）一行没改；
- `activities` / `ai_jobs` / `time_blocks` 的列一个没改；
- Phase 7 的 Timeline 查询与筛选语义、Phase 8 的区块汇总口径都没变。

## 2. 修改文件

### 新增

| 文件 | 内容 |
| --- | --- |
| `src/main/day.js` | 本地日口径：日键、区间、加减天、严格校验、日期标签 |
| `src/main/db/repositories/DiaryRepository.js` | `diaries` 的全部读写：行 + Job 同事务、缺口扫描、日历标记、回填 |
| `src/main/diary/DiaryGenerator.js` | 扫描 → 入队 → 回填 → 快照的编排，启动 / 午夜 / 区块变化三个触发点 |
| `src/main/ai/diaryOutput.js` | 日记的 JSON Schema、提示词、时段合并、上下文压缩、第二层校验 |
| `src/main/ai/diaryProvider.js` | `OllamaDiaryProvider`（文本日记） |
| `src/main/diaryIpc.js` | 通道 `lifelens:diary` / `-days` / `-status` / `-regenerate` |
| `src/main/stats/period.js` | 日 / 周 / 月 / 年的边界、标题、前后锚点、趋势分桶 |
| `src/main/stats/summarize.js` | 统计的二次汇总（纯函数，不碰数据库与 DOM） |
| `src/main/db/repositories/StatsRepository.js` | 看板的 12 条聚合查询 |
| `src/main/statsIpc.js` | 通道 `lifelens:stats` |
| `src/renderer/diary.js` | 日记页渲染层（纯函数 + 视图装配） |
| `src/renderer/kanban.js` | 看板页渲染层（手写 SVG，无内联样式） |
| `test/diary.test.js` | 15 例：日期口径、Schema、校验、提示词、Provider、生成器、IPC 契约 |
| `test/diaryView.test.js` | 11 例：日历网格与状态、详情六段与空态、转义、换月、全局作用域、DOM 装配 |
| `test/statsRepository.test.js` | 9 例：周期边界、空骨架、时长口径、排行、关键词与待办、分桶、IPC 契约 |
| `test/kanbanView.test.js` | 13 例：环形图、趋势几何、排行、面板数量、CSP 约束、全局作用域、DOM 装配 |
| `docs/18-日记生成.md`、`docs/19-日记界面.md`、`docs/20-看板与统计.md` | 本阶段的三份功能文档 |

### 修改

| 文件 | 变更 |
| --- | --- |
| `src/main/db/schema.js` | `SCHEMA_VERSION` 2 → 3；新增 `DIARIES_TABLE`、`idx_diaries_status` 与 version 3 migration |
| `src/main/db/repositories/TimeBlockRepository.js` | 新增 `daySummary(from, to)`（日记页的「这一天概况」） |
| `src/main/db/repositories/ActivityRepository.js` | 新增 `countBetween(from, to)`（一天有多少张截图） |
| `src/main/ai/job.js` | `jobPayloadKey` 加上 `?? payload?.day`（日记按天去重） |
| `src/main/ai/AIJobQueueService.js` | 构造新增 `diaries`；新增 `enqueueWithDiary()` 与 `_cancelQueuedFor()`（force 手动重生成时取代排队中的旧任务） |
| `src/main/ai/jobEventLog.js` | 新增事件 `DIARY_SCAN` |
| `src/main/config.js` | 新增 `diaryModel` / `diaryTimeoutMs`（300000）/ `diaryScanLimit`（30） |
| `src/main/main.js` | 装配 `DiaryRepository` / `StatsRepository` / `OllamaDiaryProvider` / `DiaryGenerator`；按 Job 类型三路分流回填；区块状态变化时通知日记扫描；启动 `start()`、退出 `stop()` |
| `src/main/stats/period.js` | 修正 `future` 的语义（见第 6 节） |
| `src/preload.js` | 新增 `getDiary` / `getDiaryDays` / `getDiaryStatus` / `regenerateDiary` / `getStats` |
| `src/renderer/index.html` | 标签栏加「日记」「看板」；`#view-diary` / `#view-kanban`；引入 `diary.js` / `kanban.js` |
| `src/renderer/renderer.js` | `TAB_VIEWS` 加日记 / 看板；`refreshAll()` 与事件处理接入两个新页面 |
| `src/renderer/styles.css` | 日历（`.cal-*`）、日记（`.diary-*`）、看板（`.kanban-*` / `.chart-*` / `.donut-*` / `.stat-*`） |
| `test/support.js` | `makeQueue` 注入并返回 `diaries` 与 `stats` |
| `test/database.test.js` | 断言 `diaries` 表与 `idx_diaries_status`；新增 v2 → v3 升级用例 |
| `docs/README.md`、`docs/01`、`docs/02`、`docs/06`、`docs/07` | 索引、分层图、表结构、测试清单、环境变量 |

## 3. Schema 变更（v2 → v3）

只加了一张表和一条索引，**没有改任何已有列**，所以升级是纯增量：老库打开后 `user_version`
从 2 变成 3，`diaries` 建好，原有 `activities` / `ai_jobs` / `time_blocks` 数据一行不动
（`test/database.test.js` 有用例守着）。

```text
v2 db（21 条区块）-> 打开后：user_version=3、diaries 表存在、idx_diaries_status 存在、time_blocks 21 条不变
```

## 4. 自动化测试

```text
node --test test/diary.test.js            15/15
node --test test/diaryView.test.js        11/11
node --test test/statsRepository.test.js   9/9
node --test test/kanbanView.test.js       13/13
npm test                                 220/220
```

## 5. 真实 Electron 冒烟验证

环境：Windows + Electron 44.3.0，隔离数据目录 `%TEMP%\lifelens-p9-smoke-<时间戳>`
（`LIFELENS_DIR` + `LIFELENS_AUTOSTART=0` + 独立 `--user-data-dir` + `--remote-debugging-port`）。

**不依赖真实模型**：起一个假 Ollama（`/api/tags` 返回模型列表，`/api/chat` 延迟 150ms 后返回一篇
合法的日记 JSON），数据目录里预置 3 天 × 7 个已汇总区块 + 21 条已分析记录。

启动日志（节选）：

```text
[DB] Database opened: ...\lifelens-p9-smoke-20260916-195452\data\lifelens.db
[DB] Schema version: 3
[AI-JOB] JOB_STARTED   job=DIARY_GENERATION_mu41nh0s_11cf5049 type=DIARY_GENERATION status=PROCESSING
[AI-JOB] JOB_COMPLETED job=DIARY_GENERATION_mu41nh0s_11cf5049 type=DIARY_GENERATION status=COMPLETED events=2 highlights=1 todos=1 suggestions=1
[AI-JOB] JOB_COMPLETED job=DIARY_GENERATION_mu41nh0x_b1dc89fc type=DIARY_GENERATION status=COMPLETED ...
[AI-JOB] JOB_COMPLETED job=DIARY_GENERATION_mu41nh0y_47480fea type=DIARY_GENERATION status=COMPLETED ...
[fake-ollama] chat model=fake-summary:latest prompt=2609 chars 有日记标记=true
```

用 CDP 在真实渲染进程里逐项确认（Renderer → Preload → IPC → Main → SQLite）：

```text
1 页面就绪            true
2 标签页              记录/动态/日记/看板
3 日记页可见性        diary=block/visible dynamics=none
4 默认选中的是哪天     2026年9月（日历标题）/ 选中 2026-09-15 / 今天 2026-09-16
5 日历格子            格子 35，可点 30，已完成 3，未生成 32
6 日记详情标题        2026年9月15日 周二 | 7 个时间段 · 共 1 小时 10 分 · 7 张截图 · 主要在工作（4 段）
7 日记六段            简短总结 / 主要事项 / 高光 / 待办 / 优化建议 / 温馨提示
8 日记正文            这一天主要在写《2026 年中报告》，上午整理数据，下午把结论补进报告里，中途被…
9 内联样式违规        0
10 换一天             2026年9月14日 周一 | 这一天主要在写《2026 年中报告》…
11 看板（周）         label=2026年9月14日 – 20日，nextDisabled=true，卡片=[2 小时 20 分/14 个/14 张/2-7 天/1 小时 10 分]
                      面板=[时间分配/活动趋势/时段分布/项目专注时长/软件使用次数/关键词/待办线索]
                      svg=4、环形扇区=4、堆叠柱=14、排行条=13、关键词=2、待办=1
12 看板（日/月/年）    日=6 块面板（不重复画时段分布）、月=7 块、年=7 块，标签与锚点正确
13 上一期 / 回到今天   点「上一期」标签回到 2025 年且下一期可点；「回到今天」清空锚点并回显日期
15 控制台 / 安全日志   []（没有 CSP 违规、没有未捕获异常）
```

数据库侧：3 条 `diaries` 行全部 `COMPLETED`、`block_count = 7`、`model = fake-summary:latest`；
`ai_jobs` 里 `DIARY_GENERATION` 3 条全部 `COMPLETED`，没有孤儿任务。

## 6. 本阶段发现并修复的问题

- **`resolvePeriod().future` 的语义写反了**（补测看板数据层时发现）：实现是 `to <= now`（整段在过去），
  而界面与需求要的是「整段在未来」。结果是看板的「下一期」按钮完全反着来——
  已经过完的周期点不动「下一期」，未来的周期反而能一直往后翻。修复为 `from > now`。
- **标签栏漏了「看板」按钮**（真实 Electron 冒烟时发现）：`TAB_VIEWS`、`selectTab()`、
  `#view-kanban` 都到位了，只有 `<nav class="tabs">` 里少一个按钮，看板页在界面上根本点不到。
  纯函数单测覆盖不到装配层，这类问题只能靠真实冒烟或 DOM 桩用例兜住。
- **`enqueueWithDiary` 的手动重新生成会被去重吞掉**：`force` 只覆盖
  `COMPLETED` / `FAILED` 这类终态，同一天还有 `PENDING` / `RETRYING` 任务时去重照旧生效，
  用户点「重新生成」页面毫无反应。修复为 force 时先取消同一天排队中的旧任务再建新任务
  （`PROCESSING` 按状态机不可取消，此时仍然去重）。
- **`test/diary.test.js` 的三处用例与实现的真实语义不符**（收尾时修正）：第二遍扫描时
  「这一天已经没有缺口」而不是「跳过 1 个」；重入保护用例里那句占位写法
  （`scan.call({ ...generator, scanning: true })`）换成真正的并发调用断言；
  端到端用例补上了 `onCompleted -> DiaryGenerator.handleResult` 的装配，否则日记行永远停在 `PENDING`。

## 7. Scope Check

```text
日记手动编辑 / 日记导出 / 周报月报 / 自定义周期 / 同比环比 / 导出 CSV / 图表缩放平移 /
心情打分 / 日记搜索 / 云端同步 / 多语言输出 : NOT IMPLEMENTED
```

## 8. 留给后续 Phase 的问题

见《[18-日记生成](18-日记生成.md)》第 10 节与《[20-看板与统计](20-看板与统计.md)》第 10 节。
主要几条：

- 一天里补录了新区块不会自动重算已经完成的日记，只能手动「重新生成」；
- `FAILED` 的日记不会自动重试（避免无限循环），只能手动重新生成；
- 软件名仍是自由文本，排行里会出现同一软件的不同写法；
- 看板不区分「今天还没过完」，日视图的 `活跃天数/自然天数` 对比偏低；
- 日记的上下文只取上一天，跨天的长任务看不到更早的线索。