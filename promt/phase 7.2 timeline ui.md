你现在是 Life Lens 项目的 Senior Electron + Node.js Engineer。

# Phase 7.2 — Timeline UI

## 基于 Phase 7.1 已完成的 Timeline 数据层，把 Activity 数据做成一个清晰、直观、真正可用的 Timeline 界面。

---

# 一、当前项目状态（已核实，以实际代码为准）

已完成：

* Phase 1-5.2：截图 / 相似过滤 / Ollama / AI Job Queue / Recovery / Structured Output
* Phase 6：SQLite Storage
* Phase 7.1：Timeline Data Layer

测试基线：

```text
npm test → 92 / 92 PASS
```

以你实际运行结果为准。

Phase 7.1 已落地的数据层（直接使用，不要重新设计）：

```text
window.lifelens.getTimeline(query)
  → IPC lifelens:timeline
  → ActivityRepository.queryTimeline({ from, to, limit, offset })
  → { items, total, limit, offset, hasMore }
```

* `items` 字段与 `lifelens:recent` 返回完全同形：`id`（= screenshotId）、`time`、`imagePath`、`analysisStatus`、`analysis`（activity / summary / category / project / keywords / confidence 或 null）、`summary`、`model`、`analysisMs`、`error`、`errorCode`
* `from` / `to` 接受 Date / 毫秒时间戳 / 可解析时间字符串，Repository 内部已归一化
* 排序固定 `captured_at DESC, id DESC`

现有 Renderer 结构（必须先读懂再动手）：

* [index.html](../src/renderer/index.html)：单页线性布局 —— 控制面板 → 统计卡片 → AI 队列 → 「最近分析结果」`#list`
* [renderer.js](../src/renderer/renderer.js)：无框架、无打包器，`escapeHtml` + `innerHTML` 模板渲染；`onEvent` 事件流实时更新列表
* [styles.css](../src/renderer/styles.css)：已有 `.panel` / `.record` / `.pill` / `.stat-card` / `.badge` 等成套样式，直接复用
* 窗口 1040×880

---

# 二、关键决策（已定，不要重新讨论，不要偏离）

以下决策已经确定。你的职责是正确执行它们，不是重新权衡。

## 决策 1 — Timeline 替换「最近分析结果」区域

现有 `#list`「最近分析结果」本身就是一个迷你 Timeline。本阶段把它**升级替换**为 Timeline 面板（保留在同一位置，作为页面第 3 个 section）。

* 禁止：另建一个平行的新列表（页面上不允许出现两个几乎一样的活动列表）
* 禁止：引入导航结构（Tab / Sidebar / 视图切换）—— 本应用还没有导航，本阶段也不做
* 现有 `records.slice(0, 30)` 的内存列表逻辑随本次替换迁移为分页状态

## 决策 2 — 截图内嵌展示的技术路线

当前 UI 从不内嵌图片（只有「查看截图」按钮走 `shell.openPath`）。Timeline 要内嵌 `<img>`，按以下路线执行：

1. 修改 [index.html](../src/renderer/index.html) 的 CSP：

```text
img-src 'self'  →  img-src 'self' file:
```

只改这一项，不动其他 CSP 指令。

2. `imagePath` 是 Windows 绝对路径，转成 `img.src` 时必须正确生成 `file:///` URL：

* 反斜杠 → 正斜杠
* 盘符形式必须是 `file:///C:/...`，不是 `file://C:/...`
* 中文 / 空格 / `#` 等字符必须逐段 `encodeURIComponent`
* 写进 HTML 时沿用 `escapeHtml`

3. 「查看截图」按钮保留现状（系统查看器 + outputDir 白名单校验），不要删。

4. 若 Electron smoke 验证发现 `file:` 仍被拦截：先在报告中说明，再改用自定义 privileged scheme 方案。禁止为了绕开 CSP 把 `img-src` 放开到 `*`。

## 决策 3 — 缩略图 = 纯 CSS

* 用 CSS 限制图片显示尺寸（固定缩略高度，宽度自适应，`object-fit: cover`）
* `<img loading="lazy">`
* 图片加载失败（文件被移动 / 删除）：`onerror` 显示占位块，禁止让整张卡片或整个 Timeline 崩溃
* 禁止：实现任何缩略图生成管线（生成小图文件属于后续阶段）

## 决策 4 — 实时更新接入现有事件流

Timeline 不是静态快照。复用现有 `onEvent`（[renderer.js](../src/renderer/renderer.js)）：

