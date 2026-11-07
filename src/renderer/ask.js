'use strict';

// Phase 12：问答页（Ask My Life v1）的渲染层。
// 数据只有一个来源：Phase 12 的 lifelens:ask 通道（window.lifelens.ask）。
// 这一层不碰 SQLite / LanceDB / Ollama / Embedding，只负责：
// 输入问题 -> 调 IPC -> 画回答与相关记忆 -> 跳转到已有页面。
//
// 与 search.js 相同的两条约定：
// - 整个文件包在 IIFE 里：与 renderer.js / search.js 共享同一个全局作用域，
//   不隔离的话同名的 escapeHtml 会被后加载的脚本覆盖；
// - 跳转（jumpTargetOf / applyJump）与相关记忆的卡片渲染一律复用 search.js 暴露的
//   window.lifelensSearchKit，不在这里复制第二份。
// 上半部分是纯函数，通过 module.exports 暴露给 node --test；末尾的 DOM 初始化只在渲染进程里执行。

(function () {

const CONFIDENCE_LABELS = Object.freeze({ high: '高', medium: '中', low: '低' });

const NO_QUESTION_HINT = '先输入一个问题，再开始提问。';
// 本地模型生成要十几秒到几十秒：文案要让用户知道等待是正常的。
const LOADING_HINT = '正在检索记忆并生成回答…（本地模型通常要十几秒到几十秒）';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function confidenceLabel(confidence) {
  return CONFIDENCE_LABELS[String(confidence ?? '').trim()] ?? '未知';
}

// 回答 + 依据充分程度。耗时与模型有值就顺带写上，方便判断这次回答是怎么来的。
function renderAnswer(payload) {
  const answer = String(payload?.answer ?? '').trim();
  if (!answer) return `<p class="timeline-state">${escapeHtml(NO_QUESTION_HINT)}</p>`;

  const meta = [`依据充分程度：${confidenceLabel(payload?.confidence)}`];
  const elapsedMs = Number(payload?.elapsedMs);
  if (Number.isFinite(elapsedMs) && elapsedMs > 0) meta.push(`用时 ${(elapsedMs / 1000).toFixed(1)} 秒`);

  return '<div class="ask-answer-body">'
    + `<p class="ask-answer-text">${escapeHtml(answer)}</p>`
    + `<p class="ask-answer-meta">${escapeHtml(meta.join(' · '))}</p>`
    + '</div>';
}

function createAskView({
  input, submit, statusEl, answerEl, memoriesEl, memoriesWrap, ask, kit, views,
}) {
  let memories = [];
  let busy = false;

  // 视图对象（标签页 / 时间线 / 日记页）在本文件之后才挂到 window 上，所以每次跳转时现取。
  const resolveViews = typeof views === 'function' ? views : () => views;

  function setStatus(text, { error = false } = {}) {
    const message = String(text ?? '');
    statusEl.hidden = message === '';
    statusEl.textContent = message;
    statusEl.className = error ? 'search-status error' : 'search-status';
  }

  // 生成期间禁用提交按钮：这是唯一防重复提交的开关。
  function setBusy(next) {
    busy = next;
    submit.disabled = next;
  }

  function renderMemories() {
    memoriesWrap.hidden = memories.length === 0;
    memoriesEl.innerHTML = memories.length ? kit.renderResults({ items: memories }) : '';
  }

  async function run(question) {
    const text = String(question ?? input.value ?? '').trim();
    if (!text) {
      answerEl.innerHTML = `<p class="timeline-state">${escapeHtml(NO_QUESTION_HINT)}</p>`;
      setStatus('');
      return;
    }
    if (busy) return;

    input.value = text;
    memories = [];
    renderMemories();
    setBusy(true);
    setStatus('正在回忆并生成回答…');
    answerEl.innerHTML = `<p class="timeline-state">${escapeHtml(LOADING_HINT)}</p>`;

    try {
      const payload = await ask(text);
      memories = Array.isArray(payload?.memories) ? payload.memories : [];
      answerEl.innerHTML = renderAnswer(payload);
      renderMemories();
      setStatus(memories.length ? `回答基于 ${memories.length} 条相关记忆` : '');
    } catch (error) {
      // 失败时给可读的原因（检索不可用 / 模型不可用 / 超时），页面结构与相关记忆区都不留残骸。
      answerEl.innerHTML = `<p class="timeline-error">提问失败：${escapeHtml(kit.cleanErrorMessage(error))}</p>`;
      memories = [];
      renderMemories();
      setStatus('提问失败，确认本地 Ollama 与 embedding 模型可用后重试。', { error: true });
    } finally {
      setBusy(false);
    }
  }

  function openMemory(index) {
    const target = kit.jumpTargetOf(memories[index]);
    if (!target) {
      setStatus('这条记忆暂时无法跳转。', { error: true });
      return;
    }
    kit.applyJump(target, resolveViews());
    setStatus(target.tab === 'diary' ? '已跳转到日记页。' : '已跳转到时间线并定位到这条记忆。');
  }

  submit.addEventListener('click', () => { run().catch(() => {}); });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault?.();
    run().catch(() => {});
  });
  onElementClick(memoriesEl, (event) => {
    const card = event.target.closest('[data-open]');
    if (!card) return;
    openMemory(Number(card.dataset.open));
  });

  setStatus('');
  answerEl.innerHTML = `<p class="timeline-state">${escapeHtml(NO_QUESTION_HINT)}</p>`;
  renderMemories();

  return {
    run,
    read: () => ({ memories: memories.slice(), busy }),
  };
}

// 事件目标可能是文本节点（没有 closest），统一走一层保护。
function onElementClick(element, handler) {
  element.addEventListener('click', (event) => {
    if (typeof event?.target?.closest !== 'function') return;
    handler(event);
  });
}

function init() {
  const input = document.getElementById('ask-input');
  const submit = document.getElementById('ask-submit');
  const statusEl = document.getElementById('ask-status');
  const answerEl = document.getElementById('ask-answer');
  const memoriesEl = document.getElementById('ask-memories');
  const memoriesWrap = document.getElementById('ask-memories-wrap');
  if (!input || !submit || !statusEl || !answerEl || !memoriesEl || !memoriesWrap) return;

  // 跳转与卡片渲染都来自 search.js（先加载）；没有它这一页没法跳转，索性不装配。
  const kit = window.lifelensSearchKit;
  if (!kit) return;

  window.lifelensAsk = createAskView({
    input,
    submit,
    statusEl,
    answerEl,
    memoriesEl,
    memoriesWrap,
    ask: (question) => window.lifelens.ask(question),
    kit,
    views: () => ({
      tabs: window.lifelensTabs,
      timeline: window.lifelensTimeline,
      diary: window.lifelensDiary,
    }),
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIDENCE_LABELS,
    NO_QUESTION_HINT,
    LOADING_HINT,
    escapeHtml,
    confidenceLabel,
    renderAnswer,
    createAskView,
  };
}

})();
