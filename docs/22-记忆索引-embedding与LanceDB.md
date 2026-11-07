# 记忆索引：本地 Embedding 与 LanceDB

Phase 10 把三层记忆（20 秒 Activity / 10 分钟 Block / 1 天 Diary）变成向量，写进本地的
LanceDB，跑通「记忆 → embedding → 向量库」这条链路。检索 UI 与问答留给 Phase 11。

## 1. 目标与边界

**本阶段做：**

- 三层记忆的 embedding 文本构造（Text Builder）；
- 本地 Embedding 模型接入（Ollama `/api/embed`，默认 `bge-m3`）；
- 批量扫描、批量嵌入与 `embedding_status` 状态管理；
- LanceDB 三张向量表 + 按数据量阈值自动建索引；
- 基础 vector search（最简实现，供验证用）。

**本阶段不做（留给 Phase 11）：**

- 检索 UI、Ask & Answer；
- 跨三张表的聚合检索；
- 索引调参、全文检索混合查询；
- 换模型后的全量重建流程（只预留了 `embedding_model` / `embedding_version` 字段与手动重置入口）。

**三条铁律：**

1. **SQLite 是唯一事实来源**。LanceDB 只是可随时重建的语义索引，坏了就重建，不承载业务状态：
   删掉向量库目录、把状态重置为 `PENDING`，服务会重新嵌入，SQLite 的原始数据一行不动。
2. **Embedding 绝不阻塞截图链路**。模型缺失 / Ollama 挂掉时，截图、分析、区块汇总、日记照常工作，
   记录保持 `PENDING`，模型恢复后自动补齐。原生模块装不上也只降级，不影响启动。
3. **三层记忆不混数据**。粒度、字段、更新频率都不同，分别建表、分别重建。

## 2. 三层记忆 → 三张向量表

| 表名 | 数据源 | 行 ID 格式 | 预估量级（1 年） |
| --- | --- | --- | --- |
| `activity_vectors` | `activities` | `activity:{activities.id}` | ~157 万条 |
| `block_vectors` | `time_blocks` | `block:{block_start}` | ~14.4 万条 |
| `diary_vectors` | `diaries` | `diary:{day}` | ~365 条 |

存储位置：`app.getPath('userData')/lancedb/`（Electron 的用户数据目录，与 `<LIFELENS_DIR>` 下的
SQLite 是两处；SQLite 才是事实来源，所以向量库不进备份也不影响数据安全）。

**三张表字段完全一致**（便于将来的聚合层统一处理）：

| 字段 | 说明 |
| --- | --- |
| `id` | 行 ID，见上表格式，upsert 的覆盖键 |
| `source_id` | 对应 SQLite 的业务键（`activities.id` / `block_start` / `day`） |
| `text` | 实际用于 embedding 的文本（Text Builder 的产物，便于排查召回问题） |
| `vector` | embedding 向量，维度由第一批数据确定 |
| `captured_at` | 原始时间（activity）/ `block_start`（block）/ `day`（diary） |
| `date` | 本地日期 `YYYY-MM-DD`（取 `captured_at` 前 10 字符，与 SQLite 同口径） |
| `project` / `category` | 过滤用的下推列；日记没有这两列，写 `null` |
| `embedding_model` / `embedding_version` | 生成这条向量的模型与版本（如 `bge-m3` / `v1`） |
| `created_at` | 写入时间 |

**为什么不用一张表**：三层数据量差 4 个数量级（157 万 vs 365），混表后 diary / block 的查询与重建会被
activity 拖累；三层字段差异大，单表要么塞 JSON 元数据列（无法列下推过滤），要么大量 NULL；
而且与现有 Repository 分层（各管一表）一致，换模型时可以逐表重建、互不影响。

注意：**不要用 `metadata` JSON 列装元数据**——LanceDB 的过滤是列下推的，扁平列才能参与过滤。

## 3. 文本构造（Text Builder）

核心原则：**嵌入「构造过的语义文本」，不是 `JSON.stringify`，也不是单字段**。
三层各有一个 Builder（`src/main/embedding/textBuilder/`），共同点是空字段不产生空行、
数组字段用顿号或分号连接，全部为空时返回空串。

