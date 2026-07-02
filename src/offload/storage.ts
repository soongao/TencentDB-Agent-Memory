/**
 * File I/O layer for the context offload plugin.
 *
 * Multi-agent / multi-session storage isolation:
 *   - Different agents get separate subdirectories under dataRoot
 *   - Same agent shares mmds/, refs/, state.json
 *   - offload is per-session: offload-<sessionId>.jsonl
 *   - L2 aggregation reads all offload-*.jsonl in the agent dir
 *   - All I/O functions require a StorageContext (no global mutable state)
 * 中文：上下文卸载插件的文件I/O层。
 * 多代理/多会话存储隔离：
 * - 不同代理各自拥有dataRoot下的子目录
 * - 同一代理共享mmds/, refs/, state.json
 * - 卸载操作按会话进行：offload-<sessionId>.jsonl
 * - L2聚合读取代理目录下所有offload-*.jsonl文件
 * - 所有I/O函数都需要一个StorageContext（无全局可变状态）
 */
import { readFile, writeFile, appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type { OffloadEntry, PluginLogger } from "./types.js";

/** Default root data directory (parent of all agent subdirectories) */
/** 中文：默认根数据目录（所有代理子目录的父目录） */
export const DEFAULT_DATA_ROOT = join(homedir(), ".openclaw", "context-offload");

// ─── StorageContext ──────────────────────────────────────────────────────────
// 中文：─── StorageContext ──────────────────────────────────────────────────────────

/** Immutable per-session storage path context. Created once per session switch. */
/** 中文：每次会话切换时创建一次的不可变会话存储路径上下文。 */
export interface StorageContext {
  readonly dataRoot: string;
  readonly dataDir: string;
  readonly refsDir: string;
  readonly mmdsDir: string;
  readonly offloadJsonl: string;
  readonly stateFile: string;
  readonly agentName: string;
  readonly sessionId: string;
}

/**
 * Build an immutable StorageContext for a given agent + session.
 * Once created, paths are frozen and cannot be affected by other sessions.
 * 中文：为给定的代理+会话构建一个不可变的StorageContext。
 * 一旦创建，路径将被冻结且不受其他会话影响。
 */
export function createStorageContext(
  dataRoot: string,
  agentName: string,
  sessionId: string,
): StorageContext {
  const dataDir = join(dataRoot, agentName);
  return Object.freeze({
    dataRoot,
    dataDir,
    refsDir: join(dataDir, "refs"),
    mmdsDir: join(dataDir, "mmds"),
    offloadJsonl: join(dataDir, `offload-${sessionId}.jsonl`),
    stateFile: join(dataDir, "state.json"),
    agentName,
    sessionId,
  });
}

// ─── SessionKey Parsing ──────────────────────────────────────────────────────
// 中文：─── 会话键解析 ──────────────────────────────────────────────────────

/** Sanitize a string for use as a directory/file name */
/** 中文：对用于目录/文件名使用的字符串进行清理 */
function sanitizePath(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\.{2,}/g, "_");
}

/**
 * Parse a sessionKey into agentName and sessionId.
 * Expected format: "agent:<agent-name>:<session-id>"
 *
 * Worker isolation: if the sessionId contains a "swebench-w{N}" pattern
 * (from multi-worker inference), the worker suffix is merged into agentName
 * so each worker gets its own dataDir (state.json, mmds/, refs/).
 *
 * Returns null if format doesn't match.
 * 中文：将sessionKey解析为agentName和sessionId。
 * 预期格式："agent:<代理名称>:<会话ID>"
 * 工作者隔离：如果sessionId包含"swebench-w{N}"模式（来自多工作者推理），则会在agentName中合并工作符后缀
 * 以使每个工作者拥有自己的dataDir（state.json, mmds/, refs/）。
 * 若格式不匹配，则返回null
 */
export function parseSessionKey(
  sessionKey: string,
): { agentName: string; sessionId: string } | null {
  if (typeof sessionKey !== "string") return null;
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent" || !parts[1]) return null;
  let agentName = parts[1];
  const sessionId = parts.slice(2).join(":");
  if (!sessionId) return null;
  const workerMatch = sessionId.match(/swebench-w(\d+)/);
  if (workerMatch) {
    agentName = `${agentName}-w${workerMatch[1]}`;
  }
  return {
    agentName: sanitizePath(agentName),
    sessionId: sanitizePath(sessionId),
  };
}

