/**
 * Embedding Service: converts text to vector embeddings.
 *
 * Supports two providers:
 * - "openai": OpenAI-compatible embedding APIs (OpenAI, Azure OpenAI, self-hosted)
 * - "local": node-llama-cpp with embeddinggemma-300m GGUF model (fully offline)
 *
 * When no remote embedding is configured, automatically falls back to local provider.
 *
 * Design:
 * - Single `embed()` for one text, `embedBatch()` for multiple.
 * - `getDimensions()` returns configured vector dimensions.
 * - Throws on failure; callers decide fallback strategy.
 * 中文：{"嵌入服务": "将文本转换为向量嵌入。
 * 支持两种提供者：
 * - "openai": 兼容OpenAI的嵌入API（OpenAI、Azure OpenAI、自托管）
 * - "local": node-llama-cpp与embeddinggemma-300m GGUF模型（完全离线）
 * 当未配置远程嵌入时，自动回退到本地提供者。
 * 设计：
 * - 单个`embed()`用于单个文本，`embedBatch()`用于多个。
 * - `getDimensions()`返回配置的向量维度。
 * - 失败时抛出异常；调用方决定回退策略。}
 */

import type { Logger } from "../types.js";

// ============================
// Types
// ============================

export interface OpenAIEmbeddingConfig {
  /** Provider identifier — any value other than "local" (e.g. "openai", "deepseek", "azure", "qclaw") */
  /** 中文：提供者标识符 — 任何不同于"local"（例如"openai"、"deepseek"、"azure"、"qclaw"）的值 */
  provider: string;
  /** API base URL (required — must be specified by user, e.g. "https://api.openai.com/v1") */
  /** 中文：API基础URL（必需 — 必须由用户指定，例如"https://api.openai.com/v1"） */
  baseUrl: string;
  /** API Key (required) */
  /** 中文：API密钥（必需） */
  apiKey: string;
  /** Model name (required — must be specified by user) */
  /** 中文：模型名称（必需——必须由用户指定） */
  model: string;
  /** Output dimensions (required — must match the chosen model) */
  /** 中文：输出维度（必需——必须与所选模型匹配） */
  dimensions: number;
  /**
   * Whether to include the `dimensions` field in the embeddings request body.
   * Defaults to `true` for backward compatibility with OpenAI's `text-embedding-3-*`
   * (Matryoshka representation). Some self-hosted / OSS models (e.g. BGE-M3) reject
   * unknown `dimensions` parameters with HTTP 400; set this to `false` for those.
   * 中文：是否在嵌入请求体中包含 `dimensions` 字段。
   * 默认为 `true`，以兼容 OpenAI 的 `text-embedding-3-*`（Matryoshka 表示法）。某些自托管 / OSS 模型（例如 BGE-M3）会因未知的 `dimensions` 参数返回 HTTP 400 错误；对于这些模型，请将其设置为 `false`。
   */
  sendDimensions?: boolean;
  /** Local proxy URL (only for provider="qclaw") — requests are forwarded through this proxy with Remote-URL header */
  /** 中文：本地代理 URL（仅适用于 provider="qclaw"）——请求将通过此代理转发，并带有 Remote-URL 头 */
  proxyUrl?: string;
  /** Max input text length in characters before truncation (default: 5000). */
  /** 中文：在截断前的最大输入文本长度（默认：5000字符）。 */
  maxInputChars?: number;
  /** Timeout per API call in milliseconds (default: 10000). */
  /** 中文：每次API调用的超时时间（毫秒，默认：10000）。 */
  timeoutMs?: number;
}

export interface LocalEmbeddingConfig {
  provider: "local";
  /** Custom GGUF model path (default: embeddinggemma-300m from HuggingFace) */
  /** 中文：自定义GGUF模型路径（默认：来自HuggingFace的embeddinggemma-300m） */
  modelPath?: string;
  /** Model cache directory (default: node-llama-cpp default cache) */
  /** 中文：模型缓存目录（默认：node-llama-cpp默认缓存） */
  modelCacheDir?: string;
}

export type EmbeddingConfig = OpenAIEmbeddingConfig | LocalEmbeddingConfig;

/** Identifies the embedding provider + model for change detection. */
/** 中文：用于变更检测的嵌入提供者+模型标识符。 */
export interface EmbeddingProviderInfo {
  /** Provider identifier (e.g. "local", "openai", "deepseek") */
  /** 中文：提供者标识符（例如：“local”，“openai”，“deepseek”） */
  provider: string;
  /** Model identifier (e.g. "embeddinggemma-300m", "text-embedding-3-large") */
  /** 中文：模型标识符（例如：“embeddinggemma-300m”，“text-embedding-3-large”） */
  model: string;
}

export interface EmbeddingCallOptions {
  /** Override the default timeout for this call (milliseconds). */
  /** 中文：覆盖此调用的默认超时时间（毫秒） */
  timeoutMs?: number;
}

