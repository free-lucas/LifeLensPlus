你现在是 Life Lens 项目的 Senior Electron + Node.js Engineer。

# Phase 7.3 — Timeline Filter & Search

## 一、当前状态

Life Lens 已完成：

* Screenshot Capture
* Screenshot Similarity Filter
* Ollama + Qwen3-VL 8B
* AI Job Queue / Recovery
* Structured AI Output
* SQLite Storage
* Timeline Data Layer（7.1）
* Timeline UI（7.2）

请先阅读当前实际代码，并运行现有测试，确认当前基线。

---

## 二、本阶段目标

为 Timeline 增加**搜索和筛选能力**。

最终用户可以从大量 Activity 中快速找到自己想看的记录。

核心能力：

### 1. 关键词搜索

支持搜索 Activity 中已有的文本信息，包括：

* Activity
* Summary
* Project
* Keywords

支持中文等 Unicode 文本。

空搜索时恢复正常 Timeline。

### 2. 时间筛选

至少支持：

* 今天
* 昨天
* 最近 7 天
* 自定义时间范围

时间判断基于 `captured_at`。

### 3. Category 筛选

支持现有 Activity Category。

不要重新定义 Category。

### 4. Project 筛选

根据已有数据提供 Project 筛选。

需要合理处理 `project = null` 的 Activity。

### 5. AI 状态筛选

至少支持：

* 全部
* 已完成
* 分析中
* 失败

### 6. 组合筛选

多个条件可以同时生效。

例如：

```text
最近 7 天
+ coding
+ Life Lens
+ SQLite
```

最终只显示符合条件的 Activity。

---

## 三、UI

继续复用 Phase 7.2 的 Timeline。

不要为了搜索创建另一套复杂页面。

用户应该能够：

* 输入关键词
* 选择筛选条件
* 查看结果
* 清除筛选
* 继续加载更多

没有搜索结果时显示明确的 Empty State。

---

## 四、实现原则

请根据当前实际代码自行判断最佳实现方式。

不要机械规定：

* 必须新增哪些文件
* 必须使用什么组件
* 必须使用什么 SQL 写法
* 必须增加什么 Service

优先复用现有 Timeline Data Layer 和项目已有架构。

搜索和筛选应尽可能在 Main / SQLite 层完成，**不要把全部历史数据加载到 Renderer 后再进行搜索。**

如果确实需要增加索引或调整查询结构，请根据实际情况判断，避免过度设计。

---

## 五、范围控制

本阶段不要实现：

* Semantic Search
* Embedding
* Vector Database
* RAG
* AI Search
* Memory
* Agent
* Daily Review
* Statistics Dashboard

本阶段只解决：

> **结构化搜索 + 时间 / Category / Project / Status 筛选。**

---

## 六、测试与验证

新增必要测试，至少覆盖：

* 关键词搜索
* 中文 / Unicode 搜索
* 时间范围
* Category
* Project
* AI Status
* 多条件组合
* 空搜索
* 无结果
* 分页 / 加载更多

确保原有测试全部通过。

完成后进行一次真实 Electron 验证：

```text
Timeline UI
→ Preload
→ IPC
→ Main
→ SQLite
→ Search / Filter
→ Timeline Results
```

所有测试数字和验证结果必须以实际运行结果为准，不要虚构。

---

## 七、完成后汇报

请汇报：

1. 修改了什么
2. 搜索 / 筛选 API 如何设计
3. UI 如何实现
4. 新增测试
5. 最终测试结果
6. Electron 验证结果
7. 是否发现后续需要处理的问题

核心原则：

**先理解现有代码，再做最小、合理的实现。具体技术方案由你自行判断。**





