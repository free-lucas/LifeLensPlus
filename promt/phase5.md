# Phase 5：AI Job Queue —— AI 后台任务队列

## 0. 你的角色

你现在是一名资深 Electron + TypeScript + React + AI 应用架构师。

当前项目是一个 Windows Electron 本地 AI 个人活动记录软件。

项目目前已经完成了：

* Electron 桌面应用
* 每 20 秒自动截图
* 截图保存到本地
* Ollama 本地运行
* Qwen3-VL 8B 已经安装并可以正常调用
* 截图相似度检测 / 重复截图过滤已经实现或正在实现
* 截图对应的活动数据保存为 JSON

现在进入：

> **Phase 5：AI Job Queue**

本阶段的目标不是重新开发 Ollama，也不是重新开发截图功能。

而是：

> **建立一个可靠、可恢复、可重试、不会阻塞截图的 AI 后台任务队列。**

---

# 一、开始之前必须先 Review 当前代码

不要直接开始写代码。

首先检查当前项目：

```text
1. 项目目录结构
2. Screenshot Service
3. Screenshot Scheduler
4. Screenshot Similarity Service
5. Ollama Service
6. Qwen3-VL 调用代码
7. Activity 数据结构
8. JSON Storage
9. Electron Main Process
10. preload
11. IPC
12. Renderer
13. 已有测试
```

重点寻找：

```text
当前截图完成以后，是如何触发 Qwen3-VL 分析的？
```

如果当前代码是：

```typescript
await screenshot();
await analyzeWithQwen();
```

或者：

```typescript
setInterval(async () => {
    const image = await capture();
    await analyze(image);
}, 20000);
```

必须进行解耦。

目标架构：

```text
Screenshot Scheduler
        ↓
Screenshot Service
        ↓
保存截图
        ↓
创建 AI Job
        ↓
AI Job Queue
        ↓
AI Worker
        ↓
Ollama
        ↓
Qwen3-VL
        ↓
Activity / JSON
```

---

# 二、本阶段核心目标

实现：

```text
Screenshot
    ↓
AI Job
    ↓
Queue
    ↓
Worker
    ↓
Qwen3-VL
    ↓
Result
```

截图服务和 AI 服务必须彻底解耦。

---

# 三、最重要的原则

必须保证：

> **AI 永远不能阻塞截图。**

例如：

```text
13:00:00 截图
13:00:20 截图
13:00:40 截图
13:01:00 截图
```

即使 Qwen3-VL：

```text
13:00:00 → 分析用了 15 秒
13:00:20 → 上一个任务还没结束
13:00:40 → 上一个任务还没结束
```

截图仍然必须正常执行。

正确：

```text
Screenshot Scheduler
       │
       ├── Screenshot
       │
       ├── Screenshot
       │
       ├── Screenshot
       │
       └── Screenshot
              ↓
          AI Queue
          │
          └── Worker
               ↓
           Qwen3-VL
```

而不是：

```text
Screenshot
 ↓
等待 AI
 ↓
AI 完成
 ↓
下一次 Screenshot
```

---

# 四、创建 AI Job 数据模型

建立统一的 AI Job 类型。

例如：

```typescript
type AIJobType =
  | "SCREENSHOT_ANALYSIS"
  | "TIMEBLOCK_SUMMARY"
  | "DIARY_GENERATION"
  | "EMBEDDING"
  | "INSIGHT_GENERATION";
```

本阶段：

> **只实现 SCREENSHOT_ANALYSIS。**

其他类型只预留接口，不需要实现。

---

# 五、Job 数据结构

建立：

```typescript
interface AIJob {
  id: string;

  type: AIJobType;

  status:
    | "PENDING"
    | "PROCESSING"
    | "COMPLETED"
    | "FAILED"
    | "RETRYING"
    | "CANCELLED";

  priority: number;

  payload: {
    screenshotId?: string;
    imagePath?: string;
    activityId?: string;
  };

  retryCount: number;

  maxRetries: number;

  createdAt: string;

  startedAt?: string;

  completedAt?: string;

  failedAt?: string;

  error?: {
    code: string;
    message: string;
  };

  lastError?: string;
}
```