export interface EmbeddingService {
  /** Get embedding for a single text */
  /** 中文：单个文本的嵌入表示 */
  embed(text: string, options?: EmbeddingCallOptions): Promise<Float32Array>;
  /** Get embeddings for multiple texts (batched API call) */
  /** 中文：多个文本的嵌入表示（批量API调用） */
  embedBatch(texts: string[], options?: EmbeddingCallOptions): Promise<Float32Array[]>;
  /** Return the configured vector dimensions */
  /** 中文：返回配置的向量维度 */
  getDimensions(): number;
  /** Return provider + model identifiers for change detection */
  /** 中文：返回提供者+模型标识以供更改检测 */
  getProviderInfo(): EmbeddingProviderInfo;
  /**
   * Whether the service is ready to serve embed requests.
   * For remote providers (OpenAI), always true (stateless HTTP).
   * For local providers, true only after model download + load completes.
   * 中文：服务是否准备好处理嵌入请求。
   * 对于远程提供者（OpenAI），始终为真（无状态HTTP）。
   * 对于本地提供者，在模型下载+加载完成后才为真。
   */
  isReady(): boolean;
  /**
   * Start background warmup (model download + load).
   * For remote providers, this is a no-op.
   * For local providers, triggers async initialization without blocking.
   * Safe to call multiple times (idempotent).
   * 中文：启动后台预热（模型下载+加载）。
   * 对于远程提供者，这是一个空操作。
   * 对于本地提供者，则触发异步初始化而不阻塞。
   * 多次调用是安全的（幂等）。
   */
  startWarmup(): void;
  /** Optional: release resources (model memory, GPU, etc.) on shutdown */
  /** 中文：可选：在关闭时释放资源（模型内存、GPU 等） */
  close?(): void | Promise<void>;
}

/**
 * Error thrown when embed() / embedBatch() is called before the local
 * embedding model has finished downloading and loading.
 * Callers should catch this and fall back to keyword-only mode.
 * 中文：在本地嵌入模型尚未完成下载和加载之前调用 embed() / embedBatch() 抛出的错误。
 * 调用者应捕获此错误并回退到关键字模式
 */
export class EmbeddingNotReadyError extends Error {
  constructor(message?: string) {
    super(message ?? "Local embedding model is not ready yet (still downloading or loading)");
    this.name = "EmbeddingNotReadyError";
  }
}

const TAG = "[memory-tdai][embedding]";

// ============================
// Local (node-llama-cpp) implementation
// ============================
// 中文：本地（node-llama-cpp）实现

/** Default model: Google's embeddinggemma-300m, quantized Q8_0 (~300MB) */
/** 中文：默认模型：Google的embeddinggemma-300m，量化Q8_0（约300MB） */
const DEFAULT_LOCAL_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";

/** embeddinggemma-300m outputs 768-dimensional vectors */
/** 中文：embeddinggemma-300m输出768维向量 */
const LOCAL_DIMENSIONS = 768;

/**
 * embeddinggemma-300m has a 256-token context window.
 * As a safe heuristic, we limit input to ~600 chars for CJK text
 * (CJK characters typically tokenize to 1-2 tokens each,
 *  so 600 chars ≈ 200-400 tokens, keeping well within 256-token limit
 *  after accounting for special tokens).
 * For Latin text, ~800 chars is a safe limit (~200 tokens).
 * We use 512 chars as a conservative universal limit.
 * 中文：embeddinggemma-300m具有256个令牌上下文窗口。作为安全启发式方法，我们限制输入CJK文本约为600字符（CJK字符通常分词为1-2个令牌，因此600字符≈200-400个令牌，在考虑特殊令牌后远远低于256个令牌的限制）。
 * 对于拉丁文文本，安全限制约为800字符（约200个令牌）。我们使用512字符作为保守的通用限制。
 */
const LOCAL_MAX_INPUT_CHARS = 512;

/**
 * Sanitize NaN/Inf values and L2-normalize the vector.
 * Matches OpenClaw's own sanitizeAndNormalizeEmbedding().
 * 中文：清理NaN/Inf值并L2归一化向量。与OpenClaw自身的sanitizeAndNormalizeEmbedding()一致。
 */
function sanitizeAndNormalize(vec: number[] | Float32Array): Float32Array {
  const arr = Array.from(vec).map((v) => (Number.isFinite(v) ? v : 0));
  const magnitude = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
  if (magnitude < 1e-10) {
    return new Float32Array(arr);
  }
  return new Float32Array(arr.map((v) => v / magnitude));
}

/**
 * Initialization state for LocalEmbeddingService.
 * - "idle":         not started yet
 * - "initializing": model download / load is in progress (background)
 * - "ready":        model is loaded and ready to serve
 * - "failed":       initialization failed (will retry on next startWarmup)
 * 中文：LocalEmbeddingService的初始化状态。
 * - "idle"：尚未启动
 * - "initializing"：模型下载/加载正在进行（后台）
 * - "ready"：模型已加载且准备好提供服务
 * - "failed"：初始化失败（将在下次启动时重试warmup）
 */
type LocalInitState = "idle" | "initializing" | "ready" | "failed";