| Builder | 输入 | 文本形状 |
| --- | --- | --- |
| `activityText.js` | activities 行 | 项目 / 当前活动 / 摘要 / 关键词 |
| `blockText.js` | time_blocks 行 | 项目 / 类型 / 描述 / 软件 / 待办 |
| `diaryText.js` | diaries 行 | 日期 / 总结 / 主要事项 |

示例（Activity）：

```text
项目：Life Lens
当前活动：开发 SQLite 数据层
正在实现 ActivityRepository 与事务封装，关注事务一致性、AI Job 关联与崩溃恢复。
关键词：SQLite、Repository、Transaction、AI Job
```

三层回答的问题不同：activity 回答「我当时具体在干什么」（最细粒度），block 回答「这 10 分钟主要
做了什么」，diary 回答「这一天整体发生了什么」（长期记忆节点）。

`text` 会一并写进向量表：将来召回结果不对时，可以直接看是文本构造的问题还是检索的问题。

**空文本 = 永久失败**：Builder 返回空串表示这条记录没有可嵌入的内容（例如分析结果里一个字段都没有），
服务会把它标记为 `FAILED`，不写入空向量，也不影响同批其他记录。

## 4. EmbeddingProvider

Qwen3-VL 是视觉理解 + 文本生成模型，**不能拿来做 embedding**，所以新增独立 Provider：

```js
// src/main/embedding/localProvider.js
provider.dimension      // 向量维度，建表 / 建索引必需；0 表示还没探测出来
provider.model          // 'bge-m3'
provider.version        // 'v1'
provider.maxBatchSize   // 单批上限，默认 64
provider.health()                        // /api/tags，不触发推理
provider.embedText(text, { timeoutMs })  // -> number[]
provider.embedTexts(texts, { timeoutMs })// -> number[][]，超过 maxBatchSize 时内部切块
```

与视觉 / 汇总 Provider 一样是鸭子类型契约（不写抽象基类）：`EmbeddingService` 只依赖上面这几个成员，
换模型时换一个 Provider 实例即可，LanceDB 结构不用动。

细节：

- 走 Ollama 的 `/api/embed`（批量入口），请求体 `{ model, input: string[], truncate: true }`；
- **维度不硬编码**：配置里给 `LIFELENS_EMBEDDING_DIMENSION` 就用配置值，否则第一次真实调用的返回值
  就是维度，之后所有批次的维度必须一致（不一致直接抛 `INVALID_RESULT`，说明模型被换了）；
- 逐条校验返回：条数必须与请求一致、不能是空向量、必须全是有限数字；
- 错误映射沿用 AI 层的错误码：模型没拉取 → `MODEL_NOT_FOUND`，连不上 → `OLLAMA_UNAVAILABLE`，
  超时 → `AI_TIMEOUT`，返回不合法 → `INVALID_RESULT`。

## 5. 状态与触发

### 5.1 Migration v4（三张表各加三列）

```sql
ALTER TABLE activities ADD COLUMN embedding_status  TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE activities ADD COLUMN embedding_model   TEXT;
ALTER TABLE activities ADD COLUMN embedding_version TEXT;
CREATE INDEX idx_activities_embedding_status ON activities(embedding_status);
-- time_blocks / diaries 同样处理
```

状态列带默认值 `PENDING`，所以老库升级后**存量记录自动进入待嵌入队列**（`database.test.js` 的
Test 3 覆盖了这一点）。

### 5.2 状态机

```text
PENDING ──→ PROCESSING ──→ COMPLETED
   ↑             │
   │             ├─ 临时故障（模型掉线 / 写入失败）→ 退回 PENDING，下一轮重试
   └─────────────┘
                 └─ 构建不出文本 → FAILED（永久，只能手动重置）
```

- **启动补偿**：进程崩溃遗留的 `PROCESSING`，启动时一律退回 `PENDING`（与 `ai_jobs` 的恢复策略同口径）。
- **手动重置**：`EmbeddingSourceRepository.resetFailed()`（FAILED 重试）与 `resetAll()`
  （删库后全量重建）。两者都只改状态列，不碰任何原始数据。

**与 Phase 10 计划文档的差异（设计取舍）**：计划里的状态机写了「重试超限（3 次）→ FAILED」，
但 migration 只加三列，没有重试计数列。这里的选择是：**临时故障不计数、无限重试**（每轮扫描都会重试，
代价只是多几次 HTTP 调用；模型恢复后自动补齐），`FAILED` 只留给「这条记录永远构建不出文本」的
永久性情况。这样既不需要加列，也不会出现「重试次数用尽后必须人工干预」的死角。

