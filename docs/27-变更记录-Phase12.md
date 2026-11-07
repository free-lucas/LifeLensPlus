# 变更记录：Phase 12 — 问答（Ask My Life v1）

## 1. 这一阶段做了什么

**A. 新增 `AskMyLifeService`（Main 层唯一的新组件）**

- 一个 `ask(question)` 入口：检索相关记忆 -> 拼 Context -> 调本地模型 -> 回答 + 相关记忆；
- 依赖只有两个：现有的 `MemorySearchService`（检索与 SQLite 回查都在它内部完成）
  与 `chatWithOllama`（默认值，测试可注入假的 chat 函数）；
- **不**注入 SQLite repositories，**不**碰 LanceDB / Embedding Provider；
- 空问题、没有可用记忆都在本地短路，不打扰模型；
- 两类失败分别给固定前缀：检索失败 -> 「暂时无法搜索历史记忆…」，
  生成失败 -> 「已经找到相关记忆，但当前无法生成回答…」（都带可读原因）。

**B. 新增 `askIpc.js`（`lifelens:ask`）**

与 `searchIpc.js` 同构：`getAsk` 延迟取服务，服务未装配时抛可读错误而不是返回 undefined。

**C. 新增「问答」标签页（renderer）**

- `renderer/ask.js`（IIFE）：输入 + 提问按钮 + Enter 提交、loading（按钮禁用、禁止重复提交）、
  回答与「依据充分程度：高 / 中 / 低」、相关记忆卡片、空态与错误态；
- 跳转与相关记忆的卡片渲染**复用** `search.js`：它把 `jumpTargetOf` / `applyJump` /
  `cleanErrorMessage` / `renderResults` 挂到 `window.lifelensSearchKit`
  （函数本身仍在 IIFE 内，不污染全局作用域），`ask.js` 只引用、不复制；
- 接入点：`index.html`（Tab + `view-ask` 区块 + `<script src="ask.js">`）、
  `renderer.js` 的 `TAB_VIEWS` 加 `'ask'`、`preload.js` 加 `ask(question)`；
- 样式复用 `search-bar` / `search-input` / `search-status` / `search-card` 等既有 class，
  只新增 `.ask-answer-body`（并入既有玻璃质感选择器组）与几条排版规则。

**D. main.js 装配**

```js
ask = search
  ? new AskMyLifeService({ search, ollamaHost, model: config.summaryModel,
                           timeoutMs: config.summaryTimeoutMs, numCtx: config.numCtx })
  : null;
```

复用 `summaryModel` / `summaryTimeoutMs` / `numCtx`：**没有新增任何模型 / 超时 / 上下文配置项**。

## 2. 新增与修改的文件

```text
新增：
  src/main/ask/AskMyLifeService.js     问答服务（QA_SCHEMA / QA_SYSTEM_PROMPT / buildContext）
  src/main/askIpc.js                   lifelens:ask 通道
  src/renderer/ask.js                  问答页渲染层（纯函数 + createAskView + init）
  test/askMyLife.test.js               服务层与 IPC 测试（10 项）
  test/askView.test.js                 渲染层测试（7 项）
  test/smoke/askMyLifeSmoke.cjs        真实 Electron 冒烟（真实 Ollama + 真实数据副本）
  docs/26-问答AskMyLife.md             功能与架构说明
  docs/27-变更记录-Phase12.md          本文件

修改：
  src/main/main.js                     装配 AskMyLifeService + registerAskIpc
  src/preload.js                       ask(question)
  src/renderer/index.html              「问答」Tab、view-ask 区块、加载 ask.js
  src/renderer/renderer.js             TAB_VIEWS 追加 'ask'
  src/renderer/search.js               暴露 window.lifelensSearchKit（共享跳转与卡片渲染）
  src/renderer/styles.css              .ask-answer-body 并入玻璃质感组 + Phase 12 样式小节
  docs/01-架构总览.md                  模块地图、数据流、职责边界表
  docs/06-测试与验证.md                 测试结果与 Phase 12 冒烟记录
  docs/README.md                       文档索引与一句话概览
```

