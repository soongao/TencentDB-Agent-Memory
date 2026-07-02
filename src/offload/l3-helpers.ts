/**
 * L3 shared helper functions.
 * Used by both before-prompt-build (fast-path re-apply) and llm-input-l3 (compression).
 * 中文：L3 共享辅助函数。
 * 同时用于 before-prompt-build（快速路径重新应用）和 llm-input-l3（压缩）.
 */
import { readMmd, type StorageContext } from "./storage.js";
import { invalidateTokenCache } from "./context-token-tracker.js";
import type { OffloadEntry } from "./types.js";
import type { OffloadStateManager } from "./state-manager.js";

/**
 * Anthropic-style tool ids sometimes appear as `toolu_bdrk_01...` (underscores)
 * in offload.jsonl while the live session uses `toolubdrk01...`. Normalize for lookup.
 * 中文：Anthropic风格的工具ID有时在offload.jsonl中显示为`toolu_bdrk_01...`（包含下划线），而在实时会话中使用`toolubdrk01...`。进行规范化以方便查找。
 */
export function normalizeToolCallIdForLookup(id: string): string {
  return id.replace(/_/g, "");
}

export function getOffloadEntry(
  map: Map<string, OffloadEntry>,
  toolCallId: string,
): OffloadEntry | undefined {
  return (
    map.get(toolCallId) ?? map.get(normalizeToolCallIdForLookup(toolCallId))
  );
}

/** Index offload entries by canonical id and by underscore-free form when they differ. */
/** 中文：通过规范ID和无下划线形式对卸载条目进行索引，当它们不同时。 */
export function populateOffloadLookupMap(
  map: Map<string, OffloadEntry>,
  entries: OffloadEntry[],
): void {
  for (const entry of entries) {
    map.set(entry.tool_call_id, entry);
    const alt = normalizeToolCallIdForLookup(entry.tool_call_id);
    if (alt !== entry.tool_call_id && !map.has(alt)) {
      map.set(alt, entry);
    }
  }
}

/** Check if a message is a tool result */
/** 中文：检查一条消息是否为工具结果 */
export function isToolResultMessage(msg: any): boolean {
  if (msg.type === "message") {
    const message = msg.message;
    if (message?.role === "toolResult" || message?.role === "tool") {
      return true;
    }
  }
  if (msg.role === "toolResult" || msg.role === "tool") {
    return true;
  }
  return false;
}

/** Extract tool call ID from a tool result message */
/** 中文：从工具结果消息中提取工具调用ID */
export function extractToolCallId(msg: any): string | null {
  if (msg.type === "message") {
    const message = msg.message;
    if (message?.toolCallId) return message.toolCallId;
    if (message?.tool_call_id) return message.tool_call_id;
  }
  if (msg.toolCallId) return msg.toolCallId;
  if (msg.tool_call_id) return msg.tool_call_id;
  return null;
}

/** Check if a content block is a tool use block */
/** 中文：检查内容块是否为工具使用块 */
export function isToolUseBlock(block: any): boolean {
  return block.type === "tool_use" || block.type === "toolCall";
}

/** Get message content (handles transcript wrapper format) */
/** 中文：获取消息内容（处理转录包装格式） */
export function getMessageContent(msg: any): any {
  if (msg.type === "message") {
    const message = msg.message;
    return message?.content;
  }
  return msg.content;
}

/** Check if an assistant message contains tool_use blocks */
/** 中文：检查助手消息是否包含tool_use块 */
export function isAssistantMessageWithToolUse(msg: any): boolean {
  const content = getMessageContent(msg);
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => isToolUseBlock(block));
}

/** Check if message contains tool_use (alias) */
/** 中文：检查消息是否包含tool_use（别名） */
export function isToolUseInAssistant(msg: any): boolean {
  return isAssistantMessageWithToolUse(msg);
}

/** Extract tool_use ID from an assistant message (first tool_use block) */
/** 中文：从助手消息中提取第一个tool_use块的ID */
export function extractToolUseIdFromAssistant(msg: any): string | null {
  const content = getMessageContent(msg);
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const b = block as any;
    if (isToolUseBlock(b) && b.id) return b.id;
  }
  return null;
}

