/**
 * VectorStore: SQLite-based vector storage using sqlite-vec extension.
 *
 * Manages two layers of vector-indexed data in a single SQLite database:
 *
 * **L1 (structured memories):**
 * 1. `l1_records` — relational metadata table (content, type, priority, scene, timestamps)
 * 2. `l1_vec` — vec0 virtual table for cosine similarity search
 *
 * **L0 (raw conversations):**
 * 3. `l0_conversations` — relational metadata table (session_key, role, message text, timestamps)
 * 4. `l0_vec` — vec0 virtual table for cosine similarity search on individual messages
 *
 * Dependencies: Node.js built-in `node:sqlite` (Node 22+) + `sqlite-vec` (from root workspace).
 *
 * Design:
 * - All operations are synchronous (DatabaseSync API).
 * - Writes use manual BEGIN/COMMIT transactions for atomicity (metadata + vector).
 * - vec0 virtual table does NOT support ON CONFLICT, so upsert = delete + insert.
 * - Thread-safe via WAL mode.
 * 中文：VectorStore: 使用 sqlite-vec 扩展的基于 SQLite 的向量存储。
 * 在一个单个的 SQLite 数据库中管理两层向量索引数据：
 * **L1（结构化记忆）：**
 * 1. `l1_records` — 关系元数据表（内容、类型、优先级、场景、时间戳）
 * 2. `l1_vec` — 用于余弦相似度搜索的 vec0 虚拟表
 * **L0（原始对话）：**
 * 3. `l0_conversations` — 关系元数据表（会话键、角色、消息文本、时间戳）
 * 4. `l0_vec` — 用于个体消息余弦相似度搜索的 vec0 虚拟表
 * 依赖项: Node.js 内置 `node:sqlite` (Node 22+) + `sqlite-vec`（来自根工作区）。
 * 设计：
 * - 所有操作均为同步（DatabaseSync API）。
 * - 写入使用手动 BEGIN/COMMIT 事务以确保原子性（元数据 + 向量）。
 * - vec0 虚拟表不支持 ON CONFLICT，因此 upsert = 删除 + 插入。
 * - 通过 WAL 模式实现线程安全。
 */

import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type {
  IMemoryStore,
  StoreCapabilities,
  L0Record,
  L1SearchResult,
  L1FtsResult,
  L0SearchResult,
  L0FtsResult,
} from "./types.js";
import type { Logger } from "../types.js";

// ============================
// Types
// ============================

export interface VectorSearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** Cosine similarity score (1.0 - cosine_distance) */
  /** 中文：余弦相似度分数 (1.0 - cosine_distance) */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  /** Raw metadata JSON string (e.g., contains activity_start_time / activity_end_time for episodic) */
  /** 中文：原始元数据 JSON 字符串（例如包含活动开始时间 / 结束时间以供情景记忆使用） */
  metadata_json: string;
}

/** L0 single-message vector search result. */
/** 中文：L0 单条消息向量搜索结果。 */
export interface L0VectorSearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** Cosine similarity score (1.0 - cosine_distance) */
  /** 中文：余弦相似度分数 (1.0 - cosine_distance) */
  score: number;
  recorded_at: string;
  /** Original message timestamp (epoch ms) */
  /** 中文：原始消息时间戳（毫秒级时间戳） */
  timestamp: number;
}

/** Raw row returned by L1 record queries (column names match SQLite schema). */
/** 中文：从 SQLite 查询 L1 记录时返回的原始行（列名与 SQLite 架构匹配）。 */
export interface L1RecordRow {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  session_id: string;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  created_time: string;
  updated_time: string;
  metadata_json: string;
}

export interface L0RecordRow {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
}

/** Filter options for querying L1 records from SQLite. */
/** 中文：查询 SQLite 中 L1 记录的过滤选项。 */
export interface L1QueryFilter {
  /** If provided, only return records for this session key (conversation channel). */
  /** 中文：如果提供，仅返回此会话键（对话频道）的记录。 */
  sessionKey?: string;
  /** If provided, only return records for this session ID (single conversation instance). */
  /** 中文：如果提供，仅返回此会话ID（单次对话实例）的记录。 */
  sessionId?: string;
  /** If provided, only return records with updated_time strictly after this ISO 8601 UTC timestamp. */
  /** 中文：如果提供，仅返回更新时间严格晚于该ISO 8601 UTC时间戳的记录。 */
  updatedAfter?: string;
}

const TAG = "[memory-tdai][sqlite]";

/** Persisted metadata about the embedding provider used to generate stored vectors. */
/** 中文：关于生成存储向量所使用的嵌入提供商的持久化元数据。 */
interface EmbeddingMeta {
  provider: string;
  model: string;
  dimensions: number;
}

/** Result of VectorStore.init() — indicates whether a re-embed is needed. */
/** 中文：VectorStore.init()的结果——表示是否需要重新嵌入。 */
export interface VectorStoreInitResult {
  /**
   * `true` if the embedding provider/model/dimensions changed since
   * the vectors were last written.  Callers should re-embed all texts
   * (via `reindexAll()`) after receiving this flag.
   * 中文：自向量上次写入以来，嵌入提供商/模型/维度发生变化，则为true。调用者应在接收到此标志后通过`reindexAll()`重新嵌入所有文本。
   */
  needsReindex: boolean;
  /** Human-readable reason (for logging). */
  /** 中文：供日志记录的人类可读的原因。 */
  reason?: string;
}

// Use createRequire to load the experimental node:sqlite module
// 中文：使用createRequire加载实验性的node:sqlite模块
const require = createRequire(import.meta.url);

function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

// ============================
// FTS5 helpers (adapted from openclaw core hybrid.ts)
// ============================
// 中文：FTS5 工具函数（源自 openclaw 核心 hybrid.ts）

// ── Chinese word segmentation (jieba) ──
// Lazy-loaded singleton: initialised on first call to `buildFtsQuery`.
// If @node-rs/jieba is unavailable, falls back to Unicode-regex splitting.
// 中文：── 中文分词（jieba） ──
// 首次调用 `buildFtsQuery` 时延迟加载单例：初始化。

interface JiebaInstance {
  cutForSearch(text: string, hmm: boolean): string[];
}

let _jieba: JiebaInstance | null | undefined; // undefined = not yet tried
// 中文：undefined = 不确定

function getJieba(): JiebaInstance | null {
  if (_jieba !== undefined) return _jieba;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // 中文：eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Jieba } = require("@node-rs/jieba");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // 中文：eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dict } = require("@node-rs/jieba/dict");
    _jieba = Jieba.withDict(dict) as JiebaInstance;
  } catch {
    _jieba = null; // mark as unavailable — won't retry
    // 中文：标记为不可用 — 不会重试
  }
  return _jieba;
}

/**
 * Common Chinese stop-words that add noise to FTS5 queries.
 * Kept small on purpose — only high-frequency function words.
 * 中文：常见的中文停用词，会在FTS5查询中增加噪声。保持较小的规模 — 只包含高频功能词
 */
const ZH_STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那",
  "吗", "吧", "呢", "啊", "呀", "哦", "嗯",
]);

/**
 * Build an FTS5 MATCH query from raw text.
 *
 * When `@node-rs/jieba` is available, uses jieba's search-engine mode
 * (`cutForSearch`) for accurate Chinese word segmentation, producing
 * much better recall than the previous regex-only approach.
 *
 * Falls back to Unicode-regex splitting (`/[\p{L}\p{N}_]+/gu`) if
 * jieba is not installed.
 *
 * Tokens are OR-joined as quoted FTS5 phrase terms so that a document
 * matching *any* token is returned.  BM25 naturally ranks documents that
 * match more tokens higher, so precision is preserved while recall is
 * significantly improved — especially for longer queries and when running
 * in FTS-only fallback mode (no embedding available).
 *
 * Example (with jieba):
 *   "用户喜欢编程和TypeScript" → '"用户" OR "喜欢" OR "编程" OR "TypeScript"'
 * Example (fallback):
 *   "旅行计划 API" → '"旅行计划" OR "API"'
 */
export function buildFtsQuery(raw: string): string | null {
  const jieba = getJieba();

  let tokens: string[];
  if (jieba) {
    // jieba cutForSearch: splits long words further for better recall
    // e.g. "北京烤鸭" → ["北京", "烤鸭", "北京烤鸭"]
    tokens = jieba
      .cutForSearch(raw, true)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        // Remove pure whitespace / punctuation tokens
        // 中文：移除纯空白字符 / 标点符号 token
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        // Remove common Chinese stop-words to reduce noise
        // 中文：移除常用中文停用词以减少噪声
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
    // Deduplicate (cutForSearch may produce duplicates for sub-words)
    // 中文：去重（cutForSearch 可能会为子词生成重复项）
    tokens = [...new Set(tokens)];
  } else {
    // Fallback: simple Unicode regex split
    // 中文：备选方案：简单的 Unicode 正则表达式分割
    tokens =
      raw
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? [];
  }

  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

/**
 * Tokenize text for FTS5 indexing (write-side).
 *
 * Uses jieba `cutForSearch()` (search-engine mode) to segment Chinese text,
 * then joins tokens with spaces. The resulting string is stored in the FTS5
 * `content` column so that `unicode61` tokenizer can split it into meaningful
 * words — including both full words and their sub-words.
 *
 * Using `cutForSearch` (instead of `cut`) ensures that the index contains
 * the same sub-word tokens that `buildFtsQuery()` produces on the query side.
 * For example, "人工智能" is indexed as "人工 智能 人工智能", so queries for
 * either the full term or sub-words will match.
 *
 * Falls back to the original text if jieba is unavailable.
 *
 * Example (with jieba):
 *   "用户五月去日本旅行" → "用户 五月 去 日本 旅行"
 *   "人工智能的分支"     → "人工 智能 人工智能 的 分支"
 * Example (fallback):
 *   "用户五月去日本旅行" → "用户五月去日本旅行" (unchanged)
 */
export function tokenizeForFts(raw: string): string {
  const jieba = getJieba();
  if (!jieba) return raw;

  // Use `cutForSearch` (search-engine mode) for indexing — it produces both
  // full words AND their sub-word components. This ensures that query-side
  // tokens (also produced by `cutForSearch` in `buildFtsQuery`) will always
  // find a match in the index.
  // 中文：使用 `cutForSearch`（搜索引擎模式）进行索引——它既产生完整的单词又产生其子词组件。这确保了查询侧的标记（也在 `buildFtsQuery` 中由 `cutForSearch` 生成）总能在索引中找到匹配项。
  const tokens = jieba.cutForSearch(raw, true);

  // Join with spaces so `unicode61` tokenizer can split them.
  // Punctuation tokens are kept — unicode61 treats them as separators anyway.
  // 中文：用空格连接以便 `unicode61` 分词器可以将其拆分。标点符号标记保留——unicode61 将其视为分隔符。
  return tokens.join(" ");
}

/**
 * Reset jieba state so next call to `buildFtsQuery` re-initialises.
 * Exported for testing only.
 * @internal
 * 中文：重置 jieba 状态，以便下次调用 `buildFtsQuery` 时重新初始化。仅用于测试。@internal
 */
export function _resetJiebaForTest(): void {
  _jieba = undefined;
}

/**
 * Override jieba instance (or set to `null` to force fallback).
 * Exported for testing only.
 * @internal
 * 中文：覆盖 jieba 实例（或设置为 `null` 强制回退）。仅用于测试。@internal
 */
export function _setJiebaForTest(instance: JiebaInstance | null): void {
  _jieba = instance;
}

/**
 * Convert a BM25 rank (negative = more relevant) to a 0–1 score.
 * Mirrors the formula in openclaw core `hybrid.ts`.
 * 中文：将 BM25 排名（负数表示更相关）转换为 0–1 分数。与 openclaw 核心 `hybrid.ts` 中的公式一致。
 */
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

/** FTS5 search result for L1 records. */
/** 中文：fts5 搜索结果，针对 L1 记录。 */
export interface FtsSearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25-derived score (0–1, higher is better) */
  /** 中文：由 BM25 得出的分数（0–1，数值越大越好） */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
}