/** Function that dynamically imports node-llama-cpp. Overridable for testing. */
/** 中文：动态导入node-llama-cpp的功能。可测试时覆盖。 */
export type ImportLlamaFn = () => Promise<{
  getLlama: (opts: { logLevel: number }) => Promise<unknown>;
  resolveModelFile: (model: string, cacheDir?: string) => Promise<string>;
  LlamaLogLevel: { error: number };
}>;

const defaultImportLlama: ImportLlamaFn = () => import("node-llama-cpp") as unknown as ReturnType<ImportLlamaFn>;

export class LocalEmbeddingService implements EmbeddingService {
  private readonly modelPath: string;
  private readonly modelCacheDir?: string;
  private readonly logger?: Logger;
  private readonly importLlama: ImportLlamaFn;

  // Initialization state machine
  // 中文：初始化状态机
  private initState: LocalInitState = "idle";
  private initPromise: Promise<void> | null = null;
  private initError: Error | null = null;
  private embeddingContext: {
    getEmbeddingFor: (text: string) => Promise<{ vector: Float32Array | number[] }>;
  } | null = null;

  constructor(config?: LocalEmbeddingConfig, logger?: Logger, importLlama?: ImportLlamaFn) {
    this.modelPath = config?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
    this.modelCacheDir = config?.modelCacheDir?.trim();
    this.logger = logger;
    this.importLlama = importLlama ?? defaultImportLlama;
  }