根据现有项目架构调整字段。

不要机械复制上面的代码。

---

# 六、Job Queue Service

创建：

```text
AIJobQueueService
```

至少提供：

```typescript
enqueue(job)
dequeue()
getJob(id)
getJobs()
getPendingJobs()
retry(jobId)
cancel(jobId)
getStats()
```

建议增加：

```typescript
start()
stop()
pause()
resume()
```

---

# 七、AI Worker

创建：

```text
AIWorker
```

Worker 负责：

```text
从 Queue 获取 Job
        ↓
检查 Job
        ↓
设置 PROCESSING
        ↓
调用 Ollama
        ↓
解析 Qwen3-VL 返回结果
        ↓
保存 AI 分析结果
        ↓
设置 COMPLETED
```

失败：

```text
调用 Ollama
      ↓
失败
      ↓
判断是否可以重试
      ↓
RETRY
```

---

# 八、默认并发必须为 1

因为当前使用：

> Qwen3-VL 8B

默认：

```text
concurrency = 1
```

即：

```text
Queue
 ↓
Worker 1
 ↓
Qwen3-VL
```

不要默认：

```text
Worker 1
Worker 2
Worker 3
Worker 4
```

否则可能出现：

```text
GPU VRAM 不足
Ollama 请求堆积
系统卡顿
Electron 内存增加
```

架构上可以支持未来修改：

```text
concurrency = 1
```

以后可以在 Settings 中配置。

但本阶段默认固定为 1 即可。

---

# 九、Job 优先级

设计：

```typescript
priority: number
```

例如：

```text
10 = High
5  = Normal
1  = Low
```

截图分析默认：

```text
priority = 5
```

未来可以让用户手动触发的分析拥有更高优先级。

---

# 十、重复任务保护

必须防止：

```text
同一张截图
↓
创建两个 SCREENSHOT_ANALYSIS Job
```

例如：

```text
Screenshot ID = abc123
```

如果已经存在：

```text
SCREENSHOT_ANALYSIS
abc123
PENDING
```

再次 enqueue 时：

> 不允许创建重复 Job。

如果已经：

```text
PROCESSING
```

也不能重复创建。

如果：

```text
COMPLETED
```

默认不再创建。

除非显式执行：

```text
retry / reanalyze
```

---

# 十一、任务状态机

严格设计状态转换：

```text
PENDING
   ↓
PROCESSING
   ↓
COMPLETED
```

失败：

```text
PROCESSING
   ↓
FAILED
```

可重试：

```text
PROCESSING
   ↓
RETRYING
   ↓
PENDING
   ↓
PROCESSING
```

取消：

```text
PENDING
   ↓
CANCELLED
```

禁止非法状态跳转。

例如：

```text
COMPLETED
   ↓
PROCESSING
```

默认禁止。

---

# 十二、Retry 策略

默认：

```text
maxRetries = 3
```

例如：

```text
第一次失败
↓
等待 2 秒
↓
Retry

第二次失败
↓
等待 5 秒
↓
Retry

第三次失败
↓
等待 15 秒
↓
Retry

仍然失败
↓
FAILED
```

不要使用：

```text
while(true)
```

无限重试。

---

# 十三、哪些错误应该重试

可以重试：

```text
Ollama 暂时不可用
请求超时
网络/IPC 临时错误
模型暂时忙
```

不应该无限重试：

```text
模型不存在
图片文件不存在
图片损坏
参数错误
JSON 永久无法解析
```

对于永久性错误：

```text
FAILED
```

并保存：

```text
errorCode
errorMessage
```

---

# 十四、AI Timeout

Qwen3-VL 可能运行较慢。

必须设置：

```text
AI_TIMEOUT
```

默认例如：

```text
120000 ms
```

即：

```text
2分钟
```

如果超时：

```text
PROCESSING
 ↓
TIMEOUT
 ↓
RETRY
```

根据项目实际情况设计。

不要让一个 Job 永久卡在：

```text
PROCESSING
```

---

# 十五、Electron 重启恢复

