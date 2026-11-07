'use strict';

// Phase 13：悬浮入口的位置逻辑。
// 越界校正写成纯函数（不依赖 electron / screen），保存与读取用一个注入 fs 的小模块，
// 这样多显示器、分辨率变化、显示器被拔掉、JSON 损坏这些情况都能用 node --test 直接覆盖。

const path = require('node:path');

const POSITION_FILE_NAME = 'launcher-position.json';
// 没有历史位置时，默认位置离工作区右下角的留白。
const DEFAULT_MARGIN = 24;

function toFinite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

// workArea 是 screen 模块给的对象，测试里直接传字面量：只认这四个数。
function usableArea(area) {
  if (!area) return false;
  return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(area[key])))
    && Number(area.width) > 0 && Number(area.height) > 0;
}

function overlapArea(rect, area) {
  const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  return Math.max(0, width) * Math.max(0, height);
}

// 位置完全落在屏幕外（例如保存位置所在的显示器被拔掉）时退而求其次：
// 挑中心点最近的那块屏幕，而不是让窗口跑到用户够不着的地方。
function nearestArea(rect, areas) {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  let best = areas[0];
  let bestDistance = Infinity;
  for (const area of areas) {
    const distance = Math.hypot(centerX - (area.x + area.width / 2), centerY - (area.y + area.height / 2));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = area;
    }
  }
  return best;
}

function clampAxis(value, min, max) {
  // 工作区比窗口还小（分辨率变小）：贴左上角，保证窗口左上角一定可见。
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

// 把一个保存过的位置校正到「窗口完整落在某块可见 workArea 内」。
// position / size 不合法（缺字段、NaN、字符串数字）时也返回一个可见位置，不抛错。
function clampToWorkArea(position, size, workAreas) {
  const width = Math.max(1, toFinite(size?.width, 1));
  const height = Math.max(1, toFinite(size?.height, 1));
  const rect = { x: toFinite(position?.x, 0), y: toFinite(position?.y, 0), width, height };

  const areas = (Array.isArray(workAreas) ? workAreas : []).filter(usableArea);
  // 一块屏幕都没有（理论上不会发生）：保持原样，至少不编造一个位置。
  if (areas.length === 0) return { x: rect.x, y: rect.y };

  let target = null;
  let maxOverlap = 0;
  for (const area of areas) {
    const overlap = overlapArea(rect, area);
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      target = area;
    }
  }
  const area = target ?? nearestArea(rect, areas);

  return {
    x: clampAxis(rect.x, area.x, area.x + area.width - width),
    y: clampAxis(rect.y, area.y, area.y + area.height - height),
  };
}

// 首次启动（或被拔掉的显示器上那份位置读不出来）时的位置：主屏工作区右下角。
function defaultLauncherPosition(area, size, margin = DEFAULT_MARGIN) {
  const width = Math.max(1, toFinite(size?.width, 1));
  const height = Math.max(1, toFinite(size?.height, 1));
  if (!usableArea(area)) return { x: margin, y: margin };
  return {
    x: Math.round(area.x + area.width - width - margin),
    y: Math.round(area.y + area.height - height - margin),
  };
}

// 位置文件只有 { x, y } 两个数：
// 读不出来（文件缺失 / JSON 损坏 / 字段不合法）返回 null，由调用方回退默认位置；
// 写不进去也返回 null，不影响使用，只是下次启动回到默认位置。
function createPositionStore({ filePath, fs }) {
  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const x = Number(parsed?.x);
      const y = Number(parsed?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: Math.round(x), y: Math.round(y) };
    } catch {
      return null;
    }
  }

  async function save(position) {
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const payload = { x: Math.round(x), y: Math.round(y) };
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
      return payload;
    } catch {
      return null;
    }
  }

  return { load, save };
}

module.exports = {
  POSITION_FILE_NAME,
  DEFAULT_MARGIN,
  clampToWorkArea,
  defaultLauncherPosition,
  createPositionStore,
};
