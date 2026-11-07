# Life Lens — Phase 5.2 Structured AI Output

## 0. 你的角色

你现在是这个项目的 Senior Electron / Node.js / Local AI Engineer。

你需要在当前已经完成 Phase 5 和 Phase 5.1 的代码基础上，完成：

> **Phase 5.2 — Structured AI Output**

目标是把目前 Qwen3-VL 8B 的自由文本分析，升级为**严格、稳定、可验证的结构化 JSON 输出**。

本阶段使用：

> **Ollama 原生 JSON Schema Structured Output**

不要引入 Outlines。

不要重新设计 AI Job Queue。

不要重新设计截图系统。

不要迁移 SQLite。

不要提前开发 Timeline / Dashboard / Memory / RAG / Agent。

---

# 1. 当前项目状态

当前项目已经完成：

* Phase 1：代码 Review / Bug Fix
* Phase 2：截图系统稳定化
* Phase 3：截图相似度过滤
* Phase 4：Ollama + Qwen3-VL 8B
* Phase 5：AI Job Queue
* Phase 5.1：AI Job Recovery / Compensation

当前架构：

```text
Screenshot Scheduler
        ↓
Recorder
        ↓
save screenshot
        ↓
write Activity Record
        ↓
enqueue AI Job
        ↓
AIJobQueueService
        ↓
AIWorker
        ↓
AIProvider
        ↓
OllamaVisionProvider
        ↓
Ollama
        ↓
Qwen3-VL 8B
        ↓
AI result
        ↓
Activity Record
```

Phase 5 已经具备：

* PENDING
* PROCESSING
* COMPLETED
* FAILED
* RETRYING
* CANCELLED
* retry
* timeout
* restart recovery
* priority
* duplicate protection
* pause / resume
* reanalysis
* graceful shutdown
* AI Provider abstraction

Phase 5.1 已解决：

> Activity Record 已经处于 PENDING，但应用在 enqueue AI Job 之前崩溃，导致永远没有对应 AI Job 的问题。

**不要破坏以上能力。**

---

# 2. Phase 5.2 的核心目标

目前 AI 输出主要是一段自然语言。

例如：

```text
用户正在使用 VS Code 编写 JavaScript 代码，当前正在修改 Electron 项目中的 AI Worker 相关代码。
```

现在需要改成结构化输出：

```json
{
  "activity": "编写代码",
  "summary": "正在使用 VS Code 开发 Electron 项目中的 AI Worker。",
  "category": "coding",
  "project": "Life Lens",
  "keywords": [
    "Electron",
    "JavaScript",
    "AI Worker"
  ],
  "confidence": 0.94
}
```

以后 Timeline、统计、Project、Diary、Memory、RAG 等模块都应该基于这些结构化字段工作。

---

# 3. 非目标

本阶段明确禁止：

## 不要做 SQLite

SQLite 属于 Phase 6。

当前仍然使用现有 JSON persistence。

---

## 不要重写 AI Queue

不要修改 Job State Machine：

```text
PENDING
PROCESSING
COMPLETED
FAILED
RETRYING
CANCELLED
```

除非为了适配新的 AI Result 必须进行极小范围修改。

---

## 不要修改截图逻辑

不要改变：

* screenshot interval
* screenshot storage
* similarity detection
* screenshot naming
* capture API

---

## 不要修改 Ollama 安装方式

用户已经安装并配置：

```text
Ollama
Qwen3-VL 8B
```

不要要求用户重新安装。

---

## 不要引入 Outlines

本阶段明确采用：

> Ollama Native Structured Outputs / JSON Schema

---

# 4. 首先检查现有代码

开始开发之前，先完整检查：

```text
src/main/analyzer.js
src/main/ai/
src/main/recorder.js
src/main/store.js
src/main/main.js
src/main/config.js
src/preload.js
src/renderer/
test/
package.json
README.md
```

重点理解：

```text
OllamaVisionProvider
AIWorker
AIJobQueueService
AIJobRepository
Activity Record
```

