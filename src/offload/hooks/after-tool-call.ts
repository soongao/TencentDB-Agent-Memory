/**
 * after_tool_call hook handler.
 * Collects tool call + result pairs into the pending buffer.
 * Post-tool token snapshot via tiktoken + inline L3 compression.
 * 中文：after_tool_call hook处理器。
 * 收集工具调用+结果对到待处理缓冲区中。
 * 通过tiktoken + 内联L3压缩发送工具调用后的时间戳快照。
 */
import { nowChinaISO } from "../time-utils.js";
import { buildTiktokenContextSnapshot, type ContextSnapshot } from "../context-token-tracker.js";
import { traceOffloadDecision, traceMessagesSnapshot } from "../opik-tracer.js";
import { PLUGIN_DEFAULTS } from "../types.js";
import { readOffloadEntries, markOffloadStatus, readMmd } from "../storage.js";
import { createL3TokenCounter } from "../l3-token-counter.js";
import {
  normalizeToolCallIdForLookup,
  populateOffloadLookupMap,
  getCurrentTaskNodeIds,
  extractToolCallId,
  isToolResultMessage,
  isToolUseInAssistant,
  extractToolUseIdFromAssistant,
} from "../l3-helpers.js";
import {
  compressByScoreCascade,
  aggressiveCompressUntilBelowThreshold,
  buildHistoryMmdInjection,
  removeExistingMmdInjections,
  emergencyCompress,
  EMERGENCY_MIN_MESSAGES_TO_KEEP,
  isTokenOverflowError,
  dumpMessagesSnapshot,
} from "./llm-input-l3.js";
import { MMD_MESSAGE_MARKER, findActiveMmdInsertionPoint, findHistoryMmdInsertionPoint } from "../mmd-injector.js";
import type { OffloadStateManager } from "../state-manager.js";
import type { PluginConfig, PluginLogger, ToolPair } from "../types.js";
import type { BackendClient } from "../backend-client.js";
import {
  buildL3TriggerReport,
  classifyPatchEffectiveness,
  reportL3Trigger,
  recordToolCall,
  REPORT_TYPE_L3,
  L3_FIXED_PATCH_COST_TOKENS,
} from "../state-reporter.js";

function isHeartbeatToolCall(event: any, cachedParams: any): boolean {
  try {
    const params = event.params ?? cachedParams;
    if (!params) return false;
    const raw = typeof params === "string" ? params : JSON.stringify(params);
    return raw.includes("HEARTBEAT.md");
  } catch {
    return false;
  }
}

function _extractParamsFromMessages(messages: any[], toolCallId: string): any {
  if (!messages || !Array.isArray(messages) || !toolCallId) return null;
  const normId = toolCallId.replace(/_/g, "");
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg.role ?? msg.message?.role ?? msg.type;
    if (role !== "assistant") continue;
    const content = msg.content ?? msg.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          (block.type === "tool_use" || block.type === "toolCall") &&
          (block.id === toolCallId || block.id?.replace(/_/g, "") === normId)
        ) {
          const input = block.input ?? _tryParseArgs(block.arguments);
          if (input && typeof input === "object" && (input as any)._offloaded) continue;
          return input ?? null;
        }
      }
    }
    const toolCalls = msg.tool_calls ?? msg.message?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc.id === toolCallId || tc.id?.replace(/_/g, "") === normId) {
          return _tryParseArgs(tc.function?.arguments) ?? tc.function?.parameters ?? tc.input ?? null;
        }
      }
    }
  }
  return null;
}

function _tryParseArgs(args: any): any {
  if (args == null) return null;
  if (typeof args === "object") return args;
  if (typeof args !== "string") return null;
  try { return JSON.parse(args); } catch { return null; }
}

