/**
 * L2 Mermaid Generation Pipeline (Independent Trigger):
 *
 * L2 is NO LONGER triggered directly from L1. Instead it runs independently:
 *   - Trigger condition A: offload.jsonl has >= l2NullThreshold entries with node_id=null
 *   - Trigger condition B: time since last L2 trigger exceeds l2TimeoutSeconds
 * 中文：L2 Mermaid生成流水线（独立触发）:
 * L2不再直接从L1触发。而是独立运行：
 * - 触发条件A: offload.jsonl中有>= l2NullThreshold条目且node_id=null
 * - 触发条件B: 自上次L2触发以来的时间超过l2TimeoutSeconds
 */
import { PLUGIN_DEFAULTS, type OffloadEntry, type PluginConfig, type PluginLogger } from "../types.js";
import {
  readAllOffloadEntries,
  rewriteAllOffloadEntries,
  type StorageContext,
} from "../storage.js";
import type { OffloadStateManager } from "../state-manager.js";

function isHeartbeatEntry(entry: OffloadEntry): boolean {
  try {
    const tc = entry.tool_call ?? "";
    return tc.includes("HEARTBEAT.md");
  } catch {
    return false;
  }
}

function hasNullEntryAfterLastL2(
  nullEntries: OffloadEntry[],
  lastL2Iso: string,
): boolean {
  const lastMs = new Date(lastL2Iso).getTime();
  if (Number.isNaN(lastMs)) return true;
  return nullEntries.some((e) => {
    if (!e.timestamp) return true;
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts)) return true;
    return ts > lastMs;
  });
}

const MMD_NODE_ID_RE = /\b(\d{3}-N\d+)\b/g;

function normalizeNodeMapping(raw: any): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== "string" || !k) continue;
    const s = typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
    if (s) out[k] = s;
  }
  return out;
}

