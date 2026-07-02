/**
 * Unified LLM caller for offload local mode.
 *
 * Uses Vercel AI SDK (`ai` + `@ai-sdk/openai`) with "compatible" mode
 * to support any OpenAI-compatible backend.
 * 中文：统一线性模型调用器，用于卸载本地模式。
 * 使用 Vercel AI SDK（`ai` + `@ai-sdk/openai`）的“兼容”模式
 * 以支持任何 OpenAI 兼容后端。
 */
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createNoThinkFetch, type DisableThinkingStrategy } from "../../utils/no-think-fetch.js";
import type { PluginLogger } from "../types.js";

const TAG = "[context-offload] [local-llm]";

export interface LlmCallerConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  /**
   * Controls how thinking/reasoning is disabled for the LLM endpoint.
   * See DisableThinkingStrategy for the full list of strategies.
   * 中文：控制对 LLM 端点禁用思考/推理的方式。
   * 详见 DisableThinkingStrategy 以获取完整策略列表。
   */
  disableThinking?: DisableThinkingStrategy;
}

export interface CallLlmOpts {
  systemPrompt: string;
  userPrompt: string;
  /** Override temperature for this call */
  /** 中文：为本次调用覆盖温度值 */
  temperature?: number;
  /** Override timeout for this call */
  /** 中文：为本次调用覆盖超时时间 */
  timeoutMs?: number;
  /** Label for logging (e.g. "L1", "L1.5", "L2") */
  /** 中文：日志标签（例如：“L1”，“L1.5”，“L2”） */
  label?: string;
  /** Pre-created fetch wrapper (for caching at the client level). */
  /** 中文：预创建的 fetch 包装器（用于客户端级别的缓存）。 */
  customFetch?: typeof globalThis.fetch;
}

/**
 * Call LLM with the given prompts and return the text response.
 * Throws on timeout or API errors.
 * 中文：使用给定提示调用 LLM 并返回文本响应。
 * 超时或 API 错误时抛出异常。
 */
export async function callLlm(
  config: LlmCallerConfig,
  opts: CallLlmOpts,
  logger?: PluginLogger,
): Promise<string> {
  const startMs = Date.now();
  const label = opts.label ?? "call";
  const temperature = opts.temperature ?? config.temperature;
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;

  logger?.info?.(
    `${TAG} ${label} >>> model=${config.model}, temp=${temperature}, timeout=${timeoutMs}ms, ` +
    `systemLen=${opts.systemPrompt.length}, userLen=${opts.userPrompt.length}`,
  );

  const customFetch = opts.customFetch ?? (
    config.disableThinking ? createNoThinkFetch(config.disableThinking) : undefined
  );

  const provider = createOpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    compatibility: "compatible",
    ...(customFetch ? { fetch: customFetch } : {}),
  });

  try {
    const result = await generateText({
      model: provider.chat(config.model),
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      temperature,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    const text = result.text.trim();
    const elapsedMs = Date.now() - startMs;

    logger?.info?.(
      `${TAG} ${label} <<< ${elapsedMs}ms, output=${text.length} chars`,
    );

    return text;
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.error?.(`${TAG} ${label} FAILED (${elapsedMs}ms): ${errMsg}`);
    throw err;
  }
}
