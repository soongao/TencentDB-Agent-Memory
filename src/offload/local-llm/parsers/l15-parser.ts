/**
 * L1.5 Response Parser — extracts task judgment from LLM output.
 * 中文：L1.5 响应解析器 — 从LLM输出中提取任务判断。
 */
import { extractJson } from "./json-utils.js";
import type { TaskJudgment } from "../../types.js";

interface RawL15Response {
  taskCompleted?: boolean | null;
  isContinuation?: boolean | null;
  isLongTask?: boolean | null;
  continuationMmdFile?: string | null;
  newTaskLabel?: string | null;
}

/**
 * Parse L1.5 LLM response into TaskJudgment.
 * Returns null if the response is completely unparseable or all-null (backend unavailable).
 * 中文：将L1.5 LLM响应解析为TaskJudgment。
 * 如果响应完全无法解析或全部为空（后端不可用），则返回null。
 */
export function parseL15Response(raw: string): TaskJudgment | null {
  const parsed = extractJson<RawL15Response>(raw);
  if (!parsed || typeof parsed !== "object") return null;

  // All-null check (mirrors normalizeJudgment logic)
  // 中文：全部为空检查（镜像normalizeJudgment逻辑）
  if (parsed.taskCompleted == null && parsed.isContinuation == null && parsed.isLongTask == null) {
    return null;
  }

  return {
    taskCompleted: Boolean(parsed.taskCompleted),
    isContinuation: Boolean(parsed.isContinuation),
    isLongTask: Boolean(parsed.isLongTask),
    continuationMmdFile:
      typeof parsed.continuationMmdFile === "string" ? parsed.continuationMmdFile : undefined,
    newTaskLabel:
      typeof parsed.newTaskLabel === "string" ? parsed.newTaskLabel : undefined,
  };
}
