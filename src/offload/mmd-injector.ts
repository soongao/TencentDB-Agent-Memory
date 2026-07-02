/**
 * Unified MMD injector.
 *
 * Maintains a single marked message in event.messages containing the active
 * MMD (+ history MMDs). Used by both before_prompt_build (full inject after
 * L1.5 judgment) and after_tool_call (incremental update when L2 refreshes
 * the MMD file during the tool loop).
 *
 * The marker property `_mmdContextMessage` is used to locate the message for
 * replacement. L3 compression must skip messages carrying this marker.
 * 中文：统一的MMD注入器。
 * 维护一个在event.messages中包含的活跃
 * MMD（以及历史MMD）。被before_prompt_build（在L1.5判断后全量注入）和after_tool_call（在L2刷新MMD文件期间工具循环中的增量更新）使用。
 * 标记属性&_mmdContextMessage_用于定位需要替换的消息。L3压缩必须跳过携带此标记的消息。
 */
import { readMmd, listMmds } from "./storage.js";
import { PLUGIN_DEFAULTS, type PluginConfig, type PluginLogger } from "./types.js";
import { createL3TokenCounter } from "./l3-token-counter.js";
import { traceOffloadDecision } from "./opik-tracer.js";
import { isToolResultMessage, isAssistantMessageWithToolUse } from "./l3-helpers.js";
import type { OffloadStateManager } from "./state-manager.js";

/** Marker property on the injected message object. */
/** 中文：注入消息对象上的标记属性。 */
export const MMD_MESSAGE_MARKER = "_mmdContextMessage";

// ─── Public API ──────────────────────────────────────────────────────────────
// 中文：─── 公共API ──────────────────────────────────────────────────────────────

/**
 * Full inject — called from assemble / before_prompt_build (every user-message round)
 * and from llm_input (every LLM call).
 *
 * Only injects the ACTIVE MMD (determined by L1.5).
 * History MMDs are NOT injected here — they are only injected by L3 aggressive
 * compression (buildHistoryMmdInjection) after messages are deleted, as a
 * replacement for lost conversation context.
 * 中文：全量注入 — 被assemble / before_prompt_build（每轮用户消息）和llm_input（每次LLM调用）调用。
 * 仅注入活跃的MMD（由L1.5决定）。
 * 历史MMD不在此处注入 — 它们仅在消息被删除后由L3激进压缩（buildHistoryMmdInjection）注入，作为丢失对话上下文的替代。
 */
export async function injectMmdIntoMessages(
  messages: any[],
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  getContextWindow: (() => number) | undefined,
  pluginConfig: Partial<PluginConfig> | undefined,
  options?: { waitForL15?: boolean },
): Promise<{ mmdTokens: number }> {
  // When waitForL15 is set (assemble path), skip injection entirely if L1.5 hasn't settled yet.
  // This preserves any previously injected MMD messages without removing or replacing them.
  // 中文：当waitForL15设置（assemble路径）时，如果L1.5尚未稳定，则完全跳过注入。
  // 这会保留任何先前注入的MMD消息而不移除或替换它们。
  if (options?.waitForL15 && !stateManager.l15Settled) {
    logger.debug?.(
      `[context-offload] mmd-injector inject: SKIPPED — L1.5 not settled yet (waitForL15=true), msgs=${messages.length}`,
    );
    return { mmdTokens: stateManager.lastMmdInjectedTokens };
  }

  const injReady = stateManager.isMmdInjectionReady();
  const actFile = stateManager.getActiveMmdFile();
  logger.debug?.(
    `[context-offload] mmd-injector inject: injectionReady=${injReady}, activeMmdFile=${actFile ?? "null"}, msgs=${messages.length}`,
  );
  if (!injReady) {
    removeMmdMessages(messages);
    stateManager.lastMmdInjectedTokens = 0;
    return { mmdTokens: 0 };
  }

  const contextWindow =
    typeof getContextWindow === "function"
      ? getContextWindow()
      : PLUGIN_DEFAULTS.defaultContextWindow;
  const mmdMaxTokenRatio =
    pluginConfig?.mmdMaxTokenRatio ?? PLUGIN_DEFAULTS.mmdMaxTokenRatio;
  const countTokens = createL3TokenCounter(pluginConfig, logger);

  const activeMmdText = await buildActiveMmdText(stateManager, logger);
  logger.debug?.(
    `[context-offload] mmd-injector inject: activeMmdText=${activeMmdText ? `${activeMmdText.length} chars` : "null"}, contextWindow=${contextWindow}`,
  );
  removeMmdMessages(messages);

  let totalMmdTokens = 0;

  if (activeMmdText) {
    const activeMsg: any = {
      role: "user",
      content: [{ type: "text", text: activeMmdText }],
      [MMD_MESSAGE_MARKER]: "active",
    };
    const insertIdx = findActiveMmdInsertionPoint(messages);
    messages.splice(insertIdx, 0, activeMsg);
    totalMmdTokens += countTokens(activeMmdText);
  }

  stateManager.lastMmdInjectedTokens = totalMmdTokens;

  const activeMmd = stateManager.getActiveMmdFile();
  logger.debug?.(
    `[context-offload] mmd-injector: injected active MMD into messages (${totalMmdTokens} tokens, file=${activeMmd})`,
  );

  // Summary after active MMD injection (was full dump, now aggregated)
  // 中文：活跃MMD注入后的摘要（从前是全量导出，现在是聚合）
  if (totalMmdTokens > 0) {
    const mmdCount = messages.filter((m: any) => m[MMD_MESSAGE_MARKER] === "active" || m._mmdInjection).length;
    const offloadedCount = messages.filter((m: any) => m._offloaded).length;
    logger.debug?.(`[context-offload] POST-ACTIVE-MMD-INJECT: ${messages.length} msgs, mmd=${mmdCount}, offloaded=${offloadedCount}`);
  }

  traceOffloadDecision({
    sessionKey: stateManager.getLastSessionKey(),
    stage: "mmd-injector.inject",
    input: {
      activeMmd,
      mmdInjectionReady: true,
      contextWindow,
      mmdMaxTokenRatio,
    },
    output: {
      result: `MMD 注入 messages：${totalMmdTokens} tokens (active only)`,
      mmdTokens: totalMmdTokens,
      hasActive: !!activeMmdText,
      hasHistory: false,
      mmdTokenBudget: Math.floor(contextWindow * mmdMaxTokenRatio),
    },
    logger,
  });

  return { mmdTokens: totalMmdTokens };
}