这是本阶段最重要的功能之一。

假设：

```text
13:00
截图
↓
Job = PROCESSING
↓
Qwen3-VL 正在运行
```

突然：

```text
Electron Crash
```

重新启动：

```text
Electron Start
↓
发现 Job = PROCESSING
↓
判断该 Job 上一次没有正常完成
↓
恢复为 PENDING
↓
重新执行
```

不能让 Job 永远卡死。

---

# 十六、不要只把 Queue 放在内存里

禁止：

```typescript
const queue: AIJob[] = [];
```

然后完全依赖内存。

因为：

```text
Electron 重启
↓
Queue 全部消失
```

必须持久化。

如果当前项目已经使用 SQLite：

> 使用 SQLite 保存 Job。

如果当前项目仍然使用 JSON：

> 在不破坏现有架构的前提下，可以建立独立的 AI Job JSON 持久化。

推荐最终架构：

```text
SQLite
 ├── activities
 ├── screenshots
 ├── ai_jobs
 ├── projects
 └── memories
```

但本阶段不要为了 Queue 强行重写整个现有存储系统。

优先兼容当前项目。

---

# 十七、AI Job 与 Activity 的关系

一张截图：

```text
Screenshot
```

产生：

```text
Activity
```

同时产生：

```text
AI Job
```

建议关系：

```text
Screenshot
   │
   ├── screenshotId
   │
   └── AI Job
          │
          └── Activity
```

AI Job 不应该直接成为 Activity。

Job 是：

> “需要做什么”。

Activity 是：

> “AI 最终分析出了什么”。

---

# 十八、AI 分析结果保存

Qwen3-VL 完成后：

```text
AI Job
 ↓
Vision Result
 ↓
Activity
 ↓
JSON
```

例如：

```json
{
  "activity": "正在使用 VS Code 开发 Electron 应用",
  "summary": [
    "用户正在使用 VS Code",
    "当前正在编写 TypeScript 代码",
    "代码与 Electron 应用有关",
    "当前属于编程活动",
    "没有明显的娱乐活动"
  ],
  "category": "PROGRAMMING",
  "confidence": 0.91
}
```

必须保留：

```text
jobId
screenshotId
activityId
```

方便追踪。

---

# 十九、AI 失败时不要删除截图

例如：

```text
Screenshot
↓
保存成功
↓
AI Job
↓
Ollama失败
```

必须：

```text
截图保留
Job = FAILED
Activity 可以保持：
PROCESSING / ANALYSIS_FAILED
```

未来用户可以：

```text
Retry Analysis
```

重新分析。

---

# 二十、支持“重新分析”

为未来 UI 预留：

```text
reanalyzeScreenshot(screenshotId)
```

功能：

```text
历史截图
↓
重新创建 AI Job
↓
Queue
↓
Qwen3-VL
```

本阶段可以只实现 Service API。

UI 可以下一阶段再做。

---

# 二十一、Ollama 状态检查

Worker 在执行任务之前：

检查：

```text
Ollama 是否运行
```

如果：

```text
Ollama Offline
```

不要疯狂创建请求。

可以：

```text
Queue 保留 PENDING
Worker 暂停
```

等 Ollama 恢复后：

```text
Worker Resume
```

---

# 二十二、Ollama 模型检查

执行 SCREENSHOT_ANALYSIS 前检查：

```text
Qwen3-VL 8B 是否存在
```

如果不存在：

```text
Job = FAILED
errorCode = MODEL_NOT_FOUND
```

但是：

> 不影响截图继续执行。

---

# 二十三、AI Queue 与 Screenshot Scheduler 必须解耦

禁止：

```typescript
async function captureAndAnalyze() {
  const screenshot = await capture();
  await analyze(screenshot);
}
```

推荐：

```typescript
async function capture() {
  const screenshot = await captureScreenshot();

  if (!screenshot) {
    return;
  }

  await saveScreenshot(screenshot);

  await aiQueue.enqueue({
    type: "SCREENSHOT_ANALYSIS",
    payload: {
      screenshotId: screenshot.id,
      imagePath: screenshot.path
    }
  });
}
```

