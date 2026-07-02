/**
 * L1 Memory Conflict Detection (Batch Mode): decides how to handle multiple new
 * memories against existing records in a single LLM call.
 *
 * v4: Removed JSONL-based Jaccard fallback. Candidate recall now relies exclusively
 *     on vector search (primary) and FTS5 BM25 (degraded). If neither is available,
 *     conflict detection is skipped entirely — all memories go straight to store.
 *
 * Two-phase approach:
 * 1. Candidate search per new memory — vector recall or FTS5 keyword recall (fast, no LLM)
 * 2. Batch LLM judgment on all new memories + their candidate pools (single call)
 * 中文：L1 内存冲突检测（批模式）：决定在单个LLM调用中如何处理多个新内存与现有记录之间的关系。
 */

import type { ExtractedMemory, MemoryRecord, DedupDecision, MemoryType } from "./l1-writer.js";
import { CONFLICT_DETECTION_SYSTEM_PROMPT, formatBatchConflictPrompt } from "../prompts/l1-dedup.js";
import type { CandidateMatch } from "../prompts/l1-dedup.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse } from "../../utils/sanitize.js";
import type { IMemoryStore } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner, Logger } from "../types.js";

const TAG = "[memory-tdai][l1-dedup]";

// ============================
// Core function (batch mode)
// ============================
// 中文：核心函数（批模式）

/**
 * Batch conflict detection: compare all new memories against existing records
 * in a single LLM call.
 *
 * Candidate recall strategy (3-tier degradation):
 * 1. Vector recall (vectorStore + embeddingService) — cosine similarity (best)
 * 2. FTS5 keyword recall (vectorStore with FTS available) — BM25 ranking (degraded)
 * 3. Skip conflict detection entirely — all memories go straight to "store"
 *
 * The old JSONL-based Jaccard fallback has been removed. If neither vector search
 * nor FTS is available, we skip dedup rather than paying the O(N) full-file-scan cost.
 *
 * @param memories - Newly extracted memories (with record_id)
 * @param config - OpenClaw config (for LLM access)
 * @param logger - Optional logger
 * @param model - Optional model override
 * @param vectorStore - Optional vector store for cosine similarity search
 * @param embeddingService - Optional embedding service for computing query vectors
 * @param conflictRecallTopK - Top-K candidates to recall per new memory (default: 5)
 * @returns Array of dedup decisions, one per new memory
 * 中文：批量冲突检测：在一个LLM调用中比较所有新内存与现有记录。
 */
