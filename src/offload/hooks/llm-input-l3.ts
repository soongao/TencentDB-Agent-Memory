/**
 * llm_input L3 handler.
 * Calculates precise input tokens via tiktoken and executes L3 compression
 * (mild score-cascade replacement + aggressive oldest-prefix deletion).
 * 中文：llm_input L3 处理器。
 * 通过 tiktoken 计算精确的输入标记数并执行 L3 压缩（轻度评分级联替换 + 极力 oldest-prefix 删除）。
 */
import { PLUGIN_DEFAULTS, type OffloadEntry, type PluginConfig, type PluginLogger } from "../types.js";
import { readOffloadEntries, readMmd, listMmds, markOffloadStatus } from "../storage.js";
import { traceOffloadDecision } from "../opik-tracer.js";
import { createL3TokenCounter } from "../l3-token-counter.js";
import { injectMmdIntoMessages, findHistoryMmdInsertionPoint, findActiveMmdInsertionPoint } from "../mmd-injector.js";
import { buildTiktokenContextSnapshot, tiktokenCount, jsonReplacer, invalidateTokenCache } from "../context-token-tracker.js";
import {
  normalizeToolCallIdForLookup,
  getOffloadEntry,
  populateOffloadLookupMap,
  isToolResultMessage,
  extractToolCallId,
  isOnlyToolUseAssistant,
  extractAllToolUseIds,
  isAssistantMessageWithToolUse,
  isToolUseInAssistant,
  extractToolUseIdFromAssistant,
  replaceWithSummary,
  replaceAssistantToolUseWithSummary,
  compressNonCurrentToolUseBlocks,
  getCurrentTaskNodeIds,
} from "../l3-helpers.js";
import type { OffloadStateManager } from "../state-manager.js";
import type { BackendClient } from "../backend-client.js";
import { buildL3TriggerReport, reportL3Trigger } from "../state-reporter.js";

// ─── Heartbeat message filtering ─────────────────────────────────────────────
// 中文：─── 心跳消息过滤 ─────────────────────────────────────────────

function isHeartbeatToolUseBlock(block: any): boolean {
  if (block.type !== "tool_use" && block.type !== "toolCall") return false;
  try {
    const input = block.input ?? block.arguments;
    if (!input) return false;
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    return raw.includes("HEARTBEAT.md");
  } catch {
    return false;
  }
}

function getMessageContentLocal(msg: any): any {
  if (msg.type === "message") return msg.message?.content;
  return msg.content;
}

function getMessageRoleLocal(msg: any): string | undefined {
  if (msg.type === "message") return msg.message?.role;
  return msg.role;
}

function collectHeartbeatToolUseIds(msg: any): string[] {
  const role = getMessageRoleLocal(msg);
  if (role !== "assistant") return [];
  const content = getMessageContentLocal(msg);
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (isHeartbeatToolUseBlock(block) && block.id) ids.push(block.id);
  }
  return ids;
}

export function filterHeartbeatMessages(messages: any[], logger: PluginLogger | undefined): number {
  const heartbeatIds = new Set<string>();
  for (const msg of messages) {
    for (const id of collectHeartbeatToolUseIds(msg)) heartbeatIds.add(id);
  }
  if (heartbeatIds.size === 0) return 0;
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = getMessageRoleLocal(msg);
    if (role === "toolResult" || role === "tool") {
      const tcId = msg.toolCallId ?? msg.tool_call_id ?? msg.message?.toolCallId ?? msg.message?.tool_call_id;
      if (tcId && heartbeatIds.has(tcId)) { messages.splice(i, 1); removed++; continue; }
    }
    if (role === "assistant") {
      const content = getMessageContentLocal(msg);
      if (!Array.isArray(content)) continue;
      const beforeLen = content.length;
      for (let j = content.length - 1; j >= 0; j--) {
        if (isHeartbeatToolUseBlock(content[j])) content.splice(j, 1);
      }
      if (content.length < beforeLen) {
        removed++;
        if (content.length === 0) messages.splice(i, 1);
      }
    }
  }
  return removed;
}

// ─── Token overflow error detection ──────────────────────────────────────────
// 中文：─── 标记溢出错误检测 ──────────────────────────────────────────

export function isTokenOverflowError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("context_length") || msg.includes("context length") ||
    (msg.includes("token") && (msg.includes("exceed") || msg.includes("limit") || msg.includes("overflow") || msg.includes("too long"))) ||
    msg.includes("prompt is too long") || msg.includes("max_tokens") ||
    msg.includes("request too large") || msg.includes("compaction") ||
    msg.includes("prompt_too_long") || msg.includes("string_above_max_length")
  );
}

// ─── Constants ───────────────────────────────────────────────────────────────
// 中文：─── 常量 ───────────────────────────────────────────────────────────────

export const MILD_CASCADE_MIN_COUNT = 10;
export const MILD_CASCADE_INITIAL_SCORE = 7;
export const MILD_CASCADE_FLOOR_SCORE = 1;
export const AGGRESSIVE_MIN_MESSAGES_TO_KEEP = 2;
export const EMERGENCY_MIN_MESSAGES_TO_KEEP = 2;

// Maximum content length (chars) to keep when truncating an oversized message in-place.
// ~2K chars ≈ ~500 tokens — enough to preserve tool_call_id and a snippet of context.
// 中文：截断过大消息时就地保留的最大内容长度（字符数）。
// 约 2K 字符 ≈ 约 500 个标记 — 足够保留 tool_call_id 和一段上下文。
const EMERGENCY_TRUNCATE_MAX_CHARS = 2000;

// ─── Message dump helper ─────────────────────────────────────────────────────
// 中文：─── 消息转储辅助 ─────────────────────────────────────────────────────

export function dumpMessagesSnapshot(label: string, messages: any[], logger: PluginLogger): void {
  const summary: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role ?? msg.message?.role ?? msg.type ?? "?";
    const flags: string[] = [];
    if (msg._mmdContextMessage) flags.push(`mmdCtx=${msg._mmdContextMessage}`);
    if (msg._mmdInjection) flags.push("mmdInj");
    if (msg._offloaded) flags.push("offloaded");
    const content = msg.content ?? msg.message?.content;
    let preview: string;
    if (typeof content === "string") {
      preview = content.slice(0, 120);
    } else if (Array.isArray(content)) {
      const texts = content
        .filter((c: any) => c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text.slice(0, 80));
      const toolUses = content
        .filter((c: any) => c.type === "tool_use" || c.type === "toolCall")
        .map((c: any) => `tool_use:${c.name ?? c.id ?? "?"}`);
      const toolResults = content
        .filter((c: any) => c.type === "tool_result")
        .map((c: any) => `tool_result:${c.tool_use_id ?? "?"}`);
      preview = [...texts, ...toolUses, ...toolResults].join(" | ").slice(0, 120);
    } else {
      preview = String(content ?? "").slice(0, 80);
    }
    const flagStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
    summary.push(`  [${i}] ${role}${flagStr}: ${preview}`);
  }
  logger.debug?.(
    `[context-offload] MSG-DUMP(${label}) count=${messages.length}\n${summary.join("\n")}`,
  );
}

// ─── Create llm_input L3 Handler ─────────────────────────────────────────────
// 中文：─── 创建 llm_input L3 处理器 ─────────────────────────────────────────────

