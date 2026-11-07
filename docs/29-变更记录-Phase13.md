# 变更记录：Phase 13 — 悬浮入口（Floating Launcher）

## 1. 这一阶段做了什么

**A. 新增悬浮入口窗口（与主窗口并存的第二个 BrowserWindow）**

- 56x56、无边框、透明、置顶、不进任务栏、不可缩放、无阴影；
- 图标用内联 SVG（镜头）画在 CSS 圆标里，没有引入任何 UI 框架或新依赖，项目里也没有 Logo 资源可用；
- 启动流程末尾创建，**主窗口照常显示**（启动行为不变）。

**B. 主窗口改为「关闭 = 隐藏」（三处生命周期改动 + close 拦截）**

```text
1. createWindow() 增加 close 拦截：quitting 未置位 -> preventDefault + hide()
2. activate 不再判断 getAllWindows().length，改调 showMainWindow()
3. second-instance 不再只 focus()，改调 showMainWindow()（隐藏状态也能唤醒）
```

`showOrFocusMainWindow({ getWindow, createWindow })` 供三处共用：
不存在 -> 重建 / 隐藏或最小化 -> 显示并聚焦 / 可见 -> 只聚焦。

**C. 新增显式退出入口（本阶段唯一新增的主窗口 UI）**

- 头部状态区一个「退出」按钮 -> `lifelens:quit` -> `app.quit()`；
- `before-quit` 的内容与顺序**一个字都没改**，退出仍然走原来的优雅收尾；
- 悬浮入口常驻后 `window-all-closed` 基本不再触发，这是替代的退出路径。

**D. 拖动与点击**

- 不用 `-webkit-app-region: drag`（Windows 上会吞掉 click，两种手势无法区分）；
- `mousedown/mousemove/mouseup` + 4px 阈值：阈值内 = 点击（打开主界面），
  超阈值 = 拖动（每帧 `lifelens:launcher-move`，松手 `lifelens:launcher-end` 保存位置）。

**E. 位置持久化与越界校正**

- `<userData>/launcher-position.json`，只有 `{ x, y }`，拖动结束时写；
- 读写失败（缺文件 / JSON 损坏 / 字段非法）静默回退主屏右下角；
- 越界校正抽成纯函数 `clampToWorkArea`，启动时与每次拖动都过一遍。

## 2. 新增与修改的文件

```text
新增：
  src/main/launcher/launcherWindow.js   窗口创建 / 三条 IPC 通道 / showOrFocusMainWindow
  src/main/launcher/launcherPosition.js 越界校正 + 位置存取（依赖注入）
  src/launcherPreload.js                悬浮入口专用 preload（只暴露三个方法）
  src/renderer/launcher.html            悬浮图标页面
  src/renderer/launcher.css             悬浮球样式（独立文件，保持 CSP 严格）
  src/renderer/launcher.js              手势判定（纯函数）+ 视图装配
  test/launcherPosition.test.js         位置逻辑（10 项）
  test/launcherWindow.test.js           窗口与 IPC（10 项）
  test/launcherView.test.js             手势与装配（7 项）
  test/smoke/launcherSmoke.cjs          真实 Electron 冒烟（真实窗口 + 真实 IPC 驱动）
  docs/28-悬浮入口.md                    功能与架构说明
  docs/29-变更记录-Phase13.md            本文件

修改：
  src/main/main.js                      close 拦截 / showMainWindow / createLauncher / lifelens:quit
  src/preload.js                        quit()
  src/renderer/index.html               头部「退出」按钮
  src/renderer/renderer.js              quit 按钮的事件绑定
  src/renderer/styles.css               .quit-button
  docs/01-架构总览.md                    分层结构、职责边界表
  docs/06-测试与验证.md                  测试结果与 Phase 13 冒烟记录
  docs/README.md                        文档索引与一句话概览
```

未改动：Screenshot / Activity / Block Summary / Diary / Dashboard、
Memory Search / Ask My Life、BGE-M3 / LanceDB / SQLite / AI Worker / Ollama，
以及 `before-quit` 的收尾流程（只把退出入口接到 `app.quit()` 上）。

## 3. 数据流

```text
点击悬浮球
  renderer/launcher.js（mouseup，未超过阈值）
    -> launcherPreload.openMain()
    -> ipcMain handle('lifelens:launcher-open')
    -> showMainWindow() -> showOrFocusMainWindow({ getWindow: () => mainWindow, createWindow })

拖动悬浮球
  renderer/launcher.js（mousemove，超过阈值）
    -> launcherPreload.dragMove({ x, y })
    -> ipcMain on('lifelens:launcher-move')
    -> moveLauncherWindow：clampToWorkArea -> win.setPosition
  renderer/launcher.js（mouseup）
    -> launcherPreload.dragEnd()
    -> ipcMain handle('lifelens:launcher-end')
    -> win.getPosition() -> positionStore.save() -> <userData>/launcher-position.json

退出
  界面「退出」按钮 -> preload.quit() -> ipcMain handle('lifelens:quit') -> app.quit()
    -> before-quit（原样执行）-> 两个窗口 close 放行 -> 窗口销毁 -> quit
```

