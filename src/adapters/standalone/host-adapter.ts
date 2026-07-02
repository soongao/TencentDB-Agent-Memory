/**
 * StandaloneHostAdapter — HostAdapter for the TDAI Gateway (Hermes sidecar).
 *
 * Does NOT depend on OpenClaw. Context is constructed from Gateway config
 * and per-request parameters (session_id, user_id, etc.).
 * 中文：StandaloneHostAdapter — 来自TDAI网关（Hermes 边车）的 HostAdapter。
 * 不依赖于 OpenClaw。上下文是从网关配置和每请求参数（session_id、user_id 等）构建的
 */

import { StandaloneLLMRunnerFactory } from "./llm-runner.js";
import type { StandaloneLLMConfig } from "./llm-runner.js";
import type {
  HostAdapter,
  RuntimeContext,
  Logger,
  LLMRunnerFactory,
} from "../../core/types.js";

// ============================
// Options
// ============================
// 中文：Options

export interface StandaloneHostAdapterOptions {
  /** Base data directory for TDAI storage. */
  /** 中文：TDAI存储的基本数据目录. */
  dataDir: string;
  /** LLM configuration for model calls. */
  /** 中文：模型调用的LLM配置. */
  llmConfig: StandaloneLLMConfig;
  /** Logger instance. */
  /** 中文：日志器实例。 */
  logger: Logger;
  /** Default user ID (can be overridden per-request). */
  /** 中文：默认用户ID（可以在每次请求中被覆盖）。 */
  defaultUserId?: string;
  /** Platform identifier. */
  /** 中文：平台标识符。 */
  platform?: string;
}

// ============================
// StandaloneHostAdapter
// ============================
// 中文：独立主机适配器

export class StandaloneHostAdapter implements HostAdapter {
  readonly hostType = "standalone" as const;

  private dataDir: string;
  private logger: Logger;
  private runnerFactory: StandaloneLLMRunnerFactory;
  private defaultUserId: string;
  private platform: string;

  constructor(opts: StandaloneHostAdapterOptions) {
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.defaultUserId = opts.defaultUserId ?? "default_user";
    this.platform = opts.platform ?? "gateway";

    this.runnerFactory = new StandaloneLLMRunnerFactory({
      config: opts.llmConfig,
      logger: opts.logger,
    });
  }

  getRuntimeContext(): RuntimeContext {
    return {
      userId: this.defaultUserId,
      sessionId: "",
      sessionKey: "",
      platform: this.platform,
      workspaceDir: this.dataDir,
      dataDir: this.dataDir,
    };
  }

  /**
   * Build a RuntimeContext for a specific request.
   * Used by Gateway route handlers to scope each request to the correct user/session.
   * 中文：为特定请求构建RuntimeContext。
   * 由网关路由处理器用于将每个请求限定在正确的用户/会话范围内。
   */
  buildRuntimeContextForRequest(params: {
    userId?: string;
    sessionId?: string;
    sessionKey?: string;
    platform?: string;
  }): RuntimeContext {
    return {
      userId: params.userId ?? this.defaultUserId,
      sessionId: params.sessionId ?? "",
      sessionKey: params.sessionKey ?? params.sessionId ?? "",
      platform: params.platform ?? this.platform,
      workspaceDir: this.dataDir,
      dataDir: this.dataDir,
    };
  }

  getLogger(): Logger {
    return this.logger;
  }

  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }
}
