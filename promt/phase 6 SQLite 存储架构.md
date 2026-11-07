# Life Lens — Phase 6 SQLite Storage Architecture

## Coding Agent Prompt

你现在是本项目的 **Senior Electron + Node.js + SQLite Engineer**。

请直接在当前 Life Lens 项目代码基础上实施 **Phase 6：SQLite Storage Architecture**。

---

# 1. Phase 6 的核心目标

本阶段的唯一核心目标：

> **将 Life Lens 从当前 JSON 文件存储正式切换为 SQLite 本地数据库存储。**

特别注意：

## 本阶段不需要迁移旧数据

这是一个非常明确的产品决策：

* 不需要读取旧的 `activities-*.json`
* 不需要读取旧的 `ai-jobs.json`
* 不需要把旧 JSON 转换成 SQLite
* 不需要做 JSON → SQLite migration
* 不需要保留 legacy JSON compatibility
* 不需要设计旧数据回滚机制
* 不需要为了兼容旧 JSON 而增加复杂代码

可以假设：

> **Phase 6 上线时，SQLite 是一个全新的正式数据源。**

旧 JSON 文件可以继续存在于用户磁盘中，但 Phase 6 **完全不读取、不导入、不依赖它们**。

如果项目当前启动目录中存在旧 JSON：

> Ignore them.

不要为了它们增加任何 migration logic。

---

# 2. 当前项目背景

当前项目已经完成：

* Phase 1：代码 Review / Bug Fix
* Phase 2：Screenshot System Stabilization
* Phase 3：Screenshot Similarity Filtering
* Phase 4：Ollama + Qwen3-VL 8B
* Phase 5：AI Job Queue
* Phase 5.1：AI Job Recovery / Compensation
* Phase 5.2：Structured AI Output

当前系统已经具备：

```text
Screenshot Capture
      ↓
Similarity Filter
      ↓
Activity Record
      ↓
AI Job
      ↓
AI Worker
      ↓
Ollama / Qwen3-VL
      ↓
Structured Analysis
```

AI Worker 当前具备：

```text
PENDING
PROCESSING
COMPLETED
FAILED
RETRYING
CANCELLED
```

以及：

* Retry
* Timeout
* Ollama unavailable handling
* Model missing handling
* Crash recovery
* PROCESSING → PENDING recovery
* AI Pause / Resume
* Reanalysis
* Structured JSON output
* Activity analysis persistence

当前测试基线：

```text
61 / 61 PASS
```

请先运行现有测试确认当前基线。

---

# 3. Phase 6 非目标

本阶段严禁扩大范围。

以下功能 **不要实现**：

* Timeline
* Dashboard
* Statistics
* Diary
* Projects
* Memory
* RAG
* Vector Database
* Semantic Search
* Ask My Life
* Personal AI Agent
* AI Insights
* Todo
* Focus
* Embedding
* Full-text search system
* Knowledge graph
* Cloud sync
* Multi-device sync
* Account system
* Authentication
* Server database
* PostgreSQL
* MongoDB
* Redis
* Tauri migration
* TypeScript migration
* ORM migration
* Electron architecture rewrite
* AI Queue rewrite
* Ollama architecture rewrite
* Screenshot capture rewrite

不要因为 SQLite 将来可以支持这些功能，就提前实现。

---

# 4. 第一阶段：先检查当前代码

在修改任何代码之前，先完整检查当前项目。

重点检查：

```text
package.json
src/main/
src/main/recorder.js
src/main/store.js
src/main/capture.js
src/main/config.js
src/main/analyzer.js
src/main/ai/
src/main/main.js
src/preload.js
src/renderer/
test/
```

确认：

1. 当前 Node.js 版本
2. Electron 版本
3. npm 版本
4. 当前 package.json
5. 当前 JSON Store 实现
6. Activity Record 当前结构
7. AI Job 当前结构
8. AIJobQueueService 当前行为
9. AIWorker 当前行为
10. Recorder 当前行为
11. Reanalysis 当前行为
12. Shutdown 当前行为
13. Crash Recovery 当前行为
14. IPC 当前行为
15. 当前测试结构

不要凭假设修改。

---

# 5. SQLite Driver 选择

首选评估 Node.js 内置的：

```text
node:sqlite
```

当前环境已实测可用：

```text
系统 Node 22.23.2        → require('node:sqlite') OK
Electron 44.3.0          → 内置 Node 24.20.0，require('node:sqlite') OK
```

选择理由：

* 内置模块，零 native 依赖，彻底不存在 ABI 问题
* 测试用系统 Node 跑（node --test），应用用 Electron 跑，两边加载同一个内置实现
* 同步 API（DatabaseSync / prepared statements），与本项目主进程单线程 + 20 秒级低频写入的负载完全匹配

注意事项：

* 系统 Node 22.x 下 require 会打印 ExperimentalWarning，属预期现象，不要为了消除警告引入 native 依赖

降级方案 better-sqlite3（仅在 node:sqlite 不可用时采用）：

* Electron 的 Node ABI ≠ 系统 Node.js ABI，一份编译产物无法同时服务两者
* 特别注意：本项目的测试命令是 `node --test`（系统 Node），better-sqlite3 必须同时能在 Electron Main Process 和系统 Node 里加载，需要双 ABI 构建或统一改用 ELECTRON_RUN_AS_NODE 跑测试
* 不要只执行 `npm install better-sqlite3` 就认为完成，必须验证 driver 在真实 Electron Main Process 中加载成功

无论选哪个 driver：

* 不要偷偷修改 Electron 版本
* 不要升级整个项目到最新 Electron
* 不要为了 SQLite 重构项目

优先选择最小改动方案。

---

