# 变更记录：Phase 10 — 本地 Embedding 与 LanceDB 记忆索引

## 1. 这一阶段做了什么

**A. 三层 embedding 状态（schema v4）**

- `activities` / `time_blocks` / `diaries` 各加三列：`embedding_status`（默认 `PENDING`）、
  `embedding_model`、`embedding_version`，并各加一条 `embedding_status` 索引；
- 状态列带默认值，所以老库升级后**存量记录自动进入待嵌入队列**，不需要单独的数据迁移脚本；
- 状态机：`PENDING → PROCESSING → COMPLETED`；临时故障退回 `PENDING`（下一轮重试），
  只有「构建不出文本」才是永久的 `FAILED`；
- 启动补偿：崩溃遗留的 `PROCESSING` 一律退回 `PENDING`。

**B. 本地 embedding（Ollama `/api/embed`）**

- 新增 `LocalEmbeddingProvider`：批量调用、Provider 内部按 `maxBatchSize` 切块、
  维度自动探测并在后续批次校验一致性、错误映射到既有 AI 错误码；
- 默认模型 `bge-m3`，但**不在代码里写死维度**（`LIFELENS_EMBEDDING_DIMENSION` 给 0 就探测）；
- 模型缺失 / Ollama 挂掉时整轮跳过，记录留在 `PENDING`，恢复后自动补齐。

**C. 三个 Text Builder**

- `activityText` / `blockText` / `diaryText`：把结构化结果拼成「语义文本」而不是 JSON，
  空字段不产生空行，全部为空时返回空串（服务据此标记 `FAILED`）；
- 生成的 `text` 一并写进向量表，便于排查召回问题。

**D. LanceDB 三张向量表 + 仓储分层**

- `activity_vectors` / `block_vectors` / `diary_vectors`，存储位置 `app.getPath('userData')/lancedb/`；
- `MemoryVectorRepository`：`upsert`（按 `id` 覆盖，幂等）/ `deleteBySource` / `findBySource` /
  `count` / `ensureIndex` / `search`（含列下推过滤）；
- `LanceStore`：连接与表句柄缓存，原生模块**按需加载**，装不上只降级；
- 索引策略：行数 `< 5000` 走暴力扫描，`≥ 5000` 自动建 `IVF_PQ`（`numPartitions = sqrt(rows)`，
  `numSubVectors = dim / 64` 向下取到能整除维度的因子）。

**E. 没动的东西**

- 截图链路、AI 队列、区块汇总、日记生成与所有界面一行没改；
- `activities` / `ai_jobs` / `time_blocks` / `diaries` 的**已有列一个没动**（只新增三列）；
- Phase 7 的 Timeline、Phase 8 的区块口径、Phase 9 的日记与看板口径都没变。

## 2. 修改文件

### 新增

| 文件 | 内容 |
| --- | --- |
| `src/main/embedding/localProvider.js` | `LocalEmbeddingProvider`：Ollama `/api/embed`、切块、维度探测与校验、错误映射 |
| `src/main/embedding/textBuilder/activityText.js` | 20 秒 Activity 的 embedding 文本 |
| `src/main/embedding/textBuilder/blockText.js` | 10 分钟 Block 的 embedding 文本 |
| `src/main/embedding/textBuilder/diaryText.js` | 1 天 Diary 的 embedding 文本 |
| `src/main/embedding/textBuilder/lines.js` | 三个 Builder 共用的「标签：内容」与数组拼接 |
| `src/main/embedding/EmbeddingSourceRepository.js` | 三层待办查询与 `embedding_status` 回写（SQL 只在这里）、启动补偿、手动重置 |
| `src/main/embedding/EmbeddingService.js` | 扫描 → 批量嵌入 → 写向量库 → 回写状态的编排、健康检查降级、启动补偿 |
| `src/main/embedding/MemoryVectorRepository.js` | 一张向量表的 upsert / delete / find / count / ensureIndex / search |
| `src/main/embedding/lanceStore.js` | LanceDB 连接与表句柄封装，原生模块按需加载 |
| `test/embedding.test.js` | 15 例：文本构造、Provider（打桩 fetch）、三层状态流转、降级、启动补偿、幂等、多批上限 |
| `test/memoryVectorRepository.test.js` | 6 例：真实 LanceDB 的建表 / upsert / delete / filter / search / 阈值建索引 / 端到端重建 |
| `docs/22-记忆索引-embedding与LanceDB.md` | 本阶段的功能与设计文档 |

### 修改

| 文件 | 变更 |
| --- | --- |
| `src/main/db/schema.js` | `SCHEMA_VERSION` 3 → 4；新增 `EMBEDDING_STATEMENTS`（三表各三列 + 索引）与 version 4 migration |
| `src/main/ai/jobEventLog.js` | 新增事件 `EMBEDDING_SCAN` / `EMBEDDING_RECOVERED` / `EMBEDDING_OFFLINE` / `EMBEDDING_ONLINE` / `EMBEDDING_ERROR` |
| `src/main/config.js` | 新增 `embeddingModel` / `embeddingDimension` / `embeddingTimeoutMs` / `embeddingBatchSize` / `embeddingScanIntervalMs` / `embeddingMaxBatchesPerScan` 及对应环境变量 |
| `src/main/main.js` | 新增 `createEmbedding()` 装配与降级分支；`embedding.start()` 纳入启动顺序，`stop()` / `flush()` / `LanceStore.close()` 纳入退出顺序 |
| `test/support.js` | 新增 `fakeEmbeddingProvider`（供两个 embedding 测试文件共用） |
| `test/database.test.js` | Test 3 断言 `SCHEMA_VERSION = 4`，并校验三列与存量记录默认为 `PENDING` |
| `package.json` / `package-lock.json` | 新增运行时依赖 `@lancedb/lancedb`（首个非 Electron 的运行时依赖） |

