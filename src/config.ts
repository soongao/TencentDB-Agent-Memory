/**
 * Plugin configuration types and parser (v3).
 *
 * Config is organized into flat functional groups:
 *   capture, extraction, persona, pipeline, recall, embedding
 *
 * Minimal config (zero config): {} — all fields have sensible defaults.
 * 中文：插件配置类型和解析器（v3）。
 * 配置组织成扁平的功能组：
 * capture, extraction, persona, pipeline, recall, embedding
 * 最小化配置（零配置）：{}——所有字段都有合理的默认值。
 */

import type { DisableThinkingStrategy } from "./utils/no-think-fetch.js";
import { normalizeDisableThinking } from "./utils/no-think-fetch.js";

// ============================
// Type definitions
// ============================
// 中文：类型定义

/** Capture settings — controls L0 conversation recording. */
/** 中文：捕获设置 — 控制L0对话录制。 */
export interface CaptureConfig {
  /** Enable auto-capture (default: true) */
  /** 中文：启用自动捕获（默认：true） */
  enabled: boolean;
  /** Glob patterns to exclude agents (e.g. "bench-judge-*"); matched agents are fully ignored */
  /** 中文：排除代理的通配符模式（例如"bench-judge-*"）；匹配的代理将被完全忽略 */
  excludeAgents: string[];
  /**
   * L0/L1 local file retention days used as TTL switch.
   * 0 means cleanup disabled.(default: 0)
   * 中文：L0/L1本地文件保留天数用作TTL开关。
   * 0表示清理禁用。（默认：0）
   */
  l0l1RetentionDays: number;

  /**
   * Allow dangerous low retention (1 or 2 days).
   * Default false: when disabled, non-zero retention must be >= 3.
   * 中文：允许危险的低保留时间（1或2天）。
   * 默认false：当禁用时，非零保留必须>=3。
   */
  allowAggressiveCleanup: boolean;
}

/** Extraction settings (L1) — controls memory extraction from conversations. */
/** 中文：提取设置（L1） — 控制对话内容的内存提取。 */
export interface ExtractionConfig {
  /** Enable background extraction (default: true) */
  /** 中文：启用背景提取（默认：true） */
  enabled: boolean;
  /** Enable L1 smart dedup (default: true) */
  /** 中文：启用L1智能去重（默认：true） */
  enableDedup: boolean;
  /** Max memories per session (default: 20) */
  /** 中文：每个会话的最大内存（默认：20） */
  maxMemoriesPerSession: number;
  /** LLM model for extraction, format: "provider/model" (falls back to OpenClaw default model when omitted) */
  /** 中文：提取所用的LLM模型，格式："提供者/模型"（省略时退回到OpenClaw默认模型） */
  model?: string;
}

/** Persona (L2/L3) settings — controls scene extraction (L2) and user profile generation (L3). */
/** 中文：人物设置（L2/L3）——控制场景提取（L2）和用户画像生成（L3）。 */
export interface PersonaConfig {
  /** Trigger persona generation every N new memories (default: 50) */
  /** 中文：每N条新记忆触发一次人物生成（默认：50） */
  triggerEveryN: number;
  /** Max scene blocks (default: 15) */
  /** 中文：最大场景块数（默认：15） */
  maxScenes: number;
  /** Persona backup count (default: 3) */
  /** 中文：人物备份数量（默认：3） */
  backupCount: number;
  /** Scene blocks backup count (default: 10) */
  /** 中文：场景块备份数量（默认：10） */
  sceneBackupCount: number;
  /** LLM model for persona generation, format: "provider/model" (falls back to OpenClaw default model when omitted) */
  /** 中文：用于人物生成的LLM模型，格式："提供者/模型"（省略时退回到OpenClaw默认模型） */
  model?: string;
}

/** Pipeline trigger settings (L1→L2→L3 scheduling). */
/** 中文：管道触发设置（L1→L2→L3调度）。 */
export interface PipelineTriggerConfig {
  /** Trigger L1 after every N conversation rounds (default: 5) */
  /** 中文：每N轮对话后触发L1（默认：5） */
  everyNConversations: number;
  /** Enable warm-up: start threshold at 1, double after each L1 (1→2→4→...→everyN) (default: true) */
  /** 中文：启用预热：起始阈值为1，每次L1后翻倍（1→2→4→...→everyN）（默认：true） */
  enableWarmup: boolean;
  /** L1 idle timeout: trigger L1 after this many seconds of inactivity (default: 600) */
  /** 中文：L1空闲超时：在无活动此秒数后触发L1（默认：600） */
  l1IdleTimeoutSeconds: number;
  /** L2 delay after L1: wait this many seconds after L1 completes before triggering L2 (default: 10) */
  /** 中文：L2 L1后延迟：L1完成后等待此秒数再触发L2（默认：10） */
  l2DelayAfterL1Seconds: number;
  /** L2 min interval: minimum seconds between L2 runs per session (default: 900 = 15 min) */
  /** 中文：L2最小间隔：每会话L2运行之间的最短秒数（默认：900 = 15分钟） */
  l2MinIntervalSeconds: number;
  /** L2 max interval: even without new conversations, trigger L2 at most this often per session (default: 3600 = 60 min) */
  /** 中文：L2最大间隔：即使没有新对话，每会话最多触发L2此频率（默认：3600 = 60分钟） */
  l2MaxIntervalSeconds: number;
  /** Sessions inactive longer than this (hours) stop L2 polling (default: 24) */
  /** 中文：如果会话闲置超过此时间（小时），停止L2轮询（默认：24） */
  sessionActiveWindowHours: number;
}