// ─── Directory Operations ────────────────────────────────────────────────────
// 中文：─── 目录操作 ─────────────────────────────────────────────────────

/** Ensure all required directories exist for the given context */
/** 中文：确保给定上下文中所有所需的目录都存在 */
export async function ensureDirs(ctx: StorageContext): Promise<void> {
  await mkdir(ctx.dataRoot, { recursive: true });
  await mkdir(ctx.dataDir, { recursive: true });
  await mkdir(ctx.refsDir, { recursive: true });
  await mkdir(ctx.mmdsDir, { recursive: true });
}

// ─── Session Registry ────────────────────────────────────────────────────────
// 中文：─── 会话注册表 ───────────────────────────────────────────────────────

/** Record a sessionKey → realSessionId mapping in the agent's registry. */
/** 中文：在代理的注册表中记录一个 sessionKey → realSessionId 映射。 */
export async function registerSession(
  ctx: StorageContext,
  sessionKey: string,
  realSessionId: string,
): Promise<void> {
  if (!sessionKey || !realSessionId || !existsSync(ctx.dataDir)) return;
  const registryPath = join(ctx.dataDir, "sessions-registry.json");
  let registry: Record<string, unknown> = {};
  try {
    if (existsSync(registryPath)) {
      registry = JSON.parse(await readFile(registryPath, "utf-8"));
    }
  } catch {
    /* corrupt file, start fresh */
    /** 中文：corrupt file, start fresh */
  }
  registry[sessionKey] = {
    sessionId: realSessionId,
    offloadFile: `offload-${realSessionId}.jsonl`,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

/** Look up the real sessionId for a given sessionKey from the registry. */
/** 中文：从注册表中查找给定 sessionKey 对应的真实 sessionId。 */
export async function lookupSessionId(
  ctx: StorageContext,
  sessionKey: string,
): Promise<string | null> {
  if (!sessionKey || !existsSync(ctx.dataDir)) return null;
  const registryPath = join(ctx.dataDir, "sessions-registry.json");
  try {
    if (!existsSync(registryPath)) return null;
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as Record<string, { sessionId?: string }>;
    return registry[sessionKey]?.sessionId ?? null;
  } catch {
    return null;
  }
}

/** List all registered sessions for the given context. */
/** 中文：为给定上下文列出所有已注册的会话。 */
export async function listRegisteredSessions(
  ctx: StorageContext,
): Promise<Array<{ sessionKey: string; [key: string]: unknown }>> {
  if (!existsSync(ctx.dataDir)) return [];
  const registryPath = join(ctx.dataDir, "sessions-registry.json");
  try {
    if (!existsSync(registryPath)) return [];
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as Record<string, Record<string, unknown>>;
    return Object.entries(registry).map(([key, val]) => ({
      sessionKey: key,
      ...val,
    }));
  } catch {
    return [];
  }
}

// ─── JSONL Defense Layer ─────────────────────────────────────────────────────
// 中文：─── JSONL 防御层 ─────────────────────────────────────────────────────

const UNSAFE_CHAR_RE =
  /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u0080-\u009F\uD800-\uDFFF\u200B-\u200F\u2028\u2029\uFEFF]/gu;

/** Layer 0 — Source text sanitize. Strips unsafe characters from arbitrary text. */
/** 中文：层 0 — 源文本净化。从任意文本中移除不安全字符。 */
export function sanitizeText(text: string): string {
  if (typeof text !== "string") return text;
  return text.replace(UNSAFE_CHAR_RE, "");
}

/** Layer 1 — Write sanitize. Strips unsafe characters from a JSON string with roundtrip verification. */
/** 中文：层 1 — 写入净化。从带有回程验证的 JSON 字符串中移除不安全字符。 */
export function sanitizeJsonLine(jsonStr: string): string {
  let cleaned = jsonStr.replace(UNSAFE_CHAR_RE, "");
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    /* fall through */
    /** 中文：fall through */
  }
  cleaned = jsonStr.replace(
    /[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/g,
    "",
  );
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    /* fall through */
    /** 中文：fall through */
  }
  try {
    const obj = JSON.parse(jsonStr.replace(/[^\x20-\x7E\t\n\r]/g, ""));
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

/** Layer 3 — Entry schema validation. */
/** 中文：层 3 — 入口模式验证。 */
export function validateEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.tool_call_id !== "string" || (e.tool_call_id as string).length === 0)
    return false;
  return true;
}

