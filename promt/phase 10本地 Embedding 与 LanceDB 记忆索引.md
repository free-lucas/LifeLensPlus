# Phase 10 开发计划 — 本地 Embedding 与 LanceDB 记忆索引

> 版本：v2（基于初版评审调整：三表结构、索引策略、Migration v4、触发机制等）
>
> 目标：把 20 秒 Activity、10 分钟 Block、1 天 Diary 三层文本，可靠地变成 Embedding 并写入 LanceDB，跑通「记忆 → embedding → 向量库」完整链路。

## 0. 范围

**本阶段做：**

- 三层记忆的 embedding 文本构造（Text Builder）
- 本地 Embedding 模型接入（Ollama）
- 批量 embedding 队列与状态管理
- LanceDB 三张向量表 + 按阈值自动建索引
- 基础 vector search（最简实现，供验证）

**本阶段不做（留给 Phase 11 检索与问答）：**

- 检索 UI、Ask & Answer
- 跨三表聚合检索
- 复杂索引调参、全文检索混合查询

## 1. 架构总则

```text
                SQLite（唯一事实来源）
                        │
        ┌───────────────┼───────────────┐
        ↓               ↓               ↓
     Activity        TimeBlock        Diary
       20s             10min            1day
        │               │               │
        └───────────────┼───────────────┘
                        ↓
                 EmbeddingService
            （扫描 PENDING → 批量嵌入）
                        ↓
              LanceDB（语义检索索引）
                        ↓
                 Vector Retrieval（Phase 11）
```

三条铁律：

1. **SQLite 是唯一事实来源**。LanceDB 只是可随时重建的语义索引，坏了就重建，不承载业务状态。
2. **Embedding 绝不阻塞截图链路**。模型缺失 / 挂掉时，截图与 SQLite 照常工作，记录保持 PENDING，模型恢复后自动补齐（对齐 Phase 5 设计理念）。
3. **三层记忆不混数据**。粒度、字段、更新频率都不同，分别建表、分别重建。

## 2. LanceDB 表结构：分三张表

| 表名 | 数据源 | 预估量级（1 年） | 行 ID 格式 |
|---|---|---|---|
| `activity_vectors` | activities | ~157 万条 | `activity:{activities.id}` |
| `block_vectors` | time_blocks | ~14.4 万条 | `block:{block_start}` |
| `diary_vectors` | diaries | ~365 条 | `diary:{day}` |

**为什么不用一张表**（否决初版 `memory_vectors` 单表方案）：

1. 数据量差 4 个数量级（157 万 vs 365），混表后 diary/block 的查询和重建会被 activity 拖累。
2. 三层字段差异大（keywords / software / highlights），单表要么塞 JSON 元数据列（无法下推过滤），要么大量 NULL。
3. 与现有 Repository 分层一致（Activity / TimeBlock / Diary 各管一表），单表会让 upsert/delete 逻辑纠缠 source_type 分支。
4. 换 embedding 模型时可逐表重建，互不影响。

**统一字段结构**（三表一致，便于聚合层统一处理）：

| 字段 | 说明 |
|---|---|
| `id` | 行 ID，见上表格式 |
| `source_id` | 对应 SQLite 的业务键（id / block_start / day） |
| `text` | 实际用于 embedding 的文本 |
| `vector` | embedding 向量（固定维度，建表时声明） |
| `captured_at` | 原始时间（activity）/ block_start（block）/ day（diary） |
| `date` | 本地日期 YYYY-MM-DD（取时间前 10 字符，同 SQLite 口径） |
| `project` | 项目（diary 无此列） |
| `category` | 分类（diary 无此列） |
| `embedding_model` | 模型名，如 bge-m3 |
| `embedding_version` | 嵌入版本，如 v1 |
| `created_at` | 写入时间 |

注意：不要用 `metadata` JSON 列装元数据——LanceDB 的过滤是基于列下推的，扁平列才能参与过滤。

**存储位置**：`app.getPath('userData')/lancedb/`，依赖 `@lancedb/lancedb`（实施前先验证与当前 Electron/Node 版本兼容）。