/** Recall settings — controls memory retrieval for context injection. */
/** 中文：回忆设置 — 控制上下文注入时的记忆检索。 */
export interface RecallConfig {
  /** Enable auto-recall (default: true) */
  /** 中文：启用自动回忆（默认：true） */
  enabled: boolean;
  /** Max results to return (default: 5) */
  /** 中文：返回的最大结果数（默认：5） */
  maxResults: number;
  /** Max characters injected for a single recalled L1 memory. 0 disables the per-memory limit. */
  /** 中文：单个召回的L1记忆最多注入字符数。0禁用每个记忆的限制。 */
  maxCharsPerMemory: number;
  /** Max total characters injected for all recalled L1 memories. 0 disables the total limit. */
  /** 中文：所有召回的L1记忆总共最多注入字符数。0禁用总量限制。 */
  maxTotalRecallChars: number;
  /** Minimum score threshold (default: 0.3) */
  /** 中文：最小分数阈值（默认：0.3） */
  scoreThreshold: number;
  /** Search strategy (default: "hybrid") */
  /** 中文：搜索策略（默认: "hybrid"） */
  strategy: "embedding" | "keyword" | "hybrid";
  /** Overall recall timeout in milliseconds (default: 5000). When exceeded, recall is skipped with a warning. */
  /** 中文：总体召回超时毫秒数（默认: 5000）。超过此时间将跳过召回并发出警告。 */
  timeoutMs: number;
}

/** Embedding service configuration for vector search. */
/** 中文：向量搜索的嵌入服务配置。 */
export interface EmbeddingConfig {
  /** User-facing default is true in schema, but provider="none" still disables embedding effectively. */
  /** 中文：在模式中用户面向默认为 true，但 provider="none" 仍会有效禁用嵌入。 */
  enabled: boolean;
  /** Embedding provider: default "none" disables vector search; other values (e.g. "openai", "deepseek") are treated as OpenAI-compatible remote providers. */
  /** 中文：嵌入提供者：默认 "none" 禁用向量搜索；其他值（例如 "openai", "deepseek"）被视为与 OpenAI 兼容的远程提供者。 */
  provider: string;
  /** API Base URL (required for remote provider). */
  /** 中文：API 基础 URL（对于远程提供者是必需的）。 */
  baseUrl: string;
  /** API Key (required for remote provider). */
  /** 中文：API 密钥（对于远程提供者是必需的）。 */
  apiKey: string;
  /** Model name (required for remote provider). */
  /** 中文：模型名称（对于远程提供者是必需的）。 */
  model: string;
  /** Vector dimensions (required for remote provider, must match model). */
  /** 中文：向量维度（对于远程提供者是必需的，必须与模型匹配）. */
  dimensions: number;
  /**
   * Whether to send the `dimensions` field in the embeddings request body.
   * Default true (compatible with OpenAI text-embedding-3-* Matryoshka models).
   * Set to false for self-hosted / OSS models that reject unknown `dimensions`
   * (e.g. BGE-M3, which returns HTTP 400 "does not support matryoshka representation").
   * 中文：是否在嵌入请求主体中发送`dimensions`字段。
   * 默认为true（兼容OpenAI text-embedding-3-* Matryoshka模型）。
   * 对于拒绝未知`dimensions`的自托管/对象存储模型（例如BGE-M3，返回HTTP 400“不支持Matryoshka表示”），设置为false。
   */
  sendDimensions: boolean;
  /** Top-K candidates to recall during conflict detection (default: 5) */
  /** 中文：冲突检测期间要召回的Top-K候选者（默认值：5） */
  conflictRecallTopK: number;
  /** Proxy URL for qclaw provider — when provider="qclaw", requests are forwarded through this local proxy */
  /** 中文：qclaw提供者的代理URL——当provider="qclaw"时，请求将通过此本地代理转发 */
  proxyUrl?: string;
  /** Max input text length in characters before truncation (default: 5000). Texts exceeding this limit are truncated with a warning. */
  /** 中文：在字符数超过此限制之前进行截断的最大输入文本长度（默认值：5000）。超过此限制的文本会带有警告被截断。 */
  maxInputChars: number;
  /** Timeout per embedding API call in milliseconds (default: 10000). */
  /** 中文：每次嵌入API调用的超时时间（以毫秒为单位，默认值：10000）. */
  timeoutMs: number;
  /** Override timeoutMs for recall-path embedding calls (user-facing, should be shorter). Falls back to timeoutMs. */
  /** 中文：覆盖召回路径嵌入调用的timeoutMs（面向用户，应较短），否则回退到timeoutMs。 */
  recallTimeoutMs?: number;
  /** Override timeoutMs for capture-path embedding calls (background L1 dedup, can be longer). Falls back to timeoutMs. */
  /** 中文：覆盖捕获路径嵌入调用的timeoutMs（后台L1去重，可以较长），否则回退到timeoutMs。 */
  captureTimeoutMs?: number;
  /** Internal-only local model cache directory, not exposed in plugin schema. */
  /** 中文：仅内部使用的本地模型缓存目录，不在插件方案中公开。 */
  modelCacheDir?: string;
  /** If set, contains an error message about invalid remote config (embedding is disabled) */
  /** 中文：如果设置，则包含关于无效远程配置的错误消息（嵌入已禁用） */
  configError?: string;
}

/** Daily cleaner settings for local JSONL data (L0/L1). */
/** 中文：本地JSONL数据（L0/L1）的日清理设置。 */
export interface MemoryCleanupConfig {
  /** TTL switch from capture.l0l1RetentionDays. Undefined means disabled. */
  /** 中文：TTL开关来自capture.l0l1RetentionDays。未定义表示禁用。 */
  retentionDays?: number;

