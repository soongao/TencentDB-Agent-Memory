/**
 * llm_output hook handler.
 * Detects when L1 should be force-triggered based on pending pair count.
 *
 * Backend-only mode: local LLM pipeline references removed.
 * 中文：llm_output hook handler.
 * 基于待处理配对数量检测是否应强制触发L1。
 * Backend-only模式：本地LLM管道引用移除。
 */
import type { OffloadStateManager } from "../state-manager.js";
import type { PluginConfig } from "../types.js";

const DEFAULT_FORCE_TRIGGER_THRESHOLD = 4;

/**
 * Check if L1 should be force-triggered (called from after_tool_call when
 * pending count exceeds threshold).
 * 中文：检查是否应强制触发L1（在after_tool_call调用时，当待处理计数超过阈值）
 */
export function shouldForceL1(
  stateManager: OffloadStateManager,
  pluginConfig: Partial<PluginConfig> | undefined,
): boolean {
  const threshold =
    pluginConfig?.forceTriggerThreshold ?? DEFAULT_FORCE_TRIGGER_THRESHOLD;
  return stateManager.getPendingCount() >= threshold;
}
