# Phase 13.1：悬浮窗特效与右键菜单

## 一、目标

让 Phase 13 的悬浮入口从「一个能点开的圆标」变成「一个有生命的入口」：

* 截图时给一个「快门闪光」特效
* AI 分析成功时给一个「成功」特效
* 出错时给一个短暂的红色提示
* 录制中 / 暂停两种状态有持续的视觉差异
* 右键弹出极简菜单（打开主界面 / 暂停-恢复录制 / 退出应用）

所有特效都挂在现有的真实事件上，不造假状态、不轮询。

---

# 二、现状与可复用能力（已核实）

动手前先读以下代码：

* 事件广播：src/main/main.js 的 `broadcast(payload)`——**目前只发给 mainWindow**，
  launcherWindow 收不到任何事件。这是本阶段要改的第一个点。
* 事件类型（通过 `lifelens:event` 通道）：
  - `{ type: 'status', status: { running, ... } }`：录制器状态变化
  - `{ type: 'record', record }`：刚截完一张图
  - `{ type: 'analysis', screenshotId, patch }`：单张截图 AI 分析成功写回
  - `{ type: 'error', message }`：出错
  - `{ type: 'ai', ai: { pending, ... } }`：AI 队列快照（本阶段可选使用）
* 悬浮窗：src/main/launcher/launcherWindow.js（createLauncherWindow / registerLauncherIpc），
  src/launcherPreload.js（只暴露 openMain / dragMove / dragEnd），
  src/renderer/launcher.{html,css,js}。
* 录制状态：src/main/recorder.js 的 status 含 `running` 布尔值。
* 右键菜单：Electron 的 `Menu` / `MenuItem`，主进程 `Menu.popup({ window })`。

不要假设文件结构，根据实际代码选最小改动。

---

# 三、功能设计

### 1. 录制状态指示（持续态）

| 状态 | 视觉 |
| --- | --- |
| 录制中（running = true） | 光圈轨道环正常旋转，瞳孔青色呼吸发光 |
| 已暂停（running = false） | 轨道环停止旋转，瞳孔变暗偏灰，球体整体亮度降一档 |

来源：`status` 事件的 `status.running`。这是**持续态**，不是闪烁，靠切换 body class 实现。

### 2. 截图快门闪光（瞬时特效，~400ms）

收到 `record` 事件时：
* 球体从中心向外扩散一圈白色→青色的光圈（expand + fade）；
* 球体内部闪一次高光（亮度脉冲）；
* 持续约 400ms 后自动结束。

模拟相机快门按下的感觉，强化「我在记录」的反馈。

### 3. 分析成功特效（瞬时特效，~600ms）

收到 `analysis` 事件时：
* 瞳孔闪一下绿色，并扩散一圈淡绿色光环；
* 可在光圈中心短暂画一个对勾（用 SVG path，纯 CSS 动画显隐）；
* ~600ms 后恢复。

表示「这张图已经被 AI 看懂了」。

### 4. 错误提示（瞬时特效，~500ms）

收到 `error` 事件时：
* 球体边框 / 瞳孔闪一下红色；
* ~500ms 后恢复；
* 不弹 toast、不阻塞操作（错误详情仍在主界面日志里看）。

### 5. 右键极简菜单

右键悬浮球弹出 Electron 原生菜单，只有三项：

```text
打开主界面
暂停录制 / 恢复录制   ← 根据当前 running 状态显示对应文案
退出应用
```

* 点击「打开主界面」= 左键点击行为（showMainWindow）；
* 「暂停 / 恢复」= 调已有 `recorder.toggle()`（IPC `lifelens:toggle` 已存在，复用）；
* 「退出应用」= `app.quit()`，走现有 before-quit 优雅退出流程；
* 这是**极简菜单**，不做二级菜单、不做设置面板、不做快捷操作面板。

---

# 四、事件通道设计（关键：launcher 如何收到事件）

现状 `broadcast()` 只发给 mainWindow。最小改动方案：

### 方案：给 launcher 单独一条轻量事件通道

不要把整条 `lifelens:event` 原样转发给 launcher——那会把 screenshotId、record 数据
（含路径等）暴露给一个 56x56 的小窗口，违反最小暴露原则。

在 Main 侧维护一个 `broadcastLauncher(payload)`，只把特效需要的字段发过去：

```text
mainWindow ← 完整 lifelens:event（不变）
launcherWindow ← lifelens:launcher-event（只含 type + running，不含 record/analysis 详情）
```

具体转换：

| 原始事件 | 发给 launcher 的 |
| --- | --- |
| status.running | `{ type: 'status', running }` |
| record | `{ type: 'record' }` |
| analysis | `{ type: 'analysis' }` |
| error | `{ type: 'error' }` |

launcherPreload 新增：

```js
onEvent: (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on('lifelens:launcher-event', handler);
  return () => ipcRenderer.removeListener('lifelens:launcher-event', handler);
}
```

Main 侧 `broadcast()` 内部根据 type 决定是否同时 `broadcastLauncher()`，
或者在 recorder 的 onEvent 回调链路里分流——选改动最小的那一个。

---

# 五、特效实现要点

### 1. 纯逻辑层（可单测）

