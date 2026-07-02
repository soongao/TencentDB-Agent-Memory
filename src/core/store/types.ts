/**
 * Memory Store Abstraction Layer — Core Types & Interfaces.
 *
 * This module defines the storage contracts that all backend implementations
 * (SQLite local, Tencent Cloud VectorDB, etc.) must satisfy.
 *
 * Design principles:
 * 1. **Backend-agnostic**: Upper-layer modules (hooks, tools, pipeline, record)
 *    depend only on these interfaces — never on concrete implementations.
 * 2. **Capability-based**: Features like vector search, FTS, and hybrid search
 *    are expressed as capability flags so callers can gracefully degrade.
 * 3. **Fault-tolerant**: All methods return empty results or `false` on
 *    failure rather than throwing, unless explicitly documented otherwise.
 * 4. **Sync-first**: Matches current SQLite DatabaseSync usage. TCVDB backend
 *    adapts internally without changing these signatures.
 * 中文：内存存储抽象层 — 核心类型与接口。
 * 此模块定义了所有后端实现（如SQLite本地、腾讯云向量数据库等）必须满足的存储合约。
 * 设计原则：
 * 1. **后端无关**：上层模块（钩子、工具、管道、记录）仅依赖这些接口 — 从不依赖具体的实现。
 * 2. **基于能力**：如向量搜索、全文搜索和混合搜索等功能以能力标志的形式表达，调用方可以优雅降级。
 * 3. **容错性**：所有方法在失败时返回空结果或 `false` 而不是抛出异常，除非另有明确说明。
 * 4. **同步优先**：与当前SQLite DatabaseSync的使用方式一致。TCVDB后端内部适配而不改变这些签名。
 */

import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type { Logger } from "../types.js";

// Re-export so consumers can import everything from types.ts
// 中文：重新导出以便消费者可以从types.ts导入一切
export type { MemoryRecord, EmbeddingProviderInfo };

// ============================
// Common Types
// ============================
// 中文：常用类型

/** Minimal logger interface accepted by store implementations. */
/** 中文：存储实现接受的最小日志接口。 */
export type StoreLogger = Logger;

// ============================
// L1 Types (Structured Memories)
// ============================
// 中文：L1 类型（结构化记忆）

/** Result from an L1 vector similarity search. */
/** 中文：L1 向量相似性搜索结果。 */
export interface L1SearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** Similarity score (0–1, higher is better). */
  /** 中文：相似度分数（0–1，数值越大越好）。 */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
}

/** Result from an L1 FTS keyword search. */
/** 中文：L1 全文搜索关键词搜索结果。 */
export interface L1FtsResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25-derived score (0–1, higher is better). */
  /** 中文：BM25-derived分数（0–1，数值越大越好）. */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  session_key: string;
  session_id: string;
  metadata_json: string;
}

/** Filter options for querying L1 records. */
/** 中文：查询L1记录的过滤选项。 */
export interface L1QueryFilter {
  sessionKey?: string;
  sessionId?: string;
  /** Only return records with updated_time strictly after this ISO 8601 UTC timestamp. */
  /** 中文：仅返回updated_time严格晚于该ISO 8601 UTC时间戳的记录。 */
  updatedAfter?: string;
}

/** Row shape returned by L1 query methods. */
/** 中文：L1查询方法返回的行形状。 */
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

// ============================
// L0 Types (Raw Conversations)
// ============================
// 中文：L0类型（原始对话）

/** An L0 conversation message record for vector indexing. */
/** 中文：用于向量索引的L0对话消息记录。 */
export interface L0Record {
  id: string;
  sessionKey: string;
  sessionId: string;
  role: string;
  messageText: string;
  recordedAt: string;
  /** Original message timestamp (epoch ms). */
  /** 中文：原消息时间戳（epoch ms）。 */
  timestamp: number;
}

/** Result from an L0 vector similarity search. */
/** 中文：L0向量相似度搜索的结果。 */
export interface L0SearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** Similarity score (0–1, higher is better). */
  /** 中文：相似度得分（0–1，数值越大越好）. */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Result from an L0 FTS keyword search. */
/** 中文：L0 FTS关键词搜索结果。 */
export interface L0FtsResult {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  /** BM25-derived score (0–1, higher is better). */
  /** 中文：BM25衍生分数（0–1，数值越大越好）. */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Raw L0 row returned by query methods (used by L1 runner). */
/** 中文：查询方法返回的原始L0行数据（用于L1运行器）。 */
export interface L0QueryRow {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
}

/** L0 messages grouped by session ID (for L1 runner). */
/** 中文：按会话ID分组的L0消息（用于L1运行器）。 */
export interface L0SessionGroup {
  sessionId: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
    /** Epoch ms when this message was recorded into L0 (used by L1 cursor). */
    /** 中文：记录此消息到L0的时间点（以毫秒为单位，用于L1游标）。 */
    recordedAtMs: number;
  }>;
}

