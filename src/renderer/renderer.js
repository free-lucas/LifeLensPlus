'use strict';

const els = {
  state: document.getElementById('state'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  openDir: document.getElementById('open-dir'),
  quit: document.getElementById('quit'),
  refresh: document.getElementById('refresh'),
  runDot: document.getElementById('run-dot'),
  running: document.getElementById('stat-running'),
  queue: document.getElementById('stat-queue'),
  last: document.getElementById('stat-last'),
  lastRel: document.getElementById('stat-last-rel'),
  total: document.getElementById('stat-total'),
  analyzed: document.getElementById('stat-analyzed'),
  errors: document.getElementById('stat-errors'),
  skipped: document.getElementById('stat-skipped'),
  noteInterval: document.getElementById('note-interval'),
  noteModel: document.getElementById('note-model'),
  error: document.getElementById('error'),
  aiDot: document.getElementById('ai-dot'),
  aiState: document.getElementById('ai-state'),
  aiCurrent: document.getElementById('ai-current'),
  aiPending: document.getElementById('ai-pending'),
  aiProcessing: document.getElementById('ai-processing'),
  aiCompleted: document.getElementById('ai-completed'),
  aiFailed: document.getElementById('ai-failed'),
  aiRetrying: document.getElementById('ai-retrying'),
  aiCancelled: document.getElementById('ai-cancelled'),
  aiNote: document.getElementById('ai-note'),
  aiLog: document.getElementById('ai-log'),
  aiPause: document.getElementById('ai-pause'),
  aiResume: document.getElementById('ai-resume'),
  summaryState: document.getElementById('summary-state'),
};

let status = {
  running: false,
  busy: false,
  queue: 0,
  count: 0,
  total: 0,
  analyzed: 0,
  errors: 0,
  skipped: 0,
  lastCaptureAt: null,
  lastError: null,
  outputDir: '',
  model: '',
  intervalMs: 20000,
};
// AI 队列状态：来自主进程的 ai-status / ai 事件。
let ai = {
  paused: false,
  offline: false,
  current: null,
  stats: {},
  events: [],
};
// 区块汇总状态（Phase 8）：驱动头部的「汇总中」标记。
let summary = {
  scanning: false,
  stats: {},
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? '');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatRelative(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 0) return '';
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function showError(message) {
  els.error.hidden = false;
  els.error.textContent = message;
}

function renderStatus() {
  const { running, busy } = status;

  els.state.className = `pill ${busy ? 'pill-busy' : running ? 'pill-on' : 'pill-off'}`;
  els.state.textContent = busy ? '分析中' : running ? '运行中' : '已停止';

  els.start.disabled = Boolean(running);
  els.stop.disabled = !running;

  els.runDot.className = `dot${busy ? ' busy' : running ? ' on' : ''}`;
  els.running.textContent = busy ? '分析中' : running ? '运行中' : '已停止';

  els.queue.textContent = String(status.queue ?? 0);

  els.last.textContent = status.lastCaptureAt ? formatDateTime(status.lastCaptureAt) : '—';
  els.lastRel.textContent = status.lastCaptureAt ? `（${formatRelative(status.lastCaptureAt)}）` : '';

  els.total.textContent = String(status.total ?? 0);
  els.analyzed.textContent = String(status.analyzed ?? 0);
  els.errors.textContent = String(status.errors ?? 0);
  els.errors.classList.toggle('alert', (status.errors ?? 0) > 0);
  els.skipped.textContent = String(status.skipped ?? 0);

  const seconds = Math.round((status.intervalMs || 20000) / 1000);
  els.noteInterval.textContent = `每 ${seconds} 秒截屏`;
  els.noteModel.textContent = `模型 ${status.model || '—'}`;

  if (status.lastError) showError(status.lastError);
}

function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderAI() {
  const stats = ai.stats || {};

  let label = '待命';
  let dotClass = 'dot on';
  if (ai.offline) {
    label = '离线（Ollama 未运行）';
    dotClass = 'dot';
  } else if (ai.paused) {
    label = '已暂停';
    dotClass = 'dot';
  } else if (ai.current) {
    label = '正在分析';
    dotClass = 'dot busy';
  }

  els.aiDot.className = dotClass;
  els.aiState.textContent = label;
  els.aiCurrent.textContent = ai.current
    ? `${formatClock(ai.current.startedAt)} ${ai.current.type}`
    : '—';

  els.aiPending.textContent = String(stats.pending ?? 0);
  els.aiProcessing.textContent = String(stats.processing ?? 0);
  els.aiCompleted.textContent = String(stats.completed ?? 0);
  els.aiFailed.textContent = String(stats.failed ?? 0);
  els.aiRetrying.textContent = String(stats.retrying ?? 0);
  els.aiCancelled.textContent = String(stats.cancelled ?? 0);

  els.aiPause.disabled = Boolean(ai.paused);
  els.aiResume.disabled = !ai.paused;

  if (ai.offline) {
    els.aiNote.textContent = 'Ollama 没有运行：截图仍在照常记录，AI 恢复后会自动继续分析。';
  } else if (ai.paused) {
    els.aiNote.textContent = 'AI 已暂停：截图继续记录，任务保留在队列里，点「继续 AI」后接着处理。';
  } else {
    els.aiNote.textContent = 'AI 不可用不会影响截图记录：截图照常保存在本地。';
  }

  const events = ai.events || [];
  els.aiLog.innerHTML = events.length
    ? events
      .map((entry) => {
        const meta = [entry.jobType, entry.status, entry.errorCode, entry.message]
          .filter(Boolean)
          .join(' · ');
        return `<li><span class="ai-log-time">${escapeHtml(formatClock(entry.at))}</span>`
          + `<span class="ai-log-event">${escapeHtml(entry.event)}</span>`
          + `<span class="ai-log-meta">${escapeHtml(meta)}</span></li>`;
      })
      .join('')
    : '<li class="empty">暂无任务日志</li>';
}

// 有待汇总 / 正在扫描的时间段时，头部显示「汇总中」标记。
function renderSummary() {
  const stats = summary?.stats ?? {};
  const pending = Number(stats.pending) || 0;
  const busy = Boolean(summary?.scanning) || pending > 0;

  els.summaryState.hidden = !busy;
  if (!busy) return;

  els.summaryState.textContent = pending > 0 ? `汇总中 ${pending}` : '汇总中';
  const failed = Number(stats.failed) || 0;
  els.summaryState.title = failed > 0
    ? `还有 ${pending} 个时间段等待汇总，${failed} 个汇总失败`
    : `还有 ${pending} 个时间段等待汇总`;
}

async function refreshAll() {
  status = await window.lifelens.getStatus();
  renderStatus();
  const nextAi = await window.lifelens.getAiStatus();
  if (nextAi) {
    ai = nextAi;
    renderAI();
  }
  const nextSummary = await window.lifelens.getSummaryStatus();
  if (nextSummary) {
    summary = nextSummary;
    renderSummary();
  }
  // 时间线自己管分页状态，这里只负责触发首屏 / 「刷新」时的重新加载。
  await window.lifelensTimeline.reload();
  await window.lifelensDynamics.reload();
  await window.lifelensDiary?.reload();
  await window.lifelensKanban?.reload();
}

els.start.addEventListener('click', async () => {
  try {
    status = await window.lifelens.start();
    renderStatus();
  } catch (error) {
    showError(error.message);
  }
});

els.stop.addEventListener('click', async () => {
  try {
    status = await window.lifelens.stop();
    renderStatus();
  } catch (error) {
    showError(error.message);
  }
});

els.refresh.addEventListener('click', () => {
  refreshAll().catch((error) => showError(error.message));
});

els.openDir.addEventListener('click', () => {
  window.lifelens.openOutputDir().catch((error) => showError(error.message));
});

// 退出（Phase 13）：关窗口只是隐藏，退出交给 Main 的 app.quit()（=> before-quit 收尾）。
els.quit.addEventListener('click', () => {
  window.lifelens.quit().catch((error) => showError(error.message));
});

els.aiPause.addEventListener('click', async () => {
  try {
    ai = await window.lifelens.pauseAi();
    renderAI();
  } catch (error) {
    showError(error.message);
  }
});

els.aiResume.addEventListener('click', async () => {
  try {
    ai = await window.lifelens.resumeAi();
    renderAI();
  } catch (error) {
    showError(error.message);
  }
});

window.lifelens.onEvent((payload) => {
  if (payload.type === 'status') {
    status = { ...status, ...payload.status };
    renderStatus();
  } else if (payload.type === 'record') {
    els.error.hidden = true;
    // 新截图前插到时间线顶部（内部按 id 去重），不重新查库。
    window.lifelensTimeline.prependRecord(payload.record);
  } else if (payload.type === 'analysis') {
    // 已加载的卡片按 screenshotId 就地回填，没加载过就忽略。
    window.lifelensTimeline.patchRecord(payload.screenshotId, payload.patch);
  } else if (payload.type === 'ai') {
    ai = payload.ai;
    renderAI();
  } else if (payload.type === 'summary') {
    // 汇总状态变化：更新头部标记，并让动态页重新读一次区块。
    summary = payload.summary;
    renderSummary();
    window.lifelensDynamics.reload().catch(() => {});
    // 区块状态变化同样影响日记日历上的标记（这一天汇总完了没有）。
    window.lifelensDiary?.reload().catch(() => {});
  } else if (payload.type === 'diary') {
    // 日记生成完成 / 状态变化：日记页重新读一次（正在生成 -> 生成完成）。
    window.lifelensDiary?.reload().catch(() => {});
  } else if (payload.type === 'error') {
    showError(payload.message);
  }
});

// ---- 标签页：记录 / 动态 / 日记 / 看板 / 搜索 / 问答 ----
const TAB_VIEWS = ['overview', 'dynamics', 'diary', 'kanban', 'search', 'ask'];

function selectTab(name) {
  const target = TAB_VIEWS.includes(name) ? name : 'overview';
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === target);
  }
  for (const view of document.querySelectorAll('.view')) {
    view.hidden = view.id !== `view-${target}`;
  }
  // 热力图画的是「最近 12 小时」，切回来时按当前时间重新对齐一次。
  if (target === 'dynamics') window.lifelensDynamics.reload().catch(() => {});
  // 日记页的「今天」标记与看板的「本期」都要按当前时间重新判断。
  if (target === 'diary') window.lifelensDiary?.reload().catch(() => {});
  if (target === 'kanban') window.lifelensKanban?.reload().catch(() => {});
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
}

// 搜索页（Phase 11）点结果后要切到时间线 / 日记页：把切换入口暴露出去，
// 避免搜索页再复制一份 class 切换与「切页时刷新」的逻辑。
window.lifelensTabs = { select: selectTab };

setInterval(() => {
  if (status.lastCaptureAt) {
    els.lastRel.textContent = `（${formatRelative(status.lastCaptureAt)}）`;
  }
}, 10000);

(async () => {
  try {
    await refreshAll();
  } catch (error) {
    showError(error.message);
  }
})();