  /** Whether cleanup is enabled. True only when retentionDays is a valid positive number. */
  /** 中文：是否启用清理。仅当保留天数为有效正数时才为True。 */
  enabled: boolean;
  /** Daily execution time in HH:mm format (default: 03:00). */
  /** 中文：每日执行时间HH:mm格式，默认：03:00。 */
  cleanTime: string;
}

/** BM25 sparse vector encoding configuration (local @tencentdb-agent-memory/tcvdb-text). */
/** 中文：BM25稀疏向量编码配置（本地@tencentdb-agent-memory/tcvdb-text）。 */
export interface BM25Config {
  /** Whether BM25 sparse encoding is enabled (default: true) */
  /** 中文：是否启用BM25稀疏编码，默认：true */
  enabled: boolean;
  /** Language for BM25 pre-trained params: "zh" or "en" (default: "zh") */
  /** 中文：BM25预训练参数语言:"zh"或"en"（默认:"zh"） */
  language: "zh" | "en";
}

/** Tencent Cloud VectorDB configuration. */
/** 中文：腾讯云向量数据库配置。 */
export interface TcvdbConfig {
  /** Instance URL (e.g. "http://10.0.1.1:80" or external domain) */
  /** 中文：实例URL（例如:"http://10.0.1.1:80"或外部域名） */
  url: string;
  /** Account name (default: "root") */
  /** 中文：账户名（默认:"root"） */
  username: string;
  /** API Key */
  /** 中文：API密钥 */
  apiKey: string;
  /** Database name (auto-generated from instance_id if empty) */
  /** 中文：数据库名称（如果为空则自动生成，来自instance_id） */
  database: string;
  /** User-friendly alias for this database (optional, for identification in database.json) */
  /** 中文：此数据库的用户友好别名（可选，在database.json中标识用） */
  alias: string;
  /** Built-in embedding model (default: "bge-large-zh") */
  /** 中文：内置嵌入模型（默认:"bge-large-zh"） */
  embeddingModel: string;
  /** Request timeout in ms (default: 10000) */
  /** 中文：请求超时时间（单位：毫秒，默认值：10000) */
  timeout: number;
  /** Path to CA certificate PEM file (for HTTPS connections) */
  /** 中文：CA证书PEM文件路径（用于HTTPS连接） */
  caPemPath?: string;
}

/** Storage backend type. */
/** 中文：存储后端类型。 */
export type StoreBackend = "sqlite" | "tcvdb";

/** Report settings — controls metric/event reporting. */
/** 中文：报告设置 — 控制指标/事件上报。 */
export interface ReportConfig {
  /** Enable reporting (default: false) */
  /** 中文：启用上报（默认值：false） */
  enabled: boolean;
  /** Reporter type: "local" logs structured JSON via logger (default: "local") */
  /** 中文：上报类型："local"通过日志记录结构化JSON（默认值："local"） */
  type: string;
}

/**
 * Standalone LLM configuration — when set, TDAI uses direct API calls
 * instead of the host's built-in LLM runner (e.g. OpenClaw's runEmbeddedPiAgent).
 *
 * This allows using a different (often cheaper/faster) model for memory
 * extraction while the main agent uses a premium model.
 *
 * Leave undefined (default) to use the host's native LLM mechanism.
 * 中文：独立LLM配置 — 设置时，TDAI将使用直接API调用而不是宿主内置的LLM运行器（例如OpenClaw的runEmbeddedPiAgent）。这允许使用不同的（通常更便宜/更快）模型进行内存提取，而主要代理则使用高级模型。留空（默认值）将使用宿主的原生LLM机制。
 */
export interface StandaloneLLMOverrideConfig {
  /** Enable standalone LLM mode (default: false). When false, uses host LLM. */
  /** 中文：启用独立LLM模式（默认值：false）。为假时，使用宿主LLM。 */
  enabled: boolean;
  /** OpenAI-compatible API base URL (e.g. "https://api.openai.com/v1"). */
  /** 中文：OpenAI兼容的API基础URL（例如"https://api.openai.com/v1"）。 */
  baseUrl: string;
  /** API key for authentication. */
  /** 中文：用于身份验证的API密钥。 */
  apiKey: string;
  /** Model name (e.g. "gpt-4o", "deepseek-v3", "claude-sonnet-4-6"). */
  /** 中文：模型名称（例如"gpt-4o", "deepseek-v3", "claude-sonnet-4-6"）。 */
  model: string;
  /** Max output tokens (default: 4096). */
  /** 中文：最大输出令牌数（默认：4096）。 */
  maxTokens: number;
  /** Request timeout in milliseconds (default: 120000). */
  /** 中文：请求超时时间，单位为毫秒（默认：120000）。 */
  timeoutMs: number;
  /**
   * Controls how thinking/reasoning is disabled for the LLM endpoint (default: false).
   * - `false`: no thinking-disabling wrapper (default)
   * - `"vllm"`: vLLM/SGLang — `chat_template_kwargs: { enable_thinking: false }`
   * - `"deepseek"`: DeepSeek official API — top-level `enable_thinking: false`
   * - `"dashscope"`: Alibaba DashScope (Qwen) — top-level `enable_thinking: false`
   * - `"openai"`: OpenAI o-series — `reasoning_effort: "low"` (cannot fully disable)
   * - `"anthropic"` / `"kimi"`: Anthropic Claude / Kimi (Moonshot) — `thinking: { type: "disabled" }`
   * - `"gemini"`: Google Gemini — `thinking_config: { thinking_budget: 0 }`
   * 中文：控制LLM端点如何禁用思考/推理（默认：false）
   * - `false`：无思考禁用包装器（默认）
   * - `"vllm"`：vLLM/SGLang — `chat_template_kwargs: { enable_thinking: false }`
   * - `"deepseek"`：DeepSeek官方API — 高级层 `enable_thinking: false`
   * - `"dashscope"`：阿里云DashScope（Qwen）— 高级层 `enable_thinking: false`
   * - `"openai"`：OpenAI o系列 — `reasoning_effort: "low"`（无法完全禁用）
   * - `"anthropic"` / `"kimi"`：Anthropic Claude / Kimi（Moonshot）— `thinking: { type: "disabled" }`
   * - `"gemini"`：Google Gemini — `thinking_config: { thinking_budget: 0 }`
   */
  disableThinking: DisableThinkingStrategy;
}

