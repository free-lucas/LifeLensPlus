你现在负责开发 Life Lens 的 **Phase 11：独立记忆搜索页面（Memory Search）**。

## 目标

新增一个独立的「搜索」页面，让用户可以用自然语言搜索自己的历史记忆。

当前项目已经具备：

* SQLite 作为主数据存储
* 20 秒 Activity
* 10 分钟 Summary
* 1 天 Diary
* BGE-M3 Embedding（Ollama /api/embed，1024 维，Provider 在 src/main/embedding/localProvider.js）
* LanceDB 三张向量表：activity_vectors / block_vectors / diary_vectors，字段结构一致
  （注意：没有单张的 memory_vectors 表，来源类型由所查的表决定）
* 每张表各有一个统一的 MemoryVectorRepository（src/main/embedding/MemoryVectorRepository.js），
  已实现 search(vector, { limit, filter })，返回原始行（含 _distance）
* BGE-M3 → LanceDB 的向量写入和基础检索已经验证成功
* Timeline / Dynamic / Diary / Dashboard 等现有页面

请先阅读现有代码，理解当前的页面结构、IPC、Preload、SQLite Repository、LanceDB 封装以及已有 Embedding 实现，然后再开发。

---

## 一、搜索页面

新增独立的「搜索」页面，不要把搜索功能直接塞进 Timeline。

页面核心结构：

1. 页面标题：`搜索记忆`
2. 一个明显的自然语言搜索框
3. 搜索按钮或 Enter 搜索
4. 搜索结果区域
5. 最近搜索记录

用户可以输入：

* 我最近什么时候研究过 AI Agent？
* 我最近在做什么？
* 我什么时候开始做 Life Lens？
* 最近有哪些关于 BGE-M3 的记录？

---

## 二、搜索逻辑

用户输入问题后：

```text
用户输入
  ↓
BGE-M3 Embedding（复用现有 EmbeddingProvider.embedText 与同一份维度校验）
  ↓
三张向量表各自 Vector Search
（activity_vectors / block_vectors / diary_vectors，复用现有 search()）
  ↓
按 _distance 合并排序，取前 N 条
  ↓
回 SQLite 取完整记录
  ↓
搜索页面展示
```

跨三表的聚合检索是本阶段要新建的最小组件：三张表各查一次、按 _distance 合并排序。
不要绕过 MemoryVectorRepository 直接操作 LanceDB，也不要新写一套向量查询。

这一阶段只做**语义搜索**。

不要加入：

* Agent
* LLM 问答
* 多轮搜索
* RAG
* Query Rewrite
* Reranker
* Hybrid Search

这些留给后续阶段。

---

## 三、搜索结果

每条结果至少展示：

* 时间
* Activity / Summary / Diary 内容
* Project（如果有）
* Category（如果有）
* Keywords（如果有）
* 来源类型

来源类型显示：

* `20秒记录`
* `10分钟汇总`
* `日记`

结果按照相关度排序。

可以展示适量结果，例如默认 10～20 条。

不要把大量历史数据一次性加载到 Renderer。

---

## 四、结果跳转

点击搜索结果后：

* 如果来源是 20 秒 Activity / 10 分钟 Summary：
  尽量跳转或定位到现有 Timeline 对应记录。
* 如果来源是 Diary：
  跳转到对应日期的 Diary。

不要重新实现一套详情页面。

优先复用现有 Timeline / Diary 的查看逻辑。

---

## 五、最近搜索

保存最近若干次搜索关键词。

例如：

```text
最近搜索

AI Agent
Life Lens
BGE-M3
我最近在学习什么
```

点击后可以重新执行搜索。

实现保持简单即可，不需要复杂搜索历史管理。

---

## 六、架构要求

保持现有架构：

```text
Renderer
   ↓
Preload / IPC
   ↓
Main
   ↓
Memory Search Service（聚合三表、合并排序、回查 SQLite）
   ↓
MemoryVectorRepository（现有三实例） → LanceDB
```

不要让 Renderer 直接访问 LanceDB。

搜索相关逻辑应该放在 Main 层。