// ============================
// Store Init Result
// ============================
// 中文：存储初始化结果。

/** Result of store initialization. */
/** 中文：存储初始化的结果。 */
export interface StoreInitResult {
  /** Whether embeddings need to be regenerated (provider/model change). */
  /** 中文：是否需要重新生成嵌入（提供者/模型变更）. */
  needsReindex: boolean;
  /** Human-readable reason (for logging). */
  /** 中文：人性化的理由（用于日志记录）. */
  reason?: string;
}

// ============================
// Capability Flags
// ============================
// 中文：能力标志

/**
 * Describes what search capabilities a store backend supports.
 * Callers use this to select search strategies and degrade gracefully.
 * 中文：描述存储后端支持的搜索功能。调用方据此选择搜索策略并优雅降级.
 */
export interface StoreCapabilities {
  /** Whether vector (embedding) search is available. */
  /** 中文：向量（嵌入）搜索是否可用. */
  vectorSearch: boolean;
  /** Whether FTS (full-text keyword) search is available. */
  /** 中文：全文关键词搜索是否可用. */
  ftsSearch: boolean;
  /** Whether native hybrid search is supported (e.g., TCVDB hybridSearch). */
  /** 中文：原生混合搜索是否支持（例如，TCVDB hybridSearch）. */
  nativeHybridSearch: boolean;
  /** Whether the store supports sparse vectors (BM25 encoding). */
  /** 中文：存储是否支持稀疏向量（BM25编码）. */
  sparseVectors: boolean;
}

// ============================
// L2/L3 Profile Sync Types
// ============================
// 中文：L2/L3 层级同步类型

/** Canonical L2/L3 profile row shared between local cache and remote store. */
/** 中文：标准 L2/L3 配置文件行，在本地缓存和远程存储之间共享。 */
export interface ProfileRecord {
  /** Stable ID: `profile:v1:${sha256(scope + "\0" + type + "\0" + filename)}`. */
  /** 中文：稳定 ID: `profile:v1:${sha256(scope + "\0" + type + "\0" + filename)}`。 */
  id: string;
  type: "l2" | "l3";
  filename: string;
  content: string;
  contentMd5: string;
  agentId?: string;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Profile upsert payload with optimistic-lock baseline from the last pull. */
/** 中文：带有乐观锁基线的配置插入或更新载荷，来自上次拉取。 */
export interface ProfileSyncRecord extends ProfileRecord {
  baselineVersion?: number;
}

// ============================
// IMemoryStore — The Core Abstraction
// ============================
// 中文：IMemoryStore — 核心抽象

/**
 * Unified memory store interface.
 *
 * Implementations:
 * - `SqliteMemoryStore` (sqlite.ts) — local SQLite + sqlite-vec + FTS5
 * - `TcvdbMemoryStore` (tcvdb.ts) — Tencent Cloud VectorDB (future)
 *
 * All methods are fault-tolerant: they return empty results or `false` on
 * failure rather than throwing, unless explicitly documented otherwise.
 * 中文：统一的内存存储接口。
 * 实现方式:
 * - `SqliteMemoryStore` (sqlite.ts) — 本地 SQLite + sqlite-vec + FTS5
 * - `TcvdbMemoryStore` (tcvdb.ts) — 腾讯云向量数据库（未来）
 * 所有方法都是容错的：它们在失败时返回空结果或 `false`，而不是抛出异常，除非明确文档说明否则不如此。
 */
/**
 * Helper type: a value that may be sync or async.
 * Callers should always `await` the result — it's safe for both sync and async values.
 * 中文：辅助类型: 可能是同步或异步值。
 * 调用者应始终 `await` 结果 — 无论是同步还是异步值都安全。
 */
export type MaybePromise<T> = T | Promise<T>;

export interface IMemoryStore {
  // ── Capabilities ───────────────────────────────────────────
  // 中文：── 能力 ───────────────────────────────────────────────

  /**
   * Whether this store supports deferred (background) embedding updates.
   *
   * When `true`, auto-capture writes metadata-only via `upsertL0(record, undefined)`
   * and later calls `updateL0Embedding()` in a fire-and-forget background task.
   * When `false` or absent, embedding is computed inline and passed to `upsertL0()`.
   * 中文：是否支持延迟（后台）嵌入更新。
   * 当为`true`时，自动捕获仅写入元数据并通过`upsertL0(record, undefined)`
   * 并在后台任务中稍后调用`updateL0Embedding()`。
   * 当为`false`或缺失时，在线计算嵌入并传递给`upsertL0()`。
   */
  readonly supportsDeferredEmbedding?: boolean;