不要假设代码结构。

必须以当前仓库实际代码为准。

---

# 5. 设计原则

本阶段必须遵守以下原则：

## 5.1 AI Worker 不负责结构化 Schema

AIWorker 只关心：

```text
analyze()
health()
```

它不应该知道：

```text
category
project
keywords
confidence
```

---

## 5.2 Schema 属于 AI Provider / Analyzer 层

推荐：

```text
AIWorker
    ↓
AIProvider.analyze()
    ↓
OllamaVisionProvider
    ↓
Ollama Structured Output
    ↓
Structured AI Result
```

这样以后可以替换：

```text
Ollama
OpenAI
Gemini
Claude
其他 Local Model
```

而不会影响 Queue。

---

# 6. 定义统一 AI Result Schema

创建一个明确的结构化结果定义。

推荐字段：

```json
{
  "activity": "string",
  "summary": "string",
  "category": "string",
  "project": "string|null",
  "keywords": ["string"],
  "confidence": "number"
}
```

---

# 7. 字段语义

## activity

表示：

> 用户此刻正在做什么。

应该是短语。

例如：

```text
编写代码
阅读文档
浏览网页
观看视频
编辑图片
处理邮件
阅读新闻
参加会议
聊天
填写表格
```

不要生成长句。

---

## summary

表示：

> 对当前截图内容的简短自然语言总结。

推荐 1～2 句话。

不要写：

```text
根据图片可以看出……
```

不要写：

```text
我认为……
```

直接描述用户正在做什么。

例如：

```text
正在使用 VS Code 开发 Electron 项目，当前正在修改 AI Worker 相关代码。
```

---

## category

用于后续统计。

第一版定义有限枚举：

```text
coding
browsing
communication
meeting
document
media
design
shopping
finance
learning
entertainment
system
other
```

必须使用 enum。

不要让模型自由生成无限 category。

---

## project

表示当前活动所属项目。

例如：

```text
Life Lens
AKP
Personal
Work
```

如果无法确定：

```json
null
```

不要强行猜测。

---

## keywords

提取当前活动中有价值的关键词。

例如：

```json
[
  "Electron",
  "JavaScript",
  "Ollama",
  "AI Worker"
]
```

要求：

* 0～8 个
* 不重复
* 简洁
* 不生成完整句子

---

## confidence

表示模型对本次判断的信心。

范围：

```text
0.0 ~ 1.0
```

必须进行 Schema 约束。

推荐：

```text
minimum: 0
maximum: 1
```

---

# 8. JSON Schema

为 Ollama Structured Output 定义严格 JSON Schema。

建议：

```json
{
  "type": "object",
  "properties": {
    "activity": {
      "type": "string",
      "description": "A short phrase describing what the user is currently doing."
    },
    "summary": {
      "type": "string",
      "description": "A concise summary of the user's current activity."
    },
    "category": {
      "type": "string",
      "enum": [
        "coding",
        "browsing",
        "communication",
        "meeting",
        "document",
        "media",
        "design",
        "shopping",
        "finance",
        "learning",
        "entertainment",
        "system",
        "other"
      ]
    },
    "project": {
      "type": ["string", "null"],
      "description": "The project associated with the activity, or null if unknown."
    },
    "keywords": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 8
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    }
  },
  "required": [
    "activity",
    "summary",
    "category",
    "project",
    "keywords",
    "confidence"
  ],
  "additionalProperties": false
}
```

如果当前 Ollama API / SDK 对：

```json
"type": ["string", "null"]
```

存在兼容性问题，应根据当前 Ollama API 的实际要求调整 Schema，但必须保持：

```text
project 可以为 string 或 null
```

并且必须保持：

```text
additionalProperties = false
```

---

# 9. Ollama API 调整

修改现有：

```text
OllamaVisionProvider
```

使其调用 Ollama 的 Structured Output 能力。

核心思想：

```text
format = JSON Schema
```

而不是：

