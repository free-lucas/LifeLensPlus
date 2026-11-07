'use strict';

// Phase 7.2：活动时间线的渲染层。
// 数据只有一个来源：Phase 7.1 的 lifelens:timeline 通道（window.lifelens.getTimeline）。
// 这一层不做 SQL、不做筛选、不做缩略图生成，只负责把 Activity 画成可回看的界面。
//
// 整个文件包在一个 IIFE 里：renderer.js 与本文件都是 classic script，共享同一个全局作用域，
// 而两边都定义了 pad / escapeHtml / formatClock 这类小工具；不隔离的话，后加载的 renderer.js
// 会覆盖掉这里的同名函数。文件上半部分是纯函数（路径转换 / 时间格式化 / 按自然日分组），
// 通过 module.exports 暴露给 node --test 直接 require；末尾的 DOM 初始化只在渲染进程里执行。

(function () {

const TIMELINE_PAGE_SIZE = 20;
const WEEKDAYS = '日一二三四五六';
const UNKNOWN_DAY_KEY = 'unknown';

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

// Windows 绝对路径 -> <img src> 能用的 file:// URL。
// 反斜杠统一成正斜杠；盘符保留字面冒号（file:///C:/...，不是 file://C:/...，
// 也不是 file:///C%3A/...）；其余每一段单独 encodeURIComponent，
// 这样中文 / 空格 / # 都不会截断 URL。
function imagePathToFileUrl(imagePath) {
  const raw = String(imagePath ?? '').trim();
  if (!raw) return '';
  const slashed = raw.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(?=\/)/.exec(slashed);
  const rest = drive ? slashed.slice(drive[0].length) : slashed;
  const encoded = rest.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `file:///${drive ? `${drive[1]}:` : ''}${encoded}`;
}

function toLocalDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 组内条目的时间：显示到秒。截屏间隔是 20 秒，只到分钟会让同一分钟里的多条记录
// 时间完全相同，看起来像「同一时刻被截了好多次」。
function formatClock(value) {
  const date = toLocalDate(value);
  return date
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    : '--:--';
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 组头：YYYY-MM-DD 周X；当天加上「今天」前缀。
function formatDayLabel(date, today = new Date()) {
  const label = `${dayKey(date)} 周${WEEKDAYS[date.getDay()]}`;
  const sameDay = today instanceof Date && dayKey(today) === dayKey(date);
  return sameDay ? `今天 · ${label}` : label;
}

// 按本地自然日分组。输入已由数据层按 captured_at DESC 排好序，这里只归组、不重排。
function groupByDay(items, today = new Date()) {
  const groups = [];
  const byKey = new Map();

  for (const item of items ?? []) {
    const date = toLocalDate(item?.time);
    const key = date ? dayKey(date) : UNKNOWN_DAY_KEY;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: date ? formatDayLabel(date, today) : '未知时间', items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  return groups;
}

// ---- 搜索与筛选（Phase 7.3）----
// 筛选条件全部在数据层（SQLite）执行，这里只做三件事：
//   1. 把界面上的选择翻译成数据层认识的查询参数（buildTimelineQuery）；
//   2. 用同一套语义判断「实时事件里的这条记录是否还符合当前筛选」（matchesFilters）；
//   3. 维护筛选栏的 DOM 状态。

const SEARCH_DEBOUNCE_MS = 300;
// project 下拉框里「无项目」的取值：真实项目名不会等于它。
const PROJECT_UNASSIGNED = '__unassigned__';

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// 按「天」加减：跨月 / 跨年 / 夏令时都交给 Date 构造器处理。
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// <input type=date> 的 YYYY-MM-DD 按本地时间解析成当天 00:00。
// 不能直接 new Date('2026-09-11')：那会按 UTC 解析，在东八区会差一天。
function parseDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

// 时间预设 -> 与数据层一致的闭开区间 [from, to)。
// 「今天 / 昨天 / 最近 7 天」都按本地自然日算：today 是今天 00:00，addDays(today, 1) 是明天 00:00。
function resolveTimeRange(preset, fromValue, toValue, now = new Date()) {
  const today = startOfDay(now);
  if (preset === 'today') return { from: today, to: addDays(today, 1) };
  if (preset === 'yesterday') return { from: addDays(today, -1), to: today };
  if (preset === 'last7') return { from: addDays(today, -6), to: addDays(today, 1) };
  if (preset === 'custom') {
    const from = parseDateInput(fromValue);
    const to = parseDateInput(toValue);
    // 结束日期按「含当天」理解：上界取它第二天的 00:00。
    return { from, to: to ? addDays(to, 1) : null };
  }
  return { from: null, to: null };
}

// 界面筛选状态 -> 数据层查询参数。空值不传，让数据层用默认行为（等价于不筛这一项）。
function buildTimelineQuery(filters, { limit, offset = 0, now = new Date() } = {}) {
  const query = {};
  const range = resolveTimeRange(filters.range, filters.from, filters.to, now);
  if (range.from) query.from = range.from;
  if (range.to) query.to = range.to;
  if (filters.search) query.search = filters.search;
  if (filters.category) query.category = filters.category;
  if (filters.noProject) query.noProject = true;
  else if (filters.project) query.project = filters.project;
  if (filters.status) query.status = filters.status;
  if (limit !== undefined) query.limit = limit;
  if (offset !== undefined) query.offset = offset;
  return query;
}

// 有没有任何一项筛选在生效：决定空状态文案，也决定实时事件要不要按筛选过一遍。
function hasActiveFilters(filters) {
  if (!filters) return false;
  return Boolean(
    filters.search
    || filters.category
    || filters.project
    || filters.noProject
    || filters.status
    || filters.range !== 'all',
  );
}

// 渲染层的筛选判定：语义与 ActivityRepository.queryTimeline 保持一致，
// 只用于实时事件（新截图前插 / 分析结果回填），查询本身仍然全部走 SQLite。
function matchesFilters(record, filters, now = new Date()) {
  if (!record || !hasActiveFilters(filters)) return true;

  const time = toLocalDate(record.time);
  const range = resolveTimeRange(filters.range, filters.from, filters.to, now);
  if (range.from && (!time || time < range.from)) return false;
  if (range.to && (!time || time >= range.to)) return false;

  const analysis = record.analysis ?? null;
  if (filters.category && analysis?.category !== filters.category) return false;
  if (filters.noProject) {
    if (analysis?.project) return false;
  } else if (filters.project && analysis?.project !== filters.project) {
    return false;
  }

  if (filters.search) {
    const needle = filters.search.toLowerCase();
    const haystack = [
      record.summary,
      analysis?.activity,
      analysis?.summary,
      analysis?.project,
      ...(Array.isArray(analysis?.keywords) ? analysis.keywords : []),
    ]
      .filter((value) => typeof value === 'string')
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  if (filters.status === 'COMPLETED' && record.analysisStatus !== 'COMPLETED') return false;
  if (filters.status === 'FAILED' && record.analysisStatus !== 'FAILED') return false;
  // 「分析中」= 既没完成也没失败，与 statusOf() 的兜底口径一致。
  if (filters.status === 'PENDING'
    && (record.analysisStatus === 'COMPLETED' || record.analysisStatus === 'FAILED')) {
    return false;
  }

  return true;
}

// analysis_status 实际只有 PENDING / COMPLETED / FAILED；
// PROCESSING 与缺失值都按「分析中」兜底展示，不额外造状态。
function statusOf(record) {
  const status = String(record?.analysisStatus ?? '');
  if (status === 'COMPLETED') return { key: 'COMPLETED', icon: '✓', text: '已分析' };
  if (status === 'FAILED') return { key: 'FAILED', icon: '⚠', text: '分析失败' };
  return { key: 'PENDING', icon: '⏳', text: '分析中' };
}

// 结构化结果只在分析成功后才有；字段缺失时按「没有」处理，不用占位文案假装有值。
function renderAnalysisBody(record, status) {
  const analysis = record.analysis;
  const parts = [];

  if (analysis) {
    const category = typeof analysis.category === 'string' ? analysis.category : null;
    const project = typeof analysis.project === 'string' ? analysis.project : null;
    const confidence = typeof analysis.confidence === 'number' ? analysis.confidence : null;
    const keywords = Array.isArray(analysis.keywords) ? analysis.keywords.filter(Boolean) : [];

    const meta = [];
    if (category) meta.push(`分类 ${category}`);
    if (project) meta.push(`项目 ${project}`);
    // 0.94 要显示成 94%，不能显示成 0.94%。
    if (confidence !== null) meta.push(`把握 ${Math.round(confidence * 100)}%`);

    if (analysis.activity) parts.push(`<p class="record-activity">${escapeHtml(analysis.activity)}</p>`);
    if (analysis.summary) parts.push(`<p class="record-summary">${escapeHtml(analysis.summary)}</p>`);
    if (meta.length) parts.push(`<p class="record-meta">${escapeHtml(meta.join(' · '))}</p>`);
    if (keywords.length) {
      parts.push(`<p class="record-keywords">关键词：${escapeHtml(keywords.join(' · '))}</p>`);
    }
  } else if (status.key === 'PENDING') {
    parts.push('<p class="record pending">分析中…</p>');
  }

  if (status.key === 'FAILED') {
    const reason = [record.error, record.errorCode].filter(Boolean).join(' · ') || '未知原因';
    parts.push(`<p class="record failed">分析失败：${escapeHtml(reason)}</p>`);
  }

  return parts.join('');
}

function renderThumb(record) {
  const url = imagePathToFileUrl(record.imagePath);
  if (!url) return '<div class="timeline-thumb timeline-thumb-missing">无截图</div>';
  // 缩略图只是压缩显示尺寸，不生成小图；加载失败由 attachThumbFallbacks 换成占位块。
  return `<img class="timeline-thumb" data-thumb src="${escapeHtml(url)}" alt="活动截图" loading="lazy" />`;
}

// focusId 是搜索结果要定位到的那条记录（Phase 11）：命中的卡片单独高亮，不影响其它渲染路径。
function renderCard(record, focusId = null) {
  const status = statusOf(record);
  const focused = focusId !== null && String(record.id) === String(focusId);
  return `
    <li class="record timeline-card${focused ? ' timeline-card-focus' : ''}" data-id="${escapeHtml(record.id)}">
      <div class="timeline-media">${renderThumb(record)}</div>
      <div class="timeline-body">
        <div class="record-head">
          <span class="record-time">${escapeHtml(formatClock(record.time))}</span>
          <span class="timeline-status timeline-status-${status.key.toLowerCase()}">${status.icon} ${status.text}</span>
          <button class="spacer" data-image="${escapeHtml(record.imagePath || '')}">查看截图</button>
        </div>
        ${renderAnalysisBody(record, status)}
      </div>
    </li>`;
}

function renderGroup(group, focusId = null) {
  return `
    <section class="timeline-day" data-day="${escapeHtml(group.key)}">
      <h3 class="timeline-day-label">${escapeHtml(group.label)}</h3>
      <ol class="timeline-list">${group.items.map((item) => renderCard(item, focusId)).join('')}</ol>
    </section>`;
}

// 定位窗口的说明文案：同一天只显示 HH:mm:ss–HH:mm:ss，跨天带上第二个日期。
function formatRangeLabel(from, to) {
  const start = toLocalDate(from);
  const end = toLocalDate(to);
  if (!start || !end) return '';
  if (dayKey(start) === dayKey(end)) {
    return `${dayKey(start)} ${formatClock(start)}–${formatClock(end)}`;
  }
  return `${dayKey(start)} ${formatClock(start)} – ${dayKey(end)} ${formatClock(end)}`;
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

// 「全部」+ 数据里出现过的取值。空值不成为选项；「无项目」由 extra 单独加在最后。
function facetEntries(values, allLabel, extra = []) {
  const entries = [{ value: '', label: allLabel }];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === 'string' && value !== '' && value !== PROJECT_UNASSIGNED) {
      entries.push({ value, label: value });
    }
  }
  return entries.concat(extra);
}

// 筛选栏：把 DOM 上的选择收敛成一个筛选状态对象。
// 关键词输入防抖（每次输入都查库太吵），其余控件立即生效。
function createFilterBar(root, onChange) {
  const searchInput = root.querySelector('#timeline-search');
  const rangeSelect = root.querySelector('#timeline-range');
  const categorySelect = root.querySelector('#timeline-category');
  const projectSelect = root.querySelector('#timeline-project');
  const statusSelect = root.querySelector('#timeline-status');
  const customRange = root.querySelector('#timeline-custom-range');
  const fromInput = root.querySelector('#timeline-from');
  const toInput = root.querySelector('#timeline-to');
  const clearButton = root.querySelector('#timeline-clear');

  let timer = null;
  // 已生效的筛选状态：与新截图 / 分析结果事件用的是同一份，避免和输入框里的半成品混淆。
  let applied = collect();

  function collect() {
    const project = projectSelect.value;
    return {
      search: searchInput.value.trim(),
      category: categorySelect.value,
      project: project === PROJECT_UNASSIGNED ? '' : project,
      noProject: project === PROJECT_UNASSIGNED,
      status: statusSelect.value,
      range: rangeSelect.value,
      from: fromInput.value,
      to: toInput.value,
    };
  }

  function emit() {
    timer = null;
    applied = collect();
    // 自定义范围的两个日期框只在选中「自定义」时出现。
    customRange.hidden = applied.range !== 'custom';
    onChange(applied);
  }

  searchInput.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(emit, SEARCH_DEBOUNCE_MS);
  });
  // 回车立即搜索，不等防抖。
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (timer) clearTimeout(timer);
    emit();
  });
  for (const select of [rangeSelect, categorySelect, projectSelect, statusSelect]) {
    select.addEventListener('change', emit);
  }
  fromInput.addEventListener('change', emit);
  toInput.addEventListener('change', emit);

  clearButton.addEventListener('click', () => {
    if (timer) clearTimeout(timer);
    searchInput.value = '';
    rangeSelect.value = 'all';
    categorySelect.value = '';
    projectSelect.value = '';
    statusSelect.value = '';
    fromInput.value = '';
    toInput.value = '';
    emit();
  });

  return {
    read: () => applied,
    // 分类 / 项目选项来自已有数据（listFacets），界面不维护第二份清单。
    applyFacets(facets) {
      fillSelect(categorySelect, facetEntries(facets?.categories, '全部分类'));
      const extra = facets?.hasUnassignedProject
        ? [{ value: PROJECT_UNASSIGNED, label: '无项目' }]
        : [];
      fillSelect(projectSelect, facetEntries(facets?.projects, '全部项目', extra));
    },
  };
}