export function createLlmInputL3Handler(
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  getContextWindow: () => number,
  pluginConfig: Partial<PluginConfig> | undefined,
  callbacks?: { notifyL2NewNullEntries?: (count: number) => void },
  backendClient?: BackendClient | null,
) {
  return async (event: any) => {
    const _l3Start = Date.now();
    // Skip internal memory-pipeline sessions
    // 中文：跳过内部内存管道会话
    const _sk = stateManager.getLastSessionKey();
    if (typeof _sk === "string" && /memory-.*-session-\d+/.test(_sk)) return;

    logger.debug?.(`[context-offload] llm_input_l3 CALLED, historyMsgs=${event?.historyMessages?.length ?? "?"}, prompt=${typeof event?.prompt === "string" ? event.prompt.slice(0, 50) : "?"}`);
    let _aggDeleted = 0;
    let _mildReplaced = 0;
    let _emergencyTriggered = false;
    let _emergencyDeleted = 0;
    try {
      const historyMessages = Array.isArray(event.historyMessages) ? event.historyMessages : [];
      if (historyMessages.length > 0) filterHeartbeatMessages(historyMessages, logger);
      const sysPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : null;
      const promptText = typeof event.prompt === "string" ? event.prompt : null;
      stateManager.cachedSystemPrompt = sysPrompt;
      stateManager.cachedUserPrompt = promptText;

      if (historyMessages.length > 0) {
        const latestTurn = extractLatestTurn(historyMessages, promptText);
        stateManager.cachedLatestTurnMessages = latestTurn;
      }

      // Defensive fast-path re-apply
      // 中文：防御性快速路径重试
      if (historyMessages.length > 0) await fastPathReApply(historyMessages, stateManager, logger);

      // MMD injection into historyMessages
      // 中文：MMD注入到historyMessages中
      if (historyMessages.length > 0) {
        try {
          await injectMmdIntoMessages(historyMessages, stateManager, logger, getContextWindow, pluginConfig);
        } catch { /* ignore */ }
        // 中文：ignore
      }

      const snap = buildTiktokenContextSnapshot("llm_input_l3", historyMessages, sysPrompt, promptText);
      stateManager.cachedSystemPromptTokens = snap.systemTokens;
      stateManager.cachedUserPromptTokens = snap.userPromptTokens;

      if (snap.systemTokens > 0) {
        stateManager.setEstimatedSystemOverhead(snap.systemTokens);
        if (stateManager.isLoaded()) stateManager.save().catch(() => {});
      }

      const contextWindow = getContextWindow();
      const mildRatio = pluginConfig?.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio;
      const aggressiveRatio = pluginConfig?.aggressiveCompressRatio ?? PLUGIN_DEFAULTS.aggressiveCompressRatio;
      const mildThreshold = Math.floor(contextWindow * mildRatio);
      const aggressiveThreshold = Math.floor(contextWindow * aggressiveRatio);

      const utilisation = snap.totalTokens / contextWindow;
      logger.debug?.(
        `[context-offload] L3(llm_input) token snapshot: total=${snap.totalTokens} ` +
        `(system=${snap.systemTokens}, messages=${snap.messagesTokens}, user=${snap.userPromptTokens}) ` +
        `msgCount=${historyMessages.length} utilisation=${(utilisation * 100).toFixed(1)}% ` +
        `contextWindow=${contextWindow} mild@${mildThreshold} aggressive@${aggressiveThreshold}`,
      );

      if (historyMessages.length === 0) return;
      if (snap.totalTokens < mildThreshold) {
        logger.debug?.(`[context-offload] L3(llm_input): ${snap.totalTokens} < mild@${mildThreshold} → no compression needed`);
        return;
      }

      const offloadEntries = await readOffloadEntries(stateManager.ctx);
      const offloadMap = new Map<string, OffloadEntry>();
      populateOffloadLookupMap(offloadMap, offloadEntries);
      const currentTaskNodeIds = await getCurrentTaskNodeIds(stateManager);
      const countTokens = createL3TokenCounter(pluginConfig, logger);
      const aggressiveDeleteRatio = (pluginConfig as any)?.aggressiveDeleteRatio ?? PLUGIN_DEFAULTS.aggressiveDeleteRatio;
      const mildScanRatio = (pluginConfig as any)?.mildOffloadScanRatio ?? PLUGIN_DEFAULTS.mildOffloadScanRatio;
      let workingTokens = snap.totalTokens;

      // Aggressive
      // 中文：激进型
      if (workingTokens >= aggressiveThreshold) {
        logger.debug?.(`[context-offload] L3(llm_input) AGGRESSIVE: tokens≈${workingTokens} >= ${aggressiveThreshold}, starting deletion`);
        const _llmAggStart = Date.now();
        const result = await aggressiveCompressUntilBelowThreshold(
          historyMessages, offloadMap, currentTaskNodeIds, aggressiveDeleteRatio,
          stateManager, logger, aggressiveThreshold, countTokens, sysPrompt, promptText,
        );
        workingTokens = result.remainingTokens;
        _aggDeleted = result.deletedCount ?? result.allDeletedToolCallIds.length;
        const _llmAggDuration = Date.now() - _llmAggStart;
        logger.debug?.(`[context-offload] L3(llm_input) AGGRESSIVE done: rounds=${result.rounds}, deleted=${result.deletedCount}, remaining≈${workingTokens}, deletedIds=${result.allDeletedToolCallIds.length}, stalledByUserMsg=${result.stalledByUserMsg ?? false}, duration=${_llmAggDuration}ms`);
        if (_llmAggDuration > 10_000) {
          logger.warn(`[context-offload] L3(llm_input) AGGRESSIVE SLOW: ${_llmAggDuration}ms (rounds=${result.rounds}, deleted=${result.deletedCount}, remaining≈${workingTokens})`);
        }
        dumpMessagesSnapshot("after-aggressive", historyMessages, logger);
        if (result.allDeletedToolCallIds.length > 0) {
          const statusUpdates = new Map<string, string | boolean>();
          for (const id of result.allDeletedToolCallIds) {
            statusUpdates.set(id, "deleted");
            stateManager.confirmedOffloadIds.add(id);
            stateManager.deletedOffloadIds.add(id);
          }
          markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
          const mmdInjection = await buildHistoryMmdInjection(
            result.allDeletedToolCallIds, offloadMap, offloadEntries,
            stateManager, logger, countTokens, contextWindow, pluginConfig,
          );
          if (mmdInjection.injectedMessages.length > 0) {
            removeExistingMmdInjections(historyMessages);
            const histInsertIdx = findHistoryMmdInsertionPoint(historyMessages);
            historyMessages.splice(histInsertIdx, 0, ...mmdInjection.injectedMessages);
            workingTokens += mmdInjection.totalMmdTokens;
            logger.debug?.(`[context-offload] L3(llm_input) AGGRESSIVE: injected ${mmdInjection.injectedMessages.length} history MMD msgs at [${histInsertIdx}] (${mmdInjection.totalMmdTokens} tokens, files=${mmdInjection.mmdFiles.join(",")})`);
            dumpMessagesSnapshot("after-aggressive-mmd-injection", historyMessages, logger);
          }
        }
        // If aggressive stalled due to user message protection, force emergency
        // 中文：如果激进型因用户消息保护而停滞，则强制紧急处理
        if (result.stalledByUserMsg && workingTokens >= aggressiveThreshold) {
          logger.warn(`[context-offload] L3(llm_input) AGGRESSIVE stalled, forcing emergency fallback`);
          stateManager._forceEmergencyNext = true;
        }
      }

      // Mild
      if (workingTokens >= mildThreshold) {
        logger.debug?.(`[context-offload] L3(llm_input) MILD: tokens≈${workingTokens} >= ${mildThreshold}, starting cascade`);
        const cascadeResult = compressByScoreCascade(historyMessages, offloadMap, currentTaskNodeIds, mildScanRatio, logger);
        _mildReplaced = cascadeResult.replacedCount;
        logger.debug?.(`[context-offload] L3(llm_input) MILD done: replaced=${cascadeResult.replacedCount}, finalThreshold=${cascadeResult.finalThreshold}, ids=[${cascadeResult.replacedToolCallIds.slice(0,5).join(",")}${cascadeResult.replacedToolCallIds.length > 5 ? "..." : ""}]`);
        if (cascadeResult.replacedCount > 0) {
          for (const id of cascadeResult.replacedToolCallIds) {
            stateManager.confirmedOffloadIds.add(id);
          }
          const mildStatusUpdates = new Map<string, string | boolean>();
          for (const id of cascadeResult.replacedToolCallIds) {
            mildStatusUpdates.set(id, true);
          }
          markOffloadStatus(stateManager.ctx, mildStatusUpdates).catch(() => {});
        }
        dumpMessagesSnapshot("after-mild", historyMessages, logger);
      }

      // Emergency
      // 中文：紧急处理
      const emergencyRatio = pluginConfig?.emergencyCompressRatio ?? PLUGIN_DEFAULTS.emergencyCompressRatio;
      const emergencyTargetRatio = pluginConfig?.emergencyTargetRatio ?? PLUGIN_DEFAULTS.emergencyTargetRatio;
      const emergencyThreshold = Math.floor(contextWindow * emergencyRatio);
      const emergencyTarget = Math.floor(contextWindow * emergencyTargetRatio);
      const preEmergencySnap = buildTiktokenContextSnapshot("llm_input_pre_emergency", historyMessages, sysPrompt, promptText);
      workingTokens = preEmergencySnap.totalTokens;
      const forceEmergency = stateManager._forceEmergencyNext === true;
      if (forceEmergency) stateManager._forceEmergencyNext = false;

      if ((workingTokens >= emergencyThreshold || forceEmergency) && historyMessages.length > EMERGENCY_MIN_MESSAGES_TO_KEEP) {
        _emergencyTriggered = true;
        logger.warn(`[context-offload] L3(llm_input) EMERGENCY: tokens≈${workingTokens} >= ${emergencyThreshold} (force=${forceEmergency}), target=${emergencyTarget}`);
        const emergencyResult = emergencyCompress(historyMessages, emergencyTarget, countTokens, sysPrompt, promptText, logger);
        _emergencyDeleted = emergencyResult.deletedCount;
        logger.warn(`[context-offload] L3(llm_input) EMERGENCY done: deleted=${emergencyResult.deletedCount}, remaining≈${emergencyResult.remainingTokens}, deletedIds=${emergencyResult.deletedToolCallIds.length}`);
        if (emergencyResult.deletedToolCallIds.length > 0) {
          const statusUpdates = new Map<string, string | boolean>();
          for (const id of emergencyResult.deletedToolCallIds) {
            statusUpdates.set(id, "deleted");
            stateManager.confirmedOffloadIds.add(id);
            stateManager.deletedOffloadIds.add(id);
          }
          markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
        }
        dumpMessagesSnapshot("after-emergency", historyMessages, logger);
      }

      if (stateManager.isLoaded()) await stateManager.save();

      // Final L3 summary
      // 中文：最终L3总结
      const finalSnap = buildTiktokenContextSnapshot("llm_input_l3_final", historyMessages, sysPrompt, promptText);
      const totalSaved = snap.totalTokens - finalSnap.totalTokens;
      if (totalSaved > 0) {
        logger.debug?.(`[context-offload] L3(llm_input) SUMMARY: ${snap.totalTokens}→${finalSnap.totalTokens} (saved≈${totalSaved} tokens), msgs=${historyMessages.length}`);
      }

      traceOffloadDecision({
        sessionKey: stateManager.getLastSessionKey(),
        stage: "L3.llm_input.completed",
        input: {
          contextWindow,
          mildThreshold,
          aggressiveThreshold,
          tokensBefore: snap.totalTokens,
          messagesBefore: event.historyMessages?.length ?? 0,
        },
        output: {
          tokensAfter: finalSnap.totalTokens,
          tokensSaved: totalSaved,
          messagesAfter: historyMessages.length,
          compressionApplied: totalSaved > 0,
          utilisation: `${((snap.totalTokens / contextWindow) * 100).toFixed(1)}%`,
          aboveMild: snap.totalTokens >= mildThreshold,
          aboveAggressive: snap.totalTokens >= aggressiveThreshold,
        },
        logger,
      });

      // Upload plugin state + L3 token accounting to backend /store.
      // 中文：上传插件状态+L3令牌计费至后端/store.
      try {
        const triggerReason = snap.totalTokens >= aggressiveThreshold
          ? "above_aggressive"
          : "above_mild";
        const report = buildL3TriggerReport({
          stage: "llm_input",
          triggerReason,
          stateManager,
          event,
          contextWindow,
          mildThreshold,
          aggressiveThreshold,
          tokensBefore: snap.totalTokens,
          tokensAfter: finalSnap.totalTokens,
          messagesBefore: event.historyMessages?.length ?? 0,
          messagesAfter: historyMessages.length,
          durationMs: Date.now() - _l3Start,
          aboveMild: snap.totalTokens >= mildThreshold,
          aboveAggressive: snap.totalTokens >= aggressiveThreshold,
          mildReplacedCount: _mildReplaced,
          aggressiveDeletedCount: _aggDeleted,
          emergencyTriggered: _emergencyTriggered,
          emergencyDeletedCount: _emergencyDeleted,
        });
        reportL3Trigger(backendClient ?? null, report, logger);
      } catch (reportErr) {
        logger.warn(`[context-offload] L3(llm_input) build report failed: ${reportErr}`);
      }
    } catch (err) {
      logger.error(`[context-offload] llm_input L3 error: ${err}`);
      if (isTokenOverflowError(err)) stateManager._forceEmergencyNext = true;
    }
  };
}