### 5.3 EmbeddingService 的触发方式

**不新建队列表**：`embedding_status = 'PENDING'` 就是待办池。

每一轮扫描（默认间隔 60 秒，`setInterval` 由 `setTimeout` 链实现，与区块汇总同构）：

1. 三层各取一批待办：`分析已完成 AND embedding_status = 'PENDING'`
   （activity 需 `analysis_status = 'COMPLETED'`；block / diary 需 `status = 'COMPLETED'`），
   按时间从旧到新，先补历史存量；
2. 三层都没有待办 → 直接返回，**不去打扰 Ollama**；
3. 有待办 → 健康检查；模型不可用 → 整轮跳过，不改变任何状态（记录留在 `PENDING`）；
4. 可用 → 逐层处理：标记 `PROCESSING` → 构建文本 → 批量嵌入 → 按 `id` upsert 进 LanceDB →
   回写 `COMPLETED` + `embedding_model` / `embedding_version` → 行数到阈值时 `ensureIndex`；
5. 单条失败不影响同批其他记录（空文本单独标 `FAILED`）；整批失败（模型报错 / 写入失败）时这一批
   退回 `PENDING`，下一轮重试。

一轮最多连续处理 `maxBatchesPerScan`（默认 10）批，避免首次启动把 Ollama 一次性灌爆，
同时让存量补齐与删库重建不必等几十个轮次。

**降级日志**（走 `JobEventLog`，界面的事件日志里能看到）：

| 事件 | 触发时机 |
| --- | --- |
| `EMBEDDING_RECOVERED` | 启动补偿退回了若干 `PROCESSING` |
| `EMBEDDING_OFFLINE` / `EMBEDDING_ONLINE` | 模型可用性翻转（不是每轮都记） |
| `EMBEDDING_SCAN` | 一轮里确实嵌入成功 / 失败过若干条 |
| `EMBEDDING_ERROR` | 批次失败退回 `PENDING`，或服务装配失败降级 |

## 6. 向量索引策略

第一阶段就内置索引能力，但**不立刻建索引**——按数据量阈值自动启用：

- 行数 < 5000：暴力扫描（brute-force），延迟可接受，小数据集上 ANN 反而不准；
- 行数 ≥ 5000：批量写入后自动创建 `IVF_PQ`（`numPartitions = sqrt(rows)`，
  `numSubVectors = dim / 64` 向下取到能整除维度的因子；1024 维 → 16，768 维 → 12）。

`ensureIndex` 每次批量写入后都会调用，但只有「行数达标 + 还没有向量索引」时才真正建，其余情况是空操作；
建索引失败只记日志，不影响写入结果（索引只是加速手段）。

搜索侧对上层透明：有索引走 ANN，没有索引走暴力扫描。实测 LanceDB 训练 PQ 至少需要 256 行，
生产阈值 5000 远高于这个下限，不会命中。

## 7. 仓储分层

```
EmbeddingService            编排：扫描、批量、状态流转、启动补偿
├── EmbeddingSourceRepository   SQLite 侧：待办查询与 embedding_status 回写（SQL 只在这里）
└── MemoryVectorRepository      LanceDB 侧：upsert / delete / find / count / ensureIndex / search
    └── LanceStore              连接与表句柄缓存；原生模块按需加载（import 失败只抛错）
```

- `EmbeddingSourceRepository` 用一份 `LAYERS` 配置消掉三层的差异（表名 / 主键 / 时间列 / 行 ID 前缀 /
  「什么算分析完成」/ 文本构造），三张表各实例化一个；
- `MemoryVectorRepository` 也是三张表各一个实例；`upsert` 走 LanceDB 的
  `mergeInsert('id')`，同一条记录重复嵌入只会覆盖同一行（幂等）；
- 跨表聚合检索是 Phase 11 的事，本阶段 `search()` 只查单表，返回原始行（含 `_distance`）。

`search(vector, { limit, filter })` 的 `filter` 是 LanceDB 的下推条件，例如
`project = 'Life Lens'`、`category = 'coding'`；`date` 这类列也可以直接比较。

