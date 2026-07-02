/**
 * Tencent Cloud VectorDB HTTP Client.
 *
 * Thin wrapper around the VectorDB HTTP API. Handles authentication, timeouts,
 * retries (5xx / timeout), and error normalization.
 *
 * API docs: https://cloud.tencent.com/document/product/1709
 * 中文：腾讯云VectorDB HTTP客户端。
 * 围绕VectorDB HTTP API的薄层封装。处理认证、超时、重试（5xx/超时）和错误规范化。
 * API文档：https://cloud.tencent.com/document/product/1709
 */

import fs from "node:fs";
import { request as undiciRequest, Agent as UndiciAgent } from "undici";
import type { Dispatcher } from "undici";
import type { StoreLogger } from "./types.js";

// ============================
// Types
// ============================

export interface TcvdbClientConfig {
  /** Instance URL (e.g. "http://10.0.1.1:80") */
  /** 中文：实例URL（例如：“http://10.0.1.1:80”） */
  url: string;
  /** Account name (default: "root") */
  /** 中文：账户名（默认：“root”） */
  username: string;
  /** API Key */
  /** 中文：API密钥 */
  apiKey: string;
  /** Database name */
  /** 中文：数据库名称 */
  database: string;
  /** Request timeout in ms (default: 10000) */
  /** 中文：请求超时时间（毫秒，默认：10000） */
  timeout: number;
  /** Path to CA certificate PEM file (for HTTPS connections) */
  /** 中文：CA证书PEM文件路径（用于HTTPS连接） */
  caPemPath?: string;
}

/** Standard VectorDB API response envelope. */
/** 中文：标准VectorDB API响应包络 */
interface ApiResponse {
  code: number;
  msg: string;
  [key: string]: unknown;
}

/** Search/hybridSearch response shape. */
/** 中文：搜索/混合搜索响应形状。 */
export interface SearchResponse {
  documents: Array<Array<Record<string, unknown>>>;
}

/** Query response shape. */
/** 中文：查询响应形状。 */
export interface QueryResponse {
  documents: Array<Record<string, unknown>>;
  count?: number;
}

/** Collection info from describeCollection. */
/** 中文：describeCollection返回的集合信息。 */
export interface CollectionInfo {
  collection: string;
  database: string;
  documentCount?: number;
  embedding?: {
    field: string;
    vectorField: string;
    model: string;
  };
  indexes?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export class TcvdbApiError extends Error {
  readonly apiCode: number;
  constructor(path: string, code: number, msg: string) {
    super(`VectorDB ${path}: code=${code}, msg=${msg}`);
    this.name = "TcvdbApiError";
    this.apiCode = code;
  }
}

// ============================
// Client
// ============================
// 中文：Client

const TAG = "[memory-tdai][tcvdb-client]";
const MAX_RETRIES = 2;

export class TcvdbClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly database: string;
  private readonly timeout: number;
  private readonly logger?: StoreLogger;
  /** undici dispatcher for HTTPS + custom CA. */
  /** 中文：undici分发器用于HTTPS+自定义CA。 */
  private readonly dispatcher?: Dispatcher;

  constructor(config: TcvdbClientConfig, logger?: StoreLogger) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.authHeader = `Bearer account=${config.username}&api_key=${config.apiKey}`;
    this.database = config.database;
    this.timeout = config.timeout;
    this.logger = logger;

    // Log connection info at construction time.
    // 中文：在构造时记录连接信息。
    this.logger?.debug?.(`${TAG} url=${this.baseUrl} db=${this.database} timeout=${this.timeout}${this.baseUrl.startsWith("https://") ? ` https=true caPemPath=${config.caPemPath ?? "(none)"}` : ""}`);

