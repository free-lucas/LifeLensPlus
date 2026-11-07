# 变更记录：Phase 13.4 — 待机小镜改成悬浮球的「默认脸」

## 1. 这一阶段做了什么

Phase 13.3 把待机小镜接进了悬浮入口，规则是「**只在暂停录制时上场，并且一直演**」。
上线后立刻暴露一个问题：**启动应用后根本看不到这只待机小镜**。

用户反馈：*「为啥我启动以后待机图标没替换成 `mascot-idle.svg`？」*

### 根因

`src/main/config.js` 第 11 行的默认配置是 `autoStart: true` —— 应用一启动就开始录制，
`status.running` 立刻是 `true`，`body` 上挂的是 `state-running`。
而 Phase 13.3 的 CSS 只在 `state-paused` 下放待机小镜出来：

```css
body.state-paused .mascot-idle { visibility: visible; opacity: 1; }
```

于是**默认路径（启动即录制）下这张脸永远不上场**，只有手动右键「暂停-恢复录制」
才看得到。脚本没写错，是「什么时候该出场」这件事本身立不住。

### 两个方案

| 方案 | 做法 | 结果 |
| --- | --- | --- |
| A. 改配置 | 把 `autoStart` 默认改成 `false`，应用启动即暂停 | 待机小镜一启动就可见；但**改变了产品的核心行为**（默认不再自动记录），代价太大 |
| B. 改语义（**本次采用**） | 待机小镜改成悬浮球的**默认脸**：录制中与暂停时都在台上，只在三个瞬时态时让位 | 启动即见；「在不在录」改由亮度 / 扫光 / 时间轴表达 |

选 B：用户要的是「一启动就看到小镜」，而不是「一启动就停止录制」。

## 2. 默认脸是什么意思

| | Phase 13.3 | Phase 13.4（现在） |
| --- | --- | --- |
| 谁在台上 | 只有暂停时是待机小镜，录制中还是那颗霓虹光圈圆标 | **录制中与暂停时都是待机小镜**，圆标作废 |
| 时间轴 | 暂停时放开（在演）、录制中冻住 | **录制中放开（在演）、暂停冻回第 0 帧** |
| 「在不在录」怎么看出来 | 圆标的亮度 + 动作有无 | 小球亮度 / 去饱和 + 外围扫光转不转 + 小镜自己在不在演 |

关键点：**时间轴方向整体翻转了**。Phase 13.1 定下的信号「一暂停，整个圆标完全静止」要保住 ——
脸换成小镜以后，若还照 13.3 的写法「暂停时放开」，暂停就变成「小镜在演」，
那个「静止 = 已暂停」的信号会当场失效。所以 `applyState()` 里的方向必须跟着翻过来。

瞬时态不受影响：三个 `effect-*` 仍然只映射那三只小镜，`EFFECT_MASCOTS` 一个字节都没动。

## 3. 改了什么

```text
新增：
  docs/36-变更记录-Phase13.4.md        本文件

修改：
  src/renderer/launcher.css           放它出来的规则由 state-paused 单条改成
                                      state-running + state-paused 两条共用声明；
                                      .glyph 让位同理；降级块也补上 state-running
  src/renderer/launcher.js            applyState 方向翻转（running ? play : freeze）+ 注释同步
  test/launcherMascot.test.js         「小镜 6」按默认脸语义整条重写
  test/launcherView.test.js           「悬浮特效 9 / 10」方向翻转
  test/smoke/launcherMascotSmoke.cjs  待机段整段重写为「待机 1~11」+ FACE_PROBE
  docs/30-悬浮窗特效.md                第 5 节标题与待机段、第 8 节撤销清单
  docs/34-小镜待机态.md                第 5 节整段改写为「默认脸」
  docs/35-变更记录-Phase13.3.md        第 1 节补「后续」引用块，指向本文件
  docs/README.md                       索引加 36 行、34 行描述改「（默认脸）」
```

### 3.1 CSS：一条变两条，顺序仍然要紧

```css
body.state-running .glyph,
body.state-paused .glyph { opacity: 0; }

body.state-running .mascot-idle,
body.state-paused .mascot-idle {
  visibility: visible;
  opacity: 1;
  animation: mascot-in 0.5s ease-out;
}
```

瞬时态退场那条一字未改（选择器本来就逐个列了三个 `effect-*`），
但它**必须继续写在这两条之后** —— 特异性都是 0,2,1，靠书写顺序压过前者。
「小镜 6」同时钉住了「两个状态都放它出来」与「退场那条在后面」两件事。

`@media (prefers-reduced-motion)` 的降级块也补上了 `state-running`：

```css
body.state-running .mascot-idle,
body.state-paused .mascot-idle { animation: none; }
```

漏掉它的后果是：录制中（现在就是默认路径）淡入动画照跑，「减少动态效果」形同虚设。

### 3.2 JS：`applyState` 方向翻转

```text
applyState(running)
  running === true   -> playMascot(idle)     setCurrentTime(0) + unpauseAnimations()
  running === false  -> freezeMascot(idle)   pauseAnimations() + setCurrentTime(0)
```