# 6. SQLite 数据库位置

数据库必须放在当前 Life Lens 数据目录中。

使用现有：

```text
LIFELENS_DIR
```

不要创建第二套数据目录。

例如：

```text
LIFELENS_DIR/
    lifelens.db
    screenshots/
    ...
```

推荐：

```text
path.join(LIFELENS_DIR, 'lifelens.db')
```

具体实现以当前项目 config 为准。

不要硬编码：

```text
C:\xxx
```

不要硬编码用户目录。

---

# 7. SQLite 数据库模块

建立清晰的 Database Layer。

推荐结构：

```text
src/main/db/
├── database.js
├── schema.js
├── migrations.js
└── repositories/
    ├── ActivityRepository.js
    └── AIJobRepository.js
```

如果当前项目代码风格更适合：

```text
src/main/db/
├── database.js
├── schema.js
├── migrations.js
├── activityRepository.js
└── aiJobRepository.js
```

也可以。

重点不是文件名。

重点是：

> SQL 不应该散落在 Recorder / Worker / Main / Renderer 中。

---

# 8. 不使用 ORM

本阶段：

> 不使用 ORM。

不要引入：

```text
Prisma
Sequelize
TypeORM
Drizzle
Knex
```

SQLite + prepared statements + repository layer 即可。

原因：

Life Lens 是本地单机 Electron 应用。

当前阶段不需要 ORM 的复杂度。

---

# 9. SQLite Schema

设计第一版正式 Schema。

至少包含两个核心表：

```text
activities
ai_jobs
```

---

# 10. activities 表

建议：

```sql
CREATE TABLE activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    screenshot_id TEXT NOT NULL UNIQUE,

    captured_at TEXT NOT NULL,

    image_path TEXT NOT NULL,

    analysis_status TEXT NOT NULL,

    activity TEXT,

    summary TEXT,

    category TEXT,

    project TEXT,

    keywords_json TEXT,

    confidence REAL,

    model TEXT,

    analysis_ms INTEGER,

    error TEXT,

    error_code TEXT,

    created_at TEXT NOT NULL,

    updated_at TEXT NOT NULL
);
```

字段含义：

### id

SQLite 自增 ID。

### screenshot_id

业务主键：截图文件名去掉扩展名（当前 `record.id`，例如 `2026-09-11_21-06-05-042`）。

这是现有业务层实际使用的键（AI Job 的 `payload.screenshotId`、Reanalyze、分析结果回填），必须落库并 UNIQUE。Job 通过 `activity_id` 关联到 `activities.id`，业务层通过 `screenshot_id` 查找。

### captured_at

截图实际捕获时间。

时间格式要求见第 39 节：

```text
带时区的 ISO-8601，沿用 formatLocalIso 的 ±hh:mm 形态
```

例如：

```text
2026-09-13T13:30:00.123+08:00
```

不要使用没有时区的 naive 字符串。

### image_path

截图文件路径。

优先保存：

> 相对于 LIFELENS_DIR 的路径

例如：

```text
screenshots/2026/09/13/xxx.png
```

而不是：

```text
C:\Users\xxx\AppData\...\screenshots\xxx.png
```

这样未来移动数据目录时更加稳定。

如果当前架构强依赖绝对路径，可以暂时使用绝对路径，但必须封装路径处理，不要让路径逻辑散落在业务层。

### analysis_status

保持当前 Activity analysis 状态语义，实际只有三个值：

```text
PENDING
COMPLETED
FAILED
```

不要新增 `PROCESSING` —— 当前 Recorder 不会写入这个状态，Activity 在分析结束前一直是 PENDING。

### activity

Structured AI Output：

```text
analysis.activity
```

### summary

Structured AI Output：

```text
analysis.summary
```

### category

Structured AI Output：

```text
analysis.category
```

### project

Structured AI Output：

```text
analysis.project
```

允许：

```text
NULL
```

### keywords_json

保存：

```text
analysis.keywords
```

当前阶段直接 JSON string 即可。

例如：

```json
["AI","Ollama","GPU","Python"]
```

不要现在创建：

```text
keywords
activity_keywords
projects
```

等关系表。

未来真正需要搜索 / RAG 时再设计。

### confidence

保存：

```text
analysis.confidence
```

SQLite 中：

```text
REAL
```

业务层继续保证：

```text
0 <= confidence <= 1
```

### error

保存当前 Activity 分析错误。

### error_code

保存错误码（当前 Recorder 失败回填时的 `errorCode`），与 error 分列，便于按错误类型统计。

### model

执行本次分析的实际模型名（当前 `record.model` / 回填的 `result.model`）。可能与 config 里的默认模型不同（历史记录），所以要逐条保存。

### analysis_ms

本次 AI 分析耗时毫秒（当前 `record.analysisMs`）。

### created_at / updated_at

时间格式同 captured_at（第 39 节）：带时区的 ISO-8601，沿用 `formatLocalIso` 形态。

---

# 11. ai_jobs 表

建议：

```sql
CREATE TABLE ai_jobs (
    id TEXT PRIMARY KEY,

    type TEXT NOT NULL,

    activity_id INTEGER,

    status TEXT NOT NULL,

    priority INTEGER NOT NULL DEFAULT 5,

    retry_count INTEGER NOT NULL DEFAULT 0,

    max_retries INTEGER NOT NULL,

    error_code TEXT,

    error_message TEXT,

    last_error TEXT,

    payload_json TEXT,

    created_at TEXT NOT NULL,

    started_at TEXT,

    completed_at TEXT,

    failed_at TEXT,

    updated_at TEXT NOT NULL,

    FOREIGN KEY (activity_id)
        REFERENCES activities(id)
);
```