/** FTS5 search result for L0 records. */
/** 中文：fts5 搜索结果，针对 L0 记录。 */
export interface L0FtsSearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** BM25-derived score (0–1, higher is better) */
  /** 中文：BM25-derived分数（0–1，数值越大越好） */
  score: number;
  recorded_at: string;
  timestamp: number;
}

// ============================
// VectorStore class
// ============================
// 中文：VectorStore类

export class VectorStore implements IMemoryStore {
  private db: DatabaseSync;
  private readonly dimensions: number;
  private readonly logger?: Logger;

  /** @see IMemoryStore.supportsDeferredEmbedding */
  /** 中文：@see IMemoryStore.supportsDeferredEmbedding */
  readonly supportsDeferredEmbedding = true;

  /**
   * When `true`, the store is in a degraded state (e.g. sqlite-vec failed to
   * load, or init() encountered an unrecoverable error).  All public methods
   * become safe no-ops so the plugin never blocks the main OpenClaw flow.
   * 中文：当为true时，存储处于降级状态（例如sqlite-vec加载失败，或init()遇到不可恢复错误）。所有公共方法变为安全的空操作，插件永远不会阻塞主OpenClaw流程。
   */
  private degraded = false;

  /** Tracks whether close() has been called to prevent double-close errors. */
  /** 中文：跟踪是否已调用close()以防止重复关闭错误。 */
  private closed = false;

  /**
   * `true` when vec0 virtual tables (l1_vec / l0_vec) have been created and
   * their prepared statements are ready.  When `dimensions === 0` (i.e.
   * provider="none"), vec0 tables are deferred and this stays `false`.
   * 中文：当vec0虚拟表（l1_vec / l0_vec）创建并准备好其预处理语句时为true。当dimensions === 0（即provider="none"）时，vec0表被延迟且此值保持为false。
   */
  private vecTablesReady = false;

  // Prepared statements — L1 (initialized in init())
  // 中文：预处理语句 — L1（在init()中初始化）
  private stmtUpsertMeta!: StatementSync;
  private stmtDeleteVec?: StatementSync;   // optional — only set when vecTablesReady
  // 中文：可选 — 仅在vecTablesReady时设置
  private stmtInsertVec?: StatementSync;   // optional — only set when vecTablesReady
  // 中文：可选 — 仅在vecTablesReady时设置
  private stmtDeleteMeta!: StatementSync;
  private stmtGetMeta!: StatementSync;
  private stmtSearchVec?: StatementSync;   // optional — only set when vecTablesReady
  // 中文：可选 — 仅在vecTablesReady时设置
  private stmtQueryBySessionId!: StatementSync;
  private stmtQueryBySessionIdSince!: StatementSync;
  private stmtQueryBySessionKey!: StatementSync;
  private stmtQueryBySessionKeySince!: StatementSync;
  private stmtQueryAll!: StatementSync;
  private stmtQueryAllSince!: StatementSync;

  // Prepared statements — L0 (initialized in init())
  // 中文：预处理语句 — L0（在init()中初始化）
  private stmtL0UpsertMeta!: StatementSync;
  private stmtL0DeleteVec?: StatementSync;   // optional — only set when vecTablesReady
  // 中文：可选 — 仅在vecTablesReady时设置
  private stmtL0InsertVec?: StatementSync;   // optional — only set when vecTablesReady
  // 中文：可选 — 仅在vecTablesReady时设置
  private stmtL0DeleteMeta!: StatementSync;
  private stmtL0GetMeta!: StatementSync;
  private stmtL0SearchVec?: StatementSync;   // optional — only set when vecTablesReady
  // 中文：可选——仅在vecTablesReady时设置
  /** L0 query for L1 runner: all messages for a session key */
  /** 中文：L0查询用于L1运行器：会话键的所有消息 */
  private stmtL0QueryAll!: StatementSync;
  /** L0 query for L1 runner: messages after a timestamp cursor */
  /** 中文：L0查询用于L1运行器：时间戳游标的后续消息 */
  private stmtL0QueryAfter!: StatementSync;
  /** L1 cursor-based pagination for migration (by PK) */
  /** 中文：迁移（按主键）基于游标分页L1 */
  private stmtL1QueryMigrationCursor!: StatementSync;
  /** L0 cursor-based pagination for migration (by PK) */
  /** 中文：迁移（按主键）基于游标分页L0 */
  private stmtL0QueryMigrationCursor!: StatementSync;

  // FTS5 tables availability flag (created best-effort — may be false if fts5 is not compiled in)
  // 中文：FTS5表可用性标志（尽力而为创建——如果未编译fts5，则可能为false）
  private ftsAvailable = false;

  // Prepared statements — FTS5 L1 (initialized in init())
  // 中文：预编译语句 — FTS5 L1（在init()中初始化）
  private stmtL1FtsInsert!: StatementSync;
  private stmtL1FtsDelete!: StatementSync;
  private stmtL1FtsSearch!: StatementSync;

  // Prepared statements — FTS5 L0 (initialized in init())
  // 中文：预编译语句 — FTS5 L0（在init()中初始化）
  private stmtL0FtsInsert!: StatementSync;
  private stmtL0FtsDelete!: StatementSync;
  private stmtL0FtsSearch!: StatementSync;

  /**
   * Create a VectorStore instance.
   *
   * Note: After construction, you MUST call `init()` to load the sqlite-vec
   * extension and create the schema.
   * 中文：创建一个VectorStore实例。
   * 注意：构造后，你必须调用`init()`来加载sqlite-vec
   * 扩展并创建模式。
   */
  constructor(dbPath: string, dimensions: number, logger?: Logger) {
    this.dimensions = dimensions;
    this.logger = logger;

    // Open database with extension support enabled
    // 中文：启用扩展支持打开数据库
    const { DatabaseSync: DbSync } = requireNodeSqlite();
    this.db = new DbSync(dbPath, { allowExtension: true });

    // Set busy timeout so concurrent processes retry instead of failing with SQLITE_BUSY
    // 中文：设置忙超时以便并发进程重试而不是因 SQLITE_BUSY 失败
    this.db.exec("PRAGMA busy_timeout = 5000");

    // Enable WAL mode for better concurrent read performance
    // 中文：启用 WAL 模式以提高并发读取性能
    this.db.exec("PRAGMA journal_mode = WAL");

    // Cap page cache at 64 MB
    // 中文：将页面缓存限制在 64 MB
    this.db.exec("PRAGMA cache_size = -65536");

    // Cap memory-mapped I/O at 128 MB to bound RSS growth
    // 中文：将内存映射 I/O 限制在 128 MB 以限制 RSS 增长
    this.db.exec("PRAGMA mmap_size = 134217728");

    // Auto-checkpoint WAL every 1000 pages (~4 MB) to keep WAL file compact
    // 中文：自动每 1000 页（约 4 MB）检查点 WAL 以保持 WAL 文件紧凑
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
  }

  /**
   * Whether the store is in degraded mode (e.g. sqlite-vec failed to load).
   * When degraded, all write/search operations become safe no-ops.
   * 中文：存储是否处于降级模式（例如，sqlite-vec 扩展未能加载）。
   * 当处于降级模式时，所有写入/搜索操作都成为安全的空操作。
   */
  isDegraded(): boolean {
    return this.degraded;
  }


  /**
   * Load sqlite-vec extension and initialize database schema.
   * Must be called once after construction.
   *
   * @param providerInfo  Current embedding provider info. When provided,
   *   the store compares it against the persisted metadata. If the provider,
   *   model, or dimensions changed, the vector tables are dropped and
   *   re-created with the new dimensions, and `needsReindex: true` is returned
   *   so the caller can schedule a full re-embed.
   * 中文：加载 sqlite-vec 扩展并初始化数据库模式。
   * 必须在构造之后调用一次。
   * @param providerInfo 当前嵌入提供者信息。如果提供了该参数，
   * 存储会将其与持久化元数据进行比较。如果提供者、模型或维度发生变化，
   * 向量表将被删除并重新创建新的维度，并返回 `needsReindex: true` 以通知调用方需要安排一次全面重嵌入。
   */
  init(providerInfo?: EmbeddingProviderInfo): VectorStoreInitResult {
    // Load sqlite-vec extension (same approach as root project's sqlite-vec.ts)
    // 中文：加载 sqlite-vec 扩展（与根项目的 sqlite-vec.ts 中的方法相同）
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      // 中文：eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require("sqlite-vec");
      this.db.enableLoadExtension(true);
      sqliteVec.load(this.db);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(
        `${TAG} Failed to load sqlite-vec extension: ${message}. ` +
        `VectorStore entering degraded mode — all operations will be no-ops.`,
      );
      this.degraded = true;
      return { needsReindex: false, reason: `sqlite-vec load failed: ${message}` };
    }

    // ── Schema creation & prepared statements ──────────────────────────────
    // Wrapped in try-catch: if anything fails during schema init (e.g. the DB
    // is corrupted, disk full, etc.), we degrade gracefully instead of crashing.
    // 中文：── 模式创建及预处理语句 ──────────────────────────────
    // 包含 try-catch：如果在模式初始化过程中发生任何错误（例如数据库损坏、磁盘空间不足等），我们将优雅降级而不是崩溃。
    try {
      return this.initSchema(providerInfo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(
        `${TAG} Schema initialization failed: ${message}. ` +
        `VectorStore entering degraded mode.`,
      );
      this.degraded = true;
      return { needsReindex: false, reason: `schema init failed: ${message}` };
    }
  }