• 需求已按 Phase 7.3 文档实现完成，真实 Electron 验证与全部测试均通过。

  一、修改了什么

  - 数据层 src/main/db/repositories/ActivityRepository.js：queryTimeline 新增 search / category / project / noProject / status；新增
    normalizeFilterText、escapeLike、TIMELINE_STATUS_FILTERS、TIMELINE_SEARCH_* 与 listFacets()；WHERE 仍按 SQL 片段缓存 prepared statement。

  - IPC/Preload：新增通道 lifelens:timeline-facets 与 window.lifelens.getTimelineFacets()。
  - 渲染层：timeline.js 新增筛选纯函数与 createFilterBar，index.html 加 #timeline-filters 筛选栏，styles.css 配套样式。
  - 未改动 Recorder / AI Worker / AI Queue / SQLite schema，也没改 Phase 7.1 已有参数含义（只做加法）。

  二、搜索 / 筛选 API 设计

  - 关键词 col LIKE ? ESCAPE ? 四列（activity / summary / project / keywords_json）OR，%、_、\ 先转义再绑定；类别/项目精确 =；「无项目」project IS
    NULL OR project = ''；「分析中」analysis_status NOT IN ('COMPLETED','FAILED')；project 与 noProject 互斥时以 noProject 为准；空值与认不出的状
    态不加条件、不报错。

  - 时间仍走 Phase 7.1 的闭开区间 [from, to)；listFacets() 从已有数据 DISTINCT 取分类/项目并标记是否存在无项目记录。

  三、UI 实现

  - 单行筛选栏：搜索（300ms 防抖，回车立即生效）+ 时间范围 + 分类 + 项目 + 状态 + 清除筛选；选「自定义时间」才显示两个日期输入。
  - 条件变化重查第一页并刷新下拉（保留当前选择）；加载更多带同一组条件；空状态区分「没有记录」与「没有符合条件的记录」；新截图与 AI 回填先经
    matchesFilters 决定插入/移除。

  四、新增测试

  - test/timelineFilter.test.js 新增 12 例（四列命中、中文/emoji、通配符转义、时间、分类、项目含 NULL 与空串、状态三档、组合、空搜索、无结果、筛选
    下分页、facets、IPC 契约）。

  - test/timelineView.test.js 新增 4 例（parseDateInput、resolveTimeRange 含跨月、buildTimelineQuery/hasActiveFilters、matchesFilters）。
  - test/timeline.test.js 通道断言同步为两个通道。

  五、最终测试结果

  - npm test：# tests 119 / # pass 119 / # fail 0（Phase 7.2 基线为 103）。

  六、Electron 验证结果

  - 真实 electron.exe . + 42 条种子数据，链路 Renderer → Preload → IPC → Main → SQLite → 筛选结果，47/47 通过：首屏 20 条、搜索 SQLite 33 条 并翻
    完、中文搜索、无结果、清除筛选、今天 10 / 昨天 6 / 最近 7 天 34、自定义 10 与 16、learning 11、Life Lens 12、无项目 13、分析中 2、失败 1、已完
    成+今天 7、组合筛选 17、筛选栏单行不换行。

  - 过程中真实发现并修复两个样式问题：display:flex 盖掉 hidden 导致自定义日期框常显、窄窗口筛选栏换行。

  七、后续需处理的问题

  - LIKE 全表扫描，数据量上来后应换 FTS5；关键词非语义搜索（本阶段明确不做）。
  - 未分析记录四个可搜字段均为 NULL，任何关键词都搜不到（按状态筛选仍可见）。
  - 「无项目」不覆盖全空白字符串的 project；自定义范围只到「天」；分页仍是 offset 语义。

  文档

  - 新增 docs/13-Timeline搜索与筛选.md（功能与 API 说明）、docs/14-变更记录-Phase7.3.md（变更与验证记录）。
  - 更新 docs/README.md 索引，并在 docs/09-Timeline数据层.md:126、docs/11-Timeline界面.md:118 补充 Phase 7.3 交叉引用。

  改动都在工作区，未做 commit；需要的话我可以继续整理提交。

─ Worked for 19m 09s ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────