/**
 * Incremental update — called from after_tool_call (every tool-loop iteration).
 * 中文：增量更新 — 被after_tool_call（每次工具循环迭代）调用。
 */
export async function maybeUpdateMmdInMessages(
  messages: any[],
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  getContextWindow: (() => number) | undefined,
  pluginConfig: Partial<PluginConfig> | undefined,
): Promise<boolean> {
  const injectionReady = stateManager.isMmdInjectionReady();
  const activeMmdFile = stateManager.getActiveMmdFile();
  logger.debug?.(
    `[context-offload] mmd-injector maybeUpdate: injectionReady=${injectionReady}, activeMmdFile=${activeMmdFile ?? "null"}, msgs=${messages.length}`,
  );
  if (!injectionReady) return false;
  if (!activeMmdFile) return false;

  let mmdContent: string | null;
  try {
    mmdContent = await readMmd(stateManager.ctx, activeMmdFile);
    logger.debug?.(
      `[context-offload] mmd-injector maybeUpdate: readMmd result=${mmdContent ? `${mmdContent.length} chars` : "null"}`,
    );
  } catch (e) {
    logger.debug?.(`[context-offload] mmd-injector maybeUpdate: readMmd error=${e}`);
    return false;
  }
  if (!mmdContent) return false;

  const newFp = computeFingerprint(mmdContent);
  const lastFp = stateManager.getInjectedMmdVersion(activeMmdFile);
  if (newFp === lastFp) return false;

  logger.debug?.(
    `[context-offload] mmd-injector: MMD updated (${activeMmdFile}), refreshing in-loop`,
  );
  await injectMmdIntoMessages(
    messages,
    stateManager,
    logger,
    getContextWindow,
    pluginConfig,
  );
  return true;
}

// ─── Insertion point helpers (exported for after-tool-call & llm-input-l3) ──
// 中文：─── 插入点辅助函数（导出供after-tool-call及llm-input-l3使用） ──

function findLatestUserMessageIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg[MMD_MESSAGE_MARKER]) continue;
    if (msg._mmdInjection) continue;
    const role = msg.role ?? msg.message?.role ?? msg.type;
    if (role === "user") return i;
  }
  return -1;
}

/**
 * Find the best insertion point for the active MMD message.
 *
 * Strategy: insert AFTER the latest user message (in the second half of the
 * conversation), so the MMD sits between the user's question and the ongoing
 * tool loop — not at position 0 which pollutes the oldest context.
 *
 * Fallback: if the latest user message is in the first half (unlikely during
 * active tool loops), insert at the start of the trailing tool-result/assistant
 * block, clamped to within 30 messages from the tail.
 *
 * IMPORTANT: The insertion point must NOT split a tool_call / tool_result pair.
 * If the candidate position is between an assistant message containing tool_use
 * and its corresponding tool_result(s), shift backwards to before the assistant
 * message so the pair stays intact.
 * 中文：在活动MMD消息的最佳插入点找到。
 * 策略：在其后的最新用户消息（对话的后半部分）之后插入，使MMD位于用户的提问和正在进行的工具循环之间——不放在位置0，以免污染最旧的上下文。
 * 备选方案：如果最新的用户消息在前半部分（在活跃工具循环期间不太可能），则在尾部残留的工具结果/助手块的开头插入，但不超过30条消息从尾部开始。
 * 重要提示：插入点不得分割tool_call / tool_result配对。
 * 如果候选位置位于包含tool_use的助手消息及其对应的tool_result之间，则向后移动到该助手消息之前，以保持配对完整。
 */