## 3. Embedding 文本构造（Text Builder）

**核心原则：嵌入「构造过的语义文本」，不是 JSON stringify，也不是单字段。**

三个 Builder：

- `ActivityEmbeddingTextBuilder`（activities → text）
- `BlockEmbeddingTextBuilder`（time_blocks → text）
- `DiaryEmbeddingTextBuilder`（diaries → text）

示例（20 秒 Activity）：

```text
项目：Life Lens
当前活动：开发 SQLite 数据层
正在实现 ActivityRepository 与事务封装，关注事务一致性、AI Job 关联与崩溃恢复。
关键词：SQLite、Repository、Transaction、AI Job
```

示例（10 分钟 Block）：

```text
项目：Life Lens
类型：工作
这 10 分钟主要在开发 Life Lens 的 SQLite 数据层，完成了 ActivityRepository 设计，验证了事务一致性。
软件：VS Code、Chrome、Terminal
待办：补充数据库恢复测试。
```

示例（1 天 Diary）：

```text
日期：2026-09-17
今天主要围绕 Life Lens 项目开发，完成 Timeline、Dynamic、Diary、Dashboard，并开始设计个人生活问答。
主要事项：Timeline 搜索；Dashboard；Q&A 设计
```

定位：activity 回答「我当时具体在干什么」（最细粒度）；block 回答「这 10 分钟主要做了什么」；diary 回答「这一天整体发生了什么」（长期记忆节点）。

## 4. EmbeddingProvider 接口

Qwen3-VL 是视觉理解 + 文本生成模型，**不要拿来做 embedding**。新增独立接口：

```js
class EmbeddingProvider {
  get dimension() {}      // 向量维度，建表 / 建索引必需
  get model() {}          // 模型名，如 'bge-m3'
  get version() {}        // 嵌入版本，如 'v1'
  get maxBatchSize() {}   // 单批上限，如 64

  async embedText(text, options) {}       // -> number[]
  async embedTexts(texts, options) {}     // -> number[][]
  // options: { timeoutMs }；本地运行、无云 API 依赖、失败抛错由上层处理
}
```

`LocalEmbeddingProvider` 基于 Ollama `/api/embed` 实现。换模型时不改 LanceDB 结构，只换 Provider。

**模型选型**（实施第一步先验证，不硬编码结论）：

1. 首选 `bge-m3`：中文友好、1024 维、Ollama 可直接拉取。
2. 备选 `nomic-embed-text`：768 维、官方维护，中文效果需对比验证。

验证清单：能 pull 成功 → 单条 / 批量调用返回稳定维度 → 中文语义区分度抽查 → 记录实测速度（条/秒）用于定 batch size。

## 5. 状态与触发机制

### 5.1 SQLite Migration（version 4）

按项目约定不改已发布的 migration 1-3，**追加 version 4**：

```sql
ALTER TABLE activities  ADD COLUMN embedding_status  TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE activities  ADD COLUMN embedding_model   TEXT;
ALTER TABLE activities  ADD COLUMN embedding_version TEXT;
-- time_blocks、diaries 同样新增这三列
```

已有记录随 DEFAULT 初始化为 PENDING，实现存量数据自动补嵌入。

### 5.2 状态机

```text
PENDING ──→ PROCESSING ──→ COMPLETED
   ↑             │
   │             ↓（重试超限，如 3 次）
   └────────── FAILED
```

- 启动补偿：进程崩溃遗留的 PROCESSING，启动时一律重置回 PENDING（与 ai_jobs 恢复策略同口径）。
- FAILED 可手动触发重置为 PENDING。

### 5.3 EmbeddingService 触发方式

**不新建队列表**，SQLite 的 `embedding_status='PENDING'` 就是待办池：