/** Context Offload settings — controls multi-layer context compression. */
/** 中文：上下文卸载设置 — 控制多层上下文压缩。 */
export interface OffloadConfig {
  /** Enable context offload (default: false) */
  /** 中文：启用上下文卸载（默认：false） */
  enabled: boolean;
  /**
   * LLM execution mode for L1/L1.5/L2 tasks.
   * - "local": call LLM directly via AI SDK (uses offload.model or main agent model)
   * - "backend": route through remote backend service (requires backendUrl)
   * - "collect": data collection only — runs L1/L1.5/L2 asynchronously but disables
   *   L3 compression and does NOT occupy the contextEngine slot (uses legacy compaction)
   * Default: "local" (auto-detects based on backendUrl presence for backward compat)
   * 中文：L1/L1.5/L2任务的LLM执行模式。
   * - "local": 直接通过AI SDK调用LLM（使用offload.model或主代理模型）
   * - "backend": 路由至远程后端服务（需要backendUrl）
   * - "collect": 仅数据收集 — 异步运行L1/L1.5/L2但禁用L3压缩且不占用contextEngine插槽（使用遗留压缩方式）
   * 默认: "local"（根据backendUrl存在自动检测以保持向后兼容）
   */
  mode: "local" | "backend" | "collect";
  /** LLM model for offload tasks, format: "provider/model-id". Falls back to agents.defaults.model when omitted. */
  /** 中文：offload任务的LLM模型，格式: "provider/model-id"。省略时退回到agents.defaults.model。 */
  model?: string;
  /** LLM temperature (default: 0.2) */
  /** 中文：LLM温度，默认值: 0.2 */
  temperature: number;
  /**
   * Controls how thinking/reasoning is disabled for the offload local-mode LLM (default: false).
   * See `StandaloneLLMOverrideConfig.disableThinking` for the full list of strategies.
   * Applies only to `mode: "local"`.
   * 中文：控制offload本地模式LLM禁用思考/推理的方式（默认值: false）。
   * 参见`StandaloneLLMOverrideConfig.disableThinking`以获取完整策略列表。
   * 仅适用于`mode: "local"`。
   */
  disableThinking: DisableThinkingStrategy;
  /** Force-trigger L1 when pending tool pairs >= this threshold (default: 4) */
  /** 中文：当待处理工具对数>=此阈值时强制触发L1（默认值: 4） */
  forceTriggerThreshold: number;
  /** Custom data directory (absolute path). Default: ~/.openclaw/context-offload */
  /** 中文：自定义数据目录（绝对路径）。默认值: ~/.openclaw/context-offload */
  dataDir?: string;
  /** Default context window size (default: 200000) */
  /** 中文：默认上下文窗口大小，默认值: 200000 */
  defaultContextWindow: number;
  /** Max tool pairs per L1 batch (default: 20) */
  /** 中文：每个L1批次的最大工具对数，默认值: 20 */
  maxPairsPerBatch: number;
  /** Trigger L2 when node_id=null entries >= this count (default: 4) */
  /** 中文：当node_id=null条目>=此数量时触发L2（默认：4） */
  l2NullThreshold: number;
  /** Trigger L2 if hasn't run for this many seconds (default: 300) */
  /** 中文：如果未运行超过此秒数则触发L2（默认：300） */
  l2TimeoutSeconds: number;
  /** Mild compression ratio threshold (default: 0.5) */
  /** 中文：轻度压缩比率阈值（默认：0.5） */
  mildOffloadRatio: number;
  /** Aggressive compression ratio threshold (default: 0.85) */
  /** 中文：激进压缩比率阈值（默认：0.85） */
  aggressiveCompressRatio: number;
  /** MMD injection token budget ratio (default: 0.2) */
  /** 中文：MMD注入令牌预算比率（默认：0.2） */
  mmdMaxTokenRatio: number;
  /** Backend service URL. When set, L1/L1.5/L2/L4 LLM calls go through the backend. */
  /** 中文：后端服务URL。设置时，L1/L1.5/L2/L4语言模型调用将通过后端进行. */
  backendUrl?: string;
  /** Backend API authentication token */
  /** 中文：后端API认证令牌 */
  backendApiKey?: string;
  /** Backend call timeout in milliseconds (default: 10000) */
  /** 中文：后端调用超时时间毫秒数（默认：10000） */
  backendTimeoutMs: number;
  /**
   * Offload data retention days. Sessions/refs/mmds older than this are cleaned up.
   * 0 = disabled (default). Values in (0, 3) are treated as invalid and forced to 0.
   * Minimum effective value: 3.
   * 中文：卸载数据保留天数。超过此时间的数据（会话/引用/mmds）将被清理。
   * 0 = 禁用（默认）。值在(0, 3)之间的被视为无效并强制设为0。
   * 最小有效值：3。
   */
  offloadRetentionDays: number;
  /**
   * Max total size in MB for offload debug log files (*.log in dataRoot).
   * When exceeded, the largest logs are truncated to zero.
   * 0 = disabled. Default: 50.
   * 中文：卸载调试日志文件的最大总大小（MB），*.log 文件位于 dataRoot 目录下。超过此限制时，最大的日志文件将被截断至零。
   * 0 = 禁用。默认：50。
   */
  logMaxSizeMb: number;
  /**
   * User identifier sent as `X-User-Id` on backend requests. This is the
   * primary key used by the backend `/offload/v1/store` endpoint to upsert
   * per-user state. When omitted the plugin falls back to the machine's
   * primary non-loopback IPv4 address.
   * 中文：用户标识符作为 `X-User-Id` 发送在后端请求中。这是后端 `/offload/v1/store` 接口用于更新每个用户的状态的主键。若省略，则插件将回退到机器的主要非环回IPv4地址。
   */
  userId?: string;
}

