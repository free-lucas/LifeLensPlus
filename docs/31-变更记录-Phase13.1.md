# 变更记录：Phase 13.1 — 悬浮窗特效与右键菜单

## 1. 这一阶段做了什么

**A. 给悬浮入口单开一条裁剪后的事件通道**

- `lifelens:event`（完整业务事件）**只发主窗口，一个字节都没改**；
- 新增 `lifelens:launcher-event`：`status` 只带 `running`，`record` / `analysis` / `error` 只有类型，
  `ai` 快照等其它事件不发 —— 一个 56x56 的窗口不需要知道图片路径与分析文本；
- 分流点在 `main.js` 的 `broadcast()`：全应用唯一的事件出口，在这里分流改动最小，
  而且**必须**把「主窗口不存在就直接 return」改成两段独立发送，否则关掉主窗口后悬浮球就瞎了；
- `createLauncher()` 里在 `did-finish-load` 补发一次当前 `status`：
  启动时的第一次 `status` 早于 launcher 创建，不补的话 `autoStart=false` 会显示成「录制中」。

**B. 四个视觉反馈（全部挂在真实事件上）**

| 视觉 | 事件 | 时长 |
| --- | --- | --- |
| 录制中：环转 + 瞳孔青色呼吸 | `status.running = true` | 持续 |
| 已暂停：环停、瞳孔变暗偏灰、整体亮度降一档、呼吸光晕也停 | `status.running = false` | 持续 |
| 快门闪光（白→青光圈扩散 + 内部高光） | `record` | 0.4s |
| 分析成功（瞳孔绿闪 + 绿圈 + 对勾） | `analysis` | 0.6s |
| 错误红闪（边框与瞳孔） | `error` | 0.5s |

事件 → class 的映射是两个纯函数（`effectClassOf` / `stateClassOf`），
渲染层没有一行动画代码；class 在 `animationend` 里回收；同类事件重复到来会重播而不是叠加。

**C. 右键极简菜单（原生 Menu，三项）**

- `打开主界面` → 与左键同一件事（`showOrFocusMainWindow`）；
- `暂停录制 / 恢复录制` → 文案按**此刻**的 `recorder.running` 决定，动作复用已有的 `recorder.toggle()`；
- `退出应用` → `app.quit()`，`before-quit` 的优雅收尾一行未改；
- 没有自定义 DOM 菜单，没有二级菜单；模板抽成纯函数 `launcherMenuTemplate` 以便单测。

**D. 测试与真实冒烟**

- 新增 16 项自动化用例（转换层 4 / 窗口与菜单 4 / 渲染层 8）；
- 新增 `test/smoke/launcherEffectsSmoke.cjs`：真实 Electron 里跑真实截图与真实 AI 分析，
  13 项检查全部 PASS（见第 4 节）。

## 2. 新增与修改的文件

```text
新增：
  src/main/launcher/launcherEvents.js    事件裁剪（白名单 + 纯函数）+ 通道名
  test/launcherEvents.test.js            转换层与最小暴露（4 项）
  test/smoke/launcherEffectsSmoke.cjs    真实 Electron 冒烟（13 项）
  docs/30-悬浮窗特效.md                   功能与架构说明
  docs/31-变更记录-Phase13.1.md           本文件

修改：
  src/main/main.js                       broadcast 分流 / broadcastLauncher / 首帧补状态 / 注入菜单依赖
  src/main/launcher/launcherWindow.js    第四个通道 lifelens:launcher-context-menu + launcherMenuTemplate
  src/launcherPreload.js                 onEvent(callback) / showContextMenu()
  src/renderer/launcher.html             内联对勾 SVG（.check）
  src/renderer/launcher.css              状态样式 / 三个特效 / reduced-motion 降级 / 亮度过渡
  src/renderer/launcher.js               effectClassOf / stateClassOf / onEvent / animationend / contextmenu
  test/launcherWindow.test.js            10 -> 14 项（菜单模板、popup、三项动作、异常分支）
  test/launcherView.test.js              7 -> 15 项（特效映射、状态切换、重播与叠加、右键、老 preload）
  docs/README.md                         索引
  docs/06-测试与验证.md                   用例数与 Phase 13.1 冒烟记录
  docs/28-悬浮入口.md                     加一行指向 Phase 13.1
```

## 3. 事件链路

```text
Recorder / Summarizer / DiaryGenerator / AIQueue
  -> main.js broadcast(payload)
       ├── mainWindow.webContents.send('lifelens:event', payload)      完整事件（不变）
       └── broadcastLauncher(payload)
             -> launcherEventOf(payload)  白名单裁剪，不符返回 null
             -> launcherWindow.webContents.send('lifelens:launcher-event', { type, running? })
                  -> launcherPreload.onEvent
                       -> launcher.js onEvent
                            status   -> body.state-running / state-paused
                            record   -> body.effect-shutter   ┐
                            analysis -> body.effect-success   ├ animationend -> 摘掉 class
                            error    -> body.effect-error     ┘

右键
  launcher.js contextmenu -> preload.showContextMenu()
    -> ipcMain handle('lifelens:launcher-context-menu')
    -> launcherMenuTemplate({ running: recorder.running, … }) -> Menu.buildFromTemplate
    -> menu.popup({ window: launcherWindow })
```

## 4. 验证

### 4.1 自动化（`npm test`）

```text
tests 327 / pass 327 / fail 0
```

Phase 13.1 新增 16 项（4 + 4 + 8）；改动前是 311 项，全部仍然通过。

### 4.2 真实 Electron 冒烟（`test/smoke/launcherEffectsSmoke.cjs`）

