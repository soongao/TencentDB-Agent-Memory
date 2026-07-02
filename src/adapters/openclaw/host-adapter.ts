/**
 * OpenClawHostAdapter — translates OpenClaw's plugin API into TDAI Core's
 * unified HostAdapter interface.
 *
 * This is the "thin shell" that keeps OpenClaw-specific dependencies
 * (OpenClawPluginApi, pluginConfig, resolveStateDir, event system)
 * confined to the adapter layer while TDAI Core remains host-neutral.
 *
 * Usage (in index.ts):
 *   const adapter = new OpenClawHostAdapter({ api, pluginDataDir, config });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedConfig });
 * 中文：OpenClawHostAdapter — 将OpenClaw的插件API转换为TDAI Core统一的HostAdapter接口。
 * 这是“薄壳”，将OpenClaw特定依赖（OpenClawPluginApi、pluginConfig、resolveStateDir、事件系统）限制在适配器层内，而TDAI Core保持宿主中立。
 * 使用方法（在index.ts中）：
 * const adapter = new OpenClawHostAdapter({ api, pluginDataDir, config });
 * const core = new TdaiCore({ hostAdapter: adapter, config: parsedConfig });
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { OpenClawLLMRunnerFactory } from "./llm-runner.js";
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

export interface OpenClawHostAdapterOptions {
  /** OpenClaw plugin API instance. */
  /** 中文：OpenClaw插件API实例。 */
  api: OpenClawPluginApi;
  /** Resolved plugin data directory (e.g. ~/.openclaw/state/memory-tdai). */
  /** 中文：解析后的插件数据目录（例如：~/.openclaw/state/memory-tdai）。 */
  pluginDataDir: string;
  /** Parsed OpenClaw config (for LLM model resolution). */
  /** 中文：解析后的OpenClaw配置（用于LLM模型解析）。 */
  openclawConfig: unknown;
}

// ============================
// OpenClawHostAdapter
// ============================
// 中文：OpenClawHostAdapter

export class OpenClawHostAdapter implements HostAdapter {
  readonly hostType = "openclaw" as const;

  private api: OpenClawPluginApi;
  private pluginDataDir: string;
  private openclawConfig: unknown;
  private runnerFactory: OpenClawLLMRunnerFactory;

  constructor(opts: OpenClawHostAdapterOptions) {
    this.api = opts.api;
    this.pluginDataDir = opts.pluginDataDir;
    this.openclawConfig = opts.openclawConfig;

    this.runnerFactory = new OpenClawLLMRunnerFactory({
      config: opts.openclawConfig,
      agentRuntime: opts.api.runtime.agent,
      logger: opts.api.logger,
    });
  }

  /**
   * Build a RuntimeContext from the current OpenClaw session.
   *
   * In OpenClaw, sessionKey and sessionId come from the event/ctx objects
   * passed to hooks. This method returns a context with sensible defaults;
   * callers can override sessionKey/sessionId per-hook invocation using
   * `buildRuntimeContextForSession()`.
   * 中文：从当前OpenClaw会话构建RuntimeContext。
   * 在OpenClaw中，sessionKey和sessionId来自传递给挂钩的event/ctx对象。此方法返回具有合理默认值的上下文；调用者可以在每次hook调用时使用`buildRuntimeContextForSession()`覆盖sessionKey/sessionId。
   */
  getRuntimeContext(): RuntimeContext {
    return {
      userId: "default_user",
      sessionId: "",
      sessionKey: "",
      platform: "openclaw",
      workspaceDir: process.cwd(),
      dataDir: this.pluginDataDir,
    };
  }

  /**
   * Build a RuntimeContext for a specific session (used per-hook).
   *
   * This is an OpenClaw-specific convenience that merges session-level
   * identifiers from hook ctx into the base context.
   * 中文：Build a RuntimeContext for a specific session (used per-hook)。
   * 这是OpenClaw特定的便利功能，将会话级别的标识符从hook ctx合并到基础上下文中。
   */
  buildRuntimeContextForSession(sessionKey: string, sessionId?: string): RuntimeContext {
    return {
      ...this.getRuntimeContext(),
      sessionKey,
      sessionId: sessionId ?? "",
    };
  }

  getLogger(): Logger {
    return this.api.logger;
  }

  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }

  // -- OpenClaw-specific accessors (for index.ts bridge) --------------------
  // 中文：-- OpenClaw-specific访问器（用于index.ts桥接）--------------------

  /** Get the raw OpenClaw plugin API (for legacy callers during migration). */
  /** 中文：获取原始的OpenClaw插件API（用于迁移期间的遗留调用者）。 */
  getPluginApi(): OpenClawPluginApi {
    return this.api;
  }

  /** Get the OpenClaw config object (for legacy callers during migration). */
  /** 中文：获取OpenClaw配置对象（用于迁移期间的遗留调用者）。 */
  getOpenClawConfig(): unknown {
    return this.openclawConfig;
  }

  /** Get the resolved plugin data directory. */
  /** 中文：获取解析后的插件数据目录。 */
  getPluginDataDir(): string {
    return this.pluginDataDir;
  }
}