Phase 13.3 是反过来的。载入时四只仍然全部 `freezeMascot()`（含待机），逻辑没动。

## 4. 验证

### 4.1 单测

```powershell
npm test
# tests 335 / pass 335 / fail 0
```

### 4.2 真实 Electron 冒烟

```powershell
node_modules\electron\dist\electron.exe test\smoke\launcherMascotSmoke.cjs
```

`PASS 34 / FAIL 0`。待机这一段的原样输出：

```text
PASS  待机 1 录制中 -> state-running 挂上 body class
        body="state-running"
PASS  待机 2 录制中待机小镜在台上、光圈圆标让位
        {"idle":"visible","glyph":"0"}
PASS  待机 3 录制中待机小镜的时间轴被放开
        {"paused":false,"at":0.2}
PASS  待机 4 录制中三只瞬时态小镜仍冻着
PASS  待机 5 录制中待机小镜一直在演（时间轴在前进）
        0.2s -> 0.717s
PASS  待机 6 暂停 -> state-paused 挂上 body class
PASS  待机 7 暂停时待机小镜冻回第 0 帧（一暂停就完全静止）
        {"paused":true,"at":0}
PASS  待机 8 暂停时它仍然在台上、圆标仍然让位
        {"idle":"visible","glyph":"0"}
PASS  待机 9 淡入用的是 mascot-in（不是演完会自己消失的 mascot-pop）
        animationName=mascot-in
PASS  待机 10 瞬时事件插进来：瞬时态那只上场、待机这只退场
        {"idle":"hidden","smug":"visible"}
PASS  待机 11 恢复录制 -> state-running，待机小镜回到台上并被放开
        body="state-running" face={"idle":"visible","glyph":"0"} idle={"paused":false,"at":0.2}
```

冒烟这次新增了 `FACE_PROBE`：一次调用同时读 `.mascot-idle` 的 computed `visibility`
与 `.glyph` 的 `opacity`，用来断言「台上站的到底是谁」。

### 4.3 视觉确认

用真实 Electron 窗口的 `webContents.capturePage()`（`setZoomFactor(8)` +
`setContentSize(448, 448)`，等 0.5s 的 `mascot-in` 演完再截）拿 8x 图：

| 状态 | 看到的东西 | 结论 |
| --- | --- | --- |
| 录制中 | 球亮着，小镜是淡色的小脸 | 圆标确实让位了，小镜在台上 |
| 暂停 | 球暗下来（`brightness(0.62) saturate(0.72)`），小镜更暗但构图完整 | 「已暂停」仍读得出来 |
| 1:1（56px 圆标） | 两种状态都能认出是一张脸 | 可读性够用 |

**注意**：待机素材本身的配色是低对比的（深蓝玻璃体 + 半透明眼白），
所以「录制中亮 / 暂停暗」的差别不像原来那颗霓虹圆标那样刺眼。
这是既有素材特性，本阶段没有改素材。

## 5. 已知问题与取舍

- **录制中不再是那颗霓虹光圈圆标。** 这是「默认脸」最直观的代价：
  常驻状态下 App 的视觉主角从光圈换成了这张低对比的小脸。
  换来的是「一启动就能看到小镜」，以及录制 / 暂停统一由同一张脸表达。
- **待机脸的对比度偏低。** 素材本身如此（见 4.3），圆标让位后整体观感比 13.3 暗一档。
  想让它在球上更跳，要动的是素材配色，不是 CSS —— 那会牵到家族另外三只的一致性。
- **`applyState` 的语义方向翻转了，读代码时容易记反。** 现在的口诀是
  「**在演 = 在录**」：录制中放开时间轴，暂停冻回第 0 帧。
  `test/launcherView.test.js` 的「悬浮特效 9 / 10」把这个方向钉住了（方向若再翻回去会红）。
- **「谁退场」仍然靠书写顺序，不靠特异性。** 这条从 13.3 继承下来，没有更好：
  待机上场与瞬时态退场特异性相同（0,2,1），压得住纯粹因为退场写在后面。
  将来若重排 / 格式化 CSS，这两条**必须保持这个前后关系**。
- **Figma 生成式插件里的第 4 态还没补**（Phase 13.3 遗留）。Figma MCP 被套餐限流
  （Starter 计划 20 次/月已用完），这次仍补不了；要动的地方列在
  [34-小镜待机态](34-小镜待机态.md) 第 6 节。
- **`error` 仍然借用「思考」**（Phase 13.2 的老问题），本阶段没动。

功能与架构说明见 [34-小镜待机态](34-小镜待机态.md)、
[30-悬浮窗特效](30-悬浮窗特效.md) 与 [32-小镜表情动画](32-小镜表情动画.md)。

## 6. 相关文档

- [34-小镜待机态](34-小镜待机态.md) —— 第 4 态的几何 / 参数 / 接入方式（第 5 节即默认脸）
- [35-变更记录-Phase13.3](35-变更记录-Phase13.3.md) —— 上一阶段：待机小镜接进持续态
- [30-悬浮窗特效](30-悬浮窗特效.md) —— 持续态与瞬时态、小镜怎么上下台
