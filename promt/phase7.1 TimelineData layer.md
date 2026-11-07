你现在是 Life Lens 项目的 Senior Electron + Node.js Engineer。

## 一、当前项目状态

Life Lens 已完成：

* Screenshot Capture
* Screenshot Similarity Filter
* Ollama + Qwen3-VL 8B
* AI Job Queue
* AI Job Recovery
* Structured AI Output
* SQLite Storage
* Activity + AI Job 事务一致性
* Crash Recovery

当前测试基线：**79/79 全部通过**。

SQLite 已经是项目的主要数据存储。

现在开始：

# Phase 7.1 — Timeline Data Layer

## 二、本阶段目标

为后续 Timeline UI 提供一个稳定、清晰的数据查询能力。

最终需要做到：

```text
SQLite
  ↓
Activity 查询层
  ↓
Main Process
  ↓
IPC / Preload
  ↓
Renderer
```

Renderer 可以按照时间范围、分页等条件获取 Activity 数据，并用于后续 Timeline UI。

---

## 三、你需要完成的事情

请先认真阅读当前项目代码，理解现有：

* SQLite 数据结构
* ActivityRepository
* AIJobRepository
* Main / Preload / Renderer 的 IPC 结构
* 当前 Activity 数据模型

然后根据现有项目结构，以**最自然、最简单、最符合当前代码风格的方式**实现 Timeline Data Layer。

### 核心能力

需要支持查询 Activity：

* 按时间范围查询
* 按 `captured_at` 时间倒序排列
* 分页
* limit
* 返回 Timeline 所需的 Activity 信息
* 正确处理 PENDING / PROCESSING / COMPLETED / FAILED 等状态
* 已经存在的结构化 AI 分析结果应该能够正常返回
* keywords 应该以数组形式提供给上层使用
* 查询异常不能因为单条数据格式问题导致整个 Timeline 崩溃

时间排序必须基于：

```text
captured_at
```

而不是 AI 完成时间。

---

## 四、API / IPC

请根据项目现有的命名和架构习惯设计 API。

Renderer 不应该直接访问 SQLite。

应该通过：

```text
Renderer
→ Preload
→ IPC
→ Main
→ SQLite
```

获得 Timeline 数据。

API 应该保持简单，方便 Phase 7.2 Timeline UI 直接使用。

---

## 五、实现原则

### 1. 优先复用现有架构

不要为了 Timeline 引入新的 ORM、数据库框架或者复杂的数据访问体系。

优先复用现在已经存在的 Repository / SQLite 架构。

### 2. 不要过度设计

如果现有 Repository 已经足够，就直接扩展。

如果确实需要增加 Service / Query Layer，可以根据实际代码判断。

**不要为了满足某个预设结构而增加不必要的抽象。**

### 3. 让你自己判断具体实现

具体包括：

* 文件如何组织
* Repository 是否需要扩展
* 是否需要 Timeline Service
* IPC channel 如何命名
* DTO 如何设计
* SQL 如何组织
* 分页参数如何设计

请结合当前项目实际代码自行判断，选择最合理的实现。

### 4. 保持现有功能稳定

不要修改 Screenshot Capture、AI Worker、AI Provider、SQLite 核心架构等与 Timeline 无关的部分，除非你发现确实存在必须修复的问题。

---

## 六、测试

新增针对 Timeline Data Layer 的测试，至少覆盖：

* 没有数据时查询
* 时间排序
* 时间范围查询
* 分页
* limit
* 不同 analysis status
* Structured Analysis 数据
* keywords
* Unicode 内容
* IPC 调用

同时必须保证原来的：

```text
79/79
```

全部继续通过。

如果因为你的修改增加了测试，总测试数量可以自然增加。

---

## 七、Electron 验证

完成后进行一次真实 Electron 环境验证：

```text
Renderer
→ Preload
→ IPC
→ Main
→ SQLite
```

确认 Timeline 查询链路能够真实工作。

不需要为了本阶段重复完整运行 Ollama 流程。

---

## 八、重要要求

不要实现以下后续功能：

* Timeline UI
* Timeline Card
* Dashboard
* Statistics
* RAG
* Embedding
* Vector Database
* Semantic Search
* Memory
* AI Agent
* Todo
* Focus
* Productivity Score

这些属于后续 Phase。

本阶段重点只有：

> **让 SQLite 中已经积累的 Activity 数据，能够被稳定、规范地查询并提供给前端。**

---

## 九、完成后请汇报

完成后告诉我：

1. 你理解的当前架构
2. 实际修改了什么
3. Timeline 查询 API 怎么设计
4. IPC 怎么设计
5. 新增了哪些测试
6. 原测试通过数量
7. 总测试通过数量
8. Electron 实际验证结果
9. 是否发现需要留到后续 Phase 的问题

不要虚构测试结果，所有数字都以实际运行结果为准。

核心原则：

**先理解现有代码，再做最小、合理的实现。不要机械遵循预设架构。**