未改动：`MemorySearchService`（签名与行为不变）、`AIJobQueueService` / `AIWorker`、
三个 Provider、Screenshot / Activity / Block / Diary 链路、Timeline、Dashboard、搜索页。

## 3. 数据流

```text
Renderer(ask.js)  输入问题 + 点「提问」
  -> preload: window.lifelens.ask(question)
  -> askIpc: lifelens:ask
  -> AskMyLifeService.ask
       -> MemorySearchService.search(question, { limit: 20 })
            -> provider.embedText（BGE-M3 查询向量）
            -> 三张向量表各 search 一次 -> 按 _distance 合并截取 20 条
            -> getById / getByStart / getByDay 回查 SQLite
       -> buildContext：单条 300 字、总长 8000 字、无正文不进 Context
       -> chatWithOllama(format=QA_SCHEMA, numCtx, think=false, num_predict=1024)
  -> { answer, confidence, memories[] }
  -> 回答区 + 相关记忆卡片
  -> 点卡片：activity/block -> lifelensTabs.select('overview') + lifelensTimeline.focus(range, id)
             diary          -> lifelensTabs.select('diary')    + lifelensDiary.selectDay(day)
```

## 4. 测试

```text
npm test                                 284 / 284（基线 267，新增 17）
node --test test/askMyLife.test.js        10 / 10
node --test test/askView.test.js           7 / 7
```

服务层 10 项：空问题不检索不调模型、正常问题 limit=20 + 请求形状（format / numCtx / think /
num_predict / system prompt）、**真实 LanceDB + 真实 SQLite 的检索链路把字段拼进 Context**、
Context 单条截断与总长上限、回答解析（含 Markdown 代码块容错）、空结果短路、
检索失败三种错误码、生成失败（不可用 / 超时 / 未注入）、输出不合法六种形状、IPC 链路与未装配错误。

渲染层 7 项：回答与依据充分程度渲染 + 转义、点提问与回车提交（空问题不走 IPC）、
loading 与按钮禁用 / 重复提交拦截 / 结束恢复、相关记忆列表字段、点记忆复用搜索页跳转、
IPC 失败可读原因且不破坏页面结构、classic script 不污染全局作用域。

## 5. 验证（真实结果）

测试：`npm test` 284 / 284 全过。

真实 Electron 冒烟（`test/smoke/askMyLifeSmoke.cjs`，真实 Ollama + 真实 BGE-M3 +
真实 LanceDB + 真实 SQLite 的**只读副本**，`executeJavaScript` 驱动真实页面）：11 项全部 PASS。

```text
PASS  「问答」标签页存在  标签文案：问答
PASS  点标签页切到问答页
PASS  IPC 返回回答  confidence=high
PASS  confidence 在枚举内
PASS  IPC 返回相关记忆  相关记忆 20 条，用时 9850ms，模型 qwen3-vl:8b
PASS  相关记忆带跳转所需字段  首条：diary / 日记 / 2026-09-14 / timelineId=null
PASS  生成期间按钮禁用、出现 loading 文案  按钮 disabled=true，状态栏：正在回忆并生成回答…
PASS  回答渲染到页面上  页面文本：…依据充分程度：高 · 用时 4.6 秒
PASS  相关记忆列表画出来了  20 张卡片
PASS  点相关记忆跳转到对应页面  来源=日记 记录页=false 日记页=true
PASS  生成失败给可读原因且不白屏  「提问失败：已经找到相关记忆，但当前无法生成回答：模拟的模型故障」
```

主进程日志（真实输出）：

```text
[AI-JOB] 2026-09-19T21:09:22+08:00 MEMORY_SEARCH job=- type=- status=- 记忆搜索命中 20 条（20秒记录 20 / 10分钟汇总 20 / 日记 4，2106ms，缺失 0，跳过 0）
[AI-JOB] 2026-09-19T21:09:30+08:00 MEMORY_SEARCH job=- type=- status=- 记忆搜索命中 20 条（20秒记录 20 / 10分钟汇总 20 / 日记 4，40ms，缺失 0，跳过 0）
```

真实回答（节选，模型基于检索到的记忆自己组织）：