/** Fully resolved plugin configuration (v3). */
/** 中文：完全解析的插件配置（v3）。 */
export interface MemoryTdaiConfig {
  /**
   * Timezone for user/LLM-facing timestamps and local-day boundaries.
   * - "system" (default): follow process system timezone
   * - IANA name: "Asia/Shanghai", "Europe/Berlin", "UTC"
   * - UTC offset string: "+08:00", "-05:30" (ECMA-402 2024)
   *
   * Storage instants (SQLite/TCVDB) are always UTC regardless of this setting.
   * 中文：用户/LLM 面向的时间戳和本地日界的时间区。
   * - "system"（默认）：遵循进程系统时间区
   * - IANA 名称："Asia/Shanghai"，"Europe/Berlin"，"UTC"
   * - UTC 偏移字符串："+08:00"，"-05:30"（ECMA-402 2024）
   * 存储瞬间（SQLite/TCVDB）始终为 UTC，与该设置无关。
   */
  timezone: string;
  capture: CaptureConfig;
  extraction: ExtractionConfig;
  persona: PersonaConfig;
  pipeline: PipelineTriggerConfig;
  recall: RecallConfig;
  embedding: EmbeddingConfig;
  /** Storage backend: "sqlite" (default) or "tcvdb" */
  /** 中文：存储后端："sqlite"（默认）或 "tcvdb" */
  storeBackend: StoreBackend;
  /** Tencent Cloud VectorDB configuration (required when storeBackend = "tcvdb") */
  /** 中文：腾讯云向量数据库配置（当 storeBackend = "tcvdb" 时必需） */
  tcvdb: TcvdbConfig;
  /** BM25 sparse vector encoding (local @tencentdb-agent-memory/tcvdb-text) */
  /** 中文：BM25 稀疏向量编码（本地 @tencentdb-agent-memory/tcvdb-text） */
  bm25: BM25Config;
  /** Local JSONL cleanup settings */
  /** 中文：本地JSONL清理设置 */
  memoryCleanup: MemoryCleanupConfig;
  report: ReportConfig;
  /**
   * Standalone LLM override — when enabled, TDAI bypasses the host's LLM
   * (e.g. OpenClaw's runEmbeddedPiAgent) and uses direct OpenAI-compatible
   * API calls for L1/L2/L3 extraction.
   *
   * Default: disabled (uses host LLM).
   * 中文：独立LLM覆盖——启用时，TDAI绕过主机的LLM（例如OpenClaw的runEmbeddedPiAgent），直接使用与OpenAI兼容的API调用来进行L1/L2/L3提取。
   * 默认：禁用（使用主机LLM）.
   */
  llm: StandaloneLLMOverrideConfig;
  offload: OffloadConfig;
}

// ============================
// Parser
// ============================
// 中文：解析器

/**
 * Parse plugin config from raw user input.
 * All fields have sensible defaults — minimal config is just {}.
 * 中文：从原始用户输入中解析插件配置。所有字段都有合理的默认值——最小配置只是{}。
 */