export function createAfterToolCallHandler(
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  getContextWindow: (() => number) | undefined,
  pluginConfig: Partial<PluginConfig> | undefined,
  backendClient?: BackendClient | null,
) {
  return async (event: any, ctx: any) => {
    // Skip internal memory-pipeline sessions
    // 中文：跳过内部内存流水线会话
    const _sk = stateManager.getLastSessionKey() ?? ctx?.sessionKey;
    if (typeof _sk === "string" && /memory-.*-session-\d+/.test(_sk)) return;

    // Count every observed tool call for cumulative reporting. Done before
    // any early-return branch so the counter reflects the real invocation
    // rate, not just the cases where L3 actually runs.
    // 中文：为累计报告计数每次观察到的工具调用。在任何早期返回分支之前完成，以反映实际调用率，而不是仅仅反映L3运行的情况。
    recordToolCall();

    const eventKeys = event ? Object.keys(event) : [];
    const hasMsgsKey = "messages" in (event ?? {});
    const msgsValue = event?.messages;
    const hasMsgs = msgsValue && Array.isArray(msgsValue);
    logger.debug?.(`[context-offload] after_tool_call event keys=[${eventKeys.join(",")}], hasMsgsKey=${hasMsgsKey}, msgsType=${typeof msgsValue}, isArray=${Array.isArray(msgsValue)}, len=${hasMsgs ? msgsValue.length : "N/A"}`);

    // ── Patch-effectiveness detection ──
    // The upstream runtime patch is expected to populate event.messages with
    // the current conversation. If it is missing/empty the patch is NOT in
    // effect and L3 compression cannot run from this hook. Report that
    // explicitly so operators can detect misconfigurations.
    // 中文：── 贴片效果检测 ──
    // 上游运行时贴片应填充event.messages以包含当前对话内容。如果缺失/为空，则该贴片无效，从此挂钩无法运行L3压缩。明确报告这一点以便操作员可以检测配置错误。
    const _patchStatus = classifyPatchEffectiveness(event, "after_tool_call");
    if (_patchStatus.status !== "effective") {
      logger.warn(
        `[context-offload] after_tool_call patch check: NOT EFFECTIVE (status=${_patchStatus.status}). ` +
        `event.messages is ${Array.isArray(msgsValue) ? "empty array" : typeof msgsValue}. ` +
        `L3 compression will be skipped this turn.`,
      );
      if (backendClient) {
        try {
          backendClient
            .storeState({
              reportType: REPORT_TYPE_L3,
              reportedAt: new Date().toISOString(),
              sessionKey: _sk ?? null,
              stage: "after_tool_call",
              triggerReason: "patch_not_effective",
              patch: _patchStatus,
              pluginState: {
                l15Settled: stateManager.l15Settled === true,
                pendingCount: stateManager.getPendingCount(),
                activeMmdFile: stateManager.getActiveMmdFile?.() ?? null,
              },
              fixedPatchCostTokens: L3_FIXED_PATCH_COST_TOKENS,
            })
            .catch((err) => logger.warn(`[context-offload] patch-miss report failed: ${err}`));
        } catch { /* ignore */ }
        // 中文：ignore
      }
    }

    const toolCallId = event.toolCallId ?? ctx.toolCallId ?? `auto-${Date.now()}`;
    const cachedParams = stateManager.consumeToolParams(toolCallId);
    const messagesParams =
      !event.params && !cachedParams
        ? _extractParamsFromMessages(event.messages, toolCallId)
        : null;
    const resolvedParams = event.params ?? cachedParams ?? messagesParams ?? {};

    if (stateManager.isProcessed(toolCallId)) return;
    if (isHeartbeatToolCall(event, resolvedParams)) {
      stateManager.processedToolCallIds.add(toolCallId);
      return;
    }

    // Skip tool calls that are stuck at approval-pending — they have no useful
    // result and would waste L1 LLM tokens generating meaningless summaries.
    // Only check the structured status field to avoid false positives from
    // tool results that happen to contain "Approval required" in their text.
    // 中文：跳过处于审批待定状态的工具调用——它们没有有用的结果，并且会浪费L1 LLM令牌生成无意义的摘要。
    // 仅检查结构化状态字段以避免由于工具结果文本中偶然包含“需要批准”而导致的误报。
    const isApprovalPending = event.result?.details?.status === "approval-pending";
    if (isApprovalPending) {
      logger.debug?.(`[context-offload] after_tool_call: SKIP approval-pending tool ${event.toolName} (${toolCallId})`);
      stateManager.processedToolCallIds.add(toolCallId);
      return;
    }

    const pair: ToolPair = {
      toolName: event.toolName,
      toolCallId,
      params: resolvedParams,
      result: event.result,
      error: event.error,
      timestamp: nowChinaISO(),
      durationMs: event.durationMs,
    };
    stateManager.addToolPair(pair);
    logger.debug?.(`[context-offload] after_tool_call: buffered ${event.toolName} (${toolCallId}), pending=${stateManager.getPendingCount()}, duration=${event.durationMs ?? "N/A"}ms`);

    // Cache latest user context for L2
    // 中文：为L2缓存最新用户上下文
    if (event.messages && Array.isArray(event.messages) && event.messages.length > 0 && !stateManager.cachedLatestTurnMessages) {
      const turn = _extractLatestTurnFromMessages(event.messages);
      if (turn) stateManager.cachedLatestTurnMessages = turn;
    }

    // In-loop active MMD injection / update.
    // Only inject after L1.5 has settled (task boundary determined, activeMmdFile set).
    // This also picks up L2 MMD content updates (L2 runs async and may patch the MMD
    // file between tool calls).
    // 中文：循环内主动注入/更新MMD。
    // 仅在L1.5稳定后注入（任务边界确定，activeMmdFile设置好）。
    // 这也捕获了L2 MMD内容更新（L2异步运行并在工具调用之间可能修补MMD文件）。
    if (event.messages && Array.isArray(event.messages)) {
      try {
        const l15Settled = stateManager.l15Settled;
        const activeMmdFile = stateManager.getActiveMmdFile();
        if (!l15Settled) {
          logger.debug?.(`[context-offload] after_tool_call MMD: SKIP (L1.5 not settled yet)`);
        } else if (!activeMmdFile) {
          logger.debug?.(`[context-offload] after_tool_call MMD: SKIP (no active MMD file)`);
        } else {
          const mmdContent = await readMmd(stateManager.ctx, activeMmdFile);
          if (mmdContent) {
            let taskGoal = "";
            const metaMatch = mmdContent.match(/^%%\{\s*(.*?)\s*\}%%/);
            if (metaMatch) {
              try { const meta = JSON.parse(`{${metaMatch[1]}}`); taskGoal = meta.taskGoal || ""; } catch { /* */ }
            }
            const mmdText = [
              `<current_task_context>`,
              `【当前活跃任务的mermaid流程图】这是你最近正在执行的任务的阶段性记录（此条下方的tool use未被汇总，进程可能有延迟，仅供参考）。`,
              taskGoal ? `**任务目标:** ${taskGoal}` : "",
              `**任务文件:** ${activeMmdFile}`,
              "```mermaid", mmdContent, "```",
              `标记为 "doing" 的节点是近期焦点（注：可能有延迟，下方的tool use未被统计，仅供参考），"done" 的已完成。请参考此保持方向感，避免重复已完成的工作。`,
              `</current_task_context>`,
            ].filter((line) => line !== "").join("\n");

            const existingIdx = event.messages.findIndex((m: any) => m._mmdContextMessage === "active");
            const newMsg = { role: "user", content: [{ type: "text", text: mmdText }], _mmdContextMessage: "active" };
            if (existingIdx >= 0) {
              // Check if content changed (L1.5 switched file or L2 updated content)
              // 中文：检查内容是否更改（L1.5切换文件或L2更新内容）
              const oldContent = Array.isArray(event.messages[existingIdx].content)
                ? event.messages[existingIdx].content.map((c: any) => c.text ?? "").join("")
                : (event.messages[existingIdx].content ?? "");
              const contentChanged = !oldContent.includes(activeMmdFile) || oldContent !== mmdText;
              if (contentChanged) {
                event.messages[existingIdx] = newMsg;
                logger.debug?.(`[context-offload] after_tool_call MMD: UPDATED at [${existingIdx}], file=${activeMmdFile}, contentChanged=true`);
                _dumpMessagesAfterMmd(event.messages, "UPDATED", logger);
              } else {
                logger.debug?.(`[context-offload] after_tool_call MMD: unchanged, skip update`);
              }
            } else {
              const insertIdx = findActiveMmdInsertionPoint(event.messages);
              event.messages.splice(insertIdx, 0, newMsg);
              logger.debug?.(`[context-offload] after_tool_call MMD: INJECTED at [${insertIdx}], file=${activeMmdFile}, msgs=${event.messages.length}`);
              _dumpMessagesAfterMmd(event.messages, "INJECTED", logger);
            }
          } else {
            logger.debug?.(`[context-offload] after_tool_call MMD: file=${activeMmdFile} content is null`);
          }
        }
      } catch (err) {
        logger.warn(`[context-offload] after_tool_call MMD error: ${err}`);
      }
    }

    // Post-tool token snapshot + inline L3 compression
    // 中文：Post-tool token snapshot + inline L3压缩
    const _compStart = Date.now();
    const _msgsBefore = event.messages?.length ?? 0;

    const _contextWindow = typeof getContextWindow === "function" ? getContextWindow() : PLUGIN_DEFAULTS.defaultContextWindow;
    const _mildThreshold = Math.floor(_contextWindow * (pluginConfig?.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio));
    const _aggressiveThreshold = Math.floor(_contextWindow * (pluginConfig?.aggressiveCompressRatio ?? PLUGIN_DEFAULTS.aggressiveCompressRatio));

    // P0.5: checkAndCompressAfterToolCall now returns snapBefore/snapAfter
    // so we no longer need separate buildTiktokenContextSnapshot calls here
    // 中文：P0.5: checkAndCompressAfterToolCall 现在返回 snapBefore/snapAfter，因此这里不再需要单独的 buildTiktokenContextSnapshot 调用
    const _compResult = await checkAndCompressAfterToolCall(event, stateManager, logger, pluginConfig, getContextWindow);
    const _compDuration = Date.now() - _compStart;
    const _msgsAfter = event.messages?.length ?? 0;
    logger.debug?.(`[context-offload] after_tool_call L3 check completed: ${_compDuration}ms`);

    // QUICK-SKIP: no snapshots, skip trace
    // 中文：QUICK-SKIP: 无快照，跳过跟踪
    if (_compResult) {
      const _snapBefore = _compResult.snapBefore ?? null;
      const _snapAfter = _compResult.snapAfter ?? null;
      const _tokensBefore = _snapBefore?.totalTokens ?? 0;
      const _tokensAfter = _snapAfter?.totalTokens ?? 0;
      const _tokensSaved = _tokensBefore - _tokensAfter;
      const _utilisation = _contextWindow > 0 ? _tokensAfter / _contextWindow : 0;

      traceOffloadDecision({
        sessionKey: stateManager.getLastSessionKey(),
        stage: "L3.after_tool_call.completed",
        input: {
          toolName: event.toolName,
          toolCallId,
          messagesBefore: _msgsBefore,
          tokensBefore: _tokensBefore,
          durationMs: _compDuration,
          contextWindow: _contextWindow,
          mildThreshold: _mildThreshold,
          aggressiveThreshold: _aggressiveThreshold,
        },
        output: {
          messagesAfter: _msgsAfter,
          messagesRemoved: _msgsBefore - _msgsAfter,
          pendingCount: stateManager.getPendingCount(),
          tokensBefore: _tokensBefore,
          tokensAfter: _tokensAfter,
          tokensSaved: _tokensSaved,
          utilisation: `${(_utilisation * 100).toFixed(1)}%`,
          aboveMild: _tokensAfter >= _mildThreshold,
          aboveAggressive: _tokensAfter >= _aggressiveThreshold,
          offloadMapAvailable: stateManager.confirmedOffloadIds?.size ?? 0,
          mildReplacedCount: _compResult.mildReplacedCount ?? 0,
          mildReplacedDetails: _compResult.mildReplacedDetails ?? [],
        },
        logger,
      });

      // Upload plugin state + L3 token accounting to backend /store.
      // Only report when a real compression check happened (i.e. we have a snapshot).
      // Trigger reason is derived from the threshold that fired first.
      // 中文：上传插件状态 + L3 token 计量到后端 /store。
      // 仅当实际压缩检查发生时报告（即我们有快照）。
      // 触发原因是首次引发阈值所推导出的。
      const _triggerReason = _tokensBefore >= _aggressiveThreshold
        ? "above_aggressive"
        : _tokensBefore >= _mildThreshold
          ? "above_mild"
          : "below_mild";
      try {
        const report = buildL3TriggerReport({
          stage: "after_tool_call",
          triggerReason: _triggerReason,
          stateManager,
          event,
          contextWindow: _contextWindow,
          mildThreshold: _mildThreshold,
          aggressiveThreshold: _aggressiveThreshold,
          tokensBefore: _tokensBefore,
          tokensAfter: _tokensAfter,
          messagesBefore: _msgsBefore,
          messagesAfter: _msgsAfter,
          durationMs: _compDuration,
          aboveMild: _tokensBefore >= _mildThreshold,
          aboveAggressive: _tokensBefore >= _aggressiveThreshold,
          mildReplacedCount: _compResult.mildReplacedCount ?? 0,
          aggressiveDeletedCount: _compResult.aggressiveDeletedCount ?? 0,
          emergencyTriggered: _compResult.emergencyTriggered ?? false,
          emergencyDeletedCount: _compResult.emergencyDeletedCount ?? 0,
        });
        reportL3Trigger(backendClient ?? null, report, logger);
      } catch (reportErr) {
        logger.warn(`[context-offload] build L3 report failed: ${reportErr}`);
      }
    }

    // Trace full messages snapshot at end of after_tool_call
    // 中文：在 after_tool_call 结束时记录完整消息快照
    if (event.messages && Array.isArray(event.messages)) {
      traceMessagesSnapshot({
        sessionKey: stateManager.getLastSessionKey(),
        stage: "after_tool_call.end",
        messages: event.messages,
        label: `tool=${event.toolName}`,
        extra: {
          toolName: event.toolName,
          toolCallId,
          pendingCount: stateManager.getPendingCount(),
          activeMmdFile: stateManager.getActiveMmdFile() ?? null,
          l15Settled: stateManager.l15Settled,
        },
        logger,
      });
    }
  };
}

