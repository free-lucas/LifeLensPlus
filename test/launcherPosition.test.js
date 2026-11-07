'use strict';

// Phase 13：悬浮入口位置逻辑的单测。
// 越界校正与位置存取都不依赖 electron / 真实 fs，所以显示器被拔掉、分辨率变化、
// JSON 损坏这些情况在 node --test 里可以直接构造。

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  POSITION_FILE_NAME,
  DEFAULT_MARGIN,
  clampToWorkArea,
  defaultLauncherPosition,
  createPositionStore,
} = require('../src/main/launcher/launcherPosition');

const SIZE = { width: 56, height: 56 };
// 主屏 1920x1080（任务栏 40px -> workArea 高 1040），副屏摆在右边。
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const SECONDARY = { x: 1920, y: 0, width: 1280, height: 1024 };
const TWO_SCREENS = [PRIMARY, SECONDARY];

// ---- 越界校正（纯函数）----

test('悬浮位置 1：正常位置原样保留，贴边位置也不会被推走', () => {
  assert.deepEqual(clampToWorkArea({ x: 100, y: 200 }, SIZE, TWO_SCREENS), { x: 100, y: 200 });
  // 右下角极限：窗口右下角正好贴住工作区右下角。
  assert.deepEqual(clampToWorkArea({ x: 1864, y: 984 }, SIZE, TWO_SCREENS), { x: 1864, y: 984 });
});

test('悬浮位置 2：越界 / 负坐标都被夹回可见工作区', () => {
  // 右下越界：离得最近的是副屏，夹到副屏右下角。
  assert.deepEqual(clampToWorkArea({ x: 4000, y: 3000 }, SIZE, TWO_SCREENS), { x: 3144, y: 968 });
  // 左上负坐标：夹回主屏左上角。
  assert.deepEqual(clampToWorkArea({ x: -300, y: -120 }, SIZE, TWO_SCREENS), { x: 0, y: 0 });
  // 只越界一边时另一边的坐标保持不动。
  assert.deepEqual(clampToWorkArea({ x: 5000, y: 300 }, SIZE, [PRIMARY]), { x: 1864, y: 300 });
});

test('悬浮位置 3：位置落在副屏上时不被拉回主屏', () => {
  assert.deepEqual(clampToWorkArea({ x: 2600, y: 400 }, SIZE, TWO_SCREENS), { x: 2600, y: 400 });
  // 跨在两块屏中间：按重叠面积选屏，窗口被完整拉进重叠更多的那块（这里是副屏）。
  assert.deepEqual(clampToWorkArea({ x: 1900, y: 500 }, SIZE, TWO_SCREENS), { x: 1920, y: 500 });
});

test('悬浮位置 4：保存位置所在的显示器被拔掉后回到剩余屏幕内', () => {
  // 上半部分是副屏坐标，现在只剩主屏：落到主屏右边缘，仍然完整可见。
  const fixed = clampToWorkArea({ x: 2800, y: 300 }, SIZE, [PRIMARY]);
  assert.deepEqual(fixed, { x: 1864, y: 300 });
  assert.ok(fixed.x + SIZE.width <= PRIMARY.width);
});

test('悬浮位置 5：分辨率变小后位置仍然落在新的工作区内', () => {
  const small = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(clampToWorkArea({ x: 1864, y: 984 }, SIZE, [small]), { x: 744, y: 544 });

  // 工作区比窗口还小（极端缩放）：贴左上角，至少左上角可见。
  const tiny = { x: 10, y: 20, width: 40, height: 30 };
  assert.deepEqual(clampToWorkArea({ x: 900, y: 900 }, SIZE, [tiny]), { x: 10, y: 20 });
});

test('悬浮位置 6：字段缺失 / 非法 / 没有可用工作区都不抛错', () => {
  assert.deepEqual(clampToWorkArea(null, SIZE, TWO_SCREENS), { x: 0, y: 0 });
  assert.deepEqual(clampToWorkArea({ x: 'abc', y: NaN }, SIZE, TWO_SCREENS), { x: 0, y: 0 });
  // size 缺失时按 1x1 处理，位置仍然有效。
  assert.deepEqual(clampToWorkArea({ x: 10, y: 20 }, null, TWO_SCREENS), { x: 10, y: 20 });
  // 工作区列表里的非法项被过滤掉，合法的照常用。
  assert.deepEqual(clampToWorkArea({ x: 100, y: 100 }, SIZE, [null, { width: 0, height: 0 }, PRIMARY]), { x: 100, y: 100 });
  // 一块工作区都没有：保持原样，不编造位置。
  assert.deepEqual(clampToWorkArea({ x: 30, y: 40 }, SIZE, []), { x: 30, y: 40 });
  assert.deepEqual(clampToWorkArea({ x: 30, y: 40 }, SIZE, null), { x: 30, y: 40 });
});

