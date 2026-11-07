'use strict';

// Phase 9：看板页的渲染层（日 / 周 / 月 / 年的多维度图表）。
//
// 与 timeline.js / dynamics.js 相同的约定：整个文件包在 IIFE 里，上半部分是纯函数、
// 通过 module.exports 暴露给 node --test 直接 require，末尾的 DOM 初始化只在渲染进程里执行。
//
// 图表全部用手写 SVG：
// - 页面 CSP 是 style-src 'self'，内联 style 属性会被挡掉，所以宽度 / 高度 / 颜色
//   一律走 SVG 表现属性（x / y / width / height / class），不写 style="..."；
// - 几何计算（分桶、占比、堆叠）都在纯函数里完成，测试直接断言数值；
// - 日期边界与前后锚点由主进程算好，这一层不碰日期数学。

(function () {

const PERIODS = ['day', 'week', 'month', 'year'];
const PERIOD_LABELS = Object.freeze({ day: '日', week: '周', month: '月', year: '年' });
// 默认看「本周」：日视图在上午打开往往几乎是空的。
const DEFAULT_PERIOD = 'week';

// 与区块分类同一份口径（中文四类）。
const CATEGORY_ORDER = ['娱乐', '工作', '学习', '社交'];
const CATEGORY_CLASSES = Object.freeze({
  娱乐: 'cat-fun',
  工作: 'cat-work',
  学习: 'cat-study',
  社交: 'cat-social',
});

const DONUT_SIZE = 132;
const DONUT_RADIUS = 46;
const DONUT_STROKE = 16;

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

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

// 图表轴上的短标签：45 -> 45m，180 -> 3h。
function formatShortMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value}m`;
  const hours = value / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

function formatShare(share) {
  const value = Number(share) || 0;
  if (value <= 0) return '0%';
  if (value < 0.01) return '<1%';
  return `${Math.round(value * 100)}%`;
}

function categoryClass(category) {
  return CATEGORY_CLASSES[category] ?? '';
}

function truncateLabel(value, maxLength = 14) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function buildStatsQuery({ period, anchor } = {}) {
  return { period: PERIODS.includes(period) ? period : DEFAULT_PERIOD, anchor: anchor || null };
}

// ---- 环形图（时间分配）----

function donutSlices(categories) {
  const circumference = 2 * Math.PI * DONUT_RADIUS;
  const total = (categories ?? []).reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
  const slices = [];
  let offset = 0;
  for (const item of categories ?? []) {
    const minutes = Number(item.minutes) || 0;
    if (minutes <= 0 || total <= 0) continue;
    const length = (minutes / total) * circumference;
    slices.push({
      category: item.category,
      minutes,
      length: round2(length),
      // stroke-dashoffset 用负数把虚线段前移到累计位置（配合 rotate(-90) 从 12 点开始）。
      offset: round2(-offset),
      share: total ? minutes / total : 0,
    });
    offset += length;
  }
  return { circumference: round2(circumference), total, slices };
}

function renderDonut(categories, totals = {}) {
  const { circumference, total, slices } = donutSlices(categories);
  const minutes = Number(totals.minutes) || total;
  const center = DONUT_SIZE / 2;

  const svg = [
    `<svg class="chart-donut" viewBox="0 0 ${DONUT_SIZE} ${DONUT_SIZE}" role="img" aria-label="时间分配">`,
    `<circle class="donut-track" cx="${center}" cy="${center}" r="${DONUT_RADIUS}"`,
    ` stroke-width="${DONUT_STROKE}" />`,
    slices
      // 四个分类之外的取值（历史脏数据）也要有颜色，否则扇区会画成透明。
      .map((slice) => `<circle class="donut-slice ${categoryClass(slice.category) || 'chart-bar-other'}" cx="${center}" cy="${center}"`
        + ` r="${DONUT_RADIUS}" stroke-width="${DONUT_STROKE}"`
        + ` stroke-dasharray="${slice.length} ${round2(circumference - slice.length)}"`
        + ` stroke-dashoffset="${slice.offset}" transform="rotate(-90 ${center} ${center})" />`)
      .join(''),
    `<text class="donut-total" x="${center}" y="${center + 2}">${escapeHtml(formatShortMinutes(minutes))}</text>`,
    `<text class="donut-unit" x="${center}" y="${center + 18}">已汇总时长</text>`,
    '</svg>',
  ].join('');

  const legend = (categories ?? [])
    .map((item) => `<li class="chart-legend-item">`
      + `<i class="chart-swatch ${categoryClass(item.category) || 'chart-swatch-empty'}"></i>`
      + `<span class="chart-legend-label">${escapeHtml(item.category)}</span>`
      + `<span class="chart-legend-value">${escapeHtml(formatMinutes(item.minutes))}`
      + ` · ${escapeHtml(formatShare(item.share))}</span></li>`)
    .join('');

  return `<div class="chart-donut-wrap">${svg}<ul class="chart-legend">${legend}</ul></div>`;
}

// ---- 堆叠柱状图（活动趋势 / 时段分布）----

function trendGeometry(trend, { width = 720, height = 220, top = 16, right = 14, bottom = 26, left = 40 } = {}) {
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const items = Array.isArray(trend) ? trend : [];
  const count = Math.max(items.length, 1);
  const step = plotWidth / count;
  const barWidth = Math.max(2, Math.min(step * 0.66, 34));
  const maxMinutes = Math.max(1, ...items.map((item) => Number(item.minutes) || 0));
  const maxActivities = Math.max(1, ...items.map((item) => Number(item.activities) || 0));

  const bars = items.map((item, index) => {
    const x = round2(left + step * index + (step - barWidth) / 2);
    let cursor = top + plotHeight;
    const segments = [];
    const byCategory = { ...(item.byCategory ?? {}) };
    // 四个分类固定按顺序堆叠，数据里出现过的其它分类追加在后面，保证总高度与分钟数一致。
    const order = [...CATEGORY_ORDER, ...Object.keys(byCategory).filter((key) => !CATEGORY_ORDER.includes(key))];
    for (const category of order) {
      const minutes = Number(byCategory[category]) || 0;
      if (minutes <= 0) continue;
      const segmentHeight = (minutes / maxMinutes) * plotHeight;
      cursor -= segmentHeight;
      segments.push({
        category,
        minutes,
        x,
        y: round2(cursor),
        width: round2(barWidth),
        height: round2(segmentHeight),
      });
    }
    return {
      key: item.key,
      label: item.label,
      x,
      width: round2(barWidth),
      centerX: round2(x + barWidth / 2),
      segments,
      minutes: Number(item.minutes) || 0,
      activities: Number(item.activities) || 0,
      future: Boolean(item.future),
      totalHeight: round2(((Number(item.minutes) || 0) / maxMinutes) * plotHeight),
    };
  });

  const points = items.map((item, index) => ({
    x: round2(left + step * index + step / 2),
    y: round2(top + plotHeight - ((Number(item.activities) || 0) / maxActivities) * plotHeight),
    value: Number(item.activities) || 0,
  }));

  const ticks = [0, 0.5, 1].map((ratio) => ({
    y: round2(top + plotHeight - ratio * plotHeight),
    label: formatShortMinutes(ratio * maxMinutes),
  }));

  return {
    width,
    height,
    left,
    top,
    plotWidth,
    plotHeight,
    step: round2(step),
    barWidth: round2(barWidth),
    maxMinutes,
    maxActivities,
    bars,
    points,
    ticks,
  };
}

function renderTrendChart(trend, { title, note, height = 220 } = {}) {
  const items = Array.isArray(trend) ? trend : [];
  const hasData = items.some((item) => (Number(item.minutes) || 0) > 0);
  const head = `<h3 class="chart-title">${escapeHtml(title)}${note ? `<i class="chart-note">${escapeHtml(note)}</i>` : ''}</h3>`;
  if (!items.length || !hasData) {
    return `<section class="panel chart-panel chart-wide">${head}<p class="timeline-state">这个周期还没有汇总数据。</p></section>`;
  }

  const geometry = trendGeometry(items, { height });
  const grid = geometry.ticks
    .map((tick) => `<line class="chart-grid" x1="${geometry.left}" y1="${tick.y}"`
      + ` x2="${round2(geometry.width - 14)}" y2="${tick.y}" />`
      + `<text class="chart-tick" x="${round2(geometry.left - 6)}" y="${round2(tick.y + 3)}">${escapeHtml(tick.label)}</text>`)
    .join('');

  const bars = geometry.bars
    .map((bar) => bar.segments
      .map((segment) => `<rect class="chart-bar ${categoryClass(segment.category) || 'chart-bar-other'}"`
        + ` x="${segment.x}" y="${segment.y}" width="${segment.width}" height="${segment.height}" rx="2" />`)
      .join(''))
    .join('');

  // 桶太多时只标每隔几个，避免标签叠在一起。
  const labelStep = Math.ceil(items.length / 16);
  const labels = geometry.bars
    .map((bar, index) => (index % labelStep === 0
      ? `<text class="chart-label${bar.future ? ' chart-label-future' : ''}" x="${bar.centerX}"`
        + ` y="${round2(geometry.height - 8)}">${escapeHtml(bar.label)}</text>`
      : ''))
    .join('');

  const line = geometry.points.length > 1
    ? `<polyline class="chart-line" points="${geometry.points.map((point) => `${point.x},${point.y}`).join(' ')}" />`
    : '';

  const dots = sparsePoints(geometry.points)
    .map((point) => `<circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="2.4" />`)
    .join('');

  return [
    `<section class="panel chart-panel chart-wide">${head}`,
    `<svg class="chart-svg" viewBox="0 0 ${geometry.width} ${geometry.height}"`,
    ` role="img" aria-label="${escapeHtml(title)}">`,
    grid,
    line,
    bars,
    dots,
    labels,
    '</svg>',
    '<p class="chart-foot">柱高是这一桶的时长（按活动分类堆叠），折线是截图记录数，'
      + '鼠标停在柱子上能看到具体数值。</p>',
    '</section>',
  ].join('');
}

// 折线上的点太多时只画稀疏的几个（保持曲线可读）。
function sparsePoints(points, limit = 40) {
  if (points.length <= limit) return points;
  const step = Math.ceil(points.length / limit);
  return points.filter((_point, index) => index % step === 0 || index === points.length - 1);
}

// ---- 横向排行（项目 / 软件）----

function rankGeometry(items, { width = 360, rowHeight = 20, gap = 8, labelWidth = 128, valueWidth = 74 } = {}) {
  const rows = Array.isArray(items) ? items : [];
  const max = Math.max(1, ...rows.map((item) => Number(item.minutes) || 0));
  const barMax = Math.max(10, width - labelWidth - valueWidth);
  return {
    width,
    height: Math.max(rowHeight, rows.length * (rowHeight + gap)),
    rowHeight,
    gap,
    labelWidth,
    max,
    bars: rows.map((item, index) => {
      const minutes = Number(item.minutes) || 0;
      return {
        label: item.label,
        minutes,
        blocks: Number(item.blocks) || 0,
        share: Number(item.share) || 0,
        y: round2(index * (rowHeight + gap)),
        barWidth: round2(Math.max(minutes > 0 ? 2 : 0, (minutes / max) * barMax)),
      };
    }),
  };
}

// 注意：选项名不要叫 valueOf —— 那个键会从 Object.prototype 上取到原生函数，
// 解构出来的永远是「真值」，默认值根本不会生效。
function renderRankChart(title, note, items, { empty = '这个周期还没有数据。', valueText = null } = {}) {
  const head = `<h3 class="chart-title">${escapeHtml(title)}${note ? `<i class="chart-note">${escapeHtml(note)}</i>` : ''}</h3>`;
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    return `<section class="panel chart-panel">${head}<p class="timeline-state">${escapeHtml(empty)}</p></section>`;
  }

  const geometry = rankGeometry(rows);
  const body = geometry.bars
    .map((bar, index) => {
      const y = round2(bar.y + geometry.rowHeight / 2);
      const value = typeof valueText === 'function' ? valueText(bar) : formatMinutes(bar.minutes);
      return [
        `<text class="chart-rank-label" x="0" y="${round2(y + 4)}">${escapeHtml(truncateLabel(bar.label))}</text>`,
        `<rect class="chart-rank-track" x="${geometry.labelWidth}" y="${bar.y}"`,
        ` width="${round2(geometry.width - geometry.labelWidth - 74)}" height="${geometry.rowHeight}" rx="5" />`,
        `<rect class="chart-rank-bar rank-bar-${index % 4}" x="${geometry.labelWidth}" y="${bar.y}"`,
        ` width="${bar.barWidth}" height="${geometry.rowHeight}" rx="5" />`,
        `<text class="chart-rank-value" x="${geometry.width - 4}" y="${round2(y + 4)}">${escapeHtml(value)}</text>`,
      ].join('');
    })
    .join('');

  return [
    `<section class="panel chart-panel">${head}`,
    `<svg class="chart-svg chart-rank" viewBox="0 0 ${geometry.width} ${geometry.height}"`,
    ` role="img" aria-label="${escapeHtml(title)}">${body}</svg>`,
    '</section>',
  ].join('');
}

// ---- 关键词与待办 ----

function renderKeywords(keywords, note) {
  const head = `<h3 class="chart-title">关键词<i class="chart-note">${escapeHtml(note ?? '来自截图分析')}</i></h3>`;
  const rows = Array.isArray(keywords) ? keywords : [];
  if (!rows.length) {
    return `<section class="panel chart-panel">${head}<p class="timeline-state">这个周期还没有关键词。</p></section>`;
  }
  const max = Math.max(...rows.map((row) => Number(row.count) || 0), 1);
  const tags = rows
    .map((row) => {
      const count = Number(row.count) || 0;
      const ratio = count / max;
      const size = ratio >= 0.8 ? 'tag-lg' : ratio >= 0.45 ? 'tag-md' : 'tag-sm';
      return `<li class="chart-tag ${size}">${escapeHtml(row.keyword)}<b>${count}</b></li>`;
    })
    .join('');
  return `<section class="panel chart-panel">${head}<ul class="chart-tags">${tags}</ul></section>`;
}

function renderTodos(todos) {
  const head = '<h3 class="chart-title">待办线索<i class="chart-note">来自区块汇总里提到的待办</i></h3>';
  const rows = Array.isArray(todos) ? todos : [];
  if (!rows.length) {
    return `<section class="panel chart-panel">${head}<p class="timeline-state">这个周期没有发现待办线索。</p></section>`;
  }
  const items = rows
    .map((row) => `<li class="chart-todo"><span class="chart-todo-text">${escapeHtml(row.todo)}</span>`
      + `<span class="chart-todo-day">${escapeHtml(row.day ?? '')}</span></li>`)
    .join('');
  return `<section class="panel chart-panel">${head}<ul class="chart-todos">${items}</ul></section>`;
}

// ---- 顶部统计卡片 ----

function renderStatCards(totals = {}) {
  const minutes = Number(totals.minutes) || 0;
  const activeDays = Number(totals.activeDays) || 0;
  const days = Number(totals.days) || 0;
  const average = activeDays ? minutes / activeDays : 0;
  const cards = [
    { label: '已汇总时长', value: formatMinutes(minutes) },
    { label: '时间段', value: `${Number(totals.blocks) || 0} 个`, note: totals.failed ? `${totals.failed} 个汇总失败` : null },
    { label: '截图记录', value: `${Number(totals.activities) || 0} 张` },
    { label: '活跃天数', value: days ? `${activeDays}/${days} 天` : `${activeDays} 天` },
    { label: '平均每天', value: activeDays ? formatMinutes(average) : '—' },
  ];
  return cards
    .map((card) => `<div class="stat-card"><span class="stat-label">${escapeHtml(card.label)}</span>`
      + `<span class="stat-value">${escapeHtml(card.value)}</span>`
      + (card.note ? `<span class="stat-note">${escapeHtml(card.note)}</span>` : '')
      + '</div>')
    .join('');
}

// ---- 整页 ----

// 日视图的趋势就是 24 小时分布，不再重复画一次「时段分布」。
function hourlyTrend(hourly) {
  return (Array.isArray(hourly) ? hourly : []).map((slot) => ({
    key: pad(slot.hour),
    label: pad(slot.hour),
    minutes: slot.minutes,
    blocks: slot.blocks,
    activities: 0,
    byCategory: slot.byCategory ?? {},
    future: false,
  }));
}

function renderKanbanReport(payload) {
  if (!payload) return '<p class="timeline-state">加载中…</p>';
  const period = payload.period ?? DEFAULT_PERIOD;
  const trendNote = period === 'day'
    ? '按小时统计时长（分类堆叠）'
    : '按天统计时长（分类堆叠）与截图记录数';
  const projectNote = payload.counts?.projects
    ? `共 ${payload.counts.projects} 个项目，取时长前 ${payload.projects.length} 个`
    : '按区块累计的专注时长';
  const softwareNote = payload.counts?.software
    ? `共 ${payload.counts.software} 个软件，取出现次数前 ${payload.software.length} 个`
    : '出现在多少个时间段里';

  const panels = [
    `<section class="panel chart-panel chart-donut-panel">
      <h3 class="chart-title">时间分配<i class="chart-note">按活动分类统计已汇总的时长</i></h3>
      ${renderDonut(payload.categories, payload.totals)}</section>`,
    renderTrendChart(payload.trend, { title: '活动趋势', note: trendNote }),
  ];

  if (period !== 'day') {
    panels.push(renderTrendChart(hourlyTrend(payload.hourly), {
      title: '时段分布',
      note: '一天 24 小时的时长分布（分类堆叠）',
      height: 180,
    }));
  }

  panels.push(renderRankChart('项目专注时长', projectNote, payload.projects, {
    empty: '这个周期还没有汇总出项目。',
  }));
  panels.push(renderRankChart('软件使用次数', softwareNote, payload.software, {
    empty: '这个周期还没有汇总出软件。',
    valueText: (bar) => `${bar.blocks} 次`,
  }));
  panels.push(renderKeywords(payload.keywords, '来自截图分析的关键词，字号代表出现次数'));
  panels.push(renderTodos(payload.todos));

  return panels.join('');
}

// ---- 视图 ----

function createKanbanView({
  periodsRoot, cardsRoot, chartsRoot, statusEl, labelEl, dateInput, prevButton, nextButton,
  todayButton, getStats,
}) {
  let period = DEFAULT_PERIOD;
  // anchor 为 null 表示「今天 / 本周 / 本月 / 今年」。
  let anchor = null;
  let payload = null;
  let loading = false;
  let errorMessage = '';

  function render() {
    for (const button of periodsRoot.querySelectorAll('.kanban-period')) {
      button.classList.toggle('active', button.dataset.period === period);
    }
    labelEl.textContent = payload?.label ?? '—';
    if (dateInput) dateInput.value = payload?.anchor ?? '';
    prevButton.disabled = loading || !payload;
    // 已经是「本期」（含今天）或整段在未来时，没有下一期可看。
    nextButton.disabled = loading || !payload || Boolean(payload.hasToday) || Boolean(payload.future);

    if (errorMessage) {
      statusEl.hidden = false;
      statusEl.textContent = errorMessage;
      chartsRoot.innerHTML = `<p class="timeline-error">${escapeHtml(errorMessage)}</p>`;
      return;
    }
    statusEl.hidden = !loading;
    if (loading) statusEl.textContent = '加载中…';

    cardsRoot.innerHTML = payload ? renderStatCards(payload.totals) : '';
    chartsRoot.innerHTML = payload ? renderKanbanReport(payload) : '<p class="timeline-state">加载中…</p>';
  }

  async function reload() {
    loading = true;
    errorMessage = '';
    render();
    try {
      const next = await getStats(buildStatsQuery({ period, anchor }));
      payload = next ?? null;
      // 主进程会回传规范化后的锚点，按钮因此只需要回传 prevAnchor / nextAnchor。
      anchor = payload?.anchor ?? anchor;
    } catch (error) {
      errorMessage = `加载统计失败：${error?.message || error}`;
    } finally {
      loading = false;
    }
    render();
  }

  periodsRoot.addEventListener('click', (event) => {
    const button = event.target.closest('.kanban-period');
    if (!button) return;
    const next = button.dataset.period;
    if (!PERIODS.includes(next) || next === period) return;
    // 切换周期时保留当前锚点：从「本周」切到「月」看的就是这一周所在的月份。
    period = next;
    reload();
  });

  prevButton.addEventListener('click', () => {
    if (!payload?.prevAnchor) return;
    anchor = payload.prevAnchor;
    reload();
  });

  nextButton.addEventListener('click', () => {
    if (!payload?.nextAnchor) return;
    anchor = payload.nextAnchor;
    reload();
  });

  todayButton.addEventListener('click', () => {
    anchor = null;
    reload();
  });

  if (dateInput) {
    dateInput.addEventListener('change', () => {
      anchor = dateInput.value || null;
      reload();
    });
  }

  return { reload, read: () => ({ period, anchor }) };
}

function init() {
  const periodsRoot = document.getElementById('kanban-periods');
  const cardsRoot = document.getElementById('kanban-cards');
  const chartsRoot = document.getElementById('kanban-charts');
  const statusEl = document.getElementById('kanban-status');
  const labelEl = document.getElementById('kanban-label');
  const dateInput = document.getElementById('kanban-date');
  const prevButton = document.getElementById('kanban-prev');
  const nextButton = document.getElementById('kanban-next');
  const todayButton = document.getElementById('kanban-today');
  if (!periodsRoot || !cardsRoot || !chartsRoot || !statusEl || !labelEl
    || !prevButton || !nextButton || !todayButton) return;

  window.lifelensKanban = createKanbanView({
    periodsRoot,
    cardsRoot,
    chartsRoot,
    statusEl,
    labelEl,
    dateInput,
    prevButton,
    nextButton,
    todayButton,
    getStats: (query) => window.lifelens.getStats(query),
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PERIODS,
    PERIOD_LABELS,
    DEFAULT_PERIOD,
    CATEGORY_ORDER,
    CATEGORY_CLASSES,
    DONUT_SIZE,
    DONUT_RADIUS,
    DONUT_STROKE,
    formatMinutes,
    formatShortMinutes,
    formatShare,
    categoryClass,
    truncateLabel,
    buildStatsQuery,
    donutSlices,
    renderDonut,
    trendGeometry,
    renderTrendChart,
    rankGeometry,
    renderRankChart,
    renderKeywords,
    renderTodos,
    renderStatCards,
    hourlyTrend,
    renderKanbanReport,
    createKanbanView,
  };
}

})();