把「事件类型 → 该加哪个 body class」提取成纯函数：

```js
// 输入事件 payload，输出特效 class 名（持续态 / 瞬时态分开）
function effectClassOf(payload) { ... }   // 'effect-shutter' | 'effect-success' | 'effect-error'
function stateClassOf(running) { ... }     // 'state-running' | 'state-paused'
```

这两个函数零 DOM、零 Electron，`node --test` 直接测。

### 2. Renderer 层（launcher.js）

```text
onEvent(payload):
  status → 切 state-* class（先 remove 两个 state，再加对应一个）
  record / analysis / error → 加对应的 effect-* class
             → 监听该元素的 animationend，结束后 remove 这个 class
```

注意：

* 特效动画期间若又来了同类事件，**重新触发**（remove class → 强制 reflow → add class），
  不要堆积 class；
* 不同类特效可以叠加（例如截图闪光时瞳孔仍在呼吸）；
* `prefers-reduced-motion`：瞬时特效降级为只变色、不做位移扩散（在 CSS 里用 media query 处理）。

### 3. CSS 层（launcher.css）

在现有文件基础上追加：

* `.state-running` / `.state-paused`：控制轨道环 `animation-play-state` 与瞳孔亮度；
* `.effect-shutter`：`@keyframes shutter`——中心向外 expand + 高光 fade；
* `.effect-success`：`@keyframes success`——瞳孔绿闪 + 外圈扩散 + 对勾显隐；
* `.effect-error`：`@keyframes error`——红闪；
* 所有动画时间：shutter 0.4s，success 0.6s，error 0.5s，结束即 remove。

不要引入图片 / 外部字体 / 新依赖。SVG 对勾直接内联进 launcher.html 的 .ball 里，
默认 `opacity: 0`，`.effect-success` 时淡入。

---

# 六、右键菜单实现

### IPC

launcherPreload 新增：

```js
showContextMenu: () => ipcRenderer.invoke('lifelens:launcher-context-menu')
```

launcher.js 里监听 `contextmenu` 事件 → preventDefault → 调 `showContextMenu()`。

### Main

在 registerLauncherIpc 里加 `lifelens:launcher-context-menu` handler：

```js
const menu = Menu.buildFromTemplate([
  { label: '打开主界面', click: () => showOrFocusMainWindow() },
  { label: running ? '暂停录制' : '恢复录制', click: () => recorder.toggle() },
  { type: 'separator' },
  { label: '退出应用', click: () => app.quit() },
]);
menu.popup({ window: launcherWindow });
```

* `running` 从当前 recorder.status 取，保证菜单文案与实际状态一致；
* 不渲染任何自定义 DOM 菜单，用 Electron 原生 Menu，零样式代码；
* 不拦截左键（左键仍是打开主界面）。

---

# 七、不要做的事情

本阶段明确不做：

* 不在 launcher 里展示截图内容 / 分析文本（违反最小暴露）
* 不做通知中心 / toast / 快捷操作面板 / Widget
* 不做复杂右键菜单（二级菜单、设置项、快捷记录等）
* 不做轮询（特效只由事件驱动）
* 不引入新的 npm 依赖（特效纯 CSS + 内联 SVG）
* 不改截图 / AI / SQLite / LanceDB 业务链路
* 不破坏 Phase 13 的拖动 / 点击 / 隐藏 / 退出逻辑

---

# 八、测试

测试体系仍是 `node --test`。窗口行为（菜单弹出、动画视觉）无法在 node 里测，
只测纯逻辑与 IPC 绑定。

### 自动化测试

1. `effectClassOf`：record → 'effect-shutter'、analysis → 'effect-success'、
   error → 'effect-error'、未知 type → null
2. `stateClassOf`：running true → 'state-running'、false → 'state-paused'
3. event 转换层：原始 status/record/analysis/error → 发给 launcher 的 payload 只含 type
   与 running，不含 record 详情（验证最小暴露）
4. 右键菜单 IPC：假 ipcMain 验证 handler 注册、`lifelens:launcher-context-menu` 被调用

### 手工 smoke（npm start 真机）

1. 录制中：轨道环在转、瞳孔青色呼吸
2. 暂停：轨道环停、瞳孔变暗
3. 截图瞬间：快门闪光特效出现并 ~400ms 后消失
4. 分析成功：绿色成功特效出现
5. 触发错误（如临时让 embedding 失败）：红色闪烁
6. 右键：出现三菜单项，「打开主界面」可唤起主窗口
7. 右键「暂停/恢复」：录制状态切换、视觉同步切换
8. 右键「退出应用」：应用走 before-quit 优雅退出，无报错

---

# 九、完成标准

完成后报告：

1. 修改 / 新增哪些文件
2. launcher 事件通道如何建立（broadcastLauncher 的分流点）
3. 四个特效分别对应哪个事件、持续多久
4. 录制状态如何映射到视觉
5. 右键菜单的实现方式与菜单项
6. 自动化测试：npm test 实际结果 X/X，新增测试条数
7. 手工 smoke：上面 8 条逐条 PASS/FAIL
8. 已知问题与取舍（例如 prefers-reduced-motion 下的降级效果）

不要 commit。