```text
prompt:
"Please return JSON"
```

不要只依赖 Prompt 强迫模型返回 JSON。

必须让 Ollama API 本身接收 Schema。

---

# 10. 推荐请求结构

根据当前项目使用的 Ollama API 客户端版本实现。

目标效果类似：

```javascript
{
  model: modelName,
  messages: [
    {
      role: "user",
      content: prompt,
      images: [imageBase64]
    }
  ],
  format: schema,
  stream: false
}
```

如果当前项目 API 版本要求不同，以实际 API 为准。

不要盲目复制上述代码。

---

# 11. Prompt 设计

Prompt 不再负责“定义 JSON 格式”。

Schema 已经负责结构约束。

Prompt 只负责：

> 告诉视觉模型如何判断 Activity。

推荐原则：

```text
You are analyzing a screenshot from the user's computer.

Identify what the user is currently doing.

Focus on observable activity rather than guessing personal intentions.

Return concise structured information.

Activity should describe the current action.
Summary should briefly explain the current activity.
Category must match one of the allowed categories.
Project should be null when it cannot be determined.
Keywords should contain only useful short terms.
Confidence should reflect how certain the classification is.
```

实际 Prompt 可以根据现有 analyzer.js 风格调整。

---

# 12. 重要：不要让模型过度猜测

例如截图只是：

```text
VS Code
```

不能直接推断：

```text
用户正在开发 AKP 权限系统
```

除非截图中存在明确证据。

应该：

```json
{
  "activity": "编写代码",
  "summary": "正在使用 VS Code 编写程序。",
  "category": "coding",
  "project": null,
  "keywords": ["VS Code"],
  "confidence": 0.72
}
```

---

# 13. AI Result Validation

即使 Ollama 已经使用 JSON Schema，也必须在 Provider 返回结果后做第二层应用级验证。

不要假设：

> Schema = 业务数据一定正确。

需要增加：

```text
validateStructuredResult()
```

可以放在：

```text
src/main/ai/
```

或者 analyzer/provider 中，按照当前项目结构选择最合理的位置。

---

# 14. Validation Rules

必须验证：

## activity

```text
string
非空
合理长度
```

建议：

```text
1～100 characters
```

---

## summary

```text
string
非空
合理长度
```

建议：

```text
1～500 characters
```

---

## category

必须属于：

```text
coding
browsing
communication
meeting
document
media
design
shopping
finance
learning
entertainment
system
other
```

---

## project

允许：

```text
string
null
```

如果是 string：

```text
不能是空字符串
```

---

## keywords

必须：

```text
array
```

最大：

```text
8
```

每个元素必须：

```text
string
```

并且：

```text
trim
remove empty
remove duplicates
```

---

## confidence

必须：

```text
number
```

范围：

```text
0 <= confidence <= 1
```

如果因为浮点误差超出范围，可以安全 clamp：

```javascript
Math.min(1, Math.max(0, confidence))
```

---

# 15. 防止 AI 输出污染

如果模型返回：

````text
```json
{
 ...
}
````

````

Provider 不应该把 Markdown code fence 当作最终业务数据。

优先依赖 Ollama Structured Output。

但应用层仍然应该具有合理的 defensive parsing。

不要为了兼容旧模型而写一个巨大的脆弱 JSON parser。

保持简单。

---

# 16. 错误分类

Structured Output 失败应该纳入现有 AI Error 系统。

检查：

```text
src/main/ai/errors.js
````

如果已经有：

```text
AIError
errorCode
retryable
```

继续复用。

不要重新创建第二套错误体系。

---

# 17. Structured Output 错误是否 Retry？

推荐：

### Retryable

```text
OLLAMA_UNAVAILABLE
TIMEOUT
5xx
temporary network error
empty response
temporary structured-output failure
```

### Permanent

```text
MODEL_NOT_FOUND
IMAGE_NOT_FOUND
IMAGE_CORRUPT
BAD_REQUEST
INVALID_SCHEMA
UNSUPPORTED_API
```