// ─── Compression Algorithms ──────────────────────────────────────────────────
// 中文：──────── 压缩算法 ───────────────────────────────────────────────────────

export function compressByScoreCascade(
  messages: any[],
  offloadMap: Map<string, OffloadEntry>,
  currentTaskNodeIds: Set<string>,
  scanRatio: number,
  logger: PluginLogger,
  minCount = MILD_CASCADE_MIN_COUNT,
  initialScore = MILD_CASCADE_INITIAL_SCORE,
): { replacedCount: number; lastOffloadedId: string | null; finalThreshold: number; replacedToolCallIds: string[]; replacedDetails: Array<{ toolCallId: string; score: number; summaryPreview: string; originalLength?: number; summaryLength?: number }> } {
  const totalMessages = messages.length;
  const scanEnd = Math.floor(totalMessages * scanRatio);
  const candidates: any[] = [];
  for (let i = 0; i < scanEnd; i++) {
    const msg = messages[i];
    if (msg._offloaded) continue;
    if (!isToolResultMessage(msg)) {
      if (isOnlyToolUseAssistant(msg)) {
        const tuIds = extractAllToolUseIds(msg);
        if (tuIds.length > 0) {
          let allHaveEntry = true;
          let minScore = Infinity;
          const tuEntries: OffloadEntry[] = [];
          for (const tuId of tuIds) {
            const entry = getOffloadEntry(offloadMap, tuId);
            if (!entry) { allHaveEntry = false; break; }
            tuEntries.push(entry);
            const s = entry.score ?? 5;
            if (s < minScore) minScore = s;
          }
          if (allHaveEntry && tuEntries.length > 0) {
            candidates.push({
              msgIndex: i, toolCallId: tuIds[0], offloadEntry: tuEntries[0],
              score: minScore, isAssistantToolUse: true,
              allToolUseIds: tuIds, allOffloadEntries: tuEntries,
            });
          }
        }
      }
      continue;
    }
    const toolCallId = extractToolCallId(msg);
    if (!toolCallId) continue;
    const offloadEntry = getOffloadEntry(offloadMap, toolCallId);
    if (!offloadEntry) continue;
    candidates.push({ msgIndex: i, toolCallId, offloadEntry, score: offloadEntry.score ?? 5 });
  }
  if (candidates.length === 0) {
    logger.debug?.(`[context-offload] L3-MILD: 0 candidates in scan range (0..${scanEnd}/${totalMessages}), offloadMap=${offloadMap.size} entries`);
    return { replacedCount: 0, lastOffloadedId: null, finalThreshold: initialScore, replacedToolCallIds: [], replacedDetails: [] };
  }
  candidates.sort((a: any, b: any) => b.score - a.score);

  // Score distribution: count candidates at each score level
  // 中文：评分分布: 统计每个分数等级的候选者数量
  const scoreDist = new Map<number, number>();
  for (const c of candidates) {
    const s = c.score;
    scoreDist.set(s, (scoreDist.get(s) ?? 0) + 1);
  }
  const scoreDistStr = [...scoreDist.entries()].sort((a, b) => b[0] - a[0]).map(([s, n]) => `score=${s}:${n}`).join(", ");
  logger.debug?.(`[context-offload] L3-MILD: ${candidates.length} candidates (scan 0..${scanEnd}/${totalMessages}), distribution=[${scoreDistStr}], offloadMap=${offloadMap.size}`);

  const toolCallIdToResultIdx = new Map<string, number>();
  const toolCallIdToAssistantIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (isToolResultMessage(m)) {
      const tid = extractToolCallId(m);
      if (tid) {
        toolCallIdToResultIdx.set(tid, i);
        const tidNorm = normalizeToolCallIdForLookup(tid);
        if (tidNorm !== tid) toolCallIdToResultIdx.set(tidNorm, i);
      }
    }
    if (isAssistantMessageWithToolUse(m)) {
      const tuIds = extractAllToolUseIds(m);
      for (const tuId of tuIds) {
        toolCallIdToAssistantIdx.set(tuId, i);
        const tuIdNorm = normalizeToolCallIdForLookup(tuId);
        if (tuIdNorm !== tuId) toolCallIdToAssistantIdx.set(tuIdNorm, i);
      }
    }
  }

  let replacedCount = 0;
  let lastOffloadedId: string | null = null;
  const replacedIds = new Set<string>();
  const replacedToolCallIdList: string[] = [];
  const replacedDetails: Array<{ toolCallId: string; score: number; summaryPreview: string; originalLength?: number; summaryLength?: number }> = [];
  let activeThreshold = initialScore;

  for (let threshold = initialScore; threshold >= MILD_CASCADE_FLOOR_SCORE; threshold--) {
    activeThreshold = threshold;
    for (const c of candidates) {
      if (c.score < threshold) continue;
      const msg = messages[c.msgIndex];
      if (msg._offloaded) continue;
      if (c.isAssistantToolUse) {
        replaceAssistantToolUseWithSummary(msg, c.allOffloadEntries);
        msg._offloaded = true;
        replacedCount++;
        lastOffloadedId = c.toolCallId;
        for (const tuId of c.allToolUseIds) {
          replacedIds.add(tuId);
          replacedToolCallIdList.push(tuId);
          const tuIdNorm = normalizeToolCallIdForLookup(tuId);
          const tuEntry = c.allOffloadEntries.find((e: OffloadEntry) => e.tool_call_id === tuId || e.tool_call_id === tuIdNorm || normalizeToolCallIdForLookup(e.tool_call_id) === tuIdNorm);
          replacedDetails.push({ toolCallId: tuId, score: c.score, summaryPreview: (tuEntry?.summary ?? "").slice(0, 120) });
        }
        for (let ei = 0; ei < c.allToolUseIds.length; ei++) {
          const tuId = c.allToolUseIds[ei];
          const resultIdx = toolCallIdToResultIdx.get(tuId) ?? toolCallIdToResultIdx.get(normalizeToolCallIdForLookup(tuId));
          if (resultIdx !== undefined) {
            const resultMsg = messages[resultIdx];
            if (!resultMsg._offloaded) {
              replaceWithSummary(resultMsg, c.allOffloadEntries[ei]);
              resultMsg._offloaded = true;
              replacedCount++;
            }
          }
        }
      } else {
        const replInfo = replaceWithSummary(msg, c.offloadEntry);
        logger.debug?.(
          `[context-offload] L3-MILD replace: [${c.msgIndex}] ${c.toolCallId} score=${c.score}, ` +
          `original=${replInfo.originalLength}→summary=${replInfo.summaryLength} (delta=${replInfo.summaryLength - replInfo.originalLength}), ` +
          `tool=${(c.offloadEntry.tool_call ?? "").slice(0, 80)}, ` +
          `summary="${(c.offloadEntry.summary ?? "").slice(0, 100)}"`,
        );
        if (replInfo.summaryLength > replInfo.originalLength) {
          logger.debug?.(`[context-offload] L3-MILD: SKIPPING replacement for ${c.toolCallId} — summary larger than original (${replInfo.originalLength} → ${replInfo.summaryLength}, delta=+${replInfo.summaryLength - replInfo.originalLength}), reverting`);
          // Revert: the message was already mutated by replaceWithSummary,
          // but we mark it as _offloaded anyway to avoid re-processing.
          // The net effect is minimal since the size barely increased.
          // In practice we simply skip counting it as a useful replacement.
          // 中文：还原: 消息已经被replaceWithSummary修改过了,
          // 但我们还是将其标记为_offloaded以避免重新处理。
          // 总体影响很小，因为大小几乎没有增加。
          // 实际上我们只是跳过计算它作为一个有用的替换。
          msg._offloaded = true;
          continue;
        }
        msg._offloaded = true;
        replacedCount++;
        lastOffloadedId = c.toolCallId;
        replacedIds.add(c.toolCallId);
        replacedToolCallIdList.push(c.toolCallId);
        replacedDetails.push({ toolCallId: c.toolCallId, score: c.score, summaryPreview: (c.offloadEntry.summary ?? "").slice(0, 120), originalLength: replInfo.originalLength, summaryLength: replInfo.summaryLength });
        const assistantIdx = toolCallIdToAssistantIdx.get(c.toolCallId) ?? toolCallIdToAssistantIdx.get(normalizeToolCallIdForLookup(c.toolCallId));
        if (assistantIdx !== undefined) {
          const assistantMsg = messages[assistantIdx];
          if (isOnlyToolUseAssistant(assistantMsg) && !assistantMsg._offloaded) {
            const tuIds = extractAllToolUseIds(assistantMsg);
            const allNowReplaced = tuIds.every((id) => replacedIds.has(id) || replacedIds.has(normalizeToolCallIdForLookup(id)));
            if (allNowReplaced) {
              const tuEntries = tuIds.map((id) => getOffloadEntry(offloadMap, id)).filter(Boolean) as OffloadEntry[];
              if (tuEntries.length === tuIds.length) {
                replaceAssistantToolUseWithSummary(assistantMsg, tuEntries);
                assistantMsg._offloaded = true;
                replacedCount++;
              }
            }
          }
        }
      }
    }
    if (replacedCount >= minCount) break;
  }

  if (replacedIds.size > 0) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (isAssistantMessageWithToolUse(msg)) {
        compressNonCurrentToolUseBlocks(msg, offloadMap, currentTaskNodeIds, replacedIds);
      }
    }
  }

  return { replacedCount, lastOffloadedId, finalThreshold: activeThreshold, replacedToolCallIds: replacedToolCallIdList, replacedDetails };
}

