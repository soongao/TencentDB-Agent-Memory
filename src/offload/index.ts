/**
 * Context Offload Module Entry
 *
 * Exports `registerOffload(api, offloadConfig)` for conditional registration
 * from the main plugin index.ts.
 *
 * This module is the merged equivalent of the standalone context-offload-plugin's index.js,
 * adapted to co-exist with the memory-tencentdb plugin.
 * 中文：上下文卸载模块入口
 * 导出 `registerOffload(api, offloadConfig)` 用于条件注册
 * 从主插件 index.ts 导入。
 * 此模块是独立 context-offload-plugin 的 index.js 的合并等价物，适应与 memory-tencentdb 插件共存。
 */
import { OffloadStateManager } from "./state-manager.js";
import { createAfterToolCallHandler } from "./hooks/after-tool-call.js";
import { createBeforePromptBuildHandler } from "./hooks/before-prompt-build.js";
import { shouldForceL1 } from "./hooks/llm-output.js";
import { handleTaskTransition, normalizeJudgment } from "./hooks/before-agent-start.js";
import { checkL2Trigger, backfillNodeIds } from "./pipelines/l2-mermaid.js";
import { PLUGIN_DEFAULTS } from "./types.js";
import { initOffloadOpikTracer } from "./opik-tracer.js";
import {
  readAllOffloadEntries,
  readOffloadEntries,
  markOffloadStatus,
  DEFAULT_DATA_ROOT,
} from "./storage.js";
import { buildTiktokenContextSnapshot, configureTokenTracker, tiktokenCount, jsonReplacer } from "./context-token-tracker.js";
import { fastEstimateMessages } from "./fast-token-estimate.js";
import {
  normalizeToolCallIdForLookup,
  getOffloadEntry,
  populateOffloadLookupMap,
  isToolResultMessage,
  extractToolCallId,
  isOnlyToolUseAssistant,
  extractAllToolUseIds,
  isAssistantMessageWithToolUse,
  replaceWithSummary,
  replaceAssistantToolUseWithSummary,
  compressNonCurrentToolUseBlocks,
  getCurrentTaskNodeIds,
} from "./l3-helpers.js";
import { createL3TokenCounter } from "./l3-token-counter.js";
import {
  compressByScoreCascade,
  aggressiveCompressUntilBelowThreshold,
  buildHistoryMmdInjection,
  removeExistingMmdInjections,
  emergencyCompress,
  EMERGENCY_MIN_MESSAGES_TO_KEEP,
  isTokenOverflowError,
} from "./hooks/llm-input-l3.js";
import { findHistoryMmdInsertionPoint } from "./mmd-injector.js";
import type { OffloadConfig } from "../config.js";
import type { PluginConfig, PluginLogger } from "./types.js";
import { BackendClient } from "./backend-client.js";
import { LocalLlmClient } from "./local-llm/index.js";
import { resolveApiKeyFromAuthProfile } from "./auth-profile-key.js";
import type { L1Request, L15Request, L2Request } from "./backend-client.js";
import { parseMmdMeta } from "./mmd-meta.js";
import { sanitizeText, writeRefMd } from "./storage.js";
import { listMmds, readMmd, writeMmd, patchMmd } from "./storage.js";
import {
  appendOffloadEntries,
  rewriteAllOffloadEntries,
} from "./storage.js";
import { nowChinaISO } from "./time-utils.js";
import { traceOffloadDecision, traceMessagesSnapshot } from "./opik-tracer.js";
import { SessionRegistry } from "./session-registry.js";
import { reclaimOffloadData } from "./reclaimer.js";
import { buildL3TriggerReport, reportL3Trigger } from "./state-reporter.js";
import { resolveUserId, getUserIdSource } from "./user-id.js";

// ─── Module-level state ──────────────────────────────────────────────────────
// OpenClaw calls registerOffload() multiple times during lifecycle.
// L2 scheduler and L1.5 dispose flag are shared across invocations.
// L2 scheduler state — shared across registerOffload() calls
// 中文：─── 模块级状态 ──────────────────────────────────────────────────────
// OpenClaw 在生命周期中多次调用 registerOffload()。
// L2 调度器和 L1.5 处置标志在多次调用间共享。
// L2 调度器状态 —— 在多次调用 registerOffload() 之间共享
let _l2Running = false;
let _l2PollHandle: ReturnType<typeof setTimeout> | null = null;
let _l2FirstNotifyAt: number | null = null;

// L1.5 retry loop dispose flag
// 中文：L1.5 重试循环处置标志
let _l15Disposed = false;

// Reclaim scheduler timer — module-level so dispose() can clear it
// 中文：回收调度器定时器 —— 模块级的，以便 dispose() 可以清除它
let _reclaimTimer: ReturnType<typeof setTimeout> | null = null;

// Context Engine singleton — survives across registerOffload() calls.
// 中文：上下文引擎单例 —— 跨多次调用 registerOffload() 存在。
let _sharedEngine: OffloadContextEngine | null = null;
let _contextEngineRegistered = false;
/** Set to true when registerContextEngine returns ok=false or throws — all offload functions disabled. */
/** 中文：当 registerContextEngine 返回 ok=false 或抛出时设置为 true —— 所有卸载功能禁用。 */
let _contextEngineRejected = false;

// SessionRegistry singleton — MUST be shared between engine and hooks.
// OpenClaw calls register() N times; hooks from different calls may coexist.
// If each call creates a new SessionRegistry, the same sessionKey resolves
// to different manager instances in engine vs hooks, breaking L1.5→L2 state.
// 中文：SessionRegistry 单例 —— 必须在引擎和钩子之间共享。
// OpenClaw 多次调用 register()；不同调用的钩子可能共存。
// 如果每次调用都创建一个新的 SessionRegistry，相同的 sessionKey 在引擎与钩子中会解析为不同的管理实例，破坏 L1.5→L2 状态。
let _sharedSessions: SessionRegistry | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
// 中文：─── 辅助函数 ─────────────────────────────────────────────────────────────────

function parseCreateSkillCommand(
  prompt: string,
): { mmdName: string | null; skillFocus: string | null } | null {
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/create-skill(?:\s+(.*))?$/i);
  if (!match) return null;
  const args = (match[1] || "").trim();
  if (!args) return { mmdName: null, skillFocus: null };
  const parts = args.split(/\s+/);
  const mmdName = parts[0] || null;
  const skillFocus = parts.slice(1).join(" ") || null;
  return { mmdName, skillFocus };
}

function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Compute a fingerprint for a message (role + first 200 chars of content). */
/** 中文：计算一条消息（角色+内容前200个字符）的指纹。 */
function _msgFingerprint(msg: any): number {
  const role = msg.role ?? msg.message?.role ?? msg.type ?? "";
  let content = "";
  const raw = msg.type === "message" ? msg.message?.content : msg.content;
  if (typeof raw === "string") content = raw.slice(0, 200);
  else if (Array.isArray(raw)) content = JSON.stringify(raw).slice(0, 200);
  return simpleHash(`${role}:${content}`);
}


function _extractLatestTurn(_messages: any[], currentPrompt: string | null): string | null {
  const effectivePrompt = _isHeartbeatText(currentPrompt ?? "") ? null : currentPrompt;
  if (!effectivePrompt) return null;
  return `[User]: ${String(effectivePrompt).slice(0, 500)}`;
}

function _extractMsgText(msg: any): string {
  const content = msg.content ?? msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join(" ");
  return "";
}

function _normalizePromptForCompare(text: string | null): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Check if a message text looks like a heartbeat probe.
 * Matches both user heartbeat prompts and assistant HEARTBEAT_OK replies.
 * 中文：检查消息文本是否像是心跳探测。
 * 既匹配用户的心跳提示也匹配助手的HEARTBEAT_OK回复。
 */
function _isHeartbeatText(text: string): boolean {
  return text.includes("HEARTBEAT") || text.includes("heartbeat");
}

/**
 * Extract recent history messages for L1/L2 context, organized as
 * user-assistant pairs: each user message followed by up to
 * `maxAssistantPerUser` assistant replies from that turn.
 *
 * Output format:
 *   [User]: xxx
 *   [Assistant]: aaa
 *   [User]: yyy
 *   [Assistant]: bbb
 *   [Assistant]: ccc
 *
 * Scans messages in forward order, skipping MMD injections, heartbeat
 * probes, and the current prompt (to avoid duplication).
 * 中文：提取用于L1/L2上下文的历史消息，组织为
 * 用户-助手对：每个用户的发言后跟最多`maxAssistantPerUser`个该回合的助手回复。
 * 输出格式：
 * [User]: xxx
 * [Assistant]: aaa
 * [User]: yyy
 * [Assistant]: bbb
 * [Assistant]: ccc
 * 按正向顺序扫描消息，跳过MMD注入、心跳探测和当前提示（避免重复）。
 */