真实应用 + 真实窗口 + 真实 IPC + 真实截图 + **真实 Ollama 分析**（`qwen3-vl:8b`）：

```powershell
$dir = "$env:TEMP\lifelens-p13-1-smoke-<时间戳>"
$env:LIFELENS_SMOKE_DIR = $dir
node_modules\electron\dist\electron.exe test\smoke\launcherEffectsSmoke.cjs --user-data-dir="$dir\user-data"
```

```text
--- 结果 ---  PASS 13 / FAIL 0
PASS  1 launcher 与主窗口同时出现
PASS  2 启动时（autostart=0）圆标是暂停态          首帧 body class = "state-paused"
PASS  3 录制中 -> state-running（真实 status 事件） body class = "state-running"
PASS  4 真实截图 -> 快门特效出现并自动结束           出现 -> 消失 415ms（期望约 400ms）
PASS  5 真实 AI 分析 -> 成功特效出现并自动结束       出现 -> 消失 625ms（期望约 600ms）；已分析 1 张
PASS  6 launcher 只收到 type（+ status 的 running）  共 26 条：status / record / analysis
PASS  7 error -> 红色闪烁出现并自动结束              出现 -> 消失 514ms（期望约 500ms）
PASS  8 右键弹出原生菜单                              ["打开主界面","暂停录制","separator","退出应用"]
PASS  8 菜单「暂停录制」真的停了录制，视觉同步切到暂停态
PASS  8 菜单「恢复录制」文案正确且真的恢复录制        第二次菜单第二项 = "恢复录制"
PASS  8 菜单「打开主界面」唤起主窗口
PASS  9 prefers-reduced-motion：只闪颜色 + class 仍能回收
       动画名 = shutter-ring-flash；transform = none；轨道环 animation-name = none；class 回收 = true
PASS  8 菜单「退出应用」结束整个应用                  quit 事件已触发（before-quit 收尾流程走完）
```

冒烟里的取舍（都写在脚本注释与输出里）：

- `status` / `record` / `analysis` 三项由**真实链路**产生（真实截图、真实 Ollama 推理）；
- `error` 需要一个可复现的失败，冒烟里造不出来：用真实的转换函数 `launcherEventOf`
  生成载荷、沿真实通道推入，输出里标注了这一点；
- 右键菜单用真实的 Electron `Menu`，只把 `popup` 换成记录（原生菜单会挡住自动化）；
- 「最小暴露」不是靠读代码断言，而是**劫持 `webContents.send` 记录 Main 真正发出的载荷**，
  再检查每一条只有 `type`（和 `status` 的 `running`）。

### 4.3 像素级验证（暂停 / 录制两种状态）

用真实窗口 + 真实屏幕截图（与应用同一条 `desktopCapturer` 链路），
取圆标所在的 56x56 区域做两帧对比（间隔 600ms）：

| 状态 | 两帧平均每像素差 | 最大单通道差 | 区域平均亮度 |
| --- | --- | --- | --- |
| 已暂停 | **0** | **0** | 37.7 |
| 录制中 | 16.54 | 191 | 61.97 |

- 暂停态两帧**完全相同** → 轨道环、瞳孔、呼吸光晕全停（静止）；
- 录制态两帧明显不同 → 环在转、瞳孔在呼吸；
- 亮度 61.97 → 37.7，即暂停时整体暗约 39%（`brightness(0.62)`）；
- 空白壁纸对照区两帧差 0，排除「壁纸自己在动 / 截图噪声」的干扰。

（这条验证发现暂停态里球体的呼吸光晕还在动，「暂停」应该是完全静止，
所以把 `.ball` 的 `animation-play-state` 也纳入了 `state-paused` —— 否则两帧差是 2.7 而不是 0。）

### 4.4 顺带确认没有破坏 Phase 13 的行为

冒烟里同时覆盖了：右键不被当成手势（不打开主窗口、不发位置）、老版 preload 缺方法时不报错、
窗口销毁或拿不到 Menu 时不弹菜单、拖动与点击逻辑未被触碰（Phase 13 的 10 项用例全绿）。

## 5. 已知问题与取舍

- **`analysis` 事件在分析失败时也会发**（记录被标记为 `FAILED` 时同样走 `analysis`）。
  按需求「收到 analysis 就给成功特效」实现，所以一张分析失败的图也会闪一下绿。
  若要区分，需要把 `patch.analysisStatus` 透给 launcher（会让载荷不再只有 type）。
  影响有限：失败信号由 `error` 事件负责，主界面日志里有真实状态。
- **reduced-motion 下没有「什么都不做」的档位**：仍然会闪一次颜色（0.4-0.6 秒），
  因为 class 的回收依赖动画结束事件；只有把回收改成定时器才可能完全不闪。
- **窗口边距上有一层极淡的阴影 / 辉光**：圆标 52px 画在 56x56 窗口里，
  `box-shadow` 的 2px 边距被窗口裁掉，实测与紧邻像素的差值为 1-4/255（≤2%），
  肉眼几乎不可见，Phase 13 就有，本阶段没有改动它。
- **特效没有做节流**：`record` 每 1.5-20 秒一次，天然不会打满；但若把间隔调到几百毫秒，
  快门特效会一直在重播。
- **颜色差异没有断言**：冒烟断言的是 class 与 `animation-name` / `transform`，
  颜色本身靠上面 4.3 的像素亮度对比与肉眼看截图确认。

更完整的功能与架构说明见 [30-悬浮窗特效](30-悬浮窗特效.md)。