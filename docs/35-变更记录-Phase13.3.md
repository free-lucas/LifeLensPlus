# 变更记录：Phase 13.3 — 待机小镜接进悬浮入口的持续态

## 1. 这一阶段做了什么

Phase 13.2 之后小镜只演三个**瞬时态**（截完图 / 分析成功 / 出错），
素材目录里还躺着一只没做完的 `mascot-idle.svg`（0 个 SMIL、根节点残留 `class="glyph"`、没人引用）。

这一阶段做两件事：

| # | 做了什么 | 落在哪 |
| --- | --- | --- |
| 1 | 把待机素材从草图补成成品（家族第 4 只） | `src/renderer/assets/mascot-idle.svg` |
| 2 | 暂停录制（持续态）时让它上场，并一直演 | `launcher.html` / `launcher.css` / `launcher.js` |

第 2 件事推翻了 [30-悬浮窗特效](30-悬浮窗特效.md) 第 8 节原先「不给持续态加表情」那一条。
这是明确选过的方案 C（动画接入），代价与取舍见第 5 节。

> **后续（Phase 13.4）**：这一阶段定的「只在暂停时上场、并且一直演」已被推翻 ——
> 待机小镜改成了**默认脸**（录制中也在台上），时间轴方向也随之翻转（录制中在演、暂停冻住）。
> 见 [36-变更记录-Phase13.4](36-变更记录-Phase13.4.md)。本文件其余部分保留当时的原貌，
> 用来对照「当时为什么这么选」。

### 待机态与三个瞬时态的区别

| | 三个瞬时态 | 待机 |
| --- | --- | --- |
| 由谁驱动 | `effect-shutter` / `effect-success` / `effect-error` | `state-paused` |
| 上场时机 | 事件到来，弹一下 | 暂停录制期间**一直在** |
| 出场动画 | `mascot-pop`（演完自己淡出） | `mascot-in`（停在终态） |
| 谁回收 | `animationend` 摘 class | 不需要 —— class 由 `status` 事件维护 |
| 时间轴 | 演完 `freezeMascot()` | 暂停时 `playMascot()`，录制中 `freezeMascot()` |

`EFFECT_MASCOTS` 一个字节都没改（仍然只映射三个瞬时态）；
待机这只单独一个常量 `IDLE_MASCOT`，因为它的生命周期不从属那几个 class。

## 2. 生命周期归谁管

```text
载入            -> 四只全部 freezeMascot()（含待机：默认是「录制中」，它同样藏着）
status(true)    -> freezeMascot(idle)    pauseAnimations() + setCurrentTime(0)
status(false)   -> playMascot(idle)      setCurrentTime(0) + unpauseAnimations()
```

`playMascot()` 在 `prefers-reduced-motion` 下直接返回（小镜停在第 0 帧），
CSS 那边也把淡入去掉（`animation: none`）—— 待机小镜的显隐是纯 CSS 的，
不像瞬时态靠 `animationend` 回收 class，所以这里删掉动画不会把 class 卡住。

## 3. 改了什么

```text
新增：
  docs/34-小镜待机态.md               第 4 态的说明（几何 / 参数 / 符合性 / 接入方式 / 插件缺口）
  docs/35-变更记录-Phase13.3.md        本文件

修改：
  src/renderer/assets/mascot-idle.svg  草图 -> 成品（5029B、8 个 animate、64 个元素）
  src/renderer/launcher.html           内联第 4 份 SVG
  src/renderer/launcher.css            body.state-paused .mascot-idle 显出来 + .glyph 让位
                                       + 三个瞬时态下 .mascot-idle 退场（靠书写顺序压过前者）
                                       + @keyframes mascot-in + 降级块里 animation: none
  src/renderer/launcher.js             IDLE_MASCOT 常量、载入时冻住、applyState 里放开 / 冻回
  test/launcherMascot.test.js          小镜 5 / 小镜 6
  test/launcherView.test.js            悬浮特效 9 / 悬浮特效 10
  test/smoke/launcherMascotSmoke.cjs   STATES 加 idle + 「待机 1~7」
  docs/30-悬浮窗特效.md                 第 5 节补第 4 只、第 8 节撤销「不给持续态加表情」
  docs/32-小镜表情动画.md               指向第 4 态的交叉引用
  docs/README.md                       索引与一句话概览
```

## 4. 验证

### 4.1 单测

```powershell
npm test
# tests 335 / pass 335 / fail 0
```