字段说明（对齐当前 job.js 数据模型，不要另行发明）：

### type

`AIJobType`（当前只有 `SCREENSHOT_ANALYSIS` 在用，其余已预留）。enqueue 去重依赖 `(type, screenshotId)` 组合，必须落库。

### priority

默认值 `5` 对应当前 `JOB_PRIORITY.NORMAL`。不要写 `DEFAULT 0` —— 队列按数值越大越先执行（HIGH 10 / NORMAL 5 / LOW 1），默认 0 会产生比 LOW 还低的隐式优先级。

### retry_count / max_retries

直接对应当前 `job.retryCount` / `job.maxRetries`：retry_count 是"已调度的重试次数"，max_retries 是"允许的上限"。不要改名成 attempts/max_attempts —— 两者语义有 off-by-one 差异，换名字必然引入映射错误。

### last_error / failed_at

对应当前 `job.lastError` / `job.failedAt`，队列在维护它们，不能丢。

### payload_json

原样保存 `job.payload`（还原成对象存取）。Worker/VisionProvider 靠 `payload.imagePath` 读图、Recorder 回填靠 `payload.screenshotId`，保留它可以让 Worker / Provider / Recorder 代码零改动。`SCREENSHOT_ANALYSIS` 类型的 Job 同时写 `activity_id`，用于关系查询与外键约束；未来不带 Activity 的 Job 类型（如 TIMEBLOCK_SUMMARY）`activity_id` 允许为 NULL。

### 不设 next_attempt_at

当前重试退避是内存 `setTimeout`（Phase 5 语义），RETRYING 的 Job 重启后直接恢复为 PENDING，不存在持久化的"下次执行时间"概念。不要凭空增加这一列。

注意：

不要擅自增加：

```sql
UNIQUE(activity_id)
```

除非检查当前 Phase 5 reanalysis 行为后，确认一个 Activity 永远只允许一个 AI Job。

因为当前系统已经存在：

```text
Reanalyze
```

未来很可能：

```text
one activity
    ↓
multiple analysis attempts/jobs
```

因此不要提前限制。

---

# 12. Job 状态必须保持当前语义

使用当前 Phase 5 定义：

```text
PENDING
PROCESSING
COMPLETED
FAILED
RETRYING
CANCELLED
```

不要重新定义。

不要为了 SQLite 改变 AI Worker 的状态机。

SQLite 只是：

> 替换 JSON persistence。

不是：

> 重写 AI Queue。

---

# 13. Repository Layer

必须建立 Repository。

至少：

```text
ActivityRepository
AIJobRepository
```

---

## ActivityRepository

按当前 Store 的实际能力对齐，保证 Recorder 现有语义不丢：

```text
createActivity(record)              → 原 store.appendRecord
updateAnalysis(screenshotId, patch) → 原 store.updateRecord（不再需要 capturedAt 定位文件）
listRecentActivities(limit)         → 原 store.listRecent
getStats()                          → 原 store.loadStats（SQL 聚合；UI 统计依赖它）
listPendingActivities()             → 原 store.listPendingRecords（Phase 5.1 启动补偿依赖它）
insertActivityWithJob(record, job)  → 单事务插入，见第 22 节
```

重要原则：

> 保留当前业务层需要的语义。

不要为了数据库 API 而让 Recorder 大面积重写。

---

## AIJobRepository

保持与当前文件版仓库相同的快照式接口，队列逻辑零改动：

```text
load()      → 读取全部 Job（启动恢复用）
save(jobs)  → 全量快照持久化（单个事务内：upsert 全部行 + 删除本次快照中不存在的行）
flush()     → 等待写完成
```

说明：

* 当前 `AIJobQueueService` 在内存里维护 jobs 数组做去重、调度、裁剪，持久化只走 load/save。SQLite 版本继续这个模式，Queue 内部逻辑不需要改
* 每次状态变更全量 upsert 上限 500 行，对 SQLite 微不足道。不要为了"看起来更高效"改成 row-level 逐行 API（claimJob 之类），那是更大的队列改造，违反最小改动原则
* `load()` 重建 Job 对象时，payload_json 必须还原成 payload 对象，保证 Worker / Recorder 拿到的 Job 结构与 JSON 时代完全一致
* SCREENSHOT_ANALYSIS 的 Job 在 save 时解析 payload.screenshotId 反查 activities.screenshot_id 得到 activity_id 一并写入；若找不到对应 Activity（理论上事务保证后不会发生），activity_id 存 NULL 并记 warning

终态裁剪行为必须保留：当前队列按 `maxTerminalJobs`（默认 500，来自 `aiMaxTerminalJobs` 配置）封顶删除最老的终态 Job。SQLite 版本在同一个 save 事务里删除超出上限的最老终态行。不要因为换了数据库就让 ai_jobs 无限增长，也不要删除这个配置。

---

# 14. Repository 不能暴露数据库细节给业务层

错误方式：

```js
recorder.db.prepare(...)
```

或者：

```js
AIWorker.db.run(...)
```

禁止。

正确：

```text
Recorder
   ↓
ActivityRepository
   ↓
SQLite
```

以及：

```text
AIWorker
   ↓
AIJobQueueService
   ↓
AIJobRepository
   ↓
SQLite
```

---

# 15. SQLite 初始化

Electron Main Process 启动时初始化数据库。

大致：

```text
Electron startup
      ↓
config
      ↓
SQLite open
      ↓
PRAGMA configuration
      ↓
schema initialization
      ↓
repositories ready
      ↓
Recorder / Queue / Worker
```

不要让 Renderer 直接打开 SQLite。

---

# 16. SQLite PRAGMA

至少考虑：

```sql
PRAGMA foreign_keys = ON;
```

