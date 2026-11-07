'use strict';

// Phase 9：日记页的渲染层（日历 + 一天的日记）。
//
// 与 timeline.js / dynamics.js 相同的约定：整个文件包在 IIFE 里
// （三个文件都是 classic script，共享同一个全局作用域），上半部分是纯函数、
// 通过 module.exports 暴露给 node --test 直接 require，末尾的 DOM 初始化只在渲染进程里执行。
// 日期数学与 main/day.js 各有一份：重复的只是稳定的日历计算，换来两个层互不依赖。

(function () {

const BLOCK_MINUTES = 10;
// 日历第一列是周一。
const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
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

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// YYYY-MM-DD：字符串直接取前 10 个字符（本地 ISO 的前缀就是当时当地的日期）。
function dayKeyOf(value) {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const date = toDate(value);
  if (!date) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDayKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + (Number(days) || 0));
}

function shiftDayKey(value, days) {
  const date = parseDayKey(dayKeyOf(value));
  return date ? dayKeyOf(addDays(date, days)) : null;
}

// 2026年9月15日 周二
function dayLabel(value) {
  const date = parseDayKey(dayKeyOf(value));
  if (!date) return String(value ?? '');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_NAMES[date.getDay()]}`;
}

function monthLabel(year, month) {
  return `${year}年${month + 1}月`;
}

function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function categoryClass(category) {
  return CATEGORY_CLASSES[category] ?? '';
}

// ---- 日历网格 ----

// 一个月（周一起始、补满整周）的格子。mark 是 DiaryRepository.listDayMarks 的一行。
function calendarCells(year, month, { marks = new Map(), selected = null, today = null } = {}) {
  const first = new Date(year, month, 1, 0, 0, 0, 0);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const total = Math.ceil((offset + daysInMonth) / 7) * 7;

  const cells = [];
  for (let index = 0; index < total; index += 1) {
    const date = addDays(first, index - offset);
    const day = dayKeyOf(date);
    cells.push({
      day,
      date: date.getDate(),
      outside: date.getMonth() !== month,
      // 未来的日子按「日期键大于今天」判断：今天这一格不算未来。
      future: today !== null && day > today,
      today: today !== null && day === today,
      selected: selected !== null && day === selected,
      mark: marks.get(day) ?? null,
    });
  }
  return cells;
}

// 整月网格覆盖的日期范围（含补位的前后几天），用于一次查询拿全日历标记。
function monthRange(year, month) {
  const cells = calendarCells(year, month);
  if (!cells.length) return { from: null, to: null };
  return { from: cells[0].day, to: cells[cells.length - 1].day };
}

function cellTitle(cell) {
  const label = dayLabel(cell.day);
  const mark = cell.mark;
  if (!mark) return `${label} 没有记录`;
  const parts = [label];
  if (mark.blockCount) {
    parts.push(`${mark.blockCount} 个时间段`);
    if (mark.category) parts.push(`主要在${mark.category}`);
  }
  if (mark.status === 'COMPLETED') parts.push('已生成日记');
  else if (mark.status === 'PENDING') parts.push('正在生成日记');
  else if (mark.status === 'FAILED') parts.push('日记生成失败');
  else if (mark.pending) parts.push(`${mark.pending} 个时间段在汇总`);
  return parts.join(' · ');
}

function renderDot(mark) {
  if (!mark) return '<i class="cal-dot"></i>';
  if (mark.status === 'PENDING') return '<i class="cal-dot cal-dot-pending"></i>';
  if (mark.status === 'FAILED') return '<i class="cal-dot cal-dot-failed"></i>';
  if (mark.status === 'COMPLETED') {
    const cls = categoryClass(mark.category);
    return `<i class="cal-dot ${cls || 'cal-dot-muted'}"></i>`;
  }
  return mark.blockCount ? '<i class="cal-dot cal-dot-muted"></i>' : '<i class="cal-dot"></i>';
}

function renderCalendar(cells, { year, month, canGoNext = true } = {}) {
  const head = [
    '<div class="cal-head">',
    '<button type="button" class="cal-nav" data-month="-1" aria-label="上个月">‹</button>',
    `<span class="cal-title">${escapeHtml(monthLabel(year, month))}</span>`,
    `<button type="button" class="cal-nav" data-month="1" aria-label="下个月"${canGoNext ? '' : ' disabled'}>›</button>`,
    '<button type="button" class="cal-today">回到今天</button>',
    '</div>',
  ].join('');

  const weekdays = WEEKDAY_SHORT
    .map((name) => `<span class="cal-weekday">${escapeHtml(name)}</span>`)
    .join('');

  const days = cells
    .map((cell) => {
      const classes = ['cal-cell'];
      if (cell.outside) classes.push('outside');
      if (cell.today) classes.push('today');
      if (cell.selected) classes.push('selected');
      if (cell.future) classes.push('future');
      const inner = `<span class="cal-day">${cell.date}</span>${renderDot(cell.mark)}`;
      const title = escapeHtml(cellTitle(cell));
      if (cell.outside) {
        return `<span class="${classes.join(' ')}" title="${title}">${inner}</span>`;
      }
      return `<button type="button" class="${classes.join(' ')}" data-day="${cell.day}"`
        + ` title="${title}"${cell.future ? ' disabled' : ''}>${inner}</button>`;
    })
    .join('');

  return `${head}<div class="cal-grid">${weekdays}${days}</div>`;
}

// ---- 一天的日记 ----

function metaLine(payload) {
  const blocks = payload?.blocks ?? {};
  const parts = [];
  if (blocks.total) parts.push(`${blocks.total} 个时间段`);
  if (blocks.categorized) parts.push(`共 ${formatMinutes(blocks.categorized * BLOCK_MINUTES)}`);
  if (payload?.activityCount) parts.push(`${payload.activityCount} 张截图`);
  const top = Array.isArray(blocks.categories) ? blocks.categories[0] : null;
  if (top) parts.push(`主要在${top.category}（${top.blocks} 段）`);
  return parts.length ? parts.join(' · ') : '这一天没有记录';
}

function stateBlock(message) {
  return `<p class="diary-state">${escapeHtml(message)}</p>`;
}

function renderList(items, emptyText) {
  if (!Array.isArray(items) || !items.length) {
    return `<p class="diary-empty">${escapeHtml(emptyText)}</p>`;
  }
  return `<ul class="diary-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderSection(title, html) {
  return `<section class="diary-section"><h4>${escapeHtml(title)}</h4>${html}</section>`;
}