/** P1: Quick heuristic token estimate to skip full tiktoken when clearly below threshold. */
/** 中文：P1: 快速启发式 token 估算以避免明显低于阈值时进行完整的 tiktoken 计算 */
function quickTokenEstimate(messages: any[], stateManager: OffloadStateManager): number {
  if (stateManager.lastKnownTotalTokens <= 0) return Infinity;
  const newMsgCount = messages.length - stateManager.lastKnownMessageCount;
  if (newMsgCount <= 0) return stateManager.lastKnownTotalTokens;
  let newTokensEst = 0;
  for (let i = messages.length - newMsgCount; i < messages.length; i++) {
    const c = messages[i]?.content ?? messages[i]?.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? JSON.stringify(c) : "";
    newTokensEst += text ? _quickCountTokens(text) : 50;
  }
  return stateManager.lastKnownTotalTokens + newTokensEst;
}

/** CJK-aware quick token estimate: CJK chars ~1.5 tok/char, rest ~0.25 tok/char. */
/** 中文：CJK 意识快速 token 估算：CJK 字符 ~1.5 tok/char，其余 ~0.25 tok/char。 */
function _quickCountTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5 + rest / 4);
}

async function checkAndCompressAfterToolCall(
  event: any,
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  pluginConfig: Partial<PluginConfig> | undefined,
  getContextWindow: (() => number) | undefined,
): Promise<{
  mildReplacedCount: number;
  mildReplacedDetails: Array<{ toolCallId: string; score: number; summaryPreview: string; originalLength?: number; summaryLength?: number }>;
  aggressiveDeletedCount: number;
  emergencyTriggered: boolean;
  emergencyDeletedCount: number;
  snapBefore: ContextSnapshot | null;
  snapAfter: ContextSnapshot | null;
} | null> {
  try {
    const messages = event.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) return null;

    const sysPrompt = stateManager.cachedSystemPrompt ?? null;
    const precomputed = stateManager.cachedSystemPromptTokens != null
      ? { systemTokens: stateManager.cachedSystemPromptTokens, userPromptTokens: 0 }
      : undefined;

    const contextWindow = typeof getContextWindow === "function" ? getContextWindow() : PLUGIN_DEFAULTS.defaultContextWindow;
    const mildRatio = pluginConfig?.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio;
    const mildThreshold = Math.floor(contextWindow * mildRatio);

    // P1: Quick heuristic skip — avoid full tiktoken when clearly below threshold
    // Every MAX_CONSECUTIVE_QUICK_SKIPS, force a precise calculation to prevent drift
    // 中文：P1: 快速启发式跳过 — 避免明显低于阈值时进行完整的 tiktoken 计算
    // 每 MAX_CONSECUTIVE_QUICK_SKIPS 次，强制执行精确计算以防止漂移
    const MAX_CONSECUTIVE_QUICK_SKIPS = 5;
    const quickEst = quickTokenEstimate(messages, stateManager);
    if (quickEst < mildThreshold * 0.85 && stateManager.consecutiveQuickSkips < MAX_CONSECUTIVE_QUICK_SKIPS) {
      stateManager.consecutiveQuickSkips++;
      logger.debug?.(`[context-offload] L3(after_tool_call) QUICK-SKIP: est≈${quickEst} < ${Math.floor(mildThreshold * 0.85)} (85% mild), streak=${stateManager.consecutiveQuickSkips}/${MAX_CONSECUTIVE_QUICK_SKIPS}`);
      return null;
    }

    const snap = buildTiktokenContextSnapshot("after_tool_call", messages, sysPrompt, null, precomputed);
    // Update stateManager with precise values and reset skip counter
    // 中文：更新stateManager为精确值并重置skip计数器
    stateManager.lastKnownTotalTokens = snap.totalTokens;
    stateManager.lastKnownMessageCount = messages.length;
    stateManager.consecutiveQuickSkips = 0;

    const aggressiveRatio = pluginConfig?.aggressiveCompressRatio ?? PLUGIN_DEFAULTS.aggressiveCompressRatio;
    const aggressiveThreshold = Math.floor(contextWindow * aggressiveRatio);

    const utilisation = snap.totalTokens / contextWindow;
    const aboveMild = snap.totalTokens >= mildThreshold;
    const aboveAggressive = snap.totalTokens >= aggressiveThreshold;
    logger.debug?.(
      `[context-offload] L3(after_tool_call) token snapshot: tool=${event.toolName} total=${snap.totalTokens} ` +
      `msgCount=${messages.length} utilisation=${(utilisation * 100).toFixed(1)}% ` +
      `${aboveAggressive ? "⚠ ABOVE_AGGRESSIVE" : aboveMild ? "⚠ ABOVE_MILD" : "✓ OK"}`,
    );

    if (snap.totalTokens < mildThreshold) return { mildReplacedCount: 0, mildReplacedDetails: [], aggressiveDeletedCount: 0, emergencyTriggered: false, emergencyDeletedCount: 0, snapBefore: snap, snapAfter: snap };

    // L3 compression
    // 中文：L3压缩
    const offloadEntries = await readOffloadEntries(stateManager.ctx);
    const offloadMap = new Map();
    populateOffloadLookupMap(offloadMap, offloadEntries);
    const currentTaskNodeIds = await getCurrentTaskNodeIds(stateManager);
    const countTokens = createL3TokenCounter(pluginConfig, logger);
    const aggressiveDeleteRatio = (pluginConfig as any)?.aggressiveDeleteRatio ?? PLUGIN_DEFAULTS.aggressiveDeleteRatio;
    const mildScanRatio = (pluginConfig as any)?.mildOffloadScanRatio ?? PLUGIN_DEFAULTS.mildOffloadScanRatio;
    let workingTokens = snap.totalTokens;

    let _aggDeletedCount = 0;
    // Aggressive
    // 中文：激进模式
    if (workingTokens >= aggressiveThreshold) {
      logger.debug?.(`[context-offload] L3(after_tool_call) AGGRESSIVE: tokens≈${workingTokens} >= ${aggressiveThreshold}`);
      const _atcAggStart = Date.now();
      const result = await aggressiveCompressUntilBelowThreshold(
        messages, offloadMap, currentTaskNodeIds, aggressiveDeleteRatio,
        stateManager, logger, aggressiveThreshold, countTokens, sysPrompt, null,
      );
      workingTokens = result.remainingTokens;
      _aggDeletedCount = result.deletedCount ?? result.allDeletedToolCallIds.length;
      const _atcAggDuration = Date.now() - _atcAggStart;
      logger.debug?.(`[context-offload] L3(after_tool_call) AGGRESSIVE done: rounds=${result.rounds ?? "?"}, deleted=${result.allDeletedToolCallIds.length}, remaining≈${workingTokens}, stalledByUserMsg=${result.stalledByUserMsg ?? false}, duration=${_atcAggDuration}ms`);
      if (_atcAggDuration > 10_000) {
        logger.warn(`[context-offload] L3(after_tool_call) AGGRESSIVE SLOW: ${_atcAggDuration}ms (rounds=${result.rounds ?? "?"}, deleted=${result.allDeletedToolCallIds.length}, remaining≈${workingTokens})`);
      }
      dumpMessagesSnapshot("atc-after-aggressive", messages, logger);
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
          removeExistingMmdInjections(messages);
          const histInsertIdx = findHistoryMmdInsertionPoint(messages);
          messages.splice(histInsertIdx, 0, ...mmdInjection.injectedMessages);
          workingTokens += mmdInjection.totalMmdTokens;
          dumpMessagesSnapshot("atc-after-aggressive-mmd-injection", messages, logger);
        }
      }
      // If aggressive stalled due to user message protection and still above threshold,
      // force emergency to make progress
      // 中文：如果因用户消息保护而停滞且仍高于阈值，则强制紧急模式以促进进度
      if (result.stalledByUserMsg && workingTokens >= aggressiveThreshold) {
        logger.warn(`[context-offload] L3(after_tool_call) AGGRESSIVE stalled, forcing emergency fallback`);
        stateManager._forceEmergencyNext = true;
      }
    }

    // Mild
    let _mildResult: { mildReplacedCount: number; mildReplacedDetails: Array<{ toolCallId: string; score: number; summaryPreview: string; originalLength?: number; summaryLength?: number }> } = { mildReplacedCount: 0, mildReplacedDetails: [] };
    if (workingTokens >= mildThreshold) {
      logger.debug?.(`[context-offload] L3(after_tool_call) MILD: tokens≈${workingTokens} >= ${mildThreshold}`);
      const cascadeResult = compressByScoreCascade(messages, offloadMap, currentTaskNodeIds, mildScanRatio, logger);
      const detailStr = cascadeResult.replacedDetails.map((d) => `${d.toolCallId}(score=${d.score}): "${d.summaryPreview}"`).join(" | ");
      logger.debug?.(`[context-offload] L3(after_tool_call) MILD done: replaced=${cascadeResult.replacedCount}, threshold=${cascadeResult.finalThreshold}${detailStr ? `, details=[${detailStr}]` : ""}`);
      _mildResult = { mildReplacedCount: cascadeResult.replacedCount, mildReplacedDetails: cascadeResult.replacedDetails };
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
      dumpMessagesSnapshot("atc-after-mild", messages, logger);
    }
    const emergencyRatio = pluginConfig?.emergencyCompressRatio ?? PLUGIN_DEFAULTS.emergencyCompressRatio;
    const emergencyTargetRatio = pluginConfig?.emergencyTargetRatio ?? PLUGIN_DEFAULTS.emergencyTargetRatio;
    const emergencyThreshold = Math.floor(contextWindow * emergencyRatio);
    const emergencyTarget = Math.floor(contextWindow * emergencyTargetRatio);

    const preEmergencySnap = buildTiktokenContextSnapshot("after_tool_call_pre_emergency", messages, sysPrompt, null, precomputed);
    workingTokens = preEmergencySnap.totalTokens;

    const forceEmergency = stateManager._forceEmergencyNext === true;
    if (forceEmergency) stateManager._forceEmergencyNext = false;
    let _emergencyTriggered = false;
    let _emergencyDeletedCount = 0;
    if ((workingTokens >= emergencyThreshold || forceEmergency) && messages.length > EMERGENCY_MIN_MESSAGES_TO_KEEP) {
      _emergencyTriggered = true;
      const _atcEmStart = Date.now();
      const emergencyResult = emergencyCompress(messages, emergencyTarget, countTokens, sysPrompt, null, logger);
      const _atcEmDuration = Date.now() - _atcEmStart;
      _emergencyDeletedCount = emergencyResult.deletedCount;
      if (_atcEmDuration > 10_000) {
        logger.warn(`[context-offload] L3(after_tool_call) EMERGENCY SLOW: ${_atcEmDuration}ms (deleted=${emergencyResult.deletedCount}, remaining≈${emergencyResult.remainingTokens})`);
      }
      if (emergencyResult.deletedToolCallIds.length > 0) {
        const statusUpdates = new Map<string, string | boolean>();
        for (const id of emergencyResult.deletedToolCallIds) {
          statusUpdates.set(id, "deleted");
          stateManager.confirmedOffloadIds.add(id);
          stateManager.deletedOffloadIds.add(id);
        }
        markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
      }
      dumpMessagesSnapshot("atc-after-emergency", messages, logger);
    }

    if (stateManager.isLoaded()) await stateManager.save();

    // Update stateManager with final token count for future quick estimates
    // 中文：更新stateManager为最终token计数以便未来快速估算
    stateManager.lastKnownTotalTokens = preEmergencySnap.totalTokens;
    stateManager.lastKnownMessageCount = messages.length;

    return { ..._mildResult, aggressiveDeletedCount: _aggDeletedCount, emergencyTriggered: _emergencyTriggered, emergencyDeletedCount: _emergencyDeletedCount, snapBefore: snap, snapAfter: preEmergencySnap };
  } catch (err) {
    logger.warn?.(`[context-offload] after_tool_call L3 error: ${String(err)}`);
    if (isTokenOverflowError(err)) stateManager._forceEmergencyNext = true;
    return null;
  }
}

function _extractLatestTurnFromMessages(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg._mmdContextMessage || msg._mmdInjection) continue;
    const role = msg.role ?? msg.message?.role ?? msg.type;
    if (role !== "user") continue;
    const text = _extractText(msg);
    if (text && text.length > 10) return `[User]: ${text.slice(0, 500)}`;
  }
  return null;
}

function _extractText(msg: any): string {
  const content = msg.content ?? msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join(" ");
  }
  return "";
}

/** Dump all messages after MMD injection for diagnostics (debug-level only). */
/** 中文：仅在调试级别注入MMD后转储所有消息用于诊断 */
function _dumpMessagesAfterMmd(messages: any[], action: string, logger: PluginLogger): void {
  const mmdCount = messages.filter((m: any) => m._mmdContextMessage || m._mmdInjection).length;
  const offloadedCount = messages.filter((m: any) => m._offloaded).length;
  logger.debug?.(`[context-offload] POST-MMD-${action} (after_tool_call): ${messages.length} msgs, mmd=${mmdCount}, offloaded=${offloadedCount}`);
}