以及：

```sql
PRAGMA journal_mode = WAL;
```

WAL 如果当前 driver / filesystem / Electron 环境验证正常，可以使用。

同时考虑：

```sql
PRAGMA busy_timeout = 5000;
```

具体值可以根据实际 driver 调整。

重点：

> SQLite 必须保证本地应用异常退出时的数据安全性。

不要为了性能关闭 durability。

不要使用：

```text
synchronous = OFF
```

除非有非常充分的理由。

默认安全优先。

WAL 附带说明：

* 启用 WAL 后数据目录会出现 `lifelens.db-wal` 和 `lifelens.db-shm`，用户整目录备份/迁移时必须包含这两个文件，需要在用户文档或提示里说明
* 正常 `db.close()` 会自动 checkpoint；Shutdown 流程里不要跳过 close，避免 -wal 文件长期膨胀

---

# 17. Schema Version

必须有数据库 Schema Version。

优先使用：

```sql
PRAGMA user_version;
```

例如：

```text
0 → empty
1 → initial schema
```

虽然本阶段没有旧 JSON migration，但：

> SQLite 自己仍然需要具备未来 Schema Migration 能力。

例如未来：

```text
version 1
→
version 2
→
version 3
```

因此建立：

```text
migrations.js
```

或者同等轻量实现。

不要做复杂 migration framework。

---

# 18. 非常重要：不要实现 JSON Migration

再次强调：

本阶段禁止：

```text
JSON → SQLite
```

不要实现：

```text
migrateLegacyJson()
importLegacyActivities()
importLegacyJobs()
backupLegacyJson()
validateLegacyJson()
```

也不需要：

```text
migration dry run
legacy migration rollback
legacy compatibility mode
```

因为本阶段默认：

> SQLite 是新系统的干净起点。

---

# 19. 旧 JSON 文件的处理

如果运行环境中发现：

```text
activities-*.json
ai-jobs.json
```

不要：

* 删除
* 修改
* 导入
* 解析
* 依赖

直接忽略。

不要为了清理旧文件而增加逻辑。

---

# 20. 新系统的数据来源

Phase 6 完成之后：

```text
SQLite
    ↓
Primary Storage
```

Filesystem：

```text
Screenshots
    ↓
Image Storage
```

也就是说：

```text
SQLite
    stores metadata / records / jobs

Filesystem
    stores screenshot files
```

不要把 screenshot image 存成 SQLite BLOB。

---

# 21. Recorder 修改

当前 Recorder 流程必须保持：

```text
capture screenshot
      ↓
similarity filtering
      ↓
save screenshot
      ↓
create Activity
      ↓
create AI Job
      ↓
return
```

SQLite 版本：

```text
capture screenshot
      ↓
similarity filtering
      ↓
save screenshot file
      ↓
aiQueue.enqueueWithActivity(record, options)
      ↓   （内部：Activity + AI Job 同一事务 INSERT，见第 22 节）
return
```

截图 id（screenshot_id）仍然取自图片文件名，业务语义不变。

---

# 22. Activity + AI Job 一致性

这是本阶段非常重要的地方。

当前系统已经解决：

> Activity 创建成功，但 AI Job 创建失败导致 PENDING Activity 永久卡住。

SQLite 版本必须继续保证这一点。

优先：

```text
SQLite transaction
```

例如：

```text
BEGIN
    INSERT activity
    INSERT ai_job
COMMIT
```

如果任意一步失败：

```text
ROLLBACK
```

不要产生：

```text
Activity exists
but Job missing
```

这种不一致状态。

实现落点（重要）：

当前 Activity 和 Job 由两个组件分别写入（Recorder 调 store，Queue 的 enqueue() 内部自己 persist）。去重检查、createJob、内存注册都在 Queue 里，所以组合入口放在 Queue 上，事务放在 Repository 层：

```text
aiQueue.enqueueWithActivity(record, options)     ← 新增，专供 Recorder 的 tick 使用
    1. 复用 enqueue 现有的去重逻辑（type + screenshotId）
    2. createJob
    3. activityRepository.insertActivityWithJob(record, job)   ← 单事务
       BEGIN
           INSERT INTO activities (...)          → 得到 lastInsertRowid
           INSERT INTO ai_jobs (..., activity_id = lastInsertRowid, ...)
       COMMIT
    4. 把 Job 注册进队列内存 + emit wake
    5. 返回值与 enqueue() 同构：{ job, created, reason }

activityRepository.insertActivityWithJob(record, job)
    只做纯 SQL 事务，不碰队列内存。
```

配套要求：

* enqueue() 对外签名与返回值保持不变；把「创建 Job + 注册进内存 + emit wake」抽成内部公共路径，enqueueWithActivity 复用它，去重逻辑只保留一份实现
* Recorder 的 tick 流程改为：截屏 → saveImage → enqueueWithActivity，替换原来的 appendRecord + enqueue 两步
* reanalyze 等只涉及 Job 的路径继续走 enqueue()，单表操作即可
* 启动补偿 recoverPendingAnalyses() 保留为安全网：SQL 找出 analysis_status = 'PENDING' 的活动，沿用原有 findJobForScreenshot 去重后补建。事务保证下它理论上永远扫到 0 条，但保留成本低、能兜住未知边角情况，相关测试同步保留

---

# 23. Screenshot 文件与 SQLite Transaction

注意：

SQLite transaction 无法自动回滚已经写入 filesystem 的 PNG。

因此：

```text
save screenshot
      ↓
SQLite transaction
```

如果 SQLite 失败：

需要考虑：

```text
delete newly-created screenshot
```

避免留下 orphan screenshot。

但是：

> 不要因此重写 Screenshot System。

