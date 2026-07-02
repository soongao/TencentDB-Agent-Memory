/**
 * MemoryPipelineManager: manages the L0→L1→L2→L3 memory extraction pipeline.
 *
 * ## Layered architecture
 *
 * - **L0 (capture)**: `auto-capture.ts` extracts new messages from each
 *   `agent_end` event, sanitizes them, and passes them to the pipeline via
 *   `notifyConversation(sessionKey, messages)`. Messages are buffered
 *   locally per-session — NO remote call happens at this stage.
 *
 * - **L1 (batch extraction / ingest)**: When the conversation count reaches
 *   `everyNConversations` OR the session goes idle for `l1IdleTimeoutSeconds`,
 *   the L1 Runner is invoked with all buffered messages. The runner receives
 *   `{ sessionKey, msg, bg_msg }` and is responsible for ingesting/extracting
 *   them (e.g. calling appendEvent, or running local extraction logic).
 *   `bg_msg` is reserved for background context; currently always empty.
 *
 * - **L2 (scene extraction)**: Per-session downward-only timer. After each
 *   L2 completion, the next fire time is set to `now + maxInterval`. When
 *   L1 completes (new memory event), the fire time is advanced (but never
 *   postponed) to `max(now + delay, lastL2 + minInterval)`. When the timer
 *   fires, if the session is cold (inactive > `sessionActiveWindowHours`),
 *   the timer is cancelled rather than triggering L2 — it will be re-armed
 *   by the next L1 event.
 *
 * - **L3 (persona generation)**: Global mutex (concurrency=1) + pending flag
 *   dedup. Triggered after L2 completes.
 *
 * ## Timer semantics
 *
 * L1 uses a **resettable timer** (classic idle/debounce): each conversation
 * resets the countdown to `l1IdleTimeoutSeconds`. When the timer fires,
 * buffered messages are flushed through L1.
 *
 * L2 uses a **downward-only timer**: the scheduled fire time can only be
 * moved earlier, never later. This ensures both the maxInterval guarantee
 * and the delay-after-L1 responsiveness, while minInterval acts as a floor.
 *
 * Both timer types are implemented via `ManagedTimer` to eliminate
 * repetitive clear→set→fire→clean boilerplate.
 *
 * ## Trigger paths for L1
 *   A. **Conversation threshold** (primary): when `conversation_count >=
 *      effectiveThreshold` in `notifyConversation()`, L1 is triggered
 *      immediately with all buffered messages. The effective threshold
 *      is influenced by warm-up mode (see below).
 *   B. **Idle timeout** (catch-up): when a session goes idle for
 *      `l1IdleTimeoutSeconds`, L1 fires with whatever messages have
 *      been buffered (below threshold).
 *   C. **Shutdown flush**: on graceful shutdown, all pending buffers
 *      are flushed through L1 then L2.
 *
 * ## Warm-up mode
 *
 * When `enableWarmup` is true (default), new sessions use an exponentially
 * increasing L1 trigger threshold instead of jumping straight to
 * `everyNConversations`. The sequence is: 1 → 2 → 4 → 8 → ... →
 * everyNConversations. This ensures early conversations are processed
 * quickly (first conversation triggers L1 immediately), while gradually
 * reducing processing frequency as the session matures.
 *
 * The `warmup_threshold` field in PipelineSessionState tracks the current
 * threshold. A value of 0 means warm-up is complete (graduated to
 * steady-state). The threshold doubles after each successful L1 run.
 *
 * ## Trigger paths for L2
 *   A. **Delay-after-L1**: L1 completes → timer advanced to
 *      `max(now + delay, lastL2 + min)` → fires → enqueue L2.
 *   B. **MaxInterval guarantee**: L2 completes → timer set to
 *      `now + maxInterval` → fires → enqueue L2 (if session active).
 *   C. **Shutdown flush**: all pending L2 timers are flushed.
 *
 * All queues use SerialQueue (concurrency=1) for serial execution.
 *
 * ## Design doc
 * See `docs/08-pipeline-refactor-design.md` for full architecture.
 * 中文：{"MemoryPipelineManager": "管理L0→L1→L2→L3内存提取管道。
 * ## 分层架构
 * - **L0（捕获）**: `auto-capture.ts`从每个`agent_end`事件中提取新消息，对其进行清理，并通过`notifyConversation(sessionKey, messages)`将它们传递给管道。消息在会话级别本地缓冲——此阶段不会发生远程调用。
 * - **L1（批量提取/摄取）**: 当对话数量达到`everyNConversations`或会话闲置`l1IdleTimeoutSeconds`时，调用L1运行器并传入所有缓存的消息。运行器接收`{ sessionKey, msg, bg_msg }`并负责摄取/提取它们（例如调用appendEvent，或者运行本地提取逻辑）。`bg_msg`用于背景上下文；目前总是空的。
 * - **L2（场景提取）**: 每个会话仅向下计时器。每次L2完成后，下一次触发时间设置为`now + maxInterval`。当L1完成（新记忆事件）时，触发时间提前（但不会推迟），设置为`max(now + delay, lastL2 + minInterval)`。当定时器触发时，如果会话冷态（闲置> `sessionActiveWindowHours`），则取消计时器而不是触发L2——它将在下一个L1事件中重新武装。
 * - **L3（人物生成）**: 全局互斥量（并发=1）+ 待处理标志去重。在L2完成后触发。
 * ## 定时器语义
 * L1使用一个**可重置定时器**（经典空闲/防抖动）：每次对话重置倒计时为`l1IdleTimeoutSeconds`。当定时器触发时，缓存的消息将通过L1刷新。
 * L2使用一个**仅向下定时器**：计划的触发时间只能提前，不能推迟。这确保了最大间隔保证和L1后的响应性，而最小间隔作为底线。
 * 这两种类型的定时器都通过`ManagedTimer`实现以消除重复的清除→设置→触发→清理的样板代码。
 * ## L1触发路径
 * A. **对话阈值**（主要）：当`notifyConversation()`中的`conversation_count >= effectiveThreshold`时，立即使用所有缓存的消息触发L1。有效的阈值受预热模式的影响（见下文）。
 * B. **空闲超时**（追赶）：当会话闲置`l1IdleTimeoutSeconds`时，以任何已缓存的消息触发L1（低于阈值）。
 * C. **优雅关闭刷新**：在优雅关闭时，所有待处理缓冲区将通过L1然后是L2刷新。
 * ## 预热模式
 * 当`enableWarmup`为真（默认值）时，新会话使用指数增长的L1触发阈值而不是直接跳到`everyNConversations`。序列如下：1 → 2 → 4 → 8 → ... → `everyNConversations`。这确保了早期对话可以快速处理（第一个对话立即触发L1），同时随着会话成熟逐渐减少处理频率。
 * `PipelineSessionState`中的`warmup_threshold`字段跟踪当前阈值。值为0表示预热完成（毕业到稳定状态）。每次成功运行L1后，阈值翻倍。
 * ## L2触发路径
 * A. **L1之后的延迟**：L1完成后 → 定时器提前到`max(now + delay, lastL2 + min)` → 触发 → 入队L2。
 * B. **最大间隔保证**：L2完成后 → 定时器设置为`now + maxInterval` → 触发 → 入队L2（如果会话活跃）。
 * C. **优雅关闭刷新**：所有待处理的L2定时器被刷新。
 * 所有队列使用SerialQueue（并发=1）进行串行执行。
 * ## 设计文档
 * 请参阅`docs/08-pipeline-refactor-design.md`以获取完整架构。}
 */

