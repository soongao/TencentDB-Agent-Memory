/**
 * StandaloneLLMRunner — powered by Vercel AI SDK (`ai` + `@ai-sdk/openai`).
 *
 * This runner does NOT depend on OpenClaw's `runEmbeddedPiAgent`. It is designed
 * for the Hermes Gateway scenario where TDAI runs as an independent Node.js sidecar
 * without the OpenClaw host.
 *
 * Capabilities:
 * - `enableTools: false`: pure text output (L1 extraction, L1 dedup)
 * - `enableTools: true`: automatic tool-call loop with local file operations
 *   (L2 scene, L3 persona) via AI SDK's `maxSteps`
 *
 * Tool sandbox:
 *   When tools are enabled, three basic file operations are exposed:
 *   `read_file`, `write_to_file`, `replace_in_file`.
 *   All file paths are resolved relative to `workspaceDir`, enforcing sandbox boundaries.
 * 中文：StandaloneLLMRunner — 由 Vercel AI SDK (`ai` + `@ai-sdk/openai`) 驱动。
 * 此运行器不依赖于 OpenClaw 的 `runEmbeddedPiAgent`。它为 Hermes Gateway 场景设计，其中 TDAI 作为一个独立的 Node.js 边车运行在没有 OpenClaw 主机的情况下。
 * 功能:
 * - `enableTools: false`: 纯文本输出（L1 提取、L1 去重）
 * - `enableTools: true`: 通过 AI SDK 的 `maxSteps` 实现本地文件操作的自动工具调用循环（L2 场景、L3 人物）
 * 工具沙盒:
 * 当启用工具时，暴露了三种基本文件操作:`read_file`, `write_to_file`, `replace_in_file`。
 * 所有文件路径相对于 `workspaceDir` 解析，以确保沙盒边界。
 */