只实现最小可靠补偿逻辑。

推荐：

```text
1. capture
2. save screenshot
3. begin DB transaction
4. create activity
5. create job
6. commit
7. success
```

如果 3–6 失败：

```text
rollback
delete newly-created screenshot
throw
```

如果删除 screenshot 失败：

记录 warning/error，但不能假装已经删除。

---

# 24. AI Worker

AI Worker 逻辑基本保持不变：

```text
health
↓
dequeue
↓
PROCESSING
↓
provider
↓
structured result
↓
COMPLETED
```

区别只是：

```text
JSON persistence
```

变成：

```text
SQLite persistence
```

不要重新设计 Worker。

---

# 25. Crash Recovery

必须保留 Phase 5.1 / 5.2 的恢复机制。

应用启动：

```text
SQLite:
    PROCESSING
    RETRYING
```

应该恢复为：

```text
PENDING
```

或者按照当前 Phase 5 的既有 recovery semantics 恢复。

重点：

> Electron 被 kill 后，下一次启动不能永久留下 PROCESSING Job。

---

# 26. Queue Startup Recovery

启动顺序建议：

```text
SQLite open
      ↓
schema check
      ↓
recover PROCESSING jobs
      ↓
recover RETRYING jobs if required
      ↓
initialize Queue
      ↓
start Worker
```

不要：

```text
Worker starts
↓
database recovery happens later
```

避免 Worker 在 recovery 前读取错误状态。

---

# 27. Reanalysis

必须验证当前 Phase 5 的：

```text
Reanalyze
```

行为。

SQLite 化以后不能破坏它。

例如：

```text
existing Activity
       ↓
create new AI Job
       ↓
PENDING
       ↓
Worker
       ↓
new structured result
       ↓
update Activity
```

不要通过数据库 UNIQUE constraint 阻止 reanalysis。

---

# 28. Structured AI Output

Phase 5.2 已经完成：

```text
activity
summary
category
project
keywords
confidence
```

SQLite 必须直接存储这些字段。

不要只存：

```text
analysis_json
```

例如不要设计成：

```sql
analysis TEXT
```

然后把整个结构塞进去。

第一版应该：

```text
activity
summary
category
project
keywords_json
confidence
```

这样未来查询和统计更加容易。

---

# 29. sentences 旧字段

因为本阶段明确：

> 不迁移旧数据。

所以不需要为了历史 JSON 中的：

```text
sentences
```

增加：

```text
legacy_sentences_json
```

也不需要：

```text
legacy compatibility
```

Phase 6 的新 SQLite schema 不必包含 `sentences`。

Phase 5.2 当前代码如果仍有 `sentences` compatibility：

可以保留上层兼容逻辑一段时间，但：

> SQLite 新 Activity 不需要把旧 JSON sentences 当成历史数据迁移进去。

如果当前代码已经不再真正使用 `sentences`：

可以删除相关死代码，但必须：

* 不影响现有测试
* 不扩大重构范围
* 不修改 Structured AI Output

同样不需要保留的还有旧 record 里的：

```text
timestamp
```

（epoch 毫秒数）。`captured_at` 已经承载时间信息，Renderer 当前没有使用它，SQLite schema 不为它保留列。

---

# 30. JSON Store 的处理

当前：

```text
src/main/store.js
```

可能承担 JSON persistence。

Phase 6 完成后：

> JSON Store 不再作为正式 Activity / AI Job persistence。

根据当前代码实际情况：

可以：

### 方案 A

直接移除 JSON persistence。

或者：

### 方案 B

保留 `store.js` 中仍有用的纯工具功能，但：

> Activity / AI Job 数据不能再写 JSON。

按当前代码实际情况：Store 的目录结构、统计、补偿扫描等能力整体迁入 ActivityRepository 后，`readJson` / `writeJsonAtomic` 若无其他使用方，可随 JSON 持久化一并移除（注意 `ai/jobEventLog` 是纯内存实现，不受影响）。

不要为了保留旧架构而继续：

```text
SQLite + JSON dual write
```

---

# 31. 不要 Dual Write

这是本阶段的明确要求。

禁止：

```text
write SQLite
+
write JSON
```

作为正常业务流程。

Phase 6 完成后：

```text
SQLite = Primary Storage
JSON = Not Used
```

这样可以避免：

```text
SQLite says A
JSON says B
```

的数据一致性问题。

---

# 32. Main Process

修改：

```text
src/main/main.js
```

建立：

```text
Database
Repositories
Recorder
Queue
Worker
```

正确生命周期。

推荐：

```text
app ready
    ↓
database init
    ↓
repositories
    ↓
recovery
    ↓
recorder
    ↓
AI queue
    ↓
worker
```

---

# 33. Graceful Shutdown

Shutdown 必须考虑：

```text
Electron quit
```

过程中：

1. 停止新的 screenshot capture
2. 停止新的 AI Job 接收
3. Worker 停止继续领取新任务
4. 等待当前任务按现有策略结束 / timeout
5. flush 必要状态
6. close SQLite
7. Electron quit

不能：

```text
db.close()
```

之后 Worker 仍然执行：

```text
UPDATE ai_jobs
```

否则可能出现：

```text
Database is closed
```

异常。

---

# 34. Renderer / IPC

Renderer：

> 不允许直接访问 SQLite。

正确：

```text
Renderer
    ↓
preload.js
    ↓
IPC
    ↓
Main Process
    ↓
Repository
    ↓
SQLite
```

如果当前 UI 已经有 Activity 数据 API：

尽量保持 API 不变。

不要因为 SQLite 引入而让 Renderer API 大幅改变。

---

# 35. 查询接口

当前阶段不需要复杂查询系统。

