/**
 * TDAI Core — barrel re-export for core types and service facade.
 *
 * This module exports ONLY the host-neutral interfaces and the TdaiCore facade.
 * Host-specific adapters live in `../adapters/`.
 * 中文：TDAI 核心 — 导出核心类型和服务Facade的barrel。此模块仅导出主机中立的接口和TdaiCore Facade。主机特定适配器位于`../adapters/`.
 */

// Types & interfaces
// 中文：类型 & 接口
export type {
  Logger,
  RuntimeContext,
  LLMRunParams,
  LLMRunner,
  LLMRunnerCreateOptions,
  LLMRunnerFactory,
  HostAdapter,
  CompletedTurn,
  RecallResult,
  CaptureResult,
  MemorySearchParams,
  ConversationSearchParams,
} from "./types.js";

// TdaiCore service facade
// 中文：TdaiCore 服务Facade
export { TdaiCore } from "./tdai-core.js";
export type { TdaiCoreOptions } from "./tdai-core.js";
