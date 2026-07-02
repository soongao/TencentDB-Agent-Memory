/**
 * L2 Response Parser — extracts MMD generation results from LLM output.
 * 中文：L2响应解析器——从LLM输出中提取MMD生成结果。
 */
import { extractJson, extractMermaidFromFence } from "./json-utils.js";

export interface L2ParsedResponse {
  fileAction: "write" | "replace";
  mmdContent?: string;
  replaceBlocks?: Array<{
    startLine: number;
    endLine: number;
    content: string;
  }>;
  nodeMapping: Record<string, string>;
}

interface RawL2Response {
  file_action?: string;
  mmd_content?: string | null;
  replace_blocks?: Array<{
    start_line?: number | string;
    end_line?: number | string;
    content?: string;
  }> | null;
  node_mapping?: Record<string, string>;
}

/**
 * Parse L2 LLM response into structured L2 result.
 * Returns null if parsing fails completely.
 * 中文：将L2 LLM响应解析为结构化的L2结果。
 * 如果解析完全失败，则返回null。
 */
export function parseL2Response(raw: string): L2ParsedResponse | null {
  const parsed = extractJson<RawL2Response>(raw);
  if (!parsed || typeof parsed !== "object") {
    // Fallback: try extracting ```mermaid ... ``` code block (same as Go backend)
    // 中文：回退：尝试提取```mermaid ... ```代码块（与Go后端相同）
    const mmd = extractMermaidFromFence(raw);
    if (mmd) {
      return { fileAction: "write", mmdContent: mmd, nodeMapping: {} };
    }
    return null;
  }

  const fileAction = parsed.file_action === "replace" ? "replace" : "write";

  // Extract mmd_content (may be wrapped in code fence)
  // 中文：提取mmd_content（可能被代码围栏包裹）
  let mmdContent: string | undefined;
  if (fileAction === "write") {
    if (parsed.mmd_content) {
      mmdContent = extractMermaidFromFence(parsed.mmd_content) ?? parsed.mmd_content;
    } else {
      // mmd_content missing in write mode — try extracting from raw response
      // 中文：写入模式中mmd_content缺失——尝试从原始响应中提取
      const fallbackMmd = extractMermaidFromFence(raw);
      if (fallbackMmd) mmdContent = fallbackMmd;
    }
  }

  // Parse replace_blocks
  // 中文：解析replace_blocks
  let replaceBlocks: L2ParsedResponse["replaceBlocks"] | undefined;
  if (fileAction === "replace" && Array.isArray(parsed.replace_blocks)) {
    replaceBlocks = [];
    for (const block of parsed.replace_blocks) {
      if (!block || typeof block !== "object") continue;
      const startLine = Number(block.start_line);
      const endLine = Number(block.end_line);
      if (isNaN(startLine) || isNaN(endLine)) continue;

      let content = block.content ?? "";
      // Extract mermaid from fence if present
      // 中文：如果存在，从围栏中提取mermaid
      const extracted = extractMermaidFromFence(content);
      if (extracted) content = extracted;

      replaceBlocks.push({ startLine, endLine, content });
    }
  }

  // Parse node_mapping
  // 中文：解析node_mapping
  const nodeMapping: Record<string, string> = {};
  if (parsed.node_mapping && typeof parsed.node_mapping === "object") {
    for (const [key, value] of Object.entries(parsed.node_mapping)) {
      if (typeof value === "string") {
        nodeMapping[key] = value;
      }
    }
  }

  return {
    fileAction,
    mmdContent,
    replaceBlocks,
    nodeMapping,
  };
}
