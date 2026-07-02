/**
 * TdaiCore — Host-neutral facade for TDAI memory capabilities.
 *
 * This is the single entry point that both OpenClaw and Hermes/Gateway call
 * to perform recall, capture, search, and pipeline management. It depends
 * only on abstract interfaces (HostAdapter, LLMRunner), never on a specific host.
 *
 * Usage:
 *   // OpenClaw path (in-process)
 *   const adapter = new OpenClawHostAdapter({ api, pluginDataDir, config });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 *   await core.initialize();
 *   const recall = await core.handleBeforeRecall("user query", "session-1");
 *
 *   // Gateway path (HTTP)
 *   const adapter = new StandaloneHostAdapter({ ... });
 *   const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 *   await core.initialize();
 *   // HTTP handler calls core.handleBeforeRecall / core.handleTurnCommitted / etc.
 * 中文：TdaiCore — 跨主机的TDAI内存能力Facade。
 * 这是OpenClaw和Hermes/Gateway调用的单入口点，用于执行回忆、捕获、搜索和管道管理。它仅依赖于抽象接口（HostAdapter, LLMRunner），从不依赖特定的主机。
 * 使用方法：
 * OpenClaw路径（进程内）
 * const adapter = new OpenClawHostAdapter({ api, pluginDataDir, config });
 * const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 * await core.initialize();
 * const recall = await core.handleBeforeRecall("用户查询", "session-1");
 * Gateway路径（HTTP）
 * const adapter = new StandaloneHostAdapter({ ... });
 * const core = new TdaiCore({ hostAdapter: adapter, config: parsedCfg });
 * await core.initialize();
 * HTTP处理器调用core.handleBeforeRecall / core.handleTurnCommitted / 等等。
 */

import type {
  HostAdapter,
  Logger,
  LLMRunnerFactory,
  RecallResult,
  CaptureResult,
  CompletedTurn,
  MemorySearchParams,
  ConversationSearchParams,
} from "./types.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { IMemoryStore } from "./store/types.js";
import type { EmbeddingService } from "./store/embedding.js";
import { performAutoRecall } from "./hooks/auto-recall.js";
import { performAutoCapture } from "./hooks/auto-capture.js";
import { executeMemorySearch, formatSearchResponse } from "./tools/memory-search.js";
import { executeConversationSearch, formatConversationSearchResponse } from "./tools/conversation-search.js";
import {
  initDataDirectories,
  initStores,
  resetStores,
  createPipelineManager,
  createL1Runner,
  createPersister,
  createL2Runner,
  createL3Runner,
} from "../utils/pipeline-factory.js";
import { MemoryPipelineManager } from "../utils/pipeline-manager.js";
import { CheckpointManager } from "../utils/checkpoint.js";
import { SessionFilter } from "../utils/session-filter.js";
import { StandaloneLLMRunnerFactory } from "../adapters/standalone/llm-runner.js";

const TAG = "[memory-tdai] [core]";

// ============================
// Constructor options
// ============================
// 中文：构造函数选项

export interface TdaiCoreOptions {
  /** Host adapter providing runtime context, logger, and LLM runner factory. */
  /** 中文：提供运行时上下文、日志记录器和LLM运行器工厂的主机适配器。 */
  hostAdapter: HostAdapter;
  /** Parsed TDAI memory configuration. */
  /** 中文：解析后的TDAI内存配置。 */
  config: MemoryTdaiConfig;
  /** Session filter for excluding internal/benchmark sessions. */
  /** 中文：会话过滤器，用于排除内部/基准会话。 */
  sessionFilter?: SessionFilter;
  /** Plugin instance ID for metric reporting. */
  /** 中文：指标上报的插件实例ID。 */
  instanceId?: string;
}

// ============================
// TdaiCore
// ============================
// 中文：TdaiCore

export class TdaiCore {
  private hostAdapter: HostAdapter;
  private cfg: MemoryTdaiConfig;
  private logger: Logger;
  private dataDir: string;
  private runnerFactory: LLMRunnerFactory;
  private sessionFilter: SessionFilter;
  private instanceId?: string;