function createTimelineView({
  container, moreButton, filterRoot, openImage, getTimeline, getFacets,
}) {
  let items = [];
  let hasMore = false;
  let loading = false;
  let loaded = false;
  let errorMessage = '';
  // 定位状态（Phase 11）：{ from, to, id, label }。非空时时间线只显示这个时间窗口，
  // 由搜索结果的「跳转」写入，用户改筛选或点「查看完整时间线」时清空。
  let focusState = null;

  // 筛选栏的任何变化都回到第一页重新查询（总数与分页状态都由数据层重算）。
  // 定位模式下改筛选 = 退出定位，回到完整的筛选视图。
  const filters = createFilterBar(filterRoot, () => {
    focusState = null;
    reload();
  });

  // 空状态只产出 HTML：定位模式与筛选模式会一起拼进容器，所以不能再直接改 container。
  function emptyStateHtml() {
    if (errorMessage) {
      return `<p class="timeline-error">时间线加载失败：${escapeHtml(errorMessage)}</p>`;
    }
    if (focusState) {
      return '<div class="timeline-empty">'
        + '<p>这个时间段里没有活动记录</p>'
        + '<p>记录可能已被删除，或当时还没开始记录。</p>'
        + '</div>';
    }
    // 有筛选条件时「还没有记录」和「没筛到」是两件事，文案要分开。
    if (hasActiveFilters(filters.read())) {
      return '<div class="timeline-empty">'
        + '<p>没有符合条件的记录</p>'
        + '<p>试试换个关键词，或点「清除筛选」。</p>'
        + '</div>';
    }
    return '<div class="timeline-empty">'
      + '<p>还没有活动记录</p>'
      + '<p>Life Lens 会自动记录你的活动。</p>'
      + '</div>';
  }

  // 定位横幅：说清「现在看的不是完整时间线」，并给一条回去的路。
  function focusBannerHtml() {
    return '<div class="timeline-focus">'
      + `<span>已定位到搜索结果的记录：${escapeHtml(focusState.label)}</span>`
      + '<button type="button" data-clear-focus>查看完整时间线</button>'
      + '</div>';
  }

  function renderAll() {
    if (!loaded) {
      container.innerHTML = '<p class="timeline-state">加载中…</p>';
      updateMoreButton();
      return;
    }

    const focusBanner = focusState ? focusBannerHtml() : '';
    if (!items.length) {
      container.innerHTML = focusBanner + emptyStateHtml();
    } else {
      const errorBanner = errorMessage
        ? `<p class="timeline-error">${escapeHtml(errorMessage)}</p>`
        : '';
      // 空的分组不会出现，groupByDay 只产出有内容的组。
      container.innerHTML = focusBanner + errorBanner
        + groupByDay(items).map((group) => renderGroup(group, focusState?.id ?? null)).join('');
      attachThumbFallbacks(container);
    }

    updateMoreButton();
  }

  function updateMoreButton() {
    moreButton.hidden = !hasMore;
    moreButton.disabled = loading;
    moreButton.textContent = loading ? '加载中…' : '加载更多';
  }

  function findCard(screenshotId) {
    const cards = container.querySelectorAll('.timeline-card');
    for (const card of cards) {
      if (card.dataset.id === String(screenshotId)) return card;
    }
    return null;
  }

  // 新记录按时间落到顶部：同一天就插进当前第一组，跨天就新开一组。
  function prependCard(record) {
    const date = toLocalDate(record.time);
    const key = date ? dayKey(date) : UNKNOWN_DAY_KEY;
    const firstDay = container.querySelector('.timeline-day');

    if (firstDay && firstDay.dataset.day === key) {
      const list = firstDay.querySelector('.timeline-list');
      list.prepend(htmlToElement(renderCard(record)));
      attachThumbFallbacks(list);
      return;
    }

    const group = htmlToElement(renderGroup({
      key,
      label: date ? formatDayLabel(date) : '未知时间',
      items: [record],
    }));
    if (firstDay) firstDay.before(group);
    else container.prepend(group);
    attachThumbFallbacks(group);
  }

  // 定位模式直接按时间窗口查（筛选栏只有日期粒度）；否则走正常的筛选查询。
  function currentQuery(offset = 0) {
    if (focusState) {
      return { from: focusState.from, to: focusState.to, limit: TIMELINE_PAGE_SIZE, offset };
    }
    return buildTimelineQuery(filters.read(), { limit: TIMELINE_PAGE_SIZE, offset });
  }

  async function reload() {
    loading = true;
    errorMessage = '';
    renderAll();

    const query = currentQuery();
    try {
      // 查询与筛选选项一起刷新：新出现的分类 / 项目会出现在下拉框里。
      const [page, facets] = await Promise.all([getTimeline(query), getFacets()]);
      items = Array.isArray(page?.items) ? page.items : [];
      hasMore = Boolean(page?.hasMore);
      filters.applyFacets(facets);
    } catch (error) {
      // 已经画出来的内容继续留着，只在时间线区域内提示失败。
      errorMessage = error?.message || String(error);
    } finally {
      loading = false;
      loaded = true;
    }

    renderAll();
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    errorMessage = '';
    updateMoreButton();

    try {
      // offset = 当前已加载条数：前插的新记录会自然把它顶大，不需要单独缓存服务端 offset。
      const page = await getTimeline(currentQuery(items.length));
      for (const record of Array.isArray(page?.items) ? page.items : []) {
        if (!items.some((item) => item.id === record.id)) items.push(record);
      }
      hasMore = Boolean(page?.hasMore);
    } catch (error) {
      errorMessage = `加载更多失败：${error?.message || error}`;
    } finally {
      loading = false;
      loaded = true;
    }

    renderAll();
  }

  function prependRecord(record) {
    if (!record || !record.id) return;
    // 定位模式看的是一个历史窗口，新记录不该插进来（插了也会落在窗口之外）。
    if (focusState) return;
    // 筛选状态下只前插符合条件的记录，其余等下一次重新查询。
    if (!matchesFilters(record, filters.read())) return;
    if (items.some((item) => item.id === record.id)) return;

    const hadError = Boolean(errorMessage);
    items.unshift(record);
    errorMessage = '';

    // 有错误条时整树重画，把已经过期的提示清掉；平时只做增量插入。
    if (!hadError && container.querySelector('.timeline-day')) prependCard(record);
    else renderAll();
  }

  // analysis 事件按 screenshotId 就地回填，语义与旧列表的 patch 一致。
  function patchRecord(screenshotId, patch) {
    const index = items.findIndex((item) => item.id === screenshotId);
    if (index < 0 || !patch) return false;

    const target = items[index];
    Object.assign(target, patch);
    // 回填后可能已经不符合当前筛选（例如「分析中」的记录刚分析完）：整条移出列表。
    if (!matchesFilters(target, filters.read())) {
      items.splice(index, 1);
      renderAll();
      return true;
    }

    const card = findCard(screenshotId);
    if (!card) {
      renderAll();
      return true;
    }

    const next = htmlToElement(renderCard(target, focusState?.id ?? null));
    card.replaceWith(next);
    attachThumbFallbacks(next);
    return true;
  }

  function showError(message) {
    errorMessage = message || '';
    renderAll();
  }

  // 搜索结果定位（Phase 11）：range 是 [from, to) 的时间窗口，id 是要高亮的那条记录。
  // 复用本视图的查询与渲染，不新建一套详情页面。
  async function focus(range, id = null) {
    const from = toLocalDate(range?.from);
    const to = toLocalDate(range?.to);
    if (!from || !to || to.getTime() <= from.getTime()) return false;

    focusState = { from, to, id: id ?? null, label: formatRangeLabel(from, to) };
    await reload();

    const card = (focusState.id === null ? null : findCard(focusState.id))
      ?? container.querySelector('.timeline-card');
    // 卡片已经渲染出来了，滚到视野中间，用户一眼能看到定位结果。
    card?.scrollIntoView?.({ block: 'center' });
    return true;
  }

  function clearFocus() {
    if (!focusState) return false;
    focusState = null;
    reload();
    return true;
  }

  container.addEventListener('click', (event) => {
    if (event.target.closest('button[data-clear-focus]')) {
      clearFocus();
      return;
    }
    const button = event.target.closest('button[data-image]');
    if (!button) return;
    Promise.resolve(openImage(button.dataset.image))
      .catch((error) => showError(error?.message || String(error)));
  });

  moreButton.addEventListener('click', () => {
    loadMore().catch((error) => showError(error?.message || String(error)));
  });

  return {
    reload,
    loadMore,
    prependRecord,
    patchRecord,
    showError,
    focus,
    clearFocus,
    isFocused: () => Boolean(focusState),
  };
}

