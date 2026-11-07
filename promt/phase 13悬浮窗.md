你现在要在现有 Life Lens Electron 项目中实现一个「悬浮入口（Floating Launcher）」。

## 一、目标

Life Lens 平时不需要一直显示完整主界面，而是在桌面上保持一个小型、简洁、可自由拖动的悬浮图标。用户点击悬浮图标后打开现有 Life Lens 主界面；再次关闭主界面后，悬浮图标仍然保留。

---

# 二、先阅读现有代码（已核实的现状）

动手前先读 src/main/main.js 的窗口与生命周期部分。以下事实已经核实，直接依据它们设计：

* 主窗口：`createWindow()`（main.js L80-96），单个 BrowserWindow，1040x880，
  loadFile src/renderer/index.html，`closed` 只置 null，**没有 close 事件拦截**——
  现在点关闭按钮 = 窗口销毁。
* 退出链路：`before-quit`（main.js L396-429）有完整的优雅退出流程——`quitting` 标志 +
  preventDefault，等 recorder 收尾 → summarizer/diary/embedding 停止 → vectorStore.close →
  closeDatabase，最后 app.quit()。**这段流程必须原样保留，不能破坏。**
* `window-all-closed` → 非 darwin 直接 `app.quit()`。这是**当前唯一的退出路径**
  （整个应用没有任何显式退出按钮 / 托盘 / 菜单）。
* `second-instance` → restore + focus 主窗口；已有 `requestSingleInstanceLock` 单实例锁。
* `activate`（macOS）→ `BrowserWindow.getAllWindows().length === 0` 才重建主窗口。
* preload：src/preload.js，contextBridge 暴露 `window.lifelens.*`，contextIsolation 已开启。
* **没有设置持久化机制**：config（src/main/config.js）是环境变量 + 默认值，运行时不可写；
  Store（src/main/store.js）只是截图文件存储。