  // Lazy-initialized resources
  // 中文：懒初始化的资源
  private vectorStore?: IMemoryStore;
  private embeddingService?: EmbeddingService;
  private scheduler?: MemoryPipelineManager;
  /**
   * Promise gate for the one-shot scheduler-start sequence.
   *
   * ``ensureSchedulerStarted`` reads a checkpoint file (async) and then
   * calls ``scheduler.start(restoredStates)``.  Under the Gateway, several
   * HTTP requests can reach ``handleTurnCommitted`` concurrently and all
   * race into that function.  Using a plain boolean flag is unsafe: the
   * first caller flips the flag to ``true`` *before* the await completes,
   * so subsequent callers slip past the check and touch the scheduler
   * before ``start()`` has actually run — which makes ``start()``'s
   * ``sessionStates.set(key, restored)`` later clobber the state that
   * those concurrent captures already incremented.
   *
   * Storing the in-flight promise lets every concurrent caller ``await``
   * the same start sequence.  Once it resolves the promise is kept as a
   * sentinel so subsequent calls are a single already-resolved await
   * (effectively a no-op).
   * 中文：Promise门用于单次调度启动序列。
   * ``ensureSchedulerStarted`` 异步读取检查点文件，然后调用 ``scheduler.start(restoredStates)``。在网关下，多个HTTP请求可以并发地到达 ``handleTurnCommitted`` 并且所有请求都可能同时进入该函数。使用简单的布尔标志是不安全的：第一个调用者在await完成之前将标志翻转为 ``true`` ，因此后续调用者会绕过检查并在 ``start()`` 实际运行之前触碰调度器 —— 这会使 ``start()`` 中的 ``sessionStates.set(key, restored)`` 后面覆盖掉那些并发捕获已经递增的状态。存储正在飞行中的Promise可以让每个并发调用都 ``await`` 同一个启动序列。一旦它解析，Promise就会保持作为哨兵状态，后续调用将是一个单次已解析的await（实际上相当于空操作）。
   */
  private schedulerStartPromise?: Promise<void>;
  private storeReady?: Promise<void>;

  /**
   * In-flight fire-and-forget background tasks started by
   * ``handleTurnCommitted`` (currently: deferred L0 embedding for
   * SQLite-style stores — see auto-capture.ts path A).
   *
   * ``destroy()`` awaits all pending entries (with a hard timeout)
   * before closing ``vectorStore`` / ``embeddingService`` so that a
   * late ``updateL0Embedding`` cannot land on an already-closed
   * database connection.
   *
   * Each task registers itself on creation and removes itself in its
   * own ``finally`` handler, so the set stays bounded by the number
   * of currently-running background tasks.
   * 中文：由 ``handleTurnCommitted`` 启动的在途的后台任务（当前：延迟L0嵌入用于SQLite风格存储 —— 请参见auto-capture.ts路径A）。
   * ``destroy()`` 在关闭 ``vectorStore`` / ``embeddingService`` 前等待所有待处理条目（带有硬性超时），以防止晚些时候的 ``updateL0Embedding`` 落在已经关闭的数据库连接上。
   * 每个任务在其创建时注册自己，并在自己的 ``finally`` 处理程序中移除自身，因此集合的数量保持在当前运行中的后台任务数量之内。
   */
  private readonly bgTasks = new Set<Promise<void>>();

  constructor(opts: TdaiCoreOptions) {
    this.hostAdapter = opts.hostAdapter;
    this.cfg = opts.config;
    this.logger = opts.hostAdapter.getLogger();
    this.dataDir = opts.hostAdapter.getRuntimeContext().dataDir;
    this.runnerFactory = opts.hostAdapter.getLLMRunnerFactory();
    this.sessionFilter = opts.sessionFilter ?? new SessionFilter([]);
    this.instanceId = opts.instanceId;
  }

  // ============================
  // Lifecycle
  // ============================
  // 中文：生命周期