只提供未来 Timeline 所需的最基本查询能力，例如：

```text
listActivities({
    limit,
    offset,
    startTime,
    endTime
})
```

或者按照当前 UI 需要提供：

```text
getRecentActivities()
```

重点：

> 不要提前做完整 Timeline Query Engine。

---

# 36. Index

根据实际查询增加最少必要索引。

推荐：

```sql
CREATE INDEX idx_activities_captured_at
ON activities(captured_at);

CREATE INDEX idx_activities_analysis_status
ON activities(analysis_status);

CREATE INDEX idx_ai_jobs_status
ON ai_jobs(status);

CREATE INDEX idx_ai_jobs_activity_id
ON ai_jobs(activity_id);
```

说明：

* `activities.screenshot_id` 的 UNIQUE 约束自带索引，不必重复建
* 不要建立几十个未来可能用到的索引

原则：

> Index based on actual query patterns.

---

# 37. SQLite Constraints

可以使用必要的：

```text
NOT NULL
FOREIGN KEY
CHECK
```

例如：

```sql
CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
```

但不要把大量业务逻辑塞进 SQLite。

例如：

```text
category enum
job state machine
AI retry rules
```

继续由应用层管理。

---

# 38. Unicode

必须正确支持：

```text
中文
英文
emoji
特殊字符
```

例如：

```text
正在浏览知乎学堂
AI 服务
Ollama
GPU利用率
```

SQLite UTF-8 应正常工作。

必须加入测试。

---

# 39. 时间处理

数据库时间的硬性要求：

> 必须是带时区信息的 ISO-8601 字符串。

禁止：

```text
2026-09-13 13:30:00
```

这种没有 timezone 的 naive 字符串。

两种合法形态：

```text
2026-09-13T05:30:00.123Z          （UTC）
2026-09-13T13:30:00.123+08:00     （带偏移的本地时间）
```

当前代码全链路（Recorder / Job / Queue）已经统一使用 `formatLocalIso` 产出的带偏移格式，Renderer 直接显示它。

本阶段的决定：

> 沿用现有 ±hh:mm 偏移格式入库，不改成 UTC，也不改 Renderer。

理由：

* 两种形态都可排序、无歧义，满足"禁止 naive 字符串"的真实目标
* 强行切 UTC 需要同步修改 Renderer 的时间显示，违反本阶段最小改动原则
* 未来做 Timeline / 多时区功能时再统一迁移，届时也只动 repository 边界

注意：同一张表里不要混用两种形态，否则字符串比较排序会错乱。统一沿用 `formatLocalIso` 一种即可，repository 层不做二次转换。

---

# 40. Prepared Statements

所有用户 / AI / 文件路径等动态值：

> 必须使用 prepared statements。

禁止字符串拼 SQL。

错误：

```js
db.prepare(`SELECT * FROM activities WHERE id = ${id}`)
```

正确：

```js
db.prepare(
    'SELECT * FROM activities WHERE id = ?'
).get(id)
```

---

# 41. Database Error Handling

数据库错误必须：

* 不吞掉
* 有明确日志
* 不让错误导致 Screenshot Loop 永久停止
* 根据当前 Recorder semantics 做必要 compensation

尤其：

> SQLite 暂时 busy / locked

必须有合理处理。

---

# 42. Screenshot 系统不能被 SQLite 故障永久拖死

这是整个项目的核心可靠性要求。

原则：

```text
AI failure
    ≠
Screenshot failure
```

Phase 6 后还必须保持：

```text
SQLite temporary failure
```

不会让应用进入不可恢复状态。

如果数据库操作失败：

* 记录错误
* 做必要 compensation
* 不要 crash 整个 Electron process
* Screenshot scheduler 应能够按照现有设计继续工作，或者明确进入可恢复错误状态

不要偷偷改变当前 Screenshot Scheduler semantics。

---

# 43. 测试

必须新增 SQLite 专项测试。

所有测试使用：

```text
temporary database
```

绝对不能操作真实用户数据库。

---

## Test 1 — Database Initialization

验证：

```text
database file created
schema created
tables exist
```

---

## Test 2 — Schema Version

验证：

```text
PRAGMA user_version
```

正确。

---

## Test 3 — Activity Create

测试：

```text
createActivity()
```

并确认：

```text
id
captured_at
image_path
analysis_status
```

正确写入。

---

## Test 4 — Structured Analysis Persistence

写入：

```json
{
  "activity": "学习技术文档",
  "summary": "正在学习 AI 服务相关内容",
  "category": "learning",
  "project": null,
  "keywords": ["AI", "Ollama"],
  "confidence": 0.9
}
```

重新读取，确认全部一致。

---

## Test 5 — AI Job Persistence

测试：

```text
PENDING
PROCESSING
COMPLETED
FAILED
RETRYING
CANCELLED
```

状态更新正确。

---

## Test 6 — Activity + Job Transaction

模拟：

```text
Activity INSERT succeeds
Job INSERT fails
```

确认：

```text
Activity does NOT remain in database
```

即：

```text
ROLLBACK
```

---

## Test 7 — Crash Recovery

创建：

```text
PROCESSING
RETRYING
```

模拟应用重新启动。

确认按照 Phase 5 semantics：

```text
→ PENDING
```

---

## Test 8 — Reanalysis

验证：

```text
Activity
↓
Reanalyze
↓
new Job
```

不能被 UNIQUE constraint 错误阻止。

---

## Test 9 — Unicode

测试：

```text
中文
English
emoji
特殊字符
```

---

## Test 10 — Time

测试：

```text
带时区的 ISO-8601（formatLocalIso 形态）
```

正确保存和读取，字符串排序与时间顺序一致。

---

## Test 11 — 1000+ Records

