/**
 * Tolerant JSON parsing utilities for LLM responses.
 *
 * LLMs often wrap JSON in markdown code fences, include trailing commas,
 * or prepend explanatory text. These utilities handle common deviations.
 * 中文：容忍LLM响应中的JSON解析工具。
 * LLMs常在JSON外包裹markdown代码栅栏，包含多余的逗号，或前置说明文本。这些工具处理常见的偏差.
 */

/**
 * Extract JSON from LLM output — handles code fences, prefix text, etc.
 * Returns the parsed object/array, or null if parsing fails.
 * 中文：从LLM输出中提取JSON —— 处理代码栅栏、前置文本等。
 * 如果解析失败，则返回null。
 */
export function extractJson<T = unknown>(raw: string): T | null {
  if (!raw || typeof raw !== "string") return null;

  const trimmed = raw.trim();

  // Strategy 1: Direct parse (ideal case)
  // 中文：策略1：直接解析（理想情况）
  const direct = tryParse<T>(trimmed);
  if (direct !== null) return direct;

  // Strategy 2: Extract from markdown code fence (```json ... ``` or ``` ... ```)
  // 中文：策略2：从markdown代码栅栏中提取（```json ... ```或``` ... ```）
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    const parsed = tryParse<T>(inner);
    if (parsed !== null) return parsed;
  }

  // Strategy 3: Find first { to last } (or first [ to last ])
  // 中文：策略3：找到第一个{到最后一个}（或第一个[到最后一个]）
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = tryParse<T>(candidate);
    if (parsed !== null) return parsed;

    // Try with trailing comma fix
    // 中文：尝试修复多余的逗号
    const fixed = fixTrailingCommas(candidate);
    const parsedFixed = tryParse<T>(fixed);
    if (parsedFixed !== null) return parsedFixed;
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const candidate = trimmed.slice(firstBracket, lastBracket + 1);
    const parsed = tryParse<T>(candidate);
    if (parsed !== null) return parsed;
  }

  // Strategy 4: Try fixing the entire string
  // 中文：策略4：尝试修复整个字符串
  const fixed = fixTrailingCommas(trimmed);
  const parsedFixed = tryParse<T>(fixed);
  if (parsedFixed !== null) return parsedFixed;

  return null;
}

/**
 * Extract mermaid content from a code fence.
 * Returns the raw mermaid text (without fence markers).
 * 中文：从代码栅栏中提取mermaid内容。
 * 返回原始的mermaid文本（不包含栅栏标记）。
 */
export function extractMermaidFromFence(text: string): string | null {
  if (!text) return null;
  const match = text.match(/```mermaid\s*\n?([\s\S]*?)```/);
  if (match) return match[1].trim();
  // Fallback: if no fence, return as-is (might already be raw mermaid)
  // 中文：默认：如果没有分隔符，原样返回（可能已经是原始的 mermaid）
  if (text.includes("flowchart") || text.includes("graph")) return text.trim();
  return null;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────
// 中文：─── 内部辅助函数 ────────────────────────────────────────────────────────

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function fixTrailingCommas(s: string): string {
  // Remove trailing commas before } or ]
  // 中文：移除}或]之前的尾随逗号
  return s.replace(/,\s*([}\]])/g, "$1");
}
