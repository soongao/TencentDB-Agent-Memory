/**
 * conversation_search tool: Agent-callable tool for searching L0 conversation records.
 *
 * Supports three search strategies with automatic degradation:
 *   1. **hybrid** (default) — FTS5 keyword + vector embedding in parallel,
 *      merged via Reciprocal Rank Fusion (RRF).
 *   2. **embedding** — pure vector similarity (when FTS5 is unavailable).
 *   3. **fts** — pure FTS5 keyword search (when embedding is unavailable).
 *
 * The tool is registered via `api.registerTool()` in index.ts.
 * 中文：conversation_search 工具: Agent 调用的工具，用于搜索 L0 对话记录。
 * 支持三种搜索策略并自动降级:
 * 1. **hybrid** (默认) — FTS5 关键词 + 向量嵌入并行,
 * 通过互惠排名融合（RRF）合并。
 * 2. **embedding** — 纯向量相似度（当 FTS5 不可用时）。
 * 3. **fts** — 纯 FTS5 关键词搜索（当向量嵌入不可用时）。
 * 该工具通过 index.ts 中的 `api.registerTool()` 注册。
 */

import type { IMemoryStore, L0SearchResult } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";

// ============================
// Types
// ============================

export interface ConversationSearchResultItem {
  id: string;
  session_key: string;
  /** Role of the message sender: "user" or "assistant" */
  /** 中文：消息发送者角色: "user" 或 "assistant" */
  role: string;
  /** Text content of this single message */
  /** 中文：此单条消息的内容 */
  content: string;
  score: number;
  recorded_at: string;
}

export interface ConversationSearchResult {
  results: ConversationSearchResultItem[];
  total: number;
  /** Actual search strategy used: "hybrid", "embedding", "fts", or "none". */
  /** 中文：实际使用的搜索策略: "hybrid", "embedding", "fts", 或 "none"。 */
  strategy: string;
  /** Optional message, e.g. when embedding is not configured. */
  /** 中文：可选的消息，例如当向量嵌入未配置时。 */
  message?: string;
}

const TAG = "[memory-tdai][tdai_conversation_search]";

// ============================
// RRF (Reciprocal Rank Fusion)
// ============================
// 中文：RRF (互惠排名融合)

/** Standard RRF constant from the original RRF paper. */
/** 中文：原始 RRF 论文中的标准 RRF 常数。 */
const RRF_K = 60;

/**
 * Merge multiple ranked lists of `ConversationSearchResultItem` via Reciprocal
 * Rank Fusion. Items appearing in multiple lists get their RRF scores summed.
 *
 * Returns items sorted by descending RRF score. The `score` field of each
 * returned item is replaced by the RRF score for consistent ranking semantics.
 * 中文：通过互惠
 * 排名融合合并多个 `ConversationSearchResultItem` 排名列表。出现在多个列表中的项其 RRF 分数相加。
 * 按降序 RRF 分数返回项。每个返回项的 `score` 字段被替换为 RRF 分数以保持一致的排名语义。
 */
function rrfMergeL0(...lists: ConversationSearchResultItem[][]): ConversationSearchResultItem[] {
  const map = new Map<string, { item: ConversationSearchResultItem; rrfScore: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const score = 1 / (RRF_K + rank + 1);
      const existing = map.get(item.id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(item.id, { item, rrfScore: score });
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, score: rrfScore }));
}

// ============================
// Search implementation
// ============================
// 中文：搜索实现

