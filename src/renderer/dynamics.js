'use strict';

// Phase 8：动态页的渲染层（10 分钟热力图 + 区块时间线 + 筛选）。
// 数据只有一个来源：lifelens:time-blocks 通道（window.lifelens.getTimeBlocks）。
// 这一层不做 SQL、不做汇总，只负责把区块画成可回看的界面。
//
// 与 timeline.js 相同的约定：整个文件包在 IIFE 里（两个文件都是 classic script，
// 共享同一个全局作用域），上半部分是纯函数、通过 module.exports 暴露给 node --test 直接 require，
// 末尾的 DOM 初始化只在渲染进程里执行。日期区间那几个小工具与 timeline.js 各有一份：
// 重复的只是稳定的日期数学，换来两个模块互不依赖。

(function () {

const PAGE_SIZE = 20;
// 热力图：最近 12 小时，列 = 小时，行 = 一小时里的 6 个 10 分钟槽。
const HEATMAP_COLUMNS = 12;
const HEATMAP_ROWS = 6;
const HEATMAP_MAX_LIMIT = HEATMAP_COLUMNS * HEATMAP_ROWS;
const BLOCK_MINUTES = 10;
const BLOCK_MS = BLOCK_MINUTES * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// 需求固定的四个分类 -> 配色类名（与 styles.css 的 .cat-* 对应）。
const CATEGORY_CLASSES = Object.freeze({
  娱乐: 'cat-fun',
  工作: 'cat-work',
  学习: 'cat-study',
  社交: 'cat-social',
});

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

function toLocalDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---- 10 分钟区块的时间口径（与主进程 summary/timeBlock.js 一致）----

function blockStartOf(value) {
  const date = toLocalDate(value);
  if (!date) return null;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    Math.floor(date.getMinutes() / BLOCK_MINUTES) * BLOCK_MINUTES,
    0,
    0,
  );
}

// 区块记录上的时间是字符串（带时区偏移），统一换算成毫秒与槽位对齐比较。
function startMsOf(value) {
  const date = toLocalDate(value);
  return date ? date.getTime() : null;
}

function blockRangeLabel(value) {
  const start = toLocalDate(value);
  if (!start) return '--:--';
  const end = new Date(start.getTime() + BLOCK_MS);
  return `${pad(start.getHours())}:${pad(start.getMinutes())}–${pad(end.getHours())}:${pad(end.getMinutes())}`;
}

function blockDayLabel(value) {
  const start = toLocalDate(value);
  if (!start) return '';
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
}

function categoryClass(category) {
  return CATEGORY_CLASSES[category] ?? '';
}

// ---- 热力图槽位 ----

// 最近 columns 小时 × rows 个区块的槽位，按「列优先」排列（与 CSS 的 grid-auto-flow: column 一致）。
// 未来的槽位也会返回：界面上画成浅色占位，点了没有内容。
function heatmapSlots(now = new Date(), { columns = HEATMAP_COLUMNS, rows = HEATMAP_ROWS } = {}) {
  const current = toLocalDate(now);
  if (!current) return [];

  const hourStart = new Date(
    current.getFullYear(), current.getMonth(), current.getDate(), current.getHours(), 0, 0, 0,
  );
  const slots = [];
  for (let column = 0; column < columns; column += 1) {
    const columnStart = hourStart.getTime() - (columns - 1 - column) * HOUR_MS;
    for (let row = 0; row < rows; row += 1) {
      const startTime = columnStart + row * BLOCK_MS;
      const start = new Date(startTime);
      slots.push({
        start,
        startMs: startTime,
        time: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
        column,
        row,
        future: startTime > current.getTime(),
      });
    }
  }
  return slots;
}

// 热力图要查的时间范围：[第一列起点, 最后一列结束)。
function heatmapRange(now = new Date(), { columns = HEATMAP_COLUMNS } = {}) {
  const slots = heatmapSlots(now, { columns });
  if (!slots.length) return { from: null, to: null };
  const first = slots[0].start;
  const last = slots[slots.length - 1].start;
  return { from: first, to: new Date(last.getTime() + BLOCK_MS) };
}

function heatRows() {
  const rows = [];
  for (let row = 0; row < HEATMAP_ROWS; row += 1) rows.push(`:${pad(row * BLOCK_MINUTES)}`);
  return rows;
}

// ---- 筛选：DOM -> 数据层查询参数 ----

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// <input type=date> 的 YYYY-MM-DD 按本地时间解析成当天 00:00（直接 new Date() 会按 UTC 解析，差一天）。
function parseDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

// 时间预设 -> 与数据层一致的闭开区间 [from, to)。
function resolveTimeRange(preset, fromValue, toValue, now = new Date()) {
  const today = startOfDay(now);
  if (preset === 'today') return { from: today, to: addDays(today, 1) };
  if (preset === 'yesterday') return { from: addDays(today, -1), to: today };
  if (preset === 'last7') return { from: addDays(today, -6), to: addDays(today, 1) };
  if (preset === 'custom') {
    const from = parseDateInput(fromValue);
    const to = parseDateInput(toValue);
    // 结束日期按「含当天」理解。
    return { from, to: to ? addDays(to, 1) : null };
  }
  return { from: null, to: null };
}

// 界面筛选状态 -> 数据层查询参数（空值不传，让数据层等价于不筛这一项）。
function buildBlocksQuery(filters, { limit, offset = 0, now = new Date() } = {}) {
  const query = {};
  const range = resolveTimeRange(filters?.range, filters?.from, filters?.to, now);
  if (range.from) query.from = range.from;
  if (range.to) query.to = range.to;
  if (filters?.project) query.project = filters.project;
  if (filters?.software) query.software = filters.software;
  if (limit !== undefined) query.limit = limit;
  if (offset !== undefined) query.offset = offset;
  return query;
}

function hasActiveFilters(filters) {
  if (!filters) return false;
  return Boolean(filters.project || filters.software || filters.range !== 'all');
}

// ---- 渲染（纯字符串，交给 node --test 断言）----

function cellTitle(slot, block) {
  const range = blockRangeLabel(new Date(slot.startMs));
  if (slot.future) return `${range} 还没到`;
  if (!block) return `${range} 没有记录`;
  if (block.status === 'FAILED') return `${range} 汇总失败`;
  if (block.status !== 'COMPLETED') return `${range} 汇总中`;
  return `${range} ${block.category ?? ''} ${block.project ?? ''}`.trim();
}

function renderHeatCells(slots, blocks = new Map(), selectedMs = null) {
  return slots
    .map((slot) => {
      const block = blocks.get(slot.startMs) ?? null;
      const classes = ['heat-cell'];
      if (slot.future) {
        classes.push('future');
      } else if (!block) {
        // 没有记录：保持默认底色。
      } else if (block.status === 'COMPLETED') {
        const cls = categoryClass(block.category);
        if (cls) classes.push(cls);
      } else {
        classes.push('cat-pending');
      }
      if (selectedMs === slot.startMs) classes.push('selected');

      return `<button type="button" class="${classes.join(' ')}" data-start="${slot.startMs}"`
        + `${slot.future ? ' disabled' : ''} title="${escapeHtml(cellTitle(slot, block))}"></button>`;
    })
    .join('');
}

function renderHeatRows() {
  return heatRows().map((label) => `<span>${escapeHtml(label)}</span>`).join('');
}

function renderHeatHours(slots, columns = HEATMAP_COLUMNS) {
  const labels = [];
  for (let column = 0; column < columns; column += 1) {
    const first = slots.find((slot) => slot.column === column);
    labels.push(`<span>${escapeHtml(first ? `${pad(first.start.getHours())}:00` : '')}</span>`);
  }
  return labels.join('');
}

function renderHeatmap(slots, blocks = new Map(), selectedMs = null) {
  return '<div class="heatmap-rows">' + renderHeatRows() + '</div>'
    + '<div class="heatmap-grid">' + renderHeatCells(slots, blocks, selectedMs) + '</div>'
    + '<div class="heatmap-hours">' + renderHeatHours(slots) + '</div>';
}

function renderSoftwareTags(software) {
  const names = Array.isArray(software) ? software.filter(Boolean) : [];
  if (!names.length) return '';
  return '<div class="dynamics-tags">'
    + names.map((name) => `<span class="dynamics-tag">${escapeHtml(name)}</span>`).join('')
    + '</div>';
}

function renderBlockCard(block) {
  const startMs = startMsOf(block?.start);
  const range = escapeHtml(blockRangeLabel(block?.start));
  const day = escapeHtml(blockDayLabel(block?.start));
  const open = `<li class="record dynamics-card" data-start="${startMs}">`;

  if (block?.status === 'FAILED') {
    const reason = [block.error, block.errorCode].filter(Boolean).join(' · ') || '未知原因';
    return `${open}<div class="dynamics-head"><span class="dynamics-range">${range}</span>`
      + `<span class="dynamics-day">${day}</span></div>`
      + `<p class="dynamics-failed">汇总失败：${escapeHtml(reason)}</p></li>`;
  }
  if (block?.status !== 'COMPLETED') {
    return `${open}<div class="dynamics-head"><span class="dynamics-range">${range}</span>`
      + `<span class="dynamics-day">${day}</span></div>`
      + '<p class="dynamics-pending">汇总中…</p></li>';
  }

  const category = String(block.category ?? '');
  const chip = category
    ? `<span class="dynamics-category ${escapeHtml(categoryClass(category))}">${escapeHtml(category)}</span>`
    : '';
  const parts = [
    open,
    '<div class="dynamics-head">',
    `<span class="dynamics-range">${range}</span>`,
    chip,
    `<span class="dynamics-day">${day}</span>`,
    '</div>',
  ];
  if (block.project) parts.push(`<p class="dynamics-project">${escapeHtml(block.project)}</p>`);
  if (block.description) {
    parts.push(`<p class="dynamics-description">${escapeHtml(block.description)}</p>`);
  }
  parts.push(renderSoftwareTags(block.software));
  if (Array.isArray(block.todos) && block.todos.length) {
    parts.push(`<p class="dynamics-todos">可能遗漏的待办：${escapeHtml(block.todos.join('；'))}</p>`);
  }
  parts.push('</li>');
  return parts.join('');
}

// 点热力图方块后展开的详情。
function renderBlockDetail(block, startMs) {
  const range = block ? blockRangeLabel(block.start) : blockRangeLabel(new Date(startMs));
  const day = block ? blockDayLabel(block.start) : blockDayLabel(new Date(startMs));
  if (!block) {
    return `<h3>${escapeHtml(`${day} ${range}`)}</h3><p>这个时间段没有记录。</p>`;
  }

  const parts = [`<h3>${escapeHtml(`${day} ${range}`)}</h3>`];
  const meta = [block.category, block.status === 'COMPLETED' ? null : statusText(block)]
    .filter(Boolean)
    .join(' · ');
  if (meta) parts.push(`<p>${escapeHtml(meta)}</p>`);
  if (block.project) parts.push(`<p class="dynamics-project">${escapeHtml(block.project)}</p>`);
  if (block.description) {
    parts.push(`<p class="dynamics-description">${escapeHtml(block.description)}</p>`);
  }
  parts.push(renderSoftwareTags(block.software));
  if (Array.isArray(block.todos) && block.todos.length) {
    parts.push(`<p class="dynamics-todos">可能遗漏的待办：${escapeHtml(block.todos.join('；'))}</p>`);
  }
  parts.push(`<p class="panel-note">这个时间段有 ${block.activityCount ?? 0} 条截图记录。</p>`);
  return parts.join('');
}

function statusText(block) {
  if (block.status === 'FAILED') return '汇总失败';
  return '汇总中';
}

// ---- 筛选栏：DOM -> 筛选状态 ----

// 重建下拉框选项并保留当前选择；原选择不存在时退回第一项（值为空字符串 = 全部）。
function fillSelect(select, entries) {
  const current = select.value;
  select.replaceChildren(...entries.map((entry) => {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    return option;
  }));
  select.value = entries.some((entry) => entry.value === current) ? current : '';
}

function facetEntries(values, allLabel, extra = []) {
  const entries = [{ value: '', label: allLabel }];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === 'string' && value !== '') entries.push({ value, label: value });
  }
  return entries.concat(extra);
}