    // For HTTPS with a custom CA certificate, create a dedicated undici Agent.
    // We use undici.request() instead of global fetch because fetch's
    // `dispatcher` option is unreliable across Node versions.
    // 中文：对于带有自定义CA证书的HTTPS，创建一个专用的undici Agent。
    // 我们使用undici.request()而不是全局fetch，因为fetch的
    // dispatcher选项在不同Node版本间不可靠。
    if (this.baseUrl.startsWith("https://") && config.caPemPath) {
      try {
        const ca = fs.readFileSync(config.caPemPath, "utf-8");
        this.dispatcher = new UndiciAgent({ connect: { ca } });
        this.logger?.debug?.(`${TAG} HTTPS enabled with CA from ${config.caPemPath}`);
      } catch (err) {
        this.logger?.error(`${TAG} Failed to load CA PEM from ${config.caPemPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Generic request ─────────────────────────────────────
  // 中文：── 通用请求 ─────────────────────────────────────

  /**
   * Send a POST request to VectorDB API.
   * Handles auth, timeout, retries (5xx/timeout), and error unwrapping.
   * 中文：向VectorDB API发送POST请求。
   * 处理认证、超时、重试（5xx/超时）和错误解包。
   */
  async request<T = ApiResponse>(path: string, body: Record<string, unknown>): Promise<T> {
    let lastError: Error | undefined;
    const t0 = performance.now();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const tAttempt = performance.now();
      try {
        this.logger?.debug?.(`${TAG} → ${path} attempt=${attempt} body=${JSON.stringify(body).slice(0, 500)}`);
        const { statusCode, body: respBody } = await undiciRequest(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": this.authHeader,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeout),
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        });

        const text = await respBody.text();
        const json = JSON.parse(text) as ApiResponse;
        const attemptMs = Math.round(performance.now() - tAttempt);
        this.logger?.debug?.(`${TAG} ← ${path} status=${statusCode} code=${json.code} attemptMs=${attemptMs} attempt=${attempt}`);

        if (json.code !== 0) {
          const err = new TcvdbApiError(path, json.code, json.msg);
          if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) throw err;
          lastError = err;
          continue;
        }

        // Always log completion at info level (one line per request)
        // 中文：每次请求完成后始终记录一条信息级别日志（一行记录一次请求）
        const totalMs = Math.round(performance.now() - t0);
        this.logger?.info(`${TAG} ${path} ${totalMs}ms${attempt > 0 ? ` (${attempt + 1} attempts)` : ""}`);

        return json as unknown as T;
      } catch (err) {
        const attemptMs = Math.round(performance.now() - tAttempt);
        if (err instanceof TcvdbApiError && err.apiCode !== 0) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          const delay = 500 * (attempt + 1);
          this.logger?.debug?.(`${TAG} ${path} retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms (lastAttemptMs=${attemptMs}, error=${lastError.message})`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    const totalMs = Math.round(performance.now() - t0);
    this.logger?.debug?.(`${TAG} ✗ ${path} totalMs=${totalMs} attempts=${MAX_RETRIES + 1} error=${lastError?.message}`);
    throw lastError ?? new Error(`${TAG} ${path} failed after retries`);
  }

  // ── Database operations ─────────────────────────────────
  // 中文：── 数据库操作 ─────────────────────────────────

  async createDatabase(dbName?: string): Promise<boolean> {
    const name = dbName ?? this.database;
    // SDK pattern: list first, create only if not found
    // 中文：SDK模式：先列出，如未找到再创建
    const listResp = await this.request<{ databases: string[] }>("/database/list", {});
    const exists = (listResp.databases ?? []).includes(name);
    if (exists) {
      this.logger?.debug?.(`${TAG} Database already exists: ${name}`);
      return false;
    }
    await this.request("/database/create", { database: name });
    this.logger?.info(`${TAG} Database created: ${name}`);
    return true;
  }

  // ── Collection operations ───────────────────────────────
  // 中文：── 集合操作 ───────────────────────────────

  async createCollection(params: Record<string, unknown>): Promise<void> {
    const name = String(params.collection ?? "");
    // SDK pattern: try describe first, create only if not found (code 15302)
    // 中文：SDK模式：先尝试描述，如未找到再创建（代码15302）
    try {
      await this.describeCollection(name);
      this.logger?.debug?.(`${TAG} Collection already exists: ${name}`);
      return;
    } catch (err) {
      if (!(err instanceof TcvdbApiError && err.apiCode === 15302)) {
        throw err; // unexpected error
        // 中文：意外错误
      }
      // 15302 = collection not found → proceed to create
      // 中文：15302 = 集合未找到 → 继续创建
    }
    try {
      await this.request("/collection/create", {
        database: this.database,
        ...params,
      });
      this.logger?.info(`${TAG} Collection created: ${name}`);
    } catch (err) {
      // 15202 = collection already exists — race between describe and create.
      // Semantically identical to "describe found it", so treat as success.
      // 中文：15202 = 集合已存在 — 描述和创建之间发生竞态。
      // 语义上等同于“描述成功”，因此视为成功。
      if (err instanceof TcvdbApiError && err.apiCode === 15202) {
        this.logger?.debug?.(`${TAG} Collection already exists (race): ${name}`);
        return;
      }
      throw err;
    }
  }

  async describeCollection(collection: string): Promise<CollectionInfo> {
    const resp = await this.request<{ collection: CollectionInfo }>("/collection/describe", {
      database: this.database,
      collection,
    });
    return resp.collection;
  }

  // ── Document operations ─────────────────────────────────
  // 中文：── 文档操作 ─────────────────────────────────

  async upsert(collection: string, documents: Record<string, unknown>[]): Promise<void> {
    await this.request("/document/upsert", {
      database: this.database,
      collection,
      buildIndex: true,
      documents,
    });
  }

  async search(collection: string, searchParams: Record<string, unknown>): Promise<SearchResponse> {
    return this.request<SearchResponse>("/document/search", {
      database: this.database,
      collection,
      readConsistency: "strongConsistency",
      search: searchParams,
    });
  }

  async hybridSearch(collection: string, searchParams: Record<string, unknown>): Promise<SearchResponse> {
    return this.request<SearchResponse>("/document/hybridSearch", {
      database: this.database,
      collection,
      readConsistency: "strongConsistency",
      search: searchParams,
    });
  }

  async query(collection: string, queryParams: Record<string, unknown>): Promise<QueryResponse> {
    return this.request<QueryResponse>("/document/query", {
      database: this.database,
      collection,
      readConsistency: "strongConsistency",
      query: queryParams,
    });
  }

  async deleteDoc(collection: string, params: Record<string, unknown>): Promise<void> {
    await this.request("/document/delete", {
      database: this.database,
      collection,
      ...params,
    });
  }

  /**
   * Count documents matching an optional filter.
   * Uses the dedicated /document/count endpoint.
   * 中文：根据可选过滤条件计数匹配的文档。
   * 使用专用的 /document/count 端点。
   */
  async count(collection: string, filter?: string): Promise<number> {
    const query: Record<string, unknown> = {};
    if (filter) query.filter = filter;
    const resp = await this.request<{ count: number }>("/document/count", {
      database: this.database,
      collection,
      readConsistency: "strongConsistency",
      query,
    });
    return resp.count ?? 0;
  }

  // ── Convenience getters ─────────────────────────────────
  // 中文：── 方便获取器 ─────────────────────────────────

  getDatabase(): string {
    return this.database;
  }
}