插入至少：

```text
1000 activities
```

确认：

* 没有 corruption
* 查询正常
* 时间排序正确
* repository 没有明显逻辑错误

---

## Test 12 — SQLite Integrity

执行：

```sql
PRAGMA integrity_check;
```

必须得到：

```text
ok
```

---

## Test 13 — Foreign Key

验证：

```text
ai_jobs.activity_id
```

不能产生非法 foreign key。

---

## Test 14 — Electron Driver 加载

不能只在 Node.js：

```bash
node test.js
```

验证。

必须验证：

> Electron Main Process 可以正常加载 SQLite driver（无论 node:sqlite 还是 better-sqlite3）。

---

## Test 15 — Job 快照往返

验证：

```text
save(jobs) → load()
```

往返后 id / type / status / priority / retryCount / maxRetries / payload 完全一致，payload_json 正确还原为对象，SCREENSHOT_ANALYSIS 的 activity_id 正确关联。

---

## Test 16 — 终态裁剪

插入超过 `maxTerminalJobs` 的终态 Job，确认最老的终态行在 save 事务里被删除、活跃 Job 不受影响、行为与当前 JSON 版队列一致。

---

# 44. 现有测试不能退化

Phase 6 开始：

```text
npm test
```

必须首先确认：

```text
61 / 61 PASS
```

完成 SQLite 后：

> 所有旧测试必须继续通过。

如果旧测试需要修改：

必须判断是不是因为 persistence implementation 变化。

不要为了让测试通过而删除测试。

---

# 45. Real Electron Smoke Test

完成代码后必须进行一次真实 Electron smoke test。

验证：

```text
Electron starts
↓
SQLite initializes
↓
Screenshot capture
↓
Activity inserted
↓
AI Job inserted
↓
AI Worker
↓
Ollama
↓
Structured result
↓
SQLite Activity updated
↓
AI Job COMPLETED
```

至少验证一轮完整链路。

---

# 46. Force Kill Test

真实 Electron 启动后：

```text
capture
↓
job
↓
PROCESSING
```

然后强制 kill Electron。

重新启动。

验证：

```text
PROCESSING
↓
PENDING
↓
Worker
↓
COMPLETED
```

不能永久卡住。

---

# 47. 数据库文件检查

Smoke Test 完成后检查：

```text
LIFELENS_DIR/lifelens.db
```

确认：

* 文件存在
* SQLite 可以打开
* tables 正确
* records 正确
* foreign keys 正确
* integrity_check = ok

---

# 48. Logging

增加必要的数据库日志，例如：

```text
[DB] Database opened
[DB] Schema initialized
[DB] Schema version: 1
[DB] Recovered N AI jobs
[DB] Database closed
```

不要打印：

* 用户隐私
* screenshot 内容
* 大量 SQL
* AI 全部输出

日志保持简洁。

---

# 49. Performance

当前 screenshot interval 大约：

```text
20 seconds
```

AI：

```text
concurrency = 1
```

SQLite 对这个 workload 非常轻。

不要过早优化。

不要：

* connection pool
* sharding
* caching layer
* Redis
* worker-thread database
* complicated batch system

当前：

> 一个 Electron Main Process + SQLite 足够。

---

# 50. Architecture Target

完成之后，整体架构应该接近：

```text
                    ┌──────────────────┐
                    │ Electron Renderer│
                    └────────┬─────────┘
                             │ IPC
                             ▼
                    ┌──────────────────┐
                    │ Electron Main    │
                    └────────┬─────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
            ▼                ▼                ▼
       Screenshot         Recorder         AI Queue
          System              │                │
                              │                ▼
                              │             AI Worker
                              │                │
                              │                ▼
                              │             Ollama
                              │
                              ▼
                       Repository Layer
                              │
                              ▼
                         SQLite DB
                              │
                              ▼
                      lifelens.db
```

Screenshot files：

```text
LIFELENS_DIR/
└── screenshots/
```

Database：

```text
LIFELENS_DIR/
└── lifelens.db
```

---

# 51. Data Ownership

最终必须明确：

```text
Screenshot files
    → Filesystem

Activity metadata
    → SQLite

AI Jobs
    → SQLite

AI structured analysis
    → SQLite

Application configuration
    → current config mechanism
```

不要把所有东西都塞进 SQLite。

---

# 52. 不要修改 Ollama

Phase 4 / Phase 5.2 已经验证：

当前环境：

```text
Ollama 0.34.0
qwen3-vl:8b
```

当前 Structured Output 使用：

```text
/api/chat
+
format
```

并且没有传：

```text
think
```

本阶段：

> 不要修改 Ollama integration。

不要：

* reinstall Ollama
* change model
* change endpoint
* change prompt
* change schema
* change thinking strategy

除非 SQLite 改造导致非常明确的兼容问题。

---

# 53. 不要修改 AI Worker Architecture

当前：

```text
AIJobQueueService
AIWorker
VisionProvider
OllamaVisionProvider
StructuredOutput
```

已经工作。

本阶段：

> SQLite 是 persistence replacement。

不是：

> AI architecture rewrite。

保持：

```text
Worker → Queue → Repository
```

而不是：

```text
Worker → SQL
```

---

# 54. 不要修改 Screenshot Similarity

Phase 3 已完成：

```text
similar screenshot
    ↓
discard
```

不要因为 SQLite 改造而重新实现 similarity。

---

# 55. 不要修改 Screenshot Naming / Storage

截图文件仍然按照当前 Phase 2/3 的规则保存。

SQLite 只记录：

```text
image_path
```

不要改变现有 screenshot naming convention。

---

# 56. Error Recovery 原则

整个 Phase 6 必须遵循：