/** Layer 2+3+4 — Safe JSONL parser with tolerance, validation, and metrics. */
/** 中文：层 2+3+4 — 具有容错、验证和指标的稳健 JSONL 解析器。 */
export function parseJsonlSafe(
  content: string,
  options?: { sourceLabel?: string; skipValidation?: boolean },
): {
  entries: Array<Record<string, unknown>>;
  corruptCount: number;
  invalidCount: number;
  corruptSample: string | null;
} {
  const entries: Array<Record<string, unknown>> = [];
  let corruptCount = 0;
  let invalidCount = 0;
  let corruptSample: string | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      try {
        parsed = JSON.parse(trimmed.replace(UNSAFE_CHAR_RE, ""));
      } catch {
        corruptCount++;
        if (corruptSample === null) {
          corruptSample = trimmed.slice(0, 200);
        }
        continue;
      }
    }
    if (!options?.skipValidation && !validateEntry(parsed)) {
      invalidCount++;
      continue;
    }
    entries.push(parsed as Record<string, unknown>);
  }
  return { entries, corruptCount, invalidCount, corruptSample };
}

function safeStringifyEntry(entry: Record<string, unknown>): string {
  return sanitizeJsonLine(JSON.stringify(entry));
}

// ─── JSONL Operations (current session) ──────────────────────────────────────
// 中文：─── JSONL 操作（当前会话） ──────────────────────────────────────

/** Append one or more entries to an offload JSONL with write-time dedup. */
/** 中文：在 offload JSONL 中追加一个或多个条目，并在写入时去重。 */
export async function appendOffloadEntries(
  ctx: StorageContext,
  entries: OffloadEntry[],
  targetSessionId?: string,
  logger?: PluginLogger,
): Promise<void> {
  const filePath =
    targetSessionId && targetSessionId !== ctx.sessionId
      ? join(ctx.dataDir, `offload-${targetSessionId}.jsonl`)
      : ctx.offloadJsonl;

  let newEntries: OffloadEntry[] = entries;
  if (existsSync(filePath)) {
    try {
      const existingContent = await readFile(filePath, "utf-8");
      const existingIds = new Set<string>();
      for (const line of existingContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof parsed.tool_call_id === "string") {
            existingIds.add(parsed.tool_call_id);
            const norm = (parsed.tool_call_id as string).replace(/_/g, "");
            if (norm !== parsed.tool_call_id) existingIds.add(norm);
          }
        } catch {
          /* skip corrupt lines */
          /** 中文：跳过损坏的行 */
        }
      }

      if (existingIds.size > 0) {
        const before = newEntries.length;
        const duplicates: string[] = [];
        newEntries = entries.filter((e) => {
          const id = e.tool_call_id;
          if (!id) return true;
          const norm = id.replace(/_/g, "");
          if (existingIds.has(id) || existingIds.has(norm)) {
            duplicates.push(id);
            return false;
          }
          return true;
        });
        if (duplicates.length > 0) {
          logger?.warn?.(
            `[context-offload] appendOffloadEntries DEDUP: ${duplicates.length}/${before} entries are duplicates, writing ${newEntries.length}. file=${basename(filePath)} duplicateIds=[${duplicates.join(",")}]`,
          );
        }
      }
    } catch {
      /* If reading existing file fails, proceed without dedup */
      /** 中文：若读取现有文件失败，则不进行去重处理 */
    }
  }

  if (newEntries.length === 0) {
    logger?.info?.(
      `[context-offload] appendOffloadEntries: all ${entries.length} entries deduped, nothing to write`,
    );
    return;
  }

  const lines = newEntries.map((e) => safeStringifyEntry(e as unknown as Record<string, unknown>)).join("\n") + "\n";
  await appendFile(filePath, lines, "utf-8");
}