/**
 * Check if an assistant message contains ONLY tool_use blocks (no text or other content).
 * 中文：检查助手消息是否仅包含tool_use块（无文本或其他内容）
 */
export function isOnlyToolUseAssistant(msg: any): boolean {
  const wrapped = msg.type === "message" ? msg.message : msg;
  const role = wrapped?.role;
  if (role !== "assistant") return false;
  const content = getMessageContent(msg);
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block: any) => isToolUseBlock(block));
}

/** Extract ALL tool_use block IDs from an assistant message */
/** 中文：从助手消息中提取所有tool_use块的ID */
export function extractAllToolUseIds(msg: any): string[] {
  const content = getMessageContent(msg);
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    const b = block as any;
    if (isToolUseBlock(b) && b.id) ids.push(b.id);
  }
  return ids;
}

const COMPACT_TOOL_CALL_MAX_TOTAL = 300;
const COMPACT_ARG_TRUNCATE_AT = 60;

/** Truncate a tool_call string to a compact form */
/** 中文：将tool_call字符串裁剪为紧凑形式 */
export function compactToolCall(toolCall: string | null | undefined): string {
  if (!toolCall || typeof toolCall !== "string") return toolCall ?? "";
  if (toolCall.length <= COMPACT_TOOL_CALL_MAX_TOTAL) return toolCall;
  const parenIdx = toolCall.indexOf("(");
  if (parenIdx < 0) {
    return toolCall.slice(0, COMPACT_TOOL_CALL_MAX_TOTAL) + "…";
  }
  const toolName = toolCall.slice(0, parenIdx);
  const argsStr = toolCall.endsWith(")")
    ? toolCall.slice(parenIdx + 1, -1)
    : toolCall.slice(parenIdx + 1);
  let args: any;
  try {
    args = JSON.parse(argsStr);
  } catch {
    return (
      toolName +
      "(" +
      argsStr.slice(0, COMPACT_TOOL_CALL_MAX_TOTAL - toolName.length - 5) +
      "…)"
    );
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return (
      toolName +
      "(" +
      argsStr.slice(0, COMPACT_TOOL_CALL_MAX_TOTAL - toolName.length - 5) +
      "…)"
    );
  }
  const compacted: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > COMPACT_ARG_TRUNCATE_AT) {
      compacted[key] = value.slice(0, COMPACT_ARG_TRUNCATE_AT) + "…";
    } else if (typeof value === "object" && value !== null) {
      const s = JSON.stringify(value);
      compacted[key] = s.length > COMPACT_ARG_TRUNCATE_AT ? "[object]" : value;
    } else {
      compacted[key] = value;
    }
  }
  let result = `${toolName}(${JSON.stringify(compacted)})`;
  if (result.length > COMPACT_TOOL_CALL_MAX_TOTAL) {
    result = result.slice(0, COMPACT_TOOL_CALL_MAX_TOTAL) + "…";
  }
  return result;
}

/**
 * Compress a pure tool_use assistant message by replacing each tool_use block's
 * input/arguments with a compact offload summary.
 * 中文：压缩纯tool_use助手消息，用每个tool_use块的紧凑卸载摘要替换其输入/参数。
 */
export function replaceAssistantToolUseWithSummary(
  msg: any,
  entries: OffloadEntry[],
): void {
  const content = getMessageContent(msg);
  if (!Array.isArray(content)) return;
  const entryById = new Map<string, OffloadEntry>();
  for (const entry of entries) {
    const id = entry.tool_call_id;
    if (id) {
      entryById.set(id, entry);
      entryById.set(normalizeToolCallIdForLookup(id), entry);
    }
  }
  let idx = 0;
  for (const block of content) {
    const b = block as any;
    if (!isToolUseBlock(b)) continue;
    const entry =
      (b.id && entryById.get(b.id)) ??
      (b.id && entryById.get(normalizeToolCallIdForLookup(b.id))) ??
      entries[idx];
    idx++;
    if (!entry) continue;
    const compactInput = {
      _offloaded: true,
      node_id: entry.node_id ?? "N/A",
      tool_call: compactToolCall(entry.tool_call),
    };
    if (b.arguments !== undefined) {
      b.arguments = compactInput;
    } else {
      b.input = compactInput;
    }
  }
  invalidateTokenCache(msg);
}