function createFilterBar(root, onChange) {
  const projectSelect = root.querySelector('#dynamics-project');
  const softwareSelect = root.querySelector('#dynamics-software');
  const rangeSelect = root.querySelector('#dynamics-range');
  const customRange = root.querySelector('#dynamics-custom-range');
  const fromInput = root.querySelector('#dynamics-from');
  const toInput = root.querySelector('#dynamics-to');
  const clearButton = root.querySelector('#dynamics-clear');

  function collect() {
    return {
      project: projectSelect.value,
      software: softwareSelect.value,
      range: rangeSelect.value,
      from: fromInput.value,
      to: toInput.value,
    };
  }

  const filters = collect();

  function emit() {
    Object.assign(filters, collect());
    // 自定义范围的两个日期框只在选中「自定义」时出现。
    customRange.hidden = filters.range !== 'custom';
    onChange(filters);
  }

  for (const select of [projectSelect, softwareSelect, rangeSelect]) {
    select.addEventListener('change', emit);
  }
  fromInput.addEventListener('change', emit);
  toInput.addEventListener('change', emit);

  clearButton.addEventListener('click', () => {
    projectSelect.value = '';
    softwareSelect.value = '';
    rangeSelect.value = 'all';
    fromInput.value = '';
    toInput.value = '';
    emit();
  });

  return {
    read: () => filters,
    // 选项来自已有数据（listFacets），界面不维护第二份清单。
    applyFacets(facets) {
      fillSelect(projectSelect, facetEntries(facets?.projects, '全部项目'));
      fillSelect(softwareSelect, facetEntries(facets?.software, '全部软件'));
    },
  };
}