export function findActiveMmdInsertionPoint(messages: any[]): number {
  if (messages.length <= 2) return 0;

  const halfIdx = Math.floor(messages.length / 2);
  const latestUserIdx = findLatestUserMessageIndex(messages);
  let insertIdx: number;
  if (latestUserIdx >= halfIdx) {
    insertIdx = latestUserIdx + 1;
  } else {
    let loopStart = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg[MMD_MESSAGE_MARKER]) continue;
      if (msg._mmdInjection) continue;
      const role = msg.role ?? msg.message?.role ?? msg.type;
      if (role === "toolResult" || role === "tool" || role === "assistant") {
        loopStart = i;
      } else {
        break;
      }
    }

    const maxDistFromTail = 30;
    const minInsertIdx = Math.max(0, messages.length - maxDistFromTail);
    insertIdx = Math.max(loopStart, minInsertIdx);
    insertIdx = Math.min(insertIdx, Math.max(0, messages.length - 1));
  }

  // Guard: don't insert between an assistant tool_use message and its tool_result(s).
  // If the message at insertIdx is a tool_result, walk backwards past the tool_result
  // cluster and the preceding assistant tool_use message.
  // 中文：保护措施：不要在助手工具_use消息与其工具_result之间插入。
  // 如果插入Idx的消息是工具_result，请反向走过工具_result群集和前一个助手工具_use消息。
  insertIdx = adjustForToolCallPair(messages, insertIdx);

  return insertIdx;
}

/**
 * Adjusts an insertion index so it does not land between an assistant message
 * containing tool_use blocks and the subsequent tool_result messages.
 *
 * Walk backwards: if we see tool_result messages at `idx`, keep going back;
 * if we then land on an assistant message with tool_use, step before it too.
 * 中文：调整插入索引，使其不落在包含工具_use的助手消息及其后续工具_result之间。
 * 反向行走：如果我们看到`idx`处有工具_result消息，则继续后退；如果然后落在包含工具_use的助手消息上，则也向前移动。
 */
function adjustForToolCallPair(messages: any[], idx: number): number {
  if (idx <= 0 || idx >= messages.length) return idx;

  // Check if the message AT idx (or the preceding context) forms a tool pair boundary.
  // Case 1: idx points at a tool_result → we're inside a tool pair, walk back.
  // 中文：检查索引`idx`（或其前一个上下文）是否形成工具配对边界。
  // 情况1：`idx`指向tool_result → 我们在工具配对内，向后行走。
  let cur = idx;
  while (cur > 0 && cur < messages.length) {
    const msg = messages[cur];
    if (msg[MMD_MESSAGE_MARKER] || msg._mmdInjection) { cur--; continue; }
    if (!isToolResultMessage(msg)) break;
    cur--;
  }

  // After skipping tool_results, check if the message at `cur` is an assistant with tool_use.
  // If so, we must insert BEFORE this assistant message to keep the pair intact.
  // 中文：跳过工具_result后，检查`cur`处的消息是否为包含工具_use的助手消息。
  // 如果是，则必须在其之前插入以保持配对完整。
  if (cur >= 0 && cur < messages.length) {
    const msg = messages[cur];
    if (!msg[MMD_MESSAGE_MARKER] && !msg._mmdInjection && isAssistantMessageWithToolUse(msg)) {
      return cur;
    }
  }

  // Also check the message just BEFORE idx — if it's an assistant with tool_use,
  // and idx's message is a tool_result, we already handled above. But if idx-1 is
  // assistant with tool_use and idx is tool_result, the while-loop above would
  // have caught it. This covers the edge case where idx is right after an assistant
  // tool_use (before any tool_result arrives yet).
  // 中文：还应检查索引`idx`之前的那条消息 — 如果它是包含工具_use的助手消息，并且`idx`处的消息是tool_result，则已在上面处理。但如果`idx-1`是包含工具_use的助手消息而`idx`是tool_result，上面的while循环会捕获它。这涵盖了`idx`紧随在助手工具_use之后（尚未收到任何tool_result）的情况。
  if (idx > 0 && idx < messages.length) {
    const prevMsg = messages[idx - 1];
    if (!prevMsg[MMD_MESSAGE_MARKER] && !prevMsg._mmdInjection && isAssistantMessageWithToolUse(prevMsg)) {
      const curMsg = messages[idx];
      if (isToolResultMessage(curMsg)) {
        return idx - 1;
      }
    }
  }

  // If we moved backward, return the adjusted position; otherwise return original.
  // 中文：如果向后移动，请返回调整后的位置；否则返回原始位置。
  return cur < idx ? cur : idx;
}

