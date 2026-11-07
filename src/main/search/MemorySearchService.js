'use strict';

const { EVENTS } = require('../ai/jobEventLog');
const { ERROR_CODES } = require('../ai/errors');

// Phase 11：三层记忆的聚合语义检索。
//
// 一条链路：查询文本 -> embedding -> 三张向量表各查一次 -> 按 _distance 合并排序
//          -> 回 SQLite 取完整记录 -> 交给界面。
//
// 边界（与 Phase 10 的分层约定一致）：
// - LanceDB 的读只在 MemoryVectorRepository，这一层不 require 原生模块、不写过滤 SQL；
// - SQL 只在 db/repositories，这一层只调用 getById / getByStart / getByDay；
// - 这一层只做编排、来源类型解析与结果整形，不做 Prompt、不做生成式问答。
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// 向量表 -> 来源类型。三张表结构一致、没有 source_type 列：
// 来源类型由「查的是哪张表」决定，行 ID 前缀与表一一对应（Phase 10 的约定）。
const SOURCE_LAYERS = Object.freeze({
  activity: { table: 'activity_vectors', idPrefix: 'activity', label: '20秒记录' },
  block: { table: 'block_vectors', idPrefix: 'block', label: '10分钟汇总' },
  diary: { table: 'diary_vectors', idPrefix: 'diary', label: '日记' },
});

const LAYER_NAMES = Object.freeze(Object.keys(SOURCE_LAYERS));
const TABLE_TO_LAYER = new Map(LAYER_NAMES.map((name) => [SOURCE_LAYERS[name].table, name]));

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class MemorySearchError extends Error {
  constructor(message, { code = 'SEARCH_FAILED', cause } = {}) {
    super(message);
    this.name = 'MemorySearchError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function clampLimit(value) {
  const size = Math.floor(Number(value));
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_LIMIT;
  return Math.min(size, MAX_LIMIT);
}

// 行 ID（activity:123）-> source_id（123）。前缀对不上、空值都返回 null。
function sourceIdOfRowId(rowId, prefix) {
  const text = String(rowId ?? '');
  const head = `${prefix}:`;
  if (!text.startsWith(head)) return null;
  const rest = text.slice(head.length);
  return rest === '' ? null : rest;
}

// 向量行 -> 来源信息。表名不认识、source_id 取不出来都返回 null（这一条跳过，不让整次搜索失败）。
// source_id 优先取行里的列；列缺失（老数据 / 手工写入）时退回按行 ID 前缀解析。
function resolveSource(tableName, row) {
  const sourceType = TABLE_TO_LAYER.get(String(tableName ?? '')) ?? null;
  if (!sourceType) return null;

  const layer = SOURCE_LAYERS[sourceType];
  const raw = row?.source_id;
  const sourceId = raw === null || raw === undefined || String(raw) === ''
    ? sourceIdOfRowId(row?.id, layer.idPrefix)
    : String(raw);
  if (sourceId === null) return null;

  return { sourceType, sourceLabel: layer.label, sourceId };
}

// LanceDB 的向量检索在结果行里附 _distance（越小越接近）；取不到就当无穷远排在最后。
function distanceOf(row) {
  const distance = Number(row?._distance);
  return Number.isFinite(distance) ? distance : null;
}

// 相似度相同时用「层的固定顺序 + source_id」兜底，保证同样的输入得到同样的顺序（测试可断言）。
function byDistance(a, b) {
  const left = a.distance ?? Number.POSITIVE_INFINITY;
  const right = b.distance ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  const layerDiff = LAYER_NAMES.indexOf(a.sourceType) - LAYER_NAMES.indexOf(b.sourceType);
  if (layerDiff !== 0) return layerDiff;
  return String(a.sourceId).localeCompare(String(b.sourceId));
}

// captured_at / day 的前 10 个字符就是本地日期，与 SQLite 侧口径一致。
function dayOf(value) {
  const text = String(value ?? '').slice(0, 10);
  return DAY_PATTERN.test(text) ? text : null;
}

// 可选的标签数组：非数组、空字符串、非字符串一律丢掉，界面上不会出现「关键词：」后面跟着空值。
function toTags(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim() !== '');
}