/** Read all entries from the current session's offload JSONL. */
/** 中文：从当前会话的卸载JSONL中读取所有条目 */
export async function readOffloadEntries(
  ctx: StorageContext,
  logger?: PluginLogger,
): Promise<OffloadEntry[]> {
  if (!existsSync(ctx.offloadJsonl)) return [];
  let content: string;
  try {
    content = await readFile(ctx.offloadJsonl, "utf-8");
  } catch (err) {
    logger?.warn?.(
      `[context-offload] readOffloadEntries: failed to read ${ctx.offloadJsonl}: ${(err as Error).message}`,
    );
    return [];
  }
  const { entries, corruptCount, invalidCount, corruptSample } = parseJsonlSafe(
    content,
    { sourceLabel: basename(ctx.offloadJsonl) },
  );
  if (corruptCount > 0 || invalidCount > 0) {
    logger?.warn?.(
      `[context-offload] readOffloadEntries: skipped ${corruptCount} corrupt + ${invalidCount} invalid lines in ${basename(ctx.offloadJsonl)}. Sample: ${corruptSample?.slice(0, 100)}`,
    );
  }
  return entries as unknown as OffloadEntry[];
}

/** Rewrite the current session's offload JSONL with the given entries (sanitized) */
/** 中文：使用给定条目（已清理）重写当前会话的卸载JSONL */
export async function rewriteOffloadEntries(
  ctx: StorageContext,
  entries: OffloadEntry[],
): Promise<void> {
  const content =
    entries.map((e) => safeStringifyEntry(e as unknown as Record<string, unknown>)).join("\n") +
    (entries.length > 0 ? "\n" : "");
  await writeFile(ctx.offloadJsonl, content, "utf-8");
}

/** Mark offload entries by tool_call_id with an `offloaded` status. */
/** 中文：通过`offloaded`状态标记卸载条目，标识tool_call_id */
export async function markOffloadStatus(
  ctx: StorageContext,
  updates: Map<string, string | boolean>,
): Promise<void> {
  if (!existsSync(ctx.offloadJsonl) || updates.size === 0) return;
  const entries = (await readOffloadEntries(ctx)) as Array<OffloadEntry & { offloaded?: string | boolean }>;
  let changed = false;
  for (const entry of entries) {
    const status = updates.get(entry.tool_call_id);
    if (status !== undefined && entry.offloaded !== status) {
      entry.offloaded = status;
      changed = true;
    }
  }
  if (changed) {
    await rewriteOffloadEntries(ctx, entries);
  }
}

/** Extract confirmed (offloaded) tool_call_ids from entries. */
/** 中文：从条目中提取确认（已卸载）的tool_call_ids */
export function extractConfirmedIdsFromEntries(
  entries: Array<OffloadEntry & { offloaded?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.offloaded) {
      const id = entry.tool_call_id;
      if (!id) continue;
      ids.add(id);
      const normalized = id.replace(/_/g, "");
      if (normalized !== id) ids.add(normalized);
    }
  }
  return ids;
}

/** Extract aggressively deleted tool_call_ids from entries. */
/** 中文：从条目中提取激进删除的tool_call_ids */
export function extractDeletedIdsFromEntries(
  entries: Array<OffloadEntry & { offloaded?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.offloaded === "deleted") {
      const id = entry.tool_call_id;
      if (!id) continue;
      ids.add(id);
      const normalized = id.replace(/_/g, "");
      if (normalized !== id) ids.add(normalized);
    }
  }
  return ids;
}

// ─── JSONL Operations (all sessions under current agent) ─────────────────────
// 中文：─── JSONL 操作 （当前代理下的所有会话） ─────────────────────

/** Read offload entries from ALL session files under ctx.dataDir. */
/** 中文：从ctx.dataDir下的所有会话文件中读取卸载条目。 */
export async function readAllOffloadEntries(
  ctx: StorageContext,
  logger?: PluginLogger,
): Promise<Array<OffloadEntry & { _sourceFile?: string }>> {
  if (!existsSync(ctx.dataDir)) return [];
  let files: string[];
  try {
    files = await readdir(ctx.dataDir);
  } catch (err) {
    logger?.warn?.(
      `[context-offload] readAllOffloadEntries: failed to readdir ${ctx.dataDir}: ${(err as Error).message}`,
    );
    return [];
  }
  const offloadFiles = files
    .filter((f) => f.startsWith("offload-") && f.endsWith(".jsonl"))
    .sort();
  if (offloadFiles.length === 0) return [];
  const allEntries: Array<OffloadEntry & { _sourceFile?: string }> = [];
  let totalCorrupt = 0;
  let totalInvalid = 0;
  await Promise.all(
    offloadFiles.map(async (filename) => {
      try {
        const filePath = join(ctx.dataDir, filename);
        const content = await readFile(filePath, "utf-8");
        const { entries, corruptCount, invalidCount } = parseJsonlSafe(content, {
          sourceLabel: filename,
        });
        totalCorrupt += corruptCount;
        totalInvalid += invalidCount;
        for (const entry of entries) {
          (entry as Record<string, unknown>)._sourceFile = filename;
          allEntries.push(entry as unknown as OffloadEntry & { _sourceFile?: string });
        }
      } catch (err) {
        logger?.warn?.(
          `[context-offload] readAllOffloadEntries: failed to read ${filename}: ${(err as Error).message}`,
        );
      }
    }),
  );
  if (totalCorrupt > 0 || totalInvalid > 0) {
    logger?.warn?.(
      `[context-offload] readAllOffloadEntries: skipped ${totalCorrupt} corrupt + ${totalInvalid} invalid lines across ${offloadFiles.length} files`,
    );
  }
  return allEntries;
}