function extractMmdNodeIdsFromText(text: string | null | undefined): string[] {
  if (text == null || typeof text !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  MMD_NODE_ID_RE.lastIndex = 0;
  while ((m = MMD_NODE_ID_RE.exec(text)) !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function pickMmdDerivedFallbackNodeId(
  mmdText: string,
  mmdPrefix: string,
): string | null {
  const ids = extractMmdNodeIdsFromText(mmdText);
  if (ids.length === 0) return null;
  const prefix =
    typeof mmdPrefix === "string" && /^\d{3}$/.test(mmdPrefix)
      ? `${mmdPrefix}-`
      : null;
  const pool = prefix ? ids.filter((id) => id.startsWith(prefix)) : ids;
  const candidates = pool.length > 0 ? pool : ids;
  let best: string | null = null;
  let bestN = -1;
  for (const id of candidates) {
    const mm = id.match(/^(\d{3})-N(\d+)$/);
    if (!mm) continue;
    const n = Number(mm[2]);
    if (Number.isFinite(n) && n > bestN) {
      bestN = n;
      best = id;
    }
  }
  return best;
}

// ─── L2 Independent Trigger Check ─────────────────────────────────────────────
// 中文：─── L2 独立触发检查 ─────────────────────────────────────────────

export async function checkL2Trigger(
  stateManager: OffloadStateManager,
  pluginConfig: Partial<PluginConfig> | undefined,
  logger: PluginLogger,
): Promise<{
  shouldTrigger: boolean;
  reason: string;
  entriesByMmd: Map<string, OffloadEntry[]>;
}> {
  const nullThreshold =
    pluginConfig?.l2NullThreshold ?? PLUGIN_DEFAULTS.l2NullThreshold;
  const timeoutSeconds =
    pluginConfig?.l2TimeoutSeconds ?? PLUGIN_DEFAULTS.l2TimeoutSeconds;
  const timeNeedsNewOffload =
    (pluginConfig as any)?.l2TimeTriggerRequiresNewOffload ??
    PLUGIN_DEFAULTS.l2TimeTriggerRequiresNewOffload;
  const waitRetrySeconds =
    (pluginConfig as any)?.l2WaitRetrySeconds ??
    PLUGIN_DEFAULTS.l2WaitRetrySeconds;

  const emptyResult = { shouldTrigger: false as const, reason: "", entriesByMmd: new Map<string, OffloadEntry[]>() };

  const allEntries = await readAllOffloadEntries(stateManager.ctx);
  const nowMs = Date.now();

  // Collect eligible null entries using boundary-based grouping
  // 中文：使用边界基于分组收集符合条件的null条目
  const entriesByMmd = new Map<string, OffloadEntry[]>();
  let eligibleNullCount = 0;

  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    if (isHeartbeatEntry(entry)) continue;
    if (entry.node_id !== null && entry.node_id !== "wait") continue;

    // For "wait" entries, only include if they exceeded retry timeout
    // 中文：对于"等待"条目，仅包括如果它们超过了重试超时
    if (entry.node_id === "wait") {
      const tsIso = entry.timestamp;
      if (tsIso) {
        const tsMs = new Date(tsIso).getTime();
        if (!Number.isNaN(tsMs) && (nowMs - tsMs) / 1000 < waitRetrySeconds) continue;
      }
    }

    // Use boundary to determine which mmd this entry belongs to
    // 中文：使用边界来确定该条目属于哪个mmd
    const boundary = stateManager.resolveEntryBoundary(i);
    if (!boundary) continue;                       // no boundary coverage → skip
    // 中文：无边界覆盖 → 跳过
    if (boundary.result !== "long") continue;       // short task → skip
    // 中文：短任务 → 跳过
    if (!boundary.targetMmd) continue;              // no target mmd → skip
    // 中文：无目标mmd → 跳过

    if (entry.node_id === null) eligibleNullCount++;

    const mmd = boundary.targetMmd;
    let bucket = entriesByMmd.get(mmd);
    if (!bucket) { bucket = []; entriesByMmd.set(mmd, bucket); }
    // Dedup by tool_call_id within the same bucket
    // 中文：在同一个桶内通过tool_call_id去重
    if (entry.tool_call_id && bucket.some((e) => e.tool_call_id === entry.tool_call_id)) continue;
    bucket.push(entry);
  }

  const totalEligible = Array.from(entriesByMmd.values()).reduce((sum, arr) => sum + arr.length, 0);

  if (totalEligible === 0) {
    return { ...emptyResult, reason: "no eligible entries (boundary-filtered)" };
  }

  // Condition A: null count threshold
  // 中文：条件A：null计数阈值
  if (eligibleNullCount >= nullThreshold) {
    return {
      shouldTrigger: true,
      reason: `null_count=${eligibleNullCount} >= threshold=${nullThreshold} (${entriesByMmd.size} mmd(s))`,
      entriesByMmd,
    };
  }

  // Condition B: timeout
  // 中文：条件B：超时
  const lastL2Time = stateManager.getLastL2TriggerTime();
  if (lastL2Time) {
    const elapsed = (Date.now() - new Date(lastL2Time).getTime()) / 1000;
    if (elapsed >= timeoutSeconds) {
      if (timeNeedsNewOffload) {
        // Check if any null entry is newer than last L2
        // 中文：检查是否有空条目比上次L2更新
        const nullEntries = allEntries.filter((e) => e.node_id === null && !isHeartbeatEntry(e));
        if (!hasNullEntryAfterLastL2(nullEntries, lastL2Time) && totalEligible === eligibleNullCount) {
          return { ...emptyResult, reason: "timeout but no new offload rows" };
        }
      }
      return {
        shouldTrigger: true,
        reason: `timeout: ${elapsed.toFixed(0)}s >= ${timeoutSeconds}s (${entriesByMmd.size} mmd(s))`,
        entriesByMmd,
      };
    }
  } else {
    // No prior L2: check retry-wait entries or oldest null age
    // 中文：无先前L2：检查重试等待条目或最旧的空条目的年龄
    const hasRetryWait = totalEligible > eligibleNullCount;
    if (hasRetryWait) {
      return {
        shouldTrigger: true,
        reason: `no prior L2 + retry-wait entries (${entriesByMmd.size} mmd(s))`,
        entriesByMmd,
      };
    }
    const nullEntries = allEntries.filter((e) => e.node_id === null && !isHeartbeatEntry(e));
    if (nullEntries.length > 0) {
      const oldestTs = nullEntries[0]?.timestamp;
      if (oldestTs) {
        const elapsed = (Date.now() - new Date(oldestTs).getTime()) / 1000;
        if (elapsed >= timeoutSeconds) {
          return {
            shouldTrigger: true,
            reason: `no prior L2 + oldest null entry age=${elapsed.toFixed(0)}s`,
            entriesByMmd,
          };
        }
      }
    }
  }

  return {
    ...emptyResult,
    reason: `null_count=${eligibleNullCount} < ${nullThreshold}, timeout not reached`,
  };
}

export async function backfillNodeIds(
  ctx: StorageContext,
  nodeMapping: Record<string, string>,
  waitIds: Set<string>,
  logger: PluginLogger,
  options?: { mmdFallbackText?: string | null; mmdPrefix?: string },
): Promise<void> {
  const mapping = normalizeNodeMapping(nodeMapping);
  const mmdFallbackText = options?.mmdFallbackText ?? null;
  const mmdPrefix = options?.mmdPrefix ?? "000";
  const allEntries = await readAllOffloadEntries(ctx);
  let changed = false;
  const mappedNodeIds = Object.values(mapping);
  const fallbackFromMapping = getMostFrequent(mappedNodeIds);
  const fallbackFromMmd = pickMmdDerivedFallbackNodeId(
    mmdFallbackText ?? "",
    mmdPrefix,
  );
  const effectiveFallback = fallbackFromMapping || fallbackFromMmd;

  let mappedCount = 0;
  let fallbackCount = 0;
  let skippedCount = 0;

  for (const entry of allEntries) {
    const mapped = mapping[entry.tool_call_id];
    if (mapped) {
      entry.node_id = mapped;
      changed = true;
      mappedCount++;
      continue;
    }
    if (entry.node_id === "wait" && waitIds.has(entry.tool_call_id)) {
      if (effectiveFallback) {
        entry.node_id = effectiveFallback;
        changed = true;
        fallbackCount++;
      } else {
        skippedCount++;
      }
    }
  }
  if (changed) {
    await rewriteAllOffloadEntries(ctx, allEntries);
  }
  logger.debug?.(`[context-offload] L2 backfill: mapped=${mappedCount}, fallback=${fallbackCount} (to ${effectiveFallback ?? "N/A"}), skipped=${skippedCount}, total=${waitIds.size}`);
}

function getMostFrequent(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const freq = new Map<string, number>();
  for (const v of arr) {
    freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  let maxKey = arr[0];
  let maxCount = 0;
  for (const [key, count] of freq) {
    if (count > maxCount) {
      maxCount = count;
      maxKey = key;
    }
  }
  return maxKey;
}

// Local runL2Pipeline removed — all L2 processing goes through backend (index.ts → backendClient.l2Generate).
// 中文：本地runL2Pipeline移除——所有L2处理均通过后端（index.ts → backendClient.l2Generate）

