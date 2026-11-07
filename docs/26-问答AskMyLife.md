# 问答：Ask My Life v1（Phase 12）

## 1. 这一页是什么

「问答」标签页：用一句自然语言问一个关于**自己过去**的问题，系统先用 Phase 11 的记忆检索
找到相关记忆，再让本地模型**只根据这些记忆**回答。

- 一个问题、一次检索、一次生成：不做多轮对话、不做提问历史、不做 Query Rewrite / Reranker / Hybrid；
- 依据来自三层真实记忆：20 秒 Activity、10 分钟 Block Summary、1 天 Diary；
- 回答只依据检索到的记忆，证据不足时必须说「现有记录不足以判断」；
- 检索与生成全在 Main 层，Renderer 只通过一个 IPC 通道拿结果。

## 2. 分层结构

```text
Renderer（renderer/ask.js，IIFE）
  -> preload.js          window.lifelens.ask(question)
  -> askIpc.js           lifelens:ask
  -> AskMyLifeService    Context 拼装 + 调模型 + 结果整形
       ├── MemorySearchService.search(question, { limit: 20 })   检索 + 回查 SQLite 都在这一步完成
       │      ├── LocalEmbeddingProvider（BGE-M3）
       │      ├── MemoryVectorRepository × 3 → LanceDB 三张向量表
       │      └── ActivityRepository / TimeBlockRepository / DiaryRepository
       └── chatWithOllama（analyzer.js，format = QA_SCHEMA）
```

职责边界：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| `renderer/ask.js` | 输入、Loading / 空 / 错误态、回答与相关记忆渲染、跳转 | 不访问 SQLite / LanceDB / Ollama / Embedding，不做向量计算 |
| `askIpc.js` | 把服务暴露成一个 IPC 通道；服务未装配时给可读错误 | 不含 Prompt、不拼 Context、不写 SQL |
| `AskMyLifeService` | 检索编排、Context 拼装、调用模型、回答校验、错误口径 | 不依赖 SQLite repositories（search() 已回查完毕）、不碰 LanceDB 原生模块 |
| `MemorySearchService`（复用，未改动） | 三层聚合语义检索与 SQLite 回查 | 不做 Prompt、不做生成式问答 |

系统提示词（`QA_SYSTEM_PROMPT`）要求：只能根据给定记忆回答、不编造、可总结归纳、
证据不足时明确说明、回答直接清晰、涉及时间范围时区分不同时间的记录。

## 3. 一次问答的数据流

```text
输入问题
  -> AskMyLifeService.ask(question)
       1. 空问题：直接返回提示（不检索、不调模型）
       2. search.search(question, { limit: 20 })   检索层面的失败 -> 「暂时无法搜索历史记忆…」
       3. items 为空 / 全部无正文 -> 固定文案（不调模型）
       4. buildContext(items)                      单条截断 300 字、总长上限 8000 字
       5. chatWithOllama({ format: QA_SCHEMA, numCtx, think: false, num_predict: 1024 })
          -> 解析 + 最小业务校验                     失败 -> 「已经找到相关记忆，但当前无法生成回答…」
  -> { question, answer, confidence, memories, model, elapsedMs }
  -> 回答区 + 相关记忆卡片（点卡片跳到时间线 / 日记页）
```

`memories` 原样使用 `search()` 的 `items`：它已经带齐跳转需要的
`sourceType` / `time` / `day` / `endTime` / `timelineId`，界面不再二次查询。

## 4. Context 拼装规则

用 `items` 里现成的字段拼紧凑文本，一条记忆一段：

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

- `content` 为空的条目不进 Context（没有正文可给模型看）；
- 单条 `content` 超过 300 字截断；
- 整个 Context 上限 8000 字，超限时按相关度顺序**保留前面的**（items 已按 `_distance` 排序）；
- 时间口径与搜索页一致：日记只给日期，20 秒记录到分钟，10 分钟汇总给起止区间；
- 项目 / 分类都有才占一行，没有就不留空行；
- 绝不把整个数据库塞给模型，不发原始图片，不加载全部历史。

## 5. 模型调用与输出

复用现有的 `chatWithOllama`（不新增 Provider 抽象层、不新增模型 / 超时 / 上下文配置项）：

```js
chat({
  ollamaHost: config.ollamaHost,
  model: config.summaryModel,           // 复用汇总模型
  timeoutMs: config.summaryTimeoutMs,   // 复用汇总超时（问答与汇总同为长生成任务）
  messages: [
    { role: 'system', content: QA_SYSTEM_PROMPT },
    { role: 'user', content: `问题：${question}\n\n以下是检索到的历史记忆：\n${context}` },
  ],
  format: QA_SCHEMA,
  numCtx: config.numCtx,                // 必须显式传，见下
  options: { temperature: 0.3, num_predict: 1024 },
  think: false,
});
```

