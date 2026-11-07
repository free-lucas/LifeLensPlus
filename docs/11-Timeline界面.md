# 活动时间线（Timeline UI）

Phase 7.2 把页面第 3 个 section 的「最近分析结果」升级成**活动时间线**：
在同一个窗口里按时间倒序回看自己的活动，截图内嵌展示，AI 状态实时更新。

时间线是**只读视图**：不写数据库、不触发分析、没有搜索 / 筛选 / 导航。

## 1. 位置与组成

```text
index.html
├── <section class="records">          ← 第 3 个 section，标题「活动时间线」
│   ├── <div id="timeline">            ← 时间线容器（JS 全量接管）
│   └── <button id="timeline-more">    ← 「加载更多」，hasMore 为 false 时隐藏
├── <script src="timeline.js">         ← 必须先于 renderer.js 加载
└── <script src="renderer.js">
```

| 文件 | 职责 |
| --- | --- |
| `src/renderer/timeline.js` | 时间线的全部逻辑：分页状态、渲染、缩略图失败回退、「查看截图」点击 |
| `src/renderer/renderer.js` | 只做事件转发：`record` / `analysis` → 时间线；「刷新」→ `reload()` |
| `src/renderer/index.html` | 容器结构 + CSP 放开 `img-src 'self' file:` |
| `src/renderer/styles.css` | `.timeline-*` 样式，复用既有玻璃卡片语言 |

## 2. 数据流

```text
首屏 / 「刷新」   → lifelensTimeline.reload()    → getTimeline({ limit: 20 })
「加载更多」      → lifelensTimeline.loadMore()  → getTimeline({ limit: 20, offset: 已加载条数 })
事件 record       → lifelensTimeline.prependRecord(record)          前插（按 id 去重）
事件 analysis     → lifelensTimeline.patchRecord(id, patch)          就地回填
```

- 数据只有一个来源：`window.lifelens.getTimeline(query)`（Phase 7.1 的 `lifelens:timeline` 通道）。
- **offset 不单独缓存**：下一次请求的 `offset` 就是「当前已加载条数」。新截图前插后这个数字自然 +1，
  服务端返回的页正好接在后面，不会重复也不会漏（新记录已经在前插时去重）。
- `hasMore` 以服务端返回为准。
- 首屏失败时不清空已有内容：错误只显示在时间线区域内。

## 3. 渲染规则

### 3.1 时间

- 时间一律用 `record.time`（= `captured_at`）转**本地时间**；不使用 `created_at` / `updated_at` / AI 完成时间。
- 组内条目显示 `HH:mm:ss`；组头显示 `YYYY-MM-DD 周X`，当天的组显示 `今天 · YYYY-MM-DD 周X`。
  截屏间隔是 20 秒，只到分钟会让同一分钟里的 2~3 条记录时间显示完全相同，看起来像重复截图。
- 没有相对时间（「3 分钟前」），也没有定时器刷新时间显示。

### 3.2 分组

- 分组在渲染层做（按本地日期字符串），不动 SQL、不动 7.1 的 API。
- 输入已经由数据层按 `captured_at DESC, id DESC` 排好；`groupByDay()` 只归组、不重排。
- 没有内容的组不会渲染组头。`time` 无法解析时归入「未知时间」组，不产生 `NaN-NaN-NaN` 组头。

### 3.3 卡片

```text
14:32:20  [✓ 已分析]                                   [查看截图]
┌──────────┐  学习技术文档                    ← analysis.activity
│ 截图缩略图 │  正在阅读 Ollama 相关技术资料…    ← analysis.summary
└──────────┘  分类 learning · 项目 Ollama · 把握 94%
              关键词：Ollama · GPU · batching
```

- `confidence` 用 `Math.round(confidence * 100)`：0.94 显示 `94%`。
- 字段缺失按「没有」处理：不显示该行，也不写占位文案；`keywords` 为空数组时不显示关键词行。

### 3.4 AI 状态

| `analysis_status` | 卡头标识 | 内容区 |
| --- | --- | --- |
| `PENDING` | ⏳ 分析中 | `分析中…` |
| `COMPLETED` | ✓ 已分析 | 结构化结果 |
| `FAILED` | ⚠ 分析失败 | `分析失败：<error> · <errorCode>` |
| 其他（如 `PROCESSING`）/ 缺失 | ⏳ 分析中（兜底） | `分析中…` |

FAILED 的记录照常出现在时间线里：截图已经发生，就是真实活动数据。

### 3.5 缩略图

- **纯 CSS 压缩**：固定 `168 × 104` + `object-fit: cover`，`loading="lazy"`；不生成任何小图文件。
- `imagePath` 是 Windows 绝对路径，渲染前转成 `file:///` URL：

```text
C:\Users\a b\中文#1.png
→ file:///C:/Users/a%20b/%E4%B8%AD%E6%96%87%231.png
   ↑ 三个斜杠，盘符冒号保留字面量，其余每一段单独 encodeURIComponent
```

- 图片加载失败（文件被移动 / 删除）只把这张图的区域换成「截图不可用」占位块，卡片与整条时间线不受影响。
  失败监听用 `addEventListener('error')`，**不用内联 `onerror`**——CSP 的 `script-src 'self'` 会拦掉内联事件。
- 「查看截图」按钮保留原有行为（系统查看器 + `outputDir` 白名单校验）。

### 3.6 Loading / Empty / Error

| 状态 | 表现 |
| --- | --- |
| 首屏加载中 | 时间线区域内显示「加载中…」 |
| 空数据 | 「还没有活动记录」+「Life Lens 会自动记录你的活动。」 |
| 查询失败 | 时间线区域内显示错误条；已加载的内容保留，页面不空白、渲染进程不崩 |

## 4. 页面交互

| 操作 | 结果 |
| --- | --- |
| 「刷新」 | `refreshAll()` 重新拉状态、AI 状态并 `timeline.reload()`（回到第一页） |
| 「加载更多」 | 追加下一页（20 条）；`hasMore === false` 时按钮隐藏 |
| 滚动 | 用懒加载让进入视口的缩略图才解码，没有无限滚动 |

## 5. 已知陷阱

- **全局作用域**：`renderer.js` 与 `timeline.js` 都是 classic script，共享同一个全局作用域。
  两边都定义了 `pad` / `escapeHtml` / `formatClock` 这类小工具，后加载的 `renderer.js`
  会覆盖先加载的 `timeline.js` 的同名函数（两边都有 `pad` / `formatClock`）。
  因此 `timeline.js` 整个文件包在 IIFE 里，`test/timelineView.test.js` 有一条用例守着这件事。
- **脚本顺序**：`timeline.js` 必须先于 `renderer.js`，否则 `window.lifelensTimeline` 还不存在。
- **offset 分页**：翻页期间若有新截图写入，靠「offset = 已加载条数」+ id 去重来保证不重不漏；
  真正的游标分页留给后续 Phase。

## 6. 这一阶段明确不做

reanalyze 按钮、缩略图生成管线、
导航结构（Tab / Sidebar）、虚拟列表、无限滚动自动加载、多语言、主题切换。

## 7. Phase 7.3 扩展：搜索与筛选

时间线上方新增筛选栏（关键词、时间范围、Category、Project、AI 状态、清除筛选），
搜索与筛选在 Main / SQLite 层完成，卡片渲染与实时事件规则沿用本文第 2~4 节。

筛选栏元素、交互约定、时间范围换算与已知限制见《[13-Timeline搜索与筛选](13-Timeline搜索与筛选.md)》。
