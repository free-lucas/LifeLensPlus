# Phase 12：Ask My Life v1

## 一、目标

在 Phase 11「记忆搜索」的基础上，增加一个最小可用的「问问我的生活」功能。

目标：

> 用户用自然语言提出一个关于自己历史记录的问题，系统用现有 MemorySearchService 检索相关
> Activity / Block / Diary，然后让本地 LLM 基于检索到的真实记忆生成回答。

本阶段只打通一条链路：

```text
用户问题
  ↓
MemorySearchService.search()   ← 检索 + 回查 SQLite 都在这一步完成（Phase 11 已实现）
  ↓
Top 20 相关记忆（items，已含完整记录，不需要再查 SQLite）
  ↓
构建紧凑 Context
  ↓
chatWithOllama（现有 Ollama 封装 + QA_SCHEMA 结构化输出）
  ↓
回答 + 相关记忆
```

---

# 二、当前项目已经具备（动手前先读这些代码）

Phase 12 需要的底层能力几乎全部已存在。先阅读再开发，不要重新实现：

| 能力 | 位置 | 现状 |
| --- | --- | --- |
| 记忆检索（含回查 SQLite） | src/main/search/MemorySearchService.js | `search(query, { limit })` 已完成：embedding → 三张向量表各查一次 → 按 `_distance` 合并排序 → **回查 SQLite 补全完整记录** |
| 向量检索 | src/main/embedding/MemoryVectorRepository.js | activity / block / diary 三个实例，main.js 已装配 |
| Embedding | src/main/embedding/localProvider.js | BGE-M3 `embedText`，维度校验在 Provider 内部 |
| Ollama 对话 | src/main/analyzer.js 的 `chatWithOllama` | 支持 `format`（JSON Schema 结构化输出）、`numCtx`、`think`；非流式（stream: false） |
| 结构化输出先例 | src/main/ai/structuredOutput.js、summaryOutput.js | Schema 交给 Ollama `format` 参数约束，解析后再做业务校验 |
| 错误体系 | `MemorySearchError`（MemorySearchService.js）、`AIError`（src/main/ai/errors.js） | 带 code 的错误类 |
| IPC | 每个功能一个 src/main/xxxIpc.js（如 searchIpc.js） | channel 风格 `lifelens:*`；preload 暴露 `window.lifelens.*`；服务延迟取（getSearch） |
| 结果跳转 | src/renderer/search.js 的 `jumpTargetOf` / `applyJump` | Activity / Block → Timeline Focus；Diary → 日记对应日期 |
| 测试 | `npm test`（node --test test/*.test.js） | 真实 LanceDB + 真实 SQLite + 假 Provider 的单测风格（见 test/memorySearch.test.js）；renderer 视图用纯函数 + createXxxView 工厂（见 test/searchView.test.js） |

### search() 的返回结构（直接使用，不要再加工）

```text
search(query, { limit }) -> {
  query, limit, items, hits, returned, layerCounts,
  missing, invalid, elapsedMs, model
}

items[i] = {
  key,
  sourceType,             // 'activity' | 'block' | 'diary'
  sourceLabel,            // '20秒记录' | '10分钟汇总' | '日记'
  sourceId, distance,
  time, day, endTime,     // 时间；time+endTime 是 Timeline 的定位窗口
  timelineId,             // 仅 activity 有（= screenshot_id，Timeline 卡片 id）
  title, content,         // content = Activity 摘要 / Block 描述 / Diary 正文摘要
  project, category, keywords, keywordsLabel
}
```

注意：

* **检索和 SQLite 回查是同一步**。search() 返回的 items 就是完整记录，
  AskMyLifeService 不需要、也不应该再去查 SQLite（不要重复实现 hydrate）。
* 空查询返回空 items，不报错；检索层面失败抛 `MemorySearchError`
  （code：`INDEX_UNAVAILABLE` / `VECTOR_UNAVAILABLE` / `EMBEDDING_UNAVAILABLE`）。
* 默认 limit = 20，上限 50。

---

# 三、新增「问答」页面

新增独立 Tab，不塞进 Timeline 或现有搜索页。

### 接入点（共 3 处修改 + 1 个新文件）

1. `src/renderer/index.html`：
   * nav.tabs 加 `<button class="tab" data-tab="ask" role="tab">问答</button>`（放在「搜索」后面）；
   * 加 `<div id="view-ask" class="view" hidden>…</div>` 区块；
   * 底部加载新的 `src/renderer/ask.js`。
2. `src/renderer/renderer.js`：`TAB_VIEWS` 数组加 `'ask'`（selectTab 会自动处理切换）。
3. `src/preload.js`：`ask: (question) => ipcRenderer.invoke('lifelens:ask', { question })`。
4. 新文件 `src/renderer/ask.js`：
   * 参照 search.js 的写法，整个文件包在 IIFE 里。renderer 是 classic script、共享同一个
     全局作用域，pad / escapeHtml 这类小工具重名会互相覆盖（search.js 顶部注释记录过这个教训）；
   * 只通过 `window.lifelens.ask(question)` 调 IPC，不碰 SQLite / LanceDB / Ollama / Embedding。

### 页面最小结构

```text
┌──────────────────────────────────────┐
│ 问问我的生活                          │
│                                      │
│ [ 最近一段时间我主要在做什么？ ] [提问] │
│                                      │
│ ───────────── 回答 ──────────────── │
│ ……（可附依据充分程度：高 / 中 / 低）   │
│                                      │
│ ───────── 相关记忆 ──────────────── │
│ 10分钟汇总  2026-09-18 20:10         │
│ ……                                    │
└──────────────────────────────────────┘
```

要求：

* 输入问题、Enter 提交、提问按钮
* loading 状态：LLM 生成要十几秒到几十秒，loading 文案与按钮禁用要撑得住长等待；
  loading 期间禁止重复提交
* 回答区域、相关记忆区域、空状态、错误状态
* 错误显示可读原因，页面不能白屏
* 视觉复用现有风格与 class（timeline-state / timeline-error / 搜索页卡片样式），不重新设计

---

# 四、Q&A 核心流程（AskMyLifeService）

本阶段唯一新增的 Main 层 Service。建议 `src/main/ask/AskMyLifeService.js` +
`src/main/askIpc.js`（与 searchIpc.js 同构；main.js 里用 `getAsk` 延迟取，
装配失败时给可读错误而不是 undefined）。

依赖只有两个：

```text
AskMyLifeService
  ├── search   // 现有 MemorySearchService 实例（main.js 已装配好）
  └── chat     // 现有 chatWithOllama；作为函数注入以便测试，默认指向 analyzer.js 的 chatWithOllama
```

不要给 AskMyLifeService 注入 SQLite repositories。

### 1. 检索

```js
const result = await search.search(question, { limit: 20 });
```

* 直接调用，不修改 MemorySearchService 的签名与行为；
* 不需要自己查 SQLite——items 已是完整记录。

### 2. 空结果短路

`items` 为空时**不调用 LLM**，直接返回：

```text
没有找到足够相关的历史记录，暂时无法准确回答这个问题。
```

（confidence: 'low'，memories: []。省一次推理，也避免模型硬编。）

### 3. 构建 Context

用 items 里现成的字段拼紧凑文本：

```text
[20秒记录] 2026-09-18 20:10
项目：Life Lens ｜ 分类：coding
正在开发 Life Lens 的记忆搜索功能……

[10分钟汇总] 2026-09-18 20:10–20:20
项目：Life Lens ｜ 分类：coding
正在修改 MemorySearchService……

[日记] 2026-09-17
今天主要完成了……
```

规则：

* content 为空的条目跳过（不进 Context；相关记忆里可以不展示或展示「无内容」）；
* 单条 content 过长时截断（如 300 字）；
* 给整个 Context 设总长上限（如 8000 字），超限时按相关度顺序保留前面的；
* 不要把整个 SQLite 数据库塞给 LLM，不要发送原始图片，不要加载全部历史数据。

### 4. 调用 LLM

复用现有 chatWithOllama。不新增 Provider 抽象层、不新增模型 / 超时 / 上下文配置项：

```js
const { content } = await chat({
  ollamaHost: config.ollamaHost,
  model: config.summaryModel,          // 复用现有配置
  timeoutMs: config.summaryTimeoutMs,  // 复用现有配置（问答与汇总同为长生成任务）
  messages: [
    { role: 'system', content: QA_SYSTEM_PROMPT },
    { role: 'user', content: `问题：${question}\n\n以下是检索到的历史记忆：\n${context}` },
  ],
  format: QA_SCHEMA,
  numCtx: config.numCtx,               // 必须显式传，见下方两个坑
  options: { temperature: 0.3, num_predict: 1024 },
  think: false,
});
```

Phase 8 踩过的坑，必须遵守：

* **numCtx 必须显式传**：Ollama 默认 num_ctx 4096，超预算的输入会被**静默截断**，
  表现为模型「看不到」部分记忆、答非所问，极难排查。20 条记忆的 Context 很容易超预算。
* **num_predict 要给足**（如 1024）：默认值会截断输出。
* `think: false` 时 Ollama 可能把结果写进 message.thinking 而不是 content——
  chatWithOllama 已做 fallback（content 为空时取 thinking），不需要额外处理。
* 非流式，一次性返回。

---

# 五、System Prompt（QA_SYSTEM_PROMPT）

```text
你是 Life Lens 的本地个人记忆助手。

你只能根据提供的历史记忆回答用户问题。

要求：
- 不要编造历史记录中不存在的信息。
- 可以对已有记录进行总结和归纳。
- 如果证据不足，请明确说明「现有记录不足以判断」。
- 不要假装知道没有提供的内容。
- 回答直接、清晰。
- 如果结论来自多个记忆，请综合这些记忆。
- 如果问题涉及时间范围，要明确区分不同时间的记录。
```

---

# 六、回答格式（QA_SCHEMA）

```js
const QA_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: '基于给定历史记忆的简明回答，通常不超过 300 字。',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
};
```

* 结构化输出走 chatWithOllama 的 format 参数（由 Ollama 约束语法，与 Phase 5.2 / Phase 8 同一套做法），
  解析后在 Service 层做最小业务校验：answer 是非空字符串、confidence 在枚举内；
  校验失败按「LLM 失败」路径处理。
* IPC 返回结构：

```text
{
  question,
  answer,
  confidence,         // 'high' | 'medium' | 'low'
  memories: items,    // 原样使用 search() 的 items（含跳转所需的 time/day/endTime/timelineId/sourceType）
  model, elapsedMs
}
```

---

# 七、相关记忆

回答下方展示本次 search() 返回的 items：

* sourceLabel（来源类型显示名）
* 时间：显示规则与搜索页一致（日记只显示日期；Activity 到分钟；Block 显示起止区间）
* content 摘要
* project / category（有则显示）

点击后**必须复用** Phase 11 已有导航能力，不要重新实现：

* Activity / Block → 切到时间线并定位到这条记录（`views.timeline.focus(range, id)`）
* Diary → 切到日记页对应日期（`views.diary.selectDay(day)`）

**注意**：`jumpTargetOf` / `applyJump` 以及时间格式化函数目前在 src/renderer/search.js
的 IIFE 内部，Renderer 无法 require，ask.js 直接拿不到。用最小方式共享（选其一）：

* search.js 把这几个纯函数挂到 window（如 `window.lifelensSearchJump`）；
* 或把它们提取成一个共享脚本文件，search.js 与 ask.js 都加载，
  并保持现有 node --test 所依赖的 module.exports 导出不破坏。

**不要把跳转逻辑复制一份到 ask.js。**

---

# 八、错误处理

沿用 Phase 11 的方式：Main 抛带可读 message 的 Error → IPC 透传 → renderer 用
cleanErrorMessage 取可读部分展示。

| 情况 | 来源 | 表现 |
| --- | --- | --- |
| 问题为空 | renderer 本地拦截 | 不触发 IPC |
| 没有相关记忆 | items 为空（不算错误） | 显示「没有找到足够相关的历史记录……」 |
| Embedding / 向量索引不可用 | `MemorySearchError`：EMBEDDING_UNAVAILABLE / INDEX_UNAVAILABLE / VECTOR_UNAVAILABLE | 「暂时无法搜索历史记忆，请检查本地 AI服务。」+ 可读原因 |
| LLM 不可用 / 超时 / 输出解析失败 | `AIError`（OLLAMA_UNAVAILABLE / AI_TIMEOUT / MODEL_NOT_FOUND 等）或本地校验失败 | 「已经找到相关记忆，但当前无法生成回答。」+ 可读原因 |

建议 AskMyLifeService 把上面两类失败转换成带明确前缀的 Error message，
renderer 不需要认识错误码。任何失败都不能让问答页面崩溃或白屏。

---

# 九、不要做的事情

本阶段明确禁止扩大范围。不要实现：

* Agentic Search / 多轮检索 / Query Rewrite / Reranker / Hybrid Search / Keyword Search / Web Search / RAG Framework
* Chat UI / 多轮对话 / 提问历史记录（搜索页有「最近搜索」，问答页不要顺手加「最近提问」）
* 自动时间范围推断 / Agent Tool Calling / 自动执行任务 / Todo Agent / Insight Agent
* 流式输出（chatWithOllama 是 stream:false，一次性返回即可）

不要动现有设施：

* **不要走 AIJobQueueService / AIWorker**——那是后台批处理队列（enqueue 只入队、不等待结果），
  问答是同步 IPC 调用，直接调 chatWithOllama；
* 不要修改 MemorySearchService 的行为与签名；
* 不要新增 AI Provider 抽象层，不要新增模型 / 超时 / 上下文配置项
  （复用 summaryModel、summaryTimeoutMs、numCtx）；
* 不要修改 Screenshot / Activity / Block Summary / Diary Pipeline、Timeline 核心逻辑、
  Dashboard、现有搜索页。

（为接入 Q&A 必须的最小修改除外：index.html 的 Tab、renderer.js 的 TAB_VIEWS、preload.js。）

Renderer 依旧不允许直接访问 SQLite / LanceDB / Ollama / Embedding Provider。

---

# 十、架构

```text
Renderer（src/renderer/ask.js，IIFE）
   │ IPC：lifelens:ask（preload: window.lifelens.ask）
   ↓
askIpc.js → AskMyLifeService（src/main/ask/）
   ├── MemorySearchService.search()        ← 检索 + 回查 SQLite 都在这里完成
   │      ├── LocalEmbeddingProvider（BGE-M3）
   │      ├── MemoryVectorRepository ×3 → LanceDB 三表
   │      └── SQLite Repositories（getById / getByStart / getByDay）
   └── chatWithOllama（analyzer.js，format = QA_SCHEMA）
```

保持：

```text
Renderer → IPC → Main → MemorySearchService → LanceDB / SQLite
```

AskMyLifeService 不直接依赖 SQLite repositories（search() 已回查完毕），
也不要为这一个功能拆出更多 Service。

---

# 十一、测试

测试体系是 `npm test`（node --test test/*.test.js）。参照现有风格：
真实 LanceDB / SQLite 能真则真，LLM 用假 chat 函数注入，renderer 视图用
纯函数 + createXxxView 工厂导出（参照 test/searchView.test.js）。

### Service / IPC 测试（test/askMyLife.test.js）

1. 空问题不触发 search、不触发 LLM
2. 正常问题触发 MemorySearchService，limit = 20
3. items 的字段进入 Context（可断言 prompt 包含 content / project / 分类 / 时间）
4. Context 单条截断与总长上限生效
5. LLM 收到 format = QA_SCHEMA、numCtx 显式传值、system prompt 在 messages 里
6. LLM 返回 { answer, confidence } 正确解析，并随 memories 一起返回
7. items 为空 → 不调 LLM，返回固定文案
8. search 抛 EMBEDDING_UNAVAILABLE / VECTOR_UNAVAILABLE → 转成「暂时无法搜索历史记忆…」
9. LLM 抛错 / 超时 / 返回非法 JSON → 转成「已经找到相关记忆，但当前无法生成回答…」
10. IPC handler 链路：按 test/memorySearch.test.js 测 registerSearchIpc 的方式
    （假 ipcMain + Map 收集 handler），验证 channel → service 完整链路，
    以及服务未装配时的可读错误

### Renderer 测试（test/askView.test.js）

1. 输入问题、点击提问、Enter 提交
2. 空问题不触发 IPC
3. loading 状态出现、提交按钮禁用、结束后恢复
4. 回答与 confidence 渲染
5. 相关记忆列表渲染（来源标签、时间、摘要、project / category）
6. 点击相关记忆产生正确跳转（复用的 jumpTargetOf / applyJump 行为不变）
7. IPC 失败显示错误信息，页面结构不被破坏

### Electron 实跑验证

项目没有 Electron smoke test 体系，不强制新增。手工运行 `npm start` 验证一次完整链路：

```text
输入问题 → IPC → MemorySearchService（BGE-M3 → 3 张 LanceDB 表 → SQLite）
→ Context → Ollama → 回答 → 相关记忆展示 → 点击跳转
```

并在完成标准里如实记录看到了什么；没有跑就写明没有跑。

---

# 十二、完成标准

完成后输出真实结果（不要虚构测试结果）：

```text
Phase 12 Ask My Life v1

实现：
- 新增：...
- 修改：...
- 数据流：...

测试：
- npm test: X/X（全过）
- 新增测试：test/askMyLife.test.js（X 项）、test/askView.test.js（X 项）

验证：
- 检索 + Context 构建（含 numCtx 显式传值）：PASS/FAIL
- LLM 回答解析：PASS/FAIL
- 空结果短路：PASS/FAIL
- 错误路径（embedding / LLM）：PASS/FAIL
- 相关记忆展示与跳转：PASS/FAIL
- Electron 实跑：跑了，看到 …；或 未跑（说明原因）

未解决问题：
- ...
```

如果发现现有架构已经能够直接复用某部分能力，优先复用，不要为了「架构完整」而重构。
不要自动 git commit。

## 最终原则

本阶段只解决一个问题：

> **我问 Life Lens 一个关于过去的问题，它能够从我的真实历史记忆中找到依据，
> 并给我一个基于这些记忆的回答。**

先把这个最小闭环跑通。不要提前设计未来的 Agent。