// 一天的日记正文：需求固定的六段内容。
function renderDiaryBody(diary) {
  const mainEvents = Array.isArray(diary.mainEvents) ? diary.mainEvents : [];
  const events = mainEvents.length
    ? `<ol class="diary-list diary-events">${mainEvents.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`
    : '<p class="diary-empty">这一天没有特别明确的主要事项</p>';

  return [
    renderSection('简短总结', `<p class="diary-summary">${escapeHtml(diary.summary ?? '')}</p>`),
    renderSection('主要事项', events),
    renderSection('高光', renderList(diary.highlights, '这一天没有记录到明显的高光')),
    renderSection('待办', renderList(diary.todos, '没有发现被落下的待办')),
    renderSection('优化建议', renderList(diary.suggestions, '暂无建议')),
    renderSection('温馨提示', renderList(diary.tips, '暂无提示')),
  ].join('');
}

function renderDiaryDetail(payload, { today = null } = {}) {
  if (!payload) return '<p class="timeline-state">加载中…</p>';

  const day = payload.day ?? '';
  const blocks = payload.blocks ?? {};
  const diary = payload.diary ?? null;
  const total = Number(blocks.total) || 0;
  const activityCount = Number(payload.activityCount) || 0;
  const todayKey = today ?? dayKeyOf(new Date());

  const regen = diary
    ? `<button type="button" class="diary-regen" data-day="${escapeHtml(day)}">重新生成</button>`
    : '';
  const head = [
    '<div class="diary-head">',
    '<div class="diary-head-text">',
    `<h3 class="diary-date">${escapeHtml(dayLabel(day))}</h3>`,
    `<p class="diary-meta">${escapeHtml(metaLine(payload))}</p>`,
    '</div>',
    regen,
    '</div>',
  ].join('');

  // 失败区块的提示：日记里确实缺了这一部分，如实说明。
  const failedNote = blocks.failed
    ? `<p class="diary-note">这一天有 ${blocks.failed} 个时间段汇总失败，日记里可能缺了这部分。</p>`
    : '';

  if (!total && !activityCount) {
    const message = day > todayKey ? '这一天还没到。' : '这一天没有记录。';
    return head + stateBlock(message);
  }
  if (!total) {
    return head + stateBlock(`这一天的 ${activityCount} 条记录还没有汇总成时间段，日记会在汇总完成后自动生成。`);
  }
  if (!diary) {
    const message = blocks.pending
      ? `还有 ${blocks.pending} 个时间段在汇总，汇总完成后会自动生成这一天的日记。`
      : '这一天的日记还没有生成，应用启动时会自动补上。';
    return head + stateBlock(message) + failedNote;
  }
  if (diary.status === 'PENDING') {
    return head + stateBlock('正在生成这一天的日记…') + failedNote;
  }
  if (diary.status === 'FAILED') {
    const reason = [diary.error, diary.errorCode].filter(Boolean).join(' · ') || '未知原因';
    return head + stateBlock(`日记生成失败：${reason}，可以点「重新生成」再试一次。`) + failedNote;
  }

  return head + renderDiaryBody(diary) + failedNote;
}