  getDimensions(): number {
    return LOCAL_DIMENSIONS;
  }

  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: "local", model: this.modelPath };
  }

  /**
   * Whether the local model is fully loaded and ready to serve requests.
   * 中文：本地模型是否已完全加载并准备好处理请求。
   */
  isReady(): boolean {
    return this.initState === "ready" && this.embeddingContext !== null;
  }

  /**
   * Start background warmup: download model (if needed) and load into memory.
   * Does NOT block the caller — returns immediately.
   * Safe to call multiple times (idempotent); re-triggers on "failed" state.
   * 中文：启动后台预热：如果需要下载模型并加载到内存中。
   * 不会阻塞调用者——立即返回。
   * 多次调用安全（幂等）；在“失败”状态下重新触发。
   */
  startWarmup(): void {
    if (this.initState === "initializing" || this.initState === "ready") {
      return; // already in progress or done
      // 中文：已经进行中或已完成
    }
    this.logger?.info(`${TAG} Starting background warmup for local embedding model...`);
    this.initState = "initializing";
    this.initError = null;

    this.initPromise = this._doInitialize()
      .then(() => {
        this.initState = "ready";
        this.logger?.info(`${TAG} Background warmup complete — local embedding ready`);
      })
      .catch((err) => {
        this.initState = "failed";
        this.initError = err instanceof Error ? err : new Error(String(err));
        this.logger?.error(
          `${TAG} Background warmup failed: ${this.initError.message}. ` +
          `embed() calls will throw EmbeddingNotReadyError until retried.`,
        );
      });
  }

  /**
   * Get embedding for a single text.
   * @throws {EmbeddingNotReadyError} if model is not yet ready.
   * 中文：获取单个文本的嵌入向量。
   * @throws {EmbeddingNotReadyError} 如果模型尚未准备好。
   */
  async embed(text: string, _options?: EmbeddingCallOptions): Promise<Float32Array> {
    this.assertReady();
    const truncated = this.truncateInput(text);
    const embedding = await this.embeddingContext!.getEmbeddingFor(truncated);
    return sanitizeAndNormalize(embedding.vector);
  }

  /**
   * Get embeddings for multiple texts.
   * @throws {EmbeddingNotReadyError} if model is not yet ready.
   * 中文：获取多个文本的嵌入向量。
   * @throws {EmbeddingNotReadyError} 如果模型尚未准备好。
   */
  async embedBatch(texts: string[], _options?: EmbeddingCallOptions): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    this.assertReady();

    const results: Float32Array[] = [];
    for (const text of texts) {
      const truncated = this.truncateInput(text);
      const embedding = await this.embeddingContext!.getEmbeddingFor(truncated);
      results.push(sanitizeAndNormalize(embedding.vector));
    }
    return results;
  }

  /**
   * Release the node-llama-cpp embedding context and model resources.
   * Safe to call multiple times (idempotent).
   * 中文：释放 node-llama-cpp 嵌入上下文和模型资源。
   * 多次调用安全（幂等）。
   */
  close(): void {
    if (this.embeddingContext) {
      try {
        const ctx = this.embeddingContext as unknown as { dispose?: () => void };
        ctx.dispose?.();
      } catch {
        // best-effort cleanup
        // 中文：尽力清理
      }
      this.embeddingContext = null;
      this.initPromise = null;
      this.initState = "idle";
      this.initError = null;
      this.logger?.info(`${TAG} Local embedding resources released`);
    }
  }

  /**
   * Assert the model is ready. Throws EmbeddingNotReadyError if not.
   * 中文：断言模型已就绪。如果未准备好，则抛出 EmbeddingNotReadyError。
   */
  private assertReady(): void {
    if (this.initState === "ready" && this.embeddingContext) {
      return;
    }
    if (this.initState === "failed") {
      throw new EmbeddingNotReadyError(
        `Local embedding model initialization failed: ${this.initError?.message ?? "unknown error"}. ` +
        `Call startWarmup() to retry.`,
      );
    }
    if (this.initState === "initializing") {
      throw new EmbeddingNotReadyError(
        "Local embedding model is still loading (download/initialization in progress). Please try again later.",
      );
    }
    // "idle" — startWarmup() was never called
    // 中文："空闲" —— startWarmup() 从未被调用
    throw new EmbeddingNotReadyError(
      "Local embedding model warmup has not been started. Call startWarmup() first.",
    );
  }

  /**
   * Truncate input text to stay within the model's context window.
   * embeddinggemma-300m has a 256-token limit; we use a character-based
   * heuristic (LOCAL_MAX_INPUT_CHARS) as a safe proxy.
   * 中文：将输入文本截断以保持在模型的上下文窗口内。
   * gemmema-300m有256个字符限制；我们使用基于字符的安全代理（LOCAL_MAX_INPUT_CHARS）作为替代方案。
   */
  private truncateInput(text: string): string {
    if (text.length <= LOCAL_MAX_INPUT_CHARS) return text;
    this.logger?.debug?.(
      `${TAG} Input truncated from ${text.length} to ${LOCAL_MAX_INPUT_CHARS} chars (model context limit)`,
    );
    return text.slice(0, LOCAL_MAX_INPUT_CHARS);
  }

  /**
   * Internal: perform the actual model download + load.
   * Called by startWarmup(), runs in background.
   * 中文：内部：实际执行模型下载+加载。
   * 由startWarmup()调用，在后台运行。
   */
  private async _doInitialize(): Promise<void> {
    // Track partially-initialized resources for cleanup on failure
    // 中文：跟踪部分初始化的资源以便在失败时进行清理
    let model: { createEmbeddingContext: () => Promise<unknown>; dispose?: () => void } | undefined;
    try {
      this.logger?.debug?.(`${TAG} Loading node-llama-cpp for local embedding...`);

      // Dynamic import — node-llama-cpp is a peer dependency of OpenClaw
      // 中文：动态导入 — node-llama-cpp是OpenClaw的一个同辈依赖项
      const { getLlama, resolveModelFile, LlamaLogLevel } = await this.importLlama();

      const llama = await getLlama({ logLevel: LlamaLogLevel.error });
      this.logger?.debug?.(`${TAG} Llama instance created`);

      const resolvedPath = await resolveModelFile(
        this.modelPath,
        this.modelCacheDir || undefined,
      );
      this.logger?.debug?.(`${TAG} Model resolved: ${resolvedPath}`);

      model = await (llama as unknown as { loadModel: (opts: { modelPath: string }) => Promise<typeof model> }).loadModel({ modelPath: resolvedPath });
      this.logger?.debug?.(`${TAG} Model loaded, creating embedding context...`);

      this.embeddingContext = await model!.createEmbeddingContext() as typeof this.embeddingContext;
      this.logger?.info(`${TAG} Local embedding ready (model=${this.modelPath}, dims=${LOCAL_DIMENSIONS})`);
    } catch (err) {
      // Clean up partially-initialized resources to prevent leaks
      // 中文：清理部分初始化的资源以防止泄漏
      if (model?.dispose) {
        try { model.dispose(); } catch { /* best-effort */ }
        // 中文：尽力而为
      }
      this.embeddingContext = null;
      throw err;
    }
  }

  /**
   * Wait for ongoing warmup to complete (used internally by tests).
   * Returns immediately if already ready or idle.
   * 中文：等待正在进行的预热完成（内部用于测试）。
   * 如果已准备好或空闲则立即返回。
   */
  async waitForReady(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }
}

// ============================
// OpenAI-compatible implementation
// ============================
// 中文：与OpenAI兼容的实现

/** Max texts per batch (OpenAI limit is 2048, we use a safe value) */
/** 中文：每个批次的最大文本数（OpenAI限制为2048，我们使用一个安全值） */
const MAX_BATCH_SIZE = 256;

/**
 * Max retries for embedding API calls (transient errors: network, 429, DNS).
 * Total attempts = MAX_RETRIES + 1. Exponential backoff: 500ms × attempt.
 * 中文：嵌入API调用的最大重试次数（瞬时错误：网络、429、DNS）。总尝试次数 = MAX_RETRIES + 1。指数退避：500ms × 尝试。
 */
const MAX_RETRIES = 3;
/** Default timeout per API call in milliseconds */
/** 中文：默认每个API调用的超时时间，单位为毫秒 */
const DEFAULT_API_TIMEOUT_MS = 10_000;