// ---- 视图 ----

function createDynamicsView({
  heatmapRoot, detailRoot, timelineRoot, statusEl, sentinel, filterRoot, getBlocks, getFacets,
}) {
  let items = [];
  let hasMore = false;
  let loading = false;
  let loaded = false;
  let errorMessage = '';
  let heatBlocks = new Map();
  let selectedMs = null;

  // 筛选条件变化就回到第一页重新查询。
  const filters = createFilterBar(filterRoot, () => { reload(); });

  // 名字必须和上面那个纯函数区分开：同名函数声明会把它遮蔽掉，调用变成无限递归。
  function paintHeatmap() {
    const slots = heatmapSlots(new Date());
    heatmapRoot.innerHTML = renderHeatmap(slots, heatBlocks, selectedMs);
  }

  function renderDetail() {
    if (selectedMs === null) {
      detailRoot.hidden = true;
      detailRoot.innerHTML = '';
      return;
    }
    detailRoot.hidden = false;
    detailRoot.innerHTML = renderBlockDetail(heatBlocks.get(selectedMs) ?? null, selectedMs);
  }

  function updateStatus() {
    if (errorMessage) {
      statusEl.hidden = false;
      statusEl.textContent = errorMessage;
      return;
    }
    if (loading) {
      statusEl.hidden = false;
      statusEl.textContent = '加载中…';
      return;
    }
    if (!items.length) {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = hasMore ? '继续向下滑动加载更多' : '没有更多了';
  }

  function renderTimeline() {
    if (!loaded) {
      timelineRoot.innerHTML = '<p class="timeline-state">加载中…</p>';
      updateStatus();
      return;
    }

    if (!items.length) {
      timelineRoot.innerHTML = hasActiveFilters(filters.read())
        ? '<div class="timeline-empty"><p>没有符合条件的动态</p>'
          + '<p>试试换个项目 / 软件，或点「清除筛选」。</p></div>'
        : '<div class="timeline-empty"><p>还没有动态记录</p>'
          + '<p>每 10 分钟会自动汇总一次，汇总完成后出现在这里。</p></div>';
      updateStatus();
      return;
    }

    const banner = errorMessage ? `<p class="timeline-error">${escapeHtml(errorMessage)}</p>` : '';
    timelineRoot.innerHTML = banner
      + `<ol class="dynamics-list">${items.map(renderBlockCard).join('')}</ol>`;
    updateStatus();
  }

  async function reload() {
    loading = true;
    errorMessage = '';
    renderTimeline();

    const now = new Date();
    const range = heatmapRange(now);
    try {
      // 时间线与热力图是两个读形状：前者分页 + 筛选，后者只要一段连续时间的全部区块。
      const [page, heat, facets] = await Promise.all([
        getBlocks(buildBlocksQuery(filters.read(), { limit: PAGE_SIZE, now })),
        getBlocks({ from: range.from, to: range.to, limit: HEATMAP_MAX_LIMIT }),
        getFacets(),
      ]);
      items = Array.isArray(page?.items) ? page.items : [];
      hasMore = Boolean(page?.hasMore);
      heatBlocks = new Map(
        (Array.isArray(heat?.items) ? heat.items : [])
          .map((block) => [startMsOf(block.start), block]),
      );
      filters.applyFacets(facets);
    } catch (error) {
      errorMessage = error?.message || String(error);
    } finally {
      loading = false;
      loaded = true;
    }

    paintHeatmap();
    renderDetail();
    renderTimeline();
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    errorMessage = '';
    updateStatus();

    try {
      // offset = 已加载条数；筛选条件不变，分页与第一页同一套条件。
      const page = await getBlocks(buildBlocksQuery(filters.read(), {
        limit: PAGE_SIZE,
        offset: items.length,
      }));
      for (const block of Array.isArray(page?.items) ? page.items : []) {
        if (!items.some((item) => item.id === block.id)) items.push(block);
      }
      hasMore = Boolean(page?.hasMore);
    } catch (error) {
      errorMessage = `加载更多失败：${error?.message || error}`;
    } finally {
      loading = false;
      loaded = true;
    }

    renderTimeline();
  }

  heatmapRoot.addEventListener('click', (event) => {
    const cell = event.target.closest('button.heat-cell');
    if (!cell || cell.disabled) return;

    selectedMs = Number(cell.dataset.start);
    for (const other of heatmapRoot.querySelectorAll('.heat-cell.selected')) {
      other.classList.remove('selected');
    }
    cell.classList.add('selected');
    renderDetail();
  });

  // 「纵向滑动加载」：列表底部的哨兵进入视口就取下一页。
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: '240px' });
    observer.observe(sentinel);
  }

  return { reload, loadMore };
}