- 每层只取「分析已完成 且 embedding_status='PENDING'」的记录（activity 需 `analysis_status='COMPLETED'`；block 需 `status='COMPLETED'`；diary 需 `status='COMPLETED'`）。
- `setInterval` 定时扫描（如每 60 秒），凑满一批（32 或 64，按实测速度定）执行：构建文本 → 批量 embedding → 批量写 LanceDB（按 id upsert）→ 更新 SQLite 状态。
- 单条失败不影响同批其他记录；模型不可用时本轮跳过，记录留在 PENDING。

## 6. 向量索引策略

**第一阶段就内置索引能力，但不立刻建索引**——按数据量阈值自动启用：

- 表行数 < 5000：暴力扫描（brute-force），延迟可接受，不建索引。
- 表行数 ≥ 5000：在批量写入后自动创建 **IVF_PQ** 索引（不用 HNSW：内存占用高；IVF_PQ 是 LanceDB 大数据量下的推荐方案）。

```js
async ensureIndex(table, dimension) {
  const count = await this.count(table);
  if (count < INDEX_THRESHOLD) return;         // 阈值 5000
  await table.createIndex('vector', 'IVF_PQ', {
    num_partitions: Math.max(2, Math.floor(Math.sqrt(count))),
    num_sub_vectors: Math.max(2, Math.floor(dimension / 64)),
  });
}
```

搜索侧：有索引走 ANN，无索引自动退回暴力扫描，对上层透明。

## 7. 模型版本与重建

每条向量记录 `embedding_model / embedding_version`，未来换模型（如 bge-m3 → 新模型）时：

1. 新建 `*_v2` 表（或清空原表），用同一批 Text Builder 重新生成文本、重新嵌入。
2. 全量重建期间旧索引仍可查询（或直接接受短暂不可用——本地索引重建成本很低）。
3. **不修改 SQLite 原始数据**，只重置 `embedding_status='PENDING'` 让服务重跑。

## 8. MemoryVectorRepository

对每张向量表提供统一仓储（SQL/Lance 查询只出现在 repository 层，与现有约定一致）：

```js
class MemoryVectorRepository {
  async upsert(rows) {}          // 按 id 覆盖写入（批量）
  async deleteBySource(ids) {}   // 按行 ID 删除
  async findBySource(id) {}      // 查单条（校验是否已入库）
  async count() {}
  async ensureIndex(dimension) {}
  async search(vector, { limit, filter }) {}  // 第一阶段仅最简实现
}
```

三张表各实例化一个；跨表聚合检索是 Phase 11 的事，本阶段不做。

## 9. 实施清单

| # | 组件 | 位置建议 |
|---|---|---|
| 1 | Migration v4（三表各加 3 列） | `src/main/db/migrations.js`、`schema.js` |
| 2 | `EmbeddingProvider` 接口 + `LocalEmbeddingProvider`（Ollama） | `src/main/embedding/` |
| 3 | 三个 Text Builder | `src/main/embedding/textBuilder/` |
| 4 | `MemoryVectorRepository`（三表） | `src/main/embedding/` |
| 5 | `EmbeddingService`（扫描、批量、状态更新、启动补偿） | `src/main/embedding/` |
| 6 | main.js 装配 + 模型不可用时的降级日志 | `src/main/main.js` |

## 10. 验收标准

1. **三层链路独立跑通**：Activity / Block / Diary 各自能从 SQLite 生成 embedding 并写入对应 LanceDB 表，`count()` 与 SQLite 完成数一致。
2. **不阻塞主链路**：停掉 Ollama 或删除 embedding 模型，截图 → Activity → SQLite 照常，记录保持 PENDING；模型恢复后自动补齐。
3. **崩溃恢复**：手工把若干记录置为 PROCESSING 后模拟重启，启动补偿将其重置为 PENDING 并完成嵌入。
4. **幂等**：同一条记录重复嵌入，LanceDB 中按 id 覆盖，不产生重复行。
5. **索引自动化**：向 activity_vectors 灌入 ≥5000 条后，`ensureIndex` 自动创建 IVF_PQ；<5000 时走暴力扫描且搜索可用。
6. **可重建**：删除 LanceDB 目录后重置状态为 PENDING，服务能全量重建索引库，SQLite 原始数据不受影响。