// ─── User Message Protection ─────────────────────────────────────────────────
// 中文：─── 用户消息保护 ─────────────────────────────────────────────────

/**
 * Find the index of the LAST real user message (not MMD/injection) in the
 * messages array.  Returns -1 if none found.
 *
 * Both aggressive and emergency compression delete from the HEAD of the array
 * (oldest → newest).  By capping deleteCount so it never reaches or exceeds
 * this index, the user's most recent prompt is preserved.
 * 中文：在messages数组中找到最后一个真实的用户消息（不是MMD/注入）的索引。如果没有找到返回-1。
 * 激进压缩和紧急压缩都从数组头部删除（最旧→最新）。通过限制deleteCount使其永远不会达到或超过此索引，可以保留用户的最近提示。
 */
function findLastUserMessageIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m._mmdContextMessage || m._mmdInjection) continue;
    const role = m.role ?? m.message?.role ?? m.type;
    if (role === "user") return i;
  }
  return -1;
}

/**
 * Cap a head-of-array deleteCount so it does NOT delete the LAST real user
 * message (the most recent user input).  Older user messages in the head
 * region ARE allowed to be deleted — only the final user message is sacred.
 *
 * If the last user message sits at or before `deleteCount`, shrink
 * deleteCount to stop just before it.
 *
 * SPECIAL CASE: When the last user message is at index 0 (i.e. only one
 * user message, at the head), there's nothing deletable before it so we
 * return 0.  The caller (aggressive/emergency) should detect this and
 * fall through to emergency which can handle this scenario differently.
 * 中文：将头部删除计数限制为不删除最后一个真实的用户消息（最新的用户输入）。头部区域的较早用户消息允许被删除——只有最终的用户消息是神圣不可侵犯的。
 * 如果最后一个用户消息位于或处于`deleteCount`之前，则缩小deleteCount以停止在它之前。
 */
function capDeleteCountForUserMessage(messages: any[], deleteCount: number): number {
  if (deleteCount <= 0) return 0;
  const lastUserIdx = findLastUserMessageIndex(messages);
  if (lastUserIdx < 0) return deleteCount;           // no user msg → nothing to protect
  // 中文：no user msg → nothing to protect
  if (deleteCount <= lastUserIdx) return deleteCount; // last user msg is safe beyond the cut
  // 中文：last user msg is safe beyond the cut
  // Shrink to just before the LAST user message (older user msgs can be deleted)
  // 中文：收缩到在最后一个用户消息之前（较旧的用户消息可以被删除）
  return lastUserIdx;
}

// ─── Aggressive Compression ──────────────────────────────────────────────────
// 中文：─── 激进压缩 ──────────────────────────────────────────────────

/**
 * Compute how many messages to delete from the head to bring total tokens
 * below threshold.  One-shot: accumulate per-message token costs from the
 * head until enough tokens have been removed.
 *
 * @param messages - messages array (MMD already extracted)
 * @param remainingTokens - current total tokens (may include sys/prompt overhead)
 * @param aggressiveThreshold - target total tokens to reach
 * @param countTokens - tiktoken counter
 * @param maxDeletable - max messages allowed to delete (preserves MIN_KEEP)
 * 中文：计算需要从头部删除多少条消息才能使总令牌数低于阈值。一次性操作：从头部逐条累加每个消息的令牌成本，直到移除足够多的令牌。
 */
function computeAggressiveDeleteCount(messages: any[], remainingTokens: number, aggressiveThreshold: number, countTokens: (t: string) => number, maxDeletable: number): number {
  if (messages.length === 0 || maxDeletable <= 0) return 0;
  if (remainingTokens <= aggressiveThreshold) return 0; // already below target
  // 中文：already below target
  // Need to remove (remainingTokens - aggressiveThreshold) tokens from messages
  // 中文：需要移除 (remainingTokens - aggressiveThreshold) 个令牌从消息中
  const tokensToDelete = remainingTokens - aggressiveThreshold;
  const perMsg = messages.map((m: any) => countTokens(JSON.stringify(m)));
  let acc = 0;
  let deleteCount = 0;
  for (let i = 0; i < messages.length && deleteCount < maxDeletable; i++) {
    acc += perMsg[i];
    deleteCount = i + 1;
    if (acc >= tokensToDelete) break;
  }
  // Minimum progress guarantee: if head messages are tiny (offloaded summaries)
  // and we couldn't reach tokensToDelete, ensure at least 20% of messages are deleted.
  // 中文：最小进度保证：如果头部消息很小（卸载的摘要），
  // 并且我们无法达到 tokensToDelete，则至少确保删除消息的20%。
  if (acc < tokensToDelete && deleteCount > 0) {
    const minByCount = Math.max(1, Math.ceil(messages.length * 0.2));
    deleteCount = Math.max(deleteCount, Math.min(minByCount, maxDeletable));
  }
  return deleteCount;
}

function adjustDeleteCountForToolPairing(messages: any[], initialDeleteCount: number): number {
  if (initialDeleteCount <= 0 || initialDeleteCount >= messages.length) return initialDeleteCount;
  let count = initialDeleteCount;
  while (count < messages.length && isToolResultMessage(messages[count])) count++;
  return count;
}

/**
 * One-shot aggressive compression.  Computes the exact cut point to bring
 * tokens below threshold in a single pass, then splices once.
 * No multi-round while loop — O(N) tiktoken + O(1) splice.
 * 中文：一次性激进压缩。计算确切的切分点以在单次通过中将令牌数降至阈值以下，然后进行一次拼接。
 * 没有多轮循环 — O(N) tiktoken + O(1) 拼接。
 */