export function parseConfig(raw: Record<string, unknown> | undefined): MemoryTdaiConfig {
  const c = raw ?? {};

  // --- Capture (L0) ---
  // 中文：--- 捕获 (L0) ---
  const captureGroup = obj(c, "capture");

  // --- Retention days validation (from capture.l0l1RetentionDays) ---
  // 中文：--- 保留天数验证（来自capture.l0l1RetentionDays）---
  const rawRetentionDays = num(captureGroup, "l0l1RetentionDays") ?? 0;
  const allowAggressiveCleanup = bool(captureGroup, "allowAggressiveCleanup") ?? false;

  let retentionDays: number | undefined;
  if (rawRetentionDays <= 0) {
    retentionDays = undefined;
  } else if (rawRetentionDays >= 3) {
    retentionDays = rawRetentionDays;
  } else if (allowAggressiveCleanup) {
    retentionDays = rawRetentionDays;
  } else {
    retentionDays = undefined;
  }

  // --- Extraction (L1) ---
  // 中文：--- 提取 (L1) ---
  const extractionGroup = obj(c, "extraction");

  // --- Persona (L2/L3) ---
  // 中文：--- 人设 (L2/L3) ---
  const personaGroup = obj(c, "persona");

  // --- Pipeline ---
  // 中文：--- Pipeline ---
  const pipelineGroup = obj(c, "pipeline");

  // --- Recall ---
  // 中文：--- Recall ---
  const recallGroup = obj(c, "recall");

  // --- Embedding ---
  // 中文：--- Embedding ---
  const embeddingGroup = obj(c, "embedding");
  let embeddingConfigError: string | undefined;

  // Embedding config: determine provider based on user input and apiKey availability
  // 中文：嵌入配置：根据用户输入和apiKey可用性确定提供者
  const embeddingApiKey = str(embeddingGroup, "apiKey") ?? "";
  const embeddingBaseUrl = str(embeddingGroup, "baseUrl") ?? "";
  const embeddingProviderRaw = str(embeddingGroup, "provider") ?? "none";
  const embeddingModelRaw = str(embeddingGroup, "model") ?? "";
  const embeddingDimensionsRaw = num(embeddingGroup, "dimensions");
  const embeddingProxyUrl = str(embeddingGroup, "proxyUrl");

  // provider="none" → embedding disabled (default for zero-config users)
  // provider="local" → no longer exposed to users; treated as disabled at entry level
  // provider="qclaw" → requires proxyUrl for local proxy forwarding
  // Any other value → remote mode (requires apiKey, baseUrl, model, dimensions)
  // 中文：provider="none" → 嵌入禁用（零配置用户的默认值）
  // provider="local" → 不再向用户暴露；在入口级被视为禁用
  // provider="qclaw" → 需要proxyUrl进行本地代理转发
  // 任何其他值 → 远程模式（需要apiKey、baseUrl、model和dimensions）
  let embeddingProvider: string;
  let embeddingEnabled = bool(embeddingGroup, "enabled") ?? true;

  if (embeddingProviderRaw === "none") {
    // Explicitly disabled (default): no embedding, no vector search
    // 中文：显式禁用（默认）：无嵌入，无向量搜索
    embeddingProvider = "none";
    embeddingEnabled = false;
  } else if (embeddingProviderRaw === "local") {
    // Local embedding is not exposed to users; treat as disabled at entry level.
    // Internal LocalEmbeddingService code is preserved but not reachable from config.
    // 中文：本地嵌入不再向用户暴露；在入口级被视为禁用。
    // 内部保留LocalEmbeddingService代码但不可通过配置访问.
    embeddingProvider = "none";
    embeddingEnabled = false;
    embeddingConfigError =
      "Local embedding provider is not available in user config. " +
      "Please configure a remote embedding provider (e.g. openai, deepseek). Embedding has been disabled.";
  } else if (embeddingProviderRaw === "qclaw") {
    // qclaw provider: requires proxyUrl for local proxy forwarding
    // 中文：qclaw提供者：需要proxyUrl进行本地代理转发
    const missingFields: string[] = [];
    if (!embeddingProxyUrl) missingFields.push("proxyUrl");
    if (!embeddingBaseUrl) missingFields.push("baseUrl");
    if (!embeddingApiKey) missingFields.push("apiKey");
    if (!embeddingModelRaw) missingFields.push("model");
    if (embeddingDimensionsRaw == null || embeddingDimensionsRaw <= 0) missingFields.push("dimensions");

    if (missingFields.length > 0) {
      const errorMsg =
        `Embedding provider 'qclaw' requires 'proxyUrl', 'baseUrl', 'apiKey', 'model', and 'dimensions' to be set. ` +
        `Missing: ${missingFields.join(", ")}. Embedding has been disabled.`;
      embeddingConfigError = errorMsg;
      embeddingEnabled = false;
      embeddingProvider = embeddingProviderRaw;
    } else {
      embeddingProvider = embeddingProviderRaw;
    }
  } else {
    // Remote mode — validate all required fields
    // 中文：远端模式——验证所有必填字段
    const missingFields: string[] = [];
    if (!embeddingApiKey) missingFields.push("apiKey");
    if (!embeddingBaseUrl) missingFields.push("baseUrl");
    if (!embeddingModelRaw) missingFields.push("model");
    if (embeddingDimensionsRaw == null || embeddingDimensionsRaw <= 0) missingFields.push("dimensions");

    if (missingFields.length > 0) {
      // Configuration error: disable embedding and log detailed error
      // This does NOT throw — the plugin continues running without vector search
      // 中文：配置错误：禁用嵌入并记录详细错误
      // 这不会抛出异常——插件将继续运行而无需向量搜索
      const errorMsg =
        `Remote embedding provider '${embeddingProviderRaw}' requires 'apiKey', 'baseUrl', 'model', and 'dimensions' to be set. ` +
        `Missing: ${missingFields.join(", ")}. Embedding has been disabled.`;
      // We store the error message so the caller (index.ts) can log it
      // 中文：我们将错误信息存储起来，以便调用者（index.ts）可以记录它
      embeddingConfigError = errorMsg;
      embeddingEnabled = false;
      embeddingProvider = embeddingProviderRaw; // preserve original for error context
      // 中文：保留原始内容以保留错误上下文
    } else {
      embeddingProvider = embeddingProviderRaw;
    }
  }

  // When provider="none", dimensions=0 signals VectorStore to skip vec0 table
  // creation entirely (deferred until a real embedding provider is configured).
  // This avoids creating vec0 tables with a placeholder dimension that would
  // mismatch if the user later enables a different-dimensional provider.
  // 中文：当provider="none"时，dimensions=0指示VectorStore完全跳过vec0表的创建（延迟到配置了真正的嵌入提供程序为止）。这避免了使用占位维度创建vec0表，如果用户后来启用不同维度的提供程序，则会导致不匹配。
  const defaultDimensions =
    embeddingProvider === "none" ? 0 :
    embeddingDimensionsRaw ?? 0;
  const defaultModel = embeddingProvider === "none" ? "" : embeddingModelRaw;

  const cleanTime = normalizeCleanTime(str(captureGroup, "cleanTime")) ?? "03:00";

  // --- BM25 (local @tencentdb-agent-memory/tcvdb-text encoder) ---
  // 中文：--- BM25 （本地 @tencentdb-agent-memory/tcvdb-text 编码器）---
  const bm25Group = obj(c, "bm25");

  // --- Store backend ---
  // 中文：--- 存储后端 ---
  const storeBackendRaw = str(c, "storeBackend") ?? "sqlite";
  const storeBackend: StoreBackend = storeBackendRaw === "tcvdb" ? "tcvdb" : "sqlite";

  // --- TCVDB config ---
  // 中文：--- TCVDB 配置 ---
  const tcvdbGroup = obj(c, "tcvdb");

  const memoryCleanup: MemoryCleanupConfig = {
    retentionDays,
    enabled: retentionDays != null,
    cleanTime,
  };

  // --- Offload ---
  // 中文：--- 卸载 ---
  const offloadGroup = obj(c, "offload");

  const offloadMode: "local" | "backend" | "collect" = (() => {
    const raw = optStr(offloadGroup, "mode");
    if (raw === "local" || raw === "backend" || raw === "collect") return raw;
    return optStr(offloadGroup, "backendUrl") ? "backend" : "local";
  })();

  const offload: OffloadConfig = {
    enabled: bool(offloadGroup, "enabled") ?? false,
    mode: offloadMode,
    model: optStr(offloadGroup, "model"),
    temperature: num(offloadGroup, "temperature") ?? 0.2,
    disableThinking: normalizeDisableThinking(boolOrStr(offloadGroup, "disableThinking")),
    forceTriggerThreshold: num(offloadGroup, "forceTriggerThreshold") ?? 4,
    dataDir: optStr(offloadGroup, "dataDir"),
    defaultContextWindow: num(offloadGroup, "defaultContextWindow") ?? 200000,
    maxPairsPerBatch: num(offloadGroup, "maxPairsPerBatch") ?? 20,
    l2NullThreshold: num(offloadGroup, "l2NullThreshold") ?? 4,
    l2TimeoutSeconds: num(offloadGroup, "l2TimeoutSeconds") ?? 300,
    mildOffloadRatio: num(offloadGroup, "mildOffloadRatio") ?? 0.5,
    aggressiveCompressRatio: num(offloadGroup, "aggressiveCompressRatio") ?? 0.85,
    mmdMaxTokenRatio: num(offloadGroup, "mmdMaxTokenRatio") ?? 0.2,
    backendUrl: optStr(offloadGroup, "backendUrl"),
    backendApiKey: optStr(offloadGroup, "backendApiKey"),
    backendTimeoutMs: num(offloadGroup, "backendTimeoutMs") ?? 120000,
    offloadRetentionDays: normalizeOffloadRetentionDays(num(offloadGroup, "offloadRetentionDays") ?? 0),
    logMaxSizeMb: num(offloadGroup, "logMaxSizeMb") ?? 50,
    userId: optStr(offloadGroup, "userId"),
  };

  return {
    timezone: str(c, "timezone") ?? "system",
    capture: {
      enabled: bool(captureGroup, "enabled") ?? true,
      excludeAgents: strArray(captureGroup, "excludeAgents") ?? [],
      l0l1RetentionDays: retentionDays ?? 0,
      allowAggressiveCleanup,
    },
    extraction: {
      enabled: bool(extractionGroup, "enabled") ?? true,
      enableDedup: bool(extractionGroup, "enableDedup") ?? true,
      maxMemoriesPerSession: num(extractionGroup, "maxMemoriesPerSession") ?? 20,
      model: optStr(extractionGroup, "model"),
    },
    persona: {
      triggerEveryN: num(personaGroup, "triggerEveryN") ?? 50,
      maxScenes: num(personaGroup, "maxScenes") ?? 15,
      backupCount: num(personaGroup, "backupCount") ?? 3,
      sceneBackupCount: num(personaGroup, "sceneBackupCount") ?? 10,
      model: optStr(personaGroup, "model"),
    },
    pipeline: {
      everyNConversations: num(pipelineGroup, "everyNConversations") ?? 5,
      enableWarmup: bool(pipelineGroup, "enableWarmup") ?? true,
      l1IdleTimeoutSeconds: num(pipelineGroup, "l1IdleTimeoutSeconds") ?? 600,
      l2DelayAfterL1Seconds: num(pipelineGroup, "l2DelayAfterL1Seconds") ?? 10,
      l2MinIntervalSeconds: num(pipelineGroup, "l2MinIntervalSeconds") ?? 900,
      l2MaxIntervalSeconds: num(pipelineGroup, "l2MaxIntervalSeconds") ?? 3600,
      sessionActiveWindowHours: num(pipelineGroup, "sessionActiveWindowHours") ?? 24,
    },
    recall: {
      enabled: bool(recallGroup, "enabled") ?? true,
      maxResults: num(recallGroup, "maxResults") ?? 5,
      maxCharsPerMemory: num(recallGroup, "maxCharsPerMemory") ?? 0,
      maxTotalRecallChars: num(recallGroup, "maxTotalRecallChars") ?? 0,
      scoreThreshold: num(recallGroup, "scoreThreshold") ?? 0.3,
      strategy: validateStrategy(str(recallGroup, "strategy")) ?? "hybrid",
      timeoutMs: num(recallGroup, "timeoutMs") ?? 5000,
    },
    embedding: {
      enabled: embeddingEnabled,
      provider: embeddingProvider,
      baseUrl: embeddingBaseUrl,
      apiKey: embeddingApiKey,
      model: str(embeddingGroup, "model") ?? defaultModel,
      dimensions: num(embeddingGroup, "dimensions") ?? defaultDimensions,
      sendDimensions: bool(embeddingGroup, "sendDimensions") ?? true,
      conflictRecallTopK: num(embeddingGroup, "conflictRecallTopK") ?? 5,
      proxyUrl: embeddingProxyUrl,
      maxInputChars: num(embeddingGroup, "maxInputChars") ?? 5000,
      timeoutMs: num(embeddingGroup, "timeoutMs") ?? 10_000,
      recallTimeoutMs: num(embeddingGroup, "recallTimeoutMs") ?? undefined,
      captureTimeoutMs: num(embeddingGroup, "captureTimeoutMs") ?? undefined,
      modelCacheDir: optStr(embeddingGroup, "modelCacheDir"),
      configError: embeddingConfigError,
    },
    storeBackend,
    tcvdb: {
      url: str(tcvdbGroup, "url") ?? "",
      username: str(tcvdbGroup, "username") ?? "root",
      apiKey: str(tcvdbGroup, "apiKey") ?? "",
      database: str(tcvdbGroup, "database") ?? "",
      alias: str(tcvdbGroup, "alias") ?? "",
      embeddingModel: str(tcvdbGroup, "embeddingModel") ?? "bge-large-zh",
      timeout: num(tcvdbGroup, "timeout") ?? 10000,
      caPemPath: str(tcvdbGroup, "caPemPath") || undefined,
    },
    bm25: {
      enabled: bool(bm25Group, "enabled") ?? true,
      language: (str(bm25Group, "language") === "en" ? "en" : "zh") as "zh" | "en",
    },
    memoryCleanup,
    report: {
      enabled: bool(obj(c, "report"), "enabled") ?? false,
      type: str(obj(c, "report"), "type") ?? "local",
    },
    llm: (() => {
      const llmGroup = obj(c, "llm");
      return {
        enabled: bool(llmGroup, "enabled") ?? false,
        baseUrl: str(llmGroup, "baseUrl") ?? "https://api.openai.com/v1",
        apiKey: str(llmGroup, "apiKey") ?? "",
        model: str(llmGroup, "model") ?? "gpt-4o",
        maxTokens: num(llmGroup, "maxTokens") ?? 4096,
        timeoutMs: num(llmGroup, "timeoutMs") ?? 120_000,
        disableThinking: normalizeDisableThinking(boolOrStr(llmGroup, "disableThinking")),
      };
    })(),
    offload,
  };
}

