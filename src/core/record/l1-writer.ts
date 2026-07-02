/**
 * L1 Memory Writer: writes extracted memories to JSONL files.
 *
 * File naming: records/YYYY-MM-DD.jsonl (daily shards, all sessions merged).
 * Each record includes sessionKey for traceability.
 *
 * Write strategy:
 * - JSONL is the append-only persistent store (source of truth for backup/recovery).
 * - VectorStore (SQLite) is the primary retrieval engine.
 * - On update/merge, old records are deleted from VectorStore in real-time;
 *   JSONL is append-only and cleaned up periodically by memory-cleaner.
 *
 * Supports store (append), update, merge, and skip operations.
 *
 * v3: Aligned with Kenty's prompt output format — 3 memory types (persona/episodic/instruction),
 * numeric priority, scene_name, source_message_ids, metadata, timestamps.
 * 中文：L1 Memory Writer: 将提取的记忆写入JSONL文件。
 * 文件命名：records/YYYY-MM-DD.jsonl（每日分片，所有会话合并）。
 * 每条记录包含sessionKey以供追溯。
 * 写入策略：
 * - JSONL是只追加的持久存储（备份/恢复的真实来源）。
 * - VectorStore（SQLite）为主要检索引擎。
 * - 更新/合并时，旧记录将实时从VectorStore中删除；
 * JSONL为只追加，并定期由内存清理程序清理。
 * 支持存储（追加）、更新、合并和跳过操作。
 * v3: 与Kenty的提示输出格式对齐——3种记忆类型（人设/事件/指令），数值优先级，场景名称，源消息ID，元数据，时间戳。
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";
import { formatLocalDate } from "../../utils/time.js";

// ============================
// Types
// ============================

/** v3: 3 memory types aligned with Kenty's extraction prompt */
/** 中文：v3: 3种记忆类型与Kenty的提取提示对齐 */
export type MemoryType = "persona" | "episodic" | "instruction";

/** Metadata for episodic memories (activity time range) */
/** 中文：事件记忆的元数据（活动时间范围） */
export interface EpisodicMetadata {
  activity_start_time?: string; // ISO 8601
  activity_end_time?: string; // ISO 8601
}

/**
 * A persisted memory record in L1 JSONL files.
 *
 * v3 changes from v2:
 * - `importance: "high"|"medium"|"low"` → `priority: number` (0-100, -1 for strict global instructions)
 * - Added `scene_name`, `source_message_ids`, `metadata`, `timestamps`
 * - Removed `keywords` (will be rebuilt from content for search)
 * - MemoryType reduced from 4 to 3 (removed "preference", folded into "persona")
 * 中文：L1 JSONL文件中持久化的记忆记录。
 * v3从v2的变化：
 * - `importance: "high"|"medium"|"low"` → `priority: number` (0-100, -1为严格的全局指令)
 * - 添加了`scene_name`, `source_message_ids`, `metadata`, `timestamps`
 * - 移除了`keywords`（将从内容重建以供搜索）
 * - 记忆类型从4减少到3（移除了"preference"，并入"persona"）
 */
export interface MemoryRecord {
  /** Unique ID for dedup updates */
  /** 中文：用于去重更新的唯一ID */
  id: string;
  /** Memory content */
  /** 中文：记忆内容 */
  content: string;
  /** Memory type: persona / episodic / instruction */
  /** 中文：记忆类型: 人设 / 事件 / 指令 */
  type: MemoryType;
  /** Priority score: 0-100 (higher = more important), -1 = strict global instruction */
  /** 中文：优先级分数：0-100（越高越重要），-1 = 严格的全局指令 */
  priority: number;
  /** Scene name this memory belongs to */
  /** 中文：场景名称 */
  scene_name: string;
  /** Source message IDs that contributed to this memory */
  /** 中文：贡献给此记忆的消息ID */
  source_message_ids: string[];
  /** Type-specific metadata (e.g., activity_start_time for episodic) */
  /** 中文：类型特定的元数据（例如，episodic的记忆起始时间activity_start_time） */
  metadata: EpisodicMetadata | Record<string, never>;
  /** Timestamp trail: all timestamps related to this memory (for merge history tracking) */
  /** 中文：时间戳轨迹：与此次记忆相关的所有时间戳（用于合并历史跟踪） */
  timestamps: string[];
  /** Creation timestamp (ISO) */
  /** 中文：创建时间戳（ISO格式） */
  createdAt: string;
  /** Last update timestamp (ISO) */
  /** 中文：最后更新时间戳（ISO格式） */
  updatedAt: string;
  /** Source session key (conversation channel identifier) */
  /** 中文：源会话键（对话频道标识符） */
  sessionKey: string;
  /** Source session ID (single conversation instance identifier) */
  /** 中文：源会话ID（单一对话实例标识符） */
  sessionId: string;
}