export async function aggressiveCompressUntilBelowThreshold(
  messages: any[],
  offloadMap: Map<string, OffloadEntry>,
  currentTaskNodeIds: Set<string>,
  deleteRatio: number,
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  aggressiveThreshold: number,
  countTokens: (t: string) => number,
  sysPrompt: string | null,
  promptText: string | null,
): Promise<{ deletedCount: number; rounds: number; remainingTokens: number; allDeletedToolCallIds: string[]; stalledByUserMsg?: boolean }> {
  const allDeletedToolCallIds: string[] = [];
  let remainingTokens = buildTiktokenContextSnapshot("l3_aggressive_est", messages, sysPrompt, promptText).totalTokens;
  let stalledByUserMsg = false;

  logger.debug?.(`[context-offload] L3-aggressive entry: msgs=${messages.length}, remainingTokens=${remainingTokens}, threshold=${aggressiveThreshold}, minKeep=${AGGRESSIVE_MIN_MESSAGES_TO_KEEP}`);

  if (remainingTokens < aggressiveThreshold || messages.length <= AGGRESSIVE_MIN_MESSAGES_TO_KEEP) {
    return { deletedCount: 0, rounds: 0, remainingTokens, allDeletedToolCallIds, stalledByUserMsg };
  }

  // ── Extract MMD messages before computing delete count ──
  // 中文：── 提取 MMD 消息再计算删除数量 ──
  const mmdMsgs: { msg: any }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._mmdContextMessage || messages[i]._mmdInjection) {
      mmdMsgs.unshift({ msg: messages.splice(i, 1)[0] });
    }
  }

  // ── One-shot: compute exactly how many to delete to reach threshold ──
  // 中文：── 一次性：精确计算需要删除多少以达到阈值 ──
  const maxDeletable = Math.max(0, messages.length - AGGRESSIVE_MIN_MESSAGES_TO_KEEP);
  let deleteCount = computeAggressiveDeleteCount(messages, remainingTokens, aggressiveThreshold, countTokens, maxDeletable);
  deleteCount = adjustDeleteCountForToolPairing(messages, deleteCount);
  const preCapCount = deleteCount;
  deleteCount = capDeleteCountForUserMessage(messages, deleteCount);
  if (deleteCount < preCapCount) {
    logger.debug?.(`[context-offload] L3-AGGRESSIVE capDeleteCountForUserMessage: ${preCapCount} → ${deleteCount} (lastUserIdx=${findLastUserMessageIndex(messages)})`);
  }

  if (deleteCount <= 0) {
    stalledByUserMsg = true;
    logger.warn(`[context-offload] L3-aggressive STALLED: deleteCount=0 (user msg at head?), remaining≈${remainingTokens}, msgs=${messages.length}`);
    // Restore MMD messages
    // 中文：恢复 MMD 消息
    for (const { msg } of mmdMsgs) {
      if (msg._mmdContextMessage === "history" || msg._mmdInjection) {
        messages.splice(findHistoryMmdInsertionPoint(messages), 0, msg);
      } else {
        messages.splice(findActiveMmdInsertionPoint(messages), 0, msg);
      }
    }
    return { deletedCount: 0, rounds: 1, remainingTokens, allDeletedToolCallIds, stalledByUserMsg };
  }

  // ── Calculate deleted token cost and splice ──
  // 中文：── 计算已删除的令牌成本并拼接 ──
  const deletedTokens = tiktokenCount(JSON.stringify(messages.slice(0, deleteCount), jsonReplacer));
  const toDelete = messages.splice(0, deleteCount);

  // Collect tool call IDs
  // 中文：收集工具调用 ID
  for (const msg of toDelete) {
    const toolCallId = extractToolCallId(msg) ?? extractToolUseIdFromAssistant(msg);
    if ((isToolResultMessage(msg) || isToolUseInAssistant(msg)) && toolCallId && allDeletedToolCallIds.length < 200) {
      allDeletedToolCallIds.push(toolCallId);
    }
  }

  remainingTokens -= deletedTokens;
  logger.debug?.(
    `[context-offload] L3-AGGRESSIVE one-shot: deleted=${toDelete.length} msgs, remaining≈${remainingTokens}, msgsLeft=${messages.length}, ` +
    `toolCallIds=[${allDeletedToolCallIds.slice(0, 5).join(",")}${allDeletedToolCallIds.length > 5 ? `...+${allDeletedToolCallIds.length - 5}` : ""}]`,
  );

  // ── Restore MMD context messages ──
  // 中文：── 恢复MMD上下文消息 ──
  for (const { msg } of mmdMsgs) {
    if (msg._mmdContextMessage === "history" || msg._mmdInjection) {
      const restoreIdx = findHistoryMmdInsertionPoint(messages);
      messages.splice(restoreIdx, 0, msg);
    } else {
      const insertIdx = findActiveMmdInsertionPoint(messages);
      messages.splice(insertIdx, 0, msg);
    }
  }

  return { deletedCount: toDelete.length, rounds: 1, remainingTokens, allDeletedToolCallIds, stalledByUserMsg };
}

// ─── Emergency Compression ───────────────────────────────────────────────────
// 中文：─── 紧急压缩 ───────────────────────────────────────────────────

export function emergencyCompress(
  messages: any[],
  targetTokens: number,
  countTokens: (t: string) => number,
  sysPrompt: string | null,
  promptText: string | null,
  logger: PluginLogger,
): { deletedCount: number; deletedToolCallIds: string[]; remainingTokens: number } {
  const mmdMsgs: { msg: any }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._mmdContextMessage || messages[i]._mmdInjection) {
      mmdMsgs.unshift({ msg: messages.splice(i, 1)[0] });
    }
  }

  const deletedToolCallIds: string[] = [];
  let deletedCount = 0;

  // Single full snapshot at entry, then incremental subtraction in the loop
  // 中文：入口处单次全量快照，然后循环中进行增量减法
  let currentTokens = buildTiktokenContextSnapshot("emergency_est", messages, sysPrompt, promptText).totalTokens;

  while (messages.length > EMERGENCY_MIN_MESSAGES_TO_KEEP) {
    if (currentTokens <= targetTokens) break;
    const excessRatio = Math.min(0.5, (currentTokens - targetTokens) / currentTokens);
    let deleteCount2 = Math.max(1, Math.ceil(messages.length * excessRatio));
    deleteCount2 = Math.min(deleteCount2, messages.length - EMERGENCY_MIN_MESSAGES_TO_KEEP);
    while (deleteCount2 < messages.length - EMERGENCY_MIN_MESSAGES_TO_KEEP) {
      const nextMsg = messages[deleteCount2];
      const role = nextMsg?.role ?? nextMsg?.message?.role ?? nextMsg?.type;
      if (role === "toolResult" || role === "tool") { deleteCount2++; } else { break; }
    }
    deleteCount2 = capDeleteCountForUserMessage(messages, deleteCount2);
    if (deleteCount2 <= 0) {
      // Head-delete is blocked (user message at index 0).
      // Fallback: delete the LARGEST non-user messages from the tail to make progress.
      // This is the last resort — emergency MUST make progress.
      // 中文：头部删除被阻止（索引0的消息为用户消息）。备选：从尾部删除最大的非用户消息以取得进展。这是最后手段——紧急情况必须取得进展。
      const tailDeleted = _emergencyTailDelete(messages, targetTokens, currentTokens, deletedToolCallIds, logger);
      deletedCount += tailDeleted.count;
      currentTokens -= tailDeleted.tokens;
      if (tailDeleted.count <= 0) {
        // Both head-delete and tail-delete are stuck.
        // Last-resort: truncate the LARGEST message content in-place.
        // 中文：头部删除和尾部删除都受阻。最后手段：就地截断最大的消息内容。
        const truncResult = _emergencyTruncateOversized(messages, targetTokens, currentTokens, deletedToolCallIds, logger);
        currentTokens -= truncResult.tokensSaved;
        if (truncResult.tokensSaved <= 0) break; // truly nothing left to do
        // 中文：truly nothing left to do
      }
      continue;
    }
    // Calculate deleted tokens before splicing (incremental subtraction)
    // 中文：在拼接前计算已删除的令牌数（增量减法）
    const deletedTokens = tiktokenCount(JSON.stringify(messages.slice(0, deleteCount2), jsonReplacer));
    const toDelete = messages.splice(0, deleteCount2);
    currentTokens -= deletedTokens;
    for (const msg of toDelete) {
      if (isToolResultMessage(msg) || isToolUseInAssistant(msg)) {
        const toolCallId = extractToolCallId(msg) ?? extractToolUseIdFromAssistant(msg);
        if (toolCallId) deletedToolCallIds.push(toolCallId);
      }
    }
    deletedCount += toDelete.length;
  }

  // Restore MMD messages and compensate token count
  // 中文：恢复MMD消息并补偿令牌计数
  for (const { msg } of mmdMsgs) {
    const mmdTokens = tiktokenCount(JSON.stringify(msg, jsonReplacer));
    if (msg._mmdContextMessage === "history" || msg._mmdInjection) {
      const restoreIdx = findHistoryMmdInsertionPoint(messages);
      messages.splice(restoreIdx, 0, msg);
    } else {
      // Active MMD: use the same insertion logic as mmd-injector to avoid
      // breaking tool_call/tool_result pairing or user→assistant alternation.
      // 中文：活跃MMD：使用mmd-injector相同的插入逻辑以避免破坏tool_call/tool_result配对或用户→助手交替。
      const insertIdx = findActiveMmdInsertionPoint(messages);
      messages.splice(insertIdx, 0, msg);
    }
    currentTokens += mmdTokens;
  }

  return { deletedCount, deletedToolCallIds, remainingTokens: currentTokens };
}

/**
 * Emergency tail-delete: when head-delete is blocked by user message at index 0,
 * delete the largest deletable **tool pair group** (assistant[tool_use] + all its
 * toolResults) to avoid orphaned tool_use/tool_result (Anthropic 400 error).
 *
 * Strategy:
 * 1. Scan messages to build "tool pair groups" — each group is an assistant
 *    message with tool_use blocks + all its corresponding toolResult messages.
 * 2. Score each group by total token count.
 * 3. Delete the largest group. Repeat until below target.
 *
 * Non-tool messages (plain assistant text, user messages other than the last)
 * are also candidates and treated as single-message groups.
 * 中文：紧急尾删除：当头部删除因用户消息在索引0处被阻止时，删除可删除的最大**工具对组**（assistant[tool_use] + 所有其对应的toolResults）以避免孤立的tool_use/tool_result（Anthropic 400错误）。
 * 策略：
 * 1. 扫描消息构建“工具对组”——每个组是一个包含工具使用块的assistant消息及其所有对应的toolResult消息。
 * 2. 按总token数为每个组评分。
 * 3. 删除最大的组。重复直到低于目标。
 * 非工具消息（纯assistant文本、除最后一条外的用户消息）也是候选者，并被视为单条消息组。
 */
