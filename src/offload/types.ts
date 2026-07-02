/**
 * Core type definitions for the context offload plugin.
 * Ported from context-offload-plugin with updated runtime defaults.
 * 中文：上下文卸载插件的核心类型定义。
 * 从context-offload-plugin移植并更新了运行时默认值。
 */

import type { Logger } from "../core/types.js";

// ============================
// Data types
// ============================
// 中文：数据类型

/** A single offloaded tool call/result summary stored in offload.jsonl */
/** 中文：单个卸载工具调用/结果摘要，存储在offload.jsonl中 */
export interface OffloadEntry {
  /** ISO timestamp inherited from the original tool result */
  /** 中文：继承自原始工具结果的ISO时间戳 */
  timestamp: string;
  /** Mermaid node ID assigned by L2, null until L2 runs */
  /** 中文：由L2分配的Mermaid节点ID，在L2运行前为空 */
  node_id: string | null;
  /** Short description of the tool call command */
  /** 中文：工具调用命令的简要描述 */
  tool_call: string;
  /** LLM-generated summary of the tool result */
  /** 中文：LLM生成的工具结果总结 */
  summary: string;
  /** Relative path to the MD file containing the full tool result */
  /** 中文：包含完整工具结果的MD文件的相对路径 */
  result_ref: string;
  /** The original tool call ID from the provider */
  /** 中文：提供者的原始工具调用ID */
  tool_call_id: string;
  /** Session key this entry belongs to */
  /** 中文：此条目所属的会话密钥 */
  session_key?: string;
  /** Replaceability score (0-10). Higher = summary can better replace original. Assigned by L1 LLM. */
  /** 中文：可替换性评分（0-10）。越高表示摘要能更好地替代原始内容。由L1语言模型分配。 */
  score?: number;
}

/** A buffered tool call + result pair waiting to be processed by L1 */
/** 中文：缓冲的工具调用+结果对，等待被L1处理 */
export interface ToolPair {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown> | string;
  result: unknown;
  error?: string;
  timestamp: string;
  durationMs?: number;
}

/** Persistent plugin state saved to state.json */
/** 中文：插件持久化状态保存到state.json */
export interface PluginState {
  /** Path to the currently active MMD file (relative to mmds/) */
  /** 中文：当前活动MMD文件的路径（相对于mmds/） */
  activeMmdFile: string | null;
  /** Identifier/label for the active MMD */
  /** 中文：活动MMD的标识/标签 */
  activeMmdId: string | null;
  /** Counter for auto-incrementing MMD filenames */
  /** 中文：自增命名MMD文件名的计数器 */
  mmdCounter: number;
  /** Last session key the plugin was active in */
  /** 中文：插件上次活跃的会话键 */
  lastSessionKey: string | null;
  /** Last tool_call_id that was successfully offloaded into compact context (L3 cursor) */
  /** 中文：成功卸载到紧凑上下文中的最后一个tool_call_id（L3光标） */
  lastOffloadedToolCallId: string | null;
  /** ISO timestamp of the last successful L2 trigger */
  /** 中文：最后一次成功的L2触发的ISO时间戳 */
  lastL2TriggerTime: string | null;
}

/** Metadata block embedded in MMD files */
/** 中文：嵌入在MMD文件中的元数据块 */
export interface MmdMetadata {
  taskGoal: string;
  createdTime: string;
  updatedTime: string;
}

/** A node in the Mermaid flowchart */
/** 中文：Mermaid流程图中的一个节点 */
export interface MmdNode {
  id: string;
  label: string;
  status: "done" | "doing" | "todo";
  summary: string;
  timestamp: string;
}

// ============================
// LLM types
// ============================
// 中文：LLM类型

/** Configuration for the LLM client */
/** 中文：LLM客户端配置 */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Result from L1.5 task judgment */
/** 中文：L1.5任务判断结果 */
export interface TaskJudgment {
  /** Whether the current task is completed */
  /** 中文：当前任务是否完成 */
  taskCompleted: boolean;
  /** Whether the new task is a continuation of a recent task */
  /** 中文：新任务是否为最近任务的延续 */
  isContinuation: boolean;
  /** If continuation, which MMD file to reactivate */
  /** 中文：如果是延续，请重新激活哪个MMD文件 */
  continuationMmdFile?: string;
  /** Short label for new task (used in MMD filename) */
  /** 中文：新任务的简短标签（用于MMD文件名） */
  newTaskLabel?: string;
  /** Whether this is a long task (vs. casual chat) */
  /** 中文：此任务是否为长期任务（与随意聊天区别） */
  isLongTask: boolean;
}

/** L1.5 boundary marker: divides entries into task-attributed segments.
 *  Each boundary defines the ownership of entries from startIndex onward
 * 中文：L1.5边界标记：将条目分为由任务归属的部分。每个边界的起始索引定义了从该索引及以后的所有条目的所有权直到下一个边界的起始索引。
 *  until the next boundary's startIndex. */