/** Replace a tool result message's content with the offload summary.
 * 中文：用卸载摘要替换工具结果消息的内容。返回原始内容和摘要内容长度以供诊断。
 *  Returns original and summary content lengths for diagnostics. */
export function replaceWithSummary(msg: any, entry: OffloadEntry): { originalLength: number; summaryLength: number } {
  const summaryContent = [
    `[Offloaded Tool Result | node: ${entry.node_id ?? "N/A"}]`,
    `Summary: ${entry.summary}`,
    `result_ref: ${entry.result_ref} (read this file for full tool call and raw result)`,
  ].join("\n");

  // Measure original content length
  // 中文：测量原始内容长度
  let originalLength = 0;
  const extractLength = (content: any): number => {
    if (typeof content === "string") return content.length;
    if (Array.isArray(content)) return content.reduce((acc: number, c: any) => acc + (typeof c === "string" ? c.length : (c.text?.length ?? 0)), 0);
    return 0;
  };

  if (msg.type === "message") {
    const message = msg.message;
    if (message) {
      originalLength = extractLength(message.content);
      if (Array.isArray(message.content)) {
        message.content = [{ type: "text", text: summaryContent }];
      } else {
        message.content = summaryContent;
      }
    }
  } else {
    originalLength = extractLength(msg.content);
    if (Array.isArray(msg.content)) {
      msg.content = [{ type: "text", text: summaryContent }];
    } else {
      msg.content = summaryContent;
    }
  }
  invalidateTokenCache(msg);
  return { originalLength, summaryLength: summaryContent.length };
}

/**
 * Compress non-current-task tool_use blocks inside an assistant message.
 * 中文：压缩助手消息内的非当前任务tool_use块.
 */
export function compressNonCurrentToolUseBlocks(
  msg: any,
  offloadMap: Map<string, OffloadEntry>,
  currentTaskNodeIds: Set<string>,
  replacedIds?: Set<string>,
): void {
  const content = getMessageContent(msg);
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const b = block as any;
    if (!isToolUseBlock(b)) continue;
    const id = b.id;
    if (!id) continue;
    if (
      replacedIds &&
      !replacedIds.has(id) &&
      !replacedIds.has(normalizeToolCallIdForLookup(id))
    ) {
      continue;
    }
    const entry = getOffloadEntry(offloadMap, id);
    if (!entry) continue;
    const idInReplacedIds =
      replacedIds &&
      (replacedIds.has(id) || replacedIds.has(normalizeToolCallIdForLookup(id)));
    if (!idInReplacedIds && entry.node_id && currentTaskNodeIds.has(entry.node_id))
      continue;
    const compactInput = {
      _offloaded: true,
      node_id: entry.node_id ?? "N/A",
      tool_call: compactToolCall(entry.tool_call),
    };
    if (b.arguments !== undefined) {
      b.arguments = compactInput;
    } else {
      b.input = compactInput;
    }
  }
  invalidateTokenCache(msg);
}

/** Get the set of node_ids belonging to the current active task */
/** 中文：获取当前活跃任务所属的node_ids集合. */
export async function getCurrentTaskNodeIds(
  stateManager: OffloadStateManager,
): Promise<Set<string>> {
  const nodeIds = new Set<string>();
  const activeMmdFile = stateManager.getActiveMmdFile();
  if (!activeMmdFile) return nodeIds;
  const mmdContent = await readMmd(stateManager.ctx, activeMmdFile);
  if (!mmdContent) return nodeIds;
  const nodePattern = /\b(\d+-N\d+|N\d+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = nodePattern.exec(mmdContent)) !== null) {
    nodeIds.add(match[1]);
  }
  return nodeIds;
}