import type { PipelineSessionState } from "./checkpoint.js";
import { SessionFilter } from "./session-filter.js";
import { ManagedTimer } from "./managed-timer.js";
import { SerialQueue } from "./serial-queue.js";
import { report } from "../core/report/reporter.js";
import type { Logger } from "../core/types.js";

// ============================
// Types
// ============================

/** A single captured message ready for L1 processing. */
/** 中文：单个捕获的消息，准备用于L1处理。 */
export interface CapturedMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** ISO timestamp string */
  /** 中文：ISO时间戳字符串 */
  timestamp: string;
}

/** Pipeline configuration — all time values in seconds. */
/** 中文：管道配置 — 所有时间值为秒。 */
export interface PipelineConfig {
  /**
   * Conversation count threshold to trigger L1 batch processing.
   * When a session's conversation_count reaches this value,
   * L1 is triggered immediately with all buffered messages.
   * Default: 5.
   * 中文：触发L1批量处理的对话计数阈值。
   * 当会话的conversation_count达到此值时，
   * 立即使用所有缓存的消息触发L1。
   * 默认：5。
   */
  everyNConversations: number;

  /**
   * Enable warm-up mode for new sessions.
   * When enabled, the L1 trigger threshold starts at 1 and doubles after
   * each successful L1 run (1 → 2 → 4 → 8 → ... → everyNConversations),
   * allowing early sessions to be processed more aggressively.
   * Default: true.
   * 中文：启用新会话的预热模式。
   * 启用时，L1触发阈值从1开始并在每次成功运行后翻倍（1 → 2 → 4 → 8 → ... → everyNConversations），
   * 允许早期会话更积极地处理。
   * 默认：true。
   */
  enableWarmup: boolean;

  l1: {
    /** Idle timeout before triggering L1 (seconds, default: 60) */
    /** 中文：在触发L1之前的空闲超时时长（秒，默认：60） */
    idleTimeoutSeconds: number;
  };

  l2: {
    /**
     * Delay after L1 completes before triggering L2 (seconds, default: 90).
     * Allows remote L1 to finish generating records asynchronously.
     * 中文：L1完成后触发L2的延迟时长（秒，默认：90）。
     * 允许远程L1异步完成记录生成。
     */
    delayAfterL1Seconds: number;
    /** Minimum interval between L2 extractions per session (seconds, default: 900) */
    /** 中文：L2每次会话之间的最小间隔（秒，默认：900） */
    minIntervalSeconds: number;
    /**
     * Maximum interval between L2 extractions per session (seconds, default: 3600).
     * Even without new L1 completions, L2 will poll at this interval for active sessions.
     * 中文：L2每次会话之间的最大间隔（秒，默认：3600）。即使没有新的L1完成，L2也会在此间隔内为活动会话进行轮询。
     */
    maxIntervalSeconds: number;
    /**
     * Sessions inactive longer than this (hours, default: 24) stop L2 polling.
     * Prevents wasting resources on abandoned sessions.
     * 中文：如果会话长时间未活跃（小时，默认：24），停止L2轮询。防止浪费资源在被放弃的会话上。
     */
    sessionActiveWindowHours: number;
  };
}

/** Result returned by the L1 runner. */
/** 中文：L1运行器返回的结果。 */
export interface L1RunnerResult {
  /** Number of messages successfully processed */
  /** 中文：成功处理的消息数量。 */
  processedCount?: number;
}

/** L1 runner — batch-processes buffered messages for a session. */
/** 中文：L1运行器——批量处理会话缓冲区中的消息。 */
export type L1Runner = (params: {
  sessionKey: string;
  msg: CapturedMessage[];
  bg_msg: CapturedMessage[];
}) => Promise<L1RunnerResult | void>;

/** Result returned by the L2 extraction runner. */
/** 中文：L2提取运行器返回的结果。 */
export interface L2RunnerResult {
  /** The latest `updated_at` cursor from the processed batch. */
  /** 中文：已处理批次的最新`updated_at`游标. */
  latestCursor?: string;
  /** True if no new records were found and extraction was skipped. */
  /** 中文：如果没有找到新记录且提取被跳过，则为真。 */
  skipped?: boolean;
}

/** L2 extraction runner — processes a single session's records. */
/** 中文：L2提取运行器——处理单个会话的记录。 */
export type L2Runner = (sessionKey: string, cursor?: string) => Promise<L2RunnerResult | void>;

/** L3 runner — generates persona from all sessions' scene data. */
/** 中文：L3运行器——从所有会话的场景数据生成人物。 */
export type L3Runner = () => Promise<void>;

/** Callback to persist session states to checkpoint. */
/** 中文：持久化会话状态到检查点的回调。 */
export type PipelineStatePersister = (states: Record<string, PipelineSessionState>) => Promise<void>;

const TAG = "[memory-tdai] [pipeline]";

// ============================
// Per-session timer state (in memory only)
// ============================
// 中文：会话级别的计时器状态（仅内存中）。

interface SessionTimerState {
  /** L1 idle timer (resettable): debounces conversation activity. */
  /** 中文：L1空闲计时器（可重置）：防抖处理对话活动。 */
  l1Idle: ManagedTimer;
  /** L2 schedule timer (downward-only): next L2 fire time, only moves earlier. */
  /** 中文：L2调度计时器（单向向下）：下次L2触发时间，只可提前。 */
  l2Schedule: ManagedTimer;
  /** Whether an L1 task is already queued or running for this session. */
  /** 中文：此会话是否已排队或正在运行一个L1任务。 */
  l1Queued: boolean;
  /** Whether an L2 task is already queued or running for this session. */
  /** 中文：是否已经有L2任务被排队或正在此会话中运行。 */
  l2Queued: boolean;
  /** Consecutive L1 failure count for retry limiting. Reset on success or new conversation. */
  /** 中文：连续的L1失败次数，用于重试限制。在成功或新对话时重置。 */
  l1RetryCount: number;
}

export class MemoryPipelineManager {
  // Config (converted to ms internally)
  // 中文：配置（内部转换为ms）。
  private readonly l1IdleTimeoutMs: number;
  private readonly everyNConversations: number;
  private readonly enableWarmup: boolean;
  private readonly l2DelayAfterL1Ms: number;
  private readonly l2MinIntervalMs: number;
  private readonly l2MaxIntervalMs: number;
  private readonly sessionActiveWindowMs: number;

  /** Delay before retrying a failed L1 (ms). */
  /** 中文：在L1失败后重新尝试之前的延迟时间（ms）。 */
  private readonly L1_RETRY_DELAY_MS = 30_000; // 30 seconds
  // 中文：30 seconds
  /** Max consecutive L1 retries per session before giving up. */
  /** 中文：每个会话中L1的最大连续重试次数，在放弃之前。 */
  private readonly L1_MAX_RETRIES = 5;

  // Queues (named for diagnostics)
  // 中文：队列（用于诊断命名）
  private readonly l1Queue = new SerialQueue("L1");
  private readonly l2Queue = new SerialQueue("L2");
  private readonly l3Queue = new SerialQueue("L3");

  // L3 dedup flag
  // 中文：L3去重标志
  private l3Pending = false;
  private l3Running = false;

  // Per-session state
  // 中文：会话状态
  private readonly sessionStates = new Map<string, PipelineSessionState>();
  private readonly sessionTimers = new Map<string, SessionTimerState>();

  // Per-session message buffer: messages accumulated since last L1 run
  // 中文：会话缓冲区：上次L1运行以来累积的消息
  private readonly messageBuffers = new Map<string, CapturedMessage[]>();

  // Per-session L2 last run time (epoch ms, for minInterval floor)
  // 中文：会话L2最后运行时间（毫秒时间戳，用于minInterval底限计算）
  private readonly l2LastRunTime = new Map<string, number>();

