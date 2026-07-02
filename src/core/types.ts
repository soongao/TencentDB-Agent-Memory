/**
 * TDAI Core — Host-neutral type definitions and abstract interfaces.
 *
 * These types define the boundary between TDAI Core (memory algorithms)
 * and the host environment (OpenClaw, Hermes, standalone Gateway, etc.).
 *
 * Design principles:
 * 1. TDAI Core depends ONLY on these interfaces — never on a specific host.
 * 2. Each host provides its own implementation of HostAdapter + LLMRunnerFactory.
 * 3. RuntimeContext is the single source of truth for session/user identity.
 * 中文：TDAI 核心 — 脱机中立的类型定义和抽象接口。
 * 这些类型界定了 TDAI 核心（内存算法）与宿主环境（OpenClaw、Hermes、独立网关等）之间的边界。
 * 设计原则：
 * 1. TDAI 核心仅依赖于这些接口 — 从不依赖特定的宿主。
 * 2. 每个宿主都提供自己的 HostAdapter + LLMRunnerFactory 实现。
 * 3. RuntimeContext 是会话/用户身份的单一来源。
 */

// ============================
// Logger (unified across all layers)
// ============================
// 中文：日志记录器（跨所有层统一）

/**
 * Canonical logger interface used across all TDAI modules.
 *
 * Named variants (StoreLogger, PluginLogger, etc.) are type aliases
 * of this interface, kept for backward compatibility.
 * 中文：在整个 TDAI 模块中使用的标准日志接口。
 * 命名变体（StoreLogger、PluginLogger 等）是此接口的类型别名，保留向后兼容。
 */
export interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// ============================
// RuntimeContext
// ============================
// 中文：运行时上下文

/**
 * Unified runtime context — provides identity, scoping, and path information.
 *
 * In OpenClaw: populated from `pluginConfig`, `sessionKey`, `resolveStateDir()`.
 * In Hermes:   populated from `MemoryProvider.initialize()` kwargs.
 * In Gateway:  populated from HTTP request parameters.
 * 中文：统一的运行时上下文 — 提供身份、作用域和路径信息。
 * 在 OpenClaw 中：从 `pluginConfig`、`sessionKey`、`resolveStateDir()` 充实。
 * 在 Hermes 中：从 `MemoryProvider.initialize()` 关键字参数充实。
 * 在网关中：从 HTTP 请求参数充实。
 */
export interface RuntimeContext {
  /** User identifier (e.g. "default_user" for CLI, platform user ID for gateway). */
  /** 中文：用户标识符（例如 CLI 中的 "default_user"，网关中的平台用户 ID）。 */
  userId: string;
  /** Session identifier (unique per conversation session). */
  /** 中文：会话标识符（每个对话会话唯一）。 */
  sessionId: string;
  /** Session key (stable across reconnects, used for L0/L1 grouping). */
  /** 中文：会话密钥（重连时稳定，用于 L0/L1 分组）。 */
  sessionKey: string;
  /** Host platform identifier. */
  /** 中文：宿主机平台标识. */
  platform: "openclaw" | "hermes" | "cli" | "gateway" | string;
  /** Agent identity / profile name (optional). */
  /** 中文：代理身份/配置文件名称（可选）. */
  agentIdentity?: string;
  /** Agent execution context — primary agent, subagent, cron job, or flush task. */
  /** 中文：代理执行上下文——主代理、子代理、定时任务或刷新任务. */
  agentContext?: "primary" | "subagent" | "cron" | "flush";
  /** Workspace directory (for tool sandbox, if applicable). */
  /** 中文：工作区目录（如适用，用于工具沙盒）. */
  workspaceDir: string;
  /** Plugin/provider data directory (L0, records, scene_blocks, etc.). */
  /** 中文：插件/提供方数据目录（L0、记录、场景块等）。 */
  dataDir: string;
}

// ============================
// LLMRunner
// ============================
// 中文：LLMRunner

/** Parameters for a single LLM execution. */
/** 中文：单次LLM执行的参数. */
export interface LLMRunParams {
  /** User-facing prompt (or combined prompt if no systemPrompt). */
  /** 中文：面向用户的提示词（或无系统提示词时的组合提示词）. */
  prompt: string;
  /** Optional system prompt. When provided, `prompt` is used as the user message. */
  /** 中文：可选系统提示。当提供时，`prompt`用作用户消息。 */
  systemPrompt?: string;
  /** Unique task identifier for logging and metrics. */
  /** 中文：唯一任务标识符，用于日志记录和指标。 */
  taskId: string;
  /** Execution timeout in milliseconds (default: 120_000). */
  /** 中文：执行超时（毫秒，默认值：120_000）。 */
  timeoutMs?: number;
  /** Max output tokens (optional — defaults to model catalog value). */
  /** 中文：最大输出标记数（可选 — 默认值为模型目录中的值）。 */
  maxTokens?: number;
  /**
   * Working directory for tool-enabled runs.
   * When `enableTools` is true, the LLM's file tools resolve paths relative to this dir.
   * When omitted, a clean empty workspace is used.
   * 中文：工具启用运行的工作目录。
   * 当`enableTools`为true时，LLM的文件工具相对于此目录解析路径。
   * 省略时使用干净的空工作区。
   */
  workspaceDir?: string;
  /** Plugin instance ID for metric reporting (optional). */
  /** 中文：插件实例ID用于指标报告（可选）。 */
  instanceId?: string;
}