## 8. 装配、配置与依赖

`main.js` 里的装配顺序（`createEmbedding()`）：

1. 建 `LocalEmbeddingProvider`（模型 / 维度 / 超时来自配置）；
2. 建 `LanceStore` 并 `open()` 一次——原生模块或目录有问题在这里就降级，不会拖到第一次写入；
3. 建三个 `EmbeddingSourceRepository`（SQLite 侧）与三个 `MemoryVectorRepository`（LanceDB 侧）；
4. 建 `EmbeddingService`，`start()` 时先做启动补偿，再立刻扫一轮，之后按间隔持续扫描；
5. 退出时：`stop()` → `flush()`（等在途批次收尾）→ `LanceStore.close()` → 关 SQLite。

任何一步失败都只记 `EMBEDDING_ERROR` 日志并把 `embedding` 置空，**应用照常启动**（铁律二）。

配置项（`src/main/config.js`，前缀 `LIFELENS_`，详见 [07-配置与运行](07-配置与运行.md)）：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `LIFELENS_EMBEDDING_MODEL` | `bge-m3` | embedding 模型，与视觉 / 汇总模型相互独立 |
| `LIFELENS_EMBEDDING_DIMENSION` | `0` | `0` = 第一次调用后自动探测 |
| `LIFELENS_EMBEDDING_TIMEOUT_MS` | `60000` | 单次 `/api/embed` 请求超时 |
| `LIFELENS_EMBEDDING_BATCH_SIZE` | `32` | 一批嵌入多少条 |
| `LIFELENS_EMBEDDING_SCAN_INTERVAL_MS` | `60000` | 扫描间隔 |
| `LIFELENS_EMBEDDING_MAX_BATCHES` | `10` | 一轮扫描最多连续处理多少批 |

依赖：`@lancedb/lancedb`（napi 预编译包，Node 22.23.2 与 Electron 44 内置的 Node 24.20.0 都实测可加载）。

## 9. 验证记录

### 9.1 自动化测试

```text
node --test test/embedding.test.js               15 / 15
node --test test/memoryVectorRepository.test.js   6 / 6
npm test                                        241 / 241
```

覆盖范围：文本构造与空值语义、Provider 请求形状 / 内部切块 / 维度不一致 / 错误码映射、
三层状态流转、模型不可用时保持 `PENDING`、启动补偿、空文本 `FAILED`、临时故障退回 `PENDING`、
重复嵌入幂等、一轮多批上限；真实 LanceDB 的建表 / upsert / delete / filter / search /
阈值建索引；以及端到端「SQLite 完成数 = 向量行数」与「删库 + 重置后全量重建」。

### 9.2 真实 Electron 冒烟（假 Ollama）

目的：验证主进程装配、migration v4、LanceDB 目录与三张表的落盘，不依赖真实模型。

```powershell
# 隔离数据目录 + 假 Ollama（/api/tags 返回模型列表，/api/embed 返回 8 维假向量）
$env:LIFELENS_DIR = <临时目录>; $env:LIFELENS_AUTOSTART = 0
$env:LIFELENS_OLLAMA_HOST = http://127.0.0.1:11500
$env:LIFELENS_EMBEDDING_MODEL = fake-embed:latest
& .\node_modules\electron\dist\electron.exe --user-data-dir=<临时目录> .
```

预置数据：2 条已分析 Activity + 1 条待分析 Activity + 1 个已汇总 Block + 1 篇已完成 Diary。

```text
[DB] Schema version: 4
[LanceDB] LanceDB opened: <userData>\lancedb
EMBEDDING_ONLINE   Embedding 模型可用：fake-embed:latest
LanceDB table created: activity_vectors / block_vectors / diary_vectors
EMBEDDING_SCAN     本轮嵌入完成 4 条，失败 0 条（fake-embed:latest）

向量库：activity_vectors 2 行（activity:1, activity:2）、block_vectors 1 行、diary_vectors 1 行
取样文本：项目：Life Lens / 日期：2026-09-17
SQLite：activities COMPLETED=2 PENDING=1、time_blocks COMPLETED=1、diaries COMPLETED=1
```

待分析的截图保持 `PENDING`，不占用向量库——与「分析完成才嵌入」的口径一致。

同一套流程把模型名改成不存在的 `missing-embed:latest` 再跑一次（验收标准 2）：