## 3. 关键设计决策

1. **不加重试计数列**。计划文档的状态机写了「重试超限 3 次 → FAILED」，但 migration 只有三列。
   这里选择「临时故障无限重试、`FAILED` 只表示永久性失败」：少一列、少一套计数逻辑，也不会出现
   「次数用尽后必须人工干预」的死角。
2. **`project` / `category` 写空串而不是 `null`**。LanceDB 建表时要从第一批数据推断 Arrow 类型，
   全 `NULL` 的列推断不出来（日记表必然如此）。冒烟验证抓到了这个真实的失败，见第 5 节。
3. **原生模块按需加载**。`@lancedb/lancedb` 只在 `LanceStore.open()` 里 `require`，
   装不上 / ABI 不兼容时只让 embedding 降级，不影响应用启动（铁律二）。
4. **一轮最多连续处理 10 批**。只做一批时，存量补齐与「删库重建」要等几十个轮次；
   全速跑又会把 Ollama 一次性灌满，所以取中间值，并做成可配置。
5. **状态回写按批放在事务里**（`_updateBatch`），与仓库层其它写入路径一致：一次 fsync，
   也不会留下改了一半的批次。

## 4. 数据流

```text
截图 -> Activity 分析完成 ─┐
10 分钟区块汇总完成 ──────┼─> embedding_status = PENDING（SQLite 就是待办池）
日记生成完成 ─────────────┘
                                  │ 每 60s 扫描（一次最多 10 批 × 32 条）
                                  ↓
             构建文本 -> 批量嵌入（Ollama /api/embed）-> 按 id upsert 进 LanceDB
                                  ↓
       embedding_status = COMPLETED + embedding_model / embedding_version
                                  ↓
              行数 >= 5000 时自动建 IVF_PQ（已有索引则跳过）
```

失败语义：

| 情况 | 处理 |
| --- | --- |
| 模型不可用（Ollama 没跑 / 模型没拉取） | 整轮跳过，什么都不改，记录保持 `PENDING` |
| 单条文本为空 | 该条标 `FAILED`，同批其他记录照常完成 |
| 批量嵌入报错 / 向量库写入失败 | 这一批退回 `PENDING`，下一轮重试（记 `EMBEDDING_ERROR`） |
| 进程崩在批次中间 | 下次启动的补偿把 `PROCESSING` 退回 `PENDING` |

## 5. 验证

```text
npm test                                        241 / 241（新增 21 例）
node --test test/embedding.test.js               15 / 15
node --test test/memoryVectorRepository.test.js   6 / 6
```

真实 Electron 冒烟（假 Ollama + 真实 LanceDB）：

- 三张向量表全部落盘，4 条记录嵌入成功，SQLite 侧的 `COMPLETED` 数与向量行数一致；
- 待分析（`analysis_status != COMPLETED`）的记录保持 `PENDING`，不写向量；
- 把 embedding 模型改成不存在的名字再跑一次：应用照常启动、SQLite 照常工作、
  记录全部保持 `PENDING`、向量库一张表都没建。

前置假设验证：`@lancedb/lancedb` 在 Node 22.23.2 与 Electron 44.3.0（内置 Node 24.20.0）
里都能加载并建表（napi 预编译包，不需要 rebuild）。

详细日志与复现命令见《[22-记忆索引-embedding与LanceDB](22-记忆索引-embedding与LanceDB.md)》第 9 节。

## 6. 踩到的问题与修法

- **日记行全 NULL 的 `project` / `category` 导致建表失败**：
  `Failed to infer data type for field project at row 0. Consider providing an explicit schema.`
  纯内存假仓储的单测（`test/embedding.test.js`）完全覆盖不到——只有真实 LanceDB 会暴露。
  修法是在 `EmbeddingService` 写向量行时统一用空串，并在服务测试里加了一条「`project` / `category`
  必须是字符串」的断言防回归。教训与 Phase 8 的「假 Ollama 掩盖真实模型的 thinking 落点」同类：
  **涉及外部组件的假设，必须用真实组件验证一次**。
- **真实模型必须实测一次**：`ollama pull bge-m3`（1.2 GB）完成后补测，维度 1024、批 32 吞吐
  约 183 条/秒、中文相近语义余弦 0.55 明显高于无关语义 0.35 —— 默认 `batchSize = 32` 由此确认，
  并用真实模型重跑了一遍端到端冒烟（三张表落盘、4 条嵌入、向量行数与 SQLite `COMPLETED` 一致）。
  数据见 `22` 文档第 9.4 节。

## 7. Scope Check

```text
检索 UI / Ask & Answer / 跨三表聚合检索 / 索引参数调优 / 全文检索混合查询 /
换模型后的自动全量重建 / 删除记录时同步删向量 / 向量库的备份与导出 : NOT IMPLEMENTED
```

## 8. 留给后续 Phase 的问题

- **聚合检索**：三张表各查一次再合并排序；查询向量要复用同一个 Provider；
- **失效同步**：记录被删除或文本变化时，本阶段不会删向量（只做新增与幂等覆盖），
  需要一条「按 `source_id` 清理」的路径；
- **换模型的完整流程**：`embedding_model` / `embedding_version` 已经写进每一行，
  但还没有「检测到版本变化就自动重建」的编排；目前靠手动 `resetAll()` + 删表；
- **索引调参**：`numPartitions` / `numSubVectors` 用的是经验公式，数据量上来后需要实测调优；
- **可观测性**：`snapshot()` 已经有每层的状态计数，但还没有接到界面上（Phase 11 的检索页可以顺带展示）。
