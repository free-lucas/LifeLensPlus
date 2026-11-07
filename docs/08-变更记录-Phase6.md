# 变更记录：Phase 6（SQLite 存储架构）

目标：把 Life Lens 从 JSON 文件存储切换为 SQLite 本地数据库存储。
不迁移旧数据、不做 JSON 双写、不引入 ORM、不改写架构。

## 1. 新增文件

### 数据层 `src/main/db/`

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `database.js` | 77 | `openDatabase`（mkdir → PRAGMA → migration → 失败关闭再抛）、`closeDatabase`、`withTransaction`（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`）、`DB_FILE_NAME` |
| `schema.js` | 74 | `SCHEMA_VERSION = 1`、`activities` / `ai_jobs` 建表语句、4 个索引、`MIGRATIONS` |
| `migrations.js` | 44 | `PRAGMA user_version` 驱动的 runner；每版一个事务（DDL + 版本号一起提交）；版本高于支持值时抛错 |
| `jobRow.js` | 54 | `ai_jobs` 列清单、`INSERT_JOB_SQL`、`jobValues()`（payload → JSON 文本、error 拆列、可空值收敛为 `null`） |
| `repositories/ActivityRepository.js` | 213 | `createActivity` / `insertActivityWithJob` / `updateAnalysis` / `getByScreenshotId` / `findIdByScreenshotId` / `listRecent` / `listPendingRecords` / `loadStats`；行 ↔ Activity Record 映射 |
| `repositories/AIJobRepository.js` | 135 | `load()` / `save(jobs)`：id 主键 upsert 全量快照 + `DELETE ... NOT IN` 清理，终态裁剪在同一事务内；`_activityId()` 关联 activities |

### 测试

| 文件 | 行数 | 用例 |
| --- | --- | --- |
| `test/database.test.js` | 137 | 5 个：建库建表、user_version、版本保护、integrity_check、外键约束 |
| `test/activityRepository.test.js` | 293 | 11 个：写入字段、结构化字段往返、Unicode、时间格式、1000 条记录、排序、回填语义、统计 |
| `test/aiJobRepository.test.js` | 159 | 3 个：六种状态落库、快照往返、终态裁剪 |
| `test/sqliteConsistency.test.js` | 175 | 4 个：事务回滚、写库失败删截图、崩溃恢复、重新分析 |

### 文档

`docs/` 目录（架构总览、数据库设计、迁移与版本、数据流与事务、AI 任务队列、测试与验证、配置与运行、本变更记录）。

## 2. 修改文件

| 文件 | 变更 | 原因 |
| --- | --- | --- |
| `src/main/store.js` | 删除全部 JSON 读写，只保留 `monthDir` / `imageDir` / `saveImage`（-169 行） | 结构化数据搬到 SQLite；文件系统只负责图片 |
| `src/main/config.js` | 删除 `jobsFile` 与 `LIFELENS_JOBS_FILE` | 任务队列固定存在 `lifelens.db` |
| `src/main/recorder.js` | 构造参数改为 `{ store, activities, config, onEvent, aiQueue, capture, log }`；`loadStats` 走 repository；`tick` 改用 `enqueueWithActivity`（Activity + Job 同事务）；新增 `discardScreenshot()`；`handleAnalysisResult/Failure` 走 `activities.updateAnalysis`；record 去掉 `timestamp` / `sentences` / `summary` 字段 | 写入路径统一到数据层；保证「记录 + 任务」原子性 |
| `src/main/ai/AIJobQueueService.js` | 构造函数新增 `activities`；抽出 `_dedupe()`；新增 `enqueueWithActivity()`（对外签名与 `enqueue()` 同构） | 截图路径需要把 Activity 与 Job 放进同一个事务 |
| `src/main/main.js` | 启动顺序：`openDatabase` → repositories → Queue → Recorder → Worker；DB 初始化失败弹窗并退出；`lifelens:recent` 走 `activities.listRecent`；退出时在 Worker/Queue 之后 `closeDatabase(db)` | 建立唯一的存储入口，保证退出时不会再有写库 |
| `src/renderer/renderer.js` | `renderAnalysisBody` 去掉 `sentences` 回退分支 | 新数据来自 SQLite，不再有旧字段语义 |
| `test/support.js` | 新增 `openTestDb` / `trackDb` / `closeTestDbs`（先关库再删目录）、`makeQueue` 支持复用已有 `db/activities`（模拟重启）、`fakeProvider` 返回结构化结果、导出 `FAKE_ANALYSIS` | 让原有测试可以跑在临时 SQLite 上 |
| `test/jobQueue.test.js`、`aiWorker.test.js`、`recorderDecoupling.test.js`、`recovery.test.js`、`structuredOutput.test.js` | 改为通过 repository + 临时数据库构造依赖；断言与用例数保持不变（12 / 10 / 5 / 7 / 22） | 原有行为不能退化 |
| `README.md` | 重写存储相关章节：SQLite 表结构、目录结构、退出与启动顺序、测试与已知限制 | 原文档描述的是 JSON 存储，已过时 |

## 3. 删除文件

| 文件 | 原因 |
| --- | --- |
| `src/main/ai/AIJobRepository.js` | JSON 版任务持久化，被 `src/main/db/repositories/AIJobRepository.js` 取代 |
| `test/store.test.js` | 覆盖的是已删除的 JSON 读写（5 个用例）；能力由 `test/activityRepository.test.js` 承接 |

## 4. 行为变化一览

| 方面 | Phase 6 之前 | Phase 6 之后 |
| --- | --- | --- |
| 活动记录 | 每小时的 `YYYY-MM-DD_HH.json` | `activities` 表 |
| AI 任务 | `ai-jobs.json` | `ai_jobs` 表 |
| 记录 + 任务原子性 | 两次文件写入，可能半成功 | 单事务，整体提交或整体回滚 |
| 崩溃恢复 | 读 JSON 后把 PROCESSING/RETRYING 置回 PENDING | 同一语义，改为读 `ai_jobs` |
| 回填 | `Object.assign` 到记录对象再整文件重写 | 按 patch 字段生成 UPDATE |
| 终态裁剪 | 写 JSON 前裁剪内存数组 | 在同一事务里 `DELETE ... NOT IN` |
| 旧 JSON | 唯一的正式数据源 | 不读取、不导入、不依赖 |