/**
 * Unified LLM execution interface.
 *
 * Replaces direct usage of `CleanContextRunner` throughout TDAI Core.
 *
 * Implementations:
 * - `OpenClawLLMRunner`: wraps `CleanContextRunner` / `runEmbeddedPiAgent` (OpenClaw host)
 * - `StandaloneLLMRunner`: direct OpenAI-compatible HTTP calls (Gateway / Hermes host)
 * 中文：统一的LLM执行接口。
 * 取代TDAI核心中对`CleanContextRunner`的直接调用。
 * 实现方式：
 * - `OpenClawLLMRunner`: 包装`CleanContextRunner` / `runEmbeddedPiAgent` (OpenClaw主机)
 * - `StandaloneLLMRunner`: 直接进行OpenAI兼容HTTP调用 (Gateway / Hermes主机)
 */
export interface LLMRunner {
  /**
   * Execute a prompt and return the LLM's text output.
   *
   * Behavior depends on the factory configuration:
   * - `enableTools: false` → pure text output (used by L1 extraction, L1 dedup)
   * - `enableTools: true`  → LLM may call file tools (used by L2 scene, L3 persona)
   *
   * @returns The LLM's text response. Empty string if the LLM produces no output.
   * @throws On timeout, network errors, or unrecoverable LLM failures.
   * 中文：执行提示并返回LLM的文本输出。
   * 行为取决于工厂配置：
   * - `enableTools: false` → 纯文本输出（用于L1提取，L1去重）
   * - `enableTools: true`  → LLM可能调用文件工具（用于L2场景，L3人物）
   * @returns LLM的文本响应。如果LLM未产生任何输出，则返回空字符串。
   * @throws 超时、网络错误或不可恢复的LLM故障。
   */
  run(params: LLMRunParams): Promise<string>;
}

// ============================
// LLMRunnerFactory
// ============================
// 中文：LLMRunnerFactory

/** Options for creating an LLMRunner instance. */
/** 中文：创建LLMRunner实例的选项。 */
export interface LLMRunnerCreateOptions {
  /**
   * Full "provider/model" string (e.g. "openai/gpt-4o").
   * Takes precedence over host default model.
   * 中文：完整的“provider/model”字符串（例如：“openai/gpt-4o”）。此设置优先于主机默认模型。
   */
  modelRef?: string;
  /**
   * Whether the runner should allow tool calls (read_file, write_to_file, etc.).
   * Default: false (text-only output).
   * 中文：运行器是否允许工具调用（read_file, write_to_file等）。
   * 默认值：false（仅文本输出）。
   */
  enableTools?: boolean;
}

/**
 * Factory for creating LLMRunner instances.
 *
 * Each host provides its own factory implementation that knows how to
 * configure runners with the correct model, API keys, and tool sandbox.
 * 中文：创建LLMRunner实例的工厂。
 * 每个主机都提供自己的实现，知道如何使用正确的模型、API密钥和工具沙箱来配置运行器。
 */
export interface LLMRunnerFactory {
  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner;
}

// ============================
// HostAdapter
// ============================
// 中文：HostAdapter

/**
 * Host adapter — translates host-specific events, context, and capabilities
 * into TDAI Core's unified interface.
 *
 * Each host environment provides exactly one HostAdapter implementation:
 * - OpenClaw:    `OpenClawHostAdapter` — wraps `OpenClawPluginApi`
 * - Hermes/GW:   `StandaloneHostAdapter` — wraps Gateway HTTP request context
 *
 * HostAdapter answers these questions for TDAI Core:
 * - "Who is the current user/session?" → `getRuntimeContext()`
 * - "How do I call an LLM?"           → `getLLMRunnerFactory()`
 * - "Where do I log?"                 → `getLogger()`
 * 中文：主机适配器——将主机特定的事件、上下文和功能翻译成TDAI Core统一接口。
 * 每个主机环境提供一个且仅有一个HostAdapter实现：
 * - OpenClaw: `OpenClawHostAdapter` — 包装 `OpenClawPluginApi`
 * - Hermes/GW: `StandaloneHostAdapter` — 包装 Gateway HTTP 请求上下文
 * HostAdapter回答TDAI Core以下问题：
 * - “当前用户/会话是谁？” → `getRuntimeContext()`
 * - “如何调用LLM？”           → `getLLMRunnerFactory()`
 * - “日志记录在哪里进行？”                 → `getLogger()`
 */