* `analysis` 事件：按 `screenshotId` 匹配已加载的卡片，就地回填（状态、结构化结果、失败原因），与现有 `renderRecords` 的 patch 语义一致
* `record` 事件：新记录前插到 Timeline 顶部（检查 `id` 去重）
* 分页 offset 规则：**下一次请求的 offset = 当前已加载条数**（每次前插后自然 +1），不要单独缓存服务端 offset 数字；`hasMore` 仍以服务端返回为准

## 决策 5 — 时间展示与分组

* 所有展示时间用 `record.time`（即 captured_at）转本地时间，**禁止**用 created_at / updated_at / AI 完成时间
* 按自然日分组（本地时区），组头显示 `YYYY-MM-DD 周X`（当天的组可显示「今天」）
* 组内条目倒序，时间显示 `HH:mm`
* 禁止用相对时间（「3 分钟前」）作为 Timeline 主时间
* 不需要定时器轮询刷新时间显示

## 决策 6 — 本阶段不做 reanalyze 按钮

`lifelens:ai-reanalyze` IPC 已就绪，但 UI 接入属于后续阶段。本阶段 Timeline 卡片上**不要**加「重新分析」按钮。

## 决策 7 — 代码组织遵循现有模式

* 无框架、无打包器、无 ESM、无构建步骤
* Renderer 逻辑可以拆出新文件 `src/renderer/timeline.js`，用普通 `<script>` 标签引入（放在 renderer.js 之前或之后，注意加载顺序）
* CSS 追加到现有 [styles.css](../src/renderer/styles.css)，复用现有类与视觉语言，不引入 CSS 框架
* 用户不可配置项（页大小、分组样式等）不要做成设置

---

# 三、核心功能

用户打开 Life Lens 后，在同一页面即可按时间倒序浏览自己的活动：

```text
2026-09-14 周一

14:32
┌────────────────────────────────┐
│ [截图缩略图]                    │
│ 学习技术文档                    │
│ 正在阅读 Ollama 相关技术资料     │
│ 分类 learning · 项目 Ollama · 把握 94% │
│ 关键词：Ollama · GPU · batching │
│ [查看截图]                      │
└────────────────────────────────┘

14:31
┌────────────────────────────────┐
│ ...                            │
└────────────────────────────────┘

[加载更多]
```

具体视觉细节（卡片布局、密度、间距）可以基于现有 `.record` 样式自行调整，但上述结构要素（缩略图、时间、Activity、Summary、meta、keywords、查看截图）必须齐全。

---

# 四、Activity 展示

每张卡片至少展示：

* 截图缩略图（决策 2 / 3）
* 时间（决策 5）
* `analysis.activity`（主标题）
* `analysis.summary`
* meta 行：分类 / 项目 / 把握百分比（`Math.round(confidence * 100)`，0.94 显示 94% 不是 0.94%）
* keywords（`analysis.keywords` 数组，空数组不显示该行）
* AI 状态标识（见第六节）

字段缺失时按「没有」处理（现有 `renderAnalysisBody` 已是这个语义，直接复用或对齐它），不要用占位文案假装有值。

---

# 五、日期与时间

见决策 5。补充：

* 分组在渲染层做（按本地日期字符串分组），不要为了分组改 SQL 或 7.1 API
* 空的分组（理论上不会出现）不要渲染组头

---

# 六、AI 状态

Activity 的 `analysisStatus` 实际只有三个值（与数据库写入一致）：

```text
PENDING    → ⏳ 分析中
COMPLETED  → ✓ 已分析
FAILED     → ⚠ 分析失败（展示 error / errorCode）
```

* 若数据中出现 `PROCESSING`（当前不会写入），按「分析中」兜底展示即可，不要为它造数据或加专门 UI
* **FAILED 的 Activity 必须出现在 Timeline 中**——截图已经发生，就是真实活动数据
* PENDING 的 Activity 正常展示卡片，AI 内容区域显示「分析中…」
* 状态变化通过决策 4 的 `analysis` 事件就地更新，从 PENDING 变成 COMPLETED / FAILED 时用户无需手动刷新

---

# 七、加载更多

* 首屏：`getTimeline({ limit: 20 })`（与现有 recent 默认一致）
* 「加载更多」按钮：每次 `limit: 20`，`offset` 按决策 4 的规则计算
* `hasMore === false` 时隐藏按钮
* 禁止：一次性加载全部、虚拟列表、无限滚动自动化（按钮方案足够；滚动加载不做）

---

# 八、Loading / Empty / Error

