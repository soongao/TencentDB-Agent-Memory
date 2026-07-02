/**
 * LocalLlmClient — local-mode offload LLM client.
 *
 * Implements the same interface as BackendClient (l1Summarize, l15Judge, l2Generate)
 * but calls the LLM directly via AI SDK instead of routing through a remote backend.
 *
 * Used when `offload.model` is configured and `offload.backendUrl` is not set.
 * 中文：LocalLlmClient — local-mode offload LLM客户端。
 * 实现与BackendClient相同的接口（l1Summarize, l15Judge, l2Generate）
 * 但通过AI SDK直接调用LLM，而不是路由到远程后端。
 * 当配置了`offload.model`且未设置`offload.backendUrl`时使用。
 */
import { callLlm, type LlmCallerConfig } from "./llm-caller.js";
import { createNoThinkFetch, type DisableThinkingStrategy } from "../../utils/no-think-fetch.js";
import { L1_SYSTEM_PROMPT, buildL1UserPrompt, type L1ToolPair } from "./prompts/l1-prompt.js";
import { L15_SYSTEM_PROMPT, buildL15UserPrompt, type L15CurrentMmd, type L15MmdMeta } from "./prompts/l15-prompt.js";
import { L2_SYSTEM_PROMPT, buildL2UserPrompt, type L2NewEntry } from "./prompts/l2-prompt.js";
import { parseL1Response } from "./parsers/l1-parser.js";
import { parseL15Response } from "./parsers/l15-parser.js";
import { parseL2Response, type L2ParsedResponse } from "./parsers/l2-parser.js";
import type { OffloadEntry, TaskJudgment, PluginLogger } from "../types.js";
import type { L1Request, L1Response, L15Request, L15Response, L2Request, L2Response } from "../backend-client.js";

const TAG = "[context-offload] [local-llm]";

export interface LocalLlmClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  disableThinking?: DisableThinkingStrategy;
}

export class LocalLlmClient {
  private config: LlmCallerConfig;
  private logger?: PluginLogger;
  private readonly customFetch?: typeof globalThis.fetch;

  constructor(cfg: LocalLlmClientConfig, logger?: PluginLogger) {
    this.config = {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature: cfg.temperature ?? 0.2,
      timeoutMs: cfg.timeoutMs ?? 120_000,
      disableThinking: cfg.disableThinking ?? false,
    };
    this.logger = logger;

    // Cache the fetch wrapper at construction time — avoids per-call creation.
    // 中文：在构造时缓存fetch包装器——避免每次调用都创建。
    this.customFetch = cfg.disableThinking
      ? createNoThinkFetch(cfg.disableThinking)
      : undefined;

    logger?.info?.(`${TAG} Initialized: model=${cfg.model}, baseUrl=${cfg.baseUrl}`);
  }

  // ─── L1 Summarize ──────────────────────────────────────────────────────────
  // 中文：─── L1 总结 ─────────────────────────────────────────────────────────────

  async l1Summarize(req: L1Request): Promise<L1Response> {
    const pairs: L1ToolPair[] = req.toolPairs.map((p) => ({
      toolName: p.toolName,
      toolCallId: p.toolCallId,
      params: p.params,
      result: p.result,
      timestamp: p.timestamp,
    }));

    const userPrompt = buildL1UserPrompt(req.recentMessages, pairs);

    const raw = await callLlm(this.config, {
      systemPrompt: L1_SYSTEM_PROMPT,
      userPrompt,
      label: "L1",
      customFetch: this.customFetch,
    }, this.logger);

    const entries = parseL1Response(raw);
    if (entries.length === 0) {
      this.logger?.warn?.(`${TAG} L1: parsed 0 entries from LLM response (${raw.length} chars)`);
    }

    return { entries };
  }

  // ─── L1.5 Judge ────────────────────────────────────────────────────────────
  // 中文：─── L1.5 判断 ───────────────────────────────────────────────────────────

  async l15Judge(req: L15Request): Promise<L15Response> {
    const currentMmd: L15CurrentMmd | null = req.currentMmd
      ? { filename: req.currentMmd.filename, content: req.currentMmd.content, path: req.currentMmd.path }
      : null;

    const metas: L15MmdMeta[] = req.availableMmdMetas.map((m) => ({
      filename: m.filename,
      path: m.path,
      taskGoal: m.taskGoal,
      doneCount: m.doneCount,
      doingCount: m.doingCount,
      todoCount: m.todoCount,
      updatedTime: m.updatedTime,
      nodeSummaries: m.nodeSummaries?.map((n) => ({
        nodeId: n.nodeId,
        status: n.status,
        summary: n.summary,
      })),
    }));

    const userPrompt = buildL15UserPrompt(req.recentMessages, currentMmd, metas);

    const raw = await callLlm(this.config, {
      systemPrompt: L15_SYSTEM_PROMPT,
      userPrompt,
      label: "L1.5",
      customFetch: this.customFetch,
    }, this.logger);

    const result = parseL15Response(raw);
    if (!result) {
      this.logger?.warn?.(`${TAG} L1.5: failed to parse judgment from LLM response (${raw.length} chars)`);
      // Return all-null to trigger normalizeJudgment's "LLM unavailable" path
      // 中文：返回全空值以触发normalizeJudgment的"LLM不可用"路径
      return {
        taskCompleted: false,
        isContinuation: false,
        isLongTask: false,
      } as L15Response;
    }

    return result as L15Response;
  }

  // ─── L2 Generate ───────────────────────────────────────────────────────────
  // 中文：─── L2 生成 ─────────────────────────────────────────────────────────────

  async l2Generate(req: L2Request): Promise<L2Response> {
    const entries: L2NewEntry[] = req.newEntries.map((e) => ({
      toolCallId: e.tool_call_id,
      toolCall: e.tool_call,
      summary: e.summary,
      timestamp: e.timestamp,
    }));

    const userPrompt = buildL2UserPrompt({
      existingMmd: req.existingMmd,
      entries,
      recentHistory: req.recentHistory,
      currentTurn: req.currentTurn,
      taskLabel: req.taskLabel,
      mmdPrefix: req.mmdPrefix,
      charCount: req.mmdCharCount,
    });

    const raw = await callLlm(this.config, {
      systemPrompt: L2_SYSTEM_PROMPT,
      userPrompt,
      label: "L2",
      timeoutMs: 120_000, // L2 may take longer due to complex prompts
      // 中文：L2 可能会因为复杂的提示而耗时较长
      customFetch: this.customFetch,
    }, this.logger);

    const result = parseL2Response(raw);
    if (!result) {
      this.logger?.error?.(`${TAG} L2: failed to parse response (${raw.length} chars)`);
      throw new Error("L2 response parsing failed");
    }

    return {
      fileAction: result.fileAction,
      mmdContent: result.mmdContent,
      replaceBlocks: result.replaceBlocks?.map((b) => ({
        startLine: b.startLine,
        endLine: b.endLine,
        content: b.content,
      })),
      nodeMapping: result.nodeMapping,
    };
  }

  // ─── Stubs (not applicable in local mode) ──────────────────────────────────
  // 中文：─── 占位符（在本地模式不适用） ───────────────────────────────────────

  /** No-op in local mode — state reporting requires a remote backend. */
  /** 中文：在本地模式下为空操作——状态报告需要远程后端。 */
  async storeState(_payload: unknown): Promise<void> {}

  /** L4 Skill generation is not supported in local mode. */
  /** 中文：L4 技能生成不支持本地模式。 */
  async l4Generate(_req: unknown): Promise<unknown> {
    return null;
  }
}
