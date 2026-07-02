/**
 * Shared type definitions for the `seed` command.
 *
 * Covers:
 * - Raw input shapes (Format A / B / JSONL)
 * - Normalized internal structures
 * - Validation error descriptors
 * 中文：共享`seed`命令的类型定义。
 * 涵盖：
 * - 原始输入格式（格式A/格式B/JSONL）
 * - 标准化内部结构
 * - 验证错误描述
 */

// ============================
// Raw input types (before validation)
// ============================
// 中文：原始输入类型（在验证之前）

/** A single message in a conversation round. */
/** 中文：会话轮次中的单条消息。 */
export interface RawMessage {
  role: string;
  content: string;
  /**
   * Epoch milliseconds (number) **or** ISO 8601 string (e.g. `"2024-04-01T12:00:00Z"`).
   * ISO strings are parsed via `new Date()` during normalization and
   * stored internally as epoch ms.
   * 中文：毫秒纪元时间（数字）**或**ISO 8601字符串（例如`"2024-04-01T12:00:00Z"`）。
   * ISO字符串在标准化期间通过`new Date()`解析，并以毫秒纪元时间内部存储。
   */
  timestamp?: number | string;
}

/** A single session entry (shared between Format A wrapper and Format B array). */
/** 中文：会话条目（格式A包装器和格式B数组之间共享）. */
export interface RawSession {
  sessionKey: string;
  sessionId?: string;
  conversations: RawMessage[][];
}

/** Format A: `{ sessions: [...] }` */
/** 中文：格式A：`{ sessions: [...] }` */
export interface FormatA {
  sessions: RawSession[];
}

/** Format B: `[...]` (top-level array of sessions) */
/** 中文：格式B：`[...]`（顶级的会话数组） */
export type FormatB = RawSession[];

// ============================
// Normalized types (after validation)
// ============================
// 中文：标准化类型（在验证之后）

export interface NormalizedMessage {
  role: string;
  content: string;
  /** Epoch ms — always present after normalization (filled if originally missing). */
  /** 中文：每个周期的毫秒数——规范化后总是存在（如果原本缺失则填充）. */
  timestamp: number;
}

export interface NormalizedRound {
  messages: NormalizedMessage[];
}

export interface NormalizedSession {
  sessionKey: string;
  sessionId: string;
  rounds: NormalizedRound[];
  /** Index in the original input array (for progress reporting). */
  /** 中文：原始输入数组中的索引（用于进度报告）. */
  sourceIndex: number;
}

export interface NormalizedInput {
  sessions: NormalizedSession[];
  /** Total number of rounds across all sessions. */
  /** 中文：所有会话中轮次的总数. */
  totalRounds: number;
  /** Total number of messages across all sessions. */
  /** 中文：所有会话中消息的总数. */
  totalMessages: number;
  /** Whether timestamps were present in the original input. */
  /** 中文：原始输入中是否存在时间戳. */
  hasTimestamps: boolean;
}

// ============================
// Validation
// ============================
// 中文：验证.

/** Stages where a validation error can occur. */
/** 中文：可能发生验证错误的阶段. */
export type ValidationStage =
  | "file"
  | "top_level"
  | "session"
  | "round"
  | "message"
  | "timestamp_consistency";

/** A single validation error with location context. */
/** 中文：带有位置上下文的一个单独验证错误. */
export interface ValidationError {
  stage: ValidationStage;
  sourceIndex?: number;
  sessionKey?: string;
  roundIndex?: number;
  messageIndex?: number;
  message: string;
}

// ============================
// Seed command options (from CLI)
// ============================
// 中文：种子命令选项（来自CLI）

export interface SeedCommandOptions {
  /** Path to input file (required). */
  /** 中文：输入文件路径（必需） */
  input: string;
  /** Output directory (optional, auto-generated if missing). */
  /** 中文：输出目录（可选，缺失时自动生成） */
  outputDir?: string;
  /** Fallback session key when input lacks one. */
  /** 中文：输入缺少时的会话密钥fallback */
  sessionKey?: string;
  /** Strict round-role validation (each round must have user + assistant). */
  /** 中文：严格轮次角色验证（每轮必须包含用户+助手） */
  strictRoundRole: boolean;
  /** Skip interactive confirmations. */
  /** 中文：跳过交互确认 */
  yes: boolean;
  /** Path to memory-tdai config override file (JSON, deep-merged on top of current plugin config). */
  /** 中文：内存-tdai配置覆盖文件路径（JSON格式，深度合并于当前插件配置之上） */
  configFile?: string;
}

// ============================
// Seed runtime types
// ============================
// 中文：种子运行时类型

/** Progress info emitted during seed execution. */
/** 中文：种⼦执行期间发出的进度信息. */
export interface SeedProgress {
  /** Current round index (1-based, across all sessions). */
  /** 中文：当前轮次索引（从1开始，跨所有会话）. */
  currentRound: number;
  /** Total rounds. */
  /** 中文：总轮次数. */
  totalRounds: number;
  /** Current session key. */
  /** 中文：当前会话键. */
  sessionKey: string;
  /** Current stage description. */
  /** 中文：当前阶段描述. */
  stage: string;
}

/** Final summary after seed completes. */
/** 中文：种子完成后最终总结. */
export interface SeedSummary {
  sessionsProcessed: number;
  roundsProcessed: number;
  messagesProcessed: number;
  l0RecordedCount: number;
  durationMs: number;
  outputDir: string;
}