/**
 * A memory as extracted by LLM (before dedup / persistence).
 * Matches the output format of Kenty's extraction prompt.
 * 中文：一个由LLM提取的记忆（去重/持久化前）
 * 匹配肯蒂的提取提示输出格式。
 */
export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  priority: number;
  source_message_ids: string[];
  metadata: EpisodicMetadata | Record<string, never>;
  /** Scene name this memory was extracted in */
  /** 中文：记忆被提取的场景名称 */
  scene_name: string;
}

export type DedupAction = "store" | "update" | "merge" | "skip";

/**
 * v3 batch dedup decision — one per new memory, aligned with Kenty's conflict detection prompt.
 *
 * Key changes:
 * - `targetId` → `target_ids` (array, supports multi-target merge/update)
 * - Added `merged_type`, `merged_priority`, `merged_timestamps` for cross-type merge
 * 中文：v3批量去重决策——每个新记忆一个，与肯蒂的冲突检测提示对齐。
 * 主要变化：
 * - `targetId` → `target_ids`（数组，支持多目标合并/更新）
 * - 添加了`merged_type`、`merged_priority`、`merged_timestamps`用于跨类型合并
 */
export interface DedupDecision {
  /** Which new memory this decision is about */
  /** 中文：此决策关于的新记忆ID */
  record_id: string;
  action: DedupAction;
  /** IDs of existing records to replace/remove (for update/merge) */
  /** 中文：需要替换/移除的现有记录ID（用于更新/合并） */
  target_ids: string[];
  /** Merged/updated content text (for update/merge) */
  /** 中文：合并/更新的内容文本（用于更新/合并） */
  merged_content?: string;
  /** Best type after merge (for update/merge, may differ from original) */
  /** 中文：合并后的最佳类型（用于更新/合并，可能与原始类型不同） */
  merged_type?: MemoryType;
  /** Priority after merge (for update/merge) */
  /** 中文：合并后的优先级（用于更新/合并） */
  merged_priority?: number;
  /** Union of all related timestamps (for update/merge) */
  /** 中文：所有相关的时间戳联合（用于更新/合并） */
  merged_timestamps?: string[];
}

const TAG = "[memory-tdai][l1-writer]";

// ============================
// Core functions
// ============================
// 中文：核心功能

/**
 * Generate a unique memory ID.
 * 中文：生成一个唯一的内存ID。
 */