注意：

`enqueue()` 本身不能等待 AI 分析完成。

---

# 二十四、不要让 AI Queue 影响截图 Timer

例如：

```text
20秒 Timer
```

应该独立存在：

```text
ScreenshotScheduler
```

AI：

```text
AIWorker
```

两者独立生命周期。

---

# 二十五、增加 Queue Statistics

提供：

```typescript
getStats()
```

返回：

```json
{
  "pending": 10,
  "processing": 1,
  "completed": 120,
  "failed": 3,
  "retrying": 2,
  "cancelled": 0
}
```

以后 Dashboard 可以显示：

```text
AI Queue

Pending     10
Processing   1
Completed  120
Failed       3
```

---

# 二十六、增加最近任务日志

方便调试。

例如：

```text
13:20:00
Job abc123
SCREENSHOT_ANALYSIS
PROCESSING

13:20:08
Job abc123
COMPLETED

13:20:20
Job abc124
PROCESSING

13:20:21
Job abc124
FAILED
TIMEOUT
```

---

# 二十七、UI 增加 AI 状态

在现有 Dashboard 增加一个简单状态卡：

```text
AI Processing

● Running

Current:
Analyzing screenshot...

Queue:
8 pending

Completed:
324

Failed:
2
```

如果 Ollama 没启动：

```text
AI

○ Offline

Ollama is not running.
Screenshots will continue to be recorded.
```

非常重要：

UI 必须明确告诉用户：

> AI 不可用 ≠ 软件停止记录。

---

# 二十八、增加“AI 暂停”

预留：

```text
Pause AI
Resume AI
```

当：

```text
Pause AI
```

以后：

```text
截图继续
↓
新 Job 可以进入 Queue
↓
Worker 不处理
```

恢复：

```text
Resume AI
↓
Worker 继续
```

本阶段实现 Service 层即可。

---

# 二十九、Graceful Shutdown

Electron 关闭时：

```text
App Quit
 ↓
停止接受新的 AI Job
 ↓
停止 Screenshot Scheduler
 ↓
Worker 当前任务处理策略
 ↓
保存 Job 状态
 ↓
关闭 Storage
 ↓
退出 Electron
```

如果当前 Qwen3-VL 请求不能安全等待：

则：

```text
PROCESSING
```

下次启动恢复：

```text
PENDING
```

不要让任务丢失。

---

# 三十、测试要求

必须增加测试。

## Test 1

正常 Job：

```text
enqueue
↓
process
↓
COMPLETED
```

## Test 2

Ollama 不可用：

```text
enqueue
↓
worker
↓
失败
↓
retry
```

## Test 3

超过最大重试：

```text
retry 1
retry 2
retry 3
↓
FAILED
```

## Test 4

重复 Job：

```text
same screenshot
↓
enqueue
↓
enqueue
```

最终只能存在一个有效 Job。

## Test 5

Electron 重启：

```text
PROCESSING
↓
模拟 crash
↓
restart
↓
PENDING
```

## Test 6

AI 很慢：

模拟：

```text
analyze() = 60 seconds
```

同时：

```text
20 秒截图
20 秒截图
20 秒截图
```

必须全部正常产生截图。

## Test 7

AI 失败不能影响 Screenshot Scheduler。

## Test 8

Pause AI：

```text
AI paused
↓
截图仍然正常
↓
Queue 保留
↓
Resume
↓
继续处理
```

---

# 三十一、性能要求

默认：

```text
Worker concurrency = 1
```

不能：

```text
每个 Screenshot 创建一个新的 Worker
```

Worker 应该是：

```text
长期运行
```

即：

```text
AIWorker
   ↓
等待 Job
   ↓
处理
   ↓
等待 Job
   ↓
处理
```

而不是：

```text
Screenshot
 ↓
new Worker()
 ↓
结束

Screenshot
 ↓
new Worker()
 ↓
结束
```

---

# 三十二、内存泄漏检查

重点检查：

```text
setInterval
setTimeout
EventEmitter
IPC listener
Ollama request
Queue listener
Worker
```

确保：