// ============================
// Helper functions
// ============================
// 中文：辅助函数

/** Get sub-object by key, or empty object if missing. */
/** 中文：通过键获取子对象，缺失时返回空对象。 */
function obj(c: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = c[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function str(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function optStr(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" ? v : undefined;
}

function num(src: Record<string, unknown>, key: string): number | undefined {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bool(src: Record<string, unknown>, key: string): boolean | undefined {
  const v = src[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Read a field that may be boolean or string. */
/** 中文：读取可能为布尔值或字符串的字段。 */
function boolOrStr(src: Record<string, unknown>, key: string): boolean | string | undefined {
  const v = src[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function strArray(src: Record<string, unknown>, key: string): string[] | undefined {
  const v = src[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

const VALID_STRATEGIES: RecallConfig["strategy"][] = ["embedding", "keyword", "hybrid"];

/**
 * Validate recall strategy against whitelist.
 * Returns the strategy if valid, undefined otherwise (caller falls back to default).
 * 中文：验证召回策略是否在白名单中。
 * 如果有效则返回该策略，否则返回 undefined（调用者回退到默认值）。
 */
function validateStrategy(value: string | undefined): RecallConfig["strategy"] | undefined {
  if (!value) return undefined;
  return VALID_STRATEGIES.includes(value as RecallConfig["strategy"])
    ? (value as RecallConfig["strategy"])
    : undefined;
}

/**
 * Normalize a cleanup time string.
 *
 * The input must follow "HH:MM" or "H:MM" format (24-hour clock).
 * If the time is valid, it returns the normalized format "HH:MM"
 * with leading zeros added when necessary.
 * If the format is invalid or the time is out of range
 * (hour: 0–23, minute: 0–59), it returns undefined.
 *
 * Examples:
 * normalizeCleanTime("3:05")  -> "03:05"
 * normalizeCleanTime("03:05") -> "03:05"
 * normalizeCleanTime("23:59") -> "23:59"
 *
 * normalizeCleanTime("24:00") -> undefined   // hour out of range
 * normalizeCleanTime("12:60") -> undefined   // minute out of range
 * normalizeCleanTime("3:5")   -> undefined   // minute must have two digits
 * normalizeCleanTime("abc")   -> undefined   // invalid format
 * 中文：规范化清理时间字符串。
 * 输入必须遵循 "HH:MM" 或 "H:MM" 格式（24小时制）。
 * 如果时间格式正确，则返回规范化的格式 "HH:MM"
 * 并在必要时添加前导零。
 * 如果格式无效或时间超出范围
 * (小时：0–23，分钟：0–59)，则返回 undefined。
 * 示例：
 * normalizeCleanTime("3:05")  -> "03:05"
 * normalizeCleanTime("03:05") -> "03:05"
 * normalizeCleanTime("23:59") -> "23:59"
 * normalizeCleanTime("24:00") -> undefined   // 小时超出范围
 * normalizeCleanTime("12:60") -> undefined   // 分钟超出范围
 * normalizeCleanTime("3:5")   -> undefined   // 分钟必须为两位数
 * normalizeCleanTime("abc")   -> undefined   // 格式无效
 */
function normalizeCleanTime(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!m) return undefined;

  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return undefined;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return undefined;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Normalize offload retention days.
 *
 * - `<= 0` → 0 (disabled)
 * - `(0, 3)` → 0 (invalid, force disabled)
 * - `>= 3` → as-is
 * 中文：规范化卸载保留天数。
 * - `<= 0` → 0（禁用）
 * - `(0, 3)` → 0（无效，强制禁用）
 * - `>= 3` → 原样返回
 */
function normalizeOffloadRetentionDays(value: number): number {
  if (value <= 0) return 0;
  if (value < 3) return 0;
  return value;
}