/**
 * Find insertion point for history MMD messages (injected after AGGRESSIVE deletion).
 *
 * Strategy: insert BEFORE the active MMD (if present) or at the same position
 * where the active MMD would go. History context should precede active context
 * so the LLM reads chronologically: history → active → recent tool loop.
 *
 * Unlike active MMD, history MMD should NOT go to index 0 — it should sit in
 * the middle of the conversation, just before the active task context.
 * 中文：为历史MMD消息找到插入点（在激进删除后注入）。
 * 策略：在其前插入活动的MMD（如有），或在活动MMD本应出现的位置。历史上下文应在活动上下文之前，以便LLM按时间顺序阅读：历史 → 活动 → 最近的工具循环。
 * 与活动MMD不同，历史MMD不应放置在索引0处 — 它应该位于对话中间，在活动任务上下文之前。
 */
export function findHistoryMmdInsertionPoint(messages: any[]): number {
  // If there's an existing active MMD, insert just before it
  // 中文：如果存在一个现有的活动MMD，在其前插入
  for (let i = 0; i < messages.length; i++) {
    if (messages[i][MMD_MESSAGE_MARKER] === "active") return i;
  }
  // No active MMD — use the same heuristic as active MMD insertion
  // 中文：没有活动的MMD——使用与活动MMD插入相同的启发式方法
  return findActiveMmdInsertionPoint(messages);
}

function removeMmdMessages(messages: any[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i][MMD_MESSAGE_MARKER]) {
      messages.splice(i, 1);
    }
  }
}

async function buildActiveMmdText(
  stateManager: OffloadStateManager,
  logger: PluginLogger,
): Promise<string | null> {
  const activeMmdFile = stateManager.getActiveMmdFile();
  if (!activeMmdFile) return null;
  return await buildActiveMmdBlock(activeMmdFile, stateManager, logger);
}

async function buildActiveMmdBlock(
  activeMmdFile: string,
  stateManager: OffloadStateManager,
  logger: PluginLogger,
): Promise<string | null> {
  try {
    const mmdContent = await readMmd(stateManager.ctx, activeMmdFile);
    if (!mmdContent) return null;
    stateManager.setInjectedMmdVersion(
      activeMmdFile,
      computeFingerprint(mmdContent),
    );
    const metaMatch = mmdContent.match(/^%%\{\s*(.*?)\s*\}%%/);
    let taskGoal = "";
    if (metaMatch) {
      try {
        const meta = JSON.parse(`{${metaMatch[1]}}`);
        taskGoal = meta.taskGoal || "";
      } catch {
        /* ignore */
        /** 中文：忽略 */
      }
    }
    const nodePattern = /\b(\d+-N\d+|N\d+)\b/g;
    const nodeIds: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = nodePattern.exec(mmdContent)) !== null) {
      if (!nodeIds.includes(match[1])) nodeIds.push(match[1]);
    }
    return [
      `<current_task_context>`,
      `【当前活跃任务的mermaid流程图】这是你最近正在执行的任务的阶段性记录（此条下方的tool use未被汇总，进程可能有延迟，仅供参考）。`,
      taskGoal ? `**任务目标:** ${taskGoal}` : "",
      `**任务文件:** ${activeMmdFile}`,
      nodeIds.length > 0
        ? `**节点索引:** 可通过 node_id 在 offload.{sessionid}.jsonl 中查找对应的工具调用记录。如需查看某个节点对应的原始工具调用与完整结果，请在 offload.{sessionid}.jsonl 中找到对应条目的 result_ref 并读取该文件。`
        : "",
      "```mermaid",
      mmdContent,
      "```",
      `标记为 "doing" 的节点是近期焦点（注：可能有延迟，下方的tool use未被统计，仅供参考），"done" 的已完成。请参考此保持方向感，避免重复已完成的工作。`,
      `</current_task_context>`,
    ]
      .filter((line) => line !== "")
      .join("\n");
  } catch (err) {
    logger.error(
      `[context-offload] mmd-injector: Error building active MMD block: ${err}`,
    );
    return null;
  }
}

function computeFingerprint(content: string): string {
  return `${content.length}:${content.slice(0, 64)}`;
}