export async function batchDedup(params: {
  memories: Array<ExtractedMemory & { record_id: string }>;
  config: unknown;
  logger?: Logger;
  model?: string;
  /** Vector store for cosine similarity candidate recall */
  /** 中文：候选召回策略（三级降级）：1. 向量召回（向量存储 + 嵌入服务）—— 余弦相似度（最佳）2. FTS5 关键词召回（FTS可用时的向量存储）—— BM25 排名（降级）3. 完全跳过冲突检测 —— 所有内存直接进入“存储” */
  vectorStore?: IMemoryStore;
  /** Embedding service for computing query vectors */
  /** 中文：基于旧JSONL的杰卡德备份已被移除。如果既没有向量搜索也没有FTS，我们跳过去重而不是支付O(N)全文扫描的成本。 */
  embeddingService?: EmbeddingService;
  /** Top-K candidates per new memory (default: 5) */
  /** 中文：@param memories - 新提取的记忆（带有record_id）@param config - OpenClaw配置（用于LLM访问）@param logger - 可选日志器@param model - 可选模型覆盖@param vectorStore - 可选向量存储，用于余弦相似度搜索@param embeddingService - 可选嵌入服务，用于计算查询向量@param conflictRecallTopK - 每个新内存的候选召回数量（默认：5） */
  conflictRecallTopK?: number;
  /** Override embedding timeout for capture-path calls (milliseconds) */
  /** 中文：为捕获路径调用覆盖嵌入超时（毫秒） */
  embeddingTimeoutMs?: number;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  /** 中文：主机无关的LLM运行器 —— 当提供时，用于替代CleanContextRunner。 */
  llmRunner?: LLMRunner;
}): Promise<DedupDecision[]> {
  const { memories, config, logger, model, vectorStore, embeddingService, llmRunner } = params;
  const topK = params.conflictRecallTopK ?? 5;

  if (memories.length === 0) {
    return [];
  }

  const storeAll = () =>
    memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));

  // Determine what recall capabilities are available
  // 中文：确定可用的召回能力
  const hasVectorData = vectorStore && (await vectorStore.countL1()) > 0;
  const hasFts = vectorStore?.isFtsAvailable() ?? false;

  // Fast path: no recall capability at all → skip dedup
  // 中文：快速路径：完全没有召回能力 → 跳过去重
  if (!hasVectorData && !hasFts) {
    logger?.debug?.(`${TAG} No vector data and no FTS available, skipping conflict detection for ${memories.length} memories`);
    return storeAll();
  }

  // Phase 1: Find candidates
  //
  // Decision tree (after the fast-path guard above, vectorStore is guaranteed non-null):
  //   hasVectorData + embeddingService → Tier 1 vector recall (FTS fallback on error)
  //   otherwise hasFts                → Tier 2 FTS keyword recall
  //   otherwise                       → skip dedup (defensive; shouldn't reach here)
  // 中文：第一阶段：查找候选项
  // 决策树（在上述快速路径保护之后，vectorStore 保证非空）:
  // 有向量数据 + 向量服务 → 第一级向量召回（错误时回退到FTS）
  // 否则有fts                → 第二级FTS关键词召回
  // 否则                       → 跳过去重（防御性；不应到达此处）
  let matches: CandidateMatch[];

  if (hasVectorData && embeddingService) {
    // === Tier 1: Vector recall mode ===
    // 中文：=== 第一级：向量召回模式 ===
    logger?.debug?.(`${TAG} Using vector recall mode (topK=${topK})`);
    try {
      matches = await findCandidatesByVector(memories, vectorStore!, embeddingService, topK, logger, params.embeddingTimeoutMs);
    } catch (err) {
      logger?.warn?.(
        `${TAG} Vector recall failed, falling back to FTS keyword: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Degrade to FTS keyword recall
      // 中文：降级为FTS关键词召回
      if (hasFts) {
        matches = await findCandidatesByFts(memories, vectorStore!, logger);
      } else {
        logger?.debug?.(`${TAG} FTS not available either, skipping conflict detection`);
        return storeAll();
      }
    }
  } else if (hasFts) {
    // === Tier 2: FTS keyword recall ===
    // 中文：=== 第二级：FTS关键词召回 ===
    logger?.debug?.(`${TAG} Using FTS keyword recall mode (no embedding service or no vector data)`);
    matches = await findCandidatesByFts(memories, vectorStore!, logger);
  } else {
    // Shouldn't reach here given the fast-path check above, but be defensive
    // 中文：根据上述快速路径检查，不应到达此处，但要保持防御性
    logger?.debug?.(`${TAG} No usable recall path, skipping conflict detection`);
    return storeAll();
  }

  // Check if any memory has candidates
  // 中文：检查是否有任何内存中有候选项
  const hasAnyCandidates = matches.some((m) => m.candidates.length > 0);

  if (!hasAnyCandidates) {
    logger?.debug?.(`${TAG} No similar records found for any memory, all will be stored`);
    return storeAll();
  }

  // Phase 2: Batch LLM judgment
  // 中文：阶段2：批量LLM判断
  return runLlmJudgment(matches, memories, config, logger, model, llmRunner);
}

/**
 * Phase 2: Run batch LLM judgment on candidate matches.
 * 中文：阶段2：对候选匹配进行批量LLM判断.
 */
async function runLlmJudgment(
  matches: CandidateMatch[],
  memories: Array<ExtractedMemory & { record_id: string }>,
  config: unknown,
  logger: Logger | undefined,
  model: string | undefined,
  llmRunner?: LLMRunner,
): Promise<DedupDecision[]> {
  logger?.debug?.(`${TAG} Running batch conflict detection for ${memories.length} memories`);

  try {
    const userPrompt = formatBatchConflictPrompt(matches);
    let result: string;

    if (llmRunner) {
      // Use the host-neutral LLMRunner interface
      // 中文：使用宿主无关的LLMRunner接口
      result = await llmRunner.run({
        prompt: userPrompt,
        systemPrompt: CONFLICT_DETECTION_SYSTEM_PROMPT,
        taskId: "l1-conflict-detection",
        timeoutMs: 180_000,
      });
    } else {
      // Fallback: create CleanContextRunner (OpenClaw path)
      // 中文：降级处理：创建CleanContextRunner（OpenClaw路径）
      const runner = new CleanContextRunner({
        config,
        modelRef: model,
        enableTools: false,
        logger,
      });

      result = await runner.run({
        prompt: userPrompt,
        systemPrompt: CONFLICT_DETECTION_SYSTEM_PROMPT,
        taskId: "l1-conflict-detection",
        timeoutMs: 180_000,
      });
    }

    const decisions = parseBatchResult(result, memories, logger);
    return decisions;
  } catch (err) {
    logger?.warn?.(
      `${TAG} Batch conflict detection failed, defaulting all to store: ${err instanceof Error ? err.message : String(err)}`,
    );
    return memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));
  }
}

// ============================
// Candidate recall strategies
// ============================
// 中文：候选召回策略

/**
 * Vector-based candidate recall (aligned with prototype):
 * batch-embed new memories → cosine search in VectorStore → exclude self-batch → return candidates.
 * 中文：基于向量的候选召回（与原型对齐）:
 * 批量嵌入新记忆 → 余弦搜索在VectorStore → 排除自身批次 → 返回候选.
 */
async function findCandidatesByVector(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  topK: number,
  logger?: Logger,
  embeddingTimeoutMs?: number,
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));

  // Batch-compute embeddings for all new memories
  // 中文：批量计算所有新记忆的嵌入
  const texts = memories.map((m) => m.content);
  const embeddings = await embeddingService.embedBatch(texts, embeddingTimeoutMs ? { timeoutMs: embeddingTimeoutMs } : undefined);

  const matches: CandidateMatch[] = [];

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const queryVec = embeddings[i];

    // Vector search top-K (request extra to account for self-batch filtering)
    // 中文：向量搜索Top-K（额外请求以应对自身批次过滤）
    const searchResults = await vectorStore.searchL1Vector(queryVec, topK + memories.length, mem.content);

    // Exclude records from current batch, convert to MemoryRecord format
    // 中文：排除当前批次的记录，转换为MemoryRecord格式
    const candidates: MemoryRecord[] = searchResults
      .filter((r) => !newRecordIds.has(r.record_id))
      .slice(0, topK)
      .map((r) => ({
        id: r.record_id,
        content: r.content,
        type: r.type as MemoryRecord["type"],
        priority: r.priority,
        scene_name: r.scene_name,
        source_message_ids: [],
        metadata: {},
        timestamps: [r.timestamp_str].filter(Boolean),
        createdAt: "",
        updatedAt: "",
        sessionKey: r.session_key,
        sessionId: r.session_id,
      }));

    matches.push({ newMemory: mem, candidates });
  }

  logger?.debug?.(
    `${TAG} Vector recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`,
  );

  return matches;
}

/**
 * FTS5-based candidate recall:
 * Uses the FTS index for efficient BM25-ranked keyword matching.
 * This replaces the old Jaccard word-overlap fallback entirely.
 * 中文：基于FTS5的候选召回：
 * 使用FTS索引进行高效的BM25关键词匹配。
 * 这完全取代了旧的Jaccard词重叠回退机制
 */
async function findCandidatesByFts(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  _logger?: Logger,
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));
  const matches: CandidateMatch[] = [];

  for (const mem of memories) {
    const ftsQuery = buildFtsQuery(mem.content);
    if (ftsQuery) {
      const ftsResults = await vectorStore.searchL1Fts(ftsQuery, 10);
      // Filter out records from the current batch
      // 中文：过滤掉当前批次的记录
      const candidates: MemoryRecord[] = ftsResults
        .filter((r) => !newRecordIds.has(r.record_id))
        .slice(0, 5)
        .map((r) => ({
          id: r.record_id,
          content: r.content,
          type: r.type as MemoryRecord["type"],
          priority: r.priority,
          scene_name: r.scene_name,
          source_message_ids: [],
          metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })() : {},
          timestamps: [r.timestamp_str].filter(Boolean),
          createdAt: "",
          updatedAt: "",
          sessionKey: r.session_key,
          sessionId: r.session_id,
        }));
      matches.push({ newMemory: mem, candidates });
    } else {
      matches.push({ newMemory: mem, candidates: [] });
    }
  }

  _logger?.debug?.(`${TAG} FTS keyword recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`);
  return matches;
}

// ============================
// Result parsing
// ============================
// 中文：结果解析

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction"];

/**
 * Parse the LLM's batch conflict detection JSON response.
 *
 * Expected format: [{record_id, action, target_ids, merged_content, merged_type, merged_priority, merged_timestamps}]
 * 中文：解析LLM批冲突检测JSON响应。
 * 预期格式：[{record_id, action, target_ids, merged_content, merged_type, merged_priority, merged_timestamps}]
 */
function parseBatchResult(
  raw: string,
  memories: Array<ExtractedMemory & { record_id: string }>,
  logger?: Logger,
): DedupDecision[] {
  try {
    // Strip markdown code block wrappers
    // 中文：去除Markdown代码块包裹
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Extract JSON array
    // 中文：提取JSON数组
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      logger?.warn?.(`${TAG} No JSON array found in conflict detection response`);
      return fallbackStoreAll(memories);
    }

    // Sanitize control characters inside JSON string literals that LLM may produce
    // 中文：清理LLM生成的JSON字符串字面量内的控制字符
    const sanitized = sanitizeJsonForParse(arrayMatch[0]);
    const parsed = JSON.parse(sanitized) as unknown[];

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Conflict detection response is not an array`);
      return fallbackStoreAll(memories);
    }

    // Build decisions from LLM output
    // 中文：从LLM输出中构建决策
    const decisions: DedupDecision[] = [];
    const validActions = ["store", "update", "merge", "skip"];

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;

      const recordId = String(d.record_id ?? "");
      // Skip entries with empty/missing record_id — they are LLM hallucinations
      // 中文：跳过record_id为空/缺失的条目——它们是LLM的幻觉
      if (!recordId) {
        logger?.debug?.(`${TAG} Skipping decision with empty record_id`);
        continue;
      }
      const action = String(d.action ?? "store");

      if (!validActions.includes(action)) {
        logger?.warn?.(`${TAG} Invalid action "${action}" for record ${recordId}, defaulting to store`);
      }

      decisions.push({
        record_id: recordId,
        action: validActions.includes(action) ? (action as DedupDecision["action"]) : "store",
        target_ids: Array.isArray(d.target_ids) ? d.target_ids.map(String) : [],
        merged_content: typeof d.merged_content === "string" ? d.merged_content : undefined,
        merged_type: VALID_TYPES.includes(d.merged_type as MemoryType) ? (d.merged_type as MemoryType) : undefined,
        merged_priority: typeof d.merged_priority === "number" ? d.merged_priority : undefined,
        merged_timestamps: Array.isArray(d.merged_timestamps) ? d.merged_timestamps.map(String) : undefined,
      });
    }

    // Ensure all memories have a decision (fill missing with "store")
    // 中文：确保所有记忆都有一个决策（用"store"填充缺失的）
    const decidedIds = new Set(decisions.map((d) => d.record_id));
    for (const mem of memories) {
      if (!decidedIds.has(mem.record_id)) {
        logger?.debug?.(`${TAG} No decision for record ${mem.record_id}, defaulting to store`);
        decisions.push({
          record_id: mem.record_id,
          action: "store",
          target_ids: [],
        });
      }
    }

    return decisions;
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse conflict detection result: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackStoreAll(memories);
  }
}

/**
 * Fallback: store all memories when parsing fails.
 * 中文：解析失败时：在解析失败时存储所有记忆
 */
function fallbackStoreAll(memories: Array<ExtractedMemory & { record_id: string }>): DedupDecision[] {
  return memories.map((m) => ({
    record_id: m.record_id,
    action: "store" as const,
    target_ids: [],
  }));
}