function htmlToElement(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

// 截图文件被移走 / 删除时只把这张图的区域换成占位块，不影响卡片与整条时间线。
// 用 addEventListener 而不是内联 onerror：CSP 的 script-src 'self' 会拦掉内联事件。
function attachThumbFallbacks(root) {
  for (const img of root.querySelectorAll('img[data-thumb]')) {
    if (img.dataset.thumbBound) continue;
    img.dataset.thumbBound = '1';

    const replace = () => {
      const placeholder = document.createElement('div');
      placeholder.className = 'timeline-thumb timeline-thumb-missing';
      placeholder.textContent = '截图不可用';
      img.replaceWith(placeholder);
    };

    img.addEventListener('error', replace, { once: true });
    // 绑事件之前就已经失败的情况（例如文件不存在时浏览器直接给出失败结果）。
    if (img.complete && img.naturalWidth === 0) replace();
  }
}

function init() {
  const container = document.getElementById('timeline');
  const moreButton = document.getElementById('timeline-more');
  const filterRoot = document.getElementById('timeline-filters');
  if (!container || !moreButton || !filterRoot) return;

  window.lifelensTimeline = createTimelineView({
    container,
    moreButton,
    filterRoot,
    openImage: (file) => window.lifelens.openImage(file),
    getTimeline: (query) => window.lifelens.getTimeline(query),
    getFacets: () => window.lifelens.getTimelineFacets(),
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TIMELINE_PAGE_SIZE,
    imagePathToFileUrl,
    formatClock,
    formatDayLabel,
    formatRangeLabel,
    groupByDay,
    statusOf,
    parseDateInput,
    resolveTimeRange,
    buildTimelineQuery,
    hasActiveFilters,
    matchesFilters,
    PROJECT_UNASSIGNED,
    // 视图本体也导出：测试可以在假 DOM 里装配它（与 diary.js / dynamics.js 一致）。
    createTimelineView,
  };
}

})();