/** Write entries back to their respective source files. */
/** 中文：将条目写回其各自的源文件中。 */
export async function rewriteAllOffloadEntries(
  ctx: StorageContext,
  entries: Array<Record<string, unknown> | any>,
): Promise<void> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const entry of entries) {
    const sourceFile = (entry._sourceFile as string) ?? basename(ctx.offloadJsonl);
    if (!groups.has(sourceFile)) {
      groups.set(sourceFile, []);
    }
    const clean = { ...entry };
    delete clean._sourceFile;
    groups.get(sourceFile)!.push(clean);
  }
  if (existsSync(ctx.dataDir)) {
    const files = await readdir(ctx.dataDir);
    const offloadFiles = files.filter(
      (f) => f.startsWith("offload-") && f.endsWith(".jsonl"),
    );
    for (const f of offloadFiles) {
      if (!groups.has(f)) {
        groups.set(f, []);
      }
    }
  }
  await Promise.all(
    Array.from(groups.entries()).map(async ([filename, fileEntries]) => {
      const filePath = join(ctx.dataDir, filename);
      const content =
        fileEntries.map(safeStringifyEntry).join("\n") +
        (fileEntries.length > 0 ? "\n" : "");
      await writeFile(filePath, content, "utf-8");
    }),
  );
}

/** Update specific entries by tool_call_id across ALL session files (L2 backfill). */
/** 中文：跨所有会话文件（L2回填）更新特定条目 by tool_call_id。 */
export async function updateOffloadNodeIds(
  ctx: StorageContext,
  updates: Map<string, string>,
): Promise<void> {
  const entries = await readAllOffloadEntries(ctx);
  let changed = false;
  for (const entry of entries) {
    const newNodeId = updates.get(entry.tool_call_id);
    if (newNodeId !== undefined) {
      entry.node_id = newNodeId;
      changed = true;
    }
  }
  if (changed) {
    await rewriteAllOffloadEntries(ctx, entries as unknown as Array<Record<string, unknown>>);
  }
}

// ─── MD (Tool Result Refs) Operations ────────────────────────────────────────
// 中文：──────── MD (工具结果引用) 操作 ────────────────────────────────────────

/** Convert ISO 8601 timestamp to a safe filename (replace special chars) */
/** 中文：将ISO 8601时间戳转换为安全的文件名（替换特殊字符）。 */
export function isoToFilename(iso: string): string {
  return iso.replace(/:/g, "-").replace(/\./g, "-").replace(/\+/g, "p");
}

/** Write tool result content to a ref MD file, return relative path */
/** 中文：将工具结果内容写入一个ref MD文件，返回相对路径。 */
export async function writeRefMd(
  ctx: StorageContext,
  timestamp: string,
  toolName: string,
  content: string,
): Promise<string> {
  const filename = `${isoToFilename(timestamp)}.md`;
  const filePath = join(ctx.refsDir, filename);
  const safeContent = (content ?? "").replace(UNSAFE_CHAR_RE, "");
  const header = `# Tool Result: ${toolName}\n\n**Timestamp:** ${timestamp}\n\n---\n\n`;
  await writeFile(filePath, header + safeContent, "utf-8");
  return `refs/${filename}`;
}

