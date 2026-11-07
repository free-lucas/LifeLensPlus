# 变更记录：Phase 13.2 — 小镜三态接进悬浮入口的瞬时特效

## 1. 这一阶段做了什么

Phase 13.1 的三个瞬时特效只有「光圈 + 变色」：截图后闪一圈白、分析成功闪绿画个对勾、
出错红闪一下。这一阶段把已经设计好的**小镜三态表情动画**真正接到这三个瞬时态上 ——
截完图小镜得意一下、分析成功换成笑脸、出错时一脸疑惑。

四件事，缺一件都不成立：

| # | 做了什么 | 落在哪 |
| --- | --- | --- |
| 1 | 三份 SVG 落盘 | `src/renderer/assets/mascot-{smug,thinking,happy}.svg` |
| 2 | 原样内联进页面，各包一层 `.mascot` 容器 | `src/renderer/launcher.html` |
| 3 | 默认藏起来，只在对应的瞬时态里弹一下 | `src/renderer/launcher.css` |
| 4 | SMIL 时间轴的「拨回第一帧 / 放开 / 冻住」 | `src/renderer/launcher.js` |

素材来源是 Figma 生成式插件「LifeLens 小镜表情动画」，几何、色板与插件本体见
[32-小镜表情动画](32-小镜表情动画.md)。

### 三态与事件

| 瞬时态 class | 触发事件 | 小镜 | 表情 | 时长 |
| --- | --- | --- | --- | --- |
| `body.effect-shutter` | `record`（刚截完一张图） | `mascot-smug` | 得意（wink + 挑嘴角） | 0.4s |
| `body.effect-success` | `analysis`（AI 结果写回） | `mascot-happy` | 开心（月牙眼 + 张嘴笑 + 对勾徽章） | 0.6s |
| `body.effect-error` | `error` | `mascot-thinking` | 思考（扫视 + 高低眉 + 思考气泡） | 0.5s |

事件通道一个字节都没改：仍然是 Phase 13.1 的 `lifelens:launcher-event`，
仍然是 `{ type }`。小镜只是给已有的三个 class 加了「谁来演」。

### 为什么内联，不用 `<img>`

[32-小镜表情动画](32-小镜表情动画.md) 第 7 节原先建议用 `<img src="./assets/mascot-*.svg">`，
**这条路在本仓库走不通**，三个理由：

1. **CSP 会拦掉它。** `launcher.html` 的 CSP 是 `default-src 'none'; script-src 'self'; style-src 'self';`，
   没有 `img-src`，`<img>` 走 `default-src` 的兜底 —— 加载被拒。
   要放开就得改 CSP；而这条 CSP 是「这个页面不加载任何外部资源」的书面承诺，不该为了贴图破例。
2. **`<img>` 里的 SMIL 不受控。** 它自己从头开始循环，没有 `animationend`，
   也没有办法在事件到来的那一刻把它拨回第一帧 —— 用户看到的是「随机某一帧」，不是「从头演一遍」。
3. **内联才能按次重播。** 内联之后 `<svg>` 是个真实 DOM 节点，可以调
   `setCurrentTime(0)` / `unpauseAnimations()` / `pauseAnimations()`，
   于是「每次事件都从第一帧开始」变成一件确定的事。

代价是同一份图形有两个落点（assets 与 HTML），所以加了
`test/launcherMascot.test.js` 逐行比对，让「两边不一致」在 `npm test` 里直接红。

## 2. 小镜的上下台时机

关键前提：**SMIL 没有 `animationend`**。而 Phase 13.1 的回收机制完全建立在
`animationend` 上（class 在光圈动画结束时被摘掉）。所以没有把生命周期搬到 JS，
而是让两只手各管一段：

```text
光圈那条 CSS 动画（shutter-ring / success-ring / error-ring）
  -> animationend -> 摘掉 class（Phase 13.1，未改）
  -> 同时 freezeMascot()：pauseAnimations() + setCurrentTime(0)

playEffect(name)
  -> 挂上 class（Phase 13.1，未改）
  -> 同时 playMascot()：setCurrentTime(0) + unpauseAnimations()
```

由此得到三条必须守住的约束：

1. **小镜的出场动画时长必须等于对应光圈的时长**（`mascot-pop` 用
   `animation-duration` 跟着改）。两边不同长就会出现「光圈还在扩、小镜已经没了」。
2. **小镜的 CSS 动画不能是 `animation: none`**（reduced-motion 下也一样），
   理由与 Phase 13.1 相同：它虽然不是回收的触发者，但也不能因为被删掉而让画面卡在中间。
