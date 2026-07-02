/**
 * BM25 Sparse Vector Encoding Client.
 *
 * HTTP client for the BM25 Python sidecar service (bm25_server.py).
 * Used by TCVDB backend to generate sparse vectors for hybridSearch.
 *
 * Two operations:
 * - `encodeTexts(texts)` — encode documents for upsert (TF-based)
 * - `encodeQueries(texts)` — encode queries for search (IDF-based)
 *
 * Graceful degradation: if the sidecar is unreachable, all methods
 * return empty arrays and `isHealthy()` returns false. Callers can
 * check health to dynamically downgrade to pure semantic search.
 * 中文：BM25稀疏向量编码客户端。
 * HTTP客户端用于与BM25Python侧车服务（bm25_server.py）通信。
 * 由TCVDB后端用于生成hybridSearch所需的稀疏向量。
 * 两种操作：
 * - `encodeTexts(texts)` — 为upsert编码文档（基于TF）
 * - `encodeQueries(texts)` — 为搜索编码查询（基于IDF）
 * 优雅降级：如果侧车不可达，则所有方法返回空数组且`isHealthy()`返回false。调用者可以检查健康状态以动态降级到纯语义搜索。
 */

import type { Logger } from "../types.js";

// ============================
// Types
// ============================

/** Sparse vector: array of [token_hash, weight] pairs. */
/** 中文：稀疏向量：由[token_hash, weight]对组成的数组。 */
export type SparseVector = Array<[number, number]>;

export interface BM25ClientConfig {
  /** Sidecar service URL (default: "http://127.0.0.1:8084") */
  /** 中文：侧车服务URL（默认：“http://127.0.0.1:8084”） */
  serviceUrl: string;
  /** Request timeout in ms (default: 5000) */
  /** 中文：请求超时时间（毫秒， 默认：5000） */
  timeout: number;
}

interface EncodeResponse {
  vectors: SparseVector[];
}

// ============================
// Implementation
// ============================
// 中文：实现

const TAG = "[memory-tdai][bm25-client]";

export class BM25Client {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly logger?: Logger;

  /** Cached health status to avoid repeated checks on every call. */
  /** 中文：缓存健康状态以避免每次调用时重复检查。 */
  private _healthy: boolean | undefined;
  private _lastHealthCheck = 0;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 30_000; // re-check every 30s
  // 中文：每隔30秒重新检查

  constructor(config: BM25ClientConfig, logger?: Logger) {
    this.baseUrl = config.serviceUrl.replace(/\/+$/, "");
    this.timeout = config.timeout;
    this.logger = logger;
  }

  /**
   * Encode document texts for upsert (TF-based BM25 scoring).
   * Returns one SparseVector per input text.
   * Returns empty array on error (non-throwing).
   * 中文：为upsert编码文档文本（基于TF的BM25评分）。返回每个输入文本一个SparseVector。
   * 错误时返回空数组（非抛出）。
   */
  async encodeTexts(texts: string[]): Promise<SparseVector[]> {
    if (texts.length === 0) return [];
    return this._encode("/encode_texts", texts);
  }

  /**
   * Encode query texts for search (IDF-based BM25 scoring).
   * Returns one SparseVector per input text.
   * Returns empty array on error (non-throwing).
   * 中文：为搜索编码查询文本（基于IDF的BM25评分）。返回每个输入文本一个SparseVector。
   * 错误时返回空数组（非抛出）。
   */
  async encodeQueries(texts: string[]): Promise<SparseVector[]> {
    if (texts.length === 0) return [];
    return this._encode("/encode_queries", texts);
  }

  /**
   * Check if the BM25 sidecar is reachable.
   * Result is cached for 30 seconds to avoid spamming health checks.
   * 中文：检查BM25辅助容器是否可达。
   * 结果缓存30秒以避免频繁健康检查。
   */
  async isHealthy(): Promise<boolean> {
    const now = Date.now();
    if (
      this._healthy !== undefined &&
      now - this._lastHealthCheck < BM25Client.HEALTH_CHECK_INTERVAL_MS
    ) {
      return this._healthy;
    }

    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      this._healthy = resp.ok;
    } catch {
      this._healthy = false;
    }
    this._lastHealthCheck = now;

    if (!this._healthy) {
      this.logger?.warn(`${TAG} BM25 sidecar health check failed (${this.baseUrl})`);
    }

    return this._healthy;
  }

  // ── Internal ──────────────────────────────────────────────────
  // 中文：── 内部 ──────────────────────────────────────────────────

  private async _encode(path: string, texts: string[]): Promise<SparseVector[]> {
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "(unreadable)");
        this.logger?.warn(
          `${TAG} ${path} HTTP ${resp.status}: ${errBody.slice(0, 200)}`,
        );
        return [];
      }

      const json = (await resp.json()) as EncodeResponse;
      return json.vectors ?? [];
    } catch (err) {
      // Mark unhealthy on connection errors
      // 中文：连接错误时标记为不健康
      this._healthy = false;
      this._lastHealthCheck = Date.now();

      this.logger?.warn(
        `${TAG} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}

// ============================
// Factory
// ============================
// 中文：Factory

/**
 * Create a BM25Client if BM25 is enabled in config.
 * Returns undefined if disabled — callers should check before using.
 * 中文：如果配置中启用了BM25，则创建一个BM25Client。
 * 禁用时返回undefined——调用者在使用前应进行检查
 */
export function createBM25Client(
  config: { enabled: boolean; serviceUrl: string; timeout: number },
  logger?: Logger,
): BM25Client | undefined {
  if (!config.enabled) {
    logger?.info(`${TAG} BM25 sparse encoding disabled`);
    return undefined;
  }
  logger?.info(`${TAG} BM25 client → ${config.serviceUrl}`);
  return new BM25Client(
    { serviceUrl: config.serviceUrl, timeout: config.timeout },
    logger,
  );
}