import fsPromises from "node:fs/promises";
import path from "node:path";
import { generateText, tool, stepCountIs, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { report } from "../../core/report/reporter.js";
import { createNoThinkFetch, type DisableThinkingStrategy } from "../../utils/no-think-fetch.js";
import type {
  LLMRunner,
  LLMRunParams,
  LLMRunnerFactory,
  LLMRunnerCreateOptions,
  Logger,
} from "../../core/types.js";

const TAG = "[memory-tdai] [standalone-runner]";

// Max iterations in the tool-call loop to prevent infinite loops
// 中文：工具调用循环中的最大迭代次数，防止无限循环
const MAX_TOOL_ITERATIONS = 20;

// ============================
// Configuration
// ============================
// 中文：配置

export interface StandaloneLLMConfig {
  /** OpenAI-compatible API base URL (e.g. "https://api.openai.com/v1"). */
  /** 中文：与 OpenAI 兼容的 API 基础 URL（例如: "https://api.openai.com/v1"）。 */
  baseUrl: string;
  /** API key for authentication. */
  /** 中文：用于身份验证的 API 密钥。 */
  apiKey: string;
  /** Default model name (e.g. "gpt-4o"). */
  /** 中文：默认模型名称（例如: "gpt-4o"）。 */
  model: string;
  /** Default max output tokens. */
  /** 中文：默认最大输出标记数。 */
  maxTokens?: number;
  /** Request timeout in milliseconds (default: 120_000). */
  /** 中文：请求超时时间，单位为毫秒（默认值: 120_000） */
  timeoutMs?: number;
  /**
   * Controls how thinking/reasoning is disabled for the LLM endpoint.
   * - `false` (default): no thinking-disabling wrapper
   * - `"vllm"`: vLLM/SGLang chat_template_kwargs
   * - `"deepseek"` / `"dashscope"`: top-level enable_thinking: false
   * - `"openai"`: reasoning_effort: "low"
   * - `"anthropic"` / `"kimi"`: thinking: { type: "disabled" }
   * - `"gemini"`: thinking_config: { thinking_budget: 0 }
   * 中文：控制LLM端点禁用思考/推理的方式。
   * - `false`（默认）：无思考禁用包装
   * - `"vllm"`：vLLM/SGLang chat_template_kwargs
   * - `"deepseek"` / `"dashscope"`：顶层 enable_thinking: false
   * - `"openai"`：reasoning_effort: "low"
   * - `"anthropic"` / `"kimi"`：thinking: { type: "disabled" }
   * - `"gemini"`：thinking_config: { thinking_budget: 0 }
   */
  disableThinking?: DisableThinkingStrategy;
}

// ============================
// Sandboxed tool execution helpers
// ============================
// 中文：沙箱工具执行辅助函数

function resolveSandboxedPath(workspaceDir: string, relativePath: string): string | null {
  const resolved = path.resolve(workspaceDir, relativePath);
  if (!resolved.startsWith(path.resolve(workspaceDir))) {
    return null;
  }
  return resolved;
}

// ============================
// Tool definitions (Vercel AI SDK `tool()` format)
// ============================
// 中文：工具定义（Vercel AI SDK `tool()` 格式）

function createSandboxedTools(workspaceDir: string, logger?: Logger) {
  return {
    read_file: tool({
      description: "Read the contents of a file at the given relative path.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to read." },
        },
        required: ["path"],
      }),
      execute: (async (args: { path: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          return await fsPromises.readFile(resolved, "utf-8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} read_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    write_to_file: tool({
      description: "Write content to a file at the given relative path. Creates or overwrites.",
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to write." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
      }),
      execute: (async (args: { path: string; content: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
          await fsPromises.writeFile(resolved, args.content, "utf-8");
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} write_to_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    replace_in_file: tool({
      description: "Replace an exact substring in a file with new content.",
      inputSchema: jsonSchema<{ path: string; old_str: string; new_str: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path." },
          old_str: { type: "string", description: "Exact string to find and replace." },
          new_str: { type: "string", description: "Replacement string." },
        },
        required: ["path", "old_str", "new_str"],
      }),
      execute: (async (args: { path: string; old_str: string; new_str: string }) => {
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        if (!args.old_str) return JSON.stringify({ error: "old_str cannot be empty." });
        try {
          const existing = await fsPromises.readFile(resolved, "utf-8");
          if (!existing.includes(args.old_str)) {
            return JSON.stringify({ error: `old_str not found in file "${args.path}".` });
          }
          const updated = existing.replace(args.old_str, args.new_str);
          await fsPromises.writeFile(resolved, updated, "utf-8");
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} replace_in_file failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),
  };
}

// ============================
// StandaloneLLMRunner
// ============================
// 中文：StandaloneLLMRunner

export class StandaloneLLMRunner implements LLMRunner {
  private config: StandaloneLLMConfig;
  private model: string;
  private enableTools: boolean;
  private logger?: Logger;
  private readonly customFetch?: typeof globalThis.fetch;

  constructor(opts: {
    config: StandaloneLLMConfig;
    model?: string;
    enableTools?: boolean;
    logger?: Logger;
  }) {
    this.config = opts.config;
    this.model = opts.model ?? opts.config.model;
    this.enableTools = opts.enableTools ?? false;
    this.logger = opts.logger;
    this.customFetch = opts.config.disableThinking
      ? createNoThinkFetch(opts.config.disableThinking)
      : undefined;
  }

  async run(params: LLMRunParams): Promise<string> {
    const runStartMs = Date.now();
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs ?? 120_000;
    const maxTokens = params.maxTokens ?? this.config.maxTokens ?? 4096;
    const workspaceDir = params.workspaceDir ?? process.cwd();

    this.logger?.debug?.(
      `${TAG} run() start: taskId=${params.taskId}, model=${this.model}, ` +
      `tools=${this.enableTools}, timeout=${timeoutMs}ms`,
    );

    // Create OpenAI-compatible provider via AI SDK
    // Use "compatible" mode to call /chat/completions (not Responses API),
    // which works with all OpenAI-compatible backends (DeepSeek, Qwen, etc.)
    // 中文：通过AI SDK创建OpenAI兼容的提供者
    // 使用“兼容”模式调用 /chat/completions（不是 Responses API），
    // 与所有OpenAI兼容后端（DeepSeek、Qwen等）兼容
    const provider = createOpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      compatibility: "compatible",
      ...(this.customFetch ? { fetch: this.customFetch } : {}),
    });

    // For pure text tasks like L1 extraction, avoid exposing any tools.
    // 中文：对于像L1提取这样的纯文本任务，避免暴露任何工具。
    const tools = this.enableTools
      ? createSandboxedTools(workspaceDir, this.logger)
      : undefined;

    try {
      const result = await generateText({
        model: provider.chat(this.model),
        system: params.systemPrompt,
        prompt: params.prompt,
        ...(tools ? { tools } : {}),
        stopWhen: stepCountIs(this.enableTools ? MAX_TOOL_ITERATIONS : 1),
        maxOutputTokens: maxTokens,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });

      const text = result.text.trim();
      const totalMs = Date.now() - runStartMs;

      this.logger?.debug?.(
        `${TAG} run() completed: ${totalMs}ms, steps=${result.steps.length}, output=${text.length} chars`,
      );

      // Log tool usage if any
      // 中文：如果使用任何工具，则记录工具使用情况
      if (result.steps.length > 1) {
        const toolCalls = result.steps.flatMap((s) => s.toolCalls ?? []);
        this.logger?.debug?.(
          `${TAG} Tool calls: ${toolCalls.map((tc) => tc.toolName).join(", ")}`,
        );
      }

      // Metric
      // 中文：指标
      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: this.model,
          inputLength: params.prompt.length,
          outputLength: text.length,
          totalDurationMs: totalMs,
          success: true,
          error: null,
        });
      }

      return text;
    } catch (err) {
      const totalMs = Date.now() - runStartMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger?.error(`${TAG} run() failed after ${totalMs}ms: ${errMsg}`);

      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: this.model,
          inputLength: params.prompt.length,
          outputLength: 0,
          totalDurationMs: totalMs,
          success: false,
          error: errMsg,
        });
      }

      throw err;
    }
  }
}

// ============================
// StandaloneLLMRunnerFactory
// ============================
// 中文：StandaloneLLMRunnerFactory

export interface StandaloneLLMRunnerFactoryOptions {
  /** LLM API configuration. */
  /** 中文：LLM API配置. */
  config: StandaloneLLMConfig;
  /** Logger instance. */
  /** 中文：Logger实例. */
  logger?: Logger;
}

/**
 * Factory that creates StandaloneLLMRunner instances.
 *
 * Used by the Gateway and Hermes host adapters.
 * 中文：用于Gateway和Hermes宿主适配器创建StandaloneLLMRunner实例的工厂。
 */
export class StandaloneLLMRunnerFactory implements LLMRunnerFactory {
  private config: StandaloneLLMConfig;
  private logger?: Logger;

  constructor(opts: StandaloneLLMRunnerFactoryOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const enableTools = opts?.enableTools ?? false;
    const modelRef = opts?.modelRef;

    // Parse "provider/model" → just use the model part for OpenAI-compatible API
    // 中文：解析"provider/model"→仅使用model部分以兼容OpenAI API
    let model = this.config.model;
    if (modelRef) {
      const slashIdx = modelRef.indexOf("/");
      model = slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;
    }

    this.logger?.debug?.(
      `${TAG} Creating StandaloneLLMRunner: model=${model}, tools=${enableTools}`,
    );

    return new StandaloneLLMRunner({
      config: this.config,
      model,
      enableTools,
      logger: this.logger,
    });
  }
}
