'use strict';

// Phase 11：记忆搜索页的渲染层。
// 数据只有一个来源：Phase 11 的 lifelens:memory-search 通道（window.lifelens.searchMemories）。
// 这一层不碰 LanceDB、不做向量计算，只负责：输入 -> 调 IPC -> 画结果 -> 跳转到已有页面。
//
// 整个文件包在一个 IIFE 里：renderer.js 与本文件都是 classic script，共享同一个全局作用域，
// 两边都定义了 pad / escapeHtml 这类小工具；不隔离的话，后加载的 renderer.js 会覆盖这里的同名函数。
// 上半部分是纯函数（最近搜索 / 时间格式化 / 跳转指令 / 结果卡片），通过 module.exports 暴露给
// node --test 直接 require；末尾的 DOM 初始化只在渲染进程里执行。

(function () {

const RESULT_LIMIT = 20;
const RECENT_LIMIT = 8;
const RECENT_STORAGE_KEY = 'lifelens.search.recent';
// Activity 只记录一个瞬间，定位窗口取它自己那一秒（Timeline 是闭开区间 [from, to)）。
const FOCUS_ACTIVITY_MS = 1000;

// 来源类型的固定顺序与显示名：与 Main 层 MemorySearchService 的 SOURCE_LAYERS 对应。
const LAYER_META = [
  ['activity', '20秒记录'],
  ['block', '10分钟汇总'],
  ['diary', '日记'],
];
const SOURCE_LABELS = Object.fromEntries(LAYER_META);

function pad(value) {
  return String(value).padStart(2, '0');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function sourceLabelOf(item) {
  return item?.sourceLabel || SOURCE_LABELS[item?.sourceType] || '记忆';
}

// ---- 最近搜索：一串关键词，去重、新的在前、有上限 ----
// 存 localStorage（界面状态，不是记忆数据）；storage 由调用方注入，测试里可以传假实现。

function readRecent(storage) {
  try {
    const raw = storage?.getItem(RECENT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .slice(0, RECENT_LIMIT);
  } catch {
    // 存坏了就当没有历史，不能因此让搜索页起不来。
    return [];
  }
}

// 同一个关键词再搜一次只保留最新的一条，不产生重复。
function addRecent(list, keyword, { limit = RECENT_LIMIT } = {}) {
  const text = String(keyword ?? '').trim();
  const kept = (Array.isArray(list) ? list : []).filter((item) => item !== text);
  if (!text) return kept.slice(0, limit);
  return [text, ...kept].slice(0, limit);
}

function saveRecent(storage, list) {
  try {
    storage?.setItem(RECENT_STORAGE_KEY, JSON.stringify(list ?? []));
  } catch {
    // 写不进去（隐私模式 / 配额）只影响「最近搜索」这一块，搜索本身照常。
  }
}

// ---- 时间与结果整形 ----

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatClock(value) {
  const date = toDate(value);
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '';
}

// 日记只有日期；20 秒记录显示到分钟；10 分钟汇总再带上结束时刻（同一个区块）。
function formatResultTime(item) {
  if (!item) return '';
  if (item.sourceType === 'diary') return String(item.day ?? item.time ?? '');

  const start = formatDateTime(item.time);
  if (!start) return String(item.time ?? '');
  const end = item.endTime ? formatClock(item.endTime) : '';
  return end ? `${start}–${end}` : start;
}

// 结果 -> 时间线定位窗口（闭开区间）。区块看那 10 分钟，Activity 看它自己那一秒。
function focusWindowOf(item) {
  const from = item?.time ? toDate(item.time) : null;
  if (!from) return null;

  const end = item.endTime ? toDate(item.endTime) : null;
  if (end && end.getTime() > from.getTime()) return { from, to: end };
  return { from, to: new Date(from.getTime() + FOCUS_ACTIVITY_MS) };
}

// 结果 -> 跳转指令。这一层只算「该去哪个页面、定位到哪里」，
// 真正切换标签页与调用视图对象由 applyJump 完成（因此这里可以在测试里断言）。
function jumpTargetOf(item) {
  if (!item || typeof item.sourceType !== 'string') return null;

  // 日记没有「那一天之外的定位窗口」：直接打开日记页的那一天。
  if (item.sourceType === 'diary') {
    const day = item.day ?? null;
    return day ? { tab: 'diary', day } : null;
  }

  const range = focusWindowOf(item);
  if (!range) return null;
  return { tab: 'overview', range, id: item.timelineId ?? null };
}

function applyJump(target, views) {
  if (!target) return false;
  if (target.tab === 'diary') {
    views?.tabs?.select?.('diary');
    views?.diary?.selectDay?.(target.day);
    return true;
  }
  views?.tabs?.select?.('overview');
  views?.timeline?.focus?.(target.range, target.id ?? null);
  return true;
}

// Electron 的 IPC 错误带「Error invoking remote method '...'」前缀，界面上只留可读的那半句。
function cleanErrorMessage(error) {
  const raw = String(error?.message ?? error ?? '');
  const match = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw);
  return (match ? match[1] : raw).trim() || '未知原因';
}

// ---- 渲染 ----

function renderCard(item, index) {
  const meta = [];
  if (item.project) meta.push(`项目 ${escapeHtml(item.project)}`);
  if (item.category) meta.push(`分类 ${escapeHtml(item.category)}`);

  const keywords = Array.isArray(item.keywords) ? item.keywords.filter(Boolean) : [];
  const content = String(item.content ?? '').trim();
  const title = String(item.title ?? '').trim();

  return `
    <li class="search-card" data-open="${index}">
      <div class="record-head">
        <span class="search-source search-source-${escapeHtml(item.sourceType)}">${escapeHtml(sourceLabelOf(item))}</span>
        <span class="record-time">${escapeHtml(formatResultTime(item))}</span>
        <button class="spacer" data-open="${index}">查看记录</button>
      </div>
      ${title ? `<p class="record-activity">${escapeHtml(title)}</p>` : ''}
      ${content
        ? `<p class="record-summary">${escapeHtml(content)}</p>`
        : '<p class="search-missing-line">这条记录没有可显示的内容</p>'}
      ${meta.length ? `<p class="record-meta">${meta.join(' · ')}</p>` : ''}
      ${keywords.length
        ? `<p class="record-keywords">${escapeHtml(item.keywordsLabel || '关键词')}：${escapeHtml(keywords.join(' · '))}</p>`
        : ''}
    </li>`;
}

function renderResults(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return '<div class="timeline-empty">'
      + '<p>没有找到相关的记忆</p>'
      + '<p>换一种说法试试，或等记忆索引完成嵌入后再搜。</p>'
      + '</div>';
  }
  return `<ol class="search-results">${items.map(renderCard).join('')}</ol>`;
}

// 结果统计：各层候选条数 + 回查时被跳过的失效 / 异常记录。
function resultSummary(payload) {
  const counts = payload?.layerCounts ?? {};
  const parts = LAYER_META.map(([key, label]) => `${label} ${Number(counts[key]) || 0}`).join(' · ');
  const notes = [];
  if (Number(payload?.missing) > 0) notes.push(`已失效 ${payload.missing} 条`);
  if (Number(payload?.invalid) > 0) notes.push(`跳过异常 ${payload.invalid} 条`);
  return `找到 ${Number(payload?.returned) || 0} 条相关记忆 · 各层候选：${parts}`
    + (notes.length ? `（${notes.join('，')}）` : '');
}

function createSearchView({
  input, submit, statusEl, resultsEl, recentEl, recentWrap, history, search, views,
}) {
  let recents = readRecent(history);
  let items = [];

  // 视图对象（标签页 / 时间线 / 日记页）在本文件之后才挂到 window 上，所以每次跳转时现取。
  const resolveViews = typeof views === 'function' ? views : () => views;

  function setStatus(text, { error = false } = {}) {
    const message = String(text ?? '');
    statusEl.hidden = message === '';
    statusEl.textContent = message;
    statusEl.className = error ? 'search-status error' : 'search-status';
  }

  function renderRecents() {
    recentWrap.hidden = recents.length === 0;
    recentEl.innerHTML = recents
      .map((keyword, index) => `<button type="button" class="search-recent-item" data-recent="${index}">`
        + `${escapeHtml(keyword)}</button>`)
      .join('');
  }

  async function run(keyword) {
    const text = String(keyword ?? input.value ?? '').trim();
    if (!text) {
      items = [];
      resultsEl.innerHTML = '<p class="timeline-state">先输入一句话，再开始搜索。</p>';
      setStatus('');
      return;
    }

    input.value = text;
    recents = addRecent(recents, text);
    saveRecent(history, recents);
    renderRecents();

    items = [];
    setStatus('正在搜索记忆…');
    resultsEl.innerHTML = '<p class="timeline-state">正在搜索记忆…</p>';

    try {
      const payload = await search(text, RESULT_LIMIT);
      items = Array.isArray(payload?.items) ? payload.items : [];
      resultsEl.innerHTML = renderResults(payload);
      setStatus(items.length ? resultSummary(payload) : `没有找到「${text}」相关的记忆。`);
    } catch (error) {
      // 失败时给可读的原因（Embedding 不可用 / 向量库不可用），不把页面留成空白。
      resultsEl.innerHTML = `<p class="timeline-error">搜索失败：${escapeHtml(cleanErrorMessage(error))}</p>`;
      setStatus('搜索失败，确认本地 Ollama 与 embedding 模型可用后重试。', { error: true });
    }
  }

  function openIndex(index) {
    const target = jumpTargetOf(items[index]);
    if (!target) {
      setStatus('这条结果暂时无法跳转。', { error: true });
      return;
    }
    applyJump(target, resolveViews());
    setStatus(target.tab === 'diary' ? '已跳转到日记页。' : '已跳转到时间线并定位到这条记录。');
  }

  submit.addEventListener('click', () => { run().catch(() => {}); });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault?.();
    run().catch(() => {});
  });
  onElementClick(recentEl, (event) => {
    const button = event.target.closest('[data-recent]');
    if (!button) return;
    run(recents[Number(button.dataset.recent)]).catch(() => {});
  });
  onElementClick(resultsEl, (event) => {
    const card = event.target.closest('[data-open]');
    if (!card) return;
    openIndex(Number(card.dataset.open));
  });

  renderRecents();
  resultsEl.innerHTML = '<p class="timeline-state">输入一句话，搜索你的历史记忆。</p>';

  return {
    run,
    read: () => ({ recents: recents.slice(), items: items.slice() }),
    readRecents: () => recents.slice(),
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
  const input = document.getElementById('search-input');
  const submit = document.getElementById('search-submit');
  const statusEl = document.getElementById('search-status');
  const resultsEl = document.getElementById('search-results');
  const recentEl = document.getElementById('search-recent');
  const recentWrap = document.getElementById('search-recent-wrap');
  if (!input || !submit || !statusEl || !resultsEl || !recentEl || !recentWrap) return;

  window.lifelensSearch = createSearchView({
    input,
    submit,
    statusEl,
    resultsEl,
    recentEl,
    recentWrap,
    history: window.localStorage,
    search: (query, limit) => window.lifelens.searchMemories(query, limit),
    views: () => ({
      tabs: window.lifelensTabs,
      timeline: window.lifelensTimeline,
      diary: window.lifelensDiary,
    }),
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();

// 问答页（Phase 12）要复用这里的跳转与结果卡片渲染，不能在 ask.js 里再复制一份。
// 这些函数仍然只活在 IIFE 内（不污染全局作用域），只通过命名空间共享。
if (typeof window !== 'undefined') {
  window.lifelensSearchKit = {
    jumpTargetOf,
    applyJump,
    cleanErrorMessage,
    renderResults,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RESULT_LIMIT,
    RECENT_LIMIT,
    RECENT_STORAGE_KEY,
    LAYER_META,
    readRecent,
    addRecent,
    saveRecent,
    sourceLabelOf,
    formatResultTime,
    focusWindowOf,
    jumpTargetOf,
    applyJump,
    cleanErrorMessage,
    renderCard,
    renderResults,
    resultSummary,
    createSearchView,
  };
}

})();