如果 Ollama 返回明确表示：

> 当前模型不支持该 Structured Output 功能

不要无限 retry。

应该变成明确的 permanent failure。

---

# 18. Activity Record 修改

找到当前 Activity Record 结构。

不要直接重构整个 Record。

在现有结构上增加结构化 AI 字段。

例如当前可能类似：

```json
{
  "timestamp": "...",
  "imagePath": "...",
  "analysisStatus": "COMPLETED",
  "summary": "..."
}
```

升级为：

```json
{
  "timestamp": "...",
  "imagePath": "...",
  "analysisStatus": "COMPLETED",

  "analysis": {
    "activity": "编写代码",
    "summary": "正在使用 VS Code 开发 Electron 项目。",
    "category": "coding",
    "project": "Life Lens",
    "keywords": [
      "Electron",
      "JavaScript"
    ],
    "confidence": 0.94
  }
}
```

如果当前项目已经有 `summary` 等字段，不要无脑重复字段。

应该根据现有结构设计向后兼容的升级方案。

核心目标是：

> Activity Record 最终能够保存完整 Structured AI Result。

---

# 19. 向后兼容

必须考虑已有历史记录。

历史数据可能只有：

```text
summary
```

或者：

```text
analysisStatus
```

不能因为 Phase 5.2 而让历史数据无法读取。

旧记录：

```json
{
  "summary": "正在写代码"
}
```

应该仍然能够正常显示。

Structured fields 缺失时：

```text
category = null
project = null
keywords = []
confidence = null
```

不要假装历史数据拥有 AI 判断结果。

---

# 20. Recorder 不应该负责 Schema

Recorder 只接收 AI Result。

例如：

```javascript
handleAnalysisResult(job, result)
```

然后保存。

不要在 Recorder 里面写：

```javascript
if (!result.category) ...
if (!result.confidence) ...
```

除非当前架构确实需要。

Schema/validation 应该尽量在 Provider 边界完成。

---

# 21. AIWorker 不应该感知字段

AIWorker 只需要：

```javascript
const result = await provider.analyze(...)
```

然后：

```javascript
onCompleted(result)
```

它不应该出现：

```javascript
result.category
result.project
result.keywords
```

这样保持 Provider abstraction。

---

# 22. 类型定义 / 常量

虽然当前项目是 CommonJS JavaScript，不要强行迁移 TypeScript。

可以增加：

```javascript
const AI_CATEGORIES = Object.freeze([
  ...
]);
```

以及：

```javascript
const STRUCTURED_AI_SCHEMA = ...
```

建议统一放置，避免 schema 在多个文件重复定义。

---

# 23. 配置

检查：

```text
src/main/config.js
```

如果有必要，可以增加：

```text
structuredOutputEnabled
```

但是：

### 默认必须开启。

不要要求用户额外配置才能使用 Phase 5.2。

例如：

```text
LIFELENS_AI_STRUCTURED_OUTPUT=true
```

可以作为兼容/实验开关，但默认：

```text
true
```

如果当前架构没有必要增加开关，则不要为了配置而增加配置。

---

# 24. 失败时不要影响截图

这是整个项目非常重要的原则：

> AI 失败绝对不能影响截图。

例如：

```text
Qwen3-VL structured output failure
        ↓
AI Job retry
        ↓
FAILED
```

但：

```text
Screenshot Scheduler
        ↓
继续截图
```

不能出现：

```text
AI failed
    ↓
Recorder stopped
    ↓
Screenshot stopped
```

---

# 25. AI 输出示例

至少测试以下场景。

## Coding

```json
{
  "activity": "编写代码",
  "summary": "正在使用 VS Code 编写 Electron 项目代码。",
  "category": "coding",
  "project": "Life Lens",
  "keywords": ["VS Code", "Electron", "JavaScript"],
  "confidence": 0.94
}
```

## Browsing