`QA_SCHEMA`（交给 Ollama 的 `format` 参数约束语法）：

```js
{
  type: 'object',
  properties: {
    answer: { type: 'string', description: '基于给定历史记忆的简明回答，通常不超过 300 字。' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
}
```

解析后仍做**最小业务校验**（`answer` 非空字符串、`confidence` 在枚举内），
沿用 Phase 5 的 `parseStructuredResult`（能容忍模型把 JSON 裹进 Markdown 代码块）。

Phase 8 踩过的两个坑在这里同样成立：

- **`numCtx` 必须显式传**：Ollama 默认 `num_ctx = 4096`，20 条记忆的 Context 很容易超预算，
  超出部分会被**静默截断**，表现为模型「看不到」部分记忆、答非所问，极难排查；
- **`num_predict` 要给足**（1024）：默认值会把回答截断；
- `think: false` 时 Ollama 可能把结果写进 `message.thinking`，`chatWithOllama` 已做 fallback。

## 6. IPC 返回结构

```text
{
  question,           // 裁掉前后空格后的问题
  answer,             // 回答正文
  confidence,         // 'high' | 'medium' | 'low'
  memories,           // search() 的 items 原样
  model,              // 生成回答用的模型（summaryModel）
  elapsedMs           // 整个问答的耗时
}
```

## 7. 相关记忆与跳转

回答下方展示本次 `search()` 返回的 `items`（与搜索页同一套卡片渲染）：

- 来源标签（20秒记录 / 10分钟汇总 / 日记）、时间、`content` 摘要、项目 / 分类、关键词 / 软件 / 主要事项；
- 点击后**复用 Phase 11 的跳转能力**：Activity / Block 切到「记录」并 `timeline.focus(range, id)`；
  Diary 切到「日记」并 `diary.selectDay(day)`。

`jumpTargetOf` / `applyJump` / `cleanErrorMessage` / `renderResults` 只在 `renderer/search.js` 里存在一份，
通过 `window.lifelensSearchKit` 共享给 `ask.js`（这些函数仍在各自的 IIFE 内，不污染全局作用域）。
`ask.js` 在 `search.js` 之后加载；顺序反了就不装配这一页，避免跳转悄悄失效。

## 8. 错误口径

| 情况 | 来源 | 表现 |
| --- | --- | --- |
| 问题为空 | renderer 本地拦截（服务端也有兜底） | 不触发 IPC，提示「先输入一个问题」 |
| 没有相关记忆 / 检索到的记录都没有正文 | `items` 为空 | 不调模型，返回「没有找到足够相关的历史记录，暂时无法准确回答这个问题。」 |
| Embedding / 向量索引不可用 | `MemorySearchError`（`EMBEDDING_UNAVAILABLE` / `VECTOR_UNAVAILABLE` / `INDEX_UNAVAILABLE`） | 「暂时无法搜索历史记忆，请检查本地 AI 服务：…」 |
| LLM 不可用 / 超时 / 输出不合法 | `AIError`（`OLLAMA_UNAVAILABLE` / `AI_TIMEOUT` / `MODEL_NOT_FOUND` …）或本地校验失败 | 「已经找到相关记忆，但当前无法生成回答：…」 |
| 问答服务未装配 | `askIpc.js` | 「问答不可用：本地记忆检索没有启动（Embedding 或 LanceDB 未就绪）」 |

两类失败都抛带可读 message 的 `Error`：IPC 透传，renderer 用 `cleanErrorMessage` 取可读部分展示，
页面不会白屏，也不会残留上一次的结果。生成期间禁用「提问」按钮，避免重复提交。

## 9. 明确不做的事（Phase 12 范围外）

```text
Agentic Search / 多轮检索 / Query Rewrite / Reranker / Hybrid Search / Keyword Search / Web Search /
Chat UI / 多轮对话 / 提问历史 / 自动时间范围推断 / Tool Calling / 自动执行任务 / Todo Agent /
Insight Agent / 流式输出 / 新增 Provider 抽象层 / 新增模型 / 超时 / 上下文配置项
```

另外不动现有设施：`MemorySearchService` 的签名与行为、`AIJobQueueService` / `AIWorker`
（后台批处理队列只入队不等待结果，问答是同步 IPC 调用，直接调 `chatWithOllama`）、
Screenshot / Activity / Block Summary / Diary Pipeline、Timeline 核心逻辑、Dashboard 与搜索页。

相关文档：[24-记忆搜索](24-记忆搜索.md)、[27-变更记录-Phase12](27-变更记录-Phase12.md)。