class MemorySearchService {
  constructor({
    provider,
    vectors,
    activities = null,
    timeBlocks = null,
    diaries = null,
    log = null,
    limit = DEFAULT_LIMIT,
    now = () => Date.now(),
  }) {
    this.provider = provider ?? null;
    this.vectors = vectors ?? {};
    this.activities = activities;
    this.timeBlocks = timeBlocks;
    this.diaries = diaries;
    this.log = log;
    this.limit = clampLimit(limit);
    this.now = now;
  }

  // 查询文本 -> 向量 -> 三表检索 -> 合并排序 -> 回查 SQLite。
  // 空查询直接返回空结果（不打扰 Ollama）；检索层面的失败抛 MemorySearchError，由 IPC 转给界面显示。
  async search(query, { limit } = {}) {
    const text = String(query ?? '').trim();
    const size = clampLimit(limit ?? this.limit);
    if (!text) {
      return {
        query: text,
        limit: size,
        items: [],
        hits: 0,
        returned: 0,
        layerCounts: emptyLayerCounts(),
        missing: 0,
        invalid: 0,
        elapsedMs: 0,
        model: this.provider?.model ?? null,
      };
    }

    const startedAt = this.now();
    const vector = await this._embed(text);
    const { hits, layerCounts, failures, invalid, registered } = await this._searchLayers(vector, size);

    if (registered === 0) {
      throw new MemorySearchError('记忆搜索不可用：向量索引没有装配任何一层', { code: 'INDEX_UNAVAILABLE' });
    }
    // 三张表全军覆没（原生模块缺失 / 库被删 / 维度对不上）才算失败；只坏一层时其余层照常返回。
    if (failures.length === registered) {
      throw new MemorySearchError(
        `记忆搜索不可用：向量检索失败（${failures.map((item) => `${item.layer}: ${item.error.message}`).join('；')}）`,
        { code: 'VECTOR_UNAVAILABLE', cause: failures[0].error },
      );
    }
    for (const failure of failures) {
      this.log?.record(EVENTS.MEMORY_SEARCH_ERROR, {
        errorCode: failure.error?.code ?? ERROR_CODES.UNKNOWN,
        message: `记忆搜索跳过 ${failure.layer} 层：${failure.error?.message ?? failure.error}`,
      });
    }

    hits.sort(byDistance);
    const merged = hits.slice(0, size);
    const hydrated = this._hydrate(merged);
    const result = {
      query: text,
      limit: size,
      items: hydrated.items,
      hits: merged.length,
      returned: hydrated.items.length,
      layerCounts,
      missing: hydrated.missing,
      invalid: invalid + hydrated.invalid,
      elapsedMs: Math.max(0, this.now() - startedAt),
      model: this.provider?.model ?? null,
    };

    // 只记元信息，不记查询文本（与「日志不含截图内容 / Prompt」的口径一致）。
    this.log?.record(EVENTS.MEMORY_SEARCH, {
      message: `记忆搜索命中 ${result.returned} 条`
        + `（20秒记录 ${layerCounts.activity} / 10分钟汇总 ${layerCounts.block} / 日记 ${layerCounts.diary}`
        + `，${result.elapsedMs}ms，缺失 ${result.missing}，跳过 ${result.invalid}）`,
    });
    return result;
  }

