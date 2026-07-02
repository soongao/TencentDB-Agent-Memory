/**
 * TDAI Gateway — Request/Response types for the HTTP API.
 * 中文：TDAGateway — HTTP API的请求/响应类型。
 */

// ============================
// Common
// ============================
// 中文：通用

export interface GatewayErrorResponse {
  error: string;
  code?: string;
}

// ============================
// /health
// ============================
// 中文：/健康

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
}

// ============================
// /recall
// ============================
// 中文：/召回

export interface RecallRequest {
  query: string;
  session_key: string;
  user_id?: string;
}

export interface RecallResponse {
  context: string;
  strategy?: string;
  memory_count?: number;
}

// ============================
// /capture
// ============================
// 中文：/捕获

export interface CaptureRequest {
  user_content: string;
  assistant_content: string;
  session_key: string;
  session_id?: string;
  user_id?: string;
  messages?: unknown[];
}

export interface CaptureResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
}

// ============================
// /search/memories
// ============================
// 中文：/搜索/记忆

export interface MemorySearchRequest {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface MemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
}

// ============================
// /search/conversations
// ============================
// 中文：/搜索/对话

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  session_key?: string;
}

export interface ConversationSearchResponse {
  results: string;
  total: number;
}

// ============================
// /session/end
// ============================
// 中文：/会话/结束

export interface SessionEndRequest {
  session_key: string;
  user_id?: string;
}

export interface SessionEndResponse {
  flushed: boolean;
}

// ============================
// /seed
// ============================

/**
 * Request body for `POST /seed`.
 *
 * Accepts the same input formats as the CLI `seed` command:
 * - Format A: `{ sessions: [{ sessionKey, conversations: [[...msgs]] }] }`
 * - Format B: `[{ sessionKey, conversations: [[...msgs]] }]`
 *
 * Wrapped in an envelope with optional control fields.
 * 中文：请求体用于`POST /seed`。
 * 接受与CLI `seed` 命令相同的输入格式：
 * - 格式A：`{ sessions: [{ sessionKey, conversations: [[...msgs]] }] }`
 * - 格式B：`[{ sessionKey, conversations: [[...msgs]] }]`
 * 包裹在一个包含可选控制字段的信封中。
 */
export interface SeedRequest {
  /**
   * Seed input data — either Format A object or Format B array.
   * This is the same structure accepted by `openclaw memory-tdai seed --input`.
   * 中文：种子输入数据——要么是格式A对象，要么是格式B数组。
   * 这与`openclaw memory-tdai seed --input`接受的结构相同。
   */
  data: unknown;
  /** Fallback session key when input sessions lack one. */
  /** 中文：缺少会话密钥时的回退会话密钥。 */
  session_key?: string;
  /** Require each round to have both user and assistant messages. */
  /** 中文：要求每轮对话都包含用户和助手的消息。 */
  strict_round_role?: boolean;
  /** Auto-fill missing timestamps (default: true). */
  /** 中文：自动填充缺失的时间戳（默认：true）。 */
  auto_fill_timestamps?: boolean;
  /** Plugin config overrides (deep-merged on top of gateway memory config). */
  /** 中文：插件配置覆盖（在网关内存配置之上进行深层合并）。 */
  config_override?: Record<string, unknown>;
}

export interface SeedResponse {
  sessions_processed: number;
  rounds_processed: number;
  messages_processed: number;
  l0_recorded: number;
  duration_ms: number;
  output_dir: string;
}
