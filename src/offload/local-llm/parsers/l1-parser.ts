/**
 * L1 Response Parser — extracts summarization results from LLM output.
 * 中文：L1响应解析器——从LLM输出中提取总结结果。
 */
import { extractJson } from "./json-utils.js";
import type { OffloadEntry } from "../../types.js";

interface RawL1Entry {
  tool_call?: string;
  summary?: string;
  tool_call_id?: string;
  timestamp?: string;
  score?: number;
}

/**
 * Parse L1 LLM response into OffloadEntry array.
 * Tolerant of markdown wrapping, missing fields, etc.
 * 中文：解析L1 LLB响应为OffloadEntry数组。
 * 容忍markdown包裹、缺少字段等情况。
 */
export function parseL1Response(raw: string): OffloadEntry[] {
  const parsed = extractJson<RawL1Entry[]>(raw);
  if (!parsed || !Array.isArray(parsed)) return [];

  const entries: OffloadEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;

    const toolCallId = item.tool_call_id ?? "";
    if (!toolCallId) continue; // tool_call_id is required
    // 中文：tool_call_id 是必需的

    entries.push({
      tool_call_id: toolCallId,
      tool_call: item.tool_call ?? "",
      summary: item.summary ?? "",
      timestamp: item.timestamp ?? "",
      score: typeof item.score === "number" ? item.score : 5,
      node_id: null,
    });
  }

  return entries;
}
