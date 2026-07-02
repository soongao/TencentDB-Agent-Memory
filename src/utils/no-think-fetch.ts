/**
 * Multi-strategy fetch wrapper for disabling thinking/reasoning across
 * different inference engines and model providers.
 *
 * Each strategy injects provider-specific fields into chat-completion
 * request bodies. Non-chat requests (embeddings, etc.) pass through
 * unchanged.
 *
 * Strategies:
 * - `"vllm"`:      vLLM / SGLang — `chat_template_kwargs.enable_thinking = false`
 * - `"deepseek"`:  DeepSeek official API — top-level `enable_thinking: false`
 * - `"dashscope"`: Alibaba DashScope (Qwen) — top-level `enable_thinking: false`
 * - `"openai"`:    OpenAI o-series — `reasoning_effort: "low"` (cannot fully disable)
 * - `"anthropic"`: Anthropic Claude — `thinking: { type: "disabled" }`
 * - `"kimi"`:      Kimi (Moonshot) — `thinking: { type: "disabled" }`
 * - `"gemini"`:    Google Gemini — `thinking_config: { thinking_budget: 0 }`
 * 中文：多策略获取包装器，用于禁用不同推理引擎和模型提供商之间的思考/推理。
 * 每种策略将提供特定字段注入聊天完成请求主体中。非聊天请求（嵌入等）保持不变。
 * 策略:
 * - "vllm"：      vLLM / SGLang — `chat_template_kwargs.enable_thinking = false`
 * - "deepseek"：  DeepSeek 官方 API — 高级别 `enable_thinking: false`
 * - "dashscope"： 阿里巴巴达摩院（Qwen）—— 高级别 `enable_thinking: false`
 * - "openai"：    OpenAI o系列 — `reasoning_effort: "low"`（无法完全禁用）
 * - "anthropic"： Anthropic Claude — `thinking: { type: "disabled" }`
 * - "kimi"：      Kimi（Moonshot）—— `thinking: { type: "disabled" }`
 * - "gemini"：    Google Gemini — `thinking_config: { thinking_budget: 0 }`
 */

// ─── Type & validation ────────────────────────────────────────────────────────
// 中文：─── 类型及验证 ────────────────────────────────────────────────────────

export type DisableThinkingStrategy =
  | false
  | "vllm"
  | "deepseek"
  | "dashscope"
  | "openai"
  | "anthropic"
  | "kimi"
  | "gemini";

export const VALID_DISABLE_THINKING_STRATEGIES: readonly DisableThinkingStrategy[] = [
  false, "vllm", "deepseek", "dashscope", "openai", "anthropic", "kimi", "gemini",
] as const;

/** Check if a value is a valid DisableThinkingStrategy. */
/** 中文：检查一个值是否为有效的DisableThinkingStrategy. */
export function isValidDisableThinkingStrategy(value: unknown): value is DisableThinkingStrategy {
  return (VALID_DISABLE_THINKING_STRATEGIES as readonly unknown[]).includes(value);
}

/**
 * Normalize a raw boolean-or-string config value into a DisableThinkingStrategy.
 *
 *   true  → "vllm" (shorthand for the most common self-hosted scenario)
 *   false / undefined → false
 *
 * Unknown string values fall back to false with a console warning.
 * 中文：将原始的布尔或字符串配置值标准化为DisableThinkingStrategy。
 * true  → "vllm"（最常用的自托管场景的缩写）
 * false / undefined → false
 * 未知字符串值会以控制台警告的形式回退到false
 */
export function normalizeDisableThinking(raw: boolean | string | undefined): DisableThinkingStrategy {
  if (raw === undefined || raw === false) return false;
  if (raw === true) return "vllm";
  // raw is a string
  // 中文：raw 是一个字符串
  if (isValidDisableThinkingStrategy(raw)) return raw;
  console.warn(
    `[memory-tdai] Unknown disableThinking strategy "${raw}", ` +
    `valid values: false, true, "vllm", "deepseek", "dashscope", "openai", "anthropic", "kimi", "gemini". ` +
    `Thinking will NOT be disabled.`,
  );
  return false;
}

// ─── Per-provider body transformers ───────────────────────────────────────────
// 中文：─── Per-provider 体转换器 ───────────────────────────────────────────

function applyVllm(body: Record<string, unknown>): void {
  const existing = body.chat_template_kwargs;
  const base = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? existing as Record<string, unknown>
    : {};
  body.chat_template_kwargs = { ...base, enable_thinking: false };
}

function applyDeepSeek(body: Record<string, unknown>): void {
  body.enable_thinking = false;
}

function applyDashScope(body: Record<string, unknown>): void {
  body.enable_thinking = false;
}

function applyOpenAI(body: Record<string, unknown>): void {
  body.reasoning_effort = "low";
}

function applyAnthropic(body: Record<string, unknown>): void {
  body.thinking = { type: "disabled" };
}

function applyGemini(body: Record<string, unknown>): void {
  body.thinking_config = { thinking_budget: 0 };
}

const STRATEGY_TRANSFORMERS: Record<
  Exclude<DisableThinkingStrategy, false>,
  (body: Record<string, unknown>) => void
> = {
  vllm: applyVllm,
  deepseek: applyDeepSeek,
  dashscope: applyDashScope,
  openai: applyOpenAI,
  anthropic: applyAnthropic,
  kimi: applyAnthropic,
  gemini: applyGemini,
};

// ─── Factory ──────────────────────────────────────────────────────────────────
// 中文：─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a fetch wrapper that injects provider-specific thinking-disabling
 * fields into chat-completion request bodies.
 *
 * When `strategy` is `false`, returns `globalThis.fetch` directly (no wrapper).
 *
 * Only requests with a `messages` array in the body are modified — embedding
 * and other non-chat requests pass through unchanged.
 * 中文：创建一个 fetch 包装器，将提供方特定的思考禁用字段注入 chat-completion 请求体中。
 * 当 `strategy` 为 `false` 时，直接返回 `globalThis.fetch`（无包装）。
 * 只有带有 `messages` 数组的请求会被修改 —— 嵌入和其他非 chat 请求保持不变
 */
export function createNoThinkFetch(strategy: DisableThinkingStrategy = false): typeof globalThis.fetch {
  if (strategy === false) return globalThis.fetch;

  const transform = STRATEGY_TRANSFORMERS[strategy];
  if (!transform) return globalThis.fetch; // defensive: unknown strategy → passthrough
  // 中文：防御性：未知策略 → 透传

  return (async (input, init) => {
    if (init && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        if (body && Array.isArray(body.messages)) {
          transform(body);
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // non-JSON body — forward unchanged
        // 中文：非JSON正文——原样转发
      }
    }
    return globalThis.fetch(input, init);
  }) as typeof globalThis.fetch;
}