```text
Data Safety > Convenience
```

优先级：

```text
1. 数据不丢
2. 状态一致
3. Crash 可恢复
4. Screenshot 不被 AI 阻塞
5. AI Queue 不被 DB 小故障永久破坏
6. 性能
```

---

# 57. 最小改动原则

不要为了 SQLite：

* 重写 Recorder
* 重写 Worker
* 重写 Queue
* 重写 Renderer
* 重写 IPC
* 重写 Config
* 重写 Screenshot System

如果当前接口可以保留：

> 保留。

如果必须改变：

> 做最小变化。

---

# 58. Implementation Order

严格按照以下顺序：

## Step 1

检查当前项目。

运行：

```bash
npm test
```

确认：

```text
61 / 61 PASS
```

---

## Step 2

检查：

```text
Electron version
Node version
package.json
```

按第 5 节确定 SQLite driver：先实测 `node:sqlite` 在系统 Node 与 Electron Main Process 中均可用，可用则直接采用；不可用再降级 better-sqlite3，并落实测试的双 ABI 策略。

---

## Step 3

建立：

```text
src/main/db/
```

---

## Step 4

实现：

```text
database.js
schema.js
migrations.js
```

---

## Step 5

实现：

```text
ActivityRepository
AIJobRepository
```

---

## Step 6

为 SQLite Repository 编写单元测试。

---

## Step 7

修改 Recorder / Queue / Worker 使用 Repository。

---

## Step 8

移除 Activity / AI Job 的 JSON persistence。

注意：

> 不迁移旧 JSON。

---

## Step 9

实现 Crash Recovery。

---

## Step 10

修复 Main Process lifecycle。

---

## Step 11

验证 Renderer / IPC。

---

## Step 12

运行全部测试。

---

## Step 13

真实 Electron Smoke Test。

---

## Step 14

Force Kill Recovery Test。

---

## Step 15

最终检查 SQLite integrity。

---

# 59. Definition of Done

Phase 6 只有满足以下条件才算完成。

### Storage

```text
SQLite successfully initialized
```

### Activity

```text
Activity stored in SQLite
```

### AI Job

```text
AI Jobs stored in SQLite
```

### Structured Output

```text
activity
summary
category
project
keywords
confidence
```

全部正确保存。

### Screenshot

```text
Screenshot remains filesystem file
```

### Queue

```text
Existing Queue behavior preserved
```

### Recovery

```text
PROCESSING → PENDING
```

恢复机制正常。

### Reanalysis

正常。

### Transaction

Activity + Job 不允许出现半成功状态。

### JSON

正常业务流程：

```text
NO JSON persistence
```

并且：

```text
NO JSON migration
```

### Tests

原有：

```text
61 / 61 PASS
```

并新增 SQLite tests。

### Integrity

```sql
PRAGMA integrity_check;
```

结果：

```text
ok
```

### Electron

SQLite native module 在真实 Electron Main Process 中可以正常加载。

### Real-world

真实 Electron：

```text
Screenshot
→ Activity
→ AI Job
→ AI
→ Structured Result
→ SQLite
```

完整成功。

---

# 60. Final Report

完成后不要只告诉我：

```text
Done
```

必须输出详细报告。

格式：

## 1. Baseline

```text
Before:
61 / 61 PASS
```

## 2. SQLite Driver

说明：

```text
driver
version
Electron compatibility
```

## 3. Database Architecture

说明：

```text
database.js
schema.js
migrations.js
repositories
```

## 4. Schema

展示：

```text
activities
ai_jobs
```

以及关键 indexes。

## 5. Code Changes

列出：

```text
新增文件
修改文件
删除文件
```

以及每个文件的职责。

## 6. JSON Handling

必须明确写：

```text
Legacy JSON migration: NOT IMPLEMENTED
Legacy JSON import: NOT IMPLEMENTED
Legacy JSON compatibility: NOT REQUIRED
Normal JSON persistence: REMOVED
```

## 7. Transaction

说明：

```text
Activity + AI Job transaction behavior
```

## 8. Crash Recovery

说明：

```text
PROCESSING
RETRYING
```

如何恢复。

## 9. Tests

展示：

```text
Old tests:
XX / XX PASS

New SQLite tests:
XX / XX PASS

Total:
XX / XX PASS
```

不要伪造数字。

## 10. Real Electron Smoke Test

说明：

```text
Electron
Screenshot
Activity
AI Job
Ollama
Structured Output
SQLite
```

是否完整通过。

## 11. Force Kill Test

说明：

```text
Before kill:
PROCESSING

After restart:
PENDING

Final:
COMPLETED
```

如果实际结果不同，必须如实说明。

## 12. SQLite Integrity

展示：

```text
PRAGMA integrity_check = ok
```

## 13. Known Issues

列出真实存在的问题。

不要隐藏问题。

## 14. Non-goals

明确确认本阶段没有实现：

```text
Timeline
Dashboard
Statistics
Diary
Memory
RAG
Vector DB
Ask My Life
Agent
Semantic Search
```

---

# 61. 最重要的最终原则

整个 Phase 6 请牢记：

```text
SQLite Primary Storage
Filesystem Screenshot Storage
No Legacy Migration
No JSON Dual Write
No ORM
No Architecture Rewrite
No AI Rewrite
No Scope Creep
```

最终目标不是“把 JSON 改成 SQLite”这么简单。

真正目标是：

> **建立一个可靠、可恢复、可扩展的本地 SQLite 数据基础，为后续 Timeline / Statistics / Memory / RAG / Ask My Life / Personal Agent 提供稳定的数据层。**

但是：

> **这些未来功能本阶段全部不要实现。**

现在只把 Storage Foundation 做扎实。