3. **`prefers-reduced-motion` 下不放时间轴**：小镜停在自己的第一帧（那一帧本来就是完整构图，
   见 32 号文档第 4 节），只由 CSS 淡入淡出 —— 不蹦、不扫视、不跳。

JS 侧的四个小函数（`src/renderer/launcher.js`，都在 `createLauncherView` 里）：

| 函数 | 做什么 |
| --- | --- |
| `mascotOf(state)` | `.mascot-<state> > svg`，找不到返回 `null` |
| `isTimeline(node)` | 三个 SMIL 入口是否齐全；缺一个就整个放弃，只靠 CSS 演 |
| `freezeMascot(node)` | `pauseAnimations()` + `setCurrentTime(0)` |
| `playMascot(node)` | `setCurrentTime(0)` + `unpauseAnimations()`（reduced-motion 下直接返回） |

页面一加载就把三只全部冻住（`for (const state of Object.values(EFFECT_MASCOTS)) freezeMascot(...)`）：
一个 56x56 的常驻窗口里，三只藏着的 SVG 不该自己空转。

`EFFECT_MASCOTS` 是新增的第三张映射表，键与 `EFFECT_CLASSES` 的值一一对应：

```js
const EFFECT_MASCOTS = Object.freeze({
  'effect-shutter': 'smug',
  'effect-success': 'happy',
  'effect-error': 'thinking',
});
```

## 3. 新增与修改的文件

```text
新增：
  src/renderer/assets/mascot-smug.svg      得意（0.4s 瞬时态用）
  src/renderer/assets/mascot-thinking.svg  思考（0.5s 瞬时态用）
  src/renderer/assets/mascot-happy.svg     开心（0.6s 瞬时态用）
  test/launcherMascot.test.js              素材与内联副本的一致性（4 项）
  test/smoke/launcherMascotSmoke.cjs       真实 Electron 冒烟（23 项）
  docs/33-变更记录-Phase13.2.md            本文件

修改：
  src/renderer/launcher.html   内联三只小镜（各包一层 span.mascot）
  src/renderer/launcher.css    .mascot 的显隐 / mascot-pop / mascot-fade / reduced-motion 降级
  src/renderer/launcher.js     EFFECT_MASCOTS + mascotOf / isTimeline / freezeMascot / playMascot
  docs/30-悬浮窗特效.md         加一节「小镜三态」并更新文件清单
  docs/32-小镜表情动画.md       第 7 节改写（内联而不是 img）、第 9 节勾掉已完成项
  docs/06-测试与验证.md         用例数 + 新增用例行 + Phase 13.2 验证一节
  docs/README.md               索引
```

`src/main/*`、`src/launcherPreload.js` 一行未改：事件通道与载荷保持 Phase 13.1 的样子。

## 4. 验证

### 4.1 自动化（`npm test`）

```text
tests 331 / pass 331 / fail 0
```

新增的 `test/launcherMascot.test.js` 4 项：

| # | 断言 |
| --- | --- |
| 小镜 1 | `EFFECT_MASCOTS` 的三条映射；三份素材存在、以顶格的 `<svg ` 开头（即无 BOM、无 XML 声明） |
| 小镜 2 | 三份素材与 `launcher.html` 里的内联副本**逐行一致**（忽略缩进） |
| 小镜 3 | 内联到同一个文档后 `id` 不重复（三份 SVG 的渐变 / 裁切 id 都带状态后缀） |
| 小镜 4 | `.mascot` 默认 `opacity: 0` + `visibility: hidden`；每个瞬时态只放自己那只，且出场动画是 `mascot-pop` |

### 4.2 真实 Electron 冒烟（`test/smoke/launcherMascotSmoke.cjs`）

```powershell
node_modules\electron\dist\electron.exe test\smoke\launcherMascotSmoke.cjs
```

真实 `launcher.html` + 真实 `src/launcherPreload.js` + 真实 IPC 通道，
事件由主进程按生产路径发出。不碰数据库、不碰 AI，几秒跑完。`PASS 23 / FAIL 0`。

下面是某一次运行的原样输出（class 存活时长每次会有几十毫秒抖动，属正常调度噪声）：