// ---- 日记生成状态（还有几天在排队 / 正在扫描）----

function renderDiaryStatus(status) {
  const stats = status?.stats ?? {};
  const pending = Number(stats.pending) || 0;
  const failed = Number(stats.failed) || 0;
  if (!pending && !failed && !status?.scanning) return null;
  const parts = [];
  if (pending) parts.push(`正在生成 ${pending} 天的日记`);
  if (status?.scanning) parts.push('正在检查有没有漏掉的日记');
  if (failed) parts.push(`${failed} 天生成失败`);
  return parts.join(' · ');
}

// ---- 视图 ----

// 换月时保持「同一个日号」：9 月 15 日 -> 8 月 15 日；目标月没有这一天就退到月末。
function shiftMonthCursor(cursor, delta, selectedDay) {
  const target = new Date(cursor.year, cursor.month + delta, 1);
  const year = target.getFullYear();
  const month = target.getMonth();
  const selected = parseDayKey(selectedDay);
  const dayNumber = selected ? selected.getDate() : 1;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(dayNumber, lastDay);
  return { year, month, day: dayKeyOf(new Date(year, month, day)) };
}

function createDiaryView({
  calendarRoot, detailRoot, statusEl, getDiary, getDays, getStatus, regenerate,
}) {
  const today = () => dayKeyOf(new Date());
  // 需求 1.1：默认打开前一天的日记。
  let selectedDay = shiftDayKey(today(), -1);
  let cursor = monthOf(selectedDay);
  let payload = null;
  let marks = new Map();
  let diaryStatus = null;
  let loading = false;
  let errorMessage = '';

  function monthOf(day) {
    const date = parseDayKey(day) ?? new Date();
    return { year: date.getFullYear(), month: date.getMonth() };
  }

  function render() {
    const cells = calendarCells(cursor.year, cursor.month, {
      marks,
      selected: selectedDay,
      today: today(),
    });
    calendarRoot.innerHTML = renderCalendar(cells, {
      year: cursor.year,
      month: cursor.month,
      // 不允许翻到完全属于未来的月份。
      canGoNext: `${cursor.year}-${pad(cursor.month + 1)}` <= today().slice(0, 7),
    });

    if (errorMessage) {
      detailRoot.innerHTML = `<p class="timeline-error">${escapeHtml(errorMessage)}</p>`;
    } else if (loading && !payload) {
      detailRoot.innerHTML = '<p class="timeline-state">加载中…</p>';
    } else {
      detailRoot.innerHTML = renderDiaryDetail(payload, { today: today() });
    }

    const text = renderDiaryStatus(diaryStatus);
    statusEl.hidden = !text;
    if (text) statusEl.textContent = text;
  }

  async function reload() {
    loading = true;
    errorMessage = '';
    render();

    const range = monthRange(cursor.year, cursor.month);
    try {
      const [day, dayMarks, status] = await Promise.all([
        getDiary(selectedDay),
        getDays({ from: range.from, to: range.to }),
        getStatus(),
      ]);
      payload = day ?? null;
      marks = new Map(
        (Array.isArray(dayMarks) ? dayMarks : [])
          .filter((mark) => mark && mark.day)
          .map((mark) => [mark.day, mark]),
      );
      diaryStatus = status ?? null;
    } catch (error) {
      errorMessage = `加载日记失败：${error?.message || error}`;
    } finally {
      loading = false;
    }
    render();
  }

  calendarRoot.addEventListener('click', (event) => {
    const nav = event.target.closest('.cal-nav');
    if (nav) {
      const delta = Number(nav.dataset.month) || 0;
      const next = shiftMonthCursor(cursor, delta, selectedDay);
      cursor = { year: next.year, month: next.month };
      selectedDay = next.day;
      reload();
      return;
    }
    if (event.target.closest('.cal-today')) {
      selectedDay = today();
      cursor = monthOf(selectedDay);
      reload();
      return;
    }
    const cell = event.target.closest('button.cal-cell');
    if (!cell || cell.disabled) return;
    selectedDay = cell.dataset.day;
    cursor = monthOf(selectedDay);
    reload();
  });

  detailRoot.addEventListener('click', async (event) => {
    const button = event.target.closest('button.diary-regen');
    if (!button) return;
    button.disabled = true;
    try {
      await regenerate(button.dataset.day);
    } catch (error) {
      errorMessage = `重新生成失败：${error?.message || error}`;
    }
    await reload();
  });

  return {
    reload,
    // 收到主进程的日记事件后刷新（正在生成 -> 生成完成）。
    refresh: () => reload(),
    selectDay(day) {
      const key = dayKeyOf(day);
      if (!key) return;
      selectedDay = key;
      cursor = monthOf(key);
      return reload();
    },
    read: () => ({ selectedDay, cursor }),
  };
}

function init() {
  const calendarRoot = document.getElementById('diary-calendar');
  const detailRoot = document.getElementById('diary-detail');
  const statusEl = document.getElementById('diary-status');
  if (!calendarRoot || !detailRoot || !statusEl) return;

  window.lifelensDiary = createDiaryView({
    calendarRoot,
    detailRoot,
    statusEl,
    getDiary: (day) => window.lifelens.getDiary(day),
    getDays: (query) => window.lifelens.getDiaryDays(query),
    getStatus: () => window.lifelens.getDiaryStatus(),
    regenerate: (day) => window.lifelens.regenerateDiary(day),
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BLOCK_MINUTES,
    WEEKDAY_SHORT,
    WEEKDAY_NAMES,
    CATEGORY_CLASSES,
    dayKeyOf,
    parseDayKey,
    addDays,
    shiftDayKey,
    dayLabel,
    monthLabel,
    formatMinutes,
    categoryClass,
    calendarCells,
    monthRange,
    cellTitle,
    renderDot,
    renderCalendar,
    metaLine,
    renderDiaryBody,
    renderDiaryDetail,
    renderDiaryStatus,
    shiftMonthCursor,
    createDiaryView,
  };
}

})();