function init() {
  const heatmapRoot = document.getElementById('heatmap');
  const detailRoot = document.getElementById('heatmap-detail');
  const timelineRoot = document.getElementById('dynamics-timeline');
  const statusEl = document.getElementById('dynamics-status');
  const sentinel = document.getElementById('dynamics-sentinel');
  const filterRoot = document.getElementById('dynamics-filters');
  if (!heatmapRoot || !detailRoot || !timelineRoot || !filterRoot || !sentinel) return;

  window.lifelensDynamics = createDynamicsView({
    heatmapRoot,
    detailRoot,
    timelineRoot,
    statusEl,
    sentinel,
    filterRoot,
    getBlocks: (query) => window.lifelens.getTimeBlocks(query),
    getFacets: () => window.lifelens.getTimeBlockFacets(),
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PAGE_SIZE,
    HEATMAP_COLUMNS,
    HEATMAP_ROWS,
    HEATMAP_MAX_LIMIT,
    CATEGORY_CLASSES,
    blockStartOf,
    startMsOf,
    blockRangeLabel,
    blockDayLabel,
    categoryClass,
    heatmapSlots,
    heatmapRange,
    heatRows,
    buildBlocksQuery,
    hasActiveFilters,
    resolveTimeRange,
    parseDateInput,
    renderHeatmap,
    renderBlockCard,
    renderBlockDetail,
    // 视图装配也导出：纯函数全对不代表页面画得出来，DOM 桩测试要能直接构造它。
    createFilterBar,
    createDynamicsView,
  };
}

})();