export async function executeConversationSearch(params: {
  query: string;
  limit: number;
  sessionKey?: string;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}): Promise<ConversationSearchResult> {
  const {
    query,
    limit,
    sessionKey: sessionFilter,
    vectorStore,
    embeddingService,
    logger,
  } = params;

  logger?.debug?.(
    `${TAG} CALLED: query="${query.slice(0, 100)}", limit=${limit}, ` +
    `sessionFilter=${sessionFilter ?? "(none)"}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}`,
  );

  if (!query || query.trim().length === 0) {
    logger?.debug?.(`${TAG} Empty query, returning empty`);
    return { results: [], total: 0, strategy: "none" };
  }

  if (!vectorStore) {
    logger?.warn?.(`${TAG} VectorStore not available`);
    return { results: [], total: 0, strategy: "none" };
  }

  // ── Determine available capabilities ──
  // 中文：── 确定可用能力 ──
  const hasEmbedding = !!embeddingService;
  const hasFts = vectorStore.isFtsAvailable();

  if (!hasEmbedding && !hasFts) {
    logger?.warn?.(`${TAG} Neither EmbeddingService nor FTS5 available — cannot search`);
    return {
      results: [],
      total: 0,
      strategy: "none",
      message:
        "Embedding service is not configured and FTS is not available. " +
        "Conversation search requires an embedding provider or FTS5 support. " +
        "Please configure an embedding provider in the embedding.provider setting (e.g. openai_compatible).",
    };
  }

  // ── Over-retrieve for later filtering and RRF merging ──
  // 中文：── 过度获取以便后续过滤和RRF合并 ──
  const candidateK = sessionFilter ? limit * 4 : limit * 3;

  // ── Run available search strategies in parallel ──
  // 中文：── 并行运行可用的搜索策略 ──
  const [ftsItems, vecItems] = await Promise.all([
    // FTS5 keyword search on L0
    // 中文：L0上的FTS5关键词搜索
    (async (): Promise<ConversationSearchResultItem[]> => {
      if (!hasFts) return [];
      try {
        const ftsQuery = buildFtsQuery(query);
        if (!ftsQuery) {
          logger?.debug?.(`${TAG} [hybrid-fts] No usable FTS tokens from query`);
          return [];
        }
        logger?.debug?.(`${TAG} [hybrid-fts] FTS5 query: "${ftsQuery}"`);
        const ftsResults = await vectorStore.searchL0Fts(ftsQuery, candidateK);
        logger?.debug?.(`${TAG} [hybrid-fts] FTS5 returned ${ftsResults.length} candidates`);
        return ftsResults.map((r) => ({
          id: r.record_id,
          session_key: r.session_key,
          role: r.role,
          content: r.message_text,
          score: r.score,
          recorded_at: r.recorded_at,
        }));
      } catch (err) {
        logger?.warn?.(
          `${TAG} [hybrid-fts] FTS5 search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })(),

    // Vector embedding search on L0
    // 中文：L0上的向量嵌入搜索
    (async (): Promise<ConversationSearchResultItem[]> => {
      if (!hasEmbedding) return [];
      try {
        logger?.debug?.(`${TAG} [hybrid-vec] Generating query embedding...`);
        const queryEmbedding = await embeddingService!.embed(query);
        logger?.debug?.(
          `${TAG} [hybrid-vec] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}...`,
        );
        const vecResults: L0SearchResult[] = await vectorStore.searchL0Vector(queryEmbedding, candidateK, query);
        logger?.debug?.(`${TAG} [hybrid-vec] Vector search returned ${vecResults.length} candidates`);
        return vecResults.map((r) => ({
          id: r.record_id,
          session_key: r.session_key,
          role: r.role,
          content: r.message_text,
          score: r.score,
          recorded_at: r.recorded_at,
        }));
      } catch (err) {
        logger?.warn?.(
          `${TAG} [hybrid-vec] Embedding search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })(),
  ]);

  // ── Determine effective strategy ──
  // 中文：── 确定有效策略 ──
  const ftsOk = ftsItems.length > 0;
  const vecOk = vecItems.length > 0;
  let strategy: string;

  if (ftsOk && vecOk) {
    strategy = "hybrid";
  } else if (vecOk) {
    strategy = "embedding";
  } else if (ftsOk) {
    strategy = "fts";
  } else {
    logger?.debug?.(`${TAG} Both search paths returned 0 results`);
    return { results: [], total: 0, strategy: hasEmbedding ? "embedding" : "fts" };
  }

  // ── Merge results ──
  // 中文：── 合并结果 ──
  let results: ConversationSearchResultItem[];
  if (strategy === "hybrid") {
    results = rrfMergeL0(ftsItems, vecItems);
    logger?.debug?.(
      `${TAG} [hybrid] RRF merged: fts=${ftsItems.length}, vec=${vecItems.length} → ${results.length} unique`,
    );
  } else {
    // Single-source: use whichever list has results (already sorted by score)
    // 中文：单源：使用有结果的列表（已按分数排序）
    results = ftsOk ? ftsItems : vecItems;
  }

  // ── Apply session key filter ──
  // 中文：── 应用会话密钥过滤 ──
  if (sessionFilter) {
    const preFilterCount = results.length;
    results = results.filter((r) => r.session_key === sessionFilter);
    logger?.debug?.(`${TAG} After session filter "${sessionFilter}": ${results.length}/${preFilterCount}`);
  }

  // ── Trim to requested limit ──
  // 中文：── 截断至请求限制 ──
  const trimmed = results.slice(0, limit);

  logger?.debug?.(
    `${TAG} RESULT (strategy=${strategy}): returning ${trimmed.length} messages ` +
    `(scores: [${trimmed.map((r) => r.score.toFixed(3)).join(", ")}])`,
  );

  return {
    results: trimmed,
    total: trimmed.length,
    strategy,
  };
}

// ============================
// Tool response formatter
// ============================
// 中文：工具响应格式化器

export function formatConversationSearchResponse(result: ConversationSearchResult): string {
  if (result.message) {
    return result.message;
  }
  if (result.results.length === 0) {
    return "No matching conversation messages found.";
  }

  const lines: string[] = [
    `Found ${result.total} matching message(s):`,
    "",
  ];

  for (const item of result.results) {
    const scoreStr = typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
    const dateStr = item.recorded_at ? ` [${item.recorded_at}]` : "";
    lines.push(`---`);
    lines.push(`**[${item.role}]** Session: ${item.session_key}${dateStr}${scoreStr}`);
    lines.push("");
    lines.push(item.content);
    lines.push("");
  }

  return lines.join("\n");
}
