/**
 * OpenClawLLMRunner — wraps the existing CleanContextRunner as a host-neutral LLMRunner.
 *
 * This is a compatibility bridge: TDAI Core modules (L1 extractor, L2 scene extractor,
 * L3 persona generator, L1 dedup) can depend on the `LLMRunner` interface, while
 * OpenClaw continues to use its native `runEmbeddedPiAgent` mechanism under the hood.
 *
 * Usage:
 *   const factory = new OpenClawLLMRunnerFactory({ config, agentRuntime, logger });
 *   const runner = factory.createRunner({ modelRef: "openai/gpt-4o", enableTools: true });
 *   const result = await runner.run({ prompt: "...", taskId: "l1-extraction" });
 * 中文：OpenClawLLMRunner — 将现有的CleanContextRunner封装为一个主机无关的LLMRunner。
 * 这是一个兼容性桥梁：TDAI Core模块（L1提取器，L2场景提取器，
 * L3人物生成器，L1去重）可以依赖于`LLMRunner`接口，而OpenClaw将继续在其内部使用其原生的`runEmbeddedPiAgent`机制。
 * 用法:
 * const factory = new OpenClawLLMRunnerFactory({ config, agentRuntime, logger });
 * const runner = factory.createRunner({ modelRef: "openai/gpt-4o", enableTools: true });
 * const result = await runner.run({ prompt: "...", taskId: "l1-extraction" });
 */

import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import type { EmbeddedAgentRuntimeLike } from "../../utils/clean-context-runner.js";
import type {
  LLMRunner,
  LLMRunParams,
  LLMRunnerFactory,
  LLMRunnerCreateOptions,
  Logger,
} from "../../core/types.js";

const TAG = "[memory-tdai] [openclaw-runner]";

// ============================
// OpenClawLLMRunner
// ============================
// 中文：OpenClawLLMRunner

/**
 * LLMRunner implementation backed by CleanContextRunner.
 *
 * Each instance is configured with a fixed model + tools setting.
 * Create via `OpenClawLLMRunnerFactory.createRunner()`.
 * 中文：由CleanContextRunner支持的LLMRunner实现。
 * 每个实例都配置了固定的模型+工具设置。
 */
export class OpenClawLLMRunner implements LLMRunner {
  private runner: CleanContextRunner;

  constructor(runner: CleanContextRunner) {
    this.runner = runner;
  }

  async run(params: LLMRunParams): Promise<string> {
    return this.runner.run({
      prompt: params.prompt,
      systemPrompt: params.systemPrompt,
      taskId: params.taskId,
      timeoutMs: params.timeoutMs,
      maxTokens: params.maxTokens,
      workspaceDir: params.workspaceDir,
      instanceId: params.instanceId,
    });
  }
}

// ============================
// OpenClawLLMRunnerFactory
// ============================
// 中文：OpenClawLLMRunnerFactory

export interface OpenClawLLMRunnerFactoryOptions {
  /** OpenClaw config object (passed to CleanContextRunner). */
  /** 中文：OpenClaw配置对象（传递给CleanContextRunner）。 */
  config: unknown;
  /** Preferred embedded agent runtime (host-injected). */
  /** 中文：首选嵌入式代理运行时（主机注入）。 */
  agentRuntime?: EmbeddedAgentRuntimeLike;
  /** Logger for runner tracing. */
  /** 中文：运行器的日志记录器。 */
  logger?: Logger;
}

/**
 * Factory that creates OpenClawLLMRunner instances.
 *
 * Encapsulates the OpenClaw-specific dependencies (config, agentRuntime)
 * so that callers only need to specify model + tools.
 * 中文：创建OpenClawLLMRunner实例的工厂。
 * 封装了OpenClaw特定的依赖项（config，agentRuntime），
 * 使得调用者只需指定模型+工具。
 */
export class OpenClawLLMRunnerFactory implements LLMRunnerFactory {
  private config: unknown;
  private agentRuntime?: EmbeddedAgentRuntimeLike;
  private logger?: Logger;

  constructor(opts: OpenClawLLMRunnerFactoryOptions) {
    this.config = opts.config;
    this.agentRuntime = opts.agentRuntime;
    this.logger = opts.logger;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const enableTools = opts?.enableTools ?? false;
    const modelRef = opts?.modelRef;

    this.logger?.debug?.(
      `${TAG} Creating OpenClawLLMRunner: model=${modelRef ?? "(default)"}, tools=${enableTools}`,
    );

    const cleanRunner = new CleanContextRunner({
      config: this.config,
      modelRef,
      enableTools,
      agentRuntime: this.agentRuntime,
      logger: this.logger,
    });

    return new OpenClawLLMRunner(cleanRunner);
  }
}