export function generateMemoryId(): string {
  return `m_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Write a memory record according to the dedup decision.
 *
 * - store: append new record
 * - update: remove target records + append updated record
 * - merge: remove target records + append merged record
 * - skip: do nothing
 *
 * v3: supports multi-target removal for update/merge.
 * v3.1: optional VectorStore + EmbeddingService for dual-write (JSONL + vector).
 * 中文：根据去重决策生成记忆记录。
 * - store: 新增记录
 * - update: 删除目标记录并新增更新后的记录
 * - merge: 删除目标记录并新增合并后的记录
 * - skip: 不做任何操作
 * v3: 更新/合并时支持多目标删除。
 * v3.1: 可选的VectorStore + EmbeddingService用于双写（JSONL + 向量库）。
 */
export async function writeMemory(params: {
  memory: ExtractedMemory;
  decision: DedupDecision;
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  logger?: Logger;
  /** Optional vector store for dual-write (JSONL + vector DB) */
  /** 中文：可选的向量存储，用于双写（JSONL + 向量数据库） */
  vectorStore?: IMemoryStore;
  /** Optional embedding service (required when vectorStore is provided) */
  /** 中文：可选的嵌入服务（当提供vectorStore时需要） */
  embeddingService?: EmbeddingService;
}): Promise<MemoryRecord | null> {
  const { memory, decision, baseDir, sessionKey, sessionId, logger, vectorStore, embeddingService } = params;

  if (decision.action === "skip") {
    logger?.debug?.(`${TAG} Skipping memory: ${memory.content.slice(0, 50)}...`);
    return null;
  }

  const now = new Date().toISOString();

  // Determine final content, type, priority based on action
  // 中文：根据动作确定最终内容、类型和优先级
  let finalContent: string;
  let finalType: MemoryType;
  let finalPriority: number;
  let finalTimestamps: string[];

  if (decision.action === "merge" || decision.action === "update") {
    finalContent = decision.merged_content ?? memory.content;
    finalType = decision.merged_type ?? memory.type;
    finalPriority = decision.merged_priority ?? memory.priority;
    finalTimestamps = decision.merged_timestamps ?? [now];
  } else {
    // store
    finalContent = memory.content;
    finalType = memory.type;
    finalPriority = memory.priority;
    finalTimestamps = [now];
  }

  const record: MemoryRecord = {
    id: decision.record_id || generateMemoryId(),
    content: finalContent,
    type: finalType,
    priority: finalPriority,
    scene_name: memory.scene_name,
    source_message_ids: memory.source_message_ids,
    metadata: memory.metadata,
    timestamps: finalTimestamps,
    createdAt: now,
    updatedAt: now,
    sessionKey,
    sessionId: sessionId || "",
  };

  const recordsDir = path.join(baseDir, "records");
  await fs.mkdir(recordsDir, { recursive: true });

  const shardDate = formatLocalDate(new Date());
  const filePath = path.join(recordsDir, `${shardDate}.jsonl`);

  if ((decision.action === "update" || decision.action === "merge") && decision.target_ids.length > 0) {
    // Remove target records from VectorStore (real-time deletion for retrieval accuracy).
    // JSONL is append-only — old records remain in files and are cleaned up periodically
    // by memory-cleaner (which reconciles against VectorStore as source of truth).
    // 中文：从VectorStore删除目标记录（实时删除以提高检索准确性）。
    // JSONL为追加只读 — 旧记录保留在文件中，并由内存清理程序周期性清理
    // (该清理程序以VectorStore作为真相来源进行校正)。
    if (vectorStore) {
      try {
        await vectorStore.deleteL1Batch(decision.target_ids);
        logger?.debug?.(`${TAG} VectorStore: deleted ${decision.target_ids.length} target record(s) for ${decision.action}`);
      } catch (err) {
        logger?.warn?.(
          `${TAG} VectorStore delete failed for ${decision.action}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
    logger?.debug?.(`${TAG} ${decision.action} memory: removed [${decision.target_ids.join(",")}] from VectorStore → ${record.id}: ${finalContent.slice(0, 80)}...`);
  } else {
    // store: append a new line
    // 中文：store: append a new line
    await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
    logger?.debug?.(`${TAG} Stored memory ${record.id}: ${finalContent.slice(0, 80)}...`);
  }

  // === Vector Store dual-write ===
  // 中文：=== Vector Store 双写 ===
  if (vectorStore) {
    try {
      logger?.debug?.(
        `${TAG} [vec-dual-write] START id=${record.id}, contentLen=${record.content.length}, ` +
        `content="${record.content.slice(0, 80)}..."`,
      );

      let embedding: Float32Array | undefined;

      if (embeddingService) {
        try {
          embedding = await embeddingService.embed(record.content);
          logger?.debug?.(
            `${TAG} [vec-dual-write] Embedding OK: dims=${embedding.length}, ` +
            `norm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
          );
        } catch (embedErr) {
          // Embedding failed — pass undefined to upsert() which writes
          // metadata + FTS only, skipping the vec0 table.
          // 中文：Embedding failed — pass undefined to upsert() which writes
          // metadata + FTS only, skipping the vec0 表。
          logger?.warn(
            `${TAG} [vec-dual-write] Embedding FAILED for id=${record.id}, ` +
            `will write metadata only: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
          );
        }
      }

      const upsertOk = await vectorStore.upsertL1(record, embedding);
      logger?.debug?.(`${TAG} [vec-dual-write] upsert result=${upsertOk} id=${record.id}`);
    } catch (err) {
      // Vector write failure should NOT block the main JSONL write
      // 中文：Vector 写失败不应阻塞主要的 JSONL 写操作
      logger?.warn?.(
        `${TAG} [vec-dual-write] FAILED (JSONL already written) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    logger?.debug?.(
      `${TAG} [vec-dual-write] SKIPPED id=${record.id}: vectorStore=${!!vectorStore}`,
    );
  }

  return record;
}

// ============================
// Helpers
// ============================
// 中文：Helpers