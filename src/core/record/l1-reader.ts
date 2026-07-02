/**
 * L1 Memory Reader: reads persisted L1 memory records.
 *
 * Provides two data paths:
 *
 * 1. **SQLite** (preferred): `queryMemoryRecords()` — uses VectorStore's `queryL1Records()`
 *    with composite indexes on (session_key, updated_time) and (session_id, updated_time)
 *    for efficient session-scoped and time-range queries.
 *
 * 2. **JSONL** (fallback): `readMemoryRecords()` / `readAllMemoryRecords()` — reads from
 *    `records/YYYY-MM-DD.jsonl` files. Used when VectorStore is unavailable or degraded.
 * 中文：L1 Memory Reader: reads persisted L1 memory records.
 * 提供两种数据路径：
 * 1. **SQLite**（首选）：`queryMemoryRecords()` — 使用VectorStore的`queryL1Records()`，带有复合索引`(session_key, updated_time)`和`(session_id, updated_time)`，用于高效的会话范围和时间区间查询。
 * 2. **JSONL**（备用）：`readMemoryRecords()` / `readAllMemoryRecords()` — 从`records/YYYY-MM-DD.jsonl`文件读取。当VectorStore不可用或降级时使用。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryRecord, MemoryType, EpisodicMetadata } from "./l1-writer.js";
import type { IMemoryStore, L1RecordRow, L1QueryFilter } from "../store/types.js";

// Re-export types that readers need
// 中文：Re-export types that readers need
export type { MemoryRecord, MemoryType, EpisodicMetadata } from "./l1-writer.js";
export type { L1QueryFilter } from "../store/types.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [l1-reader]";

// ============================
// SQLite-based queries (preferred)
// ============================
// 中文：基于SQLite的查询（首选）

/**
 * Query L1 memory records from SQLite via VectorStore.
 *
 * This is the **preferred** read path — it uses the composite index
 * `idx_l1_session_updated(session_id, updated_time)` for efficient
 * session-scoped and time-range queries.
 *
 * All timestamps are UTC ISO 8601 (as stored by l1-writer's dual-write).
 *
 * Falls back to empty array if VectorStore is null or degraded.
 * 中文：通过VectorStore从SQLite查询L1内存记录。
 * 这是**首选**读路径——它使用复合索引`idx_l1_session_updated(session_id, updated_time)`进行高效的会话范围和时间区间查询。
 * 所有时间戳均为UTC ISO 8601（由l1-writer的双写存储）。当VectorStore为空或降级时，退回到空数组。
 */
export async function queryMemoryRecords(
  vectorStore: IMemoryStore | null | undefined,
  filter?: L1QueryFilter,
  logger?: Logger,
): Promise<MemoryRecord[]> {
  if (!vectorStore) {
    logger?.warn(`${TAG} queryMemoryRecords: no VectorStore available, returning empty`);
    return [];
  }

  const rows = await vectorStore.queryL1Records(filter);
  return rows.map(rowToMemoryRecord);
}

/**
 * Convert a raw SQLite L1RecordRow to a MemoryRecord (same shape as JSONL records).
 * 中文：将原始SQLite L1RecordRow转换为MemoryRecord（与JSONL记录相同格式）
 */
function rowToMemoryRecord(row: L1RecordRow): MemoryRecord {
  let metadata: EpisodicMetadata | Record<string, never> = {};
  try {
    metadata = JSON.parse(row.metadata_json) as EpisodicMetadata | Record<string, never>;
  } catch {
    // malformed JSON — use empty object
    // 中文：无效的JSON——使用空对象
  }

  // Reconstruct timestamps array from timestamp_start / timestamp_end
  // 中文：从timestamp_start / timestamp_end重构时间戳数组
  const timestamps: string[] = [];
  if (row.timestamp_str) timestamps.push(row.timestamp_str);
  if (row.timestamp_start && row.timestamp_start !== row.timestamp_str) timestamps.push(row.timestamp_start);
  if (row.timestamp_end && row.timestamp_end !== row.timestamp_str && row.timestamp_end !== row.timestamp_start) {
    timestamps.push(row.timestamp_end);
  }

  return {
    id: row.record_id,
    content: row.content,
    type: row.type as MemoryType,
    priority: row.priority,
    scene_name: row.scene_name,
    source_message_ids: [], // not stored in SQLite (vector search doesn't need them)
    // 中文：不存储在SQLite中（向量搜索不需要它们）
    metadata,
    timestamps,
    createdAt: row.created_time,
    updatedAt: row.updated_time,
    sessionKey: row.session_key,
    sessionId: row.session_id,
  };
}

// ============================
// JSONL-based reads (fallback)
// ============================
// 中文：基于JSONL的读取（备用）

/**
 * Read all memory records for a session from JSONL files.
 *
 * Current naming mode:
 * - Daily merged file: records/YYYY-MM-DD.jsonl (all sessions in one file)
 * 中文：读取会话的全部内存记录从JSONL文件。
 * 当前命名模式：
 * - 每日合并文件：records/YYYY-MM-DD.jsonl（一个文件中包含所有会话）
 */
export async function readMemoryRecords(
  sessionKey: string,
  baseDir: string,
  logger?: Logger,
): Promise<MemoryRecord[]> {
  const recordsDir = path.join(baseDir, "records");
  const dateFilePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(recordsDir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist yet
    // 中文：目录尚不存在
    return [];
  }

  const targetFiles = entries
    .filter((entry) => entry.isFile() && dateFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (targetFiles.length === 0) {
    return [];
  }

  const records: MemoryRecord[] = [];

  for (const fileName of targetFiles) {
    const filePath = path.join(recordsDir, fileName);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      logger?.warn?.(`${TAG} Failed to read L1 file: ${filePath}`);
      continue;
    }

    const lines = raw.split("\n").filter((line) => line.trim());
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const parsed = JSON.parse(line) as Partial<MemoryRecord>;
        if (parsed.sessionKey !== sessionKey) {
          continue;
        }
        records.push(parsed as MemoryRecord);
      } catch {
        logger?.warn?.(`${TAG} Skipping malformed JSONL line in ${filePath}:${i + 1}`);
      }
    }
  }

  records.sort((a, b) => {
    const ta = a.updatedAt || a.createdAt || "";
    const tb = b.updatedAt || b.createdAt || "";
    return ta.localeCompare(tb);
  });

  return records;
}

/**
 * Read ALL memory records across all session JSONL files.
 * 中文：读取所有会话的全部内存记录从JSONL文件。
 */
export async function readAllMemoryRecords(
  baseDir: string,
  logger?: Logger,
): Promise<MemoryRecord[]> {
  const recordsDir = path.join(baseDir, "records");
  try {
    const files = await fs.readdir(recordsDir);
    const allRecords: MemoryRecord[] = [];

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(recordsDir, file);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const lines = raw.split("\n").filter((line: string) => line.trim());
        for (const line of lines) {
          try {
            allRecords.push(JSON.parse(line) as MemoryRecord);
          } catch {
            logger?.warn?.(`${TAG} Skipping malformed JSONL line in ${file}`);
          }
        }
      } catch {
        logger?.warn?.(`${TAG} Failed to read ${file}`);
      }
    }

    allRecords.sort((a, b) => {
      const ta = a.updatedAt || a.createdAt || "";
      const tb = b.updatedAt || b.createdAt || "";
      return ta.localeCompare(tb);
    });

    return allRecords;

  } catch {
    // records/ directory doesn't exist yet
    // 中文：records/ 目录尚不存在
    return [];
  }
}

// ============================
// Helpers
// ============================
// 中文：辅助

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}
