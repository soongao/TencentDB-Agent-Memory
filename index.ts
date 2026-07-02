/**
 * memory-tdai v3: Four-layer memory system plugin for OpenClaw.
 *
 * Provides:
 * - L0: Automatic conversation recording (local JSONL)
 * - L1: Structured memory extraction (LLM + dedup)
 * - L2: Scene block management (LLM scene extraction)
 * - L3: Persona generation (LLM persona synthesis)
 *
 * All processing is local, zero external API dependencies.
 *
 * v3.1: Refactored to use TdaiCore + OpenClawHostAdapter.
 * index.ts is now a thin shell that:
 * - Registers tools and hooks with OpenClaw
 * - Translates OpenClaw events into TdaiCore calls
 * - Manages prompt caching and metric reporting
 *
 * Core memory logic lives in src/core/tdai-core.ts (host-neutral).
 * 中文：memory-tdai v3: OpenClaw的四层内存系统插件。
 * 提供：
 * - L0: 自动对话记录（本地JSONL）
 * - L1: 结构化记忆提取（LLM + 去重）
 * - L2: 场景块管理（LLM场景提取）
 * - L3: 人物生成（LLM人物合成）
 * 所有处理均为本地，无外部API依赖。
 * v3.1: 重构为使用TdaiCore + OpenClawHostAdapter。
 * index.ts 现在是一个薄壳：
 * - 与OpenClaw注册工具和钩子
 * - 将OpenClaw事件转换为TdaiCore调用
 * - 管理提示缓存和指标报告
 * 核心内存逻辑位于 src/core/tdai-core.ts（主机中立）。
 */

import path from "node:path";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { parseConfig } from "./src/config.js";
import type { MemoryTdaiConfig } from "./src/config.js";
import { initTimeModule, getActiveTimeZone } from "./src/utils/time.js";
import { registerOffload } from "./src/offload/index.js";
import {
  setPreferredEmbeddedAgentRuntime,
  prewarmEmbeddedAgent,
} from "./src/utils/clean-context-runner.js";
import { SessionFilter } from "./src/utils/session-filter.js";
import { LocalMemoryCleaner } from "./src/utils/memory-cleaner.js";
import { registerMemoryTdaiCli } from "./src/cli/index.js";
import { initDataDirectories, resetStores } from "./src/utils/pipeline-factory.js";
import { getOrCreateInstanceId, initReporter, report, resetReporter } from "./src/core/report/reporter.js";
import { ensureL2L3Local } from "./src/core/profile/profile-sync.js";

// Core abstractions (host-neutral)
// 中文：核心抽象（主机中立）
import { OpenClawHostAdapter } from "./src/adapters/openclaw/host-adapter.js";
import { TdaiCore } from "./src/core/tdai-core.js";
import {
  ensurePluginHookPolicy,
  decideHookPolicy,
} from "./src/utils/ensure-hook-policy.js";
import { resolveOpenClawStateDir } from "./src/utils/openclaw-state-dir.js";

const TAG = "[memory-tdai]";

/**
 * Epoch ms when the plugin was registered (cold-start timestamp).
 * Used as a fallback cursor in performAutoCapture when no checkpoint
 * exists yet — prevents the first agent_end from dumping the entire
 * session history into L0.
 * 中文：插件注册时的纪元毫秒时间戳（冷启动时间戳）。
 * 在 performAutoCapture 无检查点时用作备用游标，防止首次 agent_end 将整个会话历史记录全部倒入 L0。
 */
let pluginStartTimestamp = 0;

/**
 * Cache original user prompts and message counts across hooks.
 * - text: clean user prompt before prependContext injection
 * - ts: cache creation time (for TTL sweep)
 * - messageCount: session message count at before_prompt_build time,
 *   used as fallback slice offset if timestamp cursor is unreliable
 * 中文：缓存原始用户提示和消息计数跨钩子。
 * - text: 在 prependContext 注入前的干净用户提示
 * - ts: 缓存创建时间（用于 TTL 清理）
 * - messageCount: before_prompt_build 时会话的消息计数，用作时间戳游标不可靠时的回退切片偏移量
 */
const pendingOriginalPrompts = new Map<string, { text: string; ts: number; messageCount: number }>();
const PROMPT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// 中文：10 minutes
const PROMPT_CACHE_MAX_SIZE = 10_000; // Hard limit to prevent unbounded growth in high-concurrency scenarios
// 中文：硬性限制以防止在高并发场景下无界增长

/**
 * Cache recall results (L1 memories + L3 Persona) from before_prompt_build
 * for retrieval at agent_end, enabling the agent_turn metric event.
 *
 * Keyed by sessionKey — same correlation pattern as pendingOriginalPrompts.
 * 中文：缓存回忆结果（L1记忆 + L3人物）从 before_prompt_build 获取，在 agent_end 时检索，启用 agent_turn 指标事件。
 * 按 sessionKey 键——与 pendingOriginalPrompts 的待处理原始提示相同的关联模式。
 */
const pendingRecallCache = new Map<string, {
  l1Memories: Array<{ content: string; score: number; type: string }>;
  l3Persona: string | null;
  strategy: string;
  durationMs: number;
  ts: number;
}>();

