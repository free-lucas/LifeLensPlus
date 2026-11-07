'use strict';

// Phase 13：悬浮入口的交互层。这里只有两条手势：
//   位移不超过阈值 -> 单击：打开 / 聚焦主界面
//   位移超过阈值   -> 拖动：拖动中持续把位置发给 Main（由 Main clamp 后 setPosition），松手保存位置
//
// Phase 13.1 在这两种手势之外加了第二类输入：Main 推来的事件（status / record / analysis / error）。
// 事件只做一件事 —— 切换 body 上的 class，视觉全部交给 CSS：
//   status            -> state-running / state-paused（持续态）
//   record / analysis / error -> effect-shutter / effect-success / effect-error（瞬时态，animationend 回收）
//
// 不用 CSS 的 -webkit-app-region: drag：它在 Windows 上会把 drag 区域的 click 一起吞掉，
// 「拖动」和「点击」就没法自己区分了。
//
// 与其它渲染层文件同构：上半部分是纯函数（node --test 直接 require），
// 末尾的 DOM 初始化只在渲染进程里执行。

(function () {

// 4px：小于它算手抖，仍然当作点击。
const DRAG_THRESHOLD_PX = 4;

// 持续态：任意时刻最多一个。
const STATE_CLASSES = Object.freeze(['state-running', 'state-paused']);

// 瞬时态：事件类型 -> body class。与 launcher.css 里的 .effect-* 一一对应。
const EFFECT_CLASSES = Object.freeze({
  record: 'effect-shutter',
  analysis: 'effect-success',
  error: 'effect-error',
});

// 动画名 -> class。只认「主光圈」那条动画（它与其他动画同时长），
// 这样两个特效叠在一起时，结束的那一个只回收自己，不会误删另一个。
const EFFECT_OF_ANIMATION = Object.freeze({
  'shutter-ring': 'effect-shutter',
  'shutter-ring-flash': 'effect-shutter',
  'success-ring': 'effect-success',
  'success-ring-flash': 'effect-success',
  'error-ring': 'effect-error',
});

// Phase 13.2：每个瞬时特效上场的是哪只小镜。键就是 EFFECT_CLASSES 的值，
// 一一对应，不多不少：
//   record   -> 得意：刚截完一张图
//   analysis -> 开心：分析结果写回来了
//   error    -> 思考：小镜一脸「咦？」（专门的沮丧态还没画，先借用思考）
// 素材是 src/renderer/assets/mascot-*.svg，按原样内联在 launcher.html 里。
const EFFECT_MASCOTS = Object.freeze({
  'effect-shutter': 'smug',
  'effect-success': 'happy',
  'effect-error': 'thinking',
});

// Phase 13.3 / 13.4：持续态也有一只 —— 待机小镜，它现在是悬浮球的**默认脸**。
// 它和上面三只的用法不同：那三只由瞬时态的 class 驱动、演完就收；
// 这一只在录制中与暂停时都在台上（CSS 里由 body.state-* 放它出来），
// 只有三个瞬时态时才让位，所以它不挂 class，时间轴由 applyState 直接管。
const IDLE_MASCOT = 'idle';

// 事件 -> 该加的特效 class；不需要特效的事件（status、未知类型）返回 null。
function effectClassOf(payload) {
  return EFFECT_CLASSES[payload?.type] ?? null;
}

// 录制中 / 已暂停。只看布尔真值：坏包（undefined、'true'、1）一律按「已暂停」处理，
// 宁可显示成暂停，也不要在没在截图的时候显出「正在记录」的假状态。
function stateClassOf(running) {
  return running === true ? 'state-running' : 'state-paused';
}

// 手势判定是纯函数：只吃累计位移与阈值，输出 'click' | 'drag'。
function gestureOf(delta, threshold = DRAG_THRESHOLD_PX) {
  const dx = Number(delta?.dx) || 0;
  const dy = Number(delta?.dy) || 0;
  return Math.hypot(dx, dy) > threshold ? 'drag' : 'click';
}

function createLauncherView({ api, view = window, doc = document, threshold = DRAG_THRESHOLD_PX }) {
  // 一次按下的状态；松手后立刻清空，所以不会漏掉任何一次手势。
  let press = null;

  function onMouseDown(event) {
    if (event.button !== 0) return;
    press = {
      startX: event.screenX,
      startY: event.screenY,
      // 按下那一刻的窗口位置：后面所有位移都以它为基准。
      windowX: view.screenX,
      windowY: view.screenY,
      dragging: false,
    };
    event.preventDefault?.();
  }

  function onMouseMove(event) {
    if (!press) return;
    const dx = event.screenX - press.startX;
    const dy = event.screenY - press.startY;

    if (!press.dragging) {
      if (gestureOf({ dx, dy }, threshold) === 'click') return;
      press.dragging = true;
      doc.body?.classList?.add('dragging');
    }

    // 位置全程按「按下时的窗口位置 + 累计位移」算：不读 window.screenX 的实时值，
    // 所以快速拖动时不会因为刷新时机丢掉位移。越界由 Main 统一 clamp。
    api.dragMove({ x: press.windowX + dx, y: press.windowY + dy });
  }

  function onMouseUp() {
    const state = press;
    press = null;
    if (!state) return;
    doc.body?.classList?.remove('dragging');

    // 悬浮球上失败没有可展示的地方：静默忽略，下一次手势照常可用。
    if (state.dragging) {
      Promise.resolve(api.dragEnd()).catch(() => {});
      return;
    }
    Promise.resolve(api.openMain()).catch(() => {});
  }

  // ---- Phase 13.1：事件 -> body class ----

  const bodyClass = doc.body?.classList;

  // ---- Phase 13.2：三只小镜 ----

  // 小镜的动画是 SMIL，没有 animationend。所以生命周期照旧由光圈那条 CSS 动画驱动，
  // 这里只管两件事：出场时把时间轴拨回第一帧再放开，演完冻回去。
  const reduceMotion = view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

  function mascotOf(state) {
    return doc.querySelector?.(`.mascot-${state}`)?.querySelector?.('svg') ?? null;
  }

  // 三个 SMIL 入口都挂在 <svg> 根上：缺一个就整个放弃，只靠 CSS 演。
  // 也正好让假 doc（单测里没有 querySelector）安静地什么都不做。
  function isTimeline(node) {
    return typeof node?.setCurrentTime === 'function'
      && typeof node?.pauseAnimations === 'function'
      && typeof node?.unpauseAnimations === 'function';
  }

  function freezeMascot(node) {
    if (!isTimeline(node)) return;
    node.pauseAnimations();
    node.setCurrentTime(0);
  }

  function playMascot(node) {
    // 「减少动态效果」下不放开时间轴：小镜停在自己第一帧（那一帧本来就是完整构图），
    // 只由 CSS 淡入淡出。
    if (reduceMotion || !isTimeline(node)) return;
    node.setCurrentTime(0);
    node.unpauseAnimations();
  }

  // 一加载就全部冻住：常驻小球的 SVG 不该在第一次 status 到达前自己空转。
  // 待机那只也在内 —— 它第一帧本来就是完整构图，冻着也好看（家族硬约束第 1 条）。
  for (const state of [...Object.values(EFFECT_MASCOTS), IDLE_MASCOT]) freezeMascot(mascotOf(state));

  // 持续态：先摘掉两个再挂上对应的一个，任何时候都不会同时存在两个状态。
  // 待机小镜在两个状态下都在台上，所以时间轴跟着录制状态走，方向与「藏起来才冻」相反：
  //   录制中 -> 放开（球亮着、外围扫光在转，小镜也跟着演）
  //   暂停   -> 冻回第 0 帧（「一暂停整个圆标完全静止」是 13.1 定下的信号，
  //            脸换成小镜以后这条要保住，不能再让它在暂停时动）
  function applyState(running) {
    for (const name of STATE_CLASSES) bodyClass?.remove(name);
    bodyClass?.add(stateClassOf(running));

    const idle = mascotOf(IDLE_MASCOT);
    if (running) playMascot(idle);
    else freezeMascot(idle);
  }

  // 瞬时态：同类事件在动画没播完时又来了，就重播而不是叠加。
  // 中间那次强制 reflow 是必需的：不读一次布局属性，浏览器会把
  // remove + add 合并掉，动画不会重新开始。
  function playEffect(name) {
    bodyClass?.remove(name);
    void doc.body?.offsetWidth;
    bodyClass?.add(name);
    // 同一只小镜连着触发两次也要从第一帧重来：先拨回 0，再放开。
    playMascot(mascotOf(EFFECT_MASCOTS[name]));
  }

  function onEvent(payload) {
    if (payload?.type === 'status') {
      applyState(payload.running === true);
      return;
    }
    const effect = effectClassOf(payload);
    if (effect) playEffect(effect);
  }

  // 动画播完就摘掉 class，特效不会残留。动画名 -> class 的映射在
  // EFFECT_OF_ANIMATION 里，未知动画（将来的新特效）不处理。
  function onAnimationEnd(event) {
    const name = EFFECT_OF_ANIMATION[event?.animationName];
    if (!name) return;
    bodyClass?.remove(name);
    // 演完立刻冻住：看不见的时候不该还在跑时间轴。
    freezeMascot(mascotOf(EFFECT_MASCOTS[name]));
  }

  // 右键：不画自定义菜单，也没收浏览器默认菜单，交给 Main 弹原生 Menu。
  function onContextMenu(event) {
    event?.preventDefault?.();
    Promise.resolve(api.showContextMenu?.()).catch(() => {});
  }

  // 监听都挂在 document 上：整个 56x56 窗口都是热区，
  // 按在球体边缘（透明的角落）也能拖。刻意不监听 mouseleave：
  // 拖动中窗口跟着鼠标走，一旦按窗口离开就结束拖动反而会断开手势。
  doc.addEventListener('mousedown', onMouseDown);
  doc.addEventListener('mousemove', onMouseMove);
  doc.addEventListener('mouseup', onMouseUp);
  doc.addEventListener('contextmenu', onContextMenu);
  doc.addEventListener('animationend', onAnimationEnd);

  // 事件订阅：没有 onEvent（老版本 preload）就只做手势，不影响页面其余部分。
  if (typeof api.onEvent === 'function') api.onEvent(onEvent);

  return { onMouseDown, onMouseMove, onMouseUp, onEvent };
}

function init() {
  const api = window.lifelensLauncher;
  // 没有 preload 就什么都不做，而不是抛错（页面本身还能打开）。
  if (!api) return;
  createLauncherView({ api });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DRAG_THRESHOLD_PX,
    STATE_CLASSES,
    EFFECT_CLASSES,
    EFFECT_MASCOTS,
    IDLE_MASCOT,
    gestureOf,
    effectClassOf,
    stateClassOf,
    createLauncherView,
  };
}

})();