  /**
   * Initialize data directories, storage, and pipeline scheduler.
   * Must be called once before any other methods.
   * 中文：初始化数据目录、存储和管道调度器。
   * 必须在调用任何其他方法之前至少被调用一次。
   */
  async initialize(): Promise<void> {
    this.logger.debug?.(`${TAG} Initializing TDAI Core: dataDir=${this.dataDir}`);
    initDataDirectories(this.dataDir);

    // Initialize stores (async)
    // 中文：初始化存储（异步）
    this.storeReady = this.initStores();

    // Create pipeline manager (sync — does not need store)
    // 中文：创建管道管理器（同步 —— 不需要存储）
    if (this.cfg.extraction.enabled) {
      this.scheduler = createPipelineManager(this.cfg, this.logger, this.sessionFilter);
      // Wire runners after store is ready (or after store init fails — runners
      // still work in degraded mode with JSONL fallback and no embedding)
      // 中文：在存储准备好后连接运行器（或在存储初始化失败后 —— 运行器仍然以JSONL回退模式和无嵌入的降级模式工作）
      this.storeReady
        .then(() => this.wirePipelineRunners())
        .catch((err) => {
          this.logger.error(`${TAG} Store init failed; wiring pipeline runners in degraded mode: ${err instanceof Error ? err.message : String(err)}`);
          this.wirePipelineRunners();
        });
    }

    this.logger.debug?.(`${TAG} TDAI Core initialized`);
  }

