'use strict';

// Phase 6 第一版正式 Schema。
//
// 约定：已经发布过的 migration 不再修改，后续结构变更一律追加新的 version，
// 靠 PRAGMA user_version 决定从哪一版开始跑（见 migrations.js）。
const SCHEMA_VERSION = 4;

// activities：一张截图一条记录，screenshot_id 是业务主键（截图文件名去掉扩展名）。
// 结构化 AI 结果按字段拆开存，方便后续统计与查询，不把整个 JSON 塞进一个字段。
const ACTIVITIES_TABLE = `
  CREATE TABLE activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      screenshot_id TEXT NOT NULL UNIQUE,
      captured_at TEXT NOT NULL,
      image_path TEXT NOT NULL,
      analysis_status TEXT NOT NULL,
      activity TEXT,
      summary TEXT,
      category TEXT,
      project TEXT,
      keywords_json TEXT,
      confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      model TEXT,
      analysis_ms INTEGER,
      error TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  )
`;

// ai_jobs：队列的持久化。id 是 createJob() 生成的业务 id，activity_id 指回 activities.id。
// 不设 next_attempt_at：重试退避是内存里的 setTimeout，重启后 RETRYING 一律恢复为 PENDING。
const AI_JOBS_TABLE = `
  CREATE TABLE ai_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      activity_id INTEGER,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT,
      last_error TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (activity_id)
          REFERENCES activities(id)
  )
`;

// time_blocks（Phase 8）：一段已结束的 10 分钟区块一条记录，block_start 是业务主键
// （本地 ISO 字符串，与 captured_at 同一格式，字符串比较即时间比较）。
// 汇总结果按字段拆开存，software / todos 是 JSON 文本数组，读取时容错解析。
const TIME_BLOCKS_TABLE = `
  CREATE TABLE time_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_start TEXT NOT NULL UNIQUE,
      block_end TEXT NOT NULL,
      status TEXT NOT NULL,
      activity_count INTEGER NOT NULL DEFAULT 0,
      project TEXT,
      category TEXT,
      description TEXT,
      software_json TEXT,
      todos_json TEXT,
      model TEXT,
      analysis_ms INTEGER,
      error TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  )
`;

// 索引只按真实查询建：最近记录（captured_at）、启动补偿（analysis_status）、
// 队列快照（status）与 Job 关联活动（activity_id）。screenshot_id 的 UNIQUE 自带索引。
const INDEXES = [
  'CREATE INDEX idx_activities_captured_at ON activities(captured_at)',
  'CREATE INDEX idx_activities_analysis_status ON activities(analysis_status)',
  'CREATE INDEX idx_ai_jobs_status ON ai_jobs(status)',
  'CREATE INDEX idx_ai_jobs_activity_id ON ai_jobs(activity_id)',
];

// time_blocks 的两条读路径：按 block_start 范围取（UNIQUE 自带索引）与按状态计数（汇总中标记）。
const TIME_BLOCK_INDEXES = [
  'CREATE INDEX idx_time_blocks_status ON time_blocks(status)',
];

// diaries（Phase 9）：一天的日记一行，day 是业务主键（本地日期 YYYY-MM-DD，
// 与 block_start / captured_at 的前 10 个字符同口径）。
// 日记是「这一天所有 10 分钟区块」的二阶汇总：summary 是简短总结，
// 其余五段（主要事项 / 高光 / 待办 / 优化建议 / 温馨提示）都是字符串数组。
const DIARIES_TABLE = `
  CREATE TABLE diaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      block_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      main_events_json TEXT,
      highlights_json TEXT,
      todos_json TEXT,
      suggestions_json TEXT,
      tips_json TEXT,
      model TEXT,
      analysis_ms INTEGER,
      error TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  )
`;

// diaries 的两条读路径：按 day 范围取（UNIQUE 自带索引）与按状态计数（日记生成中标记）。
const DIARY_INDEXES = [
  'CREATE INDEX idx_diaries_status ON diaries(status)',
];

// Phase 10：三层记忆的 embedding 状态（三张表各加三列，结构一致）。
// embedding_status 就是待办池：PENDING / PROCESSING / COMPLETED / FAILED；
// embedding_model / embedding_version 记录这条向量由哪个模型、哪个版本生成，
// 将来换模型时可以据此识别旧向量（Phase 10 只写入，不做迁移）。
// 状态列带默认值 PENDING，所以老库升级后存量记录会自动进入待嵌入队列。
function embeddingStatements(table) {
  return [
    `ALTER TABLE ${table} ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'PENDING'`,
    `ALTER TABLE ${table} ADD COLUMN embedding_model TEXT`,
    `ALTER TABLE ${table} ADD COLUMN embedding_version TEXT`,
    // 待办扫描按 embedding_status 过滤（activities 一年约 157 万行，必须有索引）。
    `CREATE INDEX idx_${table}_embedding_status ON ${table}(embedding_status)`,
  ];
}

const EMBEDDING_STATEMENTS = ['activities', 'time_blocks', 'diaries'].flatMap(embeddingStatements);

const MIGRATIONS = [
  {
    version: 1,
    statements: [ACTIVITIES_TABLE, AI_JOBS_TABLE, ...INDEXES],
  },
  {
    version: 2,
    statements: [TIME_BLOCKS_TABLE, ...TIME_BLOCK_INDEXES],
  },
  {
    version: 3,
    statements: [DIARIES_TABLE, ...DIARY_INDEXES],
  },
  {
    version: 4,
    statements: EMBEDDING_STATEMENTS,
  },
];

module.exports = { SCHEMA_VERSION, MIGRATIONS, DIARIES_TABLE, DIARY_INDEXES, EMBEDDING_STATEMENTS };
