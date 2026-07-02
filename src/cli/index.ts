/**
 * memory-tdai CLI entry point.
 *
 * Registers the `memory-tdai` namespace under the OpenClaw CLI and
 * wires up all subcommands (currently: `seed`).
 *
 * Integration path:
 *   index.ts → api.registerCli() → registerMemoryTdaiCli() → registerSeedCommand()
 * 中文：memory-tdai CLI入口点。
 * 在OpenClaw CLI下注册`memory-tdai`命名空间，并连接所有子命令（当前：`seed`）。
 * 集成路径：
 * index.ts → api.registerCli() → registerMemoryTdaiCli() → registerSeedCommand()
 */

import type { Command } from "commander";
import { registerSeedCommand } from "./commands/seed.js";

// ============================
// Context type
// ============================
// 中文：Context类型

/**
 * Minimal context needed by seed CLI commands.
 *
 * Derived from OpenClawPluginCliContext but scoped to what seed actually needs,
 * avoiding a hard dependency on the full plugin CLI context type.
 * 中文：种子CLI命令所需的最小上下文。
 * 源自OpenClawPluginCliContext，但仅针对种子实际所需的内容进行范围限定，避免对完整插件CLI上下文类型的硬依赖。
 */
export interface SeedCliContext {
  /** OpenClaw config (for LLM calls in L1 extraction). */
  /** 中文：OpenClaw配置（用于L1提取中的LLM调用）。 */
  config: unknown;
  /** Raw plugin config (same shape as api.pluginConfig). */
  /** 中文：原始插件配置（与api.pluginConfig形状相同）. */
  pluginConfig: unknown;
  /** State directory root (e.g. ~/.openclaw). */
  /** 中文：状态目录根目录（例如：~/.openclaw）。 */
  stateDir: string;
  /** Logger instance. */
  /** 中文：日志实例。 */
  logger: {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}

// ============================
// Top-level registration
// ============================
// 中文：顶级注册

/**
 * Register all memory-tdai CLI subcommands under the given Commander program.
 *
 * This function is called by the plugin's `api.registerCli()` registrar.
 * It creates the `memory-tdai` namespace and delegates to individual
 * command registrars.
 *
 * @param program - The `memory-tdai` Commander command (already created by the registrar)
 * @param ctx - CLI context with config, state dir, and logger
 * 中文：注册所有memory-tdai CLI子命令到给定的Commander程序中。
 * 此函数由插件的`api.registerCli()`注册器调用。
 * 它创建`memory-tdai`命名空间并委托给单独的
 * 命令注册器。
 * @param program - 已经由注册器创建的`memory-tdai` Commander命令
 * @param ctx - 包含配置、状态目录和日志记录的CLI上下文
 */
export function registerMemoryTdaiCli(program: Command, ctx: SeedCliContext): void {
  // Register subcommands
  // 中文：注册子命令
  registerSeedCommand(program, ctx);

  // Future: registerQueryCommand(program, ctx);
  // Future: registerStatsCommand(program, ctx);
  // 中文：未来: 注册查询命令(program, ctx);
  // 未来: 注册统计命令(program, ctx);
}
