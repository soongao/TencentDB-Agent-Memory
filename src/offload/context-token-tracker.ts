/**
 * Context Token Tracker
 *
 * Prefers API-reported input_tokens when available, supplements with tiktoken
 * for message deltas and full fallback. Encoding is configurable via configure().
 * 中文：上下文令牌跟踪器
 * 优先使用API报告的input_tokens，当可用时，用tiktoken补充消息增量和完整回退。编码可通过configure()进行配置。
 */
import { getEncoding, type Tiktoken } from "js-tiktoken";

let ENCODING_NAME = "o200k_base";
let encoder: Tiktoken | null = null;

/**
 * Configure the tiktoken encoding used for token counting.
 * Call once at startup before any snapshot calls.
 * If the encoding changes, the cached encoder is invalidated.
 * 中文：配置用于计数的tiktoken编码。
 * 在任何快照调用之前，在启动时仅调用一次。
 * 如果编码更改，则缓存的编解码器将被无效化。
 */
export function configureTokenTracker(encodingName?: string): void {
  if (encodingName && encodingName !== ENCODING_NAME) {
    ENCODING_NAME = encodingName;
    encoder = null; // invalidate cached encoder
    // 中文：缓存编码器无效化
  }
}

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = getEncoding(ENCODING_NAME as any);
  }
  return encoder;
}

/** Count tokens for a text string using tiktoken BPE encoding. */
/** 中文：使用tiktoken BPE编码对文本字符串进行令牌计数。 */
export function tiktokenCount(text: string): number {
  if (!text || text.length === 0) return 0;
  try {
    return getEncoder().encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function extractLastUserText(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const wrapped = m.type === "message" ? m.message : m;
    if (!wrapped || wrapped.role !== "user") continue;
    const c = wrapped.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const block of c) {
        if (block.type === "text" && typeof block.text === "string")
          parts.push(block.text);
      }
      return parts.length > 0 ? parts.join("\n") : null;
    }
    return null;
  }
  return null;
}

export interface ContextSnapshot {
  timestamp: string;
  stage: string;
  encoding: string;
  totalTokens: number;
  systemTokens: number;
  messagesTokens: number;
  userPromptTokens: number;
  messageCount: number;
}

// Internal metadata keys that should NOT be counted as tokens.
// These are plugin-internal markers or framework-internal fields that the LLM never sees.
// Note: "details" is stripped by OpenClaw's normalizeMessagesForLlmBoundary before sending to LLM.
// 中文：不应计入令牌数的内部元数据键。
// 这些是插件内部标记或框架内部字段，LLM从未见过。
// 注意：“details”在发送到LLM之前由OpenClaw的normalizeMessagesForLlmBoundary去除。
const INTERNAL_KEYS = new Set([
  "_offloaded",
  "_mmdContextMessage",
  "_mmdInjection",
  "_contextOffloadProcessed",
  "details",
]);

/** JSON replacer that strips internal metadata keys from serialization. */
/** 中文：用于从序列化中剥离内部元数据键的JSON替换器。 */
export function jsonReplacer(key: string, value: unknown): unknown {
  if (INTERNAL_KEYS.has(key)) return undefined;
  return value;
}

// ─── Per-message token cache (WeakMap) ─────────────────────────────────────
// Cache token counts per message object. Entries are automatically GC'd when
// the message object is no longer referenced. Cache invalidation is triggered
// by _offloaded flag changes or explicit invalidateTokenCache() calls.
// 中文：─── 每消息令牌缓存（WeakMap） ─────────────────────────────────────
// 按消息对象缓存令牌计数。当不再引用消息对象时，条目将自动被垃圾回收。
// 缓存无效由_offloaded标志更改或显式调用invalidateTokenCache()触发。
const msgTokenCache = new WeakMap<object, { tokens: number; offloaded: boolean }>();

function cachedMessageTokens(msg: any): number {
  const offloaded = !!msg._offloaded;
  const cached = msgTokenCache.get(msg);
  if (cached && cached.offloaded === offloaded) return cached.tokens;
  const str = JSON.stringify(msg, jsonReplacer);
  const tokens = tiktokenCount(str);
  msgTokenCache.set(msg, { tokens, offloaded });
  return tokens;
}

/**
 * Invalidate the token cache for a message whose content was mutated in-place
 * (e.g. by replaceWithSummary). Must be called after any content mutation.
 * 中文：对于内容原地突变的消息（例如replaceWithSummary），无效化令牌缓存。
 * 必须在任何内容突变之后调用。
 */
export function invalidateTokenCache(msg: any): void {
  msgTokenCache.delete(msg);
}

/**
 * Tiktoken-only snapshot (messages JSON + optional user prompt dedupe).
 * Does not write logs.
 * Internal metadata keys (_offloaded, _mmdContextMessage, etc.) are stripped
 * before serialization so they don't inflate the token count.
 *
 * Uses per-message WeakMap cache: unchanged messages (same object reference
 * and same _offloaded flag) reuse previously computed token counts.
 * 中文：仅tiktoken快照（消息JSON +可选用户提示去重）。
 * 不写日志。
 * 在序列化之前，内部元数据键（_offloaded、_mmdContextMessage等）被剥离
 * 以防止它们膨胀令牌计数。
 * 使用每消息WeakMap缓存：未更改的消息（相同的对象引用和相同的_offloaded标志）重用先前计算的令牌计数。
 */
export function buildTiktokenContextSnapshot(
  stage: string,
  messages: any[],
  systemPromptText: string | null,
  userPromptText: string | null,
  precomputed?: { systemTokens?: number; userPromptTokens?: number },
): ContextSnapshot {
  const systemTokens =
    precomputed?.systemTokens != null
      ? precomputed.systemTokens
      : tiktokenCount(systemPromptText ?? "");

  // Per-message cached token counting (replaces full JSON.stringify + tiktoken)
  // 中文：消息级缓存令牌计数（替换full JSON.stringify + tiktoken）
  let messagesTokens = 0;
  for (const msg of messages) {
    messagesTokens += cachedMessageTokens(msg);
  }
  // Compensate for JSON array structure overhead ([, commas, ])
  // 中文：补偿JSON数组结构开销（[,逗号, ]）
  messagesTokens += Math.ceil(messages.length * 0.5);

  let userPromptTokens = 0;
  if (precomputed?.userPromptTokens != null) {
    userPromptTokens = precomputed.userPromptTokens;
  } else if (userPromptText && userPromptText.trim()) {
    const lastUserText = extractLastUserText(messages);
    const alreadyInMessages =
      lastUserText !== null && lastUserText.trim() === userPromptText.trim();
    if (!alreadyInMessages) {
      userPromptTokens = tiktokenCount(userPromptText);
    }
  }

  const totalTokens = systemTokens + messagesTokens + userPromptTokens;

  return {
    timestamp: new Date().toISOString(),
    stage,
    encoding: ENCODING_NAME,
    totalTokens,
    systemTokens,
    messagesTokens,
    userPromptTokens,
    messageCount: messages.length,
  };
}