新增 4 条：待机素材与内联副本逐行一致、CSS 只在 `state-paused` 时放它出来、
暂停时放开时间轴、待机与瞬时态互不干扰。
其中「小镜 6」除了盯显隐规则，还把**规则顺序**钉住了（退场那条必须写在上场那条之后，
两边特异性相同，顺序就是优先级）。

### 4.2 真实 Electron 冒烟

```powershell
node_modules\electron\dist\electron.exe test\smoke\launcherMascotSmoke.cjs
```

`PASS 30 / FAIL 0`。待机这一段的原样输出：

```text
PASS  待机 1 暂停录制 -> state-paused 挂上 body class
        body="state-paused"
PASS  待机 2 待机小镜的时间轴被放开
        {"paused":false,"at":0.15}
PASS  待机 3 待机期间三只瞬时态小镜仍冻着
PASS  待机 4 淡入用的是 mascot-in（不是演完会自己消失的 mascot-pop）
        animationName=mascot-in
PASS  待机 5 待机小镜一直在演（时间轴在前进）
        0.15s -> 0.667s
PASS  待机 6 待机期间来瞬时事件：瞬时态那只上场、待机这只退场
        {"idle":"hidden","smug":"visible"}
PASS  待机 7 恢复录制 -> 换回 state-running，待机小镜冻回第 0 帧
        body="effect-shutter state-running" idle={"paused":true,"at":0}
```

### 4.3 视觉确认

用无头浏览器载入**真实的** `launcher.html`（只把 `<body>` 换成 `class="state-paused"`，
markup 与 CSS 全部是真实的），按 8 倍与 1:1 各看一次：

| 倍率 | 看什么 | 结论 |
| --- | --- | --- |
| 8x | 待机脸的整体观感 | 下垂眼、抿嘴、腮红、右上角的 z 都清楚；`state-paused` 的降亮降饱和让它读成「睡着的小镜」 |
| 1:1（52px 圆标） | 真实尺寸下还认不认得出 | 认得出，与原来那颗光圈圆标同一量级的可读性 |

再看一次**待机 + 瞬时态同时挂着**（`state-paused effect-shutter`）：

| 倍率 | 看什么 | 结论 |
| --- | --- | --- |
| 8x | 会不会两张脸叠在一起 | 只有得意那张；待机脸完全不在（`visibility: hidden`），**没有叠脸** |
| 1:1（52px 圆标） | 真实尺寸下的观感 | 同样只有一张脸，读得清 |

对照组（不加 class）确认没有回归：仍然是那颗亮着的霓虹光圈圆标。

## 5. 已知问题与取舍

- **「完全静止」这个信号没有了。** 这是选方案 C 的直接代价：待机不再一眼看出「它不动」。
  顶上来的替代信号是**亮度**（`brightness(0.62) saturate(0.72)` 照旧生效），
  所以待机小镜是暗的、去饱和的 —— 想让它更亮，就得同时想清楚拿什么替代「未录制」的提示。
- **常驻窗口会一直跑动画。** 待机期间 SMIL 一直在走（这正是方案 C 想要的效果），
  而这是个常驻置顶的 56x56 窗口。面积很小，实测没有可感负担；
  但这是 Phase 13.2「藏起来的 SVG 不该空转」那条原则的一处**有意例外**：
  待机这只在可见时本来就该演，看不见时（录制中）照样冻着。
- **`.ball` 上的 `filter` 会让这层持续重绘。** 待机时 `.ball` 挂着 `filter`，
  里面又有一个一直在动的 SMIL，浏览器要按帧重栅格化这一层。
  56x56 的量级可以忽略；将来球体变大，这是一个要先量一下的点。
- **Figma 生成式插件里的第 4 态还没补。** 家族的源头是那个插件，
  现在 `mascot-idle.svg` 是手写对齐家族骨架的产物，还没反向进插件。
  Figma MCP 这次被套餐限流（Starter 计划 20 次/月），补不了；
  要动的地方列在 [34-小镜待机态](34-小镜待机态.md) 第 6 节。
- **「谁退场」靠书写顺序，不靠特异性。** 待机上场与瞬时态退场这两条的特异性完全一样
  （都是 0,2,1），压得住纯粹是因为退场那条写在后面。将来若有人把 CSS 重排 / 格式化，
  这两条**必须保持这个前后关系**（`test/launcherMascot.test.js` 会拦住）。
- **`error` 仍然借用「思考」**（Phase 13.2 的老问题），本阶段没动。

功能与架构说明见 [34-小镜待机态](34-小镜待机态.md)、
[30-悬浮窗特效](30-悬浮窗特效.md) 与 [32-小镜表情动画](32-小镜表情动画.md)。