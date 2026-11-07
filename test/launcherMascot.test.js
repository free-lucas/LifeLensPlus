'use strict';

// Phase 13.2 / 13.3：小镜素材（三态 + 待机）与它在 launcher.html 里的内联副本。
//
// 悬浮入口是个独立页面，CSP 只有 default-src none —— 外链图片会被直接拦掉，
// 所以三份 SVG 是按原样内联进 HTML 的。内联就意味着同一份图形有两个落点，
// 这份测试把「两边必须一样」钉住：只改了 assets/ 下的素材而忘了同步 HTML，这里会红。

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { EFFECT_MASCOTS, IDLE_MASCOT } = require('../src/renderer/launcher');

const ASSET_DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets');
const HTML_PATH = path.join(__dirname, '..', 'src', 'renderer', 'launcher.html');
const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'launcher.css');

const readUtf8 = (file) => fs.readFileSync(file, 'utf8');
const assetPathOf = (state) => path.join(ASSET_DIR, `mascot-${state}.svg`);

// 逐行比对要忽略缩进：素材是顶格写的，内联副本按 HTML 层级缩进了 8 格。
const bodyLines = (text) => text.replace(/\s+$/, '').split('\n').map((line) => line.trim());

// 从 HTML 里切出 .mascot-<state> 容器内的那一棵 <svg>…</svg>。
function inlineSvgOf(html, state) {
  const container = html.indexOf(`<span class="mascot mascot-${state}"`);
  if (container === -1) return null;
  const start = html.indexOf('<svg', container);
  const end = html.indexOf('</svg>', start);
  if (start === -1 || end === -1) return null;
  return html.slice(start, end + '</svg>'.length);
}

test('小镜 1：三个瞬时特效各配一只小镜，素材落在 src/renderer/assets/', () => {
  assert.deepEqual(EFFECT_MASCOTS, {
    'effect-shutter': 'smug',
    'effect-success': 'happy',
    'effect-error': 'thinking',
  });

  for (const state of Object.values(EFFECT_MASCOTS)) {
    const file = assetPathOf(state);
    assert.ok(fs.existsSync(file), `${file} 应该存在`);
    // 顶格的 <svg 开头 = 没有 BOM、也没有 XML 声明：这份素材还要喂给别的渲染层。
    assert.match(readUtf8(file), /^<svg /, `${file} 应该以 <svg 开头`);
  }
});

test('小镜 2：三份素材按原样内联在 launcher.html 里（逐行一致）', () => {
  const html = readUtf8(HTML_PATH);

  for (const state of Object.values(EFFECT_MASCOTS)) {
    const inline = inlineSvgOf(html, state);
    assert.notEqual(inline, null, `launcher.html 里应该有 .mascot-${state} 的内联 SVG`);
    assert.deepEqual(
      bodyLines(inline),
      bodyLines(readUtf8(assetPathOf(state))),
      `.mascot-${state} 的内联副本与 assets/mascot-${state}.svg 已经不一致`,
    );
  }
});

test('小镜 3：内联到同一个文档后 id 不重复', () => {
  const html = readUtf8(HTML_PATH);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const dup = ids.filter((id, index) => ids.indexOf(id) !== index);
  // 三份 SVG 各自带一套渐变 / 裁切 id（都带状态后缀），合并进一个文档后仍然唯一：
  // 重名会让 url(#...) 引到别人的渐变上。
  assert.deepEqual(dup, []);
  assert.equal(ids.length, new Set(ids).size);
});

test('小镜 4：三只小镜默认不显示，各自只由对应的瞬时态放出来', () => {
  const css = readUtf8(CSS_PATH);

  assert.match(css, /\.mascot\s*\{[^}]*opacity: 0;/);
  assert.match(css, /\.mascot\s*\{[^}]*visibility: hidden;/);

  for (const [effectClass, state] of Object.entries(EFFECT_MASCOTS)) {
    assert.ok(
      css.includes(`body.${effectClass} .mascot-${state}`),
      `launcher.css 里应该有 body.${effectClass} .mascot-${state} 这条规则`,
    );
    // 出场动画的时长必须跟着光圈走，否则会出现「光圈还在扩、小镜已经没了」。
    assert.match(css, new RegExp(`body\\.${effectClass} \\.mascot-${state}[^}]*animation: mascot-pop`));
  }
});