/**
 * Cache recall completion timestamps per session.
 * Used in agent_end to estimate LLM reasoning time:
 *   llmEstimatedMs ≈ agent_end_start - recall_end_ts
 * Entries are cleaned up in agent_end after use; stale entries swept alongside prompt cache.
 * 中文：按会话缓存召回完成时间戳。
 * 用于agent_end估算LLM推理时间：
 * llmEstimatedMs ≈ agent_end_start - recall_end_ts
 * 使用后会在agent_end清理条目；过期条目与提示缓存一起清除。
 */
const pendingRecallEndTimestamps = new Map<string, number>();

// 进程级单例，避免同一进程重复启动清理器导致并发清理竞态
let sharedMemoryCleaner: LocalMemoryCleaner | undefined;

/**
 * Sweep both pendingOriginalPrompts and pendingRecallCache for stale entries.
 * Unified from the original sweepStalePromptCache() to cover both Maps
 * with identical TTL + hard-cap logic.
 * 中文：清理 stale 值的 pendingOriginalPrompts 和 pendingRecallCache。
 * 统一自原 sweepStalePromptCache()，涵盖具有相同 TTL + 硬上限逻辑的两个 Map。
 */
function sweepStaleCaches(): void {
  const now = Date.now();
  // Clean pendingOriginalPrompts
  // 中文：清理 pendingOriginalPrompts
  for (const [key, entry] of pendingOriginalPrompts) {
    if (now - entry.ts > PROMPT_CACHE_TTL_MS) {
      pendingOriginalPrompts.delete(key);
      pendingRecallEndTimestamps.delete(key);
    }
  }
  // Clean pendingRecallCache
  // 中文：清理 pendingRecallCache
  for (const [key, entry] of pendingRecallCache) {
    if (now - entry.ts > PROMPT_CACHE_TTL_MS) {
      pendingRecallCache.delete(key);
    }
  }
  // Hard limit: evict oldest entries if either Map exceeds cap
  // 中文：硬性限制：如果任一Map超过容量，则移除最旧条目
  if (pendingOriginalPrompts.size > PROMPT_CACHE_MAX_SIZE) {
    const entries = [...pendingOriginalPrompts.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toEvict = entries.slice(0, entries.length - PROMPT_CACHE_MAX_SIZE);
    for (const [key] of toEvict) {
      pendingOriginalPrompts.delete(key);
      pendingRecallEndTimestamps.delete(key);
    }
  }
  if (pendingRecallCache.size > PROMPT_CACHE_MAX_SIZE) {
    const entries = [...pendingRecallCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toEvict = entries.slice(0, entries.length - PROMPT_CACHE_MAX_SIZE);
    for (const [key] of toEvict) {
      pendingRecallCache.delete(key);
    }
  }
}

export default function register(api: OpenClawPluginApi) {
  // ─── CLI metadata mode: register CLI commands only, skip all runtime init ───
  // In this mode, runtime is `{} as PluginRuntime` (empty object).
  // OpenClaw calls this to discover CLI subcommands without starting the full plugin.
  // 中文：─── CLI元数据模式：仅注册CLI命令，跳过所有运行时初始化 ───
  // 在此模式下，运行时是`{} as PluginRuntime`（空对象）。
  // OpenClaw调用此方法以发现CLI子命令而不启动完整插件。
  if (api.registrationMode === "cli-metadata") {
    api.registerCli(
      ({ program, config, logger: cliLogger }) => {
        const memoryTdai = program
          .command("memory-tdai")
          .description("memory-tdai plugin commands (seed, query, stats)");

        registerMemoryTdaiCli(memoryTdai, {
          config,
          pluginConfig: api.pluginConfig,
          stateDir: resolveOpenClawStateDir((api.runtime as any)?.state),
          logger: cliLogger,
        });
      },
      { commands: ["memory-tdai"] },
    );
    return;
  }

  // ─── Full / discovery mode: complete runtime initialization ───
  // 中文：─── 完整/发现模式：完成运行时初始化 ───
  pluginStartTimestamp = Date.now();
  setPreferredEmbeddedAgentRuntime(api.runtime.agent);
  // Reset reporter singleton so config changes take effect on hot-reload.
  // 中文：重置报告器单例，以便配置更改在热重载时生效。
  resetReporter();
  const _require = createRequire(import.meta.url);
  const pluginVersion = (() => { try { return (_require("./package.json") as { version?: string }).version ?? "unknown"; } catch { return "unknown"; } })();
  api.logger.debug?.(
    `${TAG} Registering plugin ... ` +
    `startTimestamp=${pluginStartTimestamp} (${new Date(pluginStartTimestamp).toISOString()})`,
  );

  let cfg: MemoryTdaiConfig;
  try {
    // OpenClaw calls register() N times (plugin scan → gateway start →
    // per-channel bootstrap → config reload). Each call receives the full
    // pluginConfig from openclaw.json, so we parse it directly every time.
    // 中文：OpenClaw多次调用register()（插件扫描 → 网关启动 →
    // 每通道启动 → 配置重新加载）。每次调用都接收来自openclaw.json的完整pluginConfig，因此我们每次都直接解析它。
    const rawPluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
    const rawKeys = rawPluginConfig ? Object.keys(rawPluginConfig) : [];
    api.logger.debug?.(
      `${TAG} pluginConfig received (${rawKeys.length} keys)`,
    );

    cfg = parseConfig(rawPluginConfig);
    api.logger.debug?.(
      `${TAG} Config parsed: ` +
      `capture=${cfg.capture.enabled}, ` +
      `recall=${cfg.recall.enabled}(maxResults=${cfg.recall.maxResults}), ` +
      `extraction=${cfg.extraction.enabled}(dedup=${cfg.extraction.enableDedup}, maxMem=${cfg.extraction.maxMemoriesPerSession}), ` +
      `pipeline=(everyN=${cfg.pipeline.everyNConversations}, warmup=${cfg.pipeline.enableWarmup}, l1Idle=${cfg.pipeline.l1IdleTimeoutSeconds}s, l2DelayAfterL1=${cfg.pipeline.l2DelayAfterL1Seconds}s, l2Min=${cfg.pipeline.l2MinIntervalSeconds}s, l2Max=${cfg.pipeline.l2MaxIntervalSeconds}s, activeWindow=${cfg.pipeline.sessionActiveWindowHours}h), ` +
      `persona(triggerEvery=${cfg.persona.triggerEveryN}, backupCount=${cfg.persona.backupCount}, sceneBackupCount=${cfg.persona.sceneBackupCount}), ` +
      `memoryCleanup(enabled=${cfg.memoryCleanup.enabled}, retentionDays=${cfg.memoryCleanup.retentionDays ?? "(disabled)"}, cleanTime=${cfg.memoryCleanup.cleanTime}), ` +
      `offload(enabled=${cfg.offload.enabled}, backendUrl=${cfg.offload.backendUrl ?? "(none)"}, mildRatio=${cfg.offload.mildOffloadRatio}, aggressiveRatio=${cfg.offload.aggressiveCompressRatio}, retentionDays=${cfg.offload.offloadRetentionDays})`,
    );
  } catch (err) {
    api.logger.error(`${TAG} Config parsing failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  // Initialize unified time module (must happen before any timestamp formatting)
  // 中文：初始化统一时间模块（必须在任何时间戳格式化之前发生）
  initTimeModule({ timezone: cfg.timezone }, api.logger);

  // ============================
  // Hook policy auto-patch (v2026.4.24+ compat)
  // ============================
  // `allowConversationAccess` hook policy was introduced in v2026.4.23;
  // the zod schema fix landed in v2026.4.24. Older hosts don't understand
  // the field and don't need it patched in.
  //
  // Note: `api.runtime.version` is only exposed on v2026.4.15+. On older
  // hosts it is `undefined`; we MUST treat that as "does not need the
  // patch" (old hosts have no gate), otherwise we would silently mutate
  // the user's openclaw.json on every gateway start.
  // 中文：Hook策略自动打补丁（v2026.4.24+ 兼容性）
  // `allowConversationAccess` Hook策略是在v2026.4.23引入的；zod模式修复在v2026.4.24落地。较旧的主机不理解该字段，不需要打补丁。
  // 注意：`api.runtime.version`仅在v2026.4.15+中公开，在较旧的主机上为`undefined`；我们必须将其视为“无需打补丁”（旧主机没有门），否则我们将在每次网关启动时无声地突变用户的openclaw.json。
  {
    // Gate: only apply the auto-patch when host version >= 2026.4.24.
    // decideHookPolicy() parses the leading x.y.z prefix numerically
    // (ignoring `-beta.N`, `-N`, etc.) and returns apply=false for any
    // version we cannot parse — which is the safe default on old hosts
    // that don't expose `api.runtime.version`. See ensure-hook-policy.ts
    // for the full policy + co-located unit tests.
    // 中文：门：仅当主机版本 >= 2026.4.24 时应用自动打补丁。
    // decideHookPolicy()解析前导的x.y.z前缀为数字
    // （忽略`-beta.N`，`-N`等），对于任何无法解析的版本返回apply=false — 这是在旧主机上不暴露`api.runtime.version`的安全默认值。请参见ensure-hook-policy.ts以获取完整的策略及相邻单元测试
    const rawVersion = (api.runtime as any)?.version;
    const decision = decideHookPolicy(rawVersion);
    const parsedStr = decision.parsedXYZ ? decision.parsedXYZ.join(".") : "<unparsable>";
    const minStr = decision.minXYZ.join(".");

    if (!decision.apply) {
      api.logger.debug?.(
        `${TAG} Hook policy auto-patch skipped: ` +
        `original=${JSON.stringify(rawVersion)}, parsed=${parsedStr}, min=${minStr}`,
      );
    } else {
      api.logger.debug?.(
        `${TAG} Hook policy auto-patch applying: ` +
        `original=${JSON.stringify(rawVersion)}, parsed=${parsedStr} >= min=${minStr}`,
      );
      try {
        ensurePluginHookPolicy({
          rootConfig: api.config,
          runtimeConfig: api.runtime?.config,
          logger: api.logger,
        });
      } catch (err) {
        api.logger.warn(`${TAG} Hook policy check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // If remote embedding config is incomplete, log a prominent error so the user knows
  // 中文：如果远程嵌入配置不完整，请记录一个显眼的错误日志以便用户知晓
  if (cfg.embedding.configError) {
    api.logger.error(`${TAG} [EMBEDDING CONFIG ERROR] ${cfg.embedding.configError}`);
  }

  // Resolve plugin data directory via runtime API (avoid importing internal paths directly)
  // 中文：通过运行时API解析插件数据目录（避免直接导入内部路径）
  const openclawStateDir = resolveOpenClawStateDir((api.runtime as any)?.state);
  const pluginDataDir = path.join(openclawStateDir, "memory-tdai");
  initDataDirectories(pluginDataDir);
  api.logger.debug?.(`${TAG} Data dir: ${pluginDataDir} (all subdirectories initialized)`);

  // ============================
  // Create OpenClawHostAdapter + TdaiCore
  // ============================
  // 中文：创建OpenClawHostAdapter + TdaiCore
  const hostAdapter = new OpenClawHostAdapter({
    api,
    pluginDataDir,
    openclawConfig: api.config,
  });

  const sessionFilter = new SessionFilter(cfg.capture.excludeAgents);
  if (cfg.capture.excludeAgents.length > 0) {
    api.logger.debug?.(`${TAG} Agent exclude patterns: ${cfg.capture.excludeAgents.join(", ")}`);
  }

  const core = new TdaiCore({
    hostAdapter,
    config: cfg,
    sessionFilter,
  });

  // Initialize TdaiCore (async — store init, pipeline wiring)
  // 中文：初始化TdaiCore（异步——存储初始化，管道布线）
  const coreReady = core.initialize().then(() => {
    // Keep cleaner's SQLite handle updated after store init
    // 中文：在存储初始化后保持清理者的SQLite句柄更新
    memoryCleaner?.setVectorStore(core.getVectorStore());

    // Pull L2/L3 profiles if remote store supports it
    // 中文：如果远程存储支持，请立即拉取L2/L3配置文件
    const vs = core.getVectorStore();
    if (vs?.pullProfiles) {
      ensureL2L3Local(pluginDataDir, vs, api.logger).catch((err) => {
        api.logger.warn(`${TAG} Startup L2/L3 pull failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }).catch((err) => {
    api.logger.error(`${TAG} Core init failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Kick off instanceId resolution immediately after data dir is ready.
  // 中文：数据目录准备好后立即启动instanceId解析.
  let instanceId: string | undefined;
  getOrCreateInstanceId(pluginDataDir).then((id) => {
    instanceId = id;
    core.setInstanceId(id);
    initReporter({ enabled: cfg.report.enabled, type: cfg.report.type, logger: api.logger, instanceId: id, pluginVersion });
  }).catch((err) => {
    api.logger.warn(`${TAG} Failed to initialize instanceId for metrics: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Daily local JSONL cleaner (L0/L1), enabled only when retentionDays is configured.
  // 中文：每日本地JSONL清理器（L0/L1），仅当配置了retentionDays时启用
  let memoryCleaner: LocalMemoryCleaner | undefined;
  if (cfg.memoryCleanup.enabled && cfg.memoryCleanup.retentionDays != null) {
    if (!sharedMemoryCleaner) {
      sharedMemoryCleaner = new LocalMemoryCleaner({
        baseDir: pluginDataDir,
        retentionDays: cfg.memoryCleanup.retentionDays,
        cleanTime: cfg.memoryCleanup.cleanTime,
        logger: api.logger,
      });
      sharedMemoryCleaner.start();
      api.logger.debug?.(`${TAG} Memory cleaner started (singleton)`);
    } else {
      api.logger.debug?.(`${TAG} Memory cleaner already started in this process, reusing existing instance`);
    }
    memoryCleaner = sharedMemoryCleaner;
  } else {
    api.logger.debug?.(`${TAG} Memory cleaner disabled (retentionDays not configured)`);
  }

  const resolveSessionKey = (sessionKey?: string): string | undefined => {
    if (sessionKey) return sessionKey;
    api.logger.warn(`${TAG} sessionKey is empty, skipping capture/recall to avoid unstable fallback key`);
    return undefined;
  };

  /**
   * Whether embedding warmup has been triggered.
   * Deferred until first real conversation to avoid model downloads during CLI commands.
   * 中文：是否已触发嵌入预热。
   * 延迟至首次实际对话以避免在CLI命令期间下载模型。
   */
  let embeddingWarmupTriggered = false;
  const ensureEmbeddingWarmup = (): void => {
    const svc = core.getEmbeddingService();
    if (!svc) return;
    if (!embeddingWarmupTriggered) {
      embeddingWarmupTriggered = true;
      api.logger.debug?.(`${TAG} Triggering lazy embedding warmup on first conversation`);
      svc.startWarmup();
      return;
    }
    if (!svc.isReady()) {
      api.logger.debug?.(`${TAG} Embedding not ready, re-triggering warmup (retry)`);
      svc.startWarmup();
    }
  };

  // ============================
  // Tool registration — delegate to TdaiCore
  // ============================
  // 中文：工具注册——委托给TdaiCore

  // tdai_memory_search — Agent-callable L1 memory search tool
  // TODO: implement hard per-turn call limit via before_tool_call hook + execute early-return (方案 D)
  if (cfg.recall.enabled || cfg.capture.enabled) {
  api.registerTool(
    {
      name: "tdai_memory_search",
      label: "Memory Search",
      description:
        "Search through the user's long-term memories. Use this when you need to recall specific information about the user's preferences, past events, instructions, or context from previous conversations. Returns relevant memory records ranked by relevance. " +
        "Limit: tdai_memory_search and tdai_conversation_search share a combined limit of 3 calls per turn. Stop searching after 3 total attempts.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query describing what you want to recall about the user",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 5, max: 20)",
          },
          type: {
            type: "string",
            enum: ["persona", "episodic", "instruction"],
            description: "Optional filter by memory type: persona (identity/preferences), episodic (events/activities), instruction (user rules/commands)",
          },
          scene: {
            type: "string",
            description: "Optional filter by scene name",
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const startMs = Date.now();
        const query = String(params.query ?? "");
        const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 20);
        const typeFilter = typeof params.type === "string" ? params.type : undefined;
        const sceneFilter = typeof params.scene === "string" ? params.scene : undefined;

        api.logger.debug?.(
          `${TAG} [tool] tdai_memory_search called: ` +
          `query="${query.length > 80 ? query.slice(0, 80) + "…" : query}", ` +
          `limit=${limit}, type=${typeFilter ?? "(all)"}, scene=${sceneFilter ?? "(all)"}`,
        );

        try {
          const result = await core.searchMemories({ query, limit, type: typeFilter, scene: sceneFilter });

          const elapsedMs = Date.now() - startMs;
          api.logger.debug?.(
            `${TAG} [tool] tdai_memory_search completed (${elapsedMs}ms): ` +
            `total=${result.total}, strategy=${result.strategy}, ` +
            `responseLength=${result.text.length} chars`,
          );
          report("tool_call", {
            tool: "tdai_memory_search",
            query, limit, typeFilter, sceneFilter,
            resultCount: result.total,
            strategy: result.strategy,
            durationMs: elapsedMs,
            success: true,
          });
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: { count: result.total, strategy: result.strategy },
          };
        } catch (err) {
          const elapsedMs = Date.now() - startMs;
          const errMsg = err instanceof Error ? err.message : String(err);
          api.logger.error(`${TAG} [tool] tdai_memory_search failed (${elapsedMs}ms): ${errMsg}`);
          report("tool_call", {
            tool: "tdai_memory_search",
            query, limit, typeFilter, sceneFilter,
            durationMs: elapsedMs,
            success: false,
            error: errMsg,
          });
          return {
            content: [{ type: "text" as const, text: `Memory search failed: ${errMsg}` }],
            details: { error: errMsg },
          };
        }
      },
    },
    { name: "tdai_memory_search" },
  );

  // tdai_conversation_search — Agent-callable L0 conversation search tool
  // TODO: implement hard per-turn call limit via before_tool_call hook + execute early-return (方案 D)
  api.registerTool(
    {
      name: "tdai_conversation_search",
      label: "Conversation Search",
      description:
        "Search through past conversation history (raw dialogue records). " +
        "Use this when tdai_memory_search (structured memories) doesn't have the information you need, " +
        "or when you want to find specific past conversations, dialogue context, or exact words " +
        "the user said before. Returns relevant individual messages ranked by relevance. " +
        "Limit: tdai_memory_search and tdai_conversation_search share a combined limit of 3 calls per turn. Stop searching after 3 total attempts.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query describing what conversation content you want to find",
          },
          limit: {
            type: "number",
            description: "Maximum number of messages to return (default: 5, max: 20)",
          },
          session_key: {
            type: "string",
            description: "Optional: filter results to a specific session",
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const startMs = Date.now();
        const query = String(params.query ?? "");
        const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 20);
        const sessionKeyFilter = typeof params.session_key === "string" ? params.session_key : undefined;

        api.logger.debug?.(
          `${TAG} [tool] tdai_conversation_search called: ` +
          `query="${query.length > 80 ? query.slice(0, 80) + "…" : query}", ` +
          `limit=${limit}, session_key=${sessionKeyFilter ?? "(all)"}`,
        );

        try {
          const result = await core.searchConversations({ query, limit, sessionKey: sessionKeyFilter });

          const elapsedMs = Date.now() - startMs;
          api.logger.debug?.(
            `${TAG} [tool] tdai_conversation_search completed (${elapsedMs}ms): ` +
            `total=${result.total}, responseLength=${result.text.length} chars`,
          );
          report("tool_call", {
            tool: "tdai_conversation_search",
            query, limit, sessionKeyFilter,
            resultCount: result.total,
            durationMs: elapsedMs,
            success: true,
          });
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: { count: result.total },
          };
        } catch (err) {
          const elapsedMs = Date.now() - startMs;
          const errMsg = err instanceof Error ? err.message : String(err);
          api.logger.error(`${TAG} [tool] tdai_conversation_search failed (${elapsedMs}ms): ${errMsg}`);
          report("tool_call", {
            tool: "tdai_conversation_search",
            query, limit, sessionKeyFilter,
            durationMs: elapsedMs,
            success: false,
            error: errMsg,
          });
          return {
            content: [{ type: "text" as const, text: `Conversation search failed: ${errMsg}` }],
            details: { error: errMsg },
          };
        }
      },
    },
    { name: "tdai_conversation_search" },
  );
  } else {
    api.logger.debug?.(`${TAG} Memory tools (tdai_memory_search, tdai_conversation_search) not registered — memory features disabled`);
  }

  // ============================
  // Lifecycle hooks — delegate to TdaiCore
  // ============================
  // 中文：生命周期挂钩 — 委托给 TdaiCore

  // Before prompt build: auto-recall relevant memories
  // 中文：构建提示之前：自动召回相关记忆
  if (cfg.recall.enabled) {
    api.logger.debug?.(`${TAG} Registering before_prompt_build hook (auto-recall)`);
    api.on("before_prompt_build", async (event, ctx) => {
      const startMs = Date.now();
      api.logger.debug?.(`${TAG} [before_prompt_build] Hook triggered`);

      const sessionKey = ctx.sessionKey;

      if (sessionFilter.shouldSkipCtx(ctx)) {
        api.logger.debug?.(`${TAG} [before_prompt_build] Skipping filtered session`);
        return;
      }

      ensureEmbeddingWarmup();

      // Cache original user prompt for agent_end
      // 中文：为 agent_end 缓存原始用户提示
      const rawPrompt = event.prompt;
      const messages = Array.isArray(event.messages) ? event.messages : undefined;
      if (sessionKey && rawPrompt) {
        const messageCount = messages?.length ?? 0;
        pendingOriginalPrompts.set(sessionKey, { text: rawPrompt, ts: Date.now(), messageCount });
        api.logger.debug?.(`${TAG} [before_prompt_build] Cached original prompt (${rawPrompt.length} chars, msgCount=${messageCount})`);
      }
      sweepStaleCaches();

      const userText = rawPrompt;
      api.logger.debug?.(`${TAG} [before_prompt_build] userText length: ${userText?.length}`);
      if (!userText) {
        api.logger.debug?.(`${TAG} [before_prompt_build] No user text found, skipping recall`);
        return;
      }

      const resolvedSessionKey = resolveSessionKey(sessionKey);
      if (!resolvedSessionKey) {
        return;
      }

      try {
        await coreReady;
        const recallStartMs = Date.now();
        const result = await core.handleBeforeRecall(userText, resolvedSessionKey);
        const elapsedMs = Date.now() - startMs;
        const recallDurationMs = Date.now() - recallStartMs;

        // Cache recall results for agent_turn metric (retrieved at agent_end)
        // 中文：为 agent_turn 指标缓存召回结果（在 agent_end 时检索）
        if (sessionKey && result) {
          pendingRecallCache.set(sessionKey, {
            l1Memories: result.recalledL1Memories ?? [],
            l3Persona: result.recalledL3Persona ?? null,
            strategy: result.recallStrategy ?? "unknown",
            durationMs: recallDurationMs,
            ts: Date.now(),
          });
        }

        // Record recall completion timestamp for LLM timing estimation in agent_end
        // 中文：记录 LLM 在 agent_end 时的回忆完成时间戳以进行耗时估计
        if (resolvedSessionKey) {
          pendingRecallEndTimestamps.set(resolvedSessionKey, Date.now());
        }

        if (result?.appendSystemContext || result?.prependContext) {
          const appendLen = result.appendSystemContext?.length ?? 0;
          const prependLen = result.prependContext?.length ?? 0;
          api.logger.info(
            `${TAG} [before_prompt_build] Recall complete (${elapsedMs}ms), ` +
            `appendSystemContext=${appendLen} chars, prependContext=${prependLen} chars`,
          );
        } else {
          api.logger.info(`${TAG} [before_prompt_build] Recall complete (${elapsedMs}ms), no context to inject`);
        }
        return result;
      } catch (err) {
        const elapsedMs = Date.now() - startMs;
        api.logger.error(`${TAG} [before_prompt_build] Auto-recall failed after ${elapsedMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        if (instanceId) {
          report("error_degradation", {
            module: "auto-recall",
            action: "performAutoRecall",
            errorType: "exception",
            errorMessage: err instanceof Error ? err.message : String(err),
            degradedTo: "no_recall",
            impact: "non-blocking",
          });
        }
      }
    });
  }

  // Strip <relevant-memories> from user messages before they are persisted to
  // the session JSONL.  The current-turn LLM already saw the full prompt
  // (effectivePrompt lives in memory), but we don't want recall artifacts
  // polluting the historical transcript for future replays.
  // 中文：在将用户消息持久化到会话 JSONL 之前，去除 <relevant-memories> 标记。
  // 当前轮次的 LLM 已经看到了完整的提示（effectivePrompt 存在于内存中），但我们不希望回忆痕迹污染未来的回放历史记录。
  api.logger.debug?.(`${TAG} Registering before_message_write hook (strip <relevant-memories>)`);
  api.on("before_message_write", (event) => {
    const msg = event.message as { role?: string; content?: unknown };
    const contentType = typeof msg.content === "string" ? "string" : Array.isArray(msg.content) ? "parts" : typeof msg.content;
    api.logger.debug?.(`${TAG} [before_message_write] role=${msg.role}, contentType=${contentType}`);

    if (msg.role !== "user") return;

    // UserMessage.content: string | (TextContent | ImageContent)[]
    // 中文：UserMessage.content: string | (TextContent | ImageContent)[]
    const STRIP_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

    if (typeof msg.content === "string") {
      if (!msg.content.includes("<relevant-memories>")) return;
      const cleaned = msg.content.replace(STRIP_RE, "").trim();
      if (cleaned === msg.content) return;
      api.logger.debug?.(`${TAG} [before_message_write] Stripped: ${msg.content.length} → ${cleaned.length} chars`);
      return { message: { ...event.message, content: cleaned } as typeof event.message };
    }

    if (Array.isArray(msg.content)) {
      let totalStripped = 0;
      const cleanedParts = (msg.content as Array<Record<string, unknown>>).map((part) => {
        if (part.type !== "text" || typeof part.text !== "string") return part;
        if (!(part.text as string).includes("<relevant-memories>")) return part;
        const cleaned = (part.text as string).replace(STRIP_RE, "").trim();
        totalStripped += (part.text as string).length - cleaned.length;
        return { ...part, text: cleaned };
      });
      if (totalStripped === 0) return;
      api.logger.debug?.(`${TAG} [before_message_write] Stripped from parts: removed ${totalStripped} chars`);
      return { message: { ...event.message, content: cleanedParts } as unknown as typeof event.message };
    }
  });

  // After agent end: auto-capture + L0 record + L1/L2/L3 schedule
  // 中文：after agent end: auto-capture + L0 record + L1/L2/L3 schedule
  if (cfg.capture.enabled) {
    api.logger.debug?.(`${TAG} Registering agent_end hook (auto-capture)`);
    api.on("agent_end", async (event, ctx) => {
      const startMs = Date.now();
      api.logger.debug?.(`${TAG} [agent_end] Hook triggered`);

      const e = event as Record<string, unknown>;
      if (!e.success) {
        api.logger.info(`${TAG} [agent_end] Agent did not succeed, skipping capture`);
        return;
      }

      const sessionKey = ctx.sessionKey;
      const sessionId = ctx.sessionId;

      if (sessionFilter.shouldSkipCtx(ctx)) {
        api.logger.debug?.(`${TAG} [agent_end] Skipping filtered session`);
        return;
      }

      const messages = (e.messages as unknown[]) ?? [];
      const resolvedSessionKey = resolveSessionKey(sessionKey);
      if (!resolvedSessionKey) {
        return;
      }

      // Estimate LLM reasoning time: recallEnd → agentEnd start
      // 中文：估计LLM推理时间：recallEnd → agentEnd开始
      const recallEndTs = pendingRecallEndTimestamps.get(resolvedSessionKey);
      if (recallEndTs) {
        const llmEstimatedMs = startMs - recallEndTs;
        api.logger.info(
          `${TAG} ⏱ Turn timing: recallEnd→agentEnd=${llmEstimatedMs}ms ` +
          `(≈ LLM reasoning + prompt build + tool calls)`,
        );
        pendingRecallEndTimestamps.delete(resolvedSessionKey);
      }

      // Retrieve cached original prompt
      // 中文：检索缓存的原始提示
      const cachedPrompt = sessionKey ? pendingOriginalPrompts.get(sessionKey) : undefined;
      const originalUserText = cachedPrompt?.text;

      try {
        await coreReady;

        // Pre-warm the embedded agent on first conversation
        // 中文：在首次对话时预热嵌入式代理
        if (!core.isSchedulerStarted()) {
          prewarmEmbeddedAgent(api.logger, api.runtime.agent);
        }

        const captureResult = await core.handleTurnCommitted({
          userText: originalUserText ?? "",
          assistantText: "",
          messages,
          sessionKey: resolvedSessionKey,
          sessionId: sessionId || undefined,
          startedAt: pluginStartTimestamp,
          originalUserMessageCount: cachedPrompt?.messageCount,
        });
        const captureMs = Date.now() - startMs;
        api.logger.info(
          `${TAG} [agent_end] Auto-capture complete (${captureMs}ms), ` +
          `l0Recorded=${captureResult.l0RecordedCount}, ` +
          `schedulerNotified=${captureResult.schedulerNotified}`,
        );

        // ── agent_turn metric ──
        // 中文：── agent_turn指标 ──
        const cachedRecall = sessionKey ? pendingRecallCache.get(sessionKey) : undefined;
        if (sessionKey) pendingRecallCache.delete(sessionKey);

        if (instanceId) {
          report("agent_turn", {
            sessionKey: resolvedSessionKey,
            userPrompt: originalUserText ?? null,
            recalledL1Memories: cachedRecall?.l1Memories ?? [],
            recalledL1Count: cachedRecall?.l1Memories?.length ?? 0,
            recalledL3Persona: cachedRecall?.l3Persona ?? null,
            recallStrategy: cachedRecall?.strategy ?? null,
            recallDurationMs: cachedRecall?.durationMs ?? 0,
            l0CapturedMessages: captureResult.filteredMessages.map((m) => ({
              role: m.role,
              content: m.content,
              ts: m.timestamp,
            })),
            l0CapturedCount: captureResult.l0RecordedCount,
            l0VectorsWritten: captureResult.l0VectorsWritten,
            captureDurationMs: captureMs,
            totalDurationMs: Date.now() - startMs,
          });
        }
      } catch (err) {
        const elapsedMs = Date.now() - startMs;
        api.logger.error(`${TAG} [agent_end] Auto-capture failed after ${elapsedMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        if (instanceId) {
          report("error_degradation", {
            module: "auto-capture",
            action: "performAutoCapture",
            errorType: "exception",
            errorMessage: err instanceof Error ? err.message : String(err),
            degradedTo: "no_capture",
            impact: "non-blocking",
          });
        }
      }
    });

    // gateway_stop: ordered shutdown via TdaiCore.destroy()
    // 中文：gateway_stop: 通过TdaiCore.destroy()有序关闭
    api.on("gateway_stop", async () => {
      const GATEWAY_STOP_TIMEOUT_MS = 3_000;
      const hookStartMs = Date.now();

      await coreReady.catch(() => {});

      const doCleanup = async (): Promise<void> => {
        // 1. Stop memory cleaner first
        // 中文：1. 首先停止内存清理器
        if (memoryCleaner) {
          try {
            memoryCleaner.destroy();
            if (sharedMemoryCleaner === memoryCleaner) {
              sharedMemoryCleaner = undefined;
            }
          } catch (error) {
            api.logger.error(`${TAG} [gateway_stop] memoryCleaner error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // 2. Destroy TdaiCore (scheduler flush + VectorStore close + EmbeddingService close)
        // 中文：2. 销毁TdaiCore（调度器刷新 + VectorStore关闭 + EmbeddingService关闭）
        await core.destroy();
      };

      // Race cleanup against a hard timeout
      // 中文：硬性清理竞争against a hard timeout
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          doCleanup(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("timeout")),
              GATEWAY_STOP_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (err) {
        api.logger.warn(
          `${TAG} [gateway_stop] Aborted (${Date.now() - hookStartMs}ms): ${err instanceof Error ? err.message : String(err)}. ` +
          `Pending work will recover on next startup.`,
        );
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }

      resetStores();
      api.logger.info(`${TAG} [gateway_stop] Cleanup finished, all resources released (${Date.now() - hookStartMs}ms)`);
    });
  } else {
    api.logger.debug?.(`${TAG} Auto-capture disabled`);
  }

  // memoryCleaner gateway_stop for capture-enabled-but-extraction-disabled case
  // 中文：capture启用但提取禁用情况下的memoryCleaner gateway_stop
  if (memoryCleaner && !cfg.extraction.enabled) {
    api.on("gateway_stop", async () => {
      const startMs = Date.now();
      try {
        memoryCleaner?.destroy();
        if (sharedMemoryCleaner === memoryCleaner) {
          sharedMemoryCleaner = undefined;
        }
        api.logger.info(`${TAG} [gateway_stop] Memory cleaner destroyed (${Date.now() - startMs}ms)`);
      } catch (error) {
        api.logger.error(`${TAG} [gateway_stop] Error during memory cleaner destruction (${Date.now() - startMs}ms): ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  // ============================
  // Context Offload (conditional)
  // ============================
  // 中文：条件性上下文卸载(Context Offload)
  if (cfg.offload.enabled) {
    api.logger.debug?.(`${TAG} Offload enabled, registering offload module...`);
    try {
      registerOffload(api, cfg.offload);
      api.logger.debug?.(`${TAG} Offload module registered successfully`);
    } catch (err) {
      api.logger.error(`${TAG} Offload module registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    api.logger.debug?.(`${TAG} Offload disabled (offload.enabled=false)`);
  }

  // ============================
  // CLI registration
  // ============================
  // 中文：CLI注册

  api.registerCli(
    ({ program, config, logger: cliLogger }) => {
      const memoryTdai = program
        .command("memory-tdai")
        .description("memory-tdai plugin commands (seed, query, stats)");

      registerMemoryTdaiCli(memoryTdai, {
        config,
        pluginConfig: api.pluginConfig,
        stateDir: openclawStateDir,
        logger: cliLogger,
      });
    },
    { commands: ["memory-tdai"] },
  );

  api.logger.debug?.(
    `${TAG} Plugin registration complete (v3.1 — TdaiCore). ` +
    `startTimestamp=${pluginStartTimestamp} (${new Date(pluginStartTimestamp).toISOString()})`,
  );
}