/**
 * Custom error class for embedding API errors that carries HTTP status code.
 * Used to distinguish non-retryable client errors (4xx except 429) from
 * retryable server errors (5xx) and rate limits (429).
 * 中文：自定义错误类用于携带HTTP状态码的嵌入API错误。用于区分不应重试的非重试客户端错误（4xx，不包括429）与可重试的服务端错误（5xx）和速率限制（429）。
 */
class EmbeddingApiError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "EmbeddingApiError";
    this.httpStatus = httpStatus;
  }
  /** Returns true for 4xx errors that should NOT be retried (excluding 429). */
  /** 中文：对于不应重试的4xx错误返回true（不包括429）。 */
  isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500 && this.httpStatus !== 429;
  }
}

interface OpenAIEmbeddingResponse {
  data: Array<{
    index: number;
    embedding: number[];
  }>;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * ZeroEntropy's `/v1/models/embed` returns input order via `results[i]`
 * (no `index` field) and omits the OpenAI `data` envelope. See:
 *   https://docs.zeroentropy.dev/api-reference/models/embed
 * 中文：ZeroEntropy的/v1/models/embed通过results[i]返回输入顺序（没有index字段），并且省略OpenAI的数据包。参见：https://docs.zeroentropy.dev/api-reference/models/embed
 */
interface ZeroEntropyEmbeddingResponse {
  results: Array<{
    embedding: number[];
  }>;
}

// ============================
// Shared HTTP helpers (provider-agnostic)
// ============================
// 中文：共享HTTP辅助函数（提供者无关）

/**
 * Truncate every text to `maxInputChars` (when set), emitting one warning
 * per text that exceeded the limit. Returns the input array untouched when
 * no limit is configured.
 * 中文：将每段文本截断为`maxInputChars`（当设置时），对于超过限制的每个文本发出一条警告。未配置限制时，返回原始输入数组不变。
 */
function truncateEmbeddingInputs(
  texts: string[],
  maxInputChars: number | undefined,
  logger?: Logger,
): string[] {
  if (!maxInputChars) return texts;
  return texts.map((text) => {
    if (text.length <= maxInputChars) return text;
    logger?.warn?.(
      `${TAG} Input truncated from ${text.length} to ${maxInputChars} chars (maxInputChars limit)`,
    );
    return text.slice(0, maxInputChars);
  });
}

/**
 * POST a remote embedding request with the project's standard timeout +
 * retry behaviour, returning the parsed JSON body. Provider-specific
 * services own body construction and response shape — this helper handles
 * fetch, abort-on-timeout, exponential backoff, and the `EmbeddingApiError`
 * non-retry rule for 4xx responses (except 429).
 * 中文：使用项目的标准超时时间和重试行为向远程嵌入请求POST数据，并返回解析后的JSON主体。特定服务提供自己的主体构建和响应形状——此辅助函数处理获取、超时取消、指数退避以及4xx响应（不包括429）的非重试规则。
 */
async function postEmbeddingRequest(params: {
  fetchUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
}): Promise<unknown> {
  const { fetchUrl, headers, body, timeoutMs } = params;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(fetchUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "(unable to read body)");
          const err = new EmbeddingApiError(
            `Embedding API error: HTTP ${resp.status} ${resp.statusText} — ${errBody.slice(0, 500)}`,
            resp.status,
          );
          // Don't retry 4xx client errors (except 429 rate limit).
          // 中文：不要重试4xx客户端错误（除了429速率限制）.
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
            throw err;
          }
          lastError = err;
          continue;
        }
        return await resp.json();
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      // Non-retryable errors (4xx client errors) — rethrow immediately
      // 中文：非可重试错误（4xx客户端错误）——立即重新抛出
      if (err instanceof EmbeddingApiError && err.isClientError()) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      // AbortError = timeout, retry
      // 中文：AbortError = 超时，重试
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 500ms, 1000ms
        // 中文：指数退避：500ms, 1000ms
        const delay = 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error("Embedding API call failed after retries");
}

