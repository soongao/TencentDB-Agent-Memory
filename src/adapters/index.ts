/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore.
 *
 * Directory structure:
 *   adapters/
 *   ├── openclaw/      — OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   └── standalone/    — Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 * 中文：TDAI适配器——为所有宿主适配器实现的barrel重导出。
 * 每个适配器将特定宿主环境的API转换
 * 为TdaiCore消费的宿主中立HostAdapter接口。
 * 目录结构：
 * adapters/
 * ├── openclaw/      — OpenClaw插件宿主（进程内，runEmbeddedPiAgent）
 * └── standalone/    — 网关 / Hermes边车（HTTP，OpenAI兼容API）
 */

// OpenClaw adapter
// 中文：OpenClaw适配器
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
// 中文：Standalone适配器
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";