* **没有现成 Logo / Icon 资源**（images/ 下只有 UI 参考图）。
* 测试体系：`npm test`（node --test test/*.test.js），**无法运行 Electron / BrowserWindow**。

不要先假设文件结构，根据实际代码选择最小改动方案。

---

# 三、现有生命周期与本需求的冲突（必须处理）

这个需求不是纯新增，它会改变现有两条生命周期路径，必须同步处理：

### 1. 应用将失去唯一退出路径（最重要的坑）

主窗口改为「关闭 → hide」且 launcher 常驻后，`window-all-closed` 永远不会触发，
应用变成无法退出的后台进程，`before-quit` 的优雅收尾也永远走不到。

因此本阶段**必须新增一个显式退出入口**：

* 主窗口界面上加一个「退出」按钮（样式从简，放在现有头部状态区即可，用户可发现）；
* 通过 IPC `lifelens:quit` 调用 `app.quit()`，让现有 `before-quit` 流程原样执行；
* 这是本阶段唯一允许新增的主窗口 UI。

### 2. macOS `activate` 判断失效

launcher 常驻后 `getAllWindows().length === 0` 永远为 false。最小修改：
把「激活时如何处理主窗口」收敛成一个 `showOrFocusMainWindow()`（见第六节），
`activate` 改为调用它。

### 3. `second-instance` 只 focus 不 show

主窗口处于 hidden 状态时 focus 无效。`second-instance` 改为调用
`showOrFocusMainWindow()`，顺带修复「hide 后二次启动唤不醒」的问题。

---

# 四、悬浮窗口

新增一个独立的 Floating Launcher Window：

* 独立 BrowserWindow，加载自己的 src/renderer/launcher.html（56x56 左右）；
* 配置：`frame: false` + `transparent: true` + `alwaysOnTop: true` +
  `skipTaskbar: true` + `resizable: false` + `hasShadow: false`；
* 透明窗口不支持 maximize / fullscreen，不要设置这些；
* 图标：项目没有现成资源，用内联 SVG 或 CSS 画一个简洁圆标即可，
  视觉与现有 UI 风格一致（深色底、圆角、轻微悬浮感），不要复杂动画，
  不要为它引入 UI 框架或新依赖；
* 如果透明窗口在目标机器上出现渲染异常，允许退化为不透明圆形纯色背景
  （CSS border-radius），不要为此卡住。

### 文件与 preload

```text
src/main/launcher/            ← 窗口创建 + IPC 注册（与 searchIpc 等同构）
  launcherWindow.js             createLauncherWindow() / registerLauncherIpc()
  launcherPosition.js           位置存取与越界校正（纯逻辑，依赖注入）
src/renderer/launcher.html    ← 悬浮图标页面（不加载现有 renderer 脚本）
src/renderer/launcher.js      ← 拖动 / 点击手势逻辑
src/launcherPreload.js        ← 只暴露下面第八节的最小 API
```

不要复用现有 src/preload.js 给 launcher——它暴露了全部业务 API，
launcher 只需要三个窗口操作。

### 生命周期

* 应用启动（whenReady 流程末尾）创建 launcher，**主窗口照常显示**——保持现有启动行为不变，
  不要改成「启动只显示悬浮球」；
* launcher 的 `close` 事件同样拦截：非退出状态 → `preventDefault()` + `hide()`，
  与主窗口用同一个 `quitting` 标志判断（退出时放行销毁）；
* 窗口的创建 / 显示 / 隐藏 / 销毁全部由 Main 进程管理，
  launcher 不依赖任何 Renderer 业务状态。

---

# 五、拖动与点击

悬浮图标必须可以直接拖动，且不能因为拖动误触发「打开主窗口」。

### 推荐实现：手动 IPC 拖动 + 阈值判定

不要用 CSS `-webkit-app-region: drag`——它在 Windows 上会吞掉 drag 区域的 click 事件，
「拖动 vs 点击」无法自己区分。

```text
mousedown  → 记录起点与当前窗口位置（pressing）
mousemove  → 位移超过阈值（如 4px）进入 dragging；
             之后每次移动 IPC 发给 Main，Main 调 setPosition（顺带做可见范围 clamp）
mouseup    → 未进入 dragging 视为 click → IPC 打开主窗口；
             否则视为 drag 结束 → IPC 保存当前位置
```

要点：

* click / drag 的判定提取成纯函数（输入累计位移与阈值，输出 'click' | 'drag'），便于单测；
* 第一版不做复杂节流 / 惯性 / 吸附，mousemove 直接发 IPC 即可，卡顿再说。

---

# 六、点击行为

正常点击悬浮图标，Main 进程执行 `showOrFocusMainWindow()`：

```text
主窗口不存在（销毁）        → 重新 createWindow()
主窗口存在但隐藏 / 最小化   → show()（最小化先 restore()）+ focus()
主窗口存在且可见            → focus()
```

* 把这个函数写成可注入窗口对象的形态（便于用假窗口单测三个分支），
  供三处共用：launcher 点击、`second-instance`、`activate`；
* 悬浮图标本身始终保留，不关闭、不销毁。

---

# 七、位置持久化

项目没有现成的设置持久化机制，为这个功能实现一个最小的本地位置存储：

* 存 `path.join(app.getPath('userData'), 'launcher-position.json')`
  （LanceDB 存 userData/lancedb 已有先例）；
  **不要**存到 outputDir（那是用户图片目录），不要写 SQLite；
* 内容就是 `{ x, y }`，读写损坏 / 缺文件时静默回退默认位置；
* 保存时机：拖动结束时。

### 越界校正（必须）

恢复位置时用 `screen` 模块的显示器 workArea 校正，逻辑提取为纯函数：

```text
输入：保存的 { x, y }、窗口尺寸、当前所有显示器的 workArea 列表
输出：保证 56x56 完整落在某个可见 workArea 内的位置
```

覆盖：多显示器、分辨率变化、保存位置所在显示器已拔掉、负坐标。
纯函数不依赖 electron，`node --test` 直接可测。

---

# 八、Renderer / IPC

保持现有架构：

```text
Renderer → Preload → IPC → Main
```

Renderer 不直接操作 BrowserWindow。新增 IPC 保持 `lifelens:*` 命名，最小集合：

```text
lifelens:launcher-open   ← launcher 点击：showOrFocusMainWindow()
lifelens:launcher-move   ← 拖动中的位置更新（Main 侧 setPosition + clamp）
lifelens:launcher-end    ← 拖动结束：保存位置
lifelens:quit            ← 主窗口退出按钮：app.quit()（走 before-quit 优雅退出）
```

preload：

* src/launcherPreload.js 只暴露 openMain / dragMove / dragEnd 三个方法；
* 现有 src/preload.js 只新增 `quit()` 一项。

除此之外不加任何 IPC。

---

# 九、主窗口关闭行为

目标：

```text
点击主窗口关闭按钮（含 Alt+F4）：
  Main Window → hide（close 事件 preventDefault）
  Floating Launcher → continue
  Application → continue running
  截图 / AI 队列 / embedding 等后台链路 → 完全不受影响

明确退出（退出按钮 / app.quit()）：
  quitting 置位 → 两个窗口的 close 拦截放行 → 现有 before-quit 流程原样执行
```

* close 拦截必须与现有 `before-quit` 的 `quitting` 标志配合，退出时不拦截；
* `window-all-closed` 保持原样即可（launcher 常驻后正常情况不再触发，
  退出流程中触发时 app.quit() 幂等无害）；
* broadcast 只发 mainWindow，hidden 状态下 send 照常工作，不需要改。

---

# 十、交互边界

第一版只实现：

* 点击 → 打开 / 聚焦主界面
* 拖动 → 移动悬浮入口
* 主窗口关闭 → 悬浮入口继续存在
* 显式退出按钮

暂时不要实现：

* 快捷记录 / 快速提问 / AI Agent / Widget / 快捷操作面板
* 右键菜单（包括 launcher 上的退出菜单——退出只走主窗口按钮）
* 托盘图标（launcher 就是常驻入口，不要加 Tray）
* 复杂动画 / 通知中心

---

# 十一、测试

测试体系是 `npm test`（node --test），**不能运行 Electron / BrowserWindow**。
与 Phase 12 同样的原则：把可测逻辑提取成纯函数 / 可注入依赖的模块做单测，
窗口行为用真实 Electron 手工验证。不要伪造窗口级测试结果。

### 自动化测试（node --test）

1. 位置校正纯函数：越界 / 负坐标 / 显示器被移除 / 分辨率变小 → 修正到可见 workArea
2. 位置存取模块（注入 fs）：保存 / 读取 / JSON 损坏 / 文件缺失的容错
3. click / drag 手势判定纯函数：阈值内 = click，超阈值 = drag
4. showOrFocusMainWindow 三个分支（可注入假窗口对象）：
   不存在 → 创建 / 隐藏 → 显示并聚焦 / 可见 → 仅聚焦
5. launcher IPC 注册（假 ipcMain）：channel 绑定正确、
   launcher-open 正确调用 showOrFocusMainWindow

### Electron 手工 smoke（npm start 真机跑一遍，逐条记录结果）

1. 启动：launcher 与主窗口同时出现；launcher 置顶、无任务栏图标、可拖动
2. 点击 launcher → 主窗口显示 / 聚焦；launcher 仍在
3. 拖动 launcher → 跟手、松手位置保留、没有误开主窗口
4. 拖动后再单击 → 正常打开主窗口
5. 关闭主窗口 → 应用不退出、后台录制不受影响、launcher 仍在
6. 再点 launcher → 主窗口恢复
7. 主窗口「退出」按钮 → 整个应用退出，日志无报错（数据库 / 向量库正常关闭）
8. 重启应用 → launcher 恢复上次位置
9. 手工把 launcher-position.json 改成越界坐标 → 启动后自动回到可见区域
10. 再次启动第二个实例 → 单实例锁生效，已有实例的主窗口被唤起

---

# 十二、重要边界

这是一个 UI / Window Shell 改造。不要修改：

* Screenshot / Activity / Block Summary / Diary / Dashboard
* Memory Search / Ask My Life
* BGE-M3 / LanceDB / SQLite / AI Worker / Ollama
* `before-quit` 优雅退出流程的内容与顺序（只允许把退出入口接到 app.quit() 上）

不要重构现有业务代码。除第三节列出的三处生命周期修改与 `createWindow` 的 close 拦截外，
main.js 的其它逻辑不动。

---

# 十三、完成标准

完成后报告（必须给出真实结果，不要只说「代码完成」）：

1. 修改 / 新增哪些文件
2. Floating Launcher 的窗口架构（两个窗口的关系与创建时机）
3. 主窗口生命周期如何处理（close 拦截、quitting 配合、showOrFocusMainWindow）
4. 退出路径如何保证（退出按钮 → lifelens:quit → before-quit 原样执行）
5. 拖动与点击如何区分（阈值判定 + 单测证明）
6. 位置持久化方式与越界校正
7. 自动化测试：npm test 实际结果 X/X，新增测试文件与条数
8. Electron 手工 smoke：上面 10 条逐条 PASS/FAIL，没跑的条目如实写明
9. 已知问题与取舍（例如透明窗口是否退化）

不要 commit。