export class OpenAIEmbeddingService implements EmbeddingService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dims: number;
  private readonly sendDimensions: boolean;
  private readonly providerName: string;
  private readonly proxyUrl?: string;
  private readonly maxInputChars?: number;
  private readonly timeoutMs: number;
  private readonly logger?: Logger;

  constructor(config: OpenAIEmbeddingConfig, logger?: Logger) {
    if (!config.apiKey) {
      throw new Error("EmbeddingService: apiKey is required for remote provider");
    }
    if (!config.baseUrl) {
      throw new Error("EmbeddingService: baseUrl is required for remote provider");
    }
    if (!config.model) {
      throw new Error("EmbeddingService: model is required for remote provider");
    }
    if (!config.dimensions || config.dimensions <= 0) {
      throw new Error("EmbeddingService: dimensions is required for remote provider (must be a positive integer)");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dims = config.dimensions;
    this.sendDimensions = config.sendDimensions ?? true;
    this.providerName = config.provider || "openai";
    this.proxyUrl = config.proxyUrl?.trim() || undefined;
    this.maxInputChars = config.maxInputChars && config.maxInputChars > 0 ? config.maxInputChars : undefined;
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_API_TIMEOUT_MS;
    this.logger = logger;
  }

  getDimensions(): number {
    return this.dims;
  }

  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: this.providerName, model: this.model };
  }

  /** Remote embedding is always ready (stateless HTTP). */
  /** 中文：远程嵌入始终就绪（无状态HTTP）. */
  isReady(): boolean {
    return true;
  }

  /** No-op for remote embedding (no local model to warm up). */
  /** 中文：对于远程嵌入不做处理（没有本地模型预热）. */
  startWarmup(): void {
    // nothing to do — remote API is stateless
    // 中文：nothing to do — 远程API是无状态的
  }

  async embed(text: string, options?: EmbeddingCallOptions): Promise<Float32Array> {
    const [result] = await this.embedBatch([text], options);
    return result;
  }

  async embedBatch(texts: string[], options?: EmbeddingCallOptions): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Truncate texts exceeding maxInputChars limit
    // 中文：超过maxInputChars限制则截断文本
    const processedTexts = this.maxInputChars
      ? texts.map((t) => this.truncateInput(t))
      : texts;

    // Split into sub-batches if needed
    // 中文：如果需要，拆分成子批次
    if (processedTexts.length > MAX_BATCH_SIZE) {
      const results: Float32Array[] = [];
      for (let i = 0; i < processedTexts.length; i += MAX_BATCH_SIZE) {
        const chunk = processedTexts.slice(i, i + MAX_BATCH_SIZE);
        const chunkResults = await this._callApi(chunk, options?.timeoutMs);
        results.push(...chunkResults);
      }
      return results;
    }

    return this._callApi(processedTexts, options?.timeoutMs);
  }

  /**
   * Truncate input text to stay within the configured maxInputChars limit.
   * Logs a warning when truncation occurs.
   * 中文：截断输入文本以保持在配置的最大输入字符数限制内。
   * 当发生截断时会记录警告。
   */
  private truncateInput(text: string): string {
    if (!this.maxInputChars || text.length <= this.maxInputChars) return text;
    this.logger?.warn?.(
      `${TAG} Input truncated from ${text.length} to ${this.maxInputChars} chars (maxInputChars limit)`,
    );
    return text.slice(0, this.maxInputChars);
  }

  private async _callApi(texts: string[], timeoutOverride?: number): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
    };
    if (this.sendDimensions) {
      body.dimensions = this.dims;
    }

    // Determine fetch URL and headers based on proxy mode.
    // 中文：根据代理模式确定获取URL和头部信息。
    const useProxy = this.providerName === "qclaw" && !!this.proxyUrl;
    const fetchUrl = useProxy ? this.proxyUrl! : `${this.baseUrl}/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (useProxy) {
      headers["Remote-URL"] = `${this.baseUrl}/embeddings`;
      this.logger?.debug?.(
        `${TAG} [qclaw-proxy] Forwarding embedding request via proxy: ${fetchUrl}, Remote-URL: ${headers["Remote-URL"]}`,
      );
    }

    const json = (await postEmbeddingRequest({
      fetchUrl,
      headers,
      body,
      timeoutMs: timeoutOverride ?? this.timeoutMs,
    })) as OpenAIEmbeddingResponse;

    if (!json.data || !Array.isArray(json.data)) {
      throw new Error("Embedding API returned unexpected format: missing 'data' array");
    }

    // Sort by index to ensure correct order, then sanitize+normalize for consistency with local provider.
    // 中文：按索引排序以确保正确顺序，然后进行清理+归一化以与本地提供商保持一致。
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => sanitizeAndNormalize(d.embedding));
  }
}

// ============================
// ZeroEntropy embedding service
// ============================
// 中文：ZeroEntropy嵌入服务

/**
 * ZeroEntropy native embedding adapter.
 *
 * Reuses {@link OpenAIEmbeddingConfig} for the wire-config shape (baseUrl /
 * apiKey / model / dimensions / sendDimensions are identical), but the wire
 * format diverges in three places, so we keep this provider on its own class
 * instead of branching {@link OpenAIEmbeddingService}:
 *
 * 1. Endpoint is `${baseUrl}/models/embed` (not `/embeddings`).
 * 2. Request body requires `input_type` (`"query"` or `"document"`).
 *    `dimensions` is optional — for `zembed-1` the accepted values are the
 *    Matryoshka set [2560, 1280, 640, 320, 160, 80, 40]; any other value is
 *    rejected by the server. The config's `sendDimensions` flag (default
 *    true) controls whether it is forwarded, matching the OpenAI path.
 * 3. Response envelope is `{ results: [{ embedding }] }` and preserves
 *    input order via array position rather than an `index` field.
 *
 * Everything else (timeout, retry, batching, char-cap truncation,
 * sanitize+normalize) is shared via the module-level
 * `postEmbeddingRequest` / `truncateEmbeddingInputs` helpers. See
 * https://docs.zeroentropy.dev/api-reference/models/embed and issue #68.
 * 中文：ZeroEntropy原生嵌入适配器。
 * 使用 {@link OpenAIEmbeddingConfig} 作为线缆配置形状（baseUrl / apiKey / model / dimensions / sendDimensions 相同），但线缆格式在三个地方有所区别，因此我们将其保留在单独的类中而不是分支 {@link OpenAIEmbeddingService}：
 * 1. 端点是 `${baseUrl}/models/embed` （不是 `/embeddings`）。
 * 2. 请求体需要 `input_type`（`"query"` 或 `"document"`）。`dimensions` 是可选的 — 对于 `zembed-1`，接受的值是 Matryoshka 集合 [2560, 1280, 640, 320, 160, 80, 40]；任何其他值都会被服务器拒绝。配置中的 `sendDimensions` 标志（默认为 true）控制是否转发，与 OpenAI 路径匹配。
 * 3. 响应包封是 `{ results: [{ embedding }] }` 并通过数组位置而不是 `index` 字段保留输入顺序。
 * 其他一切（超时、重试、分批处理、字符截断、清理+归一化）都是通过模块级别的 `postEmbeddingRequest` / `truncateEmbeddingInputs` 辅助函数共享的。参见 https://docs.zeroentropy.dev/api-reference/models/embed 和问题 #68。
 */
export class ZeroEntropyEmbeddingService implements EmbeddingService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dims: number;
  private readonly sendDimensions: boolean;
  private readonly maxInputChars?: number;
  private readonly timeoutMs: number;
  private readonly logger?: Logger;

  constructor(config: OpenAIEmbeddingConfig, logger?: Logger) {
    if (!config.apiKey) {
      throw new Error("ZeroEntropyEmbeddingService: apiKey is required");
    }
    if (!config.baseUrl) {
      throw new Error("ZeroEntropyEmbeddingService: baseUrl is required");
    }
    if (!config.model) {
      throw new Error("ZeroEntropyEmbeddingService: model is required");
    }
    if (!config.dimensions || config.dimensions <= 0) {
      throw new Error("ZeroEntropyEmbeddingService: dimensions is required (must be a positive integer)");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dims = config.dimensions;
    this.sendDimensions = config.sendDimensions ?? true;
    this.maxInputChars = config.maxInputChars && config.maxInputChars > 0 ? config.maxInputChars : undefined;
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_API_TIMEOUT_MS;
    this.logger = logger;
  }

  getDimensions(): number {
    return this.dims;
  }

  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: "zeroentropy", model: this.model };
  }

  /** Remote embedding is always ready (stateless HTTP). */
  /** 中文：远程嵌入始终就绪（无状态 HTTP） */
  isReady(): boolean {
    return true;
  }

  /** No-op for remote embedding (no local model to warm up). */
  /** 中文：对于远程嵌入，为空操作（没有本地模型需要预热） */
  startWarmup(): void {
    // nothing to do — remote API is stateless
    // 中文：nothing to do — remote API is stateless
  }

  async embed(text: string, options?: EmbeddingCallOptions): Promise<Float32Array> {
    const [result] = await this.embedBatch([text], options);
    return result;
  }

  async embedBatch(texts: string[], options?: EmbeddingCallOptions): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const processedTexts = truncateEmbeddingInputs(texts, this.maxInputChars, this.logger);

    if (processedTexts.length > MAX_BATCH_SIZE) {
      const results: Float32Array[] = [];
      for (let i = 0; i < processedTexts.length; i += MAX_BATCH_SIZE) {
        const chunk = processedTexts.slice(i, i + MAX_BATCH_SIZE);
        const chunkResults = await this._callApi(chunk, options?.timeoutMs);
        results.push(...chunkResults);
      }
      return results;
    }

    return this._callApi(processedTexts, options?.timeoutMs);
  }

  private async _callApi(texts: string[], timeoutOverride?: number): Promise<Float32Array[]> {
    // ZeroEntropy rejects requests without `input_type`. We default to
    // "query" because the recall hot path is the only caller of embed()
    // that returns a Float32Array; capture-side batches eventually feed
    // the same vector store, and ZeroEntropy's symmetry between "query"
    // and "document" makes a single type safe across both directions.
    // 中文：ZeroEntropy 拒绝没有 `input_type` 的请求。我们默认为 "query"，因为召回热点路径是唯一一个调用 embed() 并返回 Float32Array 的调用者；捕获端批次最终会喂给相同的向量存储，并且 ZeroEntropy 在 "query" 和 "document" 之间对称性使得单一类型在两个方向上都是安全的。
    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
      input_type: "query",
    };
    if (this.sendDimensions) {
      // ZeroEntropy's docs list `dimensions` as optional. For zembed-1 the
      // accepted set is [2560, 1280, 640, 320, 160, 80, 40] (Matryoshka);
      // any other value is rejected server-side. We forward the user's
      // configured value verbatim — clamping silently would surprise users
      // who deliberately picked a smaller dim for storage savings.
      // 中文：ZeroEntropy 文档将 `dimensions` 列为可选参数。对于 zembed-1，接受的集合是 [2560, 1280, 640, 320, 160, 80, 40]（Matryoshka）；任何其他值都会在服务器端被拒绝。我们原封不动地转发用户的配置值 —— 默契限制可能会让用户意外，他们特意选择较小的维度以节省存储空间。
      body.dimensions = this.dims;
    }

    const fetchUrl = `${this.baseUrl}/models/embed`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    const json = (await postEmbeddingRequest({
      fetchUrl,
      headers,
      body,
      timeoutMs: timeoutOverride ?? this.timeoutMs,
    })) as ZeroEntropyEmbeddingResponse;

    if (!json.results || !Array.isArray(json.results)) {
      throw new Error("ZeroEntropy embedding API returned unexpected format: missing 'results' array");
    }
    // ZeroEntropy preserves input order via array position (no `index` field).
    // 中文：ZeroEntropy 通过数组位置保留输入顺序（没有 `index` 字段）。
    return json.results.map((r) => sanitizeAndNormalize(r.embedding));
  }
}

// ============================
// Factory
// ============================
// 中文：Factory

/**
 * Create an EmbeddingService from config.
 *
 * Strategy:
 * - If config has provider != "local" with valid apiKey, model, and dimensions → use remote OpenAI-compatible embedding
 * - If config has provider="local" → use node-llama-cpp local embedding
 * - If config is undefined or missing required fields → fall back to local embedding
 *
 * NOTE: For local providers, `startWarmup()` is NOT called here.
 * The caller is responsible for calling `startWarmup()` at the right time
 * (e.g. on first conversation) to avoid triggering model download during
 * short-lived CLI commands like `gateway stop` or `agents list`.
 * 中文：根据配置创建一个 EmbeddingService。
 * 策略：
 * - 如果配置有 provider != "local" 并且具有有效的 apiKey、model 和 dimensions → 使用远程 OpenAI 兼容嵌入
 * - 如果配置有 provider="local" → 使用 node-llama-cpp 本地嵌入
 * - 如果配置未定义或缺少必要字段 → 跌回使用本地嵌入
 * 注意：对于本地提供者，`startWarmup()` 不在此处调用。调用者负责在适当的时间（例如首次对话）调用 `startWarmup()`，以避免触发模型下载短命的 CLI 命令如 `gateway stop` 或 `agents list`。
 */
export function createEmbeddingService(
  config: EmbeddingConfig | undefined,
  logger?: Logger,
): EmbeddingService {
  // ZeroEntropy speaks a non-OpenAI wire format and has its own service class.
  // 中文：ZeroEntropy 使用非 OpenAI 通信格式并且有自己的服务类。
  if (config && config.provider === "zeroentropy" && "apiKey" in config && config.apiKey) {
    logger?.debug?.(`${TAG} Using ZeroEntropy embedding (model=${config.model})`);
    return new ZeroEntropyEmbeddingService(config as OpenAIEmbeddingConfig, logger);
  }

  // Remote OpenAI-compatible provider: any provider value other than "local"
  // 中文：远程 OpenAI 兼容提供者：任何不同于 "local" 的 provider 值
  if (config && config.provider !== "local" && "apiKey" in config && config.apiKey) {
    logger?.debug?.(`${TAG} Using remote embedding (provider=${config.provider}, model=${config.model})`);
    return new OpenAIEmbeddingService(config as OpenAIEmbeddingConfig, logger);
  }

  // Explicit local config
  // 中文：显式本地配置
  if (config && config.provider === "local") {
    const localConfig = config as LocalEmbeddingConfig;
    logger?.debug?.(`${TAG} Using local embedding (node-llama-cpp, model=${localConfig.modelPath ?? DEFAULT_LOCAL_MODEL})`);
    return new LocalEmbeddingService(localConfig, logger);
  }

  // Fallback: no config or empty apiKey → use local
  // 中文：默认：无配置或空apiKey → 使用本地
  logger?.debug?.(`${TAG} No remote embedding configured, falling back to local embedding (node-llama-cpp)`);
  return new LocalEmbeddingService(undefined, logger);
}

// ============================
// NoopEmbeddingService (for server-side embedding backends)
// ============================
// 中文：NoopEmbeddingService（用于服务器端嵌入后端）

/**
 * No-op embedding service for backends with built-in server-side embedding
 * (e.g., TCVDB with Collection-level embedding config).
 *
 * All embed() calls return an empty Float32Array because the server generates
 * vectors automatically from the text field during upsert/search.
 * 中文：内置服务器端嵌入的后端的空操作嵌入服务（例如，具有集合级嵌入配置的TCVDB）。所有embed()调用返回一个空的Float32Array，因为服务器在插入/搜索时会自动从文本字段生成向量
 */
export class NoopEmbeddingService implements EmbeddingService {
  embed(_text: string): Promise<Float32Array> {
    return Promise.resolve(new Float32Array(0));
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map(() => new Float32Array(0)));
  }

  getDimensions(): number {
    return 0;
  }

  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: "noop", model: "server-side" };
  }

  isReady(): boolean {
    return true;
  }

  startWarmup(): void {
    // no-op
  }
}