function _emergencyTailDelete(
  messages: any[],
  targetTokens: number,
  currentTokens: number,
  deletedToolCallIds: string[],
  logger: PluginLogger,
): { count: number; tokens: number } {
  let totalDeleted = 0;
  let totalTokensDeleted = 0;

  while (currentTokens - totalTokensDeleted > targetTokens && messages.length > EMERGENCY_MIN_MESSAGES_TO_KEEP) {
    const lastUserIdx = findLastUserMessageIndex(messages);

    // Build tool pair groups: map assistant(tool_use) index → set of related toolResult indices
    // 中文：构建工具对组：将assistant(tool_use)索引映射到相关toolResult索引集合
    const groups: Array<{ indices: number[]; tokens: number; toolCallIds: string[] }> = [];
    const claimed = new Set<number>(); // indices already in a group
    // 中文：indices already in a group

    // Pass 1: Find assistant(tool_use) messages and their paired toolResults
    // 中文：第一遍：查找assistant(tool_use)消息及其配对的toolResults
    for (let i = 1; i < messages.length; i++) {
      if (claimed.has(i)) continue;
      if (i === lastUserIdx) continue; // protect last user
      // 中文：protect last user
      const msg = messages[i];
      const tuIds = extractAllToolUseIds(msg);
      if (tuIds.length > 0 && isAssistantMessageWithToolUse(msg)) {
        const groupIndices = [i];
        const groupToolCallIds = [...tuIds];
        claimed.add(i);
        // Find all paired toolResult messages for these tool_use IDs
        // 中文：为这些tool_use ID找到所有配对的toolResult消息
        const tuIdSet = new Set(tuIds);
        for (let j = i + 1; j < messages.length; j++) {
          if (claimed.has(j)) continue;
          if (j === lastUserIdx) continue;
          if (isToolResultMessage(messages[j])) {
            const tid = extractToolCallId(messages[j]);
            if (tid && tuIdSet.has(tid)) {
              groupIndices.push(j);
              claimed.add(j);
              tuIdSet.delete(tid);
              if (tuIdSet.size === 0) break;
            }
          }
        }
        // Calculate total tokens for the group
        // 中文：计算该组的总token数
        let groupTokens = 0;
        for (const idx of groupIndices) {
          groupTokens += tiktokenCount(JSON.stringify(messages[idx], jsonReplacer));
        }
        groups.push({ indices: groupIndices, tokens: groupTokens, toolCallIds: groupToolCallIds });
      }
    }

    // Pass 2: Add orphaned toolResult messages (no paired assistant) as single-msg groups
    // 中文：第二遍：将孤立的toolResult消息（无配对assistant）作为单条消息组添加
    for (let i = 1; i < messages.length; i++) {
      if (claimed.has(i)) continue;
      if (i === lastUserIdx) continue;
      if (messages.length - i <= 1) continue; // protect last message
      // 中文：protect last message
      const msg = messages[i];
      if (isToolResultMessage(msg)) {
        const tid = extractToolCallId(msg);
        const t = tiktokenCount(JSON.stringify(msg, jsonReplacer));
        groups.push({ indices: [i], tokens: t, toolCallIds: tid ? [tid] : [] });
        claimed.add(i);
      }
    }

    // Pass 3: Add plain assistant messages (no tool_use) as single-msg groups
    // 中文：第三遍：将纯assistant消息（无tool_use）作为单条消息组添加
    for (let i = 1; i < messages.length; i++) {
      if (claimed.has(i)) continue;
      if (i === lastUserIdx) continue;
      if (messages.length - i <= 1) continue;
      const msg = messages[i];
      const role = msg.role ?? msg.message?.role ?? msg.type;
      if (role === "assistant") {
        const t = tiktokenCount(JSON.stringify(msg, jsonReplacer));
        groups.push({ indices: [i], tokens: t, toolCallIds: [] });
        claimed.add(i);
      }
    }

    if (groups.length === 0) break;

    // Find the group with the most tokens
    // 中文：找到token最多的组
    groups.sort((a, b) => b.tokens - a.tokens);
    const best = groups[0];
    if (best.tokens <= 0) break;

    // Would deleting this group leave fewer than MIN_KEEP messages?
    // 中文：删除这个组是否会留下少于MIN_KEEP条消息？
    if (messages.length - best.indices.length < EMERGENCY_MIN_MESSAGES_TO_KEEP) break;

    // Delete the group (indices in reverse order to avoid index shift issues)
    // 中文：删除组（按逆序索引以避免索引偏移问题）
    const sortedIndices = [...best.indices].sort((a, b) => b - a);
    for (const idx of sortedIndices) {
      messages.splice(idx, 1);
    }
    for (const tid of best.toolCallIds) {
      deletedToolCallIds.push(tid);
    }
    totalDeleted += best.indices.length;
    totalTokensDeleted += best.tokens;
    logger.debug?.(
      `[context-offload] EMERGENCY tail-delete: removed ${best.indices.length} msgs (group tokens=${best.tokens}, ids=[${best.toolCallIds.slice(0, 3).join(",")}${best.toolCallIds.length > 3 ? "..." : ""}]), remaining≈${currentTokens - totalTokensDeleted}`,
    );
  }

  return { count: totalDeleted, tokens: totalTokensDeleted };
}

/**
 * Emergency truncate: when both head-delete and tail-delete are blocked
 * (e.g. only MIN_KEEP messages remain but one is 142K tokens), truncate
 * the LARGEST message content in-place to break the deadlock.
 *
 * Strategy:
 * 1. Find the largest non-user message by token count.
 * 2. If it's a tool result, replace content with a truncated stub.
 * 3. If truncation fails or message is protected, try deleting it entirely
 *    (ignoring MIN_KEEP for this single critical operation).
 *
 * This ensures emergency ALWAYS makes progress regardless of MIN_KEEP constraints.
 * 中文：紧急截断：当头部删除和尾部删除都被阻止时
 * （例如，仅剩的MIN_KEEP条消息中有一条是142K个令牌），就地截断
 * 最大的消息内容以打破死锁。
 * 策略：
 * 1. 通过令牌数找到最大的非用户消息。
 * 2. 如果它是工具结果，则用截断后的占位符替换内容。
 * 3. 如果截断失败或消息受保护，尝试完全删除它（忽略MIN_KEEP在此关键操作中的约束）。
 * 这确保了紧急情况总是能够进展，不受MIN_KEEP的限制。
 */
function _emergencyTruncateOversized(
  messages: any[],
  targetTokens: number,
  currentTokens: number,
  deletedToolCallIds: string[],
  logger: PluginLogger,
): { tokensSaved: number } {
  const lastUserIdx = findLastUserMessageIndex(messages);
  let bestIdx = -1;
  let bestTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    if (i === lastUserIdx) continue; // protect last user message
    // 中文：保护最后用户的消息
    const msg = messages[i];
    if (msg._mmdContextMessage || msg._mmdInjection) continue;
    const tokens = tiktokenCount(JSON.stringify(msg, jsonReplacer));
    if (tokens > bestTokens) {
      bestTokens = tokens;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestTokens <= 0) return { tokensSaved: 0 };

  // Skip if the largest message is already small enough — truncation would
  // make it LARGER (stub text overhead > original content). ~600 tokens is
  // the approximate size of the stub + preview.
  // 中文：如果最大的消息已经足够小——截断会使它更大（占位符文本开销 > 原始内容）。大约600个令牌是占位符+预览的大致大小。
  if (bestTokens < 600) return { tokensSaved: 0 };

  const msg = messages[bestIdx];
  const role = msg.role ?? msg.message?.role ?? msg.type;
  const isAssistantTU = isAssistantMessageWithToolUse(msg);
  const toolCallId = extractToolCallId(msg) ?? extractToolUseIdFromAssistant(msg);


  // Try truncation first: replace content with a short stub
  // 中文：首先尝试截断：用短占位符替换内容
  try {
    if (isAssistantTU) {
      // Assistant with tool_use: preserve tool_use block structure (id, name, type)
      // but replace input/arguments with a compact stub to maintain tool pairing.
      // 中文：带有tool_use的助手：保留tool_use块结构（id, name, type），但用紧凑的占位符替换输入/参数以保持工具配对。
      _truncateAssistantToolUseContent(msg, bestTokens, logger);
    } else {
      // toolResult / plain assistant / other: safe to replace entire content
      // 中文：toolResult / 原始助手 / 其他：可以安全地替换整个内容
      const stubText =
        `[Tool output truncated for context management. Original ~${bestTokens} tokens, role=${role}${toolCallId ? `, id=${toolCallId}` : ""}]`;
      _setMessageContent(msg, stubText);
      // Also strip any other large fields that may exist on the message
      // (OpenClaw tool results can have output/result/data fields outside content)
      // 中文：还应移除消息上可能存在的其他大字段
      // （OpenClaw工具结果可以在content之外有output/result/data字段）
      _stripLargeFields(msg);
    }
    // Invalidate WeakMap token cache so buildTiktokenContextSnapshot sees the new size
    // 中文：清空WeakMap令牌缓存以使buildTiktokenContextSnapshot看到新的大小
    invalidateTokenCache(msg);
    // Also clean up any legacy per-message cache markers
    // 中文：同时清理任何遗留的消息缓存标记
    if (msg._cachedTokens !== undefined) delete msg._cachedTokens;
    if (msg._tokenCount !== undefined) delete msg._tokenCount;

    const afterTokens = tiktokenCount(JSON.stringify(msg, jsonReplacer));
    const saved = bestTokens - afterTokens;

    if (toolCallId) deletedToolCallIds.push(toolCallId);

    logger.warn(
      `[context-offload] EMERGENCY truncate-in-place: idx=${bestIdx}, role=${role}, isToolUse=${isAssistantTU}, ` +
      `${bestTokens}→${afterTokens} tokens (saved=${saved}), id=${toolCallId ?? "N/A"}`,
    );
    return { tokensSaved: saved };
  } catch (truncErr) {
    // Truncation failed — force-delete the message regardless of MIN_KEEP.
    // If it's an assistant with tool_use, also remove its paired toolResult
    // messages to avoid orphaned tool results (Anthropic 400 error).
    // 中文：截断失败——无视MIN_KEEP强制删除消息，如果是带有tool_use的助手，则一并移除其配对的toolResult消息以避免孤立的工具结果（Anthropic 400错误）
    logger.warn(`[context-offload] EMERGENCY truncate failed (${truncErr}), force-deleting msg idx=${bestIdx}`);
    let totalSaved = bestTokens;
    const tuIds = isAssistantTU ? new Set(extractAllToolUseIds(msg)) : null;
    messages.splice(bestIdx, 1);
    if (toolCallId) deletedToolCallIds.push(toolCallId);

    // Clean up orphaned toolResult messages for the deleted tool_use IDs
    // 中文：清理已删除tool_use ID对应的孤立toolResult消息
    if (tuIds && tuIds.size > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!isToolResultMessage(messages[i])) continue;
        const tid = extractToolCallId(messages[i]);
        if (tid && tuIds.has(tid)) {
          totalSaved += tiktokenCount(JSON.stringify(messages[i], jsonReplacer));
          messages.splice(i, 1);
          deletedToolCallIds.push(tid);
          tuIds.delete(tid);
          if (tuIds.size === 0) break;
        }
      }
    }
    return { tokensSaved: totalSaved };
  }
}