function _extractRecentHistory(messages: any[], currentPrompt: string | null = null, maxAssistantPerUser = 3): string | null {
  const normalizedCurrent = _normalizePromptForCompare(currentPrompt);

  // Collect turns: each turn = { user: string, assistants: string[] }
  // 中文：收集回合：每个回合 = { user: string, assistants: string[] }
  const turns: Array<{ user: string; assistants: string[] }> = [];
  let currentTurn: { user: string; assistants: string[] } | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg._mmdContextMessage || msg._mmdInjection) continue;
    const role = msg.role ?? msg.message?.role ?? msg.type;

    if (role === "user") {
      let text = _extractMsgText(msg);
      if (!text || text.length <= 5) continue;
      // Skip heartbeat probes
      // 中文：跳过心跳探测
      if (_isHeartbeatText(text)) { currentTurn = null; continue; }
      text = text.slice(0, 400);
      // Skip current prompt (already in "current msg" section)
      // 中文：跳过当前提示（已在“当前消息”部分）
      if (normalizedCurrent) {
        const normalizedText = _normalizePromptForCompare(text);
        if (normalizedText === normalizedCurrent || normalizedText.startsWith(normalizedCurrent) || normalizedCurrent.startsWith(normalizedText)) continue;
      }
      // Start a new turn
      // 中文：开始一个新的回合
      currentTurn = { user: text, assistants: [] };
      turns.push(currentTurn);
    } else if (role === "assistant" && currentTurn) {
      if (currentTurn.assistants.length >= maxAssistantPerUser) continue;
      const directText = _extractMsgText(msg);
      if (!directText || directText.length <= 10) continue;
      // Skip heartbeat replies (e.g. "HEARTBEAT_OK")
      // 中文：跳过心跳回复（例如：“HEARTBEAT_OK”）
      if (_isHeartbeatText(directText)) continue;
      currentTurn.assistants.push(directText.slice(0, 400));
    }
  }

  // Keep only the most recent turns (limit total to avoid oversized context)
  // 中文：仅保留最近的轮次（限制总数以避免上下文过大）
  const maxTurns = 5;
  const recentTurns = turns.slice(-maxTurns);

  const parts: string[] = [];
  for (const turn of recentTurns) {
    parts.push(`[User]: ${turn.user}`);
    for (const a of turn.assistants) {
      parts.push(`[Assistant]: ${a}`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function _buildL1RecentContext(stateManager: OffloadStateManager): string {
  // Skip heartbeat prompts in current msg
  // 中文：跳过当前消息中的心跳提示
  const rawPrompt = stateManager.cachedUserPrompt;
  const isHeartbeat = typeof rawPrompt === "string" && _isHeartbeatText(rawPrompt);
  const currentLine = (!isHeartbeat && typeof rawPrompt === "string" && rawPrompt.trim())
    ? `[User]: ${rawPrompt.slice(0, 500)}`
    : (stateManager.cachedLatestTurnMessages || "(none)");
  const historyBlock = stateManager.cachedRecentHistory || "(none)";
  return `## current msg:\n${currentLine}\n\n## history msg:\n${historyBlock}`;
}

/** L1.5-specific format: history as reference first, latest user message as focus last. */
/** 中文：L1.5特定格式：历史记录作为参考优先，最新用户消息作为重点最后。 */
function _buildL15RecentContext(stateManager: OffloadStateManager): string {
  const rawPrompt = stateManager.cachedUserPrompt;
  const isHeartbeat = typeof rawPrompt === "string" && _isHeartbeatText(rawPrompt);
  const currentLine = (!isHeartbeat && typeof rawPrompt === "string" && rawPrompt.trim())
    ? `[User]: ${rawPrompt.slice(0, 500)}`
    : (stateManager.cachedLatestTurnMessages || "(none)");
  const historyBlock = stateManager.cachedRecentHistory || "(none)";
  return `历史消息，可作为参考：\n${historyBlock}\n\n最新user message：\n${currentLine}`;
}

/**
 * Register the offload module with OpenClaw plugin API.
 * Called from main index.ts when offload.enabled = true.
 *
 * NOTE: No idempotency guard here. OpenClaw calls register() multiple
 * times during its lifecycle (plugin scan → gateway start → config reload).
 * Each call provides a different `api` instance; only the last one is the
 * live runtime api. Hooks registered on earlier api instances are discarded.
 * registerContextEngine and api.on/registerHook are safe to call repeatedly.
 * 中文：使用OpenClaw插件API注册卸载模块。
 * 在offload.enabled = true时从main index.ts调用。
 * 注意：这里没有幂等性保护。OpenClaw在其生命周期中多次调用register()（插件扫描 → 网关启动 → 配置重新加载）。
 * 每次调用提供不同的`api`实例；只有最后一个才是当前运行时的api。在早期api实例上注册的钩子会被丢弃。
 * registerContextEngine和api.on/registerHook可以安全地重复调用。
 */

/**
 * Detect internal memory-pipeline sessions that should NOT run offload.
 * Actual format from framework: `agent:main:explicit:memory-{taskId}-session-{ts}`
 * Raw format from clean-context-runner: `memory-{taskId}-session-{ts}`
 * 中文：检测不应卸载的内部内存管道会话。
 * 框架的实际格式：`agent:main:explicit:memory-{taskId}-session-{ts}`
 * 清理上下文运行器的原始格式：`memory-{taskId}-session-{ts}`
 */
const INTERNAL_SESSION_RE = /memory-.*-session-\d+/;

function isInternalMemorySession(sessionKey: string | null | undefined): boolean {
  return typeof sessionKey === "string" && INTERNAL_SESSION_RE.test(sessionKey);
}

export function registerOffload(api: any, offloadConfig: OffloadConfig): void {
  const logger: PluginLogger = api.logger;

  // ── Diagnostic: detect whether api.on / api.registerHook is functional ──
  // 中文：── 调试信息：检测api.on / api.registerHook是否功能正常 ──
  const regMode = api.registrationMode ?? "(not exposed)";
  const hasRegisterHook = typeof api.registerHook === "function";
  const hasOn = typeof api.on === "function";
  const hasRegisterContextEngine = typeof api.registerContextEngine === "function";
  const onFnName = api.on?.name ?? "(unnamed)";
  const onFnBody = String(api.on).slice(0, 200);
  logger.debug?.(
    `[context-offload] [DIAG] registrationMode=${regMode}, ` +
    `registerHook=${hasRegisterHook}, api.on=${hasOn} name="${onFnName}", ` +
    `registerContextEngine=${hasRegisterContextEngine}, ` +
    `api.on body=${onFnBody}`,
  );

  logger.debug?.("[context-offload] Registering offload module...");
  initOffloadOpikTracer(api.config, logger);

  // Build plugin config from OffloadConfig
  // 中文：从OffloadConfig构建插件配置
  const pCfg: Partial<PluginConfig> = {
    model: offloadConfig.model,
    temperature: offloadConfig.temperature,
    forceTriggerThreshold: offloadConfig.forceTriggerThreshold,
    dataDir: offloadConfig.dataDir,
    defaultContextWindow: offloadConfig.defaultContextWindow,
    maxPairsPerBatch: offloadConfig.maxPairsPerBatch,
    l2NullThreshold: offloadConfig.l2NullThreshold,
    l2TimeoutSeconds: offloadConfig.l2TimeoutSeconds,
    mildOffloadRatio: offloadConfig.mildOffloadRatio,
    aggressiveCompressRatio: offloadConfig.aggressiveCompressRatio,
    mmdMaxTokenRatio: offloadConfig.mmdMaxTokenRatio,
  };

  // Fix 4: Configure token tracker encoding to match plugin config (default: o200k_base)
  // 中文：修复4：将令牌跟踪编码配置为匹配插件配置（默认值：o200k_base）
  const _encoding = pCfg.l3TiktokenEncoding ?? PLUGIN_DEFAULTS.l3TiktokenEncoding;
  configureTokenTracker(pCfg.l3TiktokenEncoding);
  logger.debug?.(`[context-offload] Token tracker encoding: ${_encoding} (configured from ${pCfg.l3TiktokenEncoding ? "pluginConfig" : "default"})`);

  // Session Registry — module-level singleton so engine + hooks always share the same instance
  // 中文：会话注册表 — 模块级单例，因此引擎+钩子总是共享同一个实例
  const dataRoot = offloadConfig.dataDir ?? DEFAULT_DATA_ROOT;
  if (!_sharedSessions) {
    _sharedSessions = new SessionRegistry(dataRoot);
  }
  const sessions = _sharedSessions;

  // Resolve LLM Configuration — mode-based selection
  // - "backend": use remote backend service (requires backendUrl)
  // - "local": call LLM directly via AI SDK (uses offload.model or main agent model)
  //
  // User identity: prefer offloadConfig.userId; fall back to the host's
  // primary non-loopback IPv4 address.
  // 中文：解析LLM配置 — 基于模式的选择
  // - "backend"：使用远程后端服务（需要backendUrl）
  // - "local"：通过AI SDK直接调用LLM（使用offload.model或主代理模型）用户身份：优先选择offloadConfig.userId；否则回退到主机的
  // 主要非环回IPv4地址。
  const _resolvedUserId = resolveUserId(offloadConfig.userId ?? null);
  logger.debug?.(
    `[context-offload] user-id resolved: "${_resolvedUserId}" (source=${getUserIdSource() ?? "?"})`,
  );

  let backendClient: BackendClient | LocalLlmClient | null = null;

  if (offloadConfig.mode === "backend" || offloadConfig.mode === "collect") {
    // Remote backend mode (or collect mode with backend)
    // 中文：远程后端模式（或收集模式带有后端）
    if (!offloadConfig.backendUrl) {
      logger.error(`[context-offload] mode=${offloadConfig.mode} but backendUrl not configured. L1/L1.5/L2/L4 disabled.`);
    } else {
      backendClient = new BackendClient(
        offloadConfig.backendUrl,
        logger,
        offloadConfig.backendApiKey,
        offloadConfig.backendTimeoutMs,
        () => _lastActiveSessionKey,
        () => _resolvedUserId,
        () => { try { return _lastActiveMgr?.getLastSessionKey?.() ?? _lastActiveSessionKey; } catch { return _lastActiveSessionKey; } },
      );
    }
  } else {
    // Local LLM mode — resolve model from offload.model or fall back to agents.defaults.model
    // 中文：本地LLM模式 — 从offload.model解析模型，如果没有则回退到agents.defaults.model
    let resolvedModelRef = offloadConfig.model;
    if (!resolvedModelRef) {
      // Fallback: use main agent model from openclaw.json agents.defaults.model
      // 中文：回退：使用openclaw.json中的agents.defaults.model主代理模型
      const mainConfig = api.config as Record<string, unknown> | undefined;
      const agents = mainConfig?.agents as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      const modelCfg = defaults?.model;
      if (typeof modelCfg === "string" && modelCfg.includes("/")) {
        resolvedModelRef = modelCfg;
      } else if (modelCfg && typeof modelCfg === "object") {
        const primary = (modelCfg as Record<string, unknown>).primary;
        if (typeof primary === "string" && primary.includes("/")) {
          resolvedModelRef = primary;
        }
      }
      if (resolvedModelRef) {
        logger.debug?.(`[context-offload] offload.model not set, using main agent model: ${resolvedModelRef}`);
      }
    }

    if (resolvedModelRef) {
      const modelParts = resolvedModelRef.split("/", 2);
      const providerKey = modelParts[0];
      const modelId = modelParts[1] ?? resolvedModelRef;
      const models = (api.config as any)?.models;
      const providerCfg = models?.providers?.[providerKey];
      const baseUrl = providerCfg?.baseUrl ?? providerCfg?.baseURL;
      // Key resolution: prefer the plaintext key in models.providers, then fall
      // back to OpenClaw's auth-profile store (issue #90). The fallback is a
      // synchronous no-op on hosts that don't expose the auth-profile SDK.
      // 中文：密钥解析：优先选择models.providers中的明文密钥，如果没有则回退到OpenClaw的auth-profile存储（问题#90）。回退在不暴露auth-profile SDK的主机上是一个同步空操作。
      const apiKey = providerCfg?.apiKey ?? resolveApiKeyFromAuthProfile(api, providerKey, logger);

      if (baseUrl && apiKey) {
        backendClient = new LocalLlmClient(
          { baseUrl, apiKey, model: modelId, temperature: offloadConfig.temperature, timeoutMs: offloadConfig.backendTimeoutMs, disableThinking: offloadConfig.disableThinking },
          logger,
        );
      } else {
        logger.error(
          `[context-offload] Local LLM mode failed: provider "${providerKey}" not found or missing baseUrl/apiKey in models.providers (or auth profiles). ` +
          `L1/L1.5/L2 disabled.`,
        );
      }
    } else {
      logger.warn("[context-offload] No model resolved (offload.model not set, agents.defaults.model not found). L1/L1.5/L2 disabled.");
    }
  }

  // Track last active session key for BackendClient header
  // 中文：跟踪BackendClient头中的最后活跃会话密钥
  let _lastActiveSessionKey: string | null = null;

  if (backendClient && (offloadConfig.mode === "backend" || offloadConfig.mode === "collect")) {
    logger.debug?.(`[context-offload] LLM mode: backend (${offloadConfig.backendUrl})`);
  } else if (backendClient) {
    logger.debug?.(`[context-offload] LLM mode: local (${offloadConfig.model ?? "main-agent-model"})`);
  } else {
    logger.warn("[context-offload] LLM client not available. L1/L1.5/L2/L4 disabled (L3 compression still active).");
  }

  // ─── Fault tolerance constants ──────────────────────────────────────────────
  // 中文：─── 容错常量 ──────────────────────────────────────────────
  const MAX_L1_CHUNK_RETRIES = 3;
  const L1_BATCH_SIZE = 5; // matches backend toolPairs limit (1-5)
  // 中文：匹配后端toolPairs限制（1-5）
  const L2_BATCH_SIZE = 30; // max entries per L2 backend call to avoid oversized requests / timeouts
  // 中文：每个L2后端调用的最大条目数，以避免请求过大/超时

  // ─── Backend-aware L1 flush helper (with batching + retry + fallback) ──────
  // Backend mode only: take pairs → filter → split into batches → per-batch HTTP
  // → on failure: retry up to MAX_L1_CHUNK_RETRIES → then generate local fallback entries.
  // 中文：─── 后端感知的L1刷新辅助程序（带批量处理+重试+备用方案） ──────
  // 仅后端模式：取键值对 → 过滤 → 分成批次 → 批次HTTP请求
  // 失败时：最多重试MAX_L1_CHUNK_RETRIES次 → 然后生成本地备用条目。
  const flushL1 = async (stateManager: OffloadStateManager, triggerSource: string, fireAndForget = false, maxCount?: number): Promise<void> => {
    if (!backendClient) return;
    if (!stateManager.hasPending()) return;

    const release = await stateManager.acquireL1Lock();
    try {
      // Take and filter pairs
      // 中文：取并过滤键值对
      const pendingCount = stateManager.getPendingCount();
      const takeCount = maxCount != null ? Math.min(maxCount, pendingCount) : pendingCount;
      let takenPairs = stateManager.takePending(takeCount);
      if (takenPairs.length === 0) return;

      // Filter heartbeat pairs
      // 中文：过滤心跳键值对
      const isHeartbeat = (p: typeof takenPairs[0]) => {
        try {
          const raw = typeof p.params === "string" ? p.params : JSON.stringify(p.params ?? "");
          return raw.includes("HEARTBEAT.md");
        } catch { return false; }
      };
      const beforeFilter = takenPairs.length;
      const pairs = takenPairs.filter((p) => !isHeartbeat(p));
      if (beforeFilter > pairs.length) {
        logger.debug?.(`[context-offload] L1: filtered ${beforeFilter - pairs.length} heartbeat pair(s)`);
      }
      if (pairs.length === 0) return;

      // L1.1: Write ref MD files locally (preserves raw tool results for L3 recovery)
      // 中文：L1.1: 本地写入引用MD文件（保留原始工具结果供L3恢复使用）
      const refByToolCallId = new Map<string, string>();
      for (const p of pairs) {
        try {
          const resultStr = typeof p.result === "string"
            ? sanitizeText(p.result)
            : sanitizeText(JSON.stringify(p.result, null, 2));
          const content = `**Tool:** ${p.toolName}\n**Call ID:** ${p.toolCallId}\n\n**Result:**\n\`\`\`\n${resultStr}\n\`\`\``;
          const refPath = await writeRefMd(stateManager.ctx, p.timestamp, p.toolName, content);
          refByToolCallId.set(p.toolCallId, refPath);
        } catch (err) {
          logger.error(`[context-offload] L1.1 ref write error (${p.toolCallId}): ${err}`);
        }
      }

      // Split into batches of L1_BATCH_SIZE
      // 中文：分成大小为L1_BATCH_SIZE的批次
      const batches: typeof pairs[] = [];
      for (let i = 0; i < pairs.length; i += L1_BATCH_SIZE) {
        batches.push(pairs.slice(i, i + L1_BATCH_SIZE));
      }
      logger.debug?.(`[context-offload] L1 (${triggerSource}): ${pairs.length} pairs → ${batches.length} batch(es) of ≤${L1_BATCH_SIZE}`);

      const recentMessages = _buildL1RecentContext(stateManager);
      logger.debug?.(`[context-offload] L1 recentMessages (${recentMessages.length} chars):\n${recentMessages}`);

      for (const chunk of batches) {
        const chunkKey = chunk[0].toolCallId; // track by first toolCallId
        // 中文：通过第一个toolCallId跟踪
        const prevFails = stateManager._l1ChunkFailCounts.get(chunkKey) ?? 0;

        try {
          const req: L1Request = {
            recentMessages,
            toolPairs: chunk.map((p) => ({
              toolName: p.toolName,
              toolCallId: p.toolCallId,
              params: typeof p.params === "string" ? sanitizeText(p.params) : p.params,
              result: typeof p.result === "string" ? sanitizeText(p.result as string) : p.result,
              timestamp: p.timestamp,
            })),
          };
          const resp = await backendClient.l1Summarize(req);

          // Success — reset fail count, write entries
          // 中文：成功 — 重置失败计数，写入条目
          stateManager._l1ChunkFailCounts.delete(chunkKey);
          if (resp.entries && resp.entries.length > 0) {
            for (const entry of resp.entries) {
              if (!entry.result_ref && refByToolCallId.has(entry.tool_call_id)) {
                entry.result_ref = refByToolCallId.get(entry.tool_call_id)!;
              }
            }
            await appendOffloadEntries(stateManager.ctx, resp.entries, undefined, logger);
            stateManager.entryCounter += resp.entries.length;
            logger.debug?.(`[context-offload] L1 batch OK: ${resp.entries.length} entries from ${chunk.length} pairs (entryCounter=${stateManager.entryCounter})`);
          }
        } catch (err) {
          const newFails = prevFails + 1;
          logger.warn(`[context-offload] L1 batch FAILED (${chunkKey}, attempt ${newFails}/${MAX_L1_CHUNK_RETRIES}): ${err}`);

          if (newFails >= MAX_L1_CHUNK_RETRIES) {
            // Exceeded retry limit — generate local fallback entries (no LLM summary)
            // 中文：超出重试限制 — 生成本地备用条目（无LLM总结）
            logger.warn(`[context-offload] L1 batch DEGRADED: ${chunk.length} pairs → fallback entries (no LLM summary)`);
            stateManager._l1ChunkFailCounts.delete(chunkKey);
            const fallbackEntries: import("./types.js").OffloadEntry[] = [];
            for (const p of chunk) {
              const resultStr = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "");
              const truncResult = resultStr.length > 300 ? resultStr.slice(0, 297) + "..." : resultStr;
              const truncParams = typeof p.params === "string"
                ? (p.params.length > 200 ? p.params.slice(0, 197) + "..." : p.params)
                : JSON.stringify(p.params ?? "").slice(0, 200);
              fallbackEntries.push({
                timestamp: p.timestamp,
                node_id: null,
                tool_call: `${p.toolName}(${truncParams})`,
                summary: `[L1 degraded] ${p.toolName}: ${truncResult}`,
                result_ref: refByToolCallId.get(p.toolCallId) ?? "",
                tool_call_id: p.toolCallId,
                score: 0,
              });
            }
            await appendOffloadEntries(stateManager.ctx, fallbackEntries, undefined, logger);
            stateManager.entryCounter += fallbackEntries.length;
            logger.debug?.(`[context-offload] L1 fallback: wrote ${fallbackEntries.length} degraded entries`);
          } else {
            // Under retry limit — re-enqueue this chunk for next flush
            // 中文：未超出重试限制 — 将此块重新入队以备下次刷新
            stateManager._l1ChunkFailCounts.set(chunkKey, newFails);
            for (const p of chunk) {
              stateManager.processedToolCallIds.delete(p.toolCallId);
              stateManager.pendingToolPairs.push(p as any);
            }
            logger.debug?.(`[context-offload] L1 batch: re-enqueued ${chunk.length} pairs (retry ${newFails}/${MAX_L1_CHUNK_RETRIES})`);
          }
        }
      }
    } finally {
      release();
    }
  };

  // ─── Backend-aware L1.5 judge helper (1 retry, fail-safe) ──────────────────
  // L1.5 determines task boundary. On failure (after 1 retry):
  //   - activeMmd cleared to null → L2 won't trigger
  //   - All null entries marked as "short" → won't pollute future L2
  //   - This turn has no MMD construction
  // 中文：─── 后端感知的L1.5判断辅助（1次重试，故障安全） ──────────────────
  // L1.5确定任务边界。失败后（1次重试之后）：
  // - activeMmd清空为null → L2不会触发
  // - 所有null条目标记为"short" → 不会污染未来的L2
  // - 本回合没有MMD构建
  _l15Disposed = false; // Reset on re-registration
  // 中文：重新注册时重置
  const L15_RETRY_DELAY_MS = 3000;

  /** L1.5 fail-safe: push a short boundary instead of marking entries on disk. */
  /** 中文：L1.5故障安全：推送一个短边界而不是在磁盘上标记条目。 */
  const _l15FailSafe = async (stateManager: OffloadStateManager, startIndex: number) => {
    stateManager.setActiveMmd(null, null);
    stateManager.pushBoundary({ startIndex, result: "short", targetMmd: null });
    await stateManager.save();
    stateManager.setMmdInjectionReady(false);
    stateManager.l15Settled = true;
    logger.warn(`[context-offload] L1.5 fail-safe: settled (boundary short @${startIndex}, activeMmd=null)`);
  };

  const attemptL15 = async (stateManager: OffloadStateManager, startIndex: number): Promise<boolean> => {
    try {
      // Build request
      // 中文：构建请求
      const allMmds = await listMmds(stateManager.ctx);
      const availableMmds = allMmds.slice(-10);
      const { join } = await import("node:path");
      const mmdMetas: L15Request["availableMmdMetas"] = [];
      for (const mmdFile of availableMmds) {
        try {
          const content = await readMmd(stateManager.ctx, mmdFile);
          if (content) {
            mmdMetas.push(parseMmdMeta(mmdFile, join(stateManager.ctx.mmdsDir, mmdFile), content));
          }
        } catch { /* skip */ }
      }
      const currentMmdFilename = stateManager.getActiveMmdFile();
      let currentMmd: L15Request["currentMmd"] = null;
      if (currentMmdFilename) {
        const content = await readMmd(stateManager.ctx, currentMmdFilename);
        if (content) {
          currentMmd = { filename: currentMmdFilename, content, path: join(stateManager.ctx.mmdsDir, currentMmdFilename) };
        }
      }
      const recentMessages = _buildL15RecentContext(stateManager);

      stateManager.setMmdInjectionReady(false);
      const resp = await backendClient!.l15Judge({ recentMessages, currentMmd, availableMmdMetas: mmdMetas });

      // Normalize backend response (handles null fields from fallback)
      // 中文：规范化后端响应（处理备用方案中的空字段）
      const judgment = normalizeJudgment(resp as unknown as Record<string, unknown>);
      if (!judgment) {
        logger.warn("[context-offload] L1.5: all-null response (backend LLM unavailable)");
        return false; // trigger retry
        // 中文：触发重试
      }

      // Success
      // 中文：成功
      logger.debug?.(
        `[context-offload] L1.5: completed=${judgment.taskCompleted}, continuation=${judgment.isContinuation}, longTask=${judgment.isLongTask}, label=${judgment.newTaskLabel ?? "none"}, contFile=${judgment.continuationMmdFile ?? "none"}`,
      );

      // ── Flush residual null entries for the OLD mmd before task transition ──
      // When the user switches tasks, the old mmd may have < l2NullThreshold
      // null entries that would never reach the threshold trigger. We detect
      // the mmd change and fire a forced L2 for the old mmd's remaining entries
      // so they are not orphaned or mis-attributed to the new mmd.
      // 中文：── 在任务过渡前刷新旧mmd的残留null条目 ──
      // 当用户切换任务时，旧mmd可能有< l2NullThreshold
      // 个永远不会触发阈值的空条目。我们检测
      // mmd变化并为旧mmd剩余条目触发强制L2，以防止它们成为孤儿或错误地分配给新的mmd。
      const prevMmdFile = currentMmdFilename; // captured before handleTaskTransition
      // 中文：在handleTaskTransition之前捕获

      // Apply task transition
      // 中文：应用任务过渡
      await handleTaskTransition(stateManager, judgment, logger);

      const newMmdFile = stateManager.getActiveMmdFile();
      const mmdSwitched = prevMmdFile && newMmdFile !== prevMmdFile;
      if (mmdSwitched) {
        // Fire-and-forget: flush residual null entries for the OLD mmd.
        // Only include entries whose index < startIndex (they belong to the
        // previous boundary, not the new one being pushed below).
        // 中文：投递：刷新旧mmd的残留null条目。
        // 仅包括索引<startIndex的条目（它们属于之前的边界，而不是正在下面推送的新边界）。
        const _flushStartIndex = startIndex;
        const _flushPrevMmd = prevMmdFile!;
        (async () => {
          try {
            const allEntries = await readAllOffloadEntries(stateManager.ctx);
            const residualEntries: typeof allEntries = [];
            for (let idx = 0; idx < allEntries.length && idx < _flushStartIndex; idx++) {
              const e = allEntries[idx];
              if ((e.node_id === null || e.node_id === "wait") && !(e.tool_call ?? "").includes("HEARTBEAT.md")) {
                residualEntries.push(e);
              }
            }
            if (residualEntries.length === 0) return;

            // Build a synthetic entriesByMmd for the old mmd only
            // 中文：为旧的mmd构建合成entriesByMmd
            const residualByMmd = new Map<string, typeof residualEntries>();
            residualByMmd.set(_flushPrevMmd, residualEntries);

            logger.debug?.(
              `[context-offload] L1.5 task-switch flush: ${residualEntries.length} residual null entries (idx<${_flushStartIndex}) for old mmd=${_flushPrevMmd}, triggering forced L2`,
            );
            await runL2WithBackend(stateManager, residualByMmd, "task_switch_flush");
          } catch (flushErr) {
            logger.warn(`[context-offload] L1.5 task-switch flush failed: ${flushErr}`);
          }
        })().catch(() => {});
      }

      // Push boundary based on L1.5 result
      // 中文：基于L1.5结果推送边界
      const activeMmdFile = stateManager.getActiveMmdFile();
      if (activeMmdFile) {
        stateManager.pushBoundary({ startIndex, result: "long", targetMmd: activeMmdFile });
        logger.debug?.(`[context-offload] L1.5 boundary: long @${startIndex} → ${activeMmdFile}`);
      } else {
        stateManager.pushBoundary({ startIndex, result: "short", targetMmd: null });
        logger.debug?.(`[context-offload] L1.5 boundary: short @${startIndex}`);
      }

      await stateManager.save();
      stateManager.setMmdInjectionReady(true);
      stateManager.l15Settled = true;
      logger.debug?.("[context-offload] L1.5: settled, MMD injection ready");
      return true;
    } catch (err) {
      logger.warn(`[context-offload] L1.5 attempt failed: ${err}`);
      return false;
    }
  };

  const judgeL15 = async (stateManager: OffloadStateManager, event: any, ctx: any): Promise<void> => {
    if (!backendClient) return;
    stateManager.l15Settled = false;

    // Flush only the pairs that existed BEFORE this user message
    // 中文：仅刷新在此之前存在的配对
    const snapshotCount = stateManager.getPendingCount();
    if (snapshotCount > 0) {
      try {
        await flushL1(stateManager, "l15_pre_flush", false, snapshotCount);
      } catch (err) {
        logger.warn(`[context-offload] L1.5 pre-flush failed: ${err}`);
      }
    }

    // Record the dividing line: entries after this index belong to this turn
    // 中文：记录分界线：此索引后的条目属于本轮
    const startIndex = stateManager.entryCounter;
    logger.debug?.(`[context-offload] L1.5 boundary startIndex=${startIndex} (pending flushed=${snapshotCount})`);

    // First attempt
    // 中文：第一次尝试
    if (await attemptL15(stateManager, startIndex)) return;

    // Single retry after delay (fire-and-forget)
    // 中文：延迟后单次重试（投射式）
    const retry = async () => {
      await new Promise((r) => setTimeout(r, L15_RETRY_DELAY_MS));
      if (_l15Disposed || stateManager.l15Settled) return;
      logger.debug?.("[context-offload] L1.5 retrying... (1/1)");
      if (await attemptL15(stateManager, startIndex)) return;
      // Both attempts failed — activate fail-safe
      // 中文：两次尝试均失败——激活应急措施
      logger.warn("[context-offload] L1.5 FAILED after 1 retry, activating fail-safe");
      await _l15FailSafe(stateManager, startIndex);
    };
    retry().catch(() => {});
  };

  // ─── Backend-aware L2 trigger helper ───────────────────────────────────────
  // 中文：─── 后端感知的L2触发辅助器 ───────────────────────────────────────
  const runL2WithBackend = async (stateManager: OffloadStateManager, entriesByMmd: Map<string, any[]>, triggerSource: string): Promise<void> => {
    if (!backendClient) return;
    try {
      for (const [mmdFile, mmdEntries] of entriesByMmd) {
        const taskLabel = mmdFile.replace(/^\d+-/, "").replace(/\.mmd$/, "") || "unnamed-task";
        const prefixMatch = mmdFile.match(/^(\d+)-/);
        const mmdPrefix = prefixMatch ? prefixMatch[1] : "000";

        // Split entries into batches to avoid oversized requests
        // 中文：将条目分批处理以避免请求过大
        const batches: any[][] = [];
        for (let i = 0; i < mmdEntries.length; i += L2_BATCH_SIZE) {
          batches.push(mmdEntries.slice(i, i + L2_BATCH_SIZE));
        }
        logger.debug?.(`[context-offload] L2 (${triggerSource}): mmd=${mmdFile}, ${mmdEntries.length} entries → ${batches.length} batch(es) of ≤${L2_BATCH_SIZE}`);

        for (let bIdx = 0; bIdx < batches.length; bIdx++) {
          const batch = batches[bIdx];
          const batchWaitIds = new Set(batch.map((e: any) => e.tool_call_id as string));

          // Read fresh MMD for each batch (previous batch may have updated it)
          // 中文：为每个批次读取新鲜的MMD（前一批次可能已更新它）
          const existingMmd = await readMmd(stateManager.ctx, mmdFile);

          const req: L2Request = {
            existingMmd,
            newEntries: batch.map((e: any) => ({
              tool_call_id: e.tool_call_id,
              tool_call: e.tool_call,
              summary: e.summary,
              timestamp: e.timestamp,
            })),
            recentHistory: stateManager.cachedRecentHistory || null,
            currentTurn: stateManager.cachedLatestTurnMessages || null,
            taskLabel,
            mmdPrefix,
            mmdCharCount: existingMmd ? existingMmd.length : 0,
          };

          // Mark batch entries as "wait" before calling backend
          // 中文：在调用后端之前标记批次条目为"wait"
          const allEntries = await readAllOffloadEntries(stateManager.ctx);
          let changed = false;
          for (const entry of allEntries) {
            if (batchWaitIds.has(entry.tool_call_id) && entry.node_id === null) {
              entry.node_id = "wait";
              changed = true;
            }
          }
          if (changed) await rewriteAllOffloadEntries(stateManager.ctx, allEntries);
          if (bIdx === 0) {
            stateManager.setLastL2TriggerTime(nowChinaISO());
            await stateManager.save();
          }

          try {
            const resp = await backendClient.l2Generate(req);

            // Handle backend degraded response (empty fileAction = LLM unavailable)
            // 中文：处理后端降级响应（空fileAction = LLM不可用）
            if (!resp.fileAction) {
              logger.warn(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length}: degraded response, applying fallback backfill`);
              await backfillNodeIds(stateManager.ctx, resp.nodeMapping ?? {}, batchWaitIds, logger, {
                mmdFallbackText: existingMmd ?? "",
                mmdPrefix,
              });
              continue;
            }

            // Apply MMD file changes
            // 中文：应用MMD文件更改
            if (resp.fileAction === "replace" && resp.replaceBlocks && resp.replaceBlocks.length > 0) {
              const patchOk = await patchMmd(stateManager.ctx, mmdFile, resp.replaceBlocks);
              logger.debug?.(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length}: patchMmd: ${patchOk ? "ok" : "FAILED"} (${resp.replaceBlocks.length} blocks)`);
              if (!patchOk && resp.mmdContent) {
                await writeMmd(stateManager.ctx, mmdFile, resp.mmdContent);
                logger.debug?.(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length}: fallback writeMmd: ${resp.mmdContent.length} chars`);
              }
            } else if (resp.mmdContent) {
              await writeMmd(stateManager.ctx, mmdFile, resp.mmdContent);
              logger.debug?.(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length}: writeMmd: ${resp.mmdContent.length} chars`);
            }

            // Backfill node_ids
            // 中文：回填node_ids
            const mmdAfterWrite = await readMmd(stateManager.ctx, mmdFile);
            const mmdForBackfill =
              typeof mmdAfterWrite === "string" && mmdAfterWrite.trim().length > 0
                ? mmdAfterWrite
                : typeof existingMmd === "string" && existingMmd.trim().length > 0
                  ? existingMmd
                  : "";
            await backfillNodeIds(stateManager.ctx, resp.nodeMapping ?? {}, batchWaitIds, logger, {
              mmdFallbackText: mmdForBackfill,
              mmdPrefix,
            });

            logger.debug?.(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length} (${triggerSource}): applied, action=${resp.fileAction}, mapping=${Object.keys(resp.nodeMapping ?? {}).length}`);
          } catch (err) {
            logger.error(`[context-offload] L2 [${mmdFile}] batch ${bIdx + 1}/${batches.length} failed: ${err}`);
            // Continue with remaining batches — failed entries stay as "wait" for retry
            // 中文：继续处理剩余批次——失败的条目保持为"wait"以供重试
          }
        }
      }
    } catch (err) {
      logger.error(`[context-offload] L2 failed: ${err}`);
    }
  };

  // ─── Backend-aware L4 skill helper ─────────────────────────────────────────
  // 中文：───────── 后端感知的L4技能辅助函数 ───────────────────────────────────────
  const createSkillWithBackend = async (
    stateManager: OffloadStateManager,
    skillCommand: { mmdName: string | null; skillFocus: string | null },
  ): Promise<any> => {
    if (!backendClient || !skillCommand.mmdName) return null;
    try {
      // Read MMD + offload entries locally, send to backend
      // 中文：本地读取MMD + offload条目，发送给后端
      const allMmds = await listMmds(stateManager.ctx);
      const mmdFilename = allMmds.find((f) => f.includes(skillCommand.mmdName!)) ?? null;
      if (mmdFilename) {
        const mmdContent = await readMmd(stateManager.ctx, mmdFilename);
        if (mmdContent) {
          const allEntries = await readAllOffloadEntries(stateManager.ctx);
          const nodeIdPattern = /\b(\d{3}-N\d+)\b/g;
          const nodeIds = new Set<string>();
          let match: RegExpExecArray | null;
          while ((match = nodeIdPattern.exec(mmdContent)) !== null) {
            nodeIds.add(match[1]);
          }
          const filtered = allEntries.filter((e) => e.node_id && nodeIds.has(e.node_id));
          const resp = await (backendClient as any).l4Generate({
            mmdFilename,
            mmdContent,
            offloadEntries: filtered,
            skillFocus: skillCommand.skillFocus,
          });
          if (!resp) return null;
          // Write skill file locally
          // 中文：本地写技能文件
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const skillsDir = join(stateManager.ctx.dataDir, "skills", resp.skillName);
          await mkdir(skillsDir, { recursive: true });
          await writeFile(join(skillsDir, "SKILL.md"), resp.skillContent, "utf-8");
          const resultPrompt = `<l4_skill_result>\n【Skill 生成完成】\n\n**Skill 名称:** ${resp.skillName}\n**描述:** ${resp.skillDescription}\n**文件路径:** ${join(skillsDir, "SKILL.md")}\n\n---\n${resp.skillContent}\n---\n</l4_skill_result>`;
          return { appendSystemContext: resultPrompt, phase: "completed", skillName: resp.skillName };
        }
      }
    } catch (err) {
      logger.error(`[context-offload] Backend L4 failed: ${err}`);
    }
    return null;
  };

  // Resolve context window — prioritize model's actual contextWindow from openclaw.json
  // 中文：解析上下文窗口——优先从openclaw.json中获取模型的实际contextWindow
  const getContextWindow = (): number => {
    try {
      const config = api.config;
      const agents = config?.agents;
      const defaults = agents?.defaults;
      const defaultModel = typeof defaults?.model === "string"
        ? defaults.model
        : (typeof defaults?.model === "object" && typeof (defaults?.model as any)?.primary === "string")
          ? (defaults.model as any).primary
          : null;
      const models = config?.models;
      // 1. If we know the model, find its exact contextWindow from providers
      // 中文：1. 如果知道模型，从providers中找到其确切的contextWindow
      if (defaultModel && models) {
        const [providerKey, modelId] = defaultModel.split("/", 2);
        const provider = models.providers?.[providerKey];
        if (provider?.models) {
          const modelList = Array.isArray(provider.models) ? provider.models : [];
          for (const m of modelList) {
            if (m.id === modelId && typeof m.contextWindow === "number") return m.contextWindow;
          }
        }
      }
      // 2. Fallback: top-level models.contextWindow
      // 中文：2. 回退：顶级模型的contextWindow
      if (models?.contextWindow && typeof models.contextWindow === "number") return models.contextWindow;
      // NOTE: fallback 3 (scan all providers) was removed — it could return
      // contextWindow from an unrelated model (e.g. 262144 from Claude-3.5
      // when the active model is GPT with 200000).
      // 中文：注意：回退3（扫描所有providers）已被移除——它可能会返回与当前模型无关的contextWindow（例如，当活动模型为GPT（200000），而contextWindow来自Claude-3.5（262144）时）
    } catch { /* ignore */ }
    // 中文：忽略
    // 3. Plugin config fallback
    // 中文：3. 插件配置回退
    if (typeof pCfg.defaultContextWindow === "number" && pCfg.defaultContextWindow > 0) {
      return pCfg.defaultContextWindow;
    }
    return PLUGIN_DEFAULTS.defaultContextWindow;
  };

  // Track last active manager for L2 scheduler (L2 is global, needs any session's ctx to read agent-shared files)
  // 中文：追踪L2调度器（L2全局，需要任何会话的ctx来读取代理共享文件）
  let _lastActiveMgr: OffloadStateManager | null = null;

  /** Helper: resolve session manager and update last-active tracking */
  /** 中文：Helper: 解决会话管理并更新最后活跃跟踪 */
  const _resolveSession = async (sessionKey: string, sessionId?: string): Promise<OffloadStateManager | null> => {
    if (!sessionKey) return null;
    const entry = await sessions.resolveIfAllowed(sessionKey, sessionId);
    if (!entry) return null;
    _lastActiveMgr = entry.manager;
    _lastActiveSessionKey = sessionKey;
    return entry.manager;
  };

  // L2 Scheduler — uses module-level state (_l2Running, _l2PollHandle, _l2FirstNotifyAt)
  // Clean up any lingering poll timer from previous registerOffload() call
  // 中文：L2 调度器 — 使用模块级状态 (_l2Running, _l2PollHandle, _l2FirstNotifyAt)
  // 清理之前 registerOffload() 调用遗留的任何轮询定时器
  if (_l2PollHandle !== null) { clearTimeout(_l2PollHandle); _l2PollHandle = null; }
  _l2FirstNotifyAt = null;
  _l2Running = false;

  const l2TimeoutMs = (pCfg.l2TimeoutSeconds ?? PLUGIN_DEFAULTS.l2TimeoutSeconds) * 1000;
  const l2Threshold = pCfg.l2NullThreshold ?? PLUGIN_DEFAULTS.l2NullThreshold;

  const clearL2Poll = () => {
    if (_l2PollHandle !== null) { clearTimeout(_l2PollHandle); _l2PollHandle = null; }
    _l2FirstNotifyAt = null;
  };

  const armL2Poll = () => {
    if (_l2PollHandle !== null) return;
    if (_l2FirstNotifyAt === null) _l2FirstNotifyAt = Date.now();
    const tick = async () => {
      _l2PollHandle = null;
      const mgr = _lastActiveMgr;
      if (!mgr) return;
      // Gate: L2 must wait for L1.5 to settle (task boundary determined)
      // Timeout: if L1.5 hasn't settled after 60s (e.g. no Context Engine / assemble not called),
      // force-settle to unblock L2.
      // 中文：网关：L2 必须等待 L1.5 结束（任务边界由上下文确定）
      // 超时：如果在 60s 内 L1.5 没有结束（例如没有 Context Engine / assemble 被调用），强制结束以解除阻塞 L2。
      if (!mgr.l15Settled) {
        const l15WaitAge = _l2FirstNotifyAt ? Date.now() - _l2FirstNotifyAt : 0;
        if (l15WaitAge > 60_000) {
          mgr.l15Settled = true;
          logger.warn("[context-offload] L2 poll: L1.5 settle timeout (60s), force-settling to unblock L2");
        } else {
          logger.debug?.("[context-offload] L2 poll: waiting for L1.5 to settle, deferring...");
          scheduleNextTick();
          return;
        }
      }
      try {
        const allEntries = await readAllOffloadEntries(mgr.ctx);
        const nullCount = allEntries.filter((e) => e.node_id === null).length;
        if (nullCount === 0) { _l2FirstNotifyAt = null; return; }
        if (_l2Running) { scheduleNextTick(); return; }
        const age = Date.now() - (_l2FirstNotifyAt ?? Date.now());
        if (nullCount >= l2Threshold) {
          _l2FirstNotifyAt = null;
          tryTriggerL2("null_threshold").catch(() => {});
        } else if (age >= l2TimeoutMs) {
          _l2FirstNotifyAt = null;
          tryTriggerL2("timer").catch(() => {});
        } else {
          scheduleNextTick();
        }
      } catch {
        scheduleNextTick();
      }
    };
    const scheduleNextTick = () => {
      if (_l2PollHandle !== null) return;
      _l2PollHandle = setTimeout(tick, 5000);
      if (_l2PollHandle && typeof _l2PollHandle === "object" && "unref" in _l2PollHandle) {
        (_l2PollHandle as any).unref();
      }
    };
    _l2PollHandle = setTimeout(tick, 0);
    if (_l2PollHandle && typeof _l2PollHandle === "object" && "unref" in _l2PollHandle) {
      (_l2PollHandle as any).unref();
    }
  };

  const notifyL2NewNullEntries = (newNullCount: number) => {
    if (!_lastActiveMgr || newNullCount <= 0) return;
    armL2Poll();
  };

  const tryTriggerL2 = async (triggerSource = "unknown") => {
    if (_l2Running) return;
    const mgr = _lastActiveMgr;
    if (!mgr) return;
    // Set _l2Running BEFORE any await to prevent concurrent triggers
    // 中文：在任何 await 之前设置 _l2Running 以防并发触发
    _l2Running = true;
    try {
      const { shouldTrigger, reason, entriesByMmd } = await checkL2Trigger(mgr, pCfg, logger);
      if (!shouldTrigger) return;
      const totalEntries = Array.from(entriesByMmd.values()).reduce((s, a) => s + a.length, 0);
      logger.debug?.(`[context-offload] L2 triggered (${triggerSource}): ${reason}, ${totalEntries} entries across ${entriesByMmd.size} mmd(s)`);
      await runL2WithBackend(mgr, entriesByMmd, triggerSource);
    } catch (err) {
      logger.error(`[context-offload] L2 trigger error: ${err}`);
    } finally {
      _l2Running = false;
      try {
        const postEntries = await readAllOffloadEntries(mgr.ctx);
        const postNullCount = postEntries.filter((e) => e.node_id === null).length;
        if (postNullCount >= l2Threshold) {
          clearL2Poll();
          tryTriggerL2("post_completion").catch(() => {});
        } else if (postNullCount > 0) {
          clearL2Poll();
          armL2Poll();
        } else {
          clearL2Poll();
        }
      } catch {
        armL2Poll();
      }
    }
  };

  // ─── Register Hooks ────────────────────────────────────────────────────────
  //
  // api.on() in OpenClaw 4.1 is a direct wrapper around registerTypedHook():
  //   (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts, hookPolicy)
  //
  // NOTE: api.registerHook() is a different API that requires a `name` field
  // on the handler — do NOT use it here (causes "hook registration missing name").
  //
  // 中文：─── 注册钩子 ────────────────────────────────────────────────────────
  // OpenClaw 4.1 中的 api.on() 是 registerTypedHook() 的直接包装器：
  // (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts, hookPolicy)
  // 注意：api.registerHook() 是一个不同的 API，需要在处理器上添加 `name` 字段 — 不要在这里使用它（会导致“钩子注册缺少名称”错误）。
  const _hookNames: string[] = [];
  const _trackedOn = (hookName: string, handler: (...args: any[]) => any) => {
    _hookNames.push(hookName);
    if (typeof api.on === "function") {
      api.on(hookName, (...args: any[]) => {
        if (_contextEngineRejected) return; // slot not acquired — all offload disabled
        // 中文：未获取slot——所有卸载功能禁用
        return handler(...args);
      });
    } else {
      logger.error(`[context-offload] api.on not available for hook "${hookName}"! Hook will not fire.`);
    }
  };

  // before_tool_call
  // 中文：before_tool_call
  _trackedOn("before_tool_call", async (event: any, ctx: any) => {
    const sk = ctx?.sessionKey;
    if (!sk) return;
    const mgr = await _resolveSession(sk, ctx?.sessionId);
    if (!mgr) return;
    const toolCallId = event.toolCallId ?? ctx.toolCallId;
    if (toolCallId && event.params != null) {
      mgr.cacheToolParams(toolCallId, event.params);
    }
  });

  // after_tool_call
  // 中文：after_tool_call
  _trackedOn("after_tool_call", async (event: any, ctx: any) => {
    const _atcStart = Date.now();
    const _toolName = event.toolName ?? "unknown";
    const _toolCallId = event.toolCallId ?? "N/A";
    logger.debug?.(`[context-offload] >>> after_tool_call START: tool=${_toolName} id=${_toolCallId}`);
    try {
      const sk = ctx?.sessionKey;
      const _mgr = sk ? await _resolveSession(sk, ctx?.sessionId) : _lastActiveMgr;
      if (!_mgr) {
        logger.debug?.(`[context-offload] <<< after_tool_call SKIP: no session manager (${Date.now() - _atcStart}ms)`);
        return;
      }
      const afterToolCallHandler = createAfterToolCallHandler(_mgr, logger, getContextWindow, pCfg, backendClient as any);
      await afterToolCallHandler(event, ctx);
      const _handlerDone = Date.now();
      logger.debug?.(`[context-offload] after_tool_call handler done: ${_handlerDone - _atcStart}ms`);

      const pending = _mgr.getPendingCount();
      const threshold = pCfg.forceTriggerThreshold ?? 4;
      if (shouldForceL1(_mgr, pCfg)) {
        logger.debug?.(`[context-offload] L1 TRIGGERED: pending=${pending} >= threshold=${threshold}, flushing...`);
        flushL1(_mgr, "force_threshold", true).then(async () => {
          try {
            const allEntries = await readAllOffloadEntries(_mgr.ctx);
            const nullCount = allEntries.filter((e) => e.node_id === null).length;
            notifyL2NewNullEntries(nullCount);
          } catch { /* ignore */ }
          // 中文：ignore
        }).catch(() => {});
      } else {
        logger.debug?.(`[context-offload] L1 pending: ${pending}/${threshold} (not yet)`);
      }
      logger.debug?.(`[context-offload] <<< after_tool_call END: tool=${_toolName} total=${Date.now() - _atcStart}ms`);
    } catch (err) {
      logger.error(`[context-offload] <<< after_tool_call ERROR: tool=${_toolName} ${err} (${Date.now() - _atcStart}ms)`);
    }
  });

  // llm_output — simplified for backend mode (just logs pending count)
  // 中文：llm_output — 为后端模式简化（仅记录待处理计数）
  _trackedOn("llm_output", async (event: any, ctx: any) => {
    const sk = ctx?.sessionKey;
    const mgr = sk ? sessions.get(sk)?.manager : _lastActiveMgr;
    if (!mgr) return;
    const pendingCount = mgr.getPendingCount();
    if (pendingCount > 0) {
      logger.debug?.(
        `[context-offload] llm_output: ${pendingCount} pending tool pairs (will be flushed at next llm_input or after_tool_call batch)`,
      );
    }
  });

  // llm_input (token cache + L2 context cache only — L1.5 is triggered exclusively from assemble)
  // 中文：llm_input (仅缓存token + L2上下文缓存 — L1.5仅从assemble触发)
  _trackedOn("llm_input", async (event: any, _ctx: any) => {
    const _llmInputStart = Date.now();
    if (isInternalMemorySession(_ctx?.sessionKey)) return;
    logger.debug?.(`[context-offload] >>> llm_input START`);
    const _sk = _ctx?.sessionKey;
    const _mgr = _sk ? await _resolveSession(_sk, _ctx?.sessionId) : _lastActiveMgr;
    if (!_mgr) return;
    try {
      const historyMessages = Array.isArray(event.historyMessages) ? event.historyMessages : [];
      const sysPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : null;
      const promptText = typeof event.prompt === "string" ? event.prompt : null;
      _mgr.cachedSystemPrompt = sysPrompt;
      _mgr.cachedUserPrompt = promptText;

      const snap = buildTiktokenContextSnapshot("llm_input", historyMessages, sysPrompt, promptText);
      _mgr.cachedSystemPromptTokens = snap.systemTokens;
      _mgr.cachedUserPromptTokens = snap.userPromptTokens;
      if (snap.systemTokens > 0) {
        _mgr.setEstimatedSystemOverhead(snap.systemTokens);
        if (_mgr.isLoaded()) _mgr.save().catch(() => {});
      }

      if (historyMessages.length > 0) {
        _mgr.cachedLatestTurnMessages = _extractLatestTurn(historyMessages, promptText);
        _mgr.cachedRecentHistory = _extractRecentHistory(historyMessages, promptText);
      }

      logger.debug?.(`[context-offload] <<< llm_input END: ${Date.now() - _llmInputStart}ms`);
    } catch (err) {
      logger.error(`[context-offload] <<< llm_input ERROR: ${err} (${Date.now() - _llmInputStart}ms)`);
    }
  });

  // before_agent_start (L4 + session fallback)
  // 中文：before_agent_start (L4 +会话回退)
  const l4State = { pendingResult: null as any };
  _trackedOn("before_agent_start", async (event: any, ctx: any) => {
    if (isInternalMemorySession(ctx?.sessionKey)) return;
    const sk = ctx?.sessionKey;
    const mgr = sk ? await _resolveSession(sk, ctx?.sessionId) : null;
    if (!mgr) return;
    const userPrompt = event.prompt ?? "";
    const skillCommand = parseCreateSkillCommand(userPrompt);
    if (skillCommand) {
      try {
        const result = await createSkillWithBackend(mgr, skillCommand);
        if (result?.appendSystemContext) l4State.pendingResult = result;
      } catch { /* ignore */ }
      // 中文：ignore
    }
  });

  // before_prompt_build — primary hook for Responses API (gateway HTTP mode).
  //
  // OpenClaw's Responses API (/v1/responses) does NOT invoke the Context Engine
  // lifecycle (bootstrap → assemble → afterTurn). Only the pi-embedded-runner
  // (CLI/terminal mode) calls context engine methods.
  //
  // This hook provides the SAME functionality as OffloadContextEngine.assemble():
  //   1. L1.5 task judgment (fire-and-forget)
  //   2. L1 flush (fire-and-forget)
  //   3. Fast-path re-apply (confirmed/deleted offload replacements)
  //   4. L3 compression (aggressive/mild/emergency)
  //   5. MMD injection
  //
  // When assemble() IS called (CLI mode), it sets a per-turn flag so this hook
  // skips redundant work.
  // In "collect" mode: only L1 flush, skip L3 compression and MMD injection.
  // 中文：before_prompt_build — 主要hook for Responses API（网关HTTP模式）。
  // OpenClaw的Responses API (/v1/responses) 不调用Context Engine
  // 生命周期（启动 → 组装 → afterTurn）。只有pi-嵌入式运行器
  // (CLI/终端模式) 调用context engine方法。
  // 此hook提供与OffloadContextEngine.assemble()相同的功能：
  // 1. L1.5任务判断（即发即忘）
  // 2. L1刷新（即发即忘）
  // 3. 快速路径重应用（确认/删除卸载替换）
  // 4. L3压缩（激进/温和/紧急）
  // 5. MMD注入
  // 当assemble() 被调用（CLI模式），它设置一个每回合标志，使此hook跳过冗余工作。
  // 在“收集”模式下：仅触发L1刷新，跳过L3压缩和MMD注入。
  _trackedOn("before_prompt_build", async (event: any, ctx: any) => {
    if (isInternalMemorySession(ctx?.sessionKey)) return;
    const sk = ctx?.sessionKey;
    const mgr = sk ? await _resolveSession(sk, ctx?.sessionId) : _lastActiveMgr;
    if (!mgr) return;

    // L1 flush (fire-and-forget)
    // 中文：L1刷新（即发即忘）
    if (mgr.getPendingCount() > 0) {
      flushL1(mgr, "before_prompt_build_flush", true).then(async () => {
        try {
          const allEntries = await readAllOffloadEntries(mgr.ctx);
          const nullCount = allEntries.filter((e: any) => e.node_id === null).length;
          if (nullCount > 0) notifyL2NewNullEntries(nullCount);
        } catch { /* ignore */ }
        // 中文：ignore
      }).catch(() => {});
    }

    // In collect mode: trigger L1.5 (fire-and-forget) then skip L3 compression
    // 中文：在收集模式下: 触发L1.5（即发即忘），然后跳过L3压缩
    if (offloadConfig.mode === "collect") {
      // L1.5 task judgment — same logic as assemble, fire-and-forget
      // 中文：L1.5任务判断 — 与assemble相同的逻辑，即发即忘
      const _prompt = typeof event?.prompt === "string" ? event.prompt : null;
      if (_prompt && _prompt.length > 0 && backendClient) {
        const promptHash = simpleHash(_prompt);
        const lastHash = mgr.lastL15PromptHash;
        if (promptHash !== lastHash) {
          mgr.lastL15PromptHash = promptHash;
          mgr.l15Settled = false;
          judgeL15(mgr, { prompt: _prompt, messages: event.messages ?? [] }, { sessionKey: ctx?.sessionKey }).catch((err) => {
            logger.warn(`[context-offload] collect L1.5 judge failed: ${err}`);
          });
        }
      }
      return;
    }

    // Fast-path re-apply + L3 compression + MMD injection
    // 中文：快速路径重应用 + L3压缩 + MMD注入
    const bpbHandler = createBeforePromptBuildHandler(mgr, logger, getContextWindow, pCfg);
    await bpbHandler(event, ctx);
  });

  // ─── Register Context Engine ───────────────────────────────────────────────
  // 中文：─── 注册Context Engine ───────────────────────────────────────────────
  logger.debug?.(`[context-offload] [DIAG] Hooks registered via api.on: [${_hookNames.join(", ")}] (${_hookNames.length} total)`);

  // In "collect" mode: skip Context Engine entirely, use legacy compaction.
  // L1/L1.5/L2 still run async but L3 is disabled.
  // 中文："collect"模式下: 完全跳过Context Engine，使用legacy压缩。
  // L1/L1.5/L2仍然异步运行但L3被禁用。
  if (offloadConfig.mode === "collect") {
    const _configSlotCE = (api.config as any)?.plugins?.slots?.contextEngine;
    if (_configSlotCE === "memory-tencentdb") {
      logger.warn(`[context-offload] Mode "collect" but slots.contextEngine="${_configSlotCE}". Context Engine will NOT be registered in collect mode - consider removing the slot or switching to mode "backend".`);
    }
    logger.info(`[context-offload] Mode "collect": L3 disabled, context engine NOT registered (using legacy compaction). L1/L1.5/L2 active.`);
    // Force L1.5 settled so L2 poll doesn't block forever
    // 中文：强制L1.5完成以防止L2轮询永远阻塞
    if (_lastActiveMgr) (_lastActiveMgr as any).l15Settled = true;
    // Start reclaim scheduler if needed, then skip to end
    // 中文：如果需要，则启动回收调度器，然后跳转到结束
    _contextEngineRegistered = true; // prevent future registration attempts
    // 中文：防止未来的注册尝试
  } else {
  // ─── Normal mode: register Context Engine ─────────────────────────────────
  // 中文：─── 正常模式: 注册Context Engine ─────────────────────────────────
  const engineOpts = {
    sessions, logger, pCfg, getContextWindow, dataRoot,
    notifyL2NewNullEntries, clearL2Timeout: clearL2Poll, l4State,
    flushL1, backendClient, judgeL15,
    disposeL15: () => { _l15Disposed = true; },
  };

  // Singleton pattern: create engine once, update on subsequent calls.
  // OpenClaw's registerContextEngine() only succeeds on the FIRST call for
  // a given id. But only the LAST register() invocation produces live hooks.
  // So we hot-update the singleton engine's internal refs on every call.
  // 中文：单例模式: 仅创建一次引擎，在后续调用中更新。
  // OpenClaw的registerContextEngine()仅在给定id的第一个调用中成功。但只有最后一次register()调用会产生有效的hook。
  // 因此，我们在每次调用时都会热更新单例引擎的内部引用。
  if (!_sharedEngine) {
    _sharedEngine = new OffloadContextEngine(engineOpts);
  } else {
    _sharedEngine.update(engineOpts);
    logger.debug?.("[context-offload] Context engine singleton updated with latest closures");
  }
  const engine = _sharedEngine;

  if (!_contextEngineRegistered) {
    // Pre-check: verify config slots.contextEngine points to this plugin.
    // If the slot is configured for another engine (e.g. "legacy"), we must NOT
    // register — even if api.registerContextEngine() would return ok:true,
    // the framework won't actually call our assemble(), causing L1.5 to never settle.
    // 中文：预检查: 验证config slots.contextEngine指向此插件。
    // 如果槽位配置为另一个引擎（例如"legacy"），我们即使api.registerContextEngine()返回ok:true，
    // 框架也不会实际调用我们的assemble()方法，导致L1.5永远无法完成。
    const CE_PLUGIN_ID = "memory-tencentdb";
    const configSlotCE = (api.config as any)?.plugins?.slots?.contextEngine;
    if (configSlotCE !== CE_PLUGIN_ID) {
      logger.warn(`[context-offload] Config plugins.slots.contextEngine="${configSlotCE ?? "(not set)"}" (expected "${CE_PLUGIN_ID}"). Context engine slot not assigned to this plugin - ALL offload functions disabled.`);
      _contextEngineRejected = true;
      return;
    }

    // First registration — actually register with the framework
    // 中文：首次注册 —— 实际上向框架进行注册
    let ceSlotOccupied = false;
    try {
      const result = api.registerContextEngine(CE_PLUGIN_ID, () => engine) as any;
      if (result && result.ok === false) {
        logger.error(`[context-offload] registerContextEngine returned { ok: false, existingOwner: ${result.existingOwner ?? "?"} }. Context engine slot occupied — ALL offload functions disabled!`);
        ceSlotOccupied = true;
      } else {
        _contextEngineRegistered = true;
        logger.debug?.("[context-offload] Context engine registered successfully (first call)");
      }
    } catch (ceErr) {
      logger.warn(`[context-offload] registerContextEngine factory failed: ${ceErr}, trying direct object`);
      try {
        const result2 = api.registerContextEngine(CE_PLUGIN_ID, engine) as any;
        if (result2 && result2.ok === false) {
          logger.error(`[context-offload] registerContextEngine direct returned { ok: false }. Context engine slot occupied — ALL offload functions disabled!`);
          ceSlotOccupied = true;
        } else {
          _contextEngineRegistered = true;
          logger.debug?.("[context-offload] Context engine registered successfully (direct mode)");
        }
      } catch (ceErr2) {
        logger.error(`[context-offload] registerContextEngine direct also failed: ${ceErr2}. ALL offload functions disabled!`);
        ceSlotOccupied = true;
      }
    }
    if (ceSlotOccupied) {
      _contextEngineRejected = true;
      logger.error("[context-offload] Offload module DISABLED: context engine slot occupied by another plugin. All hooks will be no-ops.");
      return; // Early exit — do not start reclaim scheduler either
      // 中文：提前退出——也不要启动回收调度器
    }
  } else {
    logger.debug?.("[context-offload] Context engine already registered, singleton updated (hot-refresh)");
  }
  } // end else (non-collect mode)
  // 中文：结束else（非收集模式）

  // ─── Reclaim Scheduler ──────────────────────────────────────────────────────
  // Clean up any lingering reclaim timer from previous registerOffload() call
  // 中文：─── 回收调度器 ──────────────────────────────────────────────────────
  // 清理之前registerOffload()调用遗留的回收定时器
  if (_reclaimTimer !== null) { clearTimeout(_reclaimTimer); _reclaimTimer = null; }

  const _retentionDays = offloadConfig.offloadRetentionDays;
  const _logMaxSizeMb = offloadConfig.logMaxSizeMb;
  if (_retentionDays >= 3) {
    const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 min after startup
    // 中文：启动后5分钟
    const RECLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

    const scheduleReclaim = (delayMs: number) => {
      _reclaimTimer = setTimeout(async () => {
        try {
          const stats = await reclaimOffloadData(dataRoot, {
            retentionDays: _retentionDays,
            logMaxSizeMb: _logMaxSizeMb,
          }, logger);
          logger.debug?.(
            `[context-offload] Reclaim done: jsonl=${stats.deletedJsonl}, refs=${stats.deletedRefs}, ` +
            `mmds=${stats.deletedMmds}, logs=${stats.truncatedLogs}, registry=${stats.prunedRegistryEntries}`,
          );
        } catch (err) {
          logger.warn(`[context-offload] Reclaim failed: ${err}`);
        }
        scheduleReclaim(RECLAIM_INTERVAL_MS);
      }, delayMs);
      if (_reclaimTimer && typeof _reclaimTimer === "object" && "unref" in _reclaimTimer) {
        (_reclaimTimer as any).unref();
      }
    };
    scheduleReclaim(INITIAL_DELAY_MS);
    logger.debug?.(`[context-offload] Reclaim scheduler started: retentionDays=${_retentionDays}, logMaxSizeMb=${_logMaxSizeMb}`);
  }

  logger.debug?.("[context-offload] Offload module registration complete.");
}

// ─── OffloadContextEngine ────────────────────────────────────────────────────
// 中文：─── OffloadContextEngine ────────────────────────────────────────────────────

class OffloadContextEngine {
  private _sessions: SessionRegistry;
  private _logger: PluginLogger;
  private _pCfg: Partial<PluginConfig>;
  private _getContextWindow: () => number;
  private _notifyL2NewNullEntries: (count: number) => void;
  private _clearL2Timeout: () => void;
  private _l4State: { pendingResult: any };
  private _flushL1: (mgr: OffloadStateManager, triggerSource: string, fireAndForget?: boolean, maxCount?: number) => Promise<void>;
  private _backendClient: BackendClient | null;
  private _judgeL15: (mgr: OffloadStateManager, event: any, ctx: any) => Promise<void>;
  private _disposeL15: () => void;

  constructor(opts: any) {
    this.update(opts);
  }

  /**
   * Hot-update all internal references. Called on every registerOffload()
   * invocation so the singleton engine always delegates to the LATEST
   * closures (hooks, sessions, flushL1, etc.) produced by the most recent
   * register() call — which is the only one whose hooks are actually live.
   * 中文：热更新所有内部引用。每次调用registerOffload()时都会被调用，以确保单例引擎总是委托给最近的register()调用产生的最新闭包（钩子、会话、flushL1等）。
   */
  update(opts: any): void {
    this._sessions = opts.sessions;
    this._logger = opts.logger;
    this._pCfg = opts.pCfg;
    this._getContextWindow = opts.getContextWindow;
    this._notifyL2NewNullEntries = opts.notifyL2NewNullEntries;
    this._clearL2Timeout = opts.clearL2Timeout;
    this._l4State = opts.l4State;
    this._flushL1 = opts.flushL1;
    this._backendClient = opts.backendClient;
    this._judgeL15 = opts.judgeL15;
    this._disposeL15 = opts.disposeL15 ?? (() => {});
  }

  get info() {
    return { id: "openclaw-context-offload", name: "Context Offload Engine", version: "0.7.0", ownsCompaction: true };
  }

  async bootstrap(params: any) {
    const { sessionId, sessionKey } = params;
    const logger = this._logger;
    logger.debug?.(`[context-offload] >>> CE.bootstrap CALLED: sessionKey=${sessionKey}, sessionId=${sessionId?.slice(0, 12)}...`);
    if (isInternalMemorySession(sessionKey)) {
      logger.debug?.(`[context-offload] bootstrap SKIP: internal memory session (${sessionKey})`);
      return { bootstrapped: false, reason: "internal_memory_session" };
    }
    try {
      if (sessionKey) {
        const entry = await this._sessions.resolveIfAllowed(sessionKey, sessionId);
        if (entry) {
          // Attach per-session manager to params for assemble/afterTurn
          // 中文：为assemble/afterTurn附加会话管理器
          params._offloadManager = entry.manager;
        }
      }
      return { bootstrapped: true };
    } catch (err) {
      return { bootstrapped: false, reason: String(err) };
    }
  }

  async ingest(params: any) {
    const { message } = params;
    if (!message) return { ingested: false };
    const role = message.role ?? message.message?.role;
    if (role === "toolResult" || role === "tool") {
      const toolCallId = message.toolCallId ?? message.tool_call_id ?? message.message?.toolCallId ?? message.message?.tool_call_id;
      if (toolCallId) {
        let mgr: OffloadStateManager | undefined = params._offloadManager;
        if (!mgr && params.sessionKey) {
          mgr = this._sessions.get(params.sessionKey)?.manager;
        }
        if (mgr) mgr.processedToolCallIds.add(toolCallId);
        return { ingested: true };
      }
    }
    return { ingested: false };
  }

  async assemble(params: any) {
    const { messages, tokenBudget, prompt } = params;
    const logger = this._logger;
    logger.debug?.(`[context-offload] assemble CALLED: msgs=${messages?.length ?? 0}, budget=${tokenBudget ?? "N/A"}, prompt=${typeof prompt === "string" ? prompt.length + " chars" : "none"}, sessionKey=${params.sessionKey ?? "?"}`);
    // Resolve stateManager: prefer params._offloadManager (set by bootstrap),
    // then fall back to SessionRegistry resolve (framework may pass different params objects).
    // 中文：解析stateManager：优先选择params._offloadManager（由bootstrap设置），然后退而求其次使用SessionRegistry解析（框架可能会传递不同的params对象）。
    let stateManager: OffloadStateManager | undefined = params._offloadManager;
    if (!stateManager && params.sessionKey) {
      try {
        const entry = await this._sessions.resolveIfAllowed(params.sessionKey, params.sessionId);
        if (entry) {
          stateManager = entry.manager;
          params._offloadManager = entry.manager; // cache for compact/afterTurn
          // 中文：缓存用于紧凑/结束后转
          logger.debug?.(`[context-offload] assemble: resolved manager from SessionRegistry for ${params.sessionKey}`);
        }
      } catch (err) {
        logger.warn(`[context-offload] assemble: failed to resolve session ${params.sessionKey}: ${err}`);
      }
    }
    const pCfg = this._pCfg;

    if (!stateManager) {
      logger.debug?.(`[context-offload] assemble SKIP: no stateManager (sessionKey=${params.sessionKey ?? "none"})`);
      return { messages: messages ? [...messages] : [], estimatedTokens: 0 };
    }

    const workMessages = messages ? [...messages] : [];
    const _asmStart = Date.now();
    logger.debug?.(`[context-offload] assemble START: msgCount=${workMessages.length}, budget=${tokenBudget ?? "N/A"}, pending=${stateManager.getPendingCount()}, confirmed=${stateManager.confirmedOffloadIds?.size ?? 0}, deleted=${stateManager.deletedOffloadIds?.size ?? 0}`);

    // Cache prompt early so _buildL1RecentContext() has it when L1.5 fires
    // (assemble runs before llm_input, which is where cachedUserPrompt was previously set)
    // 中文：早期缓存提示，以便_buildL1RecentContext()在L1.5触发时可以获取到它（assemble运行在llm_input之前，这是以前cachedUserPrompt被设置的地方）
    if (typeof prompt === "string" && prompt.length > 0) {
      stateManager.cachedUserPrompt = prompt;
    }

    if (workMessages.length > 0) {
      stateManager.cachedLatestTurnMessages = _extractLatestTurn(workMessages, prompt);
      stateManager.cachedRecentHistory = _extractRecentHistory(workMessages, prompt);
    }

    try {

      // L1.5 task judgment — fire-and-forget (sole trigger point)
      // 中文：L1.5任务判断 —— 立即执行（唯一的触发点）
      if (!prompt || typeof prompt !== "string" || prompt.length === 0) {
        logger.debug?.(`[context-offload] assemble L1.5 SKIP: no prompt (prompt=${typeof prompt}, len=${prompt?.length ?? 0})`);
      } else if (!this._backendClient) {
        logger.debug?.(`[context-offload] assemble L1.5 SKIP: no backendClient`);
      } else {
        const promptHash = simpleHash(prompt);
        const lastHash = stateManager.lastL15PromptHash;
        if (promptHash === lastHash) {
          logger.debug?.(`[context-offload] assemble L1.5 SKIP: same prompt hash (${promptHash}), l15Settled=${stateManager.l15Settled}`);
        } else {
          stateManager.lastL15PromptHash = promptHash;
          stateManager.l15Settled = false;
          logger.debug?.(`[context-offload] assemble L1.5 TRIGGERED: new prompt hash (${promptHash}), l15Settled=false (reset), activeMmd=${stateManager.getActiveMmdFile() ?? "null"}`);
          this._judgeL15(
            stateManager,
            { prompt, messages: workMessages },
            { sessionKey: stateManager.getLastSessionKey() },
          ).catch((err) => {
            logger.warn(`[context-offload] assemble L1.5 judge failed: ${err}`);
          });
        }
      }

      // L1 flush is now handled inside judgeL15 (l15_pre_flush) before
      // recording the boundary startIndex. No separate flush needed here.
      // 中文：L1刷新现在由judgeL15 (l15_pre_flush)内部处理，在记录起始边界startIndex之前。这里不需要单独的刷新。

      // ── Raw token snapshot BEFORE fast-path re-apply ──
      // This captures what the framework originally passed in, before any offload
      // replacements. Crucial for understanding the delta between after_tool_call
      // and assemble traces.
      // Use the same sys tokens basis as L3 compression to ensure consistent comparisons.
      // 中文：── 原生令牌快照，快路径重新应用前 ──
      // 此内容捕获框架最初传递的内容，未经过任何卸载替换。对于理解after_tool_call和assemble跟踪之间的差异至关重要。
      // 使用与L3压缩相同的系统令牌基础以确保一致的比较
      const _rawMsgCountBeforeFP = workMessages.length;
      // Use fast estimate for raw token count (only used for logging/tracing, not for compression decisions)
      // 中文：使用快速估算进行原始令牌计数（仅用于日志记录/跟踪，不用于压缩决策)
      const _rawMsgTokens = fastEstimateMessages(workMessages);

      // Fast-path re-apply
      // 中文：快速路径重新应用
      const hasConfirmed = stateManager.confirmedOffloadIds?.size > 0;
      const hasDeleted = stateManager.deletedOffloadIds?.size > 0;
      let offloadEntries: any[] | null = null;
      let offloadMap: Map<string, any> | null = null;
      let _fpReplacedCount = 0;
      let _fpDeletedCount = 0;
      let _fpCompressedCount = 0;

      // ── FP-BOUNDARY-DELETE: fast head-delete based on last aggressive boundary ──
      // After aggressive deletes N messages from the head, the framework replays
      // the full history next time (including those already-deleted messages).
      // We record the boundary message's index + fingerprint after aggressive,
      // then on next assemble we verify the boundary is still at the same position
      // with the same content and splice everything before it.
      // 中文：── FP-BOUNDARY-DELETE: 基于上次激进边界进行快速头部删除 ──
      // 在激进删除N条消息后，框架下次会重放完整历史记录（包括已删除的消息）。
      // 我们记录激进删除后的边界消息索引+指纹，在下次组装时验证边界是否仍处于相同位置且内容一致，然后将之前的所有内容进行拼接
      const _boundary = stateManager._lastAggressiveBoundary;
      let _fpBoundaryDeleted = 0;
      if (_boundary && prompt && prompt.length > 0
          && workMessages.length > _boundary.originalIndex && _boundary.originalIndex > 0) {
        const candidateMsg = workMessages[_boundary.originalIndex];
        if (_msgFingerprint(candidateMsg) === _boundary.fingerprint) {
          let headDeleteEnd = _boundary.originalIndex;
          // Forward: if the boundary message itself is a toolResult, extend to consume
          // all consecutive toolResults (their tool_use is in the delete zone).
          // 中文：前向：如果边界消息本身是toolResult，则扩展以消耗所有连续的toolResults（它们的tool_use在删除区域中）
          while (headDeleteEnd < workMessages.length && isToolResultMessage(workMessages[headDeleteEnd])) {
            headDeleteEnd++;
          }
          // Backward: if the last kept message before cut is assistant(tool_use),
          // its tool_results may be right after the cut — include them in deletion.
          // (This shouldn't happen since aggressive guarantees clean cuts, but safety.)
          // 中文：后向：如果剪切前保留的最后一条消息是assistant(tool_use)，其后的tool_results可能就在剪切处——包括它们在内的删除操作。
          // （这不应该发生，因为激进删除保证了干净的切割，但为了安全起见）
          if (headDeleteEnd > 0 && headDeleteEnd < workMessages.length) {
            const lastDeleted = workMessages[headDeleteEnd - 1];
            if (isAssistantMessageWithToolUse(lastDeleted)) {
              // Extend to include following toolResults that belong to this tool_use
              // 中文：扩展以包含属于此tool_use的后续toolResults
              while (headDeleteEnd < workMessages.length && isToolResultMessage(workMessages[headDeleteEnd])) {
                headDeleteEnd++;
              }
            }
          }
          // Don't delete everything
          // 中文：不要删除一切
          if (headDeleteEnd > 0 && headDeleteEnd < workMessages.length) {
            workMessages.splice(0, headDeleteEnd);
            _fpDeletedCount += headDeleteEnd;
            _fpBoundaryDeleted = headDeleteEnd;
            logger.debug?.(`[context-offload] assemble FP-BOUNDARY-DELETE: spliced ${headDeleteEnd} old msgs (boundaryIdx=${_boundary.originalIndex}, was=${workMessages.length + headDeleteEnd}, now=${workMessages.length})`);
          }
        } else {
          // Fingerprint mismatch — boundary invalid, clear it
          // 中文：指纹不匹配 — 边界无效，清除它
          logger.debug?.(`[context-offload] assemble FP-BOUNDARY-DELETE: fingerprint mismatch at idx=${_boundary.originalIndex}, skipping (expected=${_boundary.fingerprint}, got=${_msgFingerprint(candidateMsg)})`);
          stateManager._lastAggressiveBoundary = null;
        }
      }

      if (hasConfirmed || hasDeleted) {
        offloadEntries = await readOffloadEntries(stateManager.ctx);
        offloadMap = new Map();
        populateOffloadLookupMap(offloadMap, offloadEntries);
        stateManager.setCachedOffloadMap(offloadMap);

        const indicesToDelete: number[] = [];
        for (let i = 0; i < workMessages.length; i++) {
          const msg = workMessages[i];
          const tid = extractToolCallId(msg);
          const tidNorm = tid ? normalizeToolCallIdForLookup(tid) : null;
          if (tid && hasDeleted && (stateManager.deletedOffloadIds.has(tid) || (tidNorm && stateManager.deletedOffloadIds.has(tidNorm)))) {
            indicesToDelete.push(i); _fpDeletedCount++; continue;
          }
          if (hasDeleted && isOnlyToolUseAssistant(msg)) {
            const tuIds = extractAllToolUseIds(msg);
            if (tuIds.length > 0 && tuIds.every((id) => stateManager.deletedOffloadIds.has(id) || stateManager.deletedOffloadIds.has(normalizeToolCallIdForLookup(id)))) {
              indicesToDelete.push(i); _fpDeletedCount++; continue;
            }
          }
          // FIX: For mixed assistant messages (text + tool_use), strip deleted tool_use
          // blocks to prevent orphaned tool_use without matching tool_result (Anthropic 400).
          // 中文：FIX: 对混合助手消息（文本 + 工具使用），移除被删除的工具使用块以防止孤立的工具使用没有匹配的工具结果（Anthropic 400）.
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
            if (entry && isToolResultMessage(msg)) { replaceWithSummary(msg, entry); msg._offloaded = true; _fpReplacedCount++; }
          }
          if (isOnlyToolUseAssistant(msg)) {
            const tuIds = extractAllToolUseIds(msg);
            const allConfirmed = tuIds.length > 0 && tuIds.every((id) => stateManager.confirmedOffloadIds.has(id) || stateManager.confirmedOffloadIds.has(normalizeToolCallIdForLookup(id)));
            if (allConfirmed) {
              const tuEntries = tuIds.map((id) => getOffloadEntry(offloadMap!, id)).filter(Boolean) as any[];
              if (tuEntries.length === tuIds.length) { replaceAssistantToolUseWithSummary(msg, tuEntries); msg._offloaded = true; _fpCompressedCount++; }
            }
          } else if (isAssistantMessageWithToolUse(msg)) {
            compressNonCurrentToolUseBlocks(msg, offloadMap, new Set(), stateManager.confirmedOffloadIds);
          }
        }
        if (indicesToDelete.length > 0) {
          for (let k = indicesToDelete.length - 1; k >= 0; k--) workMessages.splice(indicesToDelete[k], 1);
        }
      }

      // ── Post fast-path summary ──
      // 中文：── 后快速路径总结 ──
      const _fpMsgCountAfter = workMessages.length;
      logger.debug?.(`[context-offload] assemble FAST-PATH: rawMsgTokens≈${_rawMsgTokens} (${_rawMsgCountBeforeFP} msgs) → ` +
        `replaced=${_fpReplacedCount} toolResults, compressed=${_fpCompressedCount} assistants, deleted=${_fpDeletedCount} msgs → ` +
        `${_fpMsgCountAfter} msgs remaining, confirmed=${stateManager.confirmedOffloadIds?.size ?? 0}, deleted=${stateManager.deletedOffloadIds?.size ?? 0}`,
      );

      // Active MMD injection is now handled by after_tool_call hook (which has
      // access to event.messages after the openclaw patch). The hook checks
      // L1.5 settled status and reads the latest MMD content (reflecting L2 updates).
      // assemble no longer injects active MMD — it only handles L3 compression
      // and history MMD injection (AGGRESSIVE).
      // 中文：当前活动MMD注入由after_tool_call挂钩处理（该钩子在openclaw补丁后可访问event.messages）。该钩子检查L1.5稳定状态并读取最新的MMD内容（反映L2更新）。assemble不再注入活动的MMD — 它仅处理L3压缩和历史MMD注入（AGGRESSIVE）.

      // L3 compression
      // 中文：L3压缩
      const contextWindow = this._getContextWindow();
      // Use the smaller of framework budget and model context window to avoid overflow.
      // 中文：使用框架预算和模型上下文窗口中较小的一个以避免溢出。
      const effectiveBudget = tokenBudget ? Math.min(tokenBudget, contextWindow) : contextWindow;
      const mildRatio = pCfg.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio;
      const aggressiveRatio = pCfg.aggressiveCompressRatio ?? PLUGIN_DEFAULTS.aggressiveCompressRatio;
      const mildThreshold = Math.floor(effectiveBudget * mildRatio);
      const aggressiveThreshold = Math.floor(effectiveBudget * aggressiveRatio);

      // Include system prompt tokens in all token calculations.
      // assemble() doesn't receive systemPrompt directly, so use cached/estimated value.
      // 中文：在所有令牌计算中包含系统提示令牌。assemble()未直接接收systemPrompt，因此使用缓存/估算值。
      const _sysFromCache = stateManager.cachedSystemPromptTokens;
      const _sysFromOverhead = stateManager.getEstimatedSystemOverhead();
      const _sysFromRatio = Math.floor(effectiveBudget * (pCfg.defaultSystemOverheadRatio ?? PLUGIN_DEFAULTS.defaultSystemOverheadRatio));
      const systemTokensEstimate = _sysFromCache ?? _sysFromOverhead ?? _sysFromRatio;
      const _sysSource = _sysFromCache != null ? "cachedSystemPromptTokens" : _sysFromOverhead != null ? "estimatedSystemOverhead" : "defaultRatio";
      logger.debug?.(`[context-offload] assemble sys tokens: estimate=${systemTokensEstimate} (source=${_sysSource}, cache=${_sysFromCache ?? "null"}, overhead=${_sysFromOverhead ?? "null"}, ratio=${_sysFromRatio})`,
      );
      const precomputed = { systemTokens: systemTokensEstimate, userPromptTokens: 0 };

      // _rawTokensBefore uses the same sys basis as L3 compression for consistent comparisons
      // 中文：_rawTokensBefore 使用与L3压缩相同的sys基础以便一致的比较
      const _rawTokensBefore = _rawMsgTokens + systemTokensEstimate;

      // ── Fast estimate: skip tiktoken when clearly below threshold ──
      // Use fast character-based estimation (~5ms) instead of tiktoken (~3-10s).
      // Only trigger precise tiktoken when estimate is near compression thresholds.
      // 中文：── 快速估计：当明显低于阈值时跳过tiktoken ──
      const _fastEstStart = Date.now();
      const fastEst = fastEstimateMessages(workMessages) + systemTokensEstimate + (prompt ? Math.ceil(prompt.length / 4) : 0);
      const _fastEstMs = Date.now() - _fastEstStart;
      const FAST_EST_SAFETY_MARGIN = 0.85; // 15% safety margin for estimation error
      // 中文：15% 安全余量以供估算误差

      let workingTokens: number;
      let snap: ReturnType<typeof buildTiktokenContextSnapshot> | null = null;
      let _usedFastPath = false;

      // ── Incremental estimation: if boundary-delete fired and we have cached
      // aggressive results, estimate tokens incrementally from new messages only.
      // This avoids tiktoken entirely for the common case of 1-2 new messages.
      // 中文：── 增量估算：如果边界删除触发且我们有缓存的激进结果，则仅从新消息增量估算令牌。这避免了在常见情况下（1-2条新消息）完全使用tiktoken。
      const _boundaryCache = stateManager._lastAggressiveBoundary;
      const BOUNDARY_NEW_MSG_TOLERANCE = 20; // max new messages before forcing full recount
      // 中文：在强制全面重算之前的最大新消息数
      if (_fpBoundaryDeleted > 0 && _boundaryCache
          && workMessages.length <= _boundaryCache.keptMsgCount + BOUNDARY_NEW_MSG_TOLERANCE
          && _boundaryCache.remainingTokens < aggressiveThreshold) {
        // Estimate: last aggressive tokens + new messages token delta
        // 中文：估算：上次激进令牌 + 新消息令牌差值
        const newMsgCount = Math.max(0, workMessages.length - _boundaryCache.keptMsgCount);
        const newMsgTokens = newMsgCount > 0
          ? fastEstimateMessages(workMessages.slice(workMessages.length - newMsgCount)) + (prompt ? Math.ceil(prompt.length / 4) : 0)
          : (prompt ? Math.ceil(prompt.length / 4) : 0);
        const incrementalEst = _boundaryCache.remainingTokens + newMsgTokens;
        if (incrementalEst < aggressiveThreshold) {
          workingTokens = incrementalEst;
          _usedFastPath = true;
          logger.debug?.(`[context-offload] assemble BOUNDARY-INCR-SKIP: incremental≈${incrementalEst} (base=${_boundaryCache.remainingTokens}+new=${newMsgTokens}, newMsgs=${newMsgCount}) < aggressive@${aggressiveThreshold}, skipping tiktoken`);
        } else {
          // Incremental estimate exceeds threshold — need precise tiktoken
          // 中文：增量估算超过阈值 — 需要精确的tiktoken
          snap = buildTiktokenContextSnapshot("assemble", workMessages, null, prompt ?? null, precomputed);
          workingTokens = snap.totalTokens;
          logger.debug?.(`[context-offload] assemble L3 check (boundary-incr exceeded): total≈${workingTokens} (incr-est was ${incrementalEst}), msgs=${workMessages.length}, aggressive@${aggressiveThreshold}`);
        }
      } else if (fastEst < aggressiveThreshold * FAST_EST_SAFETY_MARGIN) {
        // Below aggressive threshold — use estimate for mild/skip decisions.
        // Mild only replaces tool results with summaries (no precise token math needed).
        // Only aggressive needs precise tiktoken (to compute exact delete count).
        // 中文：低于激进阈值 — 使用估算进行温和/跳过决策。仅温和替换工具结果为摘要（不需要精确的令牌计算）。只有激进需要精确的tiktoken（用于计算确切删除数量）
        workingTokens = fastEst;
        _usedFastPath = true;
        logger.debug?.(`[context-offload] assemble L3 FAST-SKIP: fastEst≈${fastEst} < ${Math.floor(aggressiveThreshold * FAST_EST_SAFETY_MARGIN)} (${(FAST_EST_SAFETY_MARGIN * 100).toFixed(0)}% aggressive), ` +
          `budget=${effectiveBudget}, msgs=${workMessages.length}, fastEstMs=${_fastEstMs}ms`,
        );
      } else if (!stateManager._lastAggressiveBoundary && prompt && prompt.length > 0) {
        // No boundary + has prompt + clearly above threshold → skip full tiktoken.
        // TAIL-ACCUMULATE will do its own precise calculation from the tail.
        // 中文：没有边界 + 有提示 + 清楚超出阈值 → 跳过完整tiktoken。TAIL-ACCUMULATE将从尾部进行自己的精确计算，然后丢弃头部。
        workingTokens = fastEst;
        logger.debug?.(`[context-offload] assemble L3 TAIL-ACCUM-PENDING: fastEst≈${fastEst} (no boundary, will tail-accumulate), skipping full tiktoken`);
      } else {
        // Near/above aggressive threshold — do precise tiktoken
        // 中文：接近/超过激进阈值 — 进行精确的tiktoken
        snap = buildTiktokenContextSnapshot("assemble", workMessages, null, prompt ?? null, precomputed);
        workingTokens = snap.totalTokens;
        logger.debug?.(`[context-offload] assemble L3 check: total≈${workingTokens} (sys≈${systemTokensEstimate}, msgs≈${snap.messagesTokens}, user≈${snap.userPromptTokens}), ` +
          `budget=${effectiveBudget} (contextWindow=${contextWindow}, tokenBudget=${tokenBudget ?? "N/A"}), ` +
          `utilisation=${((workingTokens / effectiveBudget) * 100).toFixed(1)}%, mild@${mildThreshold}, aggressive@${aggressiveThreshold}, msgs=${workMessages.length}, fastEst=${fastEst}, fastEstMs=${_fastEstMs}ms`,
        );
      }

      let _aggDeletedCount = 0;
      let _aggRounds = 0;
      let _aggDeletedIds: string[] = [];
      let _aggTokensBefore = workingTokens;
      let _aggTokensAfter = workingTokens;
      let _aggDurationMs = 0;
      let _aggMmdInjected = 0;
      let _aggMmdTokens = 0;
      if (workingTokens >= aggressiveThreshold) {
        // ── TAIL-ACCUMULATE: when no boundary cache exists (first run), compute
        // tokens from tail until reaching 60% of budget, then discard the head.
        // This avoids the expensive full-tiktoken + multi-round aggressive loop.
        // 中文：── TAIL-ACCUMULATE：当不存在边界缓存（首次运行）时，从尾部计算令牌直到达到预算的60%，然后丢弃头部。这避免了昂贵的完整tiktoken + 多轮激进循环。
        const TAIL_ACCUM_TARGET_RATIO = 0.60;
        const tailAccumTarget = Math.floor(effectiveBudget * TAIL_ACCUM_TARGET_RATIO) - systemTokensEstimate;
        if (!stateManager._lastAggressiveBoundary && workMessages.length > 0 && prompt && prompt.length > 0) {
          const _tailStart = Date.now();
          let accum = 0;
          let keepFrom = 0; // will keep [keepFrom ... end]
          // 中文：将保留 [keepFrom ... end]
          for (let i = workMessages.length - 1; i >= 0; i--) {
            const msgTokens = tiktokenCount(JSON.stringify(workMessages[i], jsonReplacer));
            if (accum + msgTokens > tailAccumTarget) {
              keepFrom = i + 1;
              break;
            }
            accum += msgTokens;
          }
          // Tool-pair safety: extend keepFrom forward to not orphan toolResults
          // 中文：工具对安全性：将keepFrom向前扩展以防止孤儿toolResults
          while (keepFrom < workMessages.length && isToolResultMessage(workMessages[keepFrom])) {
            accum += tiktokenCount(JSON.stringify(workMessages[keepFrom], jsonReplacer));
            keepFrom++;
          }
          // Tool-pair safety (backward): if last deleted msg is assistant(tool_use),
          // its tool_results are in the keep zone — extend deletion to include them
          // 中文：工具对安全（回退）：如果上次删除的消息是assistant(tool_use)，
          // 其tool_results处于保留区——扩展删除范围以包括它们
          if (keepFrom > 0 && keepFrom < workMessages.length) {
            const lastDeleted = workMessages[keepFrom - 1];
            if (isAssistantMessageWithToolUse(lastDeleted)) {
              while (keepFrom < workMessages.length && isToolResultMessage(workMessages[keepFrom])) {
                accum += tiktokenCount(JSON.stringify(workMessages[keepFrom], jsonReplacer));
                keepFrom++;
              }
            }
          }
          // User message protection: don't cut past the last user message
          // (ensure the most recent user turn is always kept)
          // 中文：用户消息保护：不要切断最后一个用户消息
          // (确保最近一次用户回合总是被保留)
          for (let u = workMessages.length - 1; u >= keepFrom; u--) {
            const role = workMessages[u].role ?? workMessages[u].message?.role ?? workMessages[u].type;
            if (role === "user" || role === "human") {
              // Found last user msg in keep zone — good
              // 中文：在保留区内找到最后一个用户消息 —— 好的
              break;
            }
            if (u === keepFrom) {
              // No user message in keep zone — find the last one and adjust keepFrom
              // 中文：没有用户消息在保留区内 —— 找到最后一个并调整keepFrom
              for (let u2 = keepFrom - 1; u2 >= 0; u2--) {
                const r2 = workMessages[u2].role ?? workMessages[u2].message?.role ?? workMessages[u2].type;
                if (r2 === "user" || r2 === "human") {
                  keepFrom = u2;
                  break;
                }
              }
            }
          }
          // Minimum keep: always keep at least 10 messages
          // 中文：最小保留：始终至少保留10条消息
          const MIN_KEEP = 10;
          if (workMessages.length - keepFrom < MIN_KEEP) {
            keepFrom = Math.max(0, workMessages.length - MIN_KEEP);
          }
          // Don't delete everything
          // 中文：不要删除一切
          if (keepFrom > 0 && keepFrom < workMessages.length) {
            // Collect deleted tool call IDs for offload tracking
            // 中文：收集已删除工具调用ID以进行卸载跟踪
            const tailDeletedIds: string[] = [];
            for (let d = 0; d < keepFrom; d++) {
              const msg = workMessages[d];
              const tid = extractToolCallId(msg) ?? (isOnlyToolUseAssistant(msg) ? extractAllToolUseIds(msg)[0] : null);
              if (tid) tailDeletedIds.push(tid);
            }
            workMessages.splice(0, keepFrom);
            _aggDeletedCount = keepFrom;
            _aggDeletedIds = tailDeletedIds;
            workingTokens = accum + systemTokensEstimate;
            _aggTokensAfter = workingTokens;
            _aggDurationMs = Date.now() - _tailStart;
            logger.info(`[context-offload] assemble TAIL-ACCUMULATE: kept ${workMessages.length} msgs from tail, deleted ${keepFrom} from head, tokens≈${workingTokens}, target=${tailAccumTarget}+sys=${systemTokensEstimate}, duration=${_aggDurationMs}ms`);
            // Mark deleted IDs
            // 中文：标记已删除的ID
            if (tailDeletedIds.length > 0) {
              const statusUpdates = new Map<string, string | boolean>();
              for (const id of tailDeletedIds) { statusUpdates.set(id, "deleted"); stateManager.confirmedOffloadIds.add(id); stateManager.deletedOffloadIds.add(id); }
              markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
            }
            // Record boundary
            // 中文：边界记录
            const boundaryFp = _msgFingerprint(workMessages[0]);
            let boundaryOrigIdx = -1;
            for (let bi = 0; bi < messages.length; bi++) {
              if (_msgFingerprint(messages[bi]) === boundaryFp) {
                if (bi + 1 < messages.length && workMessages.length > 1) {
                  if (_msgFingerprint(messages[bi + 1]) === _msgFingerprint(workMessages[1])) {
                    boundaryOrigIdx = bi; break;
                  }
                } else {
                  boundaryOrigIdx = bi; break;
                }
              }
            }
            if (boundaryOrigIdx >= 0) {
              stateManager._lastAggressiveBoundary = {
                originalIndex: boundaryOrigIdx,
                fingerprint: boundaryFp,
                keptMsgCount: workMessages.length,
                remainingTokens: workingTokens,
              };
              logger.info(`[context-offload] assemble TAIL-ACCUMULATE BOUNDARY recorded: idx=${boundaryOrigIdx}, kept=${workMessages.length}, tokens≈${workingTokens}`);
            }
          }
        } else {
          // Has boundary cache — use standard aggressive path
          // 中文：存在边界缓存——使用标准激进路径
          logger.debug?.(`[context-offload] assemble L3-AGGRESSIVE: tokens≈${workingTokens} >= ${aggressiveThreshold}, starting...`);
          if (!offloadEntries) { offloadEntries = await readOffloadEntries(stateManager.ctx); offloadMap = new Map(); populateOffloadLookupMap(offloadMap!, offloadEntries); }
          const countTokens = createL3TokenCounter(pCfg, logger);
          const aggressiveDeleteRatio = (pCfg as any).aggressiveDeleteRatio ?? PLUGIN_DEFAULTS.aggressiveDeleteRatio;
          const currentTaskNodeIds = await getCurrentTaskNodeIds(stateManager);
          const _aggStart = Date.now();
          // aggressiveThreshold includes systemTokensEstimate, but the internal
          // function computes remainingTokens WITHOUT system tokens (sysPrompt=null).
          // Subtract systemTokensEstimate so the comparison is consistent.
          // Target 85% of threshold to leave buffer for subsequent tool loop messages.
          // Without buffer: tokens hover at 109K (threshold=108.8K) → every tool call re-triggers.
          // 中文：aggressiveThreshold 包括 systemTokensEstimate，但内部函数计算剩余令牌时不包含系统令牌（sysPrompt=null）。减去systemTokensEstimate 以使比较一致。目标为阈值的85%以留出缓冲区用于后续工具循环消息。无缓冲区时：令牌徘徊在109K左右（阈值=108.8K）→每次工具调用都会重新触发。
          const AGGRESSIVE_TARGET_RATIO = 0.85;
          const aggressiveTargetForMsgs = Math.max(0, Math.floor(aggressiveThreshold * AGGRESSIVE_TARGET_RATIO) - systemTokensEstimate);
          const result = await aggressiveCompressUntilBelowThreshold(
            workMessages, offloadMap!, currentTaskNodeIds, aggressiveDeleteRatio, stateManager, logger, aggressiveTargetForMsgs, countTokens, null, prompt ?? null,
          );
          _aggDeletedCount = result.deletedCount;
          _aggRounds = result.rounds;
          _aggDeletedIds = result.allDeletedToolCallIds;
          workingTokens = result.remainingTokens + systemTokensEstimate;

          _aggTokensAfter = workingTokens;
          _aggDurationMs = Date.now() - _aggStart;
          logger.debug?.(`[context-offload] assemble L3-AGGRESSIVE done: rounds=${result.rounds}, deleted=${result.deletedCount}, remaining≈${workingTokens} (raw=${result.remainingTokens}+sys=${systemTokensEstimate}), deletedIds=${result.allDeletedToolCallIds.length}, stalledByUserMsg=${result.stalledByUserMsg ?? false}, duration=${_aggDurationMs}ms`);
          if (_aggDurationMs > 10_000) {
            logger.warn(`[context-offload] assemble L3-AGGRESSIVE SLOW: ${_aggDurationMs}ms (rounds=${result.rounds}, deleted=${result.deletedCount}, remaining≈${workingTokens})`);
          }
          // Record boundary for FP-BOUNDARY-DELETE on next replay (only when prompt present)
          // 中文：记录边界以便在下次重放时对FP-BOUNDARY-DELETE进行记录（仅当提示存在时）
          if (result.deletedCount > 0 && workMessages.length > 0 && prompt && prompt.length > 0) {
            const boundaryFp = _msgFingerprint(workMessages[0]);
            // Find the boundary message's position in the original framework input
            // 中文：在原始框架输入中查找边界消息的位置
            let boundaryOrigIdx = -1;
            for (let bi = 0; bi < messages.length; bi++) {
              if (_msgFingerprint(messages[bi]) === boundaryFp) {
                // Verify with next message too to avoid hash collision on duplicate content
                // 中文：与下一个消息验证以避免重复内容的哈希碰撞
                if (bi + 1 < messages.length && workMessages.length > 1) {
                  if (_msgFingerprint(messages[bi + 1]) === _msgFingerprint(workMessages[1])) {
                    boundaryOrigIdx = bi;
                    break;
                  }
                } else {
                  boundaryOrigIdx = bi;
                  break;
                }
              }
            }
            if (boundaryOrigIdx >= 0) {
              stateManager._lastAggressiveBoundary = {
                originalIndex: boundaryOrigIdx,
                fingerprint: boundaryFp,
                keptMsgCount: workMessages.length,
                remainingTokens: workingTokens,
              };
              logger.debug?.(`[context-offload] assemble BOUNDARY recorded: idx=${boundaryOrigIdx}, fp=${boundaryFp}, kept=${workMessages.length}, tokens≈${workingTokens}`);
            } else {
              // Could not locate boundary in original messages — clear stale boundary
              // 中文：未在原始消息中找到边界——清除过期边界
              stateManager._lastAggressiveBoundary = null;
              logger.debug?.(`[context-offload] assemble BOUNDARY: could not locate in original msgs, cleared`);
            }
          }
          if (result.allDeletedToolCallIds.length > 0) {
            const statusUpdates = new Map<string, string | boolean>();
            for (const id of result.allDeletedToolCallIds) { statusUpdates.set(id, "deleted"); stateManager.confirmedOffloadIds.add(id); stateManager.deletedOffloadIds.add(id); }
            markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
            const mmdInj = await buildHistoryMmdInjection(result.allDeletedToolCallIds, offloadMap!, offloadEntries, stateManager, logger, countTokens, effectiveBudget, pCfg);
            if (mmdInj.injectedMessages.length > 0) {
              removeExistingMmdInjections(workMessages);
              const histInsertIdx = findHistoryMmdInsertionPoint(workMessages);
              workMessages.splice(histInsertIdx, 0, ...mmdInj.injectedMessages);
              _aggMmdInjected = mmdInj.injectedMessages.length;
              _aggMmdTokens = mmdInj.totalMmdTokens;
              workingTokens += mmdInj.totalMmdTokens;
              logger.debug?.(`[context-offload] assemble L3-AGGRESSIVE MMD injection: ${mmdInj.injectedMessages.length} msgs, ${mmdInj.totalMmdTokens} tokens, budget=${Math.floor(effectiveBudget * (pCfg.mmdMaxTokenRatio ?? PLUGIN_DEFAULTS.mmdMaxTokenRatio))}, files=[${mmdInj.mmdFiles.join(",")}], workingTokens now=${workingTokens}`);

              // Debug: dump injected MMD message content
              // 中文：调试：转储注入的MMD消息内容
              for (let ii = 0; ii < mmdInj.injectedMessages.length; ii++) {
                const im = mmdInj.injectedMessages[ii] as any;
                let ic = "";
                if (typeof im.content === "string") ic = im.content;
                else if (Array.isArray(im.content)) ic = im.content.map((c: any) => typeof c === "string" ? c : (c.text ?? "")).join(" ");
                const lines = ic.split("\n");
                logger.debug?.(`[context-offload]   MMD-inject[${ii}] role=${im.role}, lines=${lines.length}, preview=${ic.replace(/\n/g, "\\n").slice(0, 200)}${ic.length > 200 ? "..." : ""}`);
              }
            } else {
              logger.debug?.(`[context-offload] assemble L3-AGGRESSIVE MMD injection: no history MMDs to inject`);
            }
          }
          // If aggressive stalled due to user message protection, force emergency
          // 中文：如果激进模式因用户消息保护而停滞，强制紧急处理
          if (result.stalledByUserMsg && workingTokens >= aggressiveThreshold) {
            logger.warn(`[context-offload] assemble L3-AGGRESSIVE stalled, forcing emergency fallback`);
            stateManager._forceEmergencyNext = true;
          }
        } // end else (standard aggressive path)
        // 中文：否则（标准激进路径）
      } else {
        logger.debug?.(`[context-offload] assemble L3-AGGRESSIVE: SKIP (tokens≈${workingTokens} < ${aggressiveThreshold})`);
      }

      // Summary after AGGRESSIVE (was full dump, now aggregated)
      // 中文：激进模式摘要（原为完整导出，现在聚合）
      if (_aggDeletedCount > 0) {
        const mmdCount = workMessages.filter((m: any) => m._mmdContextMessage || m._mmdInjection).length;
        const offloadedCount = workMessages.filter((m: any) => m._offloaded).length;
        logger.debug?.(`[context-offload] POST-AGGRESSIVE: ${workMessages.length} msgs remaining, mmd=${mmdCount}, offloaded=${offloadedCount}, deleted=${_aggDeletedCount}`);
      }

      let _mildReplacedCount = 0;
      let _mildFinalThreshold = 0;
      let _mildDurationMs = 0;
      let _mildTokensBefore = workingTokens;
      let _mildReplacedIds: string[] = [];
      if (workingTokens >= mildThreshold) {
        logger.debug?.(`[context-offload] assemble L3-MILD: tokens≈${workingTokens} >= ${mildThreshold}, starting...`);
        if (!offloadEntries) { offloadEntries = await readOffloadEntries(stateManager.ctx); offloadMap = new Map(); populateOffloadLookupMap(offloadMap!, offloadEntries); }
        const currentTaskNodeIds = await getCurrentTaskNodeIds(stateManager);
        const mildScanRatio = (pCfg as any).mildOffloadScanRatio ?? PLUGIN_DEFAULTS.mildOffloadScanRatio;
        const _mildStart = Date.now();
        const cascadeResult = compressByScoreCascade(workMessages, offloadMap!, currentTaskNodeIds, mildScanRatio, logger);
        _mildReplacedCount = cascadeResult.replacedCount;
        _mildFinalThreshold = cascadeResult.finalThreshold;
        _mildDurationMs = Date.now() - _mildStart;
        _mildReplacedIds = cascadeResult.replacedToolCallIds;
        logger.debug?.(`[context-offload] assemble L3-MILD done: replaced=${cascadeResult.replacedCount}, finalThreshold=${cascadeResult.finalThreshold}, ids=[${cascadeResult.replacedToolCallIds.slice(0, 5).join(",")}${cascadeResult.replacedToolCallIds.length > 5 ? "..." : ""}], duration=${_mildDurationMs}ms`);
        if (cascadeResult.replacedCount > 0) {
          for (const id of cascadeResult.replacedToolCallIds) stateManager.confirmedOffloadIds.add(id);
          const mildUpdates = new Map<string, string | boolean>();
          for (const id of cascadeResult.replacedToolCallIds) mildUpdates.set(id, true);
          markOffloadStatus(stateManager.ctx, mildUpdates).catch(() => {});

          // Summary after MILD replacement (was full dump, now aggregated)
          // 中文：温和模式替换后摘要（原为完整导出，现在聚合）
          const replacedCount = workMessages.filter((m: any) => {
            const c = typeof m.content === "string" ? m.content : "";
            return c.includes("[Offload summary") || c.includes("⚡ offload");
          }).length;
          logger.debug?.(`[context-offload] POST-MILD: ${workMessages.length} msgs, replaced=${replacedCount}`);
        }
      } else {
        logger.debug?.(`[context-offload] assemble L3-MILD: SKIP (tokens≈${workingTokens} < ${mildThreshold})`);
      }

      // Emergency — reuse workingTokens instead of redundant full tiktoken snapshot
      // 中文：紧急情况——重用workingTokens而非冗余的完整tiktoken快照
      const emergencyRatio = pCfg.emergencyCompressRatio ?? PLUGIN_DEFAULTS.emergencyCompressRatio;
      const emergencyTargetRatio = pCfg.emergencyTargetRatio ?? PLUGIN_DEFAULTS.emergencyTargetRatio;
      const emergencyThreshold = Math.floor(effectiveBudget * emergencyRatio);
      const emergencyTarget = Math.floor(effectiveBudget * emergencyTargetRatio);
      let _emDeletedCount = 0;
      let _emTokensBefore = workingTokens;
      let _emTriggered = false;
      const forceEmergency = stateManager._forceEmergencyNext === true;
      if (forceEmergency) stateManager._forceEmergencyNext = false;
      if ((workingTokens >= emergencyThreshold || forceEmergency) && workMessages.length > EMERGENCY_MIN_MESSAGES_TO_KEEP) {
        _emTriggered = true;
        _usedFastPath = false; // force precise finalSnap after emergency
        // 中文：紧急情况后必须强制精确 finalSnap
        logger.warn(`[context-offload] assemble EMERGENCY: tokens≈${workingTokens} >= ${emergencyThreshold} (${(emergencyRatio * 100).toFixed(0)}%), force=${forceEmergency}, target=${emergencyTarget} (${(emergencyTargetRatio * 100).toFixed(0)}%), msgTarget=${emergencyTarget - systemTokensEstimate}`);
        const countTokensEmg = createL3TokenCounter(pCfg, logger);
        const _emStart = Date.now();
        const emResult = emergencyCompress(workMessages, emergencyTarget - systemTokensEstimate, countTokensEmg, null, prompt ?? null, logger);
        _emDeletedCount = emResult.deletedCount;
        workingTokens = emResult.remainingTokens + systemTokensEstimate;
        const _emDurationMs = Date.now() - _emStart;
        if (_emDurationMs > 10_000) {
          logger.warn(`[context-offload] assemble EMERGENCY SLOW: ${_emDurationMs}ms (deleted=${emResult.deletedCount}, remaining≈${workingTokens})`);
        } else {
          logger.debug?.(`[context-offload] assemble EMERGENCY done: deleted=${emResult.deletedCount} msgs, remaining≈${workingTokens} (raw=${emResult.remainingTokens}+sys=${systemTokensEstimate}), deletedIds=${emResult.deletedToolCallIds.length}, duration=${_emDurationMs}ms`);
        }
        if (emResult.deletedToolCallIds.length > 0) {
          const emUpdates = new Map<string, string | boolean>();
          for (const id of emResult.deletedToolCallIds) { emUpdates.set(id, "deleted"); stateManager.confirmedOffloadIds.add(id); stateManager.deletedOffloadIds.add(id); }
          markOffloadStatus(stateManager.ctx, emUpdates).catch(() => {});
        }
        // Re-record boundary after emergency (only when prompt present)
        // 中文：在紧急情况下重新记录边界（仅当存在提示时）
        if (emResult.deletedCount > 0 && workMessages.length > 0 && prompt && prompt.length > 0) {
          const boundaryFp = _msgFingerprint(workMessages[0]);
          let boundaryOrigIdx = -1;
          for (let bi = 0; bi < messages.length; bi++) {
            if (_msgFingerprint(messages[bi]) === boundaryFp) {
              if (bi + 1 < messages.length && workMessages.length > 1) {
                if (_msgFingerprint(messages[bi + 1]) === _msgFingerprint(workMessages[1])) {
                  boundaryOrigIdx = bi; break;
                }
              } else {
                boundaryOrigIdx = bi; break;
              }
            }
          }
          if (boundaryOrigIdx >= 0) {
            stateManager._lastAggressiveBoundary = {
              originalIndex: boundaryOrigIdx,
              fingerprint: boundaryFp,
              keptMsgCount: workMessages.length,
              remainingTokens: workingTokens,
            };
            logger.debug?.(`[context-offload] assemble EMERGENCY BOUNDARY recorded: idx=${boundaryOrigIdx}, kept=${workMessages.length}, tokens≈${workingTokens}`);
          } else {
            stateManager._lastAggressiveBoundary = null;
          }
        }
      } else {
        logger.debug?.(`[context-offload] assemble EMERGENCY: SKIP (tokens≈${workingTokens} < ${emergencyThreshold}, force=${forceEmergency}, msgs=${workMessages.length})`);
      }

      // L4 injection
      // 中文：L4注入
      let systemPromptAddition: string | undefined;
      if (this._l4State.pendingResult?.appendSystemContext) {
        systemPromptAddition = this._l4State.pendingResult.appendSystemContext;
        this._l4State.pendingResult = null;
      }

      const finalSnap = _usedFastPath
        ? { totalTokens: workingTokens, messagesTokens: workingTokens - systemTokensEstimate, systemTokens: systemTokensEstimate, userPromptTokens: 0 }
        : buildTiktokenContextSnapshot("assemble_final", workMessages, null, prompt ?? null, precomputed);
      const tokensBefore = snap?.totalTokens ?? fastEst;
      const tokensSaved = tokensBefore - finalSnap.totalTokens;
      const _asmDuration = Date.now() - _asmStart;
      logger.debug?.(`[context-offload] assemble END (ok): ${messages?.length ?? 0}→${workMessages.length} msgs, rawTokens≈${_rawTokensBefore}, tokensBefore≈${tokensBefore} (FP: -${_rawTokensBefore - tokensBefore}, replaced=${_fpReplacedCount}, compressed=${_fpCompressedCount}, deleted=${_fpDeletedCount}), tokensAfter≈${finalSnap.totalTokens} (sys≈${systemTokensEstimate}), tokensSaved≈${tokensSaved}, totalSaved≈${_rawTokensBefore - finalSnap.totalTokens}, hasL4=${!!systemPromptAddition}, duration=${_asmDuration}ms`);

      // Async trace — fire-and-forget, must not block assemble return
      // 中文：异步跟踪——即发即弃，必须不阻塞组装返回
      try {
        traceOffloadDecision({
          sessionKey: stateManager.getLastSessionKey(),
          stage: "L3.assemble.completed",
          input: {
            messagesBefore: messages?.length ?? 0,
            rawTokensBefore: _rawTokensBefore,
            rawMsgTokens: _rawMsgTokens,
            tokensBefore,
            budget: effectiveBudget,
            contextWindow,
            systemTokensEstimate,
            mildThreshold,
            aggressiveThreshold,
            emergencyThreshold,
            durationMs: _asmDuration,
          },
          output: {
            // Overall
            // 中文：总体
            messagesAfter: workMessages.length,
            messagesRemoved: (messages?.length ?? 0) - workMessages.length,
            tokensAfter: finalSnap.totalTokens,
            tokensSaved,
            totalTokensSaved: _rawTokensBefore - finalSnap.totalTokens,
            utilisation: `${((finalSnap.totalTokens / effectiveBudget) * 100).toFixed(1)}%`,
            utilisationBefore: `${((_rawTokensBefore / effectiveBudget) * 100).toFixed(1)}%`,
            hasL4: !!systemPromptAddition,
            // Fast-path re-apply details
            // 中文：快速路径重试细节
            fastPath: {
              rawTokens: _rawTokensBefore,
              tokensAfterFP: tokensBefore,
              tokensSavedByFP: _rawTokensBefore - tokensBefore,
              replacedToolResults: _fpReplacedCount,
              compressedAssistants: _fpCompressedCount,
              deletedMsgs: _fpDeletedCount,
              confirmedIds: stateManager.confirmedOffloadIds?.size ?? 0,
              deletedIds: stateManager.deletedOffloadIds?.size ?? 0,
            },
            // AGGRESSIVE details
            // 中文：激进模式详情
            aggressive: {
              triggered: _aggDeletedCount > 0,
              tokensBefore: _aggTokensBefore,
              tokensAfter: _aggTokensAfter,
              deletedMsgs: _aggDeletedCount,
              deletedIds: _aggDeletedIds.slice(0, 20),
              rounds: _aggRounds,
              durationMs: _aggDurationMs,
              historyMmdInjected: _aggMmdInjected,
              historyMmdTokens: _aggMmdTokens,
            },
            // MILD details
            // 中文：温和模式详情
            mild: {
              triggered: _mildReplacedCount > 0,
              tokensBefore: _mildTokensBefore,
              replacedCount: _mildReplacedCount,
              finalThreshold: _mildFinalThreshold,
              replacedIds: _mildReplacedIds.slice(0, 20),
              durationMs: _mildDurationMs,
            },
            // EMERGENCY details
            // 中文：紧急模式详情
            emergency: {
              triggered: _emTriggered,
              tokensBefore: _emTokensBefore,
              deletedMsgs: _emDeletedCount,
              forceEmergency,
            },
          },
          logger,
        });
      } catch { /* trace failure must not affect assemble */ }
      // 中文：记录失败不得影响组装

      // Trace messages snapshots — original input vs processed output
      // 中文：跟踪消息快照——原始输入与处理输出对比
      try {
        traceMessagesSnapshot({
          sessionKey: stateManager.getLastSessionKey(),
          stage: "assemble.input",
          messages: messages ?? [],
          label: "original messages (before assemble)",
          extra: {
            rawTokensBefore: _rawTokensBefore,
            budget: effectiveBudget,
            contextWindow,
          },
          logger,
        });
        traceMessagesSnapshot({
          sessionKey: stateManager.getLastSessionKey(),
          stage: "assemble.output",
          messages: workMessages,
          label: "workMessages (after assemble)",
          extra: {
            tokensAfter: finalSnap.totalTokens,
            tokensSaved,
            totalTokensSaved: _rawTokensBefore - finalSnap.totalTokens,
            budget: effectiveBudget,
            hasL4: !!systemPromptAddition,
          },
          logger,
        });
      } catch { /* trace failure must not affect assemble */ }
      // 中文：记录失败不得影响组装

      // Upload plugin state + L3 token accounting to backend /store.
      // 中文：上传插件状态+L3令牌计费至后端/store.
      try {
        const _triggerReason = _rawTokensBefore >= aggressiveThreshold
          ? "above_aggressive"
          : _rawTokensBefore >= mildThreshold
            ? "above_mild"
            : "below_mild";
        const _report = buildL3TriggerReport({
          stage: "assemble",
          triggerReason: _triggerReason,
          stateManager,
          event: { messages: workMessages }, // assemble has its own shape — patch check is n/a here
          // 中文：组装有自己的形态 —— 衴补检查在此无效
          contextWindow,
          mildThreshold,
          aggressiveThreshold,
          tokensBefore: _rawTokensBefore,
          tokensAfter: finalSnap.totalTokens,
          messagesBefore: messages?.length ?? 0,
          messagesAfter: workMessages.length,
          durationMs: _asmDuration,
          aboveMild: _rawTokensBefore >= mildThreshold,
          aboveAggressive: _rawTokensBefore >= aggressiveThreshold,
          mildReplacedCount: _mildReplacedCount,
          aggressiveDeletedCount: _aggDeletedCount,
          emergencyTriggered: _emTriggered,
          emergencyDeletedCount: _emDeletedCount,
        });
        reportL3Trigger(this._backendClient ?? null, _report, logger);
      } catch (reportErr) {
        logger.warn(`[context-offload] assemble L3 state-report build failed: ${reportErr}`);
      }

      return { messages: workMessages, estimatedTokens: finalSnap.totalTokens, systemPromptAddition };
    } catch (err) {
      logger.error(`[context-offload] assemble error: ${err}`);
      if (isTokenOverflowError(err)) stateManager._forceEmergencyNext = true;
      return { messages: workMessages, estimatedTokens: 0 };
    }
  }

  async compact(params: any) {
    const _compactStart = Date.now();
    const logger = this._logger;
    logger.debug?.(`[context-offload] >>> CE.compact CALLED: sessionKey=${params.sessionKey ?? "?"}`);
    let stateManager: OffloadStateManager | undefined = params._offloadManager;
    if (!stateManager && params.sessionKey) {
      try {
        const entry = await this._sessions.resolveIfAllowed(params.sessionKey, params.sessionId);
        if (entry) stateManager = entry.manager;
      } catch { /* ignore */ }
      // 中文：ignore
    }
    const pCfg = this._pCfg;
    logger.debug?.(`[context-offload] >>> compact START: params=${JSON.stringify(params ?? {}).slice(0, 500)}`);
    if (!stateManager) {
      logger.warn(`[context-offload] <<< compact SKIP: no session manager (${Date.now() - _compactStart}ms)`);
      return { ok: false, compacted: false, reason: "no_session_manager" };
    }
    try {
      // Try delegating to runtime's built-in compaction first
      // 中文：首先尝试委托给运行时内置压缩
      let delegateFn: any;
      try {
        const { createRequire } = await import("node:module");
        const globalRequire = createRequire("/usr/local/lib/node_modules/openclaw/");
        const sdk = globalRequire("openclaw/plugin-sdk");
        delegateFn = sdk.delegateCompactionToRuntime;
        logger.debug?.(`[context-offload] compact: resolved via createRequire (global path)`);
      } catch (e1) {
        logger.debug?.(`[context-offload] compact: createRequire failed: ${e1}`);
        try {
          const paths = [
            "/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/index.js",
            "/usr/lib/node_modules/openclaw/dist/plugin-sdk/index.js",
          ];
          for (const p of paths) {
            try {
              const sdk = await import(p);
              delegateFn = sdk.delegateCompactionToRuntime;
              logger.debug?.(`[context-offload] compact: resolved via absolute path: ${p}`);
              break;
            } catch (ep) {
              logger.debug?.(`[context-offload] compact: absolute path failed: ${p} → ${ep}`);
            }
          }
        } catch { /* ignore */ }
        // 中文：ignore
        if (!delegateFn) {
          try {
            const sdk = await import("openclaw/plugin-sdk" as any);
            delegateFn = sdk.delegateCompactionToRuntime;
            logger.debug?.(`[context-offload] compact: resolved via direct import`);
          } catch { /* ignore */ }
          // 中文：ignore
        }
      }

      if (typeof delegateFn === "function") {
        logger.debug?.(`[context-offload] compact: >>> delegateCompactionToRuntime START`);
        const result = await delegateFn(params);
        logger.debug?.(`[context-offload] <<< compact END (delegated) ${Date.now() - _compactStart}ms — compacted=${result.compacted}`);
        return result;
      }

      // Fallback: self-execute emergency compression when runtime delegation unavailable
      // 中文：备用方案：当运行时委托不可用时自我执行紧急压缩
      logger.info(`[context-offload] compact: delegateCompactionToRuntime unavailable, self-executing emergency compression`);
      const messages = params.messages;
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        logger.debug?.(`[context-offload] <<< compact END (no_messages) ${Date.now() - _compactStart}ms`);
        return { ok: true, compacted: false, reason: "no_messages" };
      }

      const contextWindow = this._getContextWindow();
      const budget = params.tokenBudget ? Math.min(params.tokenBudget, contextWindow) : contextWindow;
      const mildRatio = pCfg.mildOffloadRatio ?? PLUGIN_DEFAULTS.mildOffloadRatio;
      const targetTokens = Math.floor(budget * mildRatio);
      const systemTokensEstimate = stateManager.cachedSystemPromptTokens
        ?? stateManager.getEstimatedSystemOverhead()
        ?? Math.floor(budget * (pCfg.defaultSystemOverheadRatio ?? PLUGIN_DEFAULTS.defaultSystemOverheadRatio));

      const countTokens = createL3TokenCounter(pCfg, logger);
      logger.info(`[context-offload] compact: msgs=${messages.length}, target=${targetTokens}, msgTarget=${targetTokens - systemTokensEstimate}`);
      const emergencyResult = emergencyCompress(messages, targetTokens - systemTokensEstimate, countTokens, null, null, logger);

      if (emergencyResult.deletedToolCallIds.length > 0) {
        for (const id of emergencyResult.deletedToolCallIds) {
          stateManager.confirmedOffloadIds.add(id);
          stateManager.confirmedOffloadIds.add(normalizeToolCallIdForLookup(id));
          stateManager.deletedOffloadIds.add(id);
          stateManager.deletedOffloadIds.add(normalizeToolCallIdForLookup(id));
        }
        const statusUpdates = new Map<string, string | boolean>();
        for (const id of emergencyResult.deletedToolCallIds) statusUpdates.set(id, "deleted");
        markOffloadStatus(stateManager.ctx, statusUpdates).catch(() => {});
      }

      // Invalidate assemble boundary cache after compact modifies messages
      // 中文：在compact修改消息后无效化组装边界缓存
      if (emergencyResult.deletedCount > 0) {
        stateManager._lastAggressiveBoundary = null;
      }

      logger.info(`[context-offload] <<< compact END (self_emergency) ${Date.now() - _compactStart}ms — deleted=${emergencyResult.deletedCount} msgs, remaining≈${emergencyResult.remainingTokens}+sys≈${systemTokensEstimate}`);
      return { ok: true, compacted: emergencyResult.deletedCount > 0, reason: "self_emergency", messages };
    } catch (err) {
      logger.error(`[context-offload] <<< compact ERROR: ${err} (${Date.now() - _compactStart}ms)`);
      return { ok: false, compacted: false, reason: String(err) };
    }
  }

  async afterTurn(_params: any) {
    const logger = this._logger;
    logger.debug?.(`[context-offload] >>> CE.afterTurn CALLED: sessionKey=${_params?.sessionKey ?? "?"}`);
    let stateManager: OffloadStateManager | undefined = _params?._offloadManager;
    if (!stateManager && _params?.sessionKey && !isInternalMemorySession(_params.sessionKey)) {
      try {
        const entry = this._sessions.get(_params.sessionKey);
        stateManager = entry?.manager;
      } catch { /* ignore */ }
      // 中文：ignore
    }
    if (!stateManager) return;
    try {
      // Flush remaining pending tool pairs — fire-and-forget to avoid blocking
      // the next turn's assemble(). L1 Lock guarantees data integrity; the next
      // judgeL15's pre_flush will pick up any pairs that haven't been flushed yet.
      // 中文：刷新剩余的待处理工具对——异步执行以避免阻塞下一次组装(). L1锁保证数据完整性；下一个judgeL15的pre_flush将会拾起尚未被刷新的任何对.
      const pendingCount = stateManager.getPendingCount();
      if (pendingCount > 0) {
        logger.debug?.(`[context-offload] afterTurn: fire-and-forget flushing ${pendingCount} remaining pending pairs`);
        this._flushL1(stateManager, "afterTurn_flush").then(async () => {
          try {
            const allEntries = await readAllOffloadEntries(stateManager!.ctx);
            const nullCount = allEntries.filter((e) => e.node_id === null).length;
            if (nullCount > 0) this._notifyL2NewNullEntries(nullCount);
          } catch { /* ignore */ }
          // 中文：ignore
        }).catch((err) => {
          logger.warn(`[context-offload] afterTurn: L1 flush failed: ${err}`);
        });
      }

      if (stateManager.isLoaded()) await stateManager.save();
    } catch { /* ignore */ }
    // 中文：ignore
  }

  async maintain(_params: any) {
    return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
  }

  async dispose() {
    this._logger.debug?.("[context-offload] dispose: cleaning up");
    this._disposeL15();
    this._clearL2Timeout();
    if (_reclaimTimer !== null) { clearTimeout(_reclaimTimer); _reclaimTimer = null; }
  }
}

// ─── Test-only exports (internal functions for unit testing) ────────────────
// 中文：─── 仅用于测试导出（单元测试内部函数） ────────────────
export const _testExports = {
  _isHeartbeatText,
  _extractMsgText,
  _normalizePromptForCompare,
  _extractLatestTurn,
  _extractRecentHistory,
  _buildL1RecentContext,
  _buildL15RecentContext,
  isInternalMemorySession,
  simpleHash,
  OffloadContextEngine,
};