  /**
   * Internal schema initialization — separated from init() so we can
   * catch errors at the top level and degrade gracefully.
   * 中文：内部模式初始化 — 与 init() 分开，以便我们在顶层捕获错误并优雅降级。
   */
  private initSchema(providerInfo?: EmbeddingProviderInfo): VectorStoreInitResult {
    // Tracks which provider/model/dimensions were used to generate vectors.
    // 中文：跟踪用于生成向量的提供者/模型/维度。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Detect whether re-index is needed
    // 中文：检测是否需要重新索引
    let needsReindex = false;
    let reindexReason: string | undefined;

    const savedMeta = this.readEmbeddingMeta();

    if (providerInfo) {
      if (savedMeta) {
        const providerChanged = savedMeta.provider !== providerInfo.provider;
        const modelChanged = savedMeta.model !== providerInfo.model;
        const dimsChanged = savedMeta.dimensions !== this.dimensions;

        if (providerChanged || modelChanged || dimsChanged) {
          const reasons: string[] = [];
          if (providerChanged) reasons.push(`provider: ${savedMeta.provider} → ${providerInfo.provider}`);
          if (modelChanged) reasons.push(`model: ${savedMeta.model} → ${providerInfo.model}`);
          if (dimsChanged) reasons.push(`dimensions: ${savedMeta.dimensions} → ${this.dimensions}`);
          reindexReason = reasons.join(", ");

          this.logger?.info(
            `${TAG} Embedding config changed (${reindexReason}). ` +
            `Dropping vector tables for rebuild...`,
          );

          // Drop and re-create vector tables with new dimensions
          // 中文：删除并使用新维度重新创建向量表
          this.dropVectorTables();
          needsReindex = true;
        }
      } else {
        // No saved meta — first run or legacy DB without meta table.
        // Two cases require dropping vector tables:
        // 1. Existing data created without meta tracking (legacy DB) — need re-embed
        // 2. vec0 tables exist with wrong dimensions (e.g. previously created with
        //    provider="none" placeholder 768D, now switching to a real provider
        //    with different dimensions) — must rebuild even if data tables are empty
        // 中文：无保存元数据 — 首次运行或没有元数据表的老版数据库。
        // 两种情况需要删除向量表：
        // 1. 存在未跟踪元数据的现有数据（老版数据库）—— 需要重新嵌入
        // 2. vec0 表存在且维度错误（例如之前使用 provider="none" 占位符 768D 创建，现在切换到具有不同维度的真实提供者）—— 即使数据表为空也必须重建
        const l1Count = this.tableRowCount("l1_records");
        const l0Count = this.tableRowCount("l0_conversations");
        const existingVecDims = this.getVecTableDimensions();

        if (l1Count > 0 || l0Count > 0) {
          this.logger?.info(
            `${TAG} No embedding_meta found but existing data exists ` +
            `(L1=${l1Count}, L0=${l0Count}). Dropping vector tables for safety...`,
          );
          this.dropVectorTables();
          needsReindex = true;
          reindexReason = "legacy DB without embedding_meta — cannot verify vector compatibility";
        } else if (existingVecDims !== null && existingVecDims !== this.dimensions) {
          // vec0 tables exist (from a previous provider="none" placeholder or
          // different config) but with mismatched dimensions.  Drop them so they
          // get re-created with the correct dimensions below.
          // 中文：vec0 表存在（来自之前provider="none"占位符或不同配置），但维度不匹配。请删除它们以便在下面使用正确的维度重新创建.
          this.logger?.info(
            `${TAG} vec0 table dimension mismatch (existing=${existingVecDims}, ` +
            `required=${this.dimensions}). Dropping vector tables for rebuild...`,
          );
          this.dropVectorTables();
          // No needsReindex — there's no data to re-embed
          // 中文：No needsReindex — 没有需要重新索引的数据
        }
      }
    }

    // ── L1 schema ──────────────────────────────────
    // 中文：── L1 架构 ──────────────────────────────────

    // Metadata table
    // 中文：元数据表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        session_key TEXT DEFAULT '',
        session_id TEXT DEFAULT '',
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      )
    `);

    // Indexes for common queries
    // 中文：常用查询的索引
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_type ON l1_records(type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_key ON l1_records(session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_id ON l1_records(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_scene ON l1_records(scene_name)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_ts_start ON l1_records(timestamp_start)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_ts_end ON l1_records(timestamp_end)");
    // Composite index: session_id exact match + updated_time range scan (for incremental L2 queries)
    // 中文：复合索引：session_id 精确匹配 + updated_time 范围扫描（用于增量L2查询）
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_session_updated ON l1_records(session_id, updated_time)");
    // Composite index: session_key exact match + updated_time range scan (for pipeline cursor queries)
    // 中文：复合索引：session_key 精确匹配 + updated_time 范围扫描（用于管道游标查询）
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_sessionkey_updated ON l1_records(session_key, updated_time)");

    // Vector virtual table (cosine distance) — only created when dimensions > 0.
    // When provider="none", dimensions=0 and vec0 tables are deferred until a
    // real embedding provider is configured.
    // 中文：向量虚拟表（余弦距离）——仅在维度 > 0 时创建。当provider="none"时，dimensions=0且vec0 表延迟到实际嵌入提供程序配置后才创建。
    if (this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          updated_time TEXT DEFAULT ''
        )
      `);
    }

    // Prepare statements for reuse
    // 中文：准备重用语句
    this.stmtUpsertMeta = this.db.prepare(`
      INSERT INTO l1_records (
        record_id, content, type, priority, scene_name, session_key, session_id,
        timestamp_str, timestamp_start, timestamp_end,
        created_time, updated_time, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content=excluded.content,
        type=excluded.type,
        priority=excluded.priority,
        scene_name=excluded.scene_name,
        timestamp_str=excluded.timestamp_str,
        timestamp_start=excluded.timestamp_start,
        timestamp_end=excluded.timestamp_end,
        updated_time=excluded.updated_time,
        metadata_json=excluded.metadata_json
    `);

    if (this.dimensions > 0) {
      this.stmtDeleteVec = this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?");
      this.stmtInsertVec = this.db.prepare("INSERT INTO l1_vec (record_id, embedding, updated_time) VALUES (?, ?, ?)");
    }
    this.stmtDeleteMeta = this.db.prepare("DELETE FROM l1_records WHERE record_id = ?");

    this.stmtGetMeta = this.db.prepare(`
      SELECT content, type, priority, scene_name, session_key, session_id,
             timestamp_str, timestamp_start, timestamp_end, metadata_json
      FROM l1_records WHERE record_id = ?
    `);

    if (this.dimensions > 0) {
      this.stmtSearchVec = this.db.prepare(`
        SELECT record_id, distance
        FROM l1_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    }

    // ── L0 schema ──────────────────────────────────
    // 中文：── L0模式─────────────────────────────────

    // L0 metadata table: stores individual messages for vector search
    // 中文：L0元数据表：存储用于向量搜索的单个消息
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      )
    `);

    // Migration: add timestamp column if missing (existing DBs pre-v3.x)
    // 中文：迁移：如果缺少（现有数据库预v3.x），添加时间戳列
    try {
      this.db.exec("ALTER TABLE l0_conversations ADD COLUMN timestamp INTEGER DEFAULT 0");
      this.logger?.debug?.(`${TAG} Migrated l0_conversations: added timestamp column`);
    } catch {
      // Column already exists — expected on non-first run
      // 中文：列已存在——非首次运行时预期
    }

    // Indexes for L0 queries
    // 中文：L0查询索引
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_session ON l0_conversations(session_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_session_id ON l0_conversations(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_recorded ON l0_conversations(recorded_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_conversations(timestamp)");

    // L0 vector virtual table (cosine distance, same dimensions as L1) — deferred when dimensions=0
    // 中文：L0向量虚拟表（余弦距离，维度与L1相同）——当维度为0时延迟创建
    if (this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          recorded_at TEXT DEFAULT ''
        )
      `);
    }

    // L0 prepared statements
    // 中文：L0准备语句
    this.stmtL0UpsertMeta = this.db.prepare(`
      INSERT INTO l0_conversations (
        record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        message_text=excluded.message_text,
        recorded_at=excluded.recorded_at,
        timestamp=excluded.timestamp
    `);

    if (this.dimensions > 0) {
      this.stmtL0DeleteVec = this.db.prepare("DELETE FROM l0_vec WHERE record_id = ?");
      this.stmtL0InsertVec = this.db.prepare("INSERT INTO l0_vec (record_id, embedding, recorded_at) VALUES (?, ?, ?)");
    }
    this.stmtL0DeleteMeta = this.db.prepare("DELETE FROM l0_conversations WHERE record_id = ?");

    this.stmtL0GetMeta = this.db.prepare(`
      SELECT session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations WHERE record_id = ?
    `);

    if (this.dimensions > 0) {
      this.stmtL0SearchVec = this.db.prepare(`
        SELECT record_id, distance
        FROM l0_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    }

    // L0 query statements for L1 runner (newest-first + LIMIT to bound memory)
    // Sort/filter by recorded_at (write time) instead of timestamp (conversation time)
    // because L1 cursor uses recorded_at semantics. ISO 8601 string comparison preserves time order.
    // 中文：L0 查询语句用于 L1 运行器（按最新时间排序 + LIMIT 以限制内存使用）
    // 根据 recorded_at（记录时间）进行排序/过滤，而不是 timestamp（会话时间），因为 L1 游标使用 recorded_at 的语义。ISO 8601 字符串比较可以保持时间顺序。
    this.stmtL0QueryAll = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE session_key = ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `);

    this.stmtL0QueryAfter = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE session_key = ? AND recorded_at > ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `);

    this.stmtL0QueryMigrationCursor = this.db.prepare(`
      SELECT record_id, session_key, session_id, role, message_text, recorded_at, timestamp
      FROM l0_conversations
      WHERE record_id > ?
      ORDER BY record_id ASC
      LIMIT ?
    `);

    // ── FTS5 tables (best-effort — gracefully degrade if fts5 is not compiled in) ──
    // Schema v2: `content` column stores jieba-segmented text (for indexing),
    // `content_original` (UNINDEXED) stores the raw text (for display).
    // If old v1 tables exist (no content_original column), drop + recreate.
    // 中文：── FTS5 表格（尽力而为 —— 如果未编译 fts5 则优雅降级） ──
    // Schema v2: `content` 列存储jieba分词后的文本（用于索引），
    // `content_original`（不索引）存储原始文本（用于显示）。
    // 如果存在旧的 v1 表格（没有 content_original 列），则删除并重新创建。
    try {
      // ── Migrate old FTS5 tables (v1 → v2) ──
      // v1 tables stored raw text in the `content` column. v2 stores segmented
      // text in `content` and raw text in `content_original` / `message_text_original`.
      // FTS5 virtual tables don't support ALTER TABLE ADD COLUMN, so we must
      // drop and recreate. The data will be repopulated by `rebuildFtsIndex()`.
      // 中文：── 迁移旧的 FTS5 表格（v1 → v2） ──
      // v1 表格在 `content` 列中存储原始文本。v2 在 `content` 中存储分词后的文本，在 `content_original` / `message_text_original` 中存储原始文本。
      // 由于 FTS5 虚拟表不支持 ALTER TABLE ADD COLUMN，因此我们必须删除并重新创建。数据将由 `rebuildFtsIndex()` 重新填充。
      const needsFtsRebuild = this.migrateFtsTablesIfNeeded();

      // L1 FTS5 virtual table (v2 schema)
      // 中文：L1 FTS5 虚拟表格（v2 架构）
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
          content,
          content_original UNINDEXED,
          record_id UNINDEXED,
          type UNINDEXED,
          priority UNINDEXED,
          scene_name UNINDEXED,
          session_key UNINDEXED,
          session_id UNINDEXED,
          timestamp_str UNINDEXED,
          timestamp_start UNINDEXED,
          timestamp_end UNINDEXED,
          metadata_json UNINDEXED
        )
      `);

      // L0 FTS5 virtual table (v2 schema)
      // 中文：L0 FTS5 虚拟表格（v2 架构）
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(
          message_text,
          message_text_original UNINDEXED,
          record_id UNINDEXED,
          session_key UNINDEXED,
          session_id UNINDEXED,
          role UNINDEXED,
          recorded_at UNINDEXED,
          timestamp UNINDEXED
        )
      `);

      // L1 FTS prepared statements
      // 中文：L1 FTS 准备语句
      this.stmtL1FtsInsert = this.db.prepare(`
        INSERT INTO l1_fts (content, content_original, record_id, type, priority, scene_name,
          session_key, session_id, timestamp_str, timestamp_start, timestamp_end, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.stmtL1FtsDelete = this.db.prepare("DELETE FROM l1_fts WHERE record_id = ?");

      this.stmtL1FtsSearch = this.db.prepare(`
        SELECT record_id, content_original AS content, type, priority, scene_name,
               session_key, session_id, timestamp_str, timestamp_start, timestamp_end,
               metadata_json,
               bm25(l1_fts) AS rank
        FROM l1_fts
        WHERE l1_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);

      // L0 FTS prepared statements
      // 中文：L0 FTS 准备语句
      this.stmtL0FtsInsert = this.db.prepare(`
        INSERT INTO l0_fts (message_text, message_text_original, record_id, session_key, session_id, role, recorded_at, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.stmtL0FtsDelete = this.db.prepare("DELETE FROM l0_fts WHERE record_id = ?");

      this.stmtL0FtsSearch = this.db.prepare(`
        SELECT record_id, message_text_original AS message_text, session_key, session_id, role, recorded_at, timestamp,
               bm25(l0_fts) AS rank
        FROM l0_fts
        WHERE l0_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);

      this.ftsAvailable = true;
      this.logger?.debug?.(`${TAG} FTS5 tables initialized (l1_fts, l0_fts) [schema v2 — jieba segmented]`);

      // Rebuild FTS index if migrated from v1 or tables were freshly created
      // 中文：如果从 v1 迁移或表是新创建的，则重建 FTS 索引
      if (needsFtsRebuild) {
        this.rebuildFtsIndex();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ftsAvailable = false;
      this.logger?.warn(
        `${TAG} FTS5 tables NOT available (fts5 may not be compiled in): ${message}. ` +
        `FTS-based keyword search will be unavailable; recall will use in-memory scoring if needed.`,
      );
    }

    // Save current embedding meta (write after schema is ready)
    // 中文：保存当前嵌入元数据（在模式准备好后再写入)
    if (providerInfo) {
      this.writeEmbeddingMeta({
        provider: providerInfo.provider,
        model: providerInfo.model,
        dimensions: this.dimensions,
      });
    }

    // Mark vec0 tables as ready only when they were actually created
    // 中文：只有当vec0表实际创建时才标记其为就绪
    this.vecTablesReady = this.dimensions > 0;
    // L1 query statements (for l1-reader)
    // 中文：L1查询语句（用于l1-reader）
    const l1QueryCols = `record_id, content, type, priority, scene_name, session_key, session_id,
      timestamp_str, timestamp_start, timestamp_end,
      created_time, updated_time, metadata_json`;

    this.stmtQueryBySessionId = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_id = ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionIdSince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_id = ? AND updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionKey = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_key = ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryBySessionKeySince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE session_key = ? AND updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtQueryAll = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      ORDER BY updated_time ASC
    `);

    this.stmtQueryAllSince = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE updated_time > ?
      ORDER BY updated_time ASC
    `);

    this.stmtL1QueryMigrationCursor = this.db.prepare(`
      SELECT ${l1QueryCols} FROM l1_records
      WHERE record_id > ?
      ORDER BY record_id ASC
      LIMIT ?
    `);

    this.logger?.debug?.(`${TAG} Initialized (dimensions=${this.dimensions})`);

    return { needsReindex, reason: reindexReason };
  }

  // ── Embedding meta helpers ──────────────────────────────
  // 中文：── 嵌入元数据辅助函数 ──────────────────────────────

  private readEmbeddingMeta(): EmbeddingMeta | null {
    try {
      const row = this.db
        .prepare("SELECT value FROM embedding_meta WHERE key = ?")
        .get("embedding_provider_info") as { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as EmbeddingMeta;
    } catch {
      return null;
    }
  }

  private writeEmbeddingMeta(meta: EmbeddingMeta): void {
    this.db.prepare(
      "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run("embedding_provider_info", JSON.stringify(meta));
  }

  /** Allowed table names for row counting (whitelist to prevent SQL injection). */
  /** 中文：允许进行行计数的表名（白名单以防止SQL注入）。 */
  private static readonly COUNTABLE_TABLES = new Set(["l1_records", "l0_conversations"]);

  /**
   * Extra rows to retrieve from vec0 KNN search to compensate for legacy
   * zero-vector placeholders that may still linger from older data.
   * 中文：从vec0 KNN搜索中额外检索的行数，以补偿可能仍然存在于旧数据中的过时零向量占位符。
   */
  private static readonly ZERO_VEC_BUFFER = 10;

  /** Default result limit for FTS5 keyword searches. */
  /** 中文：FTS5关键词搜索的默认结果限制。 */
  private static readonly FTS_DEFAULT_LIMIT = 20;

  private tableRowCount(table: string): number {
    if (!VectorStore.COUNTABLE_TABLES.has(table)) {
      this.logger?.warn(`${TAG} tableRowCount: rejected unknown table name "${table}"`);
      return 0;
    }
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM ${table}`)
        .get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Detect the embedding dimension of an existing vec0 table by inspecting
   * the DDL stored in sqlite_master.  Returns `null` if the table doesn't
   * exist or the dimension cannot be determined.
   *
   * The vec0 DDL looks like:
   *   CREATE VIRTUAL TABLE l1_vec USING vec0(... embedding float[768] ...)
   * We parse the number inside `float[N]`.
   * 中文：通过检查存储在sqlite_master中的DDL来检测现有vec0表的嵌入维度。如果表不存在或无法确定维度，则返回`null`。vec0 DDL如下所示：
   * CREATE VIRTUAL TABLE l1_vec USING vec0(... embedding float[768] ...)
   * 我们解析`float[N]`内的数字.
   */
  private getVecTableDimensions(): number | null {
    try {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get("l1_vec") as { sql: string } | undefined;
      if (!row?.sql) return null;
      const match = row.sql.match(/float\[(\d+)\]/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Drop both L1 and L0 vector virtual tables.
   * Metadata tables (l1_records, l0_conversations) are preserved — only
   * the vec0 tables need to be rebuilt with the new dimensions.
   * 中文：Drop both L1和L0向量虚拟表。
   * 元数据表（l1_records, l0_conversations）保留——仅需用新维度重建vec0表。
   */
  private dropVectorTables(): void {
    this.db.exec("DROP TABLE IF EXISTS l1_vec");
    this.db.exec("DROP TABLE IF EXISTS l0_vec");
    this.logger?.info(`${TAG} Dropped vector tables (l1_vec, l0_vec)`);
  }

  /**
   * Write or update a memory record (metadata + vector).
   * Uses a manual transaction for atomicity.
   *
   * If `embedding` is `undefined` or a zero vector (all elements are 0), only
   * the metadata row is written — the vec0 table is left untouched.  This
   * allows callers without an EmbeddingService to still persist metadata + FTS
   * without constructing a throwaway zero-vector, and prevents placeholder
   * zero vectors (from embedding-service failures) from polluting KNN search
   * results with null / NaN distances.
   *
   * **Fault-tolerant**: catches all errors internally so that a vector store
   * failure never propagates to the caller / main OpenClaw flow.
   * Returns `true` on success, `false` on failure (logged as warning).
   * 中文：写入或更新内存记录（元数据+向量）。
   * 使用手动事务保证原子性。
   * 如果`embedding`为`undefined`或零向量（所有元素均为0），仅写入元数据行——不修改vec0表。这允许没有EmbeddingService的调用方仍然持久化元数据+FTS，而不构建临时的零向量，并防止因嵌入服务失败而产生的占位零向量污染KNN搜索结果中的空/NaN距离。
   * **容错性**：内部捕获所有错误以确保向量存储故障不会传播给调用方/主OpenClaw流程。
   * 成功返回`true`，失败返回`false`（记录为警告）。
   */
  upsertL1(record: MemoryRecord, embedding: Float32Array | undefined): boolean {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L1-upsert] SKIPPED (degraded mode) id=${record.id}`);
      return false;
    }
    try {
      const { id: recordId, timestamps } = record;
      const tsStr = timestamps[0] ?? "";
      const tsStart =
        timestamps.length > 0
          ? timestamps.reduce((a, b) => (a < b ? a : b))
          : tsStr;
      const tsEnd =
        timestamps.length > 0
          ? timestamps.reduce((a, b) => (a > b ? a : b))
          : tsStr;

      const skipVec = !embedding || embedding.every(v => v === 0) || !this.vecTablesReady;

      this.logger?.debug?.(
        `${TAG} [L1-upsert] START id=${recordId}, type=${record.type}, ` +
        `content="${record.content.slice(0, 60)}..."` +
        (embedding
          ? `, embeddingDims=${embedding.length}, ` +
            `embeddingNorm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}` +
            `${skipVec ? " (ZERO VECTOR or vec tables not ready — vec write will be skipped)" : ""}`
          : " (no embedding — metadata-only write)"),
      );

      this.db.exec("BEGIN");
      try {
        // Upsert metadata (INSERT OR UPDATE)
        // 中文：元数据的插入或更新（INSERT OR UPDATE）
        this.stmtUpsertMeta.run(
          recordId,
          record.content,
          record.type,
          record.priority,
          record.scene_name,
          record.sessionKey,
          record.sessionId,
          tsStr,
          tsStart,
          tsEnd,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record.metadata),
        );

        if (!skipVec) {
          // vec0 does not support ON CONFLICT → delete then insert
          // 中文：vec0不支持ON CONFLICT → 先删除再插入
          this.stmtDeleteVec!.run(recordId);
          this.stmtInsertVec!.run(recordId, Buffer.from(embedding!.buffer), record.updatedAt);
        } else {
          this.logger?.debug?.(
            `${TAG} [L1-upsert] Skipping vec write (${embedding ? "zero vector" : "no embedding"}) id=${recordId}`,
          );
        }

        // Sync FTS5 (delete + re-insert to handle updates)
        // 中文：同步FTS5（删除+重新插入以处理更新）
        if (this.ftsAvailable) {
          try {
            this.stmtL1FtsDelete.run(recordId);
            this.stmtL1FtsInsert.run(
              tokenizeForFts(record.content), // content — segmented for indexing
              // 中文：内容——分段以便索引
              record.content,                 // content_original — raw for display
              // 中文：content_original——原始用于显示
              recordId,
              record.type,
              record.priority,
              record.scene_name,
              record.sessionKey,
              record.sessionId,
              tsStr,
              tsStart,
              tsEnd,
              JSON.stringify(record.metadata),
            );
          } catch (ftsErr) {
            // FTS write failure is non-fatal — log and continue
            // 中文：FTS写入失败非致命 — 记录并继续
            this.logger?.warn(
              `${TAG} [L1-upsert] FTS write failed (non-fatal) id=${recordId}: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
            );
          }
        }

        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        // 中文：忽略回滚错误
        throw err;
      }
      this.logger?.debug?.(`${TAG} [L1-upsert] OK id=${recordId}${skipVec ? " (meta-only)" : ""}`);
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-upsert] FAILED (non-fatal) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Vector similarity search (cosine distance).
   * Returns top-k results sorted by similarity (highest first).
   *
   * **Fault-tolerant**: returns an empty array on any error (e.g. dimension
   * mismatch, corrupted DB) so callers can fall back to keyword search.
   * 中文：余弦距离向量相似性搜索。
   * 按相似度排序返回top-k结果（最相似的排在前面）。
   * **容错性**：任何错误（如维度不匹配、数据库损坏等）均返回空数组，调用方可以回退到关键词搜索。
   */
  searchL1Vector(queryEmbedding: Float32Array, topK = 5): VectorSearchResult[] {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded) this.logger?.warn(`${TAG} [L1-search] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      // Over-retrieve to compensate for legacy zero-vector placeholders that
      // may still exist in the vec0 table.  New zero vectors are no longer
      // inserted (upsert() skips vec write for zero vectors since v3.x), but
      // older data may still contain them — they surface as NULL/NaN distance
      // in KNN results.  A small buffer of 10 is sufficient for remnants.
      // NOTE: "AND distance IS NOT NULL" is NOT usable because vec0 does not
      // support that constraint — it causes an empty result set.
      // 中文：为补偿vec0表中可能仍然存在的遗留零向量占位符而过度检索。自v3.x版本起，新插入的零向量不再被写入（upsert()从v3.x版本开始跳过对零向量的写入），但旧数据仍可能包含它们——在KNN结果中表现为NULL/NaN距离。少量缓冲区（10个）足以应对残留问题。
      // 注意："AND distance IS NOT NULL"不可用，因为vec0不支持该约束条件 — 它会导致空的结果集。
      const ZERO_VEC_BUFFER = 10;
      const retrieveCount = topK + ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L1-search] START topK=${topK}, retrieveCount=${retrieveCount}, ` +
        `queryEmbeddingDims=${queryEmbedding.length}, ` +
        `queryNorm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
      );

      const rows = this.stmtSearchVec!.all(
        Buffer.from(queryEmbedding.buffer),
        retrieveCount,
      ) as Array<{ record_id: string; distance: number }>;

      this.logger?.debug?.(`${TAG} [L1-search] vec0 returned ${rows.length} candidate(s)`);

      if (rows.length === 0) return [];

      const results: VectorSearchResult[] = [];

      for (const { record_id, distance } of rows) {
        // sqlite-vec returns null distance for zero vectors (cosine undefined when ‖v‖=0).
        // Skip these — they are placeholder vectors from embedding-service-unavailable fallback.
        // 中文：sqlite-vec返回零向量的距离为null（当‖v‖=0时余弦相似度未定义）。跳过这些项——它们是来自embedding-service-unavailable回退的占位符向量。
        if (distance == null || Number.isNaN(distance)) {
          this.logger?.warn(
            `${TAG} [L1-search] record_id=${record_id} has null/NaN distance (likely zero vector) — skipping`,
          );
          continue;
        }

        const meta = this.stmtGetMeta.get(record_id) as
          | {
              content: string;
              type: string;
              priority: number;
              scene_name: string;
              session_key: string;
              session_id: string;
              timestamp_str: string;
              timestamp_start: string;
              timestamp_end: string;
              metadata_json: string;
            }
          | undefined;

        if (!meta) {
          this.logger?.warn(`${TAG} [L1-search] record_id=${record_id} has vector but NO metadata (orphan)`);
          continue;
        }

        const score = 1.0 - distance;
        this.logger?.debug?.(
          `${TAG} [L1-search] HIT id=${record_id}, distance=${distance.toFixed(4)}, score=${score.toFixed(4)}, ` +
          `type=${meta.type}, content="${meta.content.slice(0, 60)}..."`,
        );

        results.push({
          record_id,
          content: meta.content,
          type: meta.type,
          priority: meta.priority,
          scene_name: meta.scene_name,
          score,
          timestamp_str: meta.timestamp_str,
          timestamp_start: meta.timestamp_start,
          timestamp_end: meta.timestamp_end,
          session_key: meta.session_key,
          session_id: meta.session_id,
          metadata_json: meta.metadata_json,
        });
      }

      // Trim back to the caller's requested topK (we over-fetched above).
      // 中文：将结果裁剪回调用者请求的topK（我们之前多取了）。
      const trimmed = results.slice(0, topK);
      this.logger?.info(
        `${TAG} [L1-search] DONE returning ${trimmed.length} result(s) (from ${results.length} valid, ${rows.length} raw)`,
      );
      return trimmed;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Delete a single record (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   * 中文：删除一条记录（元数据+向量）。**容错处理**：失败时记录警告，从不抛出异常。
   */
  deleteL1(recordId: string): boolean {
    if (this.degraded) return false;
    try {
      this.db.exec("BEGIN");
      try {
        this.stmtDeleteMeta.run(recordId);
        if (this.vecTablesReady) this.stmtDeleteVec!.run(recordId);
        if (this.ftsAvailable) {
          try { this.stmtL1FtsDelete.run(recordId); } catch { /* non-fatal */ }
          // 中文：非致命性错误
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        // 中文：忽略回滚错误
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} delete failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Delete multiple records (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   * 中文：批量删除多条记录（元数据+向量）。**容错处理**：失败时记录警告，从不抛出异常。
   */
  deleteL1Batch(recordIds: string[]): boolean {
    if (this.degraded) return false;
    if (recordIds.length === 0) return true;

    try {
      this.db.exec("BEGIN");
      try {
        for (const id of recordIds) {
          this.stmtDeleteMeta.run(id);
          if (this.vecTablesReady) this.stmtDeleteVec!.run(id);
          if (this.ftsAvailable) {
            try { this.stmtL1FtsDelete.run(id); } catch { /* non-fatal */ }
            // 中文：非致命性错误
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        // 中文：忽略回滚错误
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteBatch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get the total number of L1 records in the store.
   *
   * **Fault-tolerant**: returns 0 on failure.
   * TTL cleanup by updated_time.
   *
   * Deletes expired rows from l1_records and matching vectors from l1_vec
   * in a single transaction to guarantee consistency.
   * 中文：获取存储中L1记录的总数。**容错处理**：失败时返回0。TTL清理依据updated_time。在单个事务中删除过期行以及匹配的向量以保证一致性。
   */
  deleteL1Expired(cutoffIso: string): number {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [deleteExpired] SKIPPED (degraded mode)`);
      return 0;
    }
    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l1_records WHERE updated_time != '' AND updated_time < ?",
      ).get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      // Ratio protection: refuse to delete > 80% in one pass
      // 中文：批量删除保护：一次操作拒绝删除超过80%的数据
      const totalRow = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l1_records",
      ).get() as { cnt: number };
      const total = totalRow.cnt;
      const ratio = total > 0 ? expiredCount / total : 0;
      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L1-deleteExpired] BLOCKED: would delete ${expiredCount}/${total} ` +
          `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      this.db.exec("BEGIN");
      try {
        if (this.vecTablesReady) {
          this.db.prepare(
            "DELETE FROM l1_vec WHERE updated_time != '' AND updated_time < ?",
          ).run(cutoffIso);
        }
        this.db.prepare(
          "DELETE FROM l1_records WHERE updated_time != '' AND updated_time < ?",
        ).run(cutoffIso);
        this.db.exec("COMMIT");
        this.logger?.info?.(
          `${TAG} [L1-deleteExpired] Deleted ${expiredCount}/${total} records (cutoff=${cutoffIso})`,
        );
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        // 中文：忽略回滚错误
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL1ExpiredByUpdatedTime failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Get the total number of records in the store.
   * 中文：获取存储中的总记录数。
   */
  countL1(): number {
    if (this.degraded) return 0;
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l1_records")
        .get() as { cnt: number };
      this.logger?.debug?.(`${TAG} [L1-count] total=${row.cnt}`);
      return row.cnt;
    } catch (err) {
      this.logger?.warn(
        `${TAG} count failed (non-fatal, returning 0): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Query L1 records with optional session and time filters.
   *
   * Uses the composite index `idx_l1_session_updated(session_id, updated_time)`
   * for efficient filtering. All timestamps are compared as UTC ISO 8601 strings.
   *
   * **Fault-tolerant**: returns an empty array on any error (degraded mode, DB issues).
   * 中文：使用可选会话和时间过滤条件查询L1记录。使用复合索引`idx_l1_session_updated(session_id, updated_time)`进行高效过滤。所有时间戳都以UTC ISO 8601字符串形式比较。**容错处理**：任何错误时返回空数组（降级模式，数据库问题）。
   */
  queryL1Records(filter?: L1QueryFilter): L1RecordRow[] {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L1-query] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const { sessionKey, sessionId, updatedAfter } = filter ?? {};

      let raw: Record<string, unknown>[];

      // Priority: sessionId > sessionKey (sessionId is more specific)
      // 中文：优先级: sessionId > sessionKey (sessionId更具特异性)
      if (sessionId && updatedAfter) {
        raw = this.stmtQueryBySessionIdSince.all(sessionId, updatedAfter) as Record<string, unknown>[];
      } else if (sessionId) {
        raw = this.stmtQueryBySessionId.all(sessionId) as Record<string, unknown>[];
      } else if (sessionKey && updatedAfter) {
        raw = this.stmtQueryBySessionKeySince.all(sessionKey, updatedAfter) as Record<string, unknown>[];
      } else if (sessionKey) {
        raw = this.stmtQueryBySessionKey.all(sessionKey) as Record<string, unknown>[];
      } else if (updatedAfter) {
        raw = this.stmtQueryAllSince.all(updatedAfter) as Record<string, unknown>[];
      } else {
        raw = this.stmtQueryAll.all() as Record<string, unknown>[];
      }

      // Runtime sanity check: verify first row has expected columns (guards against schema drift)
      // 中文：运行时合理性检查: 验证第一行具有预期列（防止模式漂移）
      if (raw.length > 0 && !("record_id" in raw[0] && "content" in raw[0])) {
        this.logger?.warn(
          `${TAG} [L1-query] Schema mismatch: first row missing expected columns. ` +
          `Got keys: [${Object.keys(raw[0]).join(", ")}]`,
        );
        return [];
      }

      const rows = raw as unknown as L1RecordRow[];

      this.logger?.info(
        `${TAG} [L1-query] filter={sessionKey=${sessionKey ?? "(all)"}, sessionId=${sessionId ?? "(all)"}, updatedAfter=${updatedAfter ?? "(none)"}}, ` +
        `returned ${rows.length} record(s)`,
      );
      return rows;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-query] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  // ── L0 operations ──────────────────────────────────
  // 中文：── L0 操作 ──────────────────────────────────

  /**
   * Write or update an L0 single-message record (metadata + vector).
   * Uses a manual transaction for atomicity.
   *
   * If `embedding` is `undefined` or a zero vector (all elements are 0), only
   * the metadata row (`l0_conversations`) is written — the vec0 table
   * (`l0_vec`) is left untouched.  This allows callers without an
   * EmbeddingService to still persist metadata + FTS without constructing a
   * throwaway zero-vector, and prevents placeholder zero vectors (from
   * embedding-service failures) from polluting KNN search results.
   *
   * **Fault-tolerant**: catches all errors internally, never throws.
   * Returns `true` on success, `false` on failure (logged as warning).
   * 中文：写入或更新L0单条消息记录（元数据 + 向量）。
   * 使用手动事务确保原子性。
   * 如果`embedding`为`undefined`或零向量（所有元素均为0），
   * 仅写入元数据行（`l0_conversations`）—— `l0_vec`表未受影响。
   * 这允许没有EmbeddingService的调用者仍然可以持久化元数据 + FTS，
   * 而不必构建临时的零向量，并防止占位零向量（来自embedding-service失败）污染KNN搜索结果。
   * **容错**: 内部捕获所有错误，从不抛出。
   * 成功返回`true`，失败返回`false`并记录为警告。
   */
  upsertL0(record: L0Record, embedding: Float32Array | undefined): boolean {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-upsert] SKIPPED (degraded mode) id=${record.id}`);
      return false;
    }
    try {
      const skipVec = !embedding || embedding.every(v => v === 0) || !this.vecTablesReady;

      this.logger?.debug?.(
        `${TAG} [L0-upsert] START id=${record.id}, session=${record.sessionKey}, role=${record.role}, ` +
        `text="${record.messageText.slice(0, 60)}..."` +
        (embedding
          ? `, embeddingDims=${embedding.length}, ` +
            `embeddingNorm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}` +
            `${skipVec ? " (ZERO VECTOR or vec tables not ready — vec write will be skipped)" : ""}`
          : " (no embedding — metadata-only write)"),
      );

      this.db.exec("BEGIN");
      try {
        this.stmtL0UpsertMeta.run(
          record.id,
          record.sessionKey,
          record.sessionId,
          record.role,
          record.messageText,
          record.recordedAt,
          record.timestamp,
        );

        if (!skipVec) {
          // vec0 does not support ON CONFLICT → delete then insert
          // 中文：vec0 不支持 ON CONFLICT → 先删除再插入
          this.stmtL0DeleteVec!.run(record.id);
          this.stmtL0InsertVec!.run(record.id, Buffer.from(embedding!.buffer), record.recordedAt);
        } else {
          this.logger?.debug?.(
            `${TAG} [L0-upsert] Skipping vec write (${embedding ? "zero vector" : "no embedding"}) id=${record.id}`,
          );
        }

        // Sync FTS5 (delete + re-insert to handle updates)
        // 中文：同步 FTS5 (先删除后重新插入以处理更新)
        if (this.ftsAvailable) {
          try {
            this.stmtL0FtsDelete.run(record.id);
            this.stmtL0FtsInsert.run(
              tokenizeForFts(record.messageText), // message_text — segmented for indexing
              // 中文：message_text——分段用于索引
              record.messageText,                 // message_text_original — raw for display
              // 中文：message_text_original——原始用于显示
              record.id,
              record.sessionKey,
              record.sessionId,
              record.role,
              record.recordedAt,
              record.timestamp,
            );
          } catch (ftsErr) {
            // FTS write failure is non-fatal — log and continue
            // 中文：向量写入失败是非致命的 — 记录并继续
            this.logger?.warn(
              `${TAG} [L0-upsert] FTS write failed (non-fatal) id=${record.id}: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
            );
          }
        }

        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        // 中文：忽略回滚错误
        throw err;
      }
      this.logger?.debug?.(`${TAG} [L0-upsert] OK id=${record.id}${skipVec ? " (meta-only)" : ""}`);
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-upsert] FAILED (non-fatal) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Update ONLY the vector embedding for an existing L0 record.
   * The metadata row must already exist in l0_conversations (written by upsertL0).
   *
   * This is used by the background embedding task in auto-capture:
   *   1. upsertL0() writes metadata + FTS synchronously (no embedding)
   *   2. Background task calls embedBatch() then updateL0Embedding() for each record
   *
   * **Fault-tolerant**: catches all errors internally, never throws.
   * Returns `true` on success, `false` on failure.
   * 中文：仅更新现有L0记录的向量嵌入。
   * 元数据行必须已在l0_conversations中存在（由upsertL0写入）。
   * 此操作用于自动捕获背景嵌入任务:
   * 1. upsertL0() 同步写入元数据 + FTS（无嵌入）
   * 2. 背景任务调用embedBatch()然后updateL0Embedding()为每个记录
   * **容错**: 内部捕获所有错误，从不抛出。
   * 成功返回`true`，失败返回`false`
   */
  updateL0Embedding(recordId: string, embedding: Float32Array): boolean {
    if (this.degraded || !this.vecTablesReady) {
      return false;
    }
    if (!embedding || embedding.every(v => v === 0)) {
      this.logger?.debug?.(`${TAG} [L0-update-embedding] Skipping zero vector for ${recordId}`);
      return false;
    }
    try {
      // Look up recorded_at from metadata for the vec0 row
      // 中文：从metadata中查找vec0行的recorded_at
      const meta = this.stmtL0GetMeta.get(recordId) as { recorded_at: string } | undefined;
      if (!meta) {
        this.logger?.warn(`${TAG} [L0-update-embedding] No metadata found for ${recordId}, skipping`);
        return false;
      }

      this.db.exec("BEGIN");
      try {
        this.stmtL0DeleteVec!.run(recordId);
        this.stmtL0InsertVec!.run(recordId, Buffer.from(embedding.buffer), meta.recorded_at);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        // 中文：忽略
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-update-embedding] FAILED (non-fatal) id=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Vector similarity search on L0 individual messages (cosine distance).
   * Returns top-k results sorted by similarity (highest first).
   *
   * **Fault-tolerant**: returns an empty array on any error.
   * 中文：在L0个体消息上进行向量相似度搜索（余弦距离）。
   * 返回按相似度排序的top-k结果（最高优先级）。
   * **容错处理**：任何错误都返回空数组。
   */
  searchL0Vector(queryEmbedding: Float32Array, topK = 5): L0VectorSearchResult[] {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded) this.logger?.warn(`${TAG} [L0-search] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      // Over-retrieve to compensate for legacy zero-vector placeholders that
      // may still exist in the vec0 table.  New zero vectors are no longer
      // inserted (upsertL0() skips vec write for zero vectors since v3.x), but
      // older data may still contain them — they surface as NULL/NaN distance
      // in KNN results.
      // NOTE: "AND distance IS NOT NULL" is NOT usable because vec0 does not
      // support that constraint — it causes an empty result set.
      // 中文：为了补偿legacy零向量占位符可能仍然存在于vec0表中的情况而过度检索。自v3.x以来，新插入的零向量不再写入（upsertL0()从不为零向量进行vec写入），但旧数据中仍可能存在它们——在KNN结果中表现为NULL/NaN距离。
      // 注意："AND distance IS NOT NULL"不可用，因为vec0不支持该约束条件——它会导致空的结果集。
      const retrieveCount = topK + VectorStore.ZERO_VEC_BUFFER;

      this.logger?.debug?.(
        `${TAG} [L0-search] START topK=${topK}, retrieveCount=${retrieveCount}, ` +
        `queryEmbeddingDims=${queryEmbedding.length}, ` +
        `queryNorm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
      );

      const rows = this.stmtL0SearchVec!.all(
        Buffer.from(queryEmbedding.buffer),
        retrieveCount,
      ) as Array<{ record_id: string; distance: number }>;

      this.logger?.debug?.(`${TAG} [L0-search] vec0 returned ${rows.length} candidate(s)`);

      if (rows.length === 0) return [];

      const results: L0VectorSearchResult[] = [];

      for (const { record_id, distance } of rows) {
        // sqlite-vec returns null distance for zero vectors (cosine undefined when ‖v‖=0).
        // Skip these — they are placeholder vectors from embedding-service-unavailable fallback.
        // 中文：sqlite-vec对零向量返回null距离（当‖v‖=0时余弦未定义）。跳过这些情况——它们是由于embedding-service-unavailable回退而产生的占位符向量。
        if (distance == null || Number.isNaN(distance)) {
          this.logger?.warn(
            `${TAG} [L0-search] record_id=${record_id} has null/NaN distance (likely zero vector) — skipping`,
          );
          continue;
        }

        const meta = this.stmtL0GetMeta.get(record_id) as
          | {
              session_key: string;
              session_id: string;
              role: string;
              message_text: string;
              recorded_at: string;
              timestamp: number;
            }
          | undefined;

        if (!meta) {
          this.logger?.warn(`${TAG} [L0-search] record_id=${record_id} has vector but NO metadata (orphan)`);
          continue;
        }

        const score = 1.0 - distance;
        this.logger?.debug?.(
          `${TAG} [L0-search] HIT id=${record_id}, distance=${distance.toFixed(4)}, score=${score.toFixed(4)}, ` +
          `role=${meta.role}, session=${meta.session_key}, text="${meta.message_text.slice(0, 60)}..."`,
        );

        results.push({
          record_id,
          session_key: meta.session_key,
          session_id: meta.session_id,
          role: meta.role,
          message_text: meta.message_text,
          score,
          recorded_at: meta.recorded_at,
          timestamp: meta.timestamp ?? 0,
        });
      }

      // Trim back to the caller's requested topK (we over-fetched above).
      // 中文：将结果裁剪回调用者请求的topK（我们之前过度检索了）。
      const trimmed = results.slice(0, topK);
      this.logger?.info(
        `${TAG} [L0-search] DONE returning ${trimmed.length} result(s) (from ${results.length} valid, ${rows.length} raw)`,
      );
      return trimmed;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Delete a single L0 record (metadata + vector).
   *
   * **Fault-tolerant**: logs a warning on failure, never throws.
   * 中文：删除单个L0记录（元数据+向量）。
   * **容错处理**：失败时记录警告，从不抛出异常。
   */
  deleteL0(recordId: string): boolean {
    if (this.degraded) return false;
    try {
      this.db.exec("BEGIN");
      try {
        this.stmtL0DeleteMeta.run(recordId);
        if (this.vecTablesReady) this.stmtL0DeleteVec!.run(recordId);
        if (this.ftsAvailable) {
          try { this.stmtL0FtsDelete.run(recordId); } catch { /* non-fatal */ }
          // 中文：非致命性错误
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        // 中文：忽略回滚错误
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL0 failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * TTL cleanup by recorded_at (ISO string) for L0 records.
   *
   * Deletes expired rows from l0_conversations and matching vectors from l0_vec
   * in a single transaction to guarantee consistency.
   * 中文：按recorded_at进行TTL清理（ISO字符串格式）对L0记录。
   * 在一个事务中从l0_conversations和匹配的l0_vec中删除过期行以保证一致性。
   */
  deleteL0Expired(cutoffIso: string): number {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [deleteExpiredL0] SKIPPED (degraded mode)`);
      return 0;
    }

    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?",
      ).get(cutoffIso) as { cnt: number } | undefined;
      const expiredCount = row?.cnt ?? 0;
      if (expiredCount <= 0) return 0;

      // Ratio protection: refuse to delete > 80% in one pass
      // 中文：拒绝一次性删除超过80%的数据
      const totalRow = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM l0_conversations",
      ).get() as { cnt: number };
      const total = totalRow.cnt;
      const ratio = total > 0 ? expiredCount / total : 0;
      if (ratio > 0.8) {
        this.logger?.warn(
          `${TAG} [L0-deleteExpired] BLOCKED: would delete ${expiredCount}/${total} ` +
          `(${(ratio * 100).toFixed(1)}%) — exceeds 80% safety threshold, cutoff=${cutoffIso}`,
        );
        return 0;
      }

      this.db.exec("BEGIN");
      try {
        if (this.vecTablesReady) {
          this.db.prepare(
            "DELETE FROM l0_vec WHERE recorded_at != '' AND recorded_at < ?",
          ).run(cutoffIso);
        }
        this.db.prepare(
          "DELETE FROM l0_conversations WHERE recorded_at != '' AND recorded_at < ?",
        ).run(cutoffIso);
        this.db.exec("COMMIT");
        this.logger?.info?.(
          `${TAG} [L0-deleteExpired] Deleted ${expiredCount}/${total} records (cutoff=${cutoffIso})`,
        );
        return expiredCount;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch { /* ignore rollback errors */ }
        // 中文：忽略回滚错误
        throw err;
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} deleteL0ExpiredByRecordedAt failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Get the total number of L0 message records in the store.
   *
   * **Fault-tolerant**: returns 0 on failure.
   * 中文：获取存储中的L0消息记录总数。
   * **容错处理**：失败时返回0。
   */
  countL0(): number {
    if (this.degraded) return 0;
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM l0_conversations")
        .get() as { cnt: number };
      this.logger?.debug?.(`${TAG} [L0-count] total=${row.cnt}`);
      return row.cnt;
    } catch (err) {
      this.logger?.warn(
        `${TAG} countL0 failed (non-fatal, returning 0): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  // ── Re-index operations ──────────────────────────────────
  // 中文：── 重新索引操作 ──────────────────────────────────

  /**
   * Get all L1 record texts for re-embedding.
   * Returns record_id → content pairs.
   * 中文：获取所有L1记录文本以重新嵌入。
   * 返回record_id → content 对应对。
   */
  getAllL1Texts(): Array<{ record_id: string; content: string; updated_time: string }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare("SELECT record_id, content, updated_time FROM l1_records")
        .all() as Array<{ record_id: string; content: string; updated_time: string }>;
    } catch (err) {
      this.logger?.warn(
        `${TAG} getAllL1Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Get all L0 message texts for re-embedding.
   * Returns record_id → message_text/recorded_at tuples.
   * 中文：获取所有L0消息文本以重新嵌入。
   * 返回record_id → message_text/recorded_at 元组。
   */
  getAllL0Texts(): Array<{ record_id: string; message_text: string; recorded_at: string }> {
    if (this.degraded) return [];
    try {
      return this.db
        .prepare("SELECT record_id, message_text, recorded_at FROM l0_conversations")
        .all() as Array<{ record_id: string; message_text: string; recorded_at: string }>;
    } catch (err) {
      this.logger?.warn(
        `${TAG} getAllL0Texts failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Re-embed all existing L1 and L0 texts with a new embedding function.
   *
   * This is called after `init()` returns `needsReindex: true` — the vector
   * tables have already been dropped and re-created with the correct dimensions.
   * This method reads every text from the metadata tables and writes fresh
   * embeddings into the new vector tables.
   *
   * @param embedFn  A function that converts text → Float32Array embedding.
   * @param onProgress  Optional callback for progress reporting.
   * 中文：使用新的嵌入函数重新嵌入所有现有L1和L0文本。
   * 在`init()`返回`needsReindex: true`后调用此方法——向量表已经删除并正确重建。
   * 此方法从元数据表中读取每条文本并在新向量表中写入新鲜的嵌入。
   * @param embedFn  转换text → Float32Array嵌入的功能。
   * @param onProgress  可选的进度报告回调。
   */
  async reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    if (this.degraded || !this.vecTablesReady) {
      if (this.degraded) this.logger?.warn(`${TAG} reindexAll skipped: VectorStore is in degraded mode`);
      return { l1Count: 0, l0Count: 0 };
    }

    try {
      // ── Re-embed L1 ──
      // 中文：── 重新嵌入L1 ──
      const l1Rows = this.getAllL1Texts();
      let l1Done = 0;
      for (const { record_id, content, updated_time } of l1Rows) {
        try {
          const embedding = await embedFn(content);
          // Wrap delete+insert in a transaction to prevent orphan vectors
          // 中文：将删除+插入包裹在一个事务中以防止孤儿向量
          this.db.exec("BEGIN");
          try {
            this.stmtDeleteVec!.run(record_id);
            this.stmtInsertVec!.run(record_id, Buffer.from(embedding.buffer), updated_time);
            this.db.exec("COMMIT");
          } catch (txErr) {
            try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
            // 中文：ignore
            throw txErr;
          }
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} reindex L1 skip ${record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        l1Done++;
        onProgress?.(l1Done, l1Rows.length, "L1");
      }

      // ── Re-embed L0 ──
      // 中文：── 重新嵌入L0 ──
      const l0Rows = this.getAllL0Texts();
      let l0Done = 0;
      for (const { record_id, message_text, recorded_at } of l0Rows) {
        try {
          const embedding = await embedFn(message_text);
          // Wrap delete+insert in a transaction to prevent orphan vectors
          // 中文：将删除+插入操作包裹在事务中以防止孤立向量
          this.db.exec("BEGIN");
          try {
            this.stmtL0DeleteVec!.run(record_id);
            this.stmtL0InsertVec!.run(record_id, Buffer.from(embedding.buffer), recorded_at);
            this.db.exec("COMMIT");
          } catch (txErr) {
            try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
            // 中文：ignore
            throw txErr;
          }
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} reindex L0 skip ${record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        l0Done++;
        onProgress?.(l0Done, l0Rows.length, "L0");
      }

      this.logger?.info(
        `${TAG} Reindex complete: L1=${l1Done}/${l1Rows.length}, L0=${l0Done}/${l0Rows.length}`,
      );

      return { l1Count: l1Done, l0Count: l0Done };
    } catch (err) {
      this.logger?.error(
        `${TAG} reindexAll failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { l1Count: 0, l0Count: 0 };
    }
  }

  // ── L0 query operations (for L1 runner) ──────────────────────────────────
  // 中文：── L0 查询操作（为L1运行器）────────────────────────────────────

  /**
   * Query L0 messages for a given session key, optionally filtered by recorded_at cursor.
   * Returns messages ordered by recorded_at ASC (chronological write order).
   *
   * Used by L1 runner to read L0 data from DB instead of JSONL files.
   * 中文：查询给定会话键的L0消息，可选地按recorded_at光标过滤。
   * 按recorded_at ASC排序返回消息（按照写入顺序排列）。
   * 由L1运行器用于从数据库而不是JSONL文件读取L0数据。
   */
  queryL0ForL1(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
  ): Array<{
    record_id: string;
    session_key: string;
    session_id: string;
    role: string;
    message_text: string;
    recorded_at: string;
    timestamp: number;
  }> {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-query] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      // Query newest-first (DESC) with LIMIT, then reverse to chronological order
      // 中文：按 Newest-first (DESC) 查询并限制结果数量，然后反转以获得按时间顺序排列的结果
      let rows: Array<Record<string, unknown>>;
      if (afterRecordedAtMs && afterRecordedAtMs > 0) {
        // Convert epoch ms to ISO string for recorded_at comparison
        // 中文：将epoch ms转换为ISO字符串以便于recorded_at比较
        const afterRecordedAtIso = new Date(afterRecordedAtMs).toISOString();
        rows = this.stmtL0QueryAfter.all(sessionKey, afterRecordedAtIso, limit) as Array<Record<string, unknown>>;
      } else {
        rows = this.stmtL0QueryAll.all(sessionKey, limit) as Array<Record<string, unknown>>;
      }

      this.logger?.info(
        `${TAG} [L0-query] session=${sessionKey}, afterRecordedAtMs=${afterRecordedAtMs ?? "(all)"}, ` +
        `limit=${limit}, returned ${rows.length} row(s)`,
      );

      // Reverse: SQL returns newest-first (DESC), callers expect chronological order
      // 中文：反转：SQL返回Newest-first (DESC)，调用者期望按时间顺序排列
      return rows.map((r) => ({
        record_id: r.record_id as string,
        session_key: r.session_key as string,
        session_id: (r.session_id as string) || "",
        role: r.role as string,
        message_text: r.message_text as string,
        recorded_at: (r.recorded_at as string) || "",
        timestamp: (r.timestamp as number) || 0,
      })).reverse();
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Query L0 messages for a given session key, grouped by session_id.
   * Each group's messages are in chronological order (recorded_at ASC).
   * Groups are sorted by earliest message timestamp.
   *
   * Used by L1 runner to replace readConversationMessagesGroupedBySessionId().
   * 中文：查询给定会话键的L0消息，并按session_id分组。
   * 每个组内的消息按recorded_at ASC排序（按照写入顺序排列）。
   * 组按最早消息的时间戳排序。
   * 由L1运行器用于替换readConversationMessagesGroupedBySessionId()。
   */
  queryL0GroupedBySessionId(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
  ): Array<{ sessionId: string; messages: Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number }> }> {
    if (this.degraded) {
      this.logger?.warn(`${TAG} [L0-query-grouped] SKIPPED (degraded mode)`);
      return [];
    }
    try {
      const rows = this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);

      // Group by session_id
      // 中文：按session_id分组
      const groupMap = new Map<string, Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number }>>();
      for (const row of rows) {
        const sid = row.session_id || "";
        let group = groupMap.get(sid);
        if (!group) {
          group = [];
          groupMap.set(sid, group);
        }
        group.push({
          id: row.record_id,
          role: row.role,
          content: row.message_text,
          timestamp: row.timestamp,
          recordedAtMs: row.recorded_at ? Date.parse(row.recorded_at) || 0 : 0,
        });
      }

      // Convert to array, sorted by earliest message timestamp
      // 中文：将转换为数组，并按最早消息时间戳排序
      const groups: Array<{ sessionId: string; messages: Array<{ id: string; role: string; content: string; timestamp: number; recordedAtMs: number }> }> = [];
      for (const [sessionId, messages] of groupMap) {
        if (messages.length > 0) {
          groups.push({ sessionId, messages });
        }
      }
      groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);

      this.logger?.info(
        `${TAG} [L0-query-grouped] session=${sessionKey}, afterRecordedAtMs=${afterRecordedAtMs ?? "(all)"}, ` +
        `${rows.length} messages across ${groups.length} group(s)`,
      );

      return groups;
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query-grouped] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── Cursor-based pagination for migration ──────────────────
  // 中文：── 基于游标的分页迁移 ──────────────────

  /**
   * Read a page of L1 records using primary key cursor.
   * Returns rows with `record_id > afterId`, ordered by PK, limited to `pageSize`.
   * Pass `""` as `afterId` for the first page.
   * 中文：使用主键游标读取一页L1记录。
   * 返回满足`record_id > afterId`的行，按主键排序，限制为`pageSize`。
   * 将`""`作为`afterId`以获取第一页数据。
   */
  queryL1RecordsCursor(afterId: string, pageSize: number): L1RecordRow[] {
    if (this.degraded) return [];
    try {
      return this.stmtL1QueryMigrationCursor.all(afterId, pageSize) as unknown as L1RecordRow[];
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-query-cursor] FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Read a page of L0 records using primary key cursor.
   * Returns rows with `record_id > afterId`, ordered by PK, limited to `pageSize`.
   * Pass `""` as `afterId` for the first page.
   * 中文：使用主键游标读取一页L0记录。
   * 返回满足`record_id > afterId`的行，按主键排序，限制为`pageSize`。
   * 将`""`作为`afterId`以获取第一页数据。
   */
  queryL0RecordsCursor(afterId: string, pageSize: number): L0RecordRow[] {
    if (this.degraded) return [];
    try {
      return this.stmtL0QueryMigrationCursor.all(afterId, pageSize) as unknown as L0RecordRow[];
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-query-cursor] FAILED (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── FTS5 search operations ──────────────────────────────────
  // 中文：── FTS5搜索操作 ──────────────────────────────────

  /**
   * Whether FTS5 full-text search is available.
   * When `false`, callers should skip keyword-based recall entirely.
   * 中文：是否可用FTS5全文搜索。
   * 当`false`时，调用者应完全跳过基于关键词的召回。
   */
  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  /**
   * FTS5 keyword search on L1 records.
   * Returns top-`limit` results sorted by BM25 relevance (highest first).
   *
   * @param ftsQuery  A pre-built FTS5 MATCH expression (from `buildFtsQuery()`).
   * @param limit     Maximum number of results to return.
   *
   * **Fault-tolerant**: returns an empty array on any error.
   * 中文：在L1记录上进行FTS5关键词搜索。
   * 返回按BM25相关性排序（最高优先级）的前`limit`个结果。
   * @param ftsQuery  来自`buildFtsQuery()`的预构建FTS5 MATCH表达式。
   * @param limit     返回的最大结果数。
   * **容错处理**：任何错误时返回空数组。
   */
  searchL1Fts(ftsQuery: string, limit = 20): FtsSearchResult[] {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      const rows = this.stmtL1FtsSearch.all(ftsQuery, limit) as Array<{
        record_id: string;
        content: string;
        type: string;
        priority: number;
        scene_name: string;
        session_key: string;
        session_id: string;
        timestamp_str: string;
        timestamp_start: string;
        timestamp_end: string;
        metadata_json: string;
        rank: number;
      }>;

      return rows.map((r) => ({
        record_id: r.record_id,
        content: r.content,
        type: r.type,
        priority: r.priority,
        scene_name: r.scene_name,
        score: bm25RankToScore(r.rank),
        timestamp_str: r.timestamp_str,
        timestamp_start: r.timestamp_start,
        timestamp_end: r.timestamp_end,
        session_key: r.session_key,
        session_id: r.session_id,
        metadata_json: r.metadata_json,
      }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L1-fts-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * FTS5 keyword search on L0 conversation messages.
   * Returns top-`limit` results sorted by BM25 relevance (highest first).
   *
   * @param ftsQuery  A pre-built FTS5 MATCH expression (from `buildFtsQuery()`).
   * @param limit     Maximum number of results to return.
   *
   * **Fault-tolerant**: returns an empty array on any error.
   * 中文：在L0对话消息上进行FTS5关键词搜索。
   * 返回按BM25相关性排序（最高优先级）的前`limit`个结果。
   * @param ftsQuery  来自`buildFtsQuery()`的预构建FTS5 MATCH表达式。
   * @param limit     返回的最大结果数。
   * **容错处理**：任何错误时返回空数组。
   */
  searchL0Fts(ftsQuery: string, limit = VectorStore.FTS_DEFAULT_LIMIT): L0FtsSearchResult[] {
    if (this.degraded || !this.ftsAvailable) return [];
    try {
      const rows = this.stmtL0FtsSearch.all(ftsQuery, limit) as Array<{
        record_id: string;
        message_text: string;
        session_key: string;
        session_id: string;
        role: string;
        recorded_at: string;
        timestamp: number;
        rank: number;
      }>;

      return rows.map((r) => ({
        record_id: r.record_id,
        session_key: r.session_key,
        session_id: r.session_id,
        role: r.role,
        message_text: r.message_text,
        score: bm25RankToScore(r.rank),
        recorded_at: r.recorded_at,
        timestamp: r.timestamp ?? 0,
      }));
    } catch (err) {
      this.logger?.warn(
        `${TAG} [L0-fts-search] FAILED (non-fatal, returning empty): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ── FTS5 migration & rebuild ──────────────────────────────────────────────
  // 中文：── FTS5 迁移与重建 ──────────────────────────────────────────────

  /**
   * Detect old FTS5 v1 schema (no `content_original` column) and drop the
   * tables so they can be recreated with the v2 schema.
   *
   * FTS5 virtual tables do NOT support `ALTER TABLE ADD COLUMN`, so the only
   * migration path is DROP + recreate + repopulate.
   *
   * @returns `true` if migration was performed (= FTS index needs rebuilding).
   * @internal
   * 中文：检测旧的 FTS5 v1 架构（没有 `content_original` 列）并删除这些表，以便可以使用 v2 架构重新创建它们。
   * FTS5 虚拟表不支持 `ALTER TABLE ADD COLUMN`，因此唯一的迁移路径是 DROP + 重新创建 + 重新填充。
   * @returns `true` 如果执行了迁移（= 需要重建 FTS 索引）。
   * @internal
   */
  private migrateFtsTablesIfNeeded(): boolean {
    try {
      // Check if l1_fts exists at all
      // 中文：检查 l1_fts 是否存在
      const l1Exists = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='l1_fts'")
        .get();
      if (!l1Exists) {
        // Fresh install — tables will be created with v2 schema.
        // Still need rebuild if there's existing data in l1_records.
        // 中文：全新安装 — 表将使用 v2 架构创建。
        // 即使 l1_records 存在数据，仍需重新构建索引。
        const hasData = this.db.prepare("SELECT 1 FROM l1_records LIMIT 1").get();
        return !!hasData;
      }

      // Check if the v2 column `content_original` exists.
      // FTS5 tables appear in pragma_table_info with their column names.
      // 中文：检查 v2 列 `content_original` 是否存在。
      // FTS5 表在 pragma_table_info 中以它们的列名出现。
      const cols = this.db
        .prepare("SELECT name FROM pragma_table_info('l1_fts')")
        .all() as Array<{ name: string }>;
      const hasV2Col = cols.some((c) => c.name === "content_original");

      if (hasV2Col) {
        return false; // Already v2 — no migration needed
        // 中文：已v2 —无需迁移
      }

      // v1 → v2: drop both FTS tables (data will be repopulated by rebuildFtsIndex)
      // 中文：v1 → v2: 删除两个 FTS 表（数据将在重建 FtsIndex 时重新填充）
      this.logger?.info(`${TAG} Migrating FTS5 tables from v1 to v2 (jieba segmented)`);
      this.db.exec("DROP TABLE IF EXISTS l1_fts");
      this.db.exec("DROP TABLE IF EXISTS l0_fts");
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} FTS migration check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Rebuild the FTS5 index from scratch by reading all records from the
   * metadata tables and re-inserting them with jieba-segmented text.
   *
   * Called automatically after:
   *  - Schema migration from v1 to v2
   *  - Fresh table creation when existing data exists
   *
   * Safe to call multiple times (idempotent — clears FTS tables first).
   * 中文：从头开始重建 FTS5 索引，通过读取元数据表中的所有记录并使用 jieba 分词文本重新插入。
   * 在以下情况下自动调用：
   * - 从 v1 到 v2 的架构迁移
   * - 存在现有数据时的全新表创建
   * 多次调用是安全的（幂等 —— 首先清空 FTS 表）。
   */
  rebuildFtsIndex(): void {
    if (!this.ftsAvailable) return;

    try {
      this.logger?.info(`${TAG} Rebuilding FTS5 index with jieba segmentation…`);

      // ── Rebuild L1 FTS ──
      // Clear existing FTS data
      // 中文：── 重建 L1 FTS ──
      // 清除现有的 FTS 数据
      this.db.exec("DELETE FROM l1_fts");

      // Read all L1 records from metadata table
      // 中文：读取元数据表中的所有L1记录
      const l1Rows = this.db
        .prepare(`
          SELECT record_id, content, type, priority, scene_name,
                 session_key, session_id, timestamp_str, timestamp_start, timestamp_end, metadata_json
          FROM l1_records
        `)
        .all() as Array<{
          record_id: string;
          content: string;
          type: string;
          priority: number;
          scene_name: string;
          session_key: string;
          session_id: string;
          timestamp_str: string;
          timestamp_start: string;
          timestamp_end: string;
          metadata_json: string;
        }>;

      let l1Count = 0;
      for (const r of l1Rows) {
        try {
          this.stmtL1FtsInsert.run(
            tokenizeForFts(r.content),  // content — segmented
            // 中文：内容 — 分段
            r.content,                   // content_original — raw
            // 中文：内容_original — 原始
            r.record_id,
            r.type,
            r.priority,
            r.scene_name,
            r.session_key,
            r.session_id,
            r.timestamp_str,
            r.timestamp_start,
            r.timestamp_end,
            r.metadata_json,
          );
          l1Count++;
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} FTS rebuild skip L1 ${r.record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ── Rebuild L0 FTS ──
      // 中文：── 重建L0 FTS ──
      this.db.exec("DELETE FROM l0_fts");

      const l0Rows = this.db
        .prepare(`
          SELECT record_id, message_text, session_key, session_id, role, recorded_at, timestamp
          FROM l0_conversations
        `)
        .all() as Array<{
          record_id: string;
          message_text: string;
          session_key: string;
          session_id: string;
          role: string;
          recorded_at: string;
          timestamp: number;
        }>;

      let l0Count = 0;
      for (const r of l0Rows) {
        try {
          this.stmtL0FtsInsert.run(
            tokenizeForFts(r.message_text),  // message_text — segmented
            // 中文：message_text — 分段
            r.message_text,                   // message_text_original — raw
            // 中文：message_text_original — 原始
            r.record_id,
            r.session_key,
            r.session_id,
            r.role,
            r.recorded_at,
            r.timestamp,
          );
          l0Count++;
        } catch (err) {
          this.logger?.warn?.(
            `${TAG} FTS rebuild skip L0 ${r.record_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.logger?.info(
        `${TAG} FTS5 rebuild complete: L1=${l1Count}/${l1Rows.length}, L0=${l0Count}/${l0Rows.length}`,
      );
    } catch (err) {
      this.logger?.warn(
        `${TAG} FTS5 rebuild failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ============================
  // IMemoryStore interface implementation
  // ============================
  // 中文：IMemoryStore接口实现

  /** Query the store's search capabilities. */
  /** 中文：查询存储的搜索能力。 */
  getCapabilities(): StoreCapabilities {
    return {
      vectorSearch: this.vecTablesReady,
      ftsSearch: this.ftsAvailable,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }

  /**
   * Close the database connection.
   * Should be called on shutdown. Idempotent — safe to call multiple times.
   * 中文：关闭数据库连接。
   * 应在关机时调用。幂等——多次调用安全。
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} Error closing database: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
