/**
 * OffloadReclaimer: periodic cleanup of stale offload data files.
 *
 * Reclaims disk space by removing:
 *   Step 1 — Expired session JSONL files (offload-*.jsonl)
 *   Step 2 — Orphaned ref MD files (refs/*.md)
 *   Step 3 — Expired MMD files (mmds/*.mmd), protecting active MMD
 *   Step 4 — Oversized debug log files (*.log truncation)
 *   Step 5 — Stale sessions-registry.json entries
 *
 * Each step is independently try/caught — a failure in one step
 * does not prevent subsequent steps from running.
 *
 * All file-age checks use mtime (last modification time).
 * 中文：OffloadReclaimer: 定期清理过时的卸载数据文件。
 * 回收磁盘空间，移除：
 * 步骤1 — 过期会话JSONL文件（offload-*.jsonl）
 * 步骤2 — 孤立引用MD文件（refs/*.md）
 * 步骤3 — 过期MMD文件（mmds/*.mmd），保护活动中的MMD
 * 步骤4 — 超大尺寸调试日志文件 (*.log 截断)
 * 步骤5 — 陈旧的sessions-registry.json条目
 * 每一步独立尝试/捕获——某一步失败不会阻止后续步骤运行。
 * 所有文件年龄检查使用mtime（最后修改时间）。
 */

import { readdir, stat, unlink, readFile, writeFile, rename, truncate } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { parseJsonlSafe } from "./storage.js";
import type { PluginLogger } from "./types.js";

// ============================
// Public types
// ============================
// 中文：Public types

/** Configuration for the reclaim operation. */
/** 中文：回收操作的配置。 */
export interface ReclaimConfig {
  /** Retention period in days. Values < 3 disable reclamation entirely. */
  /** 中文：保留期，以天为单位。值小于3完全禁用回收。 */
  retentionDays: number;
  /** Max total size in MB for debug log files. 0 = no log rotation. */
  /** 中文：调试日志文件的最大总大小，以MB为单位。0 = 无日志轮转。 */
  logMaxSizeMb: number;
}

/** Statistics returned after a reclaim run. */
/** 中文：回收运行后返回的统计数据。 */
export interface ReclaimStats {
  deletedJsonl: number;
  deletedRefs: number;
  deletedMmds: number;
  truncatedLogs: number;
  prunedRegistryEntries: number;
}

// ============================
// Constants
// ============================
// 中文：常量

const TAG = "[context-offload][reclaim]";
const MS_PER_DAY = 86_400_000;

// ============================
// Main entry
// ============================
// 中文：主入口

/**
 * Run a full reclamation pass over the offload data directory.
 *
 * Safe to call concurrently (each step is idempotent) but designed
 * for single-caller-per-process via a 24h setInterval.
 * 中文：对卸载数据目录进行完整的回收处理。
 * 并发调用是安全的（每一步都是幂等的），但设计为单进程单调用者通过24小时setInterval实现。
 */