```text
start()
```

不会重复注册 Listener。

例如：

```text
start()
start()
start()
```

最终只能存在一个 Worker。

---

# 三十三、日志要求

所有 Job 生命周期必须有日志：

```text
JOB_ENQUEUED
JOB_STARTED
JOB_COMPLETED
JOB_FAILED
JOB_RETRY
JOB_CANCELLED
WORKER_STARTED
WORKER_STOPPED
```

日志包含：

```text
jobId
jobType
timestamp
errorCode
```

但不要记录：

```text
截图内容
敏感信息
密码
完整 Prompt
```

---

# 三十四、架构要求

尽量形成：

```text
src/
├── main/
│
├── services/
│   ├── screenshot/
│   ├── ai/
│   │   ├── AIJobQueueService
│   │   ├── AIWorker
│   │   └── AIJobRepository
│   │
│   ├── ollama/
│   └── storage/
│
├── types/
│   ├── ai-job.ts
│   ├── activity.ts
│   └── screenshot.ts
│
└── renderer/
```

根据现有项目结构调整。

不要为了满足这个目录结构而机械移动大量代码。

---

# 三十五、不要重复实现 Ollama

当前项目已经有：

```text
Ollama
+
Qwen3-VL 8B
```

不要重新写一套 Ollama Client。

如果现有 Ollama Service 不够合理：

> 重构成统一 AI Provider。

例如：

```typescript
interface AIProvider {
  vision(input: VisionInput): Promise<VisionResult>;
}
```

然后：

```text
AIWorker
 ↓
AIProvider
 ↓
Ollama
 ↓
Qwen3-VL
```

这样未来可以换模型而不用修改 Queue。

---

# 三十六、本阶段不做的事情

明确不要实现：

```text
❌ Diary
❌ Memory
❌ RAG
❌ Agent
❌ Vector Database
❌ Todo
❌ Focus Mode
❌ Weekly Report
❌ Mobile App
❌ Cloud Sync
```

这些属于后续 Phase。

本阶段只完成：

> **可靠的 AI Job Queue。**

---

# 三十七、完成标准

只有同时满足以下条件，Phase 5 才算完成：

```text
[ ] Screenshot 与 AI 完全解耦

[ ] AI Job 有持久化状态

[ ] Queue 支持 PENDING

[ ] Queue 支持 PROCESSING

[ ] Queue 支持 COMPLETED

[ ] Queue 支持 FAILED

[ ] Queue 支持 RETRYING

[ ] Queue 支持 CANCELLED

[ ] 默认 Worker concurrency = 1

[ ] 支持 Retry

[ ] 支持 Timeout

[ ] 支持重复 Job 防护

[ ] 支持 Electron 重启恢复

[ ] Ollama Offline 不影响截图

[ ] Qwen3-VL 不存在不影响截图

[ ] AI 失败不删除截图

[ ] 支持重新分析 API

[ ] 支持 Pause AI

[ ] 支持 Resume AI

[ ] 支持 Queue Statistics

[ ] 有单元测试

[ ] npm test 通过

[ ] npm run typecheck 通过

[ ] npm run lint 通过

[ ] npm run build 通过
```

根据项目实际 package.json 中存在的脚本执行。

---

# 三十八、最终执行要求

现在开始执行 Phase 5。

但是必须遵循：

```text
第一步：
Review 当前代码

第二步：
告诉我当前 AI 分析流程是什么

第三步：
告诉我哪些代码需要修改

第四步：
给出实施计划

第五步：
开始编码

第六步：
运行测试

第七步：
修复测试发现的问题

第八步：
再次运行测试

第九步：
输出最终报告
```

最终报告必须包含：

```text
## 1. 本次完成的功能

## 2. 修改的文件

## 3. 新增的文件

## 4. AI Queue 架构

## 5. Job 状态机

## 6. Retry 策略

## 7. Electron 重启恢复机制

## 8. 测试结果

## 9. Build 结果

## 10. 已知问题

## 11. 下一阶段建议
```

**不要自动开始 Phase 6。**

完成 Phase 5 后停止，等待下一条指令。