```text
[DB] Schema version: 4
[LanceDB] LanceDB opened: <userData>\lancedb
EMBEDDING_OFFLINE  Embedding 模型不可用（missing-embed:latest）：未知原因；本轮跳过，记录保持 PENDING
向量库：一张表都没建
SQLite：activities PENDING=3、time_blocks PENDING=1、diaries PENDING=1
```

应用照常启动、SQLite 照常工作、截图链路不受影响，记录留在 `PENDING` 等模型恢复。

### 9.3 这轮冒烟抓到的问题

- **日记行全 NULL 的 `project` / `category` 让 LanceDB 建表失败**：
  `Failed to infer data type for field project at row 0`。日记表没有项目与分类，第一批数据里这两列
  全是 `null`，Arrow 推断不出类型。修法是在写向量行时统一用空串（过滤侧 `project = ''` 表示没有项目），
  并在服务层补了一条断言防回归。纯内存假仓储的单测发现不了这个问题——只有真实 LanceDB 会暴露。
- 同一次冒烟还确认了「原生模块在 Electron 里能加载」（`LanceStore.open()` 成功）这一条前置假设。

### 9.4 真实 Ollama（bge-m3）

模型选型先验证后固化：`bge-m3` 实测 1024 维、中文区分度可用，作为首选；`nomic-embed-text`（768 维）保留为备选。
Provider 的维度来自第一次真实调用，所以换模型不需要改 LanceDB 结构，只需要清表重建（第 7 节）。

本机实测（Windows + 本机 Ollama，模型 `bge-m3:latest`，返回向量已归一化，下表点积即余弦）：

| 观测项 | 实测值 |
| --- | --- |
| 向量维度 | 1024（与 `embeddingDimension = 0` 的探测结果一致） |
| 冷启动首次调用 | 约 12.5 s（含模型加载），之后模型常驻内存 |
| 单条嵌入（预热后） | 约 32 ms |
| 批 32 吞吐 | 约 183 条/秒 |
| 批 64 吞吐 | 约 210 条/秒 |
| 批 128 吞吐 | 约 231 条/秒 |

中文语义区分度（同一批内互比，余弦越大越相近）：

```text
cos(开发 SQLite 数据层, 调试 SQLite 数据层) = 0.5507
cos(开发 SQLite 数据层, 今天去公园散步)     = 0.3835
cos(开发 SQLite 数据层, 晚上做饭)           = 0.3495
```

结论：相近语义明显高于无关语义，区分度可用；批 32 已接近吞吐饱和（32 → 64 只提升约 15%，
64 → 128 再提升约 10%，但内存占用与首包延迟代价更大），因此保持默认 `LIFELENS_EMBEDDING_BATCH_SIZE = 32`。

真实模型下的端到端冒烟（数据与流程同 9.2，只把 Provider 换成真实 Ollama）：

```text
[DB] Schema version: 4
[LanceDB] LanceDB opened: <userData>\lancedb
EMBEDDING_ONLINE   Embedding 模型可用：bge-m3
LanceDB table created: activity_vectors / block_vectors / diary_vectors
EMBEDDING_SCAN     本轮嵌入完成 4 条，失败 0 条（bge-m3）

向量库：activity_vectors 2 行（维度 1024、model=bge-m3、version=v1）
        block_vectors 1 行、diary_vectors 1 行
SQLite：activities COMPLETED=2 PENDING=1、time_blocks COMPLETED=1、diaries COMPLETED=1
```

「向量行数 = SQLite `COMPLETED` 数」在真实模型下同样成立；待分析截图保持 `PENDING`，不写入向量。

## 10. 不做的事与留给 Phase 11

```text
检索 UI / Ask & Answer / 跨三表聚合检索 / 索引参数调优 / 全文检索混合 /
换模型后的自动全量重建 / 向量库的删除同步（activity 被删时删向量） : NOT IMPLEMENTED
```

留给 Phase 11 的主要几条：

- 聚合检索层：三张表各查一次再合并排序（`search()` 已经是统一的形状）；
- 查询向量要走同一个 Provider（`embedText`），并复用同一份维度校验；
- 记录被删除 / 文本变化时的向量失效策略（本阶段只做新增与幂等覆盖）；
- 检索 UI 与问答链路。