  // ── Lifecycle (always sync) ──────────────────────────────
  // 中文：── 生命周期（始终同步） ──────────────────────────────

  init(providerInfo?: EmbeddingProviderInfo): MaybePromise<StoreInitResult>;
  isDegraded(): boolean;
  getCapabilities(): StoreCapabilities;
  close(): void;

  // ── L1 Write ─────────────────────────────────────────────
  // 中文：── L1 写入 ─────────────────────────────────────────────

  upsertL1(record: MemoryRecord, embedding?: Float32Array): MaybePromise<boolean>;
  deleteL1(recordId: string): MaybePromise<boolean>;
  deleteL1Batch(recordIds: string[]): MaybePromise<boolean>;
  deleteL1Expired(cutoffIso: string): MaybePromise<number>;

  // ── L1 Read ──────────────────────────────────────────────

  countL1(): MaybePromise<number>;
  queryL1Records(filter?: L1QueryFilter): MaybePromise<L1RecordRow[]>;
  getAllL1Texts(): MaybePromise<Array<{ record_id: string; content: string; updated_time: string }>>;

  // ── L1 Search ────────────────────────────────────────────
  // 中文：── L1 搜索 ────────────────────────────────────────────

  searchL1Vector(queryEmbedding: Float32Array, topK?: number, queryText?: string): MaybePromise<L1SearchResult[]>;
  searchL1Fts(ftsQuery: string, limit?: number): MaybePromise<L1FtsResult[]>;
  searchL1Hybrid?(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: Array<[number, number]>;
    topK?: number;
  }): MaybePromise<L1SearchResult[]>;

  // ── L0 Write ─────────────────────────────────────────────
  // 中文：── L0 写入 ─────────────────────────────────────────────

  upsertL0(record: L0Record, embedding?: Float32Array): MaybePromise<boolean>;
  /** Update only the vector embedding for an existing L0 record (sqlite background path). */
  /** 中文：仅更新现有L0记录的向量嵌入（sqlite后台路径）。 */
  updateL0Embedding?(recordId: string, embedding: Float32Array): MaybePromise<boolean>;
  deleteL0(recordId: string): MaybePromise<boolean>;
  deleteL0Expired(cutoffIso: string): MaybePromise<number>;

  // ── L0 Read ──────────────────────────────────────────────

  countL0(): MaybePromise<number>;
  queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit?: number): MaybePromise<L0QueryRow[]>;
  queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit?: number): MaybePromise<L0SessionGroup[]>;
  getAllL0Texts(): MaybePromise<Array<{ record_id: string; message_text: string; recorded_at: string }>>;

  // ── L0 Search ────────────────────────────────────────────
  // 中文：── L0 搜索 ────────────────────────────────────────────

  searchL0Vector(queryEmbedding: Float32Array, topK?: number, queryText?: string): MaybePromise<L0SearchResult[]>;
  searchL0Fts(ftsQuery: string, limit?: number): MaybePromise<L0FtsResult[]>;

  pullProfiles?(): Promise<ProfileRecord[]>;
  syncProfiles?(records: ProfileSyncRecord[]): Promise<void>;
  deleteProfiles?(recordIds: string[]): Promise<void>;

  // ── Re-index ─────────────────────────────────────────────
  // 中文：── 重新索引 ─────────────────────────────────────────────

  reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }>;

  // ── FTS (always sync — cached flag) ──────────────────────
  // 中文：── FTS (always sync — cached flag) ──────────────────────

  isFtsAvailable(): boolean;
}

// ============================
// IEmbeddingService — re-exported from embedding.ts for convenience
// ============================
// 中文：IEmbeddingService — 从embedding.ts导出以方便使用

/**
 * Re-export EmbeddingService as IEmbeddingService for backward compatibility.
 * The canonical definition lives in `./embedding.ts`. All concrete implementations
 * (LocalEmbeddingService, OpenAIEmbeddingService, NoopEmbeddingService) implement
 * the EmbeddingService interface from embedding.ts.
 * 中文：将EmbeddingService重新导出为IEmbeddingService以保持向后兼容性。
 * Canonical定义位于`./embedding.ts`。所有具体的实现（LocalEmbeddingService, OpenAIEmbeddingService, NoopEmbeddingService）都实现了来自embedding.ts的EmbeddingService接口。
 */
export type { EmbeddingService as IEmbeddingService } from "./embedding.js";