  // Callbacks
  // 中文：回调函数
  private l1Runner: L1Runner | null = null;
  private l2Runner: L2Runner | null = null;
  private l3Runner: L3Runner | null = null;
  private persister: PipelineStatePersister | null = null;
  private logger: Logger | undefined;

  // Unified session filter (internal sessions + excludeAgents)
  // 中文：统一的会话过滤器（内部会话+excludeAgents排除代理）
  private readonly sessionFilter: SessionFilter;

  // Lifecycle
  // 中文：生命周期
  private destroyed = false;

  /** Plugin instance ID for metric reporting (set externally after async init). */
  /** 中文：用于指标报告的插件实例ID（异步初始化后外部设置） */
  instanceId?: string;

  // Session GC: runs periodically to evict cold sessions from memory
  // 中文：会话GC：定期运行以从内存中移除冷会话
  /** Multiplier on sessionActiveWindowMs to determine GC eligibility. */
  /** 中文：确定GC资格的会话活动窗口时间乘数 */
  private readonly SESSION_GC_INACTIVE_MULTIPLIER = 3;
  /** Run GC every N calls to notifyConversation. */
  /** 中文：每N次调用notifyConversation时运行GC. */
  private readonly SESSION_GC_EVERY_N_NOTIFICATIONS = 50;
  /** Counter for GC scheduling. */
  /** 中文：GC调度计数器. */
  private notifyCounter = 0;

  constructor(config: PipelineConfig, logger?: Logger, sessionFilter?: SessionFilter) {
    this.l1IdleTimeoutMs = config.l1.idleTimeoutSeconds * 1000;
    this.everyNConversations = config.everyNConversations;
    this.enableWarmup = config.enableWarmup;
    this.l2DelayAfterL1Ms = config.l2.delayAfterL1Seconds * 1000;
    this.l2MinIntervalMs = config.l2.minIntervalSeconds * 1000;
    this.l2MaxIntervalMs = config.l2.maxIntervalSeconds * 1000;
    this.sessionActiveWindowMs = config.l2.sessionActiveWindowHours * 60 * 60 * 1000;
    this.logger = logger;
    this.sessionFilter = sessionFilter ?? new SessionFilter();

    this.logger?.debug?.(
      `${TAG} Initialized: everyNConversations=${config.everyNConversations}, ` +
      `warmup=${config.enableWarmup ? "enabled" : "disabled"}, ` +
      `l1IdleTimeout=${config.l1.idleTimeoutSeconds}s, ` +
      `l2DelayAfterL1=${config.l2.delayAfterL1Seconds}s, ` +
      `l2MinInterval=${config.l2.minIntervalSeconds}s, ` +
      `l2MaxInterval=${config.l2.maxIntervalSeconds}s, ` +
      `sessionActiveWindow=${config.l2.sessionActiveWindowHours}h`,
    );

    // Wire up queue debug logging
    // 中文：连接队列调试日志.
    if (this.logger?.debug) {
      const debugFn = (msg: string) => this.logger?.debug?.(`${TAG} ${msg}`);
      this.l1Queue.setDebugLogger(debugFn);
      this.l2Queue.setDebugLogger(debugFn);
      this.l3Queue.setDebugLogger(debugFn);
    }
  }

  // ============================
  // Setup
  // ============================

  setL1Runner(runner: L1Runner): void {
    this.l1Runner = runner;
  }

  setL2Runner(runner: L2Runner): void {
    this.l2Runner = runner;
  }

  setL3Runner(runner: L3Runner): void {
    this.l3Runner = runner;
  }

  setPersister(persister: PipelineStatePersister): void {
    this.persister = persister;
  }

  /**
   * Restore session states from checkpoint and start the pipeline.
   * Sessions with pending counts will be immediately re-enqueued.
   * 中文：从检查点恢复会话状态并启动管道。
   * 带有未完成任务的会话将立即重新入队列.
   */
  start(restoredStates?: Record<string, PipelineSessionState>): void {
    if (this.destroyed) return;

    if (restoredStates) {
      let skipped = 0;
      for (const [sessionKey, state] of Object.entries(restoredStates)) {
        if (this.sessionFilter.shouldSkip(sessionKey)) {
          skipped++;
          continue;
        }
        // Backfill warmup_threshold for sessions persisted before warm-up feature.
        // Missing field → treat as graduated (warmup already complete).
        // 中文：为持久化前的会话回填warmup_threshold。
        // 缺失字段→视为毕业（暖身已完成）.
        const patched = { ...state };
        if (patched.warmup_threshold == null) {
          patched.warmup_threshold = 0;
        }
        this.sessionStates.set(sessionKey, patched);
      }
      this.logger?.info(
        `${TAG} Restored ${this.sessionStates.size} session state(s) from checkpoint` +
        (skipped > 0 ? ` (filtered ${skipped} internal)` : ""),
      );
    }

    // Recovery: re-enqueue sessions with pending work
    // 中文：恢复：重新入队列带有待处理工作的会话.
    this.recoverPendingSessions();

    this.logger?.info(`${TAG} Pipeline started`);
  }

  // ============================
  // L0→L1: Notify (called from auto-capture on agent_end)
  // ============================
  // 中文：L0→L1: 通知（从代理结束的自动捕获调用）

  /**
   * Get the effective conversation threshold for a session, considering warm-up.
   *
   * When warm-up is enabled, new sessions start with threshold=1 and double
   * after each successful L1 run: 1 → 2 → 4 → 8 → ... → everyNConversations.
   * Once the threshold reaches everyNConversations, warm-up is considered complete
   * (warmup_threshold is set to 0) and the fixed config value is used.
   * 中文：获取考虑暖身后的会话有效对话阈值。
   * 当启用暖身时，新会话开始时阈值=1，并在每次成功L1运行后翻倍：1 → 2 → 4 → 8 → ... → everyNConversations。
   * 一旦阈值达到everyNConversations，视为暖身完成（warmup_threshold设置为0），并使用固定配置值。
   */
  private getEffectiveThreshold(state: PipelineSessionState): number {
    if (!this.enableWarmup) return this.everyNConversations;
    // warmup_threshold === 0 means warm-up completed; use steady-state config
    // 中文：warmup_threshold === 0 表示暖启动完成；使用稳定状态配置
    if (state.warmup_threshold <= 0) return this.everyNConversations;
    return Math.min(state.warmup_threshold, this.everyNConversations);
  }

  /**
   * Advance the warm-up threshold for a session after a successful L1 run.
   * Doubles the threshold until it reaches everyNConversations, then marks
   * warm-up as complete (warmup_threshold = 0).
   * 中文：在一次成功的L1运行后，为会话推进暖启动阈值。
   * 每次翻倍阈值直到达到everyNConversations，然后标记
   * 暖启动为完成（warmup_threshold = 0）
   */
  private advanceWarmupThreshold(state: PipelineSessionState): void {
    if (!this.enableWarmup) return;
    if (state.warmup_threshold <= 0) return; // already graduated
    // 中文：已经毕业

    const next = state.warmup_threshold * 2;
    if (next >= this.everyNConversations) {
      // Graduated: switch to steady-state
      // 中文：逐步过渡：切换到稳定状态
      state.warmup_threshold = 0;
      this.logger?.debug?.(`${TAG} Warm-up graduated → using steady-state threshold ${this.everyNConversations}`);
    } else {
      state.warmup_threshold = next;
      this.logger?.debug?.(`${TAG} Warm-up advanced → next threshold ${next}`);
    }
  }