test('小镜 5：待机小镜（持续态）也有素材，且与 launcher.html 的内联副本逐行一致', () => {
  const html = readUtf8(HTML_PATH);
  const file = assetPathOf(IDLE_MASCOT);

  assert.equal(IDLE_MASCOT, 'idle');
  assert.ok(fs.existsSync(file), `${file} 应该存在`);
  assert.match(readUtf8(file), /^<svg /, `${file} 应该以 <svg 开头`);

  const inline = inlineSvgOf(html, IDLE_MASCOT);
  assert.notEqual(inline, null, `launcher.html 里应该有 .mascot-${IDLE_MASCOT} 的内联 SVG`);
  assert.deepEqual(
    bodyLines(inline),
    bodyLines(readUtf8(file)),
    `待机小镜的内联副本与 assets/mascot-${IDLE_MASCOT}.svg 已经不一致`,
  );
});

test('小镜 6：待机小镜是默认脸（录制中与暂停时都在台上），只有瞬时态时让位', () => {
  const css = readUtf8(CSS_PATH);

  // 默认仍然藏着：它是「默认脸」，但也要由 state class 放出来 —— 没有状态事件时不猜。
  assert.match(css, /\.mascot\s*\{[^}]*visibility: hidden;/);

  // 两个状态共用同一条规则把它放出来（共用声明，免得两边漂移）。
  // 而且是「停在终态」的淡入：不能用 mascot-pop，它最后一帧是 opacity 0，脸会自己消失。
  const showAt = css.search(/body\.state-running \.mascot-idle,/);
  assert.notEqual(showAt, -1, '待机小镜应该由 state-running / state-paused 共用的规则放出来');
  const showBlock = css.slice(showAt, css.indexOf('}', showAt));
  assert.match(showBlock, /body\.state-paused \.mascot-idle/);
  assert.match(showBlock, /visibility: visible;/);
  assert.match(showBlock, /opacity: 1;/);
  assert.match(showBlock, /animation: mascot-in/);

  // 光圈圆标让位：两个状态下都藏起来（两者叠在一起会互相打架）。
  const yieldAt = css.search(/body\.state-running \.glyph,/);
  assert.notEqual(yieldAt, -1, '光圈圆标应该在两个状态下都让位');
  const yieldBlock = css.slice(yieldAt, css.indexOf('}', yieldAt));
  assert.match(yieldBlock, /body\.state-paused \.glyph/);
  assert.match(yieldBlock, /opacity: 0;/);

  // 降级：显隐是纯 CSS 的，所以直接删掉淡入（不会因为动画名被删而卡住）。
  const reducedAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.notEqual(reducedAt, -1);
  const reducedBlock = css.slice(reducedAt);
  assert.match(reducedBlock, /body\.state-running \.mascot-idle,/);
  assert.match(reducedBlock, /body\.state-paused \.mascot-idle \{ animation: none; \}/);

  // 台上照样会来瞬时事件：那只上场、待机这只退场。
  // 三个瞬时态写在同一组选择器里，所以按整块断言，而不是逐个匹配单行规则。
  const idleHideAt = css.search(/body\.effect-shutter \.mascot-idle,/);
  assert.notEqual(idleHideAt, -1, '应该有一条「待机小镜在瞬时态时退场」的规则');
  const idleHideBlock = css.slice(idleHideAt, css.indexOf('}', idleHideAt));
  for (const effect of ['effect-shutter', 'effect-success', 'effect-error']) {
    assert.match(idleHideBlock, new RegExp('body\\.' + effect + ' \\.mascot-idle'), `退场规则应该覆盖 ${effect}`);
  }
  assert.match(idleHideBlock, /visibility: hidden;/);
  assert.match(idleHideBlock, /opacity: 0;/);

  // 顺序也是约定的一部分：两边特异性相同（0,2,1），这条必须写在放它出来那条之后才生效。
  assert.ok(idleHideAt > showAt, '退场规则必须写在待机小镜上场规则之后');
});