export interface HostAdapter {
  /** Identifies the host type for conditional behavior (should be rare). */
  /** 中文：标识主机类型以供条件行为使用（应很少见）。 */
  readonly hostType: "openclaw" | "hermes" | "standalone";

  /** Get the unified runtime context for the current session. */
  /** 中文：获取当前会话的统一运行时上下文。 */
  getRuntimeContext(): RuntimeContext;

  /** Get the logger instance provided by the host. */
  /** 中文：获取由宿主提供的日志记录实例。 */
  getLogger(): Logger;

  /** Get the LLM runner factory configured for this host. */
  /** 中文：获取为该宿主配置的LLM运行器工厂。 */
  getLLMRunnerFactory(): LLMRunnerFactory;
}

// ============================
// CompletedTurn — represents a finished conversation turn
// ============================
// 中文：CompletedTurn——表示一个完成的对话回合。

/** A completed conversation turn, ready for capture/storage. */
/** 中文：一个已完成的对话回合，准备被捕获/存储。 */
export interface CompletedTurn {
  /** The user's original message text. */
  /** 中文：用户原始消息文本。 */
  userText: string;
  /** The assistant's response text. */
  /** 中文：助手响应文本。 */
  assistantText: string;
  /** All messages in the turn (may include tool call results, etc.). */
  /** 中文：回合中的所有消息（可能包括工具调用结果等）。 */
  messages: unknown[];
  /** Session key for this turn. */
  /** 中文：会话键此回合. */
  sessionKey: string;
  /** Session ID within the session key (optional, for sub-session grouping). */
  /** 中文：会话键中的会话ID（可选，用于子会话分组）。 */
  sessionId?: string;
  /** Epoch ms when this turn started. */
  /** 中文：本次回合开始的时间戳（毫秒）. */
  startedAt?: number;
  /**
   * Number of messages in the session at before_prompt_build time.
   * Used by l0-recorder to locate the exact user message that was
   * polluted by prependContext injection.
   * 中文：在before_prompt_build之前会话中消息的数量。由l0-recorder使用以定位确切被prependContext注入污染的用户消息.
   */
  originalUserMessageCount?: number;
}

// ============================
// Core service result types
// ============================
// 中文：核心服务结果类型

/** Result from a recall (prefetch) operation. */
/** 中文：召回（预取）操作的结果. */
export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt text (dynamic, per-turn). */
  /** 中文：L1相关记忆——附加到用户提示文本前（每回合动态变化）。 */
  prependContext?: string;
  /** Stable recall context appended to system prompt (persona, scene nav, tools guide). */
  /** 中文：稳定召回上下文——附加到系统提示（人设、场景导航、工具指南） */
  appendSystemContext?: string;
  /** Recalled L1 memories with scores (for metrics). */
  /** 中文：召回了L1记忆（用于指标）. */
  recalledL1Memories?: Array<{ content: string; score: number; type: string }>;
  /** L3 Persona content (for metrics). */
  /** 中文：L3人设内容（用于指标）. */
  recalledL3Persona?: string | null;
  /** Search strategy used. */
  /** 中文：使用的搜索策略. */
  recallStrategy?: string;
}

/** Result from a capture (sync_turn) operation. */
/** 中文：捕获（sync_turn）操作的结果. */
export interface CaptureResult {
  /** Number of L0 messages recorded. */
  /** 中文：记录的L0消息数量. */
  l0RecordedCount: number;
  /** Whether the pipeline scheduler was notified. */
  /** 中文：是否通知了管道调度器. */
  schedulerNotified: boolean;
  /** Number of L0 vectors written. */
  /** 中文：写入的L0向量数量. */
  l0VectorsWritten: number;
  /** Filtered messages that were captured. */
  /** 中文：被捕获并过滤的消息. */
  filteredMessages: Array<{
    role: string;
    content: string;
    timestamp: number;
  }>;
}

/** Search parameters for L1 memory search. */
/** 中文：L1内存搜索的搜索参数. */
export interface MemorySearchParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

/** Search parameters for L0 conversation search. */
/** 中文：L0对话搜索的搜索参数. */
export interface ConversationSearchParams {
  query: string;
  limit?: number;
  sessionKey?: string;
}