```json
{
  "activity": "浏览网页",
  "summary": "正在浏览网页并阅读相关信息。",
  "category": "browsing",
  "project": null,
  "keywords": ["Chrome"],
  "confidence": 0.86
}
```

## Meeting

```json
{
  "activity": "参加会议",
  "summary": "正在参加在线会议。",
  "category": "meeting",
  "project": null,
  "keywords": ["meeting"],
  "confidence": 0.91
}
```

## Unknown Project

```json
{
  "activity": "阅读文档",
  "summary": "正在阅读技术文档。",
  "category": "document",
  "project": null,
  "keywords": ["documentation"],
  "confidence": 0.79
}
```

---

# 26. 测试要求

Phase 5.2 必须增加测试。

不能只人工运行。

至少覆盖：

## Test 1 — Valid structured result

输入：

```json
{
  "activity": "编写代码",
  "summary": "正在开发 Electron 应用。",
  "category": "coding",
  "project": "Life Lens",
  "keywords": ["Electron"],
  "confidence": 0.95
}
```

应该：

```text
PASS
```

---

## Test 2 — Missing required field

例如：

```json
{
  "activity": "编写代码"
}
```

应该：

```text
FAIL
```

---

## Test 3 — Invalid category

```json
{
  "category": "gaming123"
}
```

应该：

```text
FAIL
```

---

## Test 4 — Invalid confidence

```json
{
  "confidence": 1.5
}
```

应该：

```text
FAIL
```

---

## Test 5 — Project null

```json
{
  "project": null
}
```

应该：

```text
PASS
```

---

## Test 6 — Empty keywords

```json
{
  "keywords": []
}
```

应该：

```text
PASS
```

---

## Test 7 — Duplicate keywords

输入：

```json
[
  "Electron",
  "Electron",
  "JavaScript"
]
```

经过 normalize 后：

```json
[
  "Electron",
  "JavaScript"
]
```

---

## Test 8 — Too many keywords

超过 8 个。

应该：

```text
FAIL
```

或者按照明确的 normalize 策略截断。

选择一种方式并保持一致。

---

## Test 9 — confidence normalization

测试：

```text
0
0.5
1
```

均合法。

---

## Test 10 — Ollama Structured Output request

Mock Ollama Client。

验证请求中真正包含：

```text
format = JSON Schema
```

而不是只在 Prompt 中要求 JSON。

---

## Test 11 — Structured result saved to Activity

模拟：

```text
AIWorker
    ↓
Provider
    ↓
Structured result
```

验证 Activity Record 最终保存：

```text
activity
summary
category
project
keywords
confidence
```

---

## Test 12 — AI failure does not stop screenshot

保持 Phase 5 原来的测试能力。

AI 失败时：

```text
screenshot continues
```

---

# 27. Provider 测试

必须 mock Ollama。

不要要求测试机器必须真的运行 Ollama。

测试：

```text
OllamaVisionProvider
```

至少覆盖：

```text
valid structured JSON
invalid response
missing fields
invalid category
invalid confidence
null project
Ollama unavailable
timeout
model missing
```

---

# 28. 不要让测试依赖真实 AI

测试禁止依赖：

```text
真实 Qwen3-VL
真实 GPU
真实 Ollama
```

除非额外增加一个明确的：

```text
integration test
```

并且默认：

```text
npm test
```

不应该要求 Ollama 正在运行。

---

# 29. Regression Tests

Phase 5 已经有：

```text
27/27
```

Phase 5.2 完成后：

> 所有原有测试必须继续通过。

并新增 Structured Output tests。

最终输出：

```text
old tests: PASS
new tests: PASS
total: XX/XX
```

---

# 30. UI 调整

Phase 5.2 可以对当前 AI Queue UI 做**最小必要调整**。

当前 UI 已经有：

```text
AI status
Pause / Resume
job logs
pending stats
```

不要重新设计 UI。

如果当前 Activity 页面显示 AI summary，可以逐步显示：

```text
Activity
Category
Project
Keywords
Confidence
```

例如：