  /**
   * Notify the pipeline that a conversation round has ended for a session,
   * and buffer the captured messages for L1 batch processing.
   *
   * Two trigger paths start here:
   * - **Path A (threshold)**: if conversation_count >= effective threshold
   *   (warm-up or steady-state), trigger L1 immediately with all buffered messages.
   * - **Path B (idle)**: reset the L1 idle timer. When the timer fires (user
   *   stops chatting), L1 runs with whatever has been buffered.
   * 中文：通知管道一个会话轮次的对话已结束，并缓冲捕获的消息以供L1批量处理。
   * 两条触发路径从这里开始:
   * - **路径A（阈值）**: 如果对话次数 >= 有效阈值（暖启动或稳定状态），立即使用所有缓冲消息触发L1。
   * - **路径B（空闲）**: 重置L1空闲计时器。当计时器触发（用户停止聊天）时，L1运行并使用已缓冲的内容。
   */
  async notifyConversation(sessionKey: string, messages: CapturedMessage[]): Promise<void> {
    if (this.destroyed) return;
    if (this.sessionFilter.shouldSkip(sessionKey)) return;

    const state = this.getOrCreateState(sessionKey);
    state.conversation_count += 1;
    state.last_active_time = Date.now();

    // Reset L1 retry count on new conversation (environment may have recovered)
    // 中文：在新会话上重置L1重试次数（环境可能已经恢复）
    const timers = this.getOrCreateTimers(sessionKey);
    timers.l1RetryCount = 0;

    // Buffer messages for L1
    // 中文：为L1缓冲消息
    const buffer = this.messageBuffers.get(sessionKey) ?? [];
    buffer.push(...messages);
    this.messageBuffers.set(sessionKey, buffer);

    const effectiveThreshold = this.getEffectiveThreshold(state);
    const warmupInfo = this.enableWarmup && state.warmup_threshold > 0
      ? ` (warmup: ${state.warmup_threshold})`
      : "";

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] notify: conversation_count=${state.conversation_count}/${effectiveThreshold}${warmupInfo}, ` +
      `buffered_messages=${buffer.length} (+${messages.length} new)`,
    );

    await this.persistStates();

    // Path A: conversation count reached effective threshold → trigger L1 batch
    // 中文：路径A: 对话次数达到有效阈值 → 触发L1批量处理
    if (state.conversation_count >= effectiveThreshold) {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] Conversation threshold reached (${state.conversation_count}>=${effectiveThreshold}${warmupInfo}), triggering L1`,
      );
      this.enqueueL1(sessionKey);
      return; // skip idle timer reset — L1 is already triggered
      // 中文：跳过空闲计时器重置——L1已触发
    }

    // Path B: below threshold → reset L1 idle timer (catch residual later)
    // 中文：路径B: 低于阈值 → 重置L1空闲计时器（稍后捕获残留内容）
    timers.l1Idle.schedule(this.l1IdleTimeoutMs, () => this.onL1IdleTimeout(sessionKey));
    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L1 idle timer reset (${this.l1IdleTimeoutMs / 1000}s)`,
    );

    // Periodic GC: evict cold sessions from memory
    // 中文：周期性垃圾回收：从内存中移除冷会话
    this.notifyCounter += 1;
    if (this.notifyCounter >= this.SESSION_GC_EVERY_N_NOTIFICATIONS) {
      this.notifyCounter = 0;
      this.gcStaleSessions();
    }
  }

  // ============================
  // Graceful shutdown
  // ============================
  // 中文：平滑关闭

  /**
   * Per-session flush — scoped end-of-session handling.
   *
   * Semantically different from {@link destroy}:
   *   - ``destroy`` tears down the *whole* scheduler (meant for process
   *     shutdown such as OpenClaw's ``gateway_stop``).
   *   - ``flushSession`` only processes the one session identified by
   *     ``sessionKey`` and leaves every other session's timers, buffers
   *     and pipeline state untouched.  This is the correct semantic for
   *     the Gateway's ``POST /session/end`` endpoint and for Hermes'
   *     ``on_session_end`` callback, which fire when one conversation
   *     ends while the process keeps serving other concurrent sessions.
   *
   * What it does:
   *   1. Cancel the session's pending L1 idle timer (no further idle
   *      fires for this key).
   *   2. If the session's message buffer still holds work, enqueue an
   *      immediate L1 run for this session (``triggerReason="flush"``).
   *   3. Await the shared ``l1Queue`` so the caller observes L1
   *      completion before returning.  We do not selectively wait
   *      because L1 is already a single-consumer SerialQueue — waiting
   *      for ``onIdle`` is the cheapest correct signal.
   *
   * What it deliberately does NOT do:
   *   - Touch other sessions' timers / buffers / pipeline state.
   *   - Destroy the scheduler or any of its queues.
   *   - Reset global fields such as ``destroyed``.
   *
   * Unknown session keys are a no-op: the scheduler may legitimately
   * have evicted the session earlier via GC, or the session may never
   * have produced any captures.
   * 中文：按会话刷新——针对会话结束的局部处理。
   * 与 {@link destroy} 的语义不同：
   * - ``destroy`` 会销毁整个调度器（用于进程关闭，如 OpenClaw 的 ``gateway_stop``）。
   * - ``flushSession`` 只处理由 ``sessionKey`` 标识的那个会话，并且不会影响其他会话的计时器、缓冲区和管道状态。这是 Gateway 的 ``POST /session/end`` 接口以及 Hermes 的 ``on_session_end`` 回调（在一次对话结束而进程继续服务其他并发会话时触发）所需语义。
   * 它做了什么：
   * 1. 取消会话的待处理 L1 空闲计时器（不会再为此键触发空闲事件）。
   * 2. 如果会话的消息缓冲区仍有工作，立即为该会话触发一次 L1 运行（``triggerReason="flush"``）。
   * 3. 等待共享的 ``l1Queue`` 以确保调用者在返回前观察到 L1 完成。我们不选择性等待是因为 L1 已经是一个单消费者 SerialQueue —— 等待 ``onIdle`` 是最便宜且正确的信号。
   * 它刻意不做以下操作：
   * - 不触及其他会话的计时器 / 缓冲区 / 管道状态。
   * - 不销毁调度器或其任何队列。
   * - 不重置全局字段如 ``destroyed``。
   * 未知的会话键不会产生影响：调度器可能合法地通过垃圾回收提前移除了该会话，或者该会话从未生成过任何捕获。
   */
  async flushSession(sessionKey: string): Promise<void> {
    if (this.destroyed) return;
    if (this.sessionFilter.shouldSkip(sessionKey)) return;

    const timers = this.sessionTimers.get(sessionKey);
    const buffer = this.messageBuffers.get(sessionKey);

    // Step 1: cancel the idle timer so it won't fire after we return.
    // 中文：步骤1：取消空闲计时器以防止在返回后触发。
    if (timers?.l1Idle.pending) {
      timers.l1Idle.cancel();
    }

    // Step 2: flush pending buffered messages through L1 if any.
    // 中文：步骤2：如果有待处理的消息缓冲区，则通过 L1 进行刷新。
    if (buffer && buffer.length > 0) {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] flushSession: enqueuing L1 for ${buffer.length} buffered message(s)`,
      );
      this.enqueueL1(sessionKey, "flush");
    }

    // Step 3: wait for L1 to drain.  L1 is a single-consumer SerialQueue
    // so this is the cheapest correct signal; it will not starve other
    // sessions because any cross-session interleaving L1 work was either
    // already queued or will be queued concurrently by their own capture
    // paths.
    // 中文：步骤3：等待 L1 排空。L1 是一个单消费者 SerialQueue，因此这是最便宜且正确的信号；它不会使其他会话饥饿，因为跨会话的交错 L1 工作要么已经排队，要么将由它们自己的捕获路径并发地进行排队。
    await this.l1Queue.onIdle();

    this.logger?.debug?.(`${TAG} [${sessionKey}] flushSession: complete`);
  }

  /**
   * Maximum time (ms) to wait for pipeline flush during destroy.
   * Must be shorter than the gateway_stop hook timeout (3 s) to leave
   * headroom for VectorStore / EmbeddingService cleanup that runs after.
   * 中文：销毁期间管道刷新的最大等待时间（ms）。
   * 必须短于 ``gateway_stop`` 挂钩超时时间（3秒），以便为 VectorStore / EmbeddingService 清理操作留出空间，在其运行后执行。
   */
  private readonly DESTROY_TIMEOUT_MS = 2_000;

  /**
   * Graceful shutdown with timeout protection:
   * 1. Mark destroyed, stop accepting new work
   * 2. Attempt to flush pending L1/L2/L3 work within DESTROY_TIMEOUT_MS
   * 3. If flush times out or fails, persist current state for recovery on next startup
   * 4. Pending work is never lost — it will be recovered via checkpoint on next start()
   * 中文：具有超时保护的平滑关闭：
   * 1. 标记为已销毁，停止接受新工作
   * 2. 尝试在 DESTROY_TIMEOUT_MS 内刷新待处理的 L1/L2/L3 工作
   * 3. 如果刷新超时或失败，则保存当前状态以便下次启动时恢复
   * 4. 任何未完成的工作都不会丢失 —— 它们将在下次启动时通过检查点进行恢复
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.logger?.info(
      `${TAG} Destroying pipeline (timeout=${this.DESTROY_TIMEOUT_MS}ms)...`,
    );

    try {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this._doFlush(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("destroy timeout")), this.DESTROY_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });
      this.logger?.info(`${TAG} Pipeline flushed successfully`);
    } catch (err) {
      this.logger?.warn(
        `${TAG} Pipeline flush timed out or failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Pending work will be recovered on next startup.`,
      );
    }

    // Always persist state — whether flush succeeded, timed out, or failed.
    // This ensures pending work (buffered messages, L2 pending counts) is
    // saved to checkpoint and can be recovered by recoverPendingSessions().
    // 中文：始终持久化状态——无论刷新成功、超时还是失败。
    // 这确保了待处理的工作（缓冲消息、L2待处理计数）被保存到检查点，并可以在recoverPendingSessions()中恢复。
    try {
      await this.persistStates();
    } catch (err) {
      this.logger?.error(
        `${TAG} Failed to persist states during destroy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger?.info(`${TAG} Pipeline destroyed`);
  }

  /**
   * Internal: attempt to flush all pending pipeline work (L1 → L2 → L3).
   * Extracted from destroy() so it can be wrapped with a timeout.
   * 中文：内部：尝试刷新所有待处理的管道工作（L1 → L2 → L3）。
   * 从destroy()中提取，以便可以使用超时包装器。
   */
  private async _doFlush(): Promise<void> {
    // Step 1: Flush all L1 idle timers — only enqueue if there are buffered messages
    // 中文：步骤1：刷新所有L1空闲定时器——仅在存在缓冲消息时入队
    for (const [sessionKey, timers] of this.sessionTimers) {
      if (timers.l1Idle.pending) {
        timers.l1Idle.cancel(); // don't fire the idle callback directly
        // 中文：不要直接触发空闲回调
        const buffer = this.messageBuffers.get(sessionKey);
        if (buffer && buffer.length > 0) {
          this.logger?.debug?.(`${TAG} [${sessionKey}] Flush: enqueuing L1 for ${buffer.length} buffered messages`);
          this.enqueueL1(sessionKey, "flush");
        }
      }
    }

    // Step 2: Wait for L1 queue to drain
    // 中文：步骤2：等待L1队列排空
    this.logger?.debug?.(`${TAG} Waiting for L1 queue to drain (size=${this.l1Queue.size})`);
    await this.l1Queue.onIdle();

    // Step 3: Flush all L2 schedule timers
    // 中文：步骤3：刷新所有L2调度定时器
    for (const [sessionKey, timers] of this.sessionTimers) {
      if (timers.l2Schedule.pending) {
        this.logger?.debug?.(`${TAG} [${sessionKey}] Flush: triggering L2 schedule timer`);
        timers.l2Schedule.flush();
      }
    }

    // Step 4: Wait for all remaining queues to drain
    // 中文：步骤4：等待所有剩余队列排空
    this.logger?.debug?.(`${TAG} Waiting for queues to drain (l2=${this.l2Queue.size}, l3=${this.l3Queue.size})`);
    await Promise.all([
      this.l2Queue.onIdle(),
      this.l3Queue.onIdle(),
    ]);
  }

  // ============================
  // Internal: L1 idle timeout handler
  // ============================
  // 中文：内部：L1空闲超时处理程序

  private onL1IdleTimeout(sessionKey: string): void {
    const buffer = this.messageBuffers.get(sessionKey);
    const state = this.sessionStates.get(sessionKey);

    if ((!buffer || buffer.length === 0) && (!state || state.conversation_count === 0)) {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L1 idle timeout but no pending messages or conversations`,
      );
      return;
    }

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L1 idle timeout fired (buffered=${buffer?.length ?? 0}, conversations=${state?.conversation_count ?? 0})`,
    );
    this.enqueueL1(sessionKey, "idle_timeout");
  }

  // ============================
  // Internal: L1 queue
  // ============================
  // 中文：内部：L1队列

  private enqueueL1(sessionKey: string, triggerReason: "threshold" | "idle_timeout" | "flush" = "threshold"): void {
    const timers = this.getOrCreateTimers(sessionKey);

    // Don't double-queue
    // 中文：不要双队列
    if (timers.l1Queued) {
      this.logger?.debug?.(`${TAG} [${sessionKey}] L1 already queued, skipping`);
      return;
    }

    // Cancel idle timer if running (threshold beat it)
    // 中文：如果运行中且超时（阈值打破它），取消空闲计时器
    timers.l1Idle.cancel();

    timers.l1Queued = true;
    this.logger?.debug?.(`${TAG} [${sessionKey}] Enqueuing L1 (queue=${this.l1Queue.name})`);

    // ── pipeline_l1_trigger metric ──
    // 中文：── pipeline_l1_trigger 指标 ──
    const state = this.sessionStates.get(sessionKey);
    const buffer = this.messageBuffers.get(sessionKey);
    if (this.instanceId && this.logger) {
      report("pipeline_l1_trigger", {
        sessionKey,
        triggerReason,
        conversationCount: state?.conversation_count ?? 0,
        bufferedMessageCount: buffer?.length ?? 0,
      });
    }

    this.l1Queue.add(async () => {
      await this.runL1(sessionKey);
    }).catch((err) => {
      this.logger?.error(
        `${TAG} [${sessionKey}] L1 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    }).finally(() => {
      timers.l1Queued = false;
    });
  }

  /**
   * L1 runner: Takes all buffered messages for a session and passes them
   * to the L1Runner for batch processing (e.g. appendEvent, local extraction).
   *
   * After L1 completes successfully:
   * - conversation_count and message buffer are reset
   * - L2 timer is advanced (downward-only) to allow remote record generation
   *
   * If L1 fails, conversation_count and buffer are preserved for retry
   * on next idle timeout or threshold trigger.
   * 中文：L1 运行器：为会话获取所有缓冲消息并传递给 L1Runner 以批量处理（例如，appendEvent、本地提取）。在 L1 成功完成后：- 重置 conversation_count 和消息缓冲区 - 向下推进 L2 计时器以允许远程记录生成如果 L1 失败，则保留 conversation_count 和缓冲区以便下次空闲超时或阈值触发时重试
   */
  private async runL1(sessionKey: string): Promise<void> {
    const state = this.sessionStates.get(sessionKey);
    if (!state) return;

    // Drain the message buffer (take ownership, clear the shared ref)
    // 中文：清空消息缓冲区（接管所有权，清除共享引用）
    const buffer = this.messageBuffers.get(sessionKey) ?? [];
    this.messageBuffers.set(sessionKey, []);

    if (buffer.length === 0 && state.conversation_count === 0) {
      this.logger?.debug?.(`${TAG} [${sessionKey}] L1 skipped: no messages and no pending conversations`);
      return;
    }

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L1 running: messages=${buffer.length}, conversation_count=${state.conversation_count}`,
    );

    if (!this.l1Runner) {
      this.logger?.warn(`${TAG} [${sessionKey}] No L1 runner set, skipping`);
      state.l2_pending_l1_count = state.conversation_count;
      state.conversation_count = 0;
      this.advanceWarmupThreshold(state);
      await this.persistStates();
      this.advanceL2Timer(sessionKey);
      return;
    }

    try {
      await this.l1Runner({
        sessionKey,
        msg: buffer,
        bg_msg: [], // reserved for future use
        // 中文：预留未来使用
      });

      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L1 complete: processed ${buffer.length} messages`,
      );
    } catch (err) {
      this.logger?.error(
        `${TAG} [${sessionKey}] L1 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      // On failure: put messages back into the buffer for retry
      // 中文：失败时：将消息放回缓冲区进行重试
      const currentBuffer = this.messageBuffers.get(sessionKey) ?? [];
      this.messageBuffers.set(sessionKey, [...buffer, ...currentBuffer]);
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L1 failure: restored ${buffer.length} messages to buffer (total=${buffer.length + currentBuffer.length})`,
      );

      // Re-arm L1 idle timer for automatic retry (with max retry limit)
      // 中文：为自动重试重新设置 L1 空闲计时器（带有最大重试限制）
      const timers = this.getOrCreateTimers(sessionKey);
      timers.l1RetryCount += 1;
      if (timers.l1RetryCount <= this.L1_MAX_RETRIES) {
        timers.l1Idle.schedule(this.L1_RETRY_DELAY_MS, () => this.onL1IdleTimeout(sessionKey));
        this.logger?.debug?.(
          `${TAG} [${sessionKey}] L1 retry scheduled in ${this.L1_RETRY_DELAY_MS / 1000}s ` +
          `(attempt ${timers.l1RetryCount}/${this.L1_MAX_RETRIES})`,
        );
      } else {
        this.logger?.warn(
          `${TAG} [${sessionKey}] L1 max retries reached (${this.L1_MAX_RETRIES}), ` +
          `giving up auto-retry. ${buffer.length + currentBuffer.length} messages remain buffered. ` +
          `Will resume on next user conversation.`,
        );
      }

      return; // don't advance state or trigger L2
      // 中文：不要推进状态或触发L2
    }

    // Success: reset retry count and advance state
    // 中文：成功：重置重试次数并推进状态
    const timers = this.getOrCreateTimers(sessionKey);
    timers.l1RetryCount = 0;
    state.l2_pending_l1_count = state.conversation_count;
    state.conversation_count = 0;
    this.advanceWarmupThreshold(state);
    await this.persistStates();

    // Advance the L2 timer (downward-only) to fire after delay, respecting minInterval
    // 中文：先进化L2定时器（仅向下），在延迟后触发，尊重minInterval
    this.advanceL2Timer(sessionKey);
  }

  // ============================
  // Internal: L2 timer management (downward-only)
  // ============================
  // 中文：内部：管理L2定时器（仅向下）

  /**
   * Advance the per-session L2 timer after an L1 event (new memory generated).
   *
   * Computes the desired fire time as:
   *   T_desired = max(now + l2DelayAfterL1, lastL2Time + l2MinInterval)
   *
   * The timer is only moved if T_desired is earlier than the current schedule
   * (downward-only semantics). If no timer is pending, it's set unconditionally.
   * 中文：在L1事件（新内存生成）后为每个会话进阶L2定时器。
   * 计算期望的触发时间为：
   * T_desired = max(now + l2DelayAfterL1, lastL2Time + l2MinInterval)
   * 只有当T_desired比当前调度时间更早时，才会移动定时器（仅向下语义）。如果没有待定的定时器，则会无条件设置。
   */
  private advanceL2Timer(sessionKey: string): void {
    if (this.destroyed) return;

    const timers = this.getOrCreateTimers(sessionKey);
    const now = Date.now();

    // Compute the floor: lastL2 + minInterval (rate-limit protection)
    // 中文：计算地板：lastL2 + minInterval（速率限制保护）
    const lastL2 = this.l2LastRunTime.get(sessionKey) ?? 0;
    const minIntervalFloor = lastL2 > 0 ? lastL2 + this.l2MinIntervalMs : 0;

    // Desired fire time: delay after L1, but no earlier than minInterval floor
    // 中文：期望触发时间：在L1之后延迟，但不早于minInterval地板
    const desiredTime = Math.max(now + this.l2DelayAfterL1Ms, minIntervalFloor);

    const advanced = timers.l2Schedule.tryAdvanceTo(desiredTime, () => this.onL2TimerFired(sessionKey, "delay-after-l1"));

    if (advanced) {
      const delaySec = Math.round((desiredTime - now) / 1000);
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L2 timer advanced: firing in ${delaySec}s` +
        (timers.l2Schedule.scheduledTime > 0
          ? ` (was ${Math.round((timers.l2Schedule.scheduledTime - now) / 1000)}s)`
          : " (newly armed)"),
      );
    } else {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L2 timer not advanced: current schedule is already earlier`,
      );
    }
  }

  /**
   * Arm the L2 timer for the maxInterval guarantee after L2 completes.
   * Sets T = now + l2MaxInterval (unconditional, replaces any pending timer).
   * 中文：为L2完成后的最大间隔保证武装L2定时器。
   * 设置T = now + l2MaxInterval（无条件，替换任何待定的定时器）。
   */
  private armL2MaxInterval(sessionKey: string): void {
    if (this.destroyed) return;

    const timers = this.getOrCreateTimers(sessionKey);
    const fireAt = Date.now() + this.l2MaxIntervalMs;
    timers.l2Schedule.scheduleAt(fireAt, () => this.onL2TimerFired(sessionKey, "max-interval"));

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L2 maxInterval timer armed: ${Math.round(this.l2MaxIntervalMs / 1000)}s`,
    );
  }

  /**
   * Called when a per-session L2 timer fires.
   *
   * Checks session activity: if the session is cold (inactive > activeWindow),
   * the timer is NOT re-armed — it will be revived by the next L1 event.
   * Otherwise, enqueues L2.
   *
   * The `source` parameter distinguishes the trigger origin:
   * - "delay-after-l1": fired shortly after L1 completed — skip cold check
   *   because L1 completion itself proves recent activity.
   * - "max-interval": periodic timer — apply cold check normally.
   * 中文：当每个会话的L2定时器触发时调用。
   * 检查会话活动：如果会话是冷态（不活跃 > 活动窗口），
   * 则不会重新武装定时器——它将在下一个L1事件中恢复。
   * 否则，入列L2。
   * `source`参数区分触发源：
   * - "delay-after-l1"：在L1完成后不久触发——跳过冷态检查
   * 因为L1完成本身证明了最近的活动。
   * - "max-interval"：周期性定时器——正常应用冷态检查。
   */
  private onL2TimerFired(sessionKey: string, source: "delay-after-l1" | "max-interval"): void {
    const state = this.sessionStates.get(sessionKey);
    if (!state) return;

    const now = Date.now();

    // Cold session check: only applies to periodic (maxInterval) triggers.
    // Delay-after-L1 triggers are exempt because L1 just completed, proving
    // the session was recently active.
    // 中文：冷会话检查：仅适用于周期性（最大间隔）触发。
    // 延迟后-L1触发豁免，因为L1刚刚完成，证明
    // 该会话最近是活跃的。
    if (source === "max-interval" && now - state.last_active_time >= this.sessionActiveWindowMs) {
      this.logger?.debug?.(
        `${TAG} [${sessionKey}] L2 timer fired but session is cold ` +
        `(inactive ${Math.round((now - state.last_active_time) / 3600_000)}h), timer stopped. ` +
        `Will re-arm on next L1 event.`,
      );
      return; // timer not re-armed — advanceL2Timer() in runL1 will revive it
      // 中文：计时器未重新武装——runL1中的advanceL2Timer()将会使其复活
    }

    this.enqueueL2(sessionKey, `timer:${source}`);
  }

  // ============================
  // Internal: L2 queue
  // ============================
  // 中文：内部: L2队列

  private enqueueL2(sessionKey: string, trigger: string): void {
    const timers = this.getOrCreateTimers(sessionKey);

    // Cancel any pending L2 timer (we're about to run L2)
    // 中文：取消任何待处理的L2定时器（我们即将运行L2）
    timers.l2Schedule.cancel();

    // Conflict detection: warn if L2 is already queued
    // 中文：冲突检测: 如果L2已排队则发出警告
    if (timers.l2Queued) {
      this.logger?.warn(
        `${TAG} [${sessionKey}] L2 enqueue conflict on queue "${this.l2Queue.name}": ` +
        `task already queued/running (trigger=${trigger}), skipping`,
      );
      return;
    }

    timers.l2Queued = true;
    this.logger?.debug?.(`${TAG} [${sessionKey}] Enqueuing L2 (trigger=${trigger}, queue=${this.l2Queue.name})`);

    this.l2Queue.add(async () => {
      await this.runL2(sessionKey);
    }).catch((err) => {
      this.logger?.error(
        `${TAG} [${sessionKey}] L2 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    }).finally(() => {
      timers.l2Queued = false;
    });
  }

  private async runL2(sessionKey: string): Promise<void> {
    const state = this.sessionStates.get(sessionKey);
    if (!state) return;

    if (!this.l2Runner) {
      this.logger?.warn(`${TAG} [${sessionKey}] No L2 runner set, skipping`);
      return;
    }

    this.logger?.debug?.(
      `${TAG} [${sessionKey}] L2 running: l2_pending_l1_count=${state.l2_pending_l1_count}`,
    );

    const cursor = state.last_extraction_updated_time || undefined;

    let result: L2RunnerResult | void;
    try {
      result = await this.l2Runner(sessionKey, cursor);
    } catch (err) {
      this.logger?.error(
        `${TAG} [${sessionKey}] L2 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      // Even on failure, arm maxInterval so we retry eventually
      // 中文：即使失败也设置maxInterval以便最终重试
      this.armL2MaxInterval(sessionKey);
      return;
    }

    // After L2: update state
    // 中文：L2之后更新状态
    const now = Date.now();
    state.l2_pending_l1_count = 0;

    // Cold-start optimization: if this is the very first L2 run for this session
    // and it was skipped (no new records), do NOT update l2LastRunTime.
    // This prevents l2MinIntervalSeconds from blocking the next L2 trigger
    // when the first L1 extraction produces actual memories shortly after.
    // 中文：冷启动优化：如果这是会话中的首次L2运行且被跳过（没有新记录），则不要更新l2LastRunTime。这防止l2MinIntervalSeconds阻止下一次L2触发，当第一次L1提取在短时间内生成实际记忆时。
    const isFirstL2 = !this.l2LastRunTime.has(sessionKey);
    const wasSkipped = result?.skipped === true;

    if (isFirstL2 && wasSkipped) {
      this.logger?.info?.(
        `${TAG} [${sessionKey}] L2 cold-start skip: not updating l2LastRunTime ` +
        `(minInterval won't block next trigger)`,
      );
      this.armL2MaxInterval(sessionKey);
      await this.persistStates();
      return;
    }

    state.last_extraction_time = new Date().toISOString();
    state.l2_last_extraction_time = new Date().toISOString();
    this.l2LastRunTime.set(sessionKey, now);

    // Advance cursor using the record timestamp returned by the runner
    // 中文：使用runner返回的记录时间戳推进游标
    if (result?.latestCursor) {
      state.last_extraction_updated_time = result.latestCursor;
    } else if (!state.last_extraction_updated_time) {
      // Cold-start guard: if runner returned void (e.g. extraction failure) and
      // last_extraction_updated_time is still empty, initialize it to now so
      // the next L2 run doesn't do a full table scan.
      // 中文：冷启动防护：如果runner返回空值（例如提取失败）且last_extraction_updated_time仍为空，则将其初始化为当前时间，以便下次L2运行时不进行全表扫描。
      state.last_extraction_updated_time = new Date().toISOString();
    }

    await this.persistStates();

    this.logger?.debug?.(`${TAG} [${sessionKey}] L2 complete`);

    // Arm the maxInterval timer for the next cycle
    // 中文：为下一周期武装最大间隔定时器
    this.armL2MaxInterval(sessionKey);

    // Trigger L3
    // 中文：触发L3
    this.triggerL3();
  }

  // ============================
  // Internal: L3 queue (global, dedup)
  // ============================
  // 中文：内部：L3队列（全局，去重）

  private triggerL3(): void {
    if (this.destroyed) return;

    if (this.l3Running) {
      // L3 is in progress — mark pending so it runs again after current finishes
      // 中文：L3正在进行——标记待处理状态，以便当前任务完成后重新运行
      this.l3Pending = true;
      this.logger?.debug?.(`${TAG} L3 already running, marking pending`);
      return;
    }

    this.logger?.debug?.(`${TAG} Triggering L3`);
    this.enqueueL3();
  }

  private enqueueL3(): void {
    this.l3Running = true;
    this.l3Pending = false;

    this.logger?.debug?.(`${TAG} Enqueuing L3 (queue=${this.l3Queue.name})`);

    this.l3Queue.add(async () => {
      await this.runL3();
    }).catch((err) => {
      this.logger?.error(
        `${TAG} L3 task failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    }).finally(() => {
      this.l3Running = false;

      // If new L2 completions happened while L3 was running, run again
      // 中文：如果L3运行时发生了新的L2完成事件，再次运行
      if (this.l3Pending && !this.destroyed) {
        this.logger?.debug?.(`${TAG} L3 has pending work, re-running`);
        this.enqueueL3();
      }
    });
  }

  private async runL3(): Promise<void> {
    if (!this.l3Runner) {
      this.logger?.warn(`${TAG} No L3 runner set, skipping`);
      return;
    }

    this.logger?.debug?.(`${TAG} L3 running`);
    try {
      await this.l3Runner();
      this.logger?.debug?.(`${TAG} L3 complete`);
    } catch (err) {
      this.logger?.error(
        `${TAG} L3 runner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    }
  }

  // ============================
  // Internal: state management
  // ============================
  // 中文：内部：状态管理

  private getOrCreateState(sessionKey: string): PipelineSessionState {
    let state = this.sessionStates.get(sessionKey);
    if (!state) {
      state = {
        conversation_count: 0,
        last_extraction_time: "",
        last_extraction_updated_time: "",
        last_active_time: Date.now(),
        l2_pending_l1_count: 0,
        warmup_threshold: this.enableWarmup ? 1 : 0,
        l2_last_extraction_time: "",
      };
      this.sessionStates.set(sessionKey, state);
      this.logger?.debug?.(`${TAG} [${sessionKey}] Created new session state`);
    }
    return state;
  }

  private getOrCreateTimers(sessionKey: string): SessionTimerState {
    let timers = this.sessionTimers.get(sessionKey);
    if (!timers) {
      const isDestroyed = () => this.destroyed;
      timers = {
        l1Idle: new ManagedTimer(`L1-idle:${sessionKey}`, isDestroyed),
        l2Schedule: new ManagedTimer(`L2-schedule:${sessionKey}`, isDestroyed),
        l1Queued: false,
        l2Queued: false,
        l1RetryCount: 0,
      };
      this.sessionTimers.set(sessionKey, timers);
    }
    return timers;
  }

  private async persistStates(): Promise<void> {
    if (!this.persister) return;

    // PipelineSessionState only contains pipeline-owned fields, so we can
    // safely persist the entire object without risk of overwriting runner state.
    // 中文：PipelineSessionState仅包含管道拥有的字段，因此我们可以安全地持久化整个对象而不必担心覆盖运行器状态。
    const obj: Record<string, PipelineSessionState> = {};
    for (const [k, v] of this.sessionStates) {
      obj[k] = { ...v };
    }
    try {
      this.logger?.debug?.(`Persisting states: ${JSON.stringify(obj)}`);
      await this.persister(obj);
    } catch (err) {
      this.logger?.error(
        `${TAG} Failed to persist states: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Evict cold sessions from in-memory maps to prevent unbounded growth.
   *
   * A session is eligible for GC when:
   * 1. Inactive for > sessionActiveWindowMs * SESSION_GC_INACTIVE_MULTIPLIER
   * 2. No queued/running L1 or L2 tasks
   * 3. No buffered messages pending processing
   *
   * Evicted sessions can be fully restored from checkpoint on next
   * `notifyConversation()` (state) or `start()` (recovery).
   * 中文：从内存映射中驱逐冷会话以防止无界增长。一个会话在以下条件时可被垃圾回收：1. 超过 sessionActiveWindowMs * SESSION_GC_INACTIVE_MULTIPLIER 未活动2. 没有排队或正在运行的L1或L2任务3. 没有待处理的消息Evicted会话可以在下次 `notifyConversation()`（状态）或 `start()`（恢复）时从检查点完全恢复。
   */
  private gcStaleSessions(): void {
    const now = Date.now();
    const maxInactiveMs = this.sessionActiveWindowMs * this.SESSION_GC_INACTIVE_MULTIPLIER;
    let evictedCount = 0;

    for (const [sessionKey, state] of this.sessionStates) {
      if (now - state.last_active_time < maxInactiveMs) continue;

      // Safety: don't evict sessions with active work
      // 中文：安全：不要驱逐有活跃工作的会话
      const timers = this.sessionTimers.get(sessionKey);
      if (timers?.l1Queued || timers?.l2Queued) continue;

      const buffer = this.messageBuffers.get(sessionKey);
      if (buffer && buffer.length > 0) continue;

      // Evict: cancel any pending timers, then remove from all maps
      // 中文：驱逐：取消任何待处理的定时器，然后从所有映射中移除
      if (timers) {
        timers.l1Idle.cancel();
        timers.l2Schedule.cancel();
      }
      this.sessionStates.delete(sessionKey);
      this.sessionTimers.delete(sessionKey);
      this.messageBuffers.delete(sessionKey);
      this.l2LastRunTime.delete(sessionKey);
      evictedCount++;
    }

    if (evictedCount > 0) {
      this.logger?.debug?.(
        `${TAG} Session GC: evicted ${evictedCount} cold session(s), ` +
        `${this.sessionStates.size} remaining`,
      );
    }
  }

  /**
   * Recovery: re-enqueue sessions that have pending work from before restart.
   *
   * On restart, message buffers are empty (in-memory only). Sessions with
   * non-zero conversation_count had messages that were either:
   * 1. Already processed by L1 (l2_pending_l1_count > 0) → arm L2 timer
   * 2. Never reached L1 (conversation_count > 0, messages lost) → arm L2
   *    as best-effort recovery
   *
   * We arm L2 timers (with delay) rather than enqueuing immediately,
   * because the pipeline may be starting during management commands.
   * 中文：恢复：重新入队在重启前有待处理工作的会话。重启时，消息缓冲区为空（仅内存）。具有非零对话计数的会话的消息要么：1. 已由L1处理（l2_pending_l1_count > 0）→ 设置L2定时器2. 从未到达L1（conversation_count > 0，消息丢失）→ 尽力恢复设置L2定时器因为管道可能在管理命令期间启动
   */
  private recoverPendingSessions(): void {
    for (const [sessionKey, state] of this.sessionStates) {
      if (state.conversation_count === 0 && state.l2_pending_l1_count === 0) continue;

      this.logger?.debug?.(
        `${TAG} [${sessionKey}] Recovery: conversation_count=${state.conversation_count}, ` +
        `l2_pending_l1_count=${state.l2_pending_l1_count}, arming L2 timer`,
      );

      // Reset conversation_count since we can't recover the messages
      // 中文：重置对话计数因为我们无法恢复这些消息
      state.l2_pending_l1_count = Math.max(state.l2_pending_l1_count, state.conversation_count);
      state.conversation_count = 0;

      // Arm L2 timer with delay (gives the system time to fully start)
      // 中文：为尽力恢复设置带有延迟的L2定时器
      this.advanceL2Timer(sessionKey);
    }
  }

  // ============================
  // Public accessors (for testing / status)
  // ============================
  // 中文：公共访问器（用于测试/状态）

  /** Get the pipeline session state for a session (read-only copy). */
  /** 中文：获取会话的管道会话状态（只读副本） */
  getSessionState(sessionKey: string): PipelineSessionState | undefined {
    const state = this.sessionStates.get(sessionKey);
    return state ? { ...state } : undefined;
  }

  /** Get the buffered message count for a session. */
  /** 中文：获取会话的消息缓冲区计数 */
  getBufferedMessageCount(sessionKey: string): number {
    return this.messageBuffers.get(sessionKey)?.length ?? 0;
  }

  /** Get all session keys being tracked. */
  /** 中文：获取所有正在跟踪的会话键. */
  getSessionKeys(): string[] {
    return Array.from(this.sessionStates.keys());
  }

  /** Whether the pipeline has been destroyed. */
  /** 中文：管道是否已被销毁. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Queue sizes and running state for monitoring. */
  /** 中文：监控用的队列大小和运行状态. */
  getQueueSizes(): {
    l1: number; l2: number; l3: number;
    l1Pending: boolean; l2Pending: boolean; l3Pending: boolean;
    l1Idle: boolean; l2Idle: boolean; l3Idle: boolean;
  } {
    return {
      l1: this.l1Queue.size,
      l2: this.l2Queue.size,
      l3: this.l3Queue.size,
      l1Pending: this.l1Queue.pending,
      l2Pending: this.l2Queue.pending,
      l3Pending: this.l3Queue.pending,
      l1Idle: this.l1Queue.idle,
      l2Idle: this.l2Queue.idle,
      l3Idle: this.l3Queue.idle,
    };
  }
}