```text
PASS  1 初始态：三只小镜都停在第 0 帧（藏着的 SMIL 不空转）
        {"smug":{"paused":true,"at":0},"thinking":{"paused":true,"at":0},"happy":{"paused":true,"at":0}}
PASS  record -> effect-shutter 挂上 body class
PASS  effect-shutter 期间 smug 的时间轴被放开
        {"paused":false,"at":0.083}
PASS  effect-shutter 期间另外两只小镜仍冻着
PASS  shutter-ring 之后 effect-shutter 被回收
PASS  effect-shutter class 存活 415ms（期望约 400ms）
PASS  effect-shutter 演完后 smug 重新冻住
        {"paused":true,"at":0}
PASS  analysis -> effect-success 挂上 body class
PASS  effect-success 期间 happy 的时间轴被放开
        {"paused":false,"at":0.1}
PASS  effect-success 期间另外两只小镜仍冻着
PASS  success-ring 之后 effect-success 被回收
PASS  effect-success class 存活 616ms（期望约 600ms）
PASS  effect-success 演完后 happy 重新冻住
        {"paused":true,"at":0}
PASS  error -> effect-error 挂上 body class
PASS  effect-error 期间 thinking 的时间轴被放开
        {"paused":false,"at":0.083}
PASS  effect-error 期间另外两只小镜仍冻着
PASS  error-ring 之后 effect-error 被回收
PASS  effect-error class 存活 515ms（期望约 500ms）
PASS  error-ring 演完后 thinking 重新冻住
        {"paused":true,"at":0}
PASS  4 prefers-reduced-motion：出场动画降级成纯淡入淡出
        animationName=mascot-fade
PASS  5 prefers-reduced-motion：小镜时间轴不放开（停在第 0 帧）
        {"paused":true,"at":0}
PASS  6 prefers-reduced-motion：特效 class 照常挂上
PASS  7 prefers-reduced-motion：class 仍然被回收

--- 结果 ---  PASS 23 / FAIL 0
```

### 4.3 视觉确认（冻结帧）

用 Electron 无窗口渲染真实的 `launcher.html`，把 CSS 动画与小镜 SMIL 都钉在一个时刻再截图
（`document.getAnimations()` 逐个 `pause()` 并设 `currentTime`；小镜用
`pauseAnimations()` + `setCurrentTime()`）。两种倍率各看一次：

| 倍率 | 看什么 | 结论 |
| --- | --- | --- |
| 1:1（52px 圆标） | 五官在真实尺寸下还认不认得出 | 认得出：月牙眼、张嘴、腮红都清楚 |
| 8x | 构图与小镜相对球体的比例 | 小镜的头部圆落在球体内部，虚线轨道环贴着球体边缘，与原来的光圈图标是同一套视觉语言 |

同时确认了空闲态没变：不加 class 时页面上只有原来那颗光圈圆标。

## 5. 已知问题与取舍

- **`error` 借用了「思考」这只小镜**，没有专门的沮丧态。
  一个 0.5 秒的红闪配「小镜一脸疑惑」读起来是「咦？」，说得通；
  但真要做出错态，得回插件补第四只（32 号文档第 9 节留着这一条）。
  改的时候要注意：`EFFECT_MASCOTS` 的键是 `EFFECT_CLASSES` 的值，
  加一只就要同时加素材、加 HTML 容器、加 CSS 规则。
- **「分析中」没有持续态的思考表情。** 用户最初的三态里，「分析中」是个持续态，
  但 launcher 目前只收得到 `status.running`（= 正在录制），收不到「AI 队列非空」。
  要让录制期间一直显示思考脸，得在 `launcherEventOf` 的白名单里加一个 AI 队列事件 ——
  那会改动最小暴露的边界，属于独立的一次改动，本阶段没做。
- **小镜常驻 DOM 的解析成本。** 三份 SVG 合计约 17KB，页面从 2.6KB 涨到 22.8KB。
  对一个只在启动时解析一次的本地页面来说可以接受；换来的是「不新增任何运行时依赖」。
- **窗口被隐藏时，老的 class 回收问题照旧。** 隐藏窗口里 Chromium 会节流 CSS 动画，
  光圈不动 -> `animationend` 不发 -> class 留在 body 上（Phase 13.1 就有）。
  本阶段新增的只是：这种情况下小镜的时间轴也不会被冻回去。
  真实场景里悬浮入口平时是可见的，只有用户主动关掉它才会隐藏，影响有限。
- **颜色与动效本身没有断言。** 冒烟断言的是 class 与时间轴状态，
  画面好不好看靠 4.3 的冻结帧肉眼确认。

更完整的功能与架构说明见 [30-悬浮窗特效](30-悬浮窗特效.md) 与
[32-小镜表情动画](32-小镜表情动画.md)。