```text
正在编写代码

Category: Coding
Project: Life Lens

Keywords:
Electron · JavaScript · AI Worker

Confidence: 94%
```

但 UI 不是本阶段重点。

如果当前 UI 架构修改成本较高：

> 优先保证后端结构化数据正确。

---

# 31. Confidence UI

如果显示：

```text
0.94
```

UI 可以显示：

```text
94%
```

不要显示：

```text
0.94%
```

---

# 32. 日志

AI log 中不要打印整张图片 Base64。

不要输出：

```text
imageBase64
```

也不要输出巨大 JSON。

推荐：

```text
AI completed
jobId=...
category=coding
project=Life Lens
confidence=0.94
```

如果 Debug 模式需要输出 Structured Result，也应该截断。

---

# 33. Privacy

这个项目是 Local First。

Structured AI Output 不允许增加外部 API。

数据仍然：

```text
Screenshot
    ↓
Local filesystem
    ↓
Local Ollama
    ↓
Local JSON
```

不得发送到：

```text
OpenAI
Google
Anthropic
第三方 API
```

---

# 34. 性能要求

Structured Output 不应该明显影响截图频率。

截图仍然：

```text
Scheduler
    ↓
Recorder
    ↓
save screenshot
    ↓
enqueue job
    ↓
return
```

AI：

```text
Worker
    ↓
background
```

AI 处理 60 秒也不能阻塞截图。

---

# 35. Model Compatibility

Qwen3-VL 8B 是当前主要目标模型。

实现时检查当前 Ollama 版本和 API 行为。

如果 Structured Output 对当前模型存在限制：

不要直接修改整个项目。

优先：

```text
Provider capability detection
```

或者明确的：

```text
AIError
```

例如：

```text
STRUCTURED_OUTPUT_UNSUPPORTED
```

然后让 Job 按正确的 permanent/retryable 逻辑处理。

不要让应用 crash。

---

# 36. README 更新

更新 README。

至少说明：

```text
Structured AI Output
```

以及：

```text
AI Result Schema
```

示例：

```json
{
  "activity": "编写代码",
  "summary": "正在开发 Electron 项目。",
  "category": "coding",
  "project": "Life Lens",
  "keywords": ["Electron"],
  "confidence": 0.94
}
```

说明：

```text
Ollama Native Structured Outputs / JSON Schema
```

说明：

```text
AI Worker does not depend on schema details.
Schema belongs to AI Provider layer.
```

---

# 37. 文件修改原则

优先修改现有文件：

```text
src/main/analyzer.js
src/main/ai/errors.js
src/main/recorder.js
src/main/store.js
src/main/config.js
src/main/main.js
test/
README.md
```

如果需要新增文件，可以新增，例如：

```text
src/main/ai/structuredOutput.js
src/main/ai/schema.js
test/structuredOutput.test.js
```

但不要为了形式而拆分。

保持项目简单。

---

# 38. 不允许的大规模重构

禁止：

```text
CommonJS → TypeScript
```

禁止：

```text
Electron → Tauri
```

禁止：

```text
JSON → SQLite
```

禁止：

```text
Ollama → OpenAI
```

禁止：

```text
AI Queue → completely new architecture
```

禁止：

```text
Renderer rewrite
```

禁止：

```text
React migration
```

除非当前代码已经存在对应基础，并且只是必要兼容。

---

# 39. 完成后的架构

最终应该变成：

```text
┌──────────────────────────────┐
│ Screenshot Scheduler         │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│ Recorder                     │
│ save screenshot              │
│ write Activity(PENDING)      │
│ enqueue AI Job               │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│ AI Job Queue                 │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│ AI Worker                    │
│ concurrency = 1              │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│ AI Provider                  │
│ OllamaVisionProvider         │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│ Ollama Structured Output     │
│ JSON Schema                  │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│ Qwen3-VL 8B                  │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│ Structured AI Result         │
│                              │
│ activity                     │
│ summary                      │
│ category                     │
│ project                      │
│ keywords                     │
│ confidence                   │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│ Application Validation       │
│ normalize / validate         │
└──────────────┬───────────────┘
               ↓
┌──────────────────────────────┐
│ Activity Record              │
└──────────────────────────────┘
```