/**
 * Truncate an assistant message with tool_use blocks while preserving
 * tool_use structure (type, id, name) to maintain tool pairing.
 * Replaces text blocks with a stub and tool_use input with a compact marker.
 * 中文：在保留tool_use结构（类型、ID、名称）的前提下截断助手消息，以保持工具配对，用占位符替换文本块并将tool_use输入替换成紧凑标记
 */
function _truncateAssistantToolUseContent(msg: any, originalTokens: number, logger: PluginLogger): void {
  const content = msg.content ?? msg.message?.content;
  if (!Array.isArray(content)) {
    // Not array content — fall back to simple text replacement
    // 中文：不是数组内容——回退到简单的文本替换
    _setMessageContent(msg, `[Assistant tool_use message truncated for context management. Original ~${originalTokens} tokens. Tool call arguments removed.]`);
    return;
  }
  // Insert a truncation notice as the first text block
  // 中文：插入一个截断通知作为第一个文本块
  content.unshift({
    type: "text",
    text: `[Assistant message truncated for context management. Original ~${originalTokens} tokens. Tool call arguments below replaced with stubs.]`,
  });
  for (let i = 1; i < content.length; i++) {
    const block = content[i] as any;
    if (block.type === "tool_use" || block.type === "toolCall") {
      // Preserve id/name/type, replace input with compact stub
      // 中文：保留id/名称/类型，用紧凑占位符替换输入
      if (block.input !== undefined) {
        block.input = { _truncated: true, _original_tokens: originalTokens };
      }
      if (block.arguments !== undefined) {
        block.arguments = { _truncated: true, _original_tokens: originalTokens };
      }
    } else if (block.type === "text") {
      // Truncate text blocks
      // 中文：文本块截断
      block.text = typeof block.text === "string"
        ? block.text.slice(0, 200) + (block.text.length > 200 ? "…[truncated]" : "")
        : "[truncated]";
    }
  }
}

/** Extract a preview of message content (first N chars) */
/** 中文：提取消息内容的预览（前N个字符） */
function _extractContentPreview(msg: any, maxChars: number): string {
  const content = msg.content ?? msg.message?.content;
  if (typeof content === "string") {
    return content.slice(0, maxChars);
  }
  if (Array.isArray(content)) {
    let result = "";
    for (const block of content) {
      const text = typeof block === "string" ? block : (block.text ?? "");
      result += text;
      if (result.length >= maxChars) break;
    }
    return result.slice(0, maxChars);
  }
  return "";
}

/** Set message content (handles both direct and transcript wrapper format) */
/** 中文：设置消息内容（处理直接和转录包装格式） */
function _setMessageContent(msg: any, text: string): void {
  if (msg.type === "message" && msg.message) {
    if (Array.isArray(msg.message.content)) {
      msg.message.content = [{ type: "text", text }];
    } else {
      msg.message.content = text;
    }
  } else {
    if (Array.isArray(msg.content)) {
      msg.content = [{ type: "text", text }];
    } else {
      msg.content = text;
    }
  }
}

/**
 * Strip large non-essential fields from a message after content truncation.
 * OpenClaw tool result messages may store the raw output in fields like
 * `output`, `result`, `data`, `rawContent`, `response`, etc. that are
 * outside of `content` but still get serialized and counted as tokens.
 *
 * Preserves structural fields (role, type, id, toolCallId, name, tool_call_id).
 * 中文：在内容截断后从消息中剥离大型非必要字段。
 * OpenClaw 工具结果消息可能在外层字段如`output`、`result`、`data`、`rawContent`、`response`等存储原始输出，这些字段位于`content`之外但仍会被序列化并计入token数。
 * 保留结构字段（role、type、id、toolCallId、name、tool_call_id）
 */
function _stripLargeFields(msg: any): void {
  const PRESERVE_KEYS = new Set([
    "role", "type", "name", "id", "toolCallId", "tool_call_id",
    "content", "message", "status",
    // internal plugin markers
    // 中文：内部插件标记
    "_offloaded", "_mmdContextMessage", "_mmdInjection", "_contextOffloadProcessed",
    "_cachedTokens", "_tokenCount",
  ]);
  const LARGE_THRESHOLD = 500; // chars — delete any field value > 500 chars serialized
  // 中文：chars — 删除任何序列化后超过500字符的字段值

  const stripObj = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      if (PRESERVE_KEYS.has(key)) continue;
      const val = obj[key];
      if (val === null || val === undefined) continue;
      const serialized = typeof val === "string" ? val : JSON.stringify(val);
      if (serialized && serialized.length > LARGE_THRESHOLD) {
        delete obj[key];
      }
    }
  };

  stripObj(msg);
  // Also strip inside the transcript wrapper
  // 中文：也在转录包装内剥离
  if (msg.type === "message" && msg.message && typeof msg.message === "object") {
    stripObj(msg.message);
  }
}

// ─── History MMD Injection ───────────────────────────────────────────────────
// 中文：───────── 历史MMD注入 ───────────────────────────────────────────────────

export function removeExistingMmdInjections(messages: any[]): number {
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._mmdInjection) { messages.splice(i, 1); removed++; }
  }
  return removed;
}

export async function buildHistoryMmdInjection(
  deletedToolCallIds: string[],
  offloadMap: Map<string, OffloadEntry>,
  offloadEntries: OffloadEntry[],
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  countTokens: (t: string) => number,
  contextWindow: number,
  pluginConfig: Partial<PluginConfig> | undefined,
): Promise<{ injectedMessages: any[]; totalMmdTokens: number; mmdTokenBudget: number; mmdFiles: string[] }> {
  const mmdMaxTokenRatio = pluginConfig?.mmdMaxTokenRatio ?? PLUGIN_DEFAULTS.mmdMaxTokenRatio;
  const mmdTokenBudget = Math.floor(contextWindow * mmdMaxTokenRatio);
  const deletedMmdPrefixes = new Set<string>();
  for (const toolCallId of deletedToolCallIds) {
    const entry = getOffloadEntry(offloadMap, toolCallId);
    if (entry?.node_id) {
      const prefix = entry.node_id.split("-")[0];
      if (prefix) deletedMmdPrefixes.add(prefix);
    }
  }
  if (deletedMmdPrefixes.size === 0) return { injectedMessages: [], totalMmdTokens: 0, mmdTokenBudget, mmdFiles: [] };

  const allMmdFiles = await listMmds(stateManager.ctx);
  const activeMmd = stateManager.getActiveMmdFile();
  const candidateMmds: string[] = [];
  for (const filename of allMmdFiles) {
    const filePrefix = filename.split("-")[0];
    if (deletedMmdPrefixes.has(filePrefix) && filename !== activeMmd) candidateMmds.push(filename);
  }
  if (candidateMmds.length === 0) return { injectedMessages: [], totalMmdTokens: 0, mmdTokenBudget, mmdFiles: [] };

  // Reverse: most recent MMDs first (highest prefix number = most recent task)
  // 中文：逆序：最近的MMD最先（最高前缀编号=最近年任务）
  candidateMmds.reverse();

  const injectedMessages: any[] = [];
  const mmdFiles: string[] = [];
  let totalMmdTokens = 0;
  for (const filename of candidateMmds) {
    const mmdContent = await readMmd(stateManager.ctx, filename);
    if (!mmdContent) continue;

    // Try full content first
    // 中文：先尝试完整内容
    const fullText = buildHistoryMmdText(filename, mmdContent);
    const fullTokens = countTokens(fullText);
    if (totalMmdTokens + fullTokens <= mmdTokenBudget) {
      injectedMessages.push({ role: "user", content: [{ type: "text", text: fullText }], _mmdInjection: true });
      totalMmdTokens += fullTokens;
      mmdFiles.push(filename);
      continue;
    }

    // Full content exceeds budget — try meta-only (filename + taskGoal + node summary)
    // 中文：完整内容超出预算——尝试仅元数据（文件名+任务目标+节点摘要）
    const metaText = buildHistoryMmdMetaText(filename, mmdContent);
    const metaTokens = countTokens(metaText);
    if (totalMmdTokens + metaTokens <= mmdTokenBudget) {
      logger.debug?.(`[context-offload] History MMD ${filename}: full=${fullTokens} tokens exceeds budget, injecting meta-only (${metaTokens} tokens)`);
      injectedMessages.push({ role: "user", content: [{ type: "text", text: metaText }], _mmdInjection: true });
      totalMmdTokens += metaTokens;
      mmdFiles.push(`${filename}(meta)`);
      continue;
    }

    // Even meta exceeds budget — skip entirely
    // 中文：即使元数据也超出预算——完全跳过
    logger.debug?.(`[context-offload] History MMD ${filename}: skipped (full=${fullTokens}, meta=${metaTokens}, remaining budget=${mmdTokenBudget - totalMmdTokens})`);
  }

  // Reverse back so oldest appears first in messages (chronological order for LLM)
  // 中文：反序排列以便最旧的内容首先出现（按时间顺序排列给LLM）
  injectedMessages.reverse();
  mmdFiles.reverse();

  return { injectedMessages, totalMmdTokens, mmdTokenBudget, mmdFiles };
}

