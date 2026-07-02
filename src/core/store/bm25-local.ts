/**
 * Local BM25 Sparse Vector Encoder.
 *
 * Pure TypeScript replacement for the Python sidecar BM25 client.
 * Uses @tencentdb-agent-memory/tcvdb-text package for tokenization (jieba-wasm) and BM25 encoding.
 *
 * Two operations (same contract as the old BM25Client):
 * - `encodeTexts(texts)` — encode documents for upsert (TF-based)
 * - `encodeQueries(texts)` — encode queries for search (IDF-based)
 * 中文：本地BM25稀疏向量编码器。
 * 纯TypeScript替换Python侧车BM25客户端。
 * 使用@tencentdb-agent-memory/tcvdb-text包进行分词（jieba-wasm）和BM25编码。
 * 两种操作（与旧BM25Client相同的合约）:
 * - `encodeTexts(texts)` — 编码文档以插入更新（基于TF）
 * - `encodeQueries(texts)` — 编码查询用于搜索（基于IDF）
 */

import { BM25Encoder } from "@tencentdb-agent-memory/tcvdb-text";
import type { SparseVector } from "@tencentdb-agent-memory/tcvdb-text";
import type { Logger } from "../types.js";

export type { SparseVector };

export interface BM25LocalConfig {
  /** Whether BM25 sparse encoding is enabled (default: true) */
  /** 中文：是否启用BM25稀疏编码（默认: true） */
  enabled: boolean;
  /** Language for BM25 pre-trained params: "zh" or "en" (default: "zh") */
  /** 中文：BM25预训练参数的语言: "zh" 或 "en"（默认: "zh"） */
  language?: "zh" | "en";
}

const TAG = "[memory-tdai][bm25-local]";

// ============================
// Implementation
// ============================
// 中文：实现

export class BM25LocalEncoder {
  private readonly encoder: BM25Encoder;
  private readonly logger?: Logger;

  constructor(language: "zh" | "en" = "zh", logger?: Logger) {
    this.logger = logger;
    this.encoder = BM25Encoder.default(language);
    logger?.debug?.(`${TAG} Initialized BM25 local encoder (language=${language})`);
  }

  /**
   * Encode document texts for upsert (TF-based BM25 scoring).
   * Returns one SparseVector per input text.
   * 中文：对文档文本进行编码以插入更新（基于TF的BM25评分）。
   * 返回每个输入文本一个SparseVector。
   */
  encodeTexts(texts: string[]): SparseVector[] {
    if (texts.length === 0) return [];
    try {
      return this.encoder.encodeTexts(texts);
    } catch (err) {
      this.logger?.warn(
        `${TAG} encodeTexts failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Encode query texts for search (IDF-based BM25 scoring).
   * Returns one SparseVector per input text.
   * 中文：对查询文本进行编码用于搜索（基于IDF的BM25评分）。
   * 返回每个输入文本一个SparseVector。
   */
  encodeQueries(texts: string[]): SparseVector[] {
    if (texts.length === 0) return [];
    try {
      return this.encoder.encodeQueries(texts);
    } catch (err) {
      this.logger?.warn(
        `${TAG} encodeQueries failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}

// ============================
// Factory
// ============================
// 中文：工厂

/**
 * Create a BM25LocalEncoder if BM25 is enabled in config.
 * Returns undefined if disabled — callers should check before using.
 * 中文：如果配置中启用了BM25，则创建一个BM25LocalEncoder。
 * 如果禁用则返回undefined — 调用者应在使用前检查。
 */
export function createBM25Encoder(
  config: BM25LocalConfig,
  logger?: Logger,
): BM25LocalEncoder | undefined {
  if (!config.enabled) {
    logger?.debug?.(`${TAG} BM25 sparse encoding disabled`);
    return undefined;
  }
  return new BM25LocalEncoder(config.language ?? "zh", logger);
}