  // 查询向量必须走与写入同一个 Provider，维度校验也在 Provider 内部（Phase 10 已实现）。
  async _embed(text) {
    if (typeof this.provider?.embedText !== 'function') {
      throw new MemorySearchError('记忆搜索不可用：Embedding 未装配', { code: 'INDEX_UNAVAILABLE' });
    }

    let vector;
    try {
      vector = await this.provider.embedText(text);
    } catch (error) {
      this.log?.record(EVENTS.MEMORY_SEARCH_ERROR, {
        errorCode: error?.code ?? ERROR_CODES.UNKNOWN,
        message: `查询嵌入失败：${error?.message ?? error}`,
      });
      throw new MemorySearchError(`搜索失败：嵌入查询失败（${error?.message ?? error}）`, {
        code: 'EMBEDDING_UNAVAILABLE',
        cause: error,
      });
    }

    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => Number.isFinite(value))) {
      throw new MemorySearchError('搜索失败：Embedding 返回了非法向量', { code: 'INVALID_RESULT' });
    }
    return vector;
  }

  // 三张表各查一次（每表最多 limit 条），合并后由调用方按 _distance 排序截取。
  async _searchLayers(vector, size) {
    const layerCounts = emptyLayerCounts();
    const hits = [];
    const failures = [];
    let invalid = 0;
    let registered = 0;

    for (const name of LAYER_NAMES) {
      const repo = this.vectors?.[name];
      if (!repo || typeof repo.search !== 'function') continue;
      registered += 1;

      let rows;
      try {
        rows = await repo.search(vector, { limit: size });
      } catch (error) {
        failures.push({ layer: name, error });
        continue;
      }

      const list = Array.isArray(rows) ? rows : [];
      layerCounts[name] = list.length;
      for (const row of list) {
        const source = resolveSource(SOURCE_LAYERS[name].table, row);
        if (!source) {
          invalid += 1;
          continue;
        }
        hits.push({ ...source, distance: distanceOf(row) });
      }
    }

    return { hits, layerCounts, failures, invalid, registered };
  }

  // 逐条回 SQLite。单条读不出来只跳过这一条：一条坏数据不能让整页搜索失败。
  _hydrate(hits) {
    const items = [];
    let missing = 0;
    let invalid = 0;

    for (const hit of hits) {
      let memory;
      try {
        memory = this._read(hit);
      } catch (error) {
        invalid += 1;
        this.log?.record(EVENTS.MEMORY_SEARCH_ERROR, {
          errorCode: error?.code ?? ERROR_CODES.UNKNOWN,
          message: `记忆搜索跳过无法解析的 ${hit.sourceType} 记录 ${hit.sourceId}：${error?.message ?? error}`,
        });
        continue;
      }

      // source_id 在 SQLite 里已经不存在（记录被删、向量还没清）：跳过并计数。
      if (!memory) {
        missing += 1;
        continue;
      }

      items.push({
        key: `${hit.sourceType}:${hit.sourceId}`,
        sourceType: hit.sourceType,
        sourceLabel: hit.sourceLabel,
        sourceId: hit.sourceId,
        distance: hit.distance,
        ...memory,
      });
    }

    return { items, missing, invalid };
  }

  // 按来源类型选对应的现有 Repository 回查，并整形成界面直接可画的一条结果。
  _read({ sourceType, sourceId }) {
    if (sourceType === 'activity') {
      const record = this.activities?.getById?.(sourceId) ?? null;
      if (!record) return null;
      const analysis = record.analysis ?? null;
      return {
        time: record.time ?? null,
        day: dayOf(record.time),
        endTime: null,
        // Timeline 的卡片 id 是 screenshot_id，不是向量行的 source_id。
        timelineId: record.id ?? null,
        title: analysis?.activity ?? '',
        content: analysis?.summary ?? record.summary ?? '',
        project: analysis?.project ?? null,
        category: analysis?.category ?? null,
        keywords: toTags(analysis?.keywords),
        keywordsLabel: '关键词',
      };
    }

    if (sourceType === 'block') {
      const block = this.timeBlocks?.getByStart?.(String(sourceId)) ?? null;
      if (!block) return null;
      return {
        time: block.start ?? null,
        day: dayOf(block.start),
        endTime: block.end ?? null,
        timelineId: null,
        title: '',
        content: block.description ?? '',
        project: block.project ?? null,
        category: block.category ?? null,
        keywords: toTags(block.software),
        keywordsLabel: '软件',
      };
    }

    if (sourceType === 'diary') {
      const diary = this.diaries?.getByDay?.(String(sourceId)) ?? null;
      if (!diary) return null;
      return {
        time: diary.day ?? null,
        day: dayOf(diary.day),
        endTime: null,
        timelineId: null,
        title: '',
        content: diary.summary ?? '',
        project: null,
        category: null,
        keywords: toTags(diary.mainEvents),
        keywordsLabel: '主要事项',
      };
    }

    return null;
  }
}

function emptyLayerCounts() {
  const counts = {};
  for (const name of LAYER_NAMES) counts[name] = 0;
  return counts;
}

module.exports = {
  MemorySearchService,
  MemorySearchError,
  resolveSource,
  sourceIdOfRowId,
  SOURCE_LAYERS,
  LAYER_NAMES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