---

# 40. 最终验收标准

Phase 5.2 只有满足以下条件才能认为完成：

### A. Structured Output

Ollama 请求真正使用：

```text
JSON Schema
```

而不是仅靠 Prompt。

### B. Schema

必须支持：

```text
activity
summary
category
project
keywords
confidence
```

### C. Validation

应用层存在第二层 validation。

### D. Provider abstraction

AIWorker 不依赖具体字段。

### E. Backward compatibility

历史 Activity Record 可以继续读取。

### F. Error handling

Structured Output failure 正确进入现有 AIError / retry 系统。

### G. Screenshot isolation

AI 失败不会停止截图。

### H. Tests

旧测试全部通过。

新增 Structured Output 测试全部通过。

### I. Documentation

README 更新完成。

### J. No scope creep

本阶段不进入：

```text
SQLite
Timeline
Dashboard
Project
Memory
RAG
Ask My Life
Agent
```

---

# 41. 开发流程

严格按照以下顺序执行：

## Step 1

检查现有代码。

先输出：

```text
Current Architecture Assessment
```

说明：

```text
现有 AI Provider
Activity Record
AI Worker
Analyzer
Ollama client
Tests
```

不要直接改代码。

---

## Step 2

设计：

```text
Structured AI Result
JSON Schema
Validation
```

先说明准备修改哪些文件。

---

## Step 3

实现 Schema。

---

## Step 4

实现 Ollama Native Structured Output。

---

## Step 5

实现 application-level validation / normalization。

---

## Step 6

接入现有 Provider。

---

## Step 7

接入 Activity Record。

---

## Step 8

增加测试。

---

## Step 9

运行：

```bash
npm test
```

如果项目存在其他验证命令，也运行：

```bash
npm run lint
npm run typecheck
npm run build
```

但只有当前项目确实存在这些 script 时才执行。

不要为了完成任务临时制造无意义的 lint/typecheck/build。

---

## Step 10

执行 Electron smoke test。

重点验证：

```text
screenshot
→ Activity PENDING
→ AI Job
→ Worker
→ Ollama
→ Structured Result
→ Activity COMPLETED
```

---

# 42. 最终报告

完成后必须输出：

## 1. Implementation Summary

修改了什么。

---

## 2. Architecture Changes

说明：

```text
AIWorker
AIProvider
OllamaVisionProvider
Activity Record
```

分别发生了什么变化。

---

## 3. Structured Schema

完整列出最终 Schema。

---

## 4. Files Changed

列出：

```text
modified files
new files
```

---

## 5. Test Results

例如：

```text
Existing tests: 27/27 PASS
New structured output tests: XX/XX PASS
Total: XX/XX PASS
```

---

## 6. Manual Verification

说明是否验证：

```text
Ollama
Qwen3-VL 8B
real screenshot
real structured output
```

---

## 7. Example Result

给出一份真实或 mock 的：

```json
{
  "activity": "...",
  "summary": "...",
  "category": "...",
  "project": "...",
  "keywords": [],
  "confidence": 0.0
}
```

---

## 8. Known Issues

只列真实存在的问题。

---

# 43. 最重要的开发原则

记住：

> **Phase 5.2 的核心不是“让 AI 返回 JSON”，而是建立一个稳定、可验证、可扩展的 AI Activity 数据契约。**

最终希望达到：

```text
Qwen3-VL
    ↓
Ollama Structured Output
    ↓
Schema
    ↓
Validation
    ↓
Normalized AI Result
    ↓
Activity Record
```

同时保持：

```text
Screenshot ≠ AI
```

也就是：

> **AI 永远不能成为截图系统的单点故障。**

完成后再考虑 Phase 6 SQLite。

现在不要提前做 Phase 6。