```text
根据历史记忆，最近一段时间（2026年9月14日至9月19日）您主要在进行多个项目的开发工作，
涉及《Life Lens》《LifeLens》《Filter & Search Coding Agent Frontend》《LifePlus》《LifeLinePlus》等项目。
- 9月14日：集中处理……推进Phase 2.2和Phase 7.3阶段……
- 9月16日：围绕《LifeLinePlus》项目推进Phase 8阶段……
- 9月19日：集中处理《LifeLensPlus》项目，推进Phase 10和Phase 11……
```

完成标准对照：

```text
检索 + Context 构建（含 numCtx 显式传值）：PASS
LLM 回答解析：PASS
空结果短路：PASS
错误路径（embedding / LLM）：PASS
相关记忆展示与跳转：PASS
Electron 实跑：跑了（11 项 PASS，见上）
```

## 6. 踩到的问题与修法

- **`memories[0].timelineId` 不是向量行的 `source_id`**：20 秒记录的 `timelineId` 是
  `screenshot_id`（`shot-ask`），而 `source_id` 是 `activities.id`（数字）。测试里断言错了方向
  （拿 `findIdByScreenshotId` 的返回值去比 `timelineId`）就会失败——这条正是搜索页 Phase 11
  已经记录过的口径，复用时容易踩。
- **`registerSummaryIpc` / `registerDiaryIpc` 会直接调注入对象的 `snapshot()`**：
  冒烟里传 `null` 会在界面刷新时抛错（`Cannot read properties of null`），要给 `{ snapshot: () => null }`。
- **在无 package.json 的目录里跑 Electron 脚本会换掉 userData**：
  `npx electron test/smoke/xxx.cjs` 的 `app.getName()` 是 `Electron`，
  `getPath('userData')` 会指向 `%APPDATA%\Electron`；必须 `app.setName('lifelens-plus')`，
  否则找不到真实的 LanceDB 目录（会误判成「向量库不存在」）。
- **不要用真实数据库做冒烟**：脚本把 `lifelens.db`（含 `-wal` / `-shm`）与 `lancedb/`
  复制到临时目录再读，避免验证动作污染真实数据。
- **Windows PowerShell 下 `apply_patch` 的 heredoc 会踩坑**：多段补丁要用 bash 或在
  PowerShell 里改用字面 here-string 写文件。

## 7. Scope Check

```text
Agentic Search / 多轮检索 / Query Rewrite / Reranker / Hybrid Search / Keyword Search / Web Search /
Chat UI / 多轮对话 / 提问历史 / 自动时间范围推断 / Tool Calling / 自动执行任务 / Todo Agent /
Insight Agent / 流式输出 / 新的 Provider 抽象层 / 新的模型 / 超时 / 上下文配置项 /
MemorySearchService 行为与签名变更 / MemorySearchService→SQLite 重复 hydration /
AIJobQueueService 与 AIWorker 参与问答 / Timeline 重构 / Dashboard 重构           : NOT IMPLEMENTED
```

## 8. 留给后续 Phase 的问题

- **提问历史**：这一版明确不做「最近提问」（搜索页有「最近搜索」），下一阶段若要做需要先决定
  是否落盘、是否参与多轮；
- **多轮追问**：现在每次都是独立的一次检索 + 一次生成，追问「那前一天呢」需要 Query Rewrite 或
  对话状态，属于 Agentic Search 的范围；
- **置信度口径**：`confidence` 目前完全由模型自述（Schema 枚举），没有和检索距离挂钩，
  未来可以把 `_distance` 分布一起纳入判断；
- **记忆不足时的提示**：现在只有「一条都没有」才短路；检索到但与问题无关时模型会说
  「现有记录不足以判断」，但没有结构化信号告诉界面「依据薄弱」；
- **Context 预算**：8000 字与 300 字是拍出来的常量，`numCtx` 16384 下还有余量，
  可以用 token 计数而不是字符数来定预算；
- **响应时间**：单次回答 4.6s（模型已加载）到十几秒（冷启动），非流式；
  流式输出是体验上最直接的下一步。