如果当前项目已经存在合适的 Vector Repository / Search Service，请优先复用，而不是重复实现。

建议保持职责分离：

```text
Memory Search Service
        ↓
MemoryVectorRepository（已有，activity / block / diary 各一实例）
        ↓
SQLite 侧复用现有 Repository 回查完整记录
```

Search Service 不应该直接散落 SQL 或 LanceDB 操作。

---

## 七、搜索结果的数据来源

LanceDB 是检索索引。

向量表里没有 source_type 列：来源类型由所查的表决定（activity_vectors / block_vectors /
diary_vectors），行 ID 前缀（activity: / block: / diary:）与表一一对应。

回 SQLite 获取完整记录时，三层的 source_id 含义不同：

* activity → activities.id
* block → block_start（time_blocks 的业务键）
* diary → day（diaries 的业务键）

也就是说：

```text
LanceDB 三表检索
  ↓
找到相关 memory（表名 → 来源类型，行内取 source_id）
  ↓
按来源类型选对应的现有 SQLite Repository
  ↓
完整 Activity / Summary / Diary
```

不要把 LanceDB 当成新的主数据库。

---

## 八、UI 要求

整体视觉风格复用当前 Life Lens UI，不要重新设计一套完全不同的风格。

搜索页面重点：

* 简洁
* 留白
* 搜索框突出
* 结果卡片清晰
* 支持中文
* Loading 状态明确
* 无结果状态明确
* 搜索失败显示错误
* 不要复杂动画

搜索过程中可以显示：

```text
正在搜索记忆…
```

---

## 九、性能要求

不要把全部历史数据加载到前端。

搜索必须通过 LanceDB 的向量检索完成。

默认限制返回结果数量，例如 20 条（三张表各查 limit 条，合并排序后截取前 20）。

避免因为一次搜索加载大量历史记录导致 UI 卡顿。

---

## 十、异常情况

至少处理：

* LanceDB 不可用
* Embedding Model 不可用
* 搜索为空
* LanceDB 没有数据
* source_id 对应的 SQLite 数据不存在
* 数据格式异常

单条异常记录不能导致整个搜索页面崩溃。

---

## 十一、测试

根据当前项目实际测试体系补充测试。

至少覆盖：

1. 自然语言 → Embedding → Vector Search
2. 三表结果按 _distance 合并排序（相关度排序）
3. 表名 / 行 ID 前缀 → 来源类型与 source_id 正确解析
4. Activity 搜索结果能够回 SQLite
5. 10 分钟 Summary 搜索结果能够回 SQLite
6. Diary 搜索结果能够回 SQLite
7. 空结果
8. LanceDB / Embedding 异常
9. 搜索结果数量限制
10. IPC → Main → LanceDB → SQLite 的完整链路

如果适合，补一个真实 Electron smoke test。

不要伪造测试结果，最终报告实际运行结果。

---

## 十二、明确不要做

本阶段不要实现：

* ❌ AI 问答
* ❌ Chat UI
* ❌ Agentic Search
* ❌ 多轮搜索
* ❌ Hybrid Search
* ❌ RAG
* ❌ Reranker
* ❌ Embedding 模型更换
* ❌ 新的 Vector Database
* ❌ Timeline 搜索功能重构
* ❌ Dashboard / Diary / Dynamic 功能重构

---

## 十三、开发原则

* 先阅读现有代码，再决定具体文件和类结构。
* 优先复用已有 BGE-M3、LanceDB、SQLite、IPC 能力。
* 不要为了这个功能引入不必要的新依赖。
* 不要修改已经稳定运行的核心数据流。
* 保持代码简单。
* 如果现有架构已经有合适的 Search / Vector Repository，可以在其基础上扩展。
* 不要为了“未来可能需要”提前实现复杂 Agent 架构。

完成后请输出：

1. 修改/新增了哪些文件
2. 实现了什么
3. 搜索数据流
4. 测试数量及实际结果
5. Electron 实际运行验证结果（如果执行了）
6. 当前已知限制
7. 后续建议

不要自动 git commit。