function buildHistoryMmdText(filename: string, mmdContent: string): string {
  let taskGoal = "";
  const metaMatch = mmdContent.match(/^%%\{\s*(.*?)\s*\}%%/);
  if (metaMatch) {
    try { const meta = JSON.parse(`{${metaMatch[1]}}`); taskGoal = meta.taskGoal || ""; } catch { /* */ }
  }
  return [
    `<history_task_context file="${filename}">`,
    `【历史任务上下文】以下是一个已完成/暂停的历史任务的状态图。`,
    taskGoal ? `**任务目标:** ${taskGoal}` : "",
    ``, "```mermaid", mmdContent, "```", `</history_task_context>`,
  ].filter((line) => line !== "").join("\n");
}

/** Compact meta-only version when full MMD exceeds token budget */
/** 中文：当全量MMD超过令牌预算时压缩为仅元数据版本 */
function buildHistoryMmdMetaText(filename: string, mmdContent: string): string {
  let taskGoal = "";
  const metaMatch = mmdContent.match(/^%%\{\s*(.*?)\s*\}%%/);
  if (metaMatch) {
    try { const meta = JSON.parse(`{${metaMatch[1]}}`); taskGoal = meta.taskGoal || ""; } catch { /* */ }
  }
  // Extract node summaries from mermaid: lines like `001-N1["some label"]`
  // 中文：从mermaid提取节点摘要：类似`001-N1["some label"]`的行
  const nodePattern = /(\d{3}-N\d+)\["([^"]+)"\]/g;
  const nodes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = nodePattern.exec(mmdContent)) !== null) {
    nodes.push(`${m[1]}: ${m[2]}`);
  }
  // Extract status classes: classDef done/doing/todo + class assignments
  // 中文：提取状态类：done/doing/todo + 类别分配
  const statusLines: string[] = [];
  const classAssign = /class\s+([\w,-]+)\s+(done|doing|todo)/g;
  while ((m = classAssign.exec(mmdContent)) !== null) {
    statusLines.push(`${m[1]} → ${m[2]}`);
  }
  return [
    `<history_task_context file="${filename}" mode="meta-only">`,
    `【历史任务摘要】以下是一个历史任务的元信息（原图已省略以节省上下文）。`,
    taskGoal ? `**任务目标:** ${taskGoal}` : "",
    `**任务文件:** ${filename}`,
    nodes.length > 0 ? `**节点:** ${nodes.join("; ")}` : "",
    statusLines.length > 0 ? `**状态:** ${statusLines.join("; ")}` : "",
    `</history_task_context>`,
  ].filter((line) => line !== "").join("\n");
}

// ─── Internal helpers ────────────────────────────────────────────────────────
// 中文：─── 内部辅助函数 ────────────────────────────────────────────────────────

function extractLatestTurn(historyMessages: any[], currentPrompt: string | null): string | null {
  let lastAssistant: string | null = null;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (msg._mmdContextMessage || msg._mmdInjection) continue;
    const role = msg.role ?? msg.message?.role ?? msg.type;
    if (role === "assistant") {
      const text = extractMsgText(msg);
      if (text && text.length > 10) { lastAssistant = text.slice(0, 600); break; }
    }
  }
  const parts: string[] = [];
  if (currentPrompt) parts.push(`[Current User Message]: ${currentPrompt.slice(0, 500)}`);
  if (lastAssistant) parts.push(`[Assistant]: ${lastAssistant}`);
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractMsgText(msg: any): string {
  const content = msg.content ?? msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join(" ");
  return "";
}

async function fastPathReApply(messages: any[], stateManager: OffloadStateManager, logger: PluginLogger): Promise<{ applied: number; deleted: number }> {
  const hasConfirmed = stateManager.confirmedOffloadIds?.size > 0;
  const hasDeleted = stateManager.deletedOffloadIds?.size > 0;
  if (!hasConfirmed && !hasDeleted) return { applied: 0, deleted: 0 };

  let needsWork = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg._offloaded) continue;
    const tid = extractToolCallId(msg);
    if (!tid) continue;
    const tidNorm = normalizeToolCallIdForLookup(tid);
    if (hasDeleted && (stateManager.deletedOffloadIds.has(tid) || stateManager.deletedOffloadIds.has(tidNorm))) { needsWork = true; break; }
    if (hasConfirmed && (stateManager.confirmedOffloadIds.has(tid) || stateManager.confirmedOffloadIds.has(tidNorm))) {
      if (isToolResultMessage(msg)) { needsWork = true; break; }
    }
  }
  if (!needsWork) return { applied: 0, deleted: 0 };

  let offloadMap = stateManager.getCachedOffloadMap();
  if (!offloadMap) {
    const offloadEntries = await readOffloadEntries(stateManager.ctx);
    offloadMap = new Map();
    populateOffloadLookupMap(offloadMap, offloadEntries);
    stateManager.setCachedOffloadMap(offloadMap);
  }

  let applied = 0;
  const indicesToDelete: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const tid = extractToolCallId(msg);
    const tidNorm = tid ? normalizeToolCallIdForLookup(tid) : null;
    if (tid && hasDeleted && (stateManager.deletedOffloadIds.has(tid) || (tidNorm && stateManager.deletedOffloadIds.has(tidNorm)))) {
      indicesToDelete.push(i); continue;
    }
    if (hasDeleted && isOnlyToolUseAssistant(msg)) {
      const tuIds = extractAllToolUseIds(msg);
      if (tuIds.length > 0 && tuIds.every((id) => stateManager.deletedOffloadIds.has(id) || stateManager.deletedOffloadIds.has(normalizeToolCallIdForLookup(id)))) {
        indicesToDelete.push(i); continue;
      }
    }
    // FIX: For mixed assistant messages (text + tool_use), strip deleted tool_use
    // blocks to prevent orphaned tool_use without matching tool_result (Anthropic 400).
    // 中文：FIX: 对于混合助手消息（文本+工具使用），移除被删除的工具使用块以防止孤立的工具使用没有对应的工具结果（Anthropic 400）。
    if (hasDeleted && isAssistantMessageWithToolUse(msg) && !isOnlyToolUseAssistant(msg)) {
      const content = msg.type === "message" ? msg.message?.content : msg.content;
      if (Array.isArray(content)) {
        for (let j = content.length - 1; j >= 0; j--) {
          const block = content[j] as any;
          if ((block.type === "tool_use" || block.type === "toolCall") && block.id) {
            const blockIdNorm = normalizeToolCallIdForLookup(block.id);
            if (stateManager.deletedOffloadIds.has(block.id) || stateManager.deletedOffloadIds.has(blockIdNorm)) {
              content.splice(j, 1);
            }
          }
        }
      }
    }
    if (msg._offloaded) continue;
    if (tid && hasConfirmed && (stateManager.confirmedOffloadIds.has(tid) || (tidNorm && stateManager.confirmedOffloadIds.has(tidNorm)))) {
      const entry = getOffloadEntry(offloadMap, tid);
      if (entry && isToolResultMessage(msg)) {
        replaceWithSummary(msg, entry);
        msg._offloaded = true;
        applied++;
      }
    }
    if (isOnlyToolUseAssistant(msg)) {
      const tuIds = extractAllToolUseIds(msg);
      const allConfirmed = tuIds.length > 0 && tuIds.every((id) =>
        stateManager.confirmedOffloadIds.has(id) || stateManager.confirmedOffloadIds.has(normalizeToolCallIdForLookup(id)));
      if (allConfirmed) {
        const tuEntries = tuIds.map((id) => getOffloadEntry(offloadMap, id)).filter(Boolean) as OffloadEntry[];
        if (tuEntries.length === tuIds.length) {
          replaceAssistantToolUseWithSummary(msg, tuEntries);
          msg._offloaded = true;
          applied++;
        }
      }
    } else if (isAssistantMessageWithToolUse(msg)) {
      compressNonCurrentToolUseBlocks(msg, offloadMap, new Set(), stateManager.confirmedOffloadIds);
    }
  }
  if (indicesToDelete.length > 0) {
    for (let k = indicesToDelete.length - 1; k >= 0; k--) messages.splice(indicesToDelete[k], 1);
  }
  return { applied, deleted: indicesToDelete.length };
}