* **Loading**：首屏加载期间 Timeline 区域显示「加载中…」，不允许长时间空白或布局跳动
* **Empty**：没有数据时显示明确空状态，文案：

```text
还没有活动记录
Life Lens 会自动记录你的活动。
```

* **Error**：查询失败时在 Timeline 区域内显示错误提示（可复用现有 `showError` 模式），已加载的内容保留，禁止 Renderer 崩溃、禁止空白整个页面

---

# 九、UI 原则

* 这是第一个日常使用的核心页面：简洁、清晰、信息密度合理
* Screenshot 是视觉主元素，但不能喧宾夺主盖过 Activity 信息
* 不要堆砌按钮，不要复杂动画，优先可用性
* 视觉上融入现有页面（同一套配色 / 字号 / 卡片语言），不要看起来像另一个应用

---

# 十、实现边界（硬性限制）

允许：

* 修改 [index.html](../src/renderer/index.html)（CSP 一项 + Timeline section 结构替换 `#list` 区域）
* 新增 [src/renderer/timeline.js](../src/renderer/timeline.js)、追加 [styles.css](../src/renderer/styles.css)
* 调整 [renderer.js](../src/renderer/renderer.js) 中因 `#list` 替换受影响的部分（records 状态、事件处理迁移）
* 与 Timeline 直接相关的小范围 bug 修复（必须在报告中逐条列出）

禁止：

* 修改 Main Process 架构、Recorder、AI Worker、AI Queue、SQLite schema
* 修改 7.1 的 `queryTimeline` / `getTimeline` 契约（发现缺陷先报告，不要顺手改）
* 引入任何新依赖、框架、打包器、测试框架
* 实现：Timeline 搜索、Category / Project 筛选、高级时间筛选、日期选择器、Semantic Search / Embedding / Vector / RAG / Memory、Daily Review、Statistics Dashboard、Todo、Focus、Productivity Score、Agent、reanalyze 按钮、缩略图生成管线、导航结构、主题切换、多语言

---

# 十一、测试

* 回归：`npm test` 必须 92 / 92 全部通过（以实际运行为准），不得删改旧测试来"保持通过"
* 数据层查询已由 Phase 7.1 测试覆盖，本阶段**不要求**新增 Renderer DOM 自动化测试
* 可选（不强求）：把纯函数逻辑（imagePath → file URL 转换、日期分组）抽成可独立 require 的模块，用现有 `node --test` 体系加少量测试
* Electron smoke 验证见下一节，这是本阶段的主要验证手段

---

# 十二、Electron 实际验证（必须）

真实 Electron 环境逐项确认：

```text
1. Timeline 首屏加载，缩略图真实渲染出来（CSP 修改生效的直接证据）
2. 有数据时：卡片信息完整（时间 / Activity / Summary / meta / keywords）
3. 按自然日分组、倒序正确
4. PENDING 卡片显示「分析中」，FAILED 卡片存在且显示失败原因
5. 「加载更多」翻页正确，无重复、无遗漏
6. 应用运行中：新截图的卡片自动出现在顶部；AI 完成后该卡片就地从「分析中」变为结果
7. 空数据库（临时指向空目录）显示空状态
8. 图片文件缺失的卡片显示占位，页面不崩溃
```

第 6 项必须真实跑一轮录制（≥ 1 分钟）验证，不能只靠静态数据。

---

# 十三、完成后汇报

1. 测试基线（Before / After 实际数字）
2. 实际修改了什么（按文件列出 + 职责）
3. 相对现有 UI 的改动清单（`#list` 替换、CSP 修改、事件迁移等逐条）
4. 截图加载方案的实际实现（file URL 转换、失败占位）
5. 分页 / 实时更新的实现方式
6. 是否偏离关键决策（二）：每条决策标注「遵守」或说明偏离原因
7. 新增 / 修改的测试（如有）
8. Electron 验证逐项结果（第十二节的 8 项）
9. Scope Check：

```text
搜索 / 筛选 / 统计 / RAG / Memory / Agent / 导航 / reanalyze UI / 缩略图管线: NOT IMPLEMENTED
```

10. 发现的后续 Phase 需要处理的问题

不要虚构测试结果。

---

## 最重要的原则

**先读懂现有 Renderer，再动手。关键决策（第二节）已定，执行它们。**

**保持实现简单，不要过度设计。**

**Phase 7.2 的完成标准不是"代码写完"，而是用户打开 Life Lens 后，可以真正通过 Timeline 回顾自己的活动——包括看到截图、看到分析结果、看到实时变化。**