export interface L15Boundary {
  /** Entry counter value when L1.5 judgment started.
   * 中文：L1.5判断开始时的条目计数值。此索引及其之后的所有条目属于该边界的成果。
   *  Entries at this index and beyond belong to this boundary's result. */
  startIndex: number;
  /** L1.5 judgment result for this segment */
  /** 中文：此段落的L1.5判断结果 */
  result: "long" | "short" | "pending";
  /** If result="long", the target MMD file for L2 to construct into */
  /** 中文：如果result="long"，则为目标L2构建的MMD文件 */
  targetMmd: string | null;
}

/** Result from an LLM call */
/** 中文：从LLM调用结果 */
export interface LlmResponse {
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** OpenClaw config model provider shape (minimal) */
/** 中文：OpenClaw配置模型提供者形状（最小值） */
export interface ModelProvider {
  baseUrl?: string;
  apiKey?: string;
  models?: Record<string, unknown>;
}

// ============================
// Plugin configuration
// ============================
// 中文：插件配置

/**
 * Plugin configuration, read from openclaw.json -> plugins.entries config.
 * All fields are optional; defaults are used when not specified.
 * 中文：插件配置，从openclaw.json -> plugins.entries配置读取。所有字段均为可选；未指定时使用默认值
 */
export interface PluginConfig {
  /** Explicit LLM model for offload tasks, format: "provider/model-id" (e.g. "dashscope/kimi-k2.5") */
  /** 中文：用于卸载任务的显式LLM模型，格式："provider/model-id"（例如："dashscope/kimi-k2.5"） */
  model?: string;
  /** LLM temperature for offload tasks. Default: 0.2 */
  /** 中文：卸载任务的LLM温度，默认值：0.2 */
  temperature?: number;
  /** Force-trigger L1 when pending tool pairs >= this threshold. Default: 4 */
  /** 中文：当待处理工具对数>=此阈值时强制触发L1。默认值：4 */
  forceTriggerThreshold?: number;
  /** Custom data directory path (absolute). Default: ~/.openclaw/context-offload */
  /** 中文：自定义数据目录路径（绝对路径）。默认：~/.openclaw/context-offload */
  dataDir?: string;
  /** Default context window size when not found in model config. Default: 200000 */
  /** 中文：未在模型配置中找到时，默认上下文窗口大小。默认：200000 */
  defaultContextWindow?: number;
  /** Max tool pairs to process per L1 batch. Default: 20 */
  /** 中文：每级1次批处理中要处理的最大工具对数。默认：20 */
  maxPairsPerBatch?: number;
  /** Trigger L2 when offload.jsonl has >= this many node_id=null entries. Default: 4 */
  /** 中文：当offload.jsonl中有等于或大于此数量的node_id=null条目时触发L2。默认：4 */
  l2NullThreshold?: number;
  /** Trigger L2 if it hasn't run for this many seconds. Default: 300 (5 minutes) */
  /** 中文：如果未运行超过此秒数则触发L2。默认：300（5分钟） */
  l2TimeoutSeconds?: number;
  /**
   * If L2 leaves entries in `node_id="wait"` (e.g. parse/mapping failure),
   * those entries will be retried after waiting for at least this many seconds.
   * Default: 120
   * 中文：如果L2在`node_id="wait"`中留下条目（例如解析/映射失败），这些条目将在等待至少此秒数后重试。默认：120
   */
  l2WaitRetrySeconds?: number;
  /**
   * If true (default), time-based L2 only runs when at least one `node_id=null` entry has
   * `timestamp` strictly after `lastL2TriggerTime` (i.e. new offload rows since last L2).
   * Does not affect condition A (null count threshold). Set false for legacy timeout retry of stale nulls.
   * 中文：如果为真（默认），基于时间的L2仅在至少有一个`node_id=null`条目的`timestamp`严格晚于`lastL2TriggerTime`时运行（即上次L2以来的新卸载行）。不影响条件A（空值计数阈值）。设置为假以使用旧的超时重试过期的空值
   */
  l2TimeTriggerRequiresNewOffload?: boolean;
  /** Mild offload: replace non-current-task tool results when context >= this ratio. Default: 0.5 */
  /** 中文：轻度卸载：当上下文大于等于此比例时替换非当前任务工具结果。默认：0.5 */
  mildOffloadRatio?: number;
  /** Mild offload scan range: scan the last N% of messages (0.7 = last 70%). Default: 0.7 */
  /** 中文：轻度卸载扫描范围：扫描最后N%的消息（0.7=最后70%）。默认：0.7 */
  mildOffloadScanRatio?: number;
  /** Mild offload phase-1: replace top N% highest-score (most replaceable) entries first. Default: 0.4 */
  /** 中文：轻度卸载阶段-1：首先替换最高分N%（最具可替换性）条目。默认：0.4 */
  mildScoreTopRatio?: number;
  /** Mild offload: only trigger when current task messages occupy >= this ratio of total tokens. Default: 0.8 */
  /** 中文：轻度卸载：仅在当前任务消息占用总令牌数>=此比例时触发。默认：0.8 */
  mildCurrentTaskRatio?: number;
  /** Aggressive compress: delete tail messages when context >= this ratio. Default: 0.85 */
  /** 中文：激进压缩：当上下文>=此比例时删除尾部消息。默认：0.85 */
  aggressiveCompressRatio?: number;
  /**
   * Aggressive compress: target fraction of **message** tokens to remove from the **oldest**
   * messages each round (0.4 ≈ oldest 40% of total per-message token sum). Default: 0.4
   * 中文：激进压缩：每轮从最旧的消息中移除目标分数的**消息**令牌（0.4≈最旧40%的消息总令牌和）。默认：0.4
   */
  aggressiveDeleteRatio?: number;
  /** Emergency trigger: when tokens >= contextWindow * emergencyCompressRatio, fire emergency. Default: 0.95 */
  /** 中文：紧急触发：当令牌数>=上下文窗口*紧急压缩比例时，触发紧急情况。默认：0.95 */
  emergencyCompressRatio?: number;
  /** Emergency target: delete until tokens <= contextWindow * emergencyTargetRatio. Default: 0.6 */
  /** 中文：紧急目标：删除直到令牌数<=上下文窗口*紧急目标比例。默认：0.6 */
  emergencyTargetRatio?: number;
  /** Max ratio of total tokens that injected MMDs may occupy. Default: 0.2 */
  /** 中文：注入MMD的最大总令牌占比。默认：0.2 */
  mmdMaxTokenRatio?: number;
  /**
   * L3 token counting: `tiktoken` uses js-tiktoken (exact BPE for chosen encoding);
   * `heuristic` uses 中文/1.7 + 其余/4. Default: tiktoken.
   */
  l3TokenCountMode?: "tiktoken" | "heuristic";
  /**
   * tiktoken encoding when `l3TokenCountMode` is `tiktoken`.
   * Typical: `o200k_base` (GPT-4o/o-series), `cl100k_base` (GPT-4/3.5). Default: o200k_base.
   * 中文：当`l3TokenCountMode`为`tiktoken`时的tiktoken编码。
   * 典型：`o200k_base`（GPT-4o/o系列），`cl100k_base`（GPT-4/3.5）。默认：o200k_base。
   */
  l3TiktokenEncoding?:
    | "gpt2"
    | "r50k_base"
    | "p50k_base"
    | "p50k_edit"
    | "cl100k_base"
    | "o200k_base";
  /**
   * Default ratio of context window assumed to be system overhead (system prompt +
   * tool schemas). Used when no cached overhead is available from llm_input hook.
   * Default: 0.12 (12%).
   * 中文：假设上下文窗口的默认比例为系统开销（系统提示 + 工具模式）。当从llm_input钩子无法获取缓存的开销时使用。
   * 默认：0.12（12%）.
   */
  defaultSystemOverheadRatio?: number;
}

// ============================
// Logger interface
// ============================
// 中文：日志接口

/** Logger interface used by offload plugin components */
/** 中文：由卸载插件组件使用的日志接口 */
export type PluginLogger = Logger;

// ============================
// Plugin defaults
// ============================
// 中文：插件默认值

/** Defaults for all configurable values (sourced from runtime .js) */
/** 中文：所有可配置值的默认设置（来自运行时.js） */
export const PLUGIN_DEFAULTS = {
  temperature: 0.2,
  forceTriggerThreshold: 4,
  defaultContextWindow: 200_000,
  maxPairsPerBatch: 20,
  l2NullThreshold: 4,
  l2TimeoutSeconds: 300,
  /** If L2 leaves entries in node_id="wait", retry after this many seconds */
  /** 中文：如果L2在node_id="wait"中留下条目，则在此秒数后重试 */
  l2WaitRetrySeconds: 120,
  /** When true, time-based L2 only fires if some node_id=null row is newer than last L2 */
  /** 中文：当为true时，时间基L2仅在某些node_id=null行比上次L2更新时触发 */
  l2TimeTriggerRequiresNewOffload: true,
  mildOffloadRatio: 0.5,
  mildOffloadScanRatio: 0.7,
  mildScoreTopRatio: 0.4,
  mildCurrentTaskRatio: 0.8,
  aggressiveCompressRatio: 0.85,
  aggressiveDeleteRatio: 0.4,
  /** Emergency trigger: when tokens >= contextWindow * 0.95, fire emergency */
  /** 中文：紧急触发：当tokens >= contextWindow * 0.95时，触发紧急情况 */
  emergencyCompressRatio: 0.95,
  /** Emergency target: delete until tokens <= contextWindow * 0.6 */
  /** 中文：紧急目标：删除直到tokens <= contextWindow * 0.6 */
  emergencyTargetRatio: 0.6,
  mmdMaxTokenRatio: 0.2,
  l3TokenCountMode: "tiktoken" as const,
  l3TiktokenEncoding: "cl100k_base" as const,
  defaultSystemOverheadRatio: 0.12,
} as const;