test('悬浮位置 7：默认位置在主屏右下角，没有工作区时退到留白处', () => {
  assert.deepEqual(defaultLauncherPosition(PRIMARY, SIZE), {
    x: 1920 - 56 - DEFAULT_MARGIN,
    y: 1040 - 56 - DEFAULT_MARGIN,
  });
  assert.deepEqual(defaultLauncherPosition(PRIMARY, SIZE, 0), { x: 1864, y: 984 });
  assert.deepEqual(defaultLauncherPosition(null, SIZE), { x: DEFAULT_MARGIN, y: DEFAULT_MARGIN });
});

// ---- 位置存取（注入 fs）----

function fakeFs({ files = {}, failRead = false, failWrite = false } = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    async readFile(file) {
      if (failRead) throw new Error('EACCES: 读不了');
      if (!store.has(file)) {
        const error = new Error('ENOENT: 文件不存在');
        error.code = 'ENOENT';
        throw error;
      }
      return store.get(file);
    },
    async mkdir() {},
    async writeFile(file, data) {
      if (failWrite) throw new Error('EACCES: 写不了');
      store.set(file, data);
    },
  };
}

const FILE = path.join('C:', 'tmp', POSITION_FILE_NAME);

test('悬浮位置 8：注入 fs 的存取 —— 缺失 / 损坏 / 字段非法都回退 null', async () => {
  const store = createPositionStore({ filePath: FILE, fs: fakeFs() });
  // 文件不存在：首次启动走这里，返回 null 由调用方回退默认位置。
  assert.equal(await store.load(), null);

  const corrupt = createPositionStore({ filePath: FILE, fs: fakeFs({ files: { [FILE]: '{"x":12,' } }) });
  assert.equal(await corrupt.load(), null);

  const partial = createPositionStore({ filePath: FILE, fs: fakeFs({ files: { [FILE]: '{"x":12}' } }) });
  assert.equal(await partial.load(), null);

  const wrongType = createPositionStore({ filePath: FILE, fs: fakeFs({ files: { [FILE]: '[1,2]' } }) });
  assert.equal(await wrongType.load(), null);

  const nan = createPositionStore({ filePath: FILE, fs: fakeFs({ files: { [FILE]: '{"x":"a","y":null}' } }) });
  assert.equal(await nan.load(), null);

  // 读失败（权限 / 设备错误）同样是 null，不往上抛。
  const broken = createPositionStore({ filePath: FILE, fs: fakeFs({ failRead: true }) });
  assert.equal(await broken.load(), null);
});

test('悬浮位置 9：注入 fs 的存取 —— 保存写入的是 { x, y }，取整后读回一致', async () => {
  const io = fakeFs();
  const store = createPositionStore({ filePath: FILE, fs: io });

  assert.deepEqual(await store.save({ x: 12.6, y: -3.2 }), { x: 13, y: -3 });
  assert.equal(io.store.get(FILE), '{"x":13,"y":-3}\n');
  assert.deepEqual(await store.load(), { x: 13, y: -3 });

  // 非法坐标不写盘。
  const before = io.store.get(FILE);
  assert.equal(await store.save({ x: 'left', y: 1 }), null);
  assert.equal(await store.save(null), null);
  assert.equal(io.store.get(FILE), before);

  // 写失败只返回 null，不影响调用方（位置存不下来不该让拖动报错）。
  const failing = createPositionStore({ filePath: FILE, fs: fakeFs({ failWrite: true }) });
  assert.equal(await failing.save({ x: 1, y: 2 }), null);
});

test('悬浮位置 10：真实 fs 存到临时目录再读回', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifelens-launcher-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // 目录还不存在：save 自己建目录。
  const filePath = path.join(dir, 'nested', POSITION_FILE_NAME);
  const store = createPositionStore({ filePath, fs });
  assert.deepEqual(await store.load(), null);
  assert.deepEqual(await store.save({ x: 1200, y: 640 }), { x: 1200, y: 640 });
  assert.deepEqual(await store.load(), { x: 1200, y: 640 });

  // 手工写坏文件：读回 null 而不是抛错。
  await fs.writeFile(filePath, 'not json at all', 'utf8');
  assert.equal(await store.load(), null);
});