/** Read a ref MD file by relative path */
/** 中文：通过相对路径读取一个ref MD文件。 */
export async function readRefMd(
  ctx: StorageContext,
  refPath: string,
): Promise<string | null> {
  const filePath = join(ctx.dataDir, refPath);
  if (!existsSync(filePath)) return null;
  return readFile(filePath, "utf-8");
}

// ─── MMD (Mermaid) Operations ────────────────────────────────────────────────
// 中文：──────── MMD (Mermaid) 操作 ────────────────────────────────────────────────

/** A single replace block for patchMmd */
/** 中文：单个替换块，用于patchMmd */
export interface MmdReplaceBlock {
  /** 1-based start line number (inclusive) */
  /** 中文：起始行号（1基于，包含） */
  startLine: number;
  /** 1-based end line number (inclusive). If endLine < startLine, treat as pure insertion */
  /** 中文：结束行号（1基于，包含）。若endLine < startLine，视为纯插入 */
  endLine: number;
  /** Replacement content (may contain newlines) */
  /** 中文：替换内容（可能包含换行符） */
  content: string;
}

/** Write/overwrite an MMD file */
/** 中文：写入/覆盖一个MMD文件 */
export async function writeMmd(
  ctx: StorageContext,
  filename: string,
  content: string,
): Promise<void> {
  const filePath = join(ctx.mmdsDir, filename);
  await writeFile(filePath, content, "utf-8");
}

/** Apply incremental line-based replace blocks to an existing MMD file. */
/** 中文：将现有MMD文件应用增量的行级替换块 */
export async function patchMmd(
  ctx: StorageContext,
  filename: string,
  blocks: MmdReplaceBlock[],
): Promise<boolean> {
  const filePath = join(ctx.mmdsDir, filename);
  const original = await readMmd(ctx, filename);
  if (original === null) return false;
  const lines = original.split("\n");
  let allValid = true;
  const sorted = [...blocks].sort((a, b) => b.startLine - a.startLine);
  for (const block of sorted) {
    const start = block.startLine;
    const end = block.endLine;
    if (start < 1 || start > lines.length + 1) {
      allValid = false;
      continue;
    }
    const newContentLines = block.content ? block.content.split("\n") : [];
    if (end < start) {
      lines.splice(start - 1, 0, ...newContentLines);
    } else {
      const clampedEnd = Math.min(end, lines.length);
      const deleteCount = clampedEnd - start + 1;
      lines.splice(start - 1, deleteCount, ...newContentLines);
    }
  }
  const newContent = lines.join("\n");
  if (newContent !== original) {
    await writeFile(filePath, newContent, "utf-8");
  }
  return allValid;
}

/** Read an MMD file */
/** 中文：读取一个MMD文件 */
export async function readMmd(
  ctx: StorageContext,
  filename: string,
): Promise<string | null> {
  const filePath = join(ctx.mmdsDir, filename);
  if (!existsSync(filePath)) return null;
  return readFile(filePath, "utf-8");
}

/** Delete an MMD file */
/** 中文：删除一个MMD文件 */
export async function deleteMmd(
  ctx: StorageContext,
  filename: string,
): Promise<boolean> {
  const filePath = join(ctx.mmdsDir, filename);
  if (!existsSync(filePath)) return false;
  await unlink(filePath);
  return true;
}

/** List all MMD files in the mmds directory */
/** 中文：列出mmds目录中的所有MMD文件 */
export async function listMmds(ctx: StorageContext): Promise<string[]> {
  if (!existsSync(ctx.mmdsDir)) return [];
  const files = await readdir(ctx.mmdsDir);
  return files.filter((f) => f.endsWith(".mmd")).sort();
}

// ─── State File Operations ───────────────────────────────────────────────────
// 中文：─── 状态文件操作 ───────────────────────────────────────────────────

/** Read the state.json file */
/** 中文：读取state.json文件 */
export async function readStateFile<T>(
  ctx: StorageContext,
  defaultValue: T,
): Promise<T> {
  if (!existsSync(ctx.stateFile)) return defaultValue;
  try {
    const content = await readFile(ctx.stateFile, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return defaultValue;
  }
}

/** Write the state.json file */
/** 中文：写入state.json文件 */
export async function writeStateFile<T>(
  ctx: StorageContext,
  state: T,
): Promise<void> {
  await mkdir(dirname(ctx.stateFile), { recursive: true });
  await writeFile(ctx.stateFile, JSON.stringify(state, null, 2), "utf-8");
}