export async function reclaimOffloadData(
  dataRoot: string,
  config: ReclaimConfig,
  logger: PluginLogger,
): Promise<ReclaimStats> {
  const stats: ReclaimStats = {
    deletedJsonl: 0,
    deletedRefs: 0,
    deletedMmds: 0,
    truncatedLogs: 0,
    prunedRegistryEntries: 0,
  };

  if (config.retentionDays < 3) {
    logger.debug?.(`${TAG} Skipped: retentionDays=${config.retentionDays} (min effective: 3)`);
    return stats;
  }

  if (!existsSync(dataRoot)) {
    logger.debug?.(`${TAG} Skipped: dataRoot does not exist: ${dataRoot}`);
    return stats;
  }

  const nowMs = Date.now();
  const cutoffMs = nowMs - config.retentionDays * MS_PER_DAY;

  // Discover agent subdirectories (directories inside dataRoot)
  // 中文：发现agent子目录（dataRoot内的目录）
  const agentDirs = await discoverAgentDirs(dataRoot);

  // Step 1: Clean expired session JSONL
  // 中文：步骤1：清理过期会话JSONL
  try {
    stats.deletedJsonl = await reclaimExpiredJsonl(dataRoot, agentDirs, cutoffMs, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 1 (JSONL) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: Clean orphan ref MD
  // 中文：步骤2：清理孤儿ref MD
  try {
    stats.deletedRefs = await reclaimOrphanRefs(agentDirs, cutoffMs, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 2 (refs) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3: Clean expired MMD
  // 中文：步骤3：清理过期MMD
  try {
    stats.deletedMmds = await reclaimExpiredMmds(agentDirs, cutoffMs, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 3 (MMDs) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4: Log rotation
  // 中文：步骤4：日志轮转
  try {
    stats.truncatedLogs = await rotateDebugLogs(dataRoot, config.logMaxSizeMb, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 4 (logs) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 5: Registry pruning
  // 中文：步骤5：注册表修剪
  try {
    stats.prunedRegistryEntries = await pruneRegistries(agentDirs, cutoffMs, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 5 (registry) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return stats;
}

// ============================
// Step helpers
// ============================
// 中文：步骤助手

/** Discover agent subdirectories under dataRoot. */
/** 中文：发现dataRoot下的agent子目录。 */
async function discoverAgentDirs(dataRoot: string): Promise<string[]> {
  const entries = await readdir(dataRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(dataRoot, e.name));
}

// ─── Step 1: Expired JSONL ───────────────────────────────────────────────────
// 中文：─── 步骤1：过期的JSONL ───────────────────────────────────────────────────

async function reclaimExpiredJsonl(
  dataRoot: string,
  agentDirs: string[],
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  let deleted = 0;

  // Scan dataRoot for root-level offload-*.jsonl (legacy layout)
  // 中文：在dataRoot中扫描根级的offload-*.jsonl（遗留布局）
  deleted += await deleteExpiredJsonlInDir(dataRoot, cutoffMs, logger);

  // Scan each agent directory
  // 中文：扫描每个agent目录
  for (const dir of agentDirs) {
    deleted += await deleteExpiredJsonlInDir(dir, cutoffMs, logger);
  }

  return deleted;
}

async function deleteExpiredJsonlInDir(
  dir: string,
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  let deleted = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const jsonlFiles = entries.filter((f) => f.startsWith("offload-") && f.endsWith(".jsonl"));
  for (const file of jsonlFiles) {
    const filePath = join(dir, file);
    try {
      const s = await stat(filePath);
      if (s.mtimeMs < cutoffMs) {
        await unlink(filePath);
        deleted++;
        logger.debug?.(`${TAG} Step 1: deleted expired JSONL: ${filePath} (mtime=${new Date(s.mtimeMs).toISOString()})`);
      }
    } catch (err) {
      logger.warn(`${TAG} Step 1: failed to process ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sync-clean sessions-registry.json: remove entries whose offloadFile was deleted
  // 中文：同步清理sessions-registry.json：移除offloadFile已被删除的条目
  if (deleted > 0) {
    await syncRegistryAfterJsonlDeletion(dir, logger);
  }

  return deleted;
}

/** Remove registry entries whose offloadFile no longer exists on disk. */
/** 中文：移除offloadFile在磁盘上不再存在的注册表条目。 */
async function syncRegistryAfterJsonlDeletion(dir: string, logger: PluginLogger): Promise<void> {
  const registryPath = join(dir, "sessions-registry.json");
  if (!existsSync(registryPath)) return;
  try {
    const raw = await readFile(registryPath, "utf-8");
    const registry = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    let changed = false;
    for (const [key, val] of Object.entries(registry)) {
      const offloadFile = val.offloadFile as string | undefined;
      if (offloadFile && !existsSync(join(dir, offloadFile))) {
        delete registry[key];
        changed = true;
      }
    }
    if (changed) {
      await atomicWriteJson(registryPath, registry);
    }
  } catch {
    /* best-effort */
    /** 中文：尽力而为 */
  }
}

// ─── Step 2: Orphan refs ─────────────────────────────────────────────────────
// 中文：─── 步骤2：孤立引用 ─────────────────────────────────────────────────────

async function reclaimOrphanRefs(
  agentDirs: string[],
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  let deleted = 0;

  for (const agentDir of agentDirs) {
    const refsDir = join(agentDir, "refs");
    if (!existsSync(refsDir)) continue;

    // Build set of referenced ref filenames from surviving JSONL files
    // 中文：从存活的JSONL文件中构建引用的ref文件名集合
    let referencedRefs: Set<string> | null = null;
    try {
      referencedRefs = await buildReferencedRefSet(agentDir);
    } catch {
      // Fall through: if we can't build the set, use mtime-only fallback
      // 中文：继续处理：如果无法构建集合，使用mtime仅回退
      logger.warn(`${TAG} Step 2: failed to build ref set for ${agentDir}, using mtime-only fallback`);
    }

    let refFiles: string[];
    try {
      refFiles = (await readdir(refsDir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const file of refFiles) {
      const filePath = join(refsDir, file);
      try {
        const isReferenced = referencedRefs !== null && referencedRefs.has(file);
        if (isReferenced) continue;

        // Not referenced (or ref set unavailable) — check mtime
        // 中文：未引用（或ref集不可用）——检查mtime
        const s = await stat(filePath);
        if (s.mtimeMs < cutoffMs) {
          await unlink(filePath);
          deleted++;
          logger.debug?.(`${TAG} Step 2: deleted orphan ref: ${filePath}`);
        }
      } catch {
        /* skip individual file errors */
        /** 中文：跳过个别文件错误 */
      }
    }
  }

  return deleted;
}

/** Parse all offload-*.jsonl in an agent dir, collect referenced ref filenames. */
/** 中文：解析agent目录下的所有offload-*.jsonl，收集引用的ref文件名。 */
async function buildReferencedRefSet(agentDir: string): Promise<Set<string>> {
  const refs = new Set<string>();
  let files: string[];
  try {
    files = await readdir(agentDir);
  } catch {
    return refs;
  }

  const jsonlFiles = files.filter((f) => f.startsWith("offload-") && f.endsWith(".jsonl"));
  for (const file of jsonlFiles) {
    try {
      const content = await readFile(join(agentDir, file), "utf-8");
      const { entries } = parseJsonlSafe(content, { skipValidation: true });
      for (const entry of entries) {
        const resultRef = entry.result_ref;
        if (typeof resultRef === "string" && resultRef.length > 0) {
          // result_ref format: "refs/2026-04-12T17-26-08-123p08-00.md"
          // 中文：result_ref格式: "refs/2026-04-12T17-26-08-123p08-00.md"
          refs.add(basename(resultRef));
        }
      }
    } catch {
      /* skip corrupt files */
      /** 中文：跳过损坏的文件 */
    }
  }

  return refs;
}

// ─── Step 3: Expired MMDs ────────────────────────────────────────────────────
// 中文：─── 步骤 3：过期的MMD ─────────────────────────────────────────────────────

/** Minimum number of MMD files to keep per agent, regardless of age. */
/** 中文：每个代理保留的MMD文件最小数量，不论年龄。 */
const MIN_KEEP_MMDS = 15;

async function reclaimExpiredMmds(
  agentDirs: string[],
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  let deleted = 0;

  for (const agentDir of agentDirs) {
    const mmdsDir = join(agentDir, "mmds");
    if (!existsSync(mmdsDir)) continue;

    // Read activeMmdFile from state.json to protect it
    // 中文：从state.json读取activeMmdFile以保护它
    let activeMmdFile: string | null = null;
    try {
      const stateFile = join(agentDir, "state.json");
      if (existsSync(stateFile)) {
        const stateRaw = await readFile(stateFile, "utf-8");
        const state = JSON.parse(stateRaw) as Record<string, unknown>;
        activeMmdFile = typeof state.activeMmdFile === "string" ? state.activeMmdFile : null;
      }
    } catch {
      /* state.json unreadable — proceed without protection (conservative: skip all) */
      /** 中文：state.json不可读——无需保护（保守策略：跳过所有） */
    }

    let mmdFiles: string[];
    try {
      mmdFiles = (await readdir(mmdsDir)).filter((f) => f.endsWith(".mmd"));
    } catch {
      continue;
    }

    // If total count <= MIN_KEEP_MMDS, nothing to delete
    // 中文：如果总数 <= MIN_KEEP_MMDS，则无删除操作
    if (mmdFiles.length <= MIN_KEEP_MMDS) continue;

    // Stat all files to get mtime, then sort oldest-first
    // 中文：统计所有文件以获取mtime，然后按最旧排序
    const fileMetas: Array<{ name: string; mtimeMs: number }> = [];
    for (const file of mmdFiles) {
      try {
        const s = await stat(join(mmdsDir, file));
        fileMetas.push({ name: file, mtimeMs: s.mtimeMs });
      } catch {
        /* skip unstat-able files */
        /** 中文：跳过无法统计的文件 */
      }
    }
    fileMetas.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    // 中文：最早优先

    // Walk oldest-first, delete expired ones but stop when we'd drop below MIN_KEEP_MMDS
    // 中文：按最旧顺序遍历，删除过期文件但停止在数量低于MIN_KEEP_MMDS时
    let remaining = fileMetas.length;
    for (const meta of fileMetas) {
      if (remaining <= MIN_KEEP_MMDS) break;
      if (meta.name === activeMmdFile) continue; // never delete active MMD
      // 中文：永不删除活动MMD
      if (meta.mtimeMs >= cutoffMs) continue;    // not expired
      // 中文：未过期

      const filePath = join(mmdsDir, meta.name);
      try {
        await unlink(filePath);
        deleted++;
        remaining--;
        logger.debug?.(`${TAG} Step 3: deleted expired MMD: ${filePath}`);
      } catch {
        /* skip */
      }
    }
  }

  return deleted;
}

// ─── Step 4: Log rotation ────────────────────────────────────────────────────
// 中文：─── 步骤 4：日志轮转 ───────────────────────────────────────────────────

async function rotateDebugLogs(
  dataRoot: string,
  logMaxSizeMb: number,
  logger: PluginLogger,
): Promise<number> {
  if (logMaxSizeMb <= 0) return 0;

  const maxBytes = logMaxSizeMb * 1024 * 1024;
  let entries: string[];
  try {
    entries = await readdir(dataRoot);
  } catch {
    return 0;
  }

  // Collect *.log and debug *.jsonl files (NOT offload-*.jsonl which are data)
  // 中文：收集*.log和debug *.jsonl文件（NOT offload-*.jsonl，这些是数据）
  const logFiles: Array<{ name: string; path: string; size: number }> = [];
  for (const name of entries) {
    const isLog = name.endsWith(".log");
    const isDebugJsonl = name.endsWith(".jsonl") && !name.startsWith("offload-");
    if (!isLog && !isDebugJsonl) continue;

    const filePath = join(dataRoot, name);
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        logFiles.push({ name, path: filePath, size: s.size });
      }
    } catch {
      /* skip */
    }
  }

  let totalSize = logFiles.reduce((sum, f) => sum + f.size, 0);
  if (totalSize <= maxBytes) return 0;

  // Sort by size descending — truncate largest first
  // 中文：按大小降序排序——先截断最大的
  logFiles.sort((a, b) => b.size - a.size);

  let truncated = 0;
  for (const file of logFiles) {
    if (totalSize <= maxBytes) break;
    if (file.size === 0) continue;

    try {
      await truncate(file.path, 0);
      totalSize -= file.size;
      truncated++;
      logger.debug?.(`${TAG} Step 4: truncated log: ${file.path} (was ${file.size} bytes)`);
    } catch (err) {
      logger.warn(`${TAG} Step 4: failed to truncate ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return truncated;
}

// ─── Step 5: Registry pruning ────────────────────────────────────────────────
// 中文：─── 步骤5：注册表修剪 ────────────────────────────────────────────────

async function pruneRegistries(
  agentDirs: string[],
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  let pruned = 0;

  for (const agentDir of agentDirs) {
    const registryPath = join(agentDir, "sessions-registry.json");
    if (!existsSync(registryPath)) continue;

    try {
      const raw = await readFile(registryPath, "utf-8");
      const registry = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      const originalCount = Object.keys(registry).length;
      let changed = false;

      for (const [key, val] of Object.entries(registry)) {
        const updatedAt = val.updatedAt;
        if (typeof updatedAt !== "string") continue;
        const updatedMs = new Date(updatedAt).getTime();
        if (Number.isNaN(updatedMs)) continue;
        if (updatedMs < cutoffMs) {
          delete registry[key];
          changed = true;
        }
      }

      if (changed) {
        const removedCount = originalCount - Object.keys(registry).length;
        pruned += removedCount;
        await atomicWriteJson(registryPath, registry);
        logger.debug?.(`${TAG} Step 5: pruned ${removedCount} expired entries from ${registryPath}`);
      }
    } catch (err) {
      logger.warn(`${TAG} Step 5: failed to prune ${registryPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return pruned;
}

// ============================
// Helpers
// ============================
// 中文：辅助函数

/** Atomic JSON write: write to tmp file, then rename into place. */
/** 中文：原子性JSON写入：先写入临时文件，然后重命名到位 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, filePath);
}