## 4. 验证

### 4.1 自动化（`npm test`）

```text
tests 311 / pass 311 / fail 0
```

Phase 13 新增 27 项（10 + 10 + 7）；改动前是 284 项，全部仍然通过。

### 4.2 真实 Electron 冒烟

`test/smoke/launcherSmoke.cjs` 直接引导真实应用（`require src/main/main.js`），
用真实窗口 + 真实 IPC + 真实鼠标事件驱动。分两轮跑，第二轮验证「重启恢复位置」：

```powershell
$dir = "$env:TEMP\lifelens-p13-smoke-<时间戳>"
$env:LIFELENS_SMOKE_DIR = $dir
node_modules\electron\dist\electron.exe test\smoke\launcherSmoke.cjs --user-data-dir="$dir\user-data"
# 第二轮用第一轮打印的 SAVED_POSITION
$env:LIFELENS_SMOKE_EXPECT_POSITION = "400,360"
node_modules\electron\dist\electron.exe test\smoke\launcherSmoke.cjs --user-data-dir="$dir\user-data"
```

两轮结果都是 `PASS 13 / FAIL 0`（节选自真实输出）：

```text
PASS  1 启动时 launcher 与主窗口同时出现        launcher=56x56，主窗口=1040x880
PASS  1 launcher 置顶（alwaysOnTop）
PASS  9 越界坐标启动后自动回到可见区域          文件里是 99999,99999，实际落在 2504,984（workArea 2560x1040）
PASS  8 重启后恢复到上次保存的位置              期望 400,360，实际 400,360（第二轮）
PASS  2 点击 launcher 后主窗口显示 / 聚焦       主窗口 visible=true focused=true，launcher 仍在=true
PASS  3 拖动 launcher：位置跟手                按下时窗口位置 300,300 + 位移 100,60 => 期望 400,360，实际 400,360
PASS  3 拖动没有误开主窗口                      主窗口 visible=false
PASS  3 拖动结束才写盘，写入窗口当前位置         窗口=400,360，文件={"x":400,"y":360}
PASS  4 拖动之后再单击仍能打开主窗口
PASS  5 关闭主窗口 = 隐藏而不是销毁，应用继续运行  isDestroyed=false visible=false，launcher 仍在=true
PASS  5 主窗口隐藏后后台仍在截图                关闭前 1 张，等待后 2 张（真实 PNG 落到 LIFELENS_DIR）
PASS  6 再点 launcher 主窗口恢复
PASS 10 第二个实例唤起已有实例的主窗口           second-instance=true，主窗口 visible=true
PASS  7 主窗口「退出」按钮结束整个应用          quit 事件已触发（before-quit 收尾流程走完）
```

退出时的真实日志（数据库与向量库正常关闭）：

```text
--- 退出 ---
[AI-JOB] 2026-09-20T11:16:32+08:00 WORKER_STOPPED job=- type=- status=-
[DB] Database closed
```

另外把应用自己每 3 秒抓的桌面图裁出来看了一眼：圆标的圆角外侧是真透明
（能看到底下的编辑器文字），没有黑底方块，所以**不需要**启用退化方案。

### 4.3 数据库初始化失败路径（回归确认）

主窗口的 close 拦截必须在「应用正在退出」时放行，否则 `app.quit()` 会被拦住。
`before-quit` 在 `recorder` 为 null 时（数据库初始化失败）会直接返回、不置 `quitting`，
所以专门确认了这条路径：把 `LIFELENS_DIR` 指向一个文件让建库失败，
入口脚本里替换掉 `dialog.showErrorBox`（避免模态框阻塞自动化），实测：

```text
[AI-JOB] STORAGE_ERROR ... 数据库初始化失败：EEXIST: file already exists, mkdir '...\package.json'
showErrorBox called（已拦截模态框）
QUIT event after 104ms
```

结论：这条路径下**还没有创建任何窗口**，close 拦截不会被触发，退出正常。
其它调用 `app.quit()` 的位置同样都在建窗口之前，因此不需要额外改动。

## 5. 已知问题与取舍

- 跨屏拖动在两屏交界会跳一下（最多 56px）：规则是「窗口必须完整落在某块 workArea 内」；
- 聚焦悬浮球按 Alt+F4 只会隐藏它，没有托盘 / 菜单能叫回来（按需求实现），
  恢复方式是重新启动应用（单实例锁会唤起主窗口）；
- 拖动没有节流 / 惯性 / 吸附，极端快速拖动会多打几个 IPC；
- 悬浮球的视觉（悬停高亮、拖动压暗）只有 CSS，没有动画库。