  /**
   * Destroy all resources. Call on shutdown.
   * 中文：销毁所有资源。在关闭时调用。
   */
  async destroy(): Promise<void> {
    this.logger.debug?.(`${TAG} Destroying TDAI Core...`);

    // Wait for store init to complete before tearing down
    // 中文：等待store初始化完成后再销毁
    await this.storeReady?.catch(() => {});

    if (this.scheduler && this.schedulerStartPromise) {
      await this.scheduler.destroy();
      this.schedulerStartPromise = undefined;
      this.logger.debug?.(`${TAG} Scheduler destroyed`);
    }

    // Drain fire-and-forget background tasks started by auto-capture
    // (currently: deferred L0 embedding writes).  We must wait for
    // them here — BEFORE closing vectorStore / embeddingService —
    // otherwise a late updateL0Embedding lands on an already-closed
    // DB connection and either throws "database is not open" or
    // (worse) corrupts state.  A hard timeout keeps destroy bounded
    // when a background task is stuck on a hung embed HTTP call.
    // 中文：在关闭vectorStore / embeddingService之前，处理自动捕获启动的后台任务（当前：延迟L0嵌入写操作）。我们必须在这里等待——否则，一个晚些时候的updateL0Embedding会落在已经关闭的数据库连接上，并且要么抛出"数据库未打开"错误，更糟糕的是会损坏状态。硬性超时可以确保在后台任务卡住时销毁操作保持有界
    if (this.bgTasks.size > 0) {
      const pending = [...this.bgTasks];
      this.logger.debug?.(
        `${TAG} Draining ${pending.length} background task(s) before closing stores...`,
      );
      const BG_DRAIN_TIMEOUT_MS = 5_000;
      let drainTimeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending).then(() => undefined),
          new Promise<never>((_, reject) => {
            drainTimeoutId = setTimeout(
              () => reject(new Error("bgTasks drain timeout")),
              BG_DRAIN_TIMEOUT_MS,
            );
          }),
        ]);
        this.logger.debug?.(`${TAG} Background tasks drained`);
      } catch (err) {
        this.logger.warn(
          `${TAG} Background-task drain timed out (${BG_DRAIN_TIMEOUT_MS}ms): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Closing stores anyway — residual writes may surface as warnings.`,
        );
      } finally {
        if (drainTimeoutId !== undefined) clearTimeout(drainTimeoutId);
      }
    }

    if (this.vectorStore) {
      this.vectorStore.close();
      this.vectorStore = undefined;
      this.logger.debug?.(`${TAG} VectorStore closed`);
    }

    if (this.embeddingService?.close) {
      try {
        await this.embeddingService.close();
      } catch (err) {
        this.logger.warn(`${TAG} EmbeddingService close error: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.embeddingService = undefined;
    }

    resetStores(this.dataDir);
    this.logger.debug?.(`${TAG} TDAI Core destroyed`);
  }

  // ============================
  // Core capabilities
  // ============================
  // 中文：核心能力

  /**
   * Handle recall (memory retrieval) before an LLM turn.
   * Maps to: OpenClaw `before_prompt_build` / Hermes `prefetch()`.
   * 中文：在LLM回合前处理回忆（记忆检索）。对应于：OpenClaw `before_prompt_build` / Hermes `prefetch()`。
   */
  async handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult> {
    await this.storeReady?.catch(() => {});

    const result = await performAutoRecall({
      userText,
      actorId: "default_user",
      sessionKey,
      cfg: this.cfg,
      pluginDataDir: this.dataDir,
      logger: this.logger,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
    });

    return result ?? {};
  }

  /**
   * Handle turn commitment (conversation capture + pipeline trigger).
   * Maps to: OpenClaw `agent_end` / Hermes `sync_turn()`.
   * 中文：处理回合承诺（对话捕获+流水线触发）。对应于：OpenClaw `agent_end` / Hermes `sync_turn()`。
   */
  async handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult> {
    await this.storeReady?.catch(() => {});
    await this.ensureSchedulerStarted();

    return performAutoCapture({
      messages: turn.messages,
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
      cfg: this.cfg,
      pluginDataDir: this.dataDir,
      logger: this.logger,
      scheduler: this.scheduler,
      originalUserText: turn.userText,
      originalUserMessageCount: turn.originalUserMessageCount,
      pluginStartTimestamp: turn.startedAt ?? Date.now(),
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      bgTaskRegistry: this.bgTasks,
    });
  }

  /**
   * Search L1 structured memories.
   * Maps to: `tdai_memory_search` tool.
   * 中文：搜索L1结构化记忆。对应于：`tdai_memory_search` 工具。
   */
  async searchMemories(params: MemorySearchParams): Promise<{ text: string; total: number; strategy: string }> {
    const result = await executeMemorySearch({
      query: params.query,
      limit: params.limit ?? 5,
      type: params.type,
      scene: params.scene,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
    });

    return {
      text: formatSearchResponse(result),
      total: result.total,
      strategy: result.strategy,
    };
  }

  /**
   * Search L0 raw conversations.
   * Maps to: `tdai_conversation_search` tool.
   * 中文：搜索L0原始对话。对应于：`tdai_conversation_search` 工具。
   */
  async searchConversations(params: ConversationSearchParams): Promise<{ text: string; total: number }> {
    const result = await executeConversationSearch({
      query: params.query,
      limit: params.limit ?? 5,
      sessionKey: params.sessionKey,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
    });

    return {
      text: formatConversationSearchResponse(result),
      total: result.total,
    };
  }

  /**
   * Handle end-of-conversation for a single session.
   *
   * ⚠️ Read this if you are editing the method:
   *
   * There are two distinct shutdown-ish events, and they must **NOT**
   * share an implementation:
   *
   *   - **`gateway_stop` (OpenClaw / process exit)**
   *     The host is going away.  Tear everything down — scheduler,
   *     VectorStore, EmbeddingService, caches.  That is
   *     {@link destroy}, not this method.
   *
   *   - **`on_session_end` (Hermes) / `POST /session/end` (Gateway)**
   *     One conversation ended while the process keeps serving other
   *     concurrent sessions.  **Only** this session's buffered work
   *     should be flushed; every other session's timers, buffers,
   *     pipeline state, and the shared scheduler itself MUST remain
   *     untouched.  That is this method.
   *
   * Historically this method did ``scheduler.destroy() +
   * createPipelineManager()``, which conflated the two semantics and
   * wiped concurrent sessions' in-memory state on every ``/session/end``
   * call.  That bug is covered by the concurrency test
   * ``P0-1: handleSessionEnd must be scoped to its session``.
   *
   * @param sessionKey  Session whose buffered work should be flushed.
   *                    Unknown keys are tolerated as a no-op so callers
   *                    don't have to pre-check whether the session was
   *                    already evicted or never produced a capture.
   * 中文：处理单会话结束。⚠️ 如果你正在编辑此方法，请阅读以下内容：存在两种不同的关闭事件，它们必须**不**共享实现：- **`gateway_stop`（OpenClaw / 进程退出）** 主机即将离开。销毁一切——调度器、VectorStore、EmbeddingService、缓存。这是 {@link destroy}，不是此方法。- **`on_session_end`（Hermes）/ `POST /session/end`（网关）** 一个对话结束而进程继续为其他并发会话服务。只有此会话的缓冲工作应该被刷新；所有其他会话的定时器、缓冲区、流水线状态以及共享调度器本身必须保持不变。这是此方法。历史上，此方法执行了 `scheduler.destroy() + createPipelineManager()`，这将两种语义混淆在一起，并在每次`/session/end`调用时清除了并发会话的内存状态。该错误由并发测试`P0-1: handleSessionEnd 必须针对其会话进行范围限制`覆盖。@param sessionKey  应刷新缓冲工作的会话键。未知键作为空操作处理，因此调用者不需要预先检查会话是否已被移除或从未产生捕获。
   */
  async handleSessionEnd(sessionKey: string): Promise<void> {
    if (!sessionKey) return;
    await this.storeReady?.catch(() => {});
    if (!this.scheduler) return;
    await this.scheduler.flushSession(sessionKey);
  }

  // ============================
  // Accessors (for migration bridge)
  // ============================
  // 中文：访问器（用于迁移桥梁）

  /** Get the LLM runner factory (for creating host-neutral LLM runners). */
  /** 中文：获取LLM运行器工厂（用于创建主机无关的LLM运行器）. */
  getLLMRunnerFactory(): LLMRunnerFactory {
    return this.runnerFactory;
  }

  /** Get the shared VectorStore (may be undefined if init failed). */
  /** 中文：获取共享向量存储（如果初始化失败，可能未定义）。 */
  getVectorStore(): IMemoryStore | undefined {
    return this.vectorStore;
  }

  /** Get the shared EmbeddingService (may be undefined if not configured). */
  /** 中文：获取共享嵌入式服务（如果没有配置，则可能未定义）。 */
  getEmbeddingService(): EmbeddingService | undefined {
    return this.embeddingService;
  }

  /** Get the pipeline scheduler (may be undefined if extraction disabled). */
  /** 中文：获取管道调度器（如果提取禁用，则可能未定义）。 */
  getScheduler(): MemoryPipelineManager | undefined {
    return this.scheduler;
  }

  /** Whether the scheduler has been started (or is currently starting). */
  /** 中文：调度器是否已启动（或当前正在启动）。 */
  isSchedulerStarted(): boolean {
    return this.schedulerStartPromise !== undefined;
  }

  /** Set the instance ID for metrics (may be resolved asynchronously). */
  /** 中文：设置用于指标的实例ID（可能异步解析）。 */
  setInstanceId(id: string): void {
    this.instanceId = id;
    if (this.scheduler) {
      this.scheduler.instanceId = id;
    }
  }

  // ============================
  // Internal helpers
  // ============================
  // 中文：内部辅助函数

  private async initStores(): Promise<void> {
    try {
      const stores = await initStores(this.cfg, this.dataDir, this.logger);
      this.vectorStore = stores.vectorStore;
      this.embeddingService = stores.embeddingService;
      this.logger.debug?.(`${TAG} Stores initialized: backend=${this.cfg.storeBackend}, embedding=${this.cfg.embedding.provider}`);
    } catch (err) {
      this.logger.warn(
        `${TAG} Store init failed; recall/dedup degraded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private wirePipelineRunners(): void {
    if (!this.scheduler) return;

    // Determine whether to use standalone LLM runner for extraction.
    // Priority: cfg.llm.enabled (explicit override) > hostType detection.
    // 中文：确定是否使用独立的LLM运行器进行提取。
    // 优先级：cfg.llm.enabled（显式覆盖）> hostType检测。
    const useStandaloneRunner = this.cfg.llm.enabled || this.hostAdapter.hostType !== "openclaw";

    const openclawConfig = (!useStandaloneRunner && this.hostAdapter.hostType === "openclaw")
      ? (this.hostAdapter as { getOpenClawConfig?(): unknown }).getOpenClawConfig?.()
      : undefined;

    // When standalone runner is active, create LLM runners from the factory.
    // If cfg.llm is configured AND we're in OpenClaw mode, build a dedicated
    // StandaloneLLMRunnerFactory from cfg.llm to override the host runner.
    // 中文：当独立运行器激活时，从工厂创建LLM运行器。
    // 如果cfg.llm已配置且我们处于OpenClaw模式，则根据cfg.llm构建一个专用
    // StandaloneLLMRunnerFactory以覆盖主机运行器。
    let runnerFactory = this.runnerFactory;
    if (useStandaloneRunner && this.cfg.llm.enabled && this.hostAdapter.hostType === "openclaw") {
      runnerFactory = new StandaloneLLMRunnerFactory({
        config: {
          baseUrl: this.cfg.llm.baseUrl,
          apiKey: this.cfg.llm.apiKey,
          model: this.cfg.llm.model,
          maxTokens: this.cfg.llm.maxTokens,
          timeoutMs: this.cfg.llm.timeoutMs,
          disableThinking: this.cfg.llm.disableThinking,
        },
        logger: this.logger,
      });
      this.logger.debug?.(`${TAG} Using standalone LLM override: model=${this.cfg.llm.model}, baseUrl=${this.cfg.llm.baseUrl}`);
    }

    const l1LlmRunner = useStandaloneRunner
      ? runnerFactory.createRunner({ enableTools: false })
      : undefined;
    const l2l3LlmRunner = useStandaloneRunner
      ? runnerFactory.createRunner({ enableTools: true })
      : undefined;

    // L1 runner
    // 中文：L1运行器
    this.scheduler.setL1Runner(createL1Runner({
      pluginDataDir: this.dataDir,
      cfg: this.cfg,
      openclawConfig,
      vectorStore: this.vectorStore,
      embeddingService: this.embeddingService,
      logger: this.logger,
      getInstanceId: () => this.instanceId,
      llmRunner: l1LlmRunner,
    }));

    // Persister
    // 中文：持久化
    this.scheduler.setPersister(createPersister(this.dataDir, this.logger));

    // L2 runner
    // 中文：L2运行器
    this.scheduler.setL2Runner(async (sessionKey: string, cursor?: string) => {
      const l2Runner = createL2Runner({
        pluginDataDir: this.dataDir,
        cfg: this.cfg,
        openclawConfig,
        vectorStore: this.vectorStore,
        logger: this.logger,
        instanceId: this.instanceId,
        llmRunner: l2l3LlmRunner,
      });
      return l2Runner(sessionKey, cursor);
    });

    // L3 runner
    // 中文：L3运行器
    this.scheduler.setL3Runner(async () => {
      const l3Runner = createL3Runner({
        pluginDataDir: this.dataDir,
        cfg: this.cfg,
        openclawConfig,
        vectorStore: this.vectorStore,
        logger: this.logger,
        instanceId: this.instanceId,
        llmRunner: l2l3LlmRunner,
      });
      await l3Runner();
    });

    this.logger.debug?.(`${TAG} Pipeline runners wired`);
  }

  private ensureSchedulerStarted(): Promise<void> {
    // Fast path: already started (or starting) — every concurrent caller
    // awaits the same in-flight promise.  The promise is kept around as a
    // permanently-resolved sentinel after success so subsequent calls
    // collapse into a cheap already-resolved await.
    // 中文：快速路径：已经启动（或正在启动）——每个并发调用者
    // 等待同一个正在进行中的承诺。成功后，该承诺保持为永久解析的哨兵，因此后续调用
    // 会坍缩为一个廉价已解析的await。
    if (this.schedulerStartPromise) return this.schedulerStartPromise;
    if (!this.scheduler) return Promise.resolve();

    // Capture scheduler locally so TypeScript narrows inside the closure
    // even after ``this.scheduler`` is re-assigned by handleSessionEnd.
    // 中文：在本地捕获调度程序以使TypeScript在闭包内部进行类型限制
    // even after ``this.scheduler``由handleSessionEnd重新分配.
    const scheduler = this.scheduler;
    this.schedulerStartPromise = (async () => {
      try {
        const checkpoint = new CheckpointManager(this.dataDir, this.logger);
        const cp = await checkpoint.read();
        scheduler.start(checkpoint.getAllPipelineStates(cp));
        this.logger.debug?.(`${TAG} Scheduler started`);
      } catch (err) {
        this.logger.error(`${TAG} Failed to restore checkpoint: ${err instanceof Error ? err.message : String(err)}`);
        scheduler.start({});
      }
    })();

    // If the start sequence itself rejects we clear the gate so the next
    // caller can retry; on success we keep the resolved promise so it
    // short-circuits permanently.
    // 中文：如果起始序列本身拒绝，则清除门限，以便下一个调用者可以重试；在成功时我们保持已解决的承诺，使其永久短路。
    this.schedulerStartPromise.catch(() => {
      this.schedulerStartPromise = undefined;
    });

    return this.schedulerStartPromise;
  }
}
