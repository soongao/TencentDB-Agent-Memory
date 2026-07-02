/**
 * Checkpoint management for tracking memory processing progress.
 *
 * ## Split-state design
 *
 * Per-session state is split into two independent namespaces to prevent
 * the PipelineManager and L0/L1 runners from overwriting each other's fields:
 *
 * - **runner_states** (`RunnerSessionState`): owned by CheckpointManager methods
 *   (markL1*, advanceSession*). Contains L0 capture cursor, L1 cursor, scene name.
 *
 * - **pipeline_states** (`PipelineSessionState`): owned exclusively by
 *   PipelineManager via `mergePipelineStates()`. Contains conversation_count,
 *   extraction times, L2 tracking fields.
 *
 * Each side only reads/writes its own namespace, eliminating the split-brain
 * overwrite bug where pipeline persistStates() could clobber runner-written fields.
 *
 * ## Concurrency safety
 *
 * All mutating methods (read-modify-write) are serialized via a per-file async lock.
 * Multiple CheckpointManager instances sharing the same file path automatically share
 * the same lock, so callers can freely `new CheckpointManager()` without coordination.
 * Writes use atomic tmp+rename to prevent corruption on crash.
 * 中文：跟踪内存处理进度的检查点管理。
 * ## 分布式状态设计
 * 每个会话的状态被分成两个独立命名空间，以防止PipelineManager和L0/L1运行器互相覆盖对方字段：
 * - **runner_states** (`RunnerSessionState`): 由CheckpointManager方法（markL1*、advanceSession*等）拥有。包含L0捕获光标、L1光标、场景名称。
 * - **pipeline_states** (`PipelineSessionState`): 仅由PipelineManager通过`mergePipelineStates()`独占拥有。包含对话计数、提取时间、L2跟踪字段。
 * 每一边只读写自己的命名空间，消除了管道persistStates()可能覆盖运行器写的字段的分裂脑覆盖错误。
 * ## 并发安全性
 * 所有修改方法（读-修改-写）都通过一个针对每个文件的异步锁进行序列化。
 * 多个共享同一文件路径的CheckpointManager实例自动共享同一个锁，因此调用者可以自由地`new CheckpointManager()`而无需协调。
 * 写入使用原子tmp+rename防止崩溃时出错。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

// ============================
// Types
// ============================

/**
 * Per-session state managed by L0/L1 runners (written directly to checkpoint).
 * These fields are ONLY written by CheckpointManager methods (markL1*, advanceSession*, etc.)
 * and are NEVER touched by the PipelineManager's persistStates().
 * 中文：由L0/L1运行器直接管理的每个会话状态（直接写入检查点）。
 * 这些字段仅由CheckpointManager方法（markL1*、advanceSession*等）写出，从不被PipelineManager的persistStates()触及。
 */
export interface RunnerSessionState {
  // ═══ L0 — per-session capture cursor ═══
  // 中文：═══ L0 — 每个会话捕获光标 ═══
  /** Epoch ms of the newest message captured for THIS session.
   *  Used instead of the global `Checkpoint.last_captured_timestamp` so that
   * 中文：此次会话最新消息被捕获的时间戳毫秒数。
   * 用于替代全局`Checkpoint.last_captured_timestamp`，防止并发会话互相推进对方的光标并导致漏掉消息。
   *  concurrent sessions don't advance each other's cursors and cause missed messages. */
  last_captured_timestamp: number;

  // ═══ L1 — cursor & continuity ═══
  // 中文：═══ L1 — 光标与连续性 ═══
  /** L0 JSONL cursor: epoch ms of last message processed by L1 */
  /** 中文：L0 JSONL光标：L1处理的最后一条消息的时间戳毫秒数 */
  last_l1_cursor: number;
  /** Last scene name from the most recent L1 extraction (for cross-batch continuity) */
  /** 中文：最近一次L1提取的最后一个场景名称（用于跨批次连续性） */
  last_scene_name: string;
}

/**
 * Per-session state managed exclusively by PipelineManager (written via mergePipelineStates).
 * These fields are ONLY written by the pipeline's persistStates() callback
 * and are NEVER touched by CheckpointManager's L0/L1 methods.
 * 中文：由PipelineManager独占管理的每个会话状态（通过mergePipelineStates写入）。
 * 这些字段仅由管道的persistStates()回调写出，从不被CheckpointManager的L0/L1方法触及。
 */
export interface PipelineSessionState {
  /** Conversation rounds since last L1 trigger */
  /** 中文：自上次L1触发以来的对话轮数 */
  conversation_count: number;
  /** ISO timestamp of the last extraction completion */
  /** 中文：上次提取完成的ISO时间戳 */
  last_extraction_time: string;
  /** ISO timestamp cursor for incremental extraction reads */
  /** 中文：增量提取读取的时间戳游标 */
  last_extraction_updated_time: string;
  /** Epoch ms of the last notifyConversation call */
  /** 中文：上次notifyConversation调用的Epoch ms */
  last_active_time: number;
  /** Mirrors conversation_count at L1 completion time (for L2 tracking) */
  /** 中文：在L1完成时镜像conversation_count（用于L2跟踪） */
  l2_pending_l1_count: number;
  /**
   * Current warm-up threshold for L1 triggering.
   * Starts at 1 for new sessions and doubles after each L1 completion
   * (1 → 2 → 4 → 8 → ...) until it reaches everyNConversations.
   * 0 means warm-up is complete (use everyNConversations directly).
   * 中文：当前L1触发的预热阈值。
   * 新会话开始为1，并在每次L1完成后翻倍
   * (1 → 2 → 4 → 8 → ...)，直到达到everyNConversations。
   * 0表示预热完成（直接使用everyNConversations）。
   */
  warmup_threshold: number;
  /** ISO timestamp of last L2 extraction completion */
  /** 中文：上次L2提取完成的ISO时间戳 */
  l2_last_extraction_time: string;
}

export interface Checkpoint {
  // ═══ Global counters ═══
  // 中文：═══ 全局计数器 ═══
  /** Epoch ms of the newest message successfully uploaded. Messages with ts > this are new. */
  /** 中文：最新成功上传的消息的周期毫秒数。ts大于这个值的消息是新的. */
  last_captured_timestamp: number;
  /** Total messages processed across all time */
  /** 中文：总共处理过的消息数量 */
  total_processed: number;
  last_persona_at: number;
  last_persona_time: string;
  request_persona_update: boolean;
  persona_update_reason: string;
  memories_since_last_persona: number;
  scenes_processed: number;

  // ═══ Per-session split state ═══
  // 中文：═ 每会话分割状态 ═
  /** Runner-managed per-session state (L0 capture cursor, L1 cursor, scene name).
   * 中文：由CheckpointManager方法唯一书写的每会话管理的状态（L0捕获游标，L1游标，场景名称）。
   *  Written ONLY by CheckpointManager methods. */
  runner_states: Record<string, RunnerSessionState>;
  /** Pipeline-managed per-session state (conversation_count, extraction times, etc.).
   * 中文：由管道管理的每会话状态（对话计数，提取次数等）。仅由pipeline的mergePipelineStates()编写。
   *  Written ONLY by the pipeline's mergePipelineStates(). */
  pipeline_states: Record<string, PipelineSessionState>;

  // ═══ L0 ═══
  /** Total L0 conversation files recorded */
  /** 中文：记录的总L0对话文件数量 */
  l0_conversations_count: number;

  // ═══ L1 ═══
  /** Total L1 memories extracted across all time */
  /** 中文：总共提取过的L1记忆数量 */
  total_memories_extracted: number;
}

const DEFAULT_RUNNER_STATE: RunnerSessionState = {
  last_captured_timestamp: 0,
  last_l1_cursor: 0,
  last_scene_name: "",
};

const DEFAULT_PIPELINE_STATE: PipelineSessionState = {
  conversation_count: 0,
  last_extraction_time: "",
  last_extraction_updated_time: "",
  last_active_time: 0,
  l2_pending_l1_count: 0,
  warmup_threshold: 0, // 0 = graduated (safe default for old sessions missing this field)
  // 中文：0 = 成年（为旧会话缺少此字段的安全默认值）
  l2_last_extraction_time: "",
};

const DEFAULT_CHECKPOINT: Checkpoint = {
  last_captured_timestamp: 0,
  total_processed: 0,
  last_persona_at: 0,
  last_persona_time: "",
  request_persona_update: false,
  persona_update_reason: "",
  memories_since_last_persona: 0,
  scenes_processed: 0,
  runner_states: {},
  pipeline_states: {},
  l0_conversations_count: 0,
  total_memories_extracted: 0,
};

export interface CheckpointLogger {
  info(msg: string): void;
  warn?(msg: string): void;
}

const noopLogger: CheckpointLogger = { info() {} };

// ============================
// Per-file async lock
// ============================
// Keyed by resolved file path. Multiple CheckpointManager instances pointing
// to the same file automatically share the same lock — callers don't need to
// coordinate instance creation.
// 中文：每个文件的异步锁
// 通过解析后的文件路径键入。多个指向同一文件的CheckpointManager实例自动共享相同的锁——调用者无需协调实例创建。

const fileLocks = new Map<string, Promise<void>>();

/**
 * Serialize async critical sections per file path.
 * Under no contention the overhead is a single resolved-promise await.
 * 中文：按文件路径逐个序列化异步临界区。
 * // 在无竞争的情况下，开销仅为一个解析的Promise等待。
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // Chain after whatever is currently queued for this path
  // 中文：链接到当前为该路径排队的所有任务之后
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fileLocks.set(filePath, gate);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Clean up the map entry if we're the tail of the chain
    // 中文：如果我们是链表的尾部，则清理映射条目
    if (fileLocks.get(filePath) === gate) {
      fileLocks.delete(filePath);
    }
  }
}

export class CheckpointManager {
  private filePath: string;
  private logger: CheckpointLogger;

  constructor(dataDir: string, logger?: CheckpointLogger) {
    this.filePath = path.join(dataDir, ".metadata", "recall_checkpoint.json");
    this.logger = logger ?? noopLogger;
  }

  // ============================
  // Low-level I/O (internal)
  // ============================
  // 中文：低级I/O（内部）

  private async readRaw(): Promise<Checkpoint> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Merge with defaults for backward compat (old checkpoints lack new fields).
      // structuredClone avoids shallow-copy pitfall: without it, the nested
      // runner_states/pipeline_states objects in DEFAULT_CHECKPOINT would be
      // shared across all callers and mutated in place — corrupting the default.
      // 中文：向后兼容合并默认值（旧检查点缺少新字段）。
      // // structuredClone避免浅拷贝陷阱：否则，DEFAULT_CHECKPOINT中的嵌套
      // runner_states/pipeline_states对象将被所有调用者共享并原地修改——破坏默认值。
      const cp = { ...structuredClone(DEFAULT_CHECKPOINT), ...parsed } as Checkpoint;

      // Migrate from old session_states format (pre-split)
      // 中文：从旧的会话状态格式迁移到新的（未拆分前）
      const oldStates = parsed.session_states as Record<string, Record<string, unknown>> | undefined;
      if (oldStates && !parsed.runner_states && !parsed.pipeline_states) {
        cp.runner_states = {};
        cp.pipeline_states = {};
        for (const [key, state] of Object.entries(oldStates)) {
          cp.runner_states[key] = {
            ...DEFAULT_RUNNER_STATE,
            last_captured_timestamp: (state.last_captured_timestamp as number) ?? 0,
            last_l1_cursor: (state.last_l1_cursor as number) ?? 0,
            last_scene_name: (state.last_scene_name as string) ?? "",
          };
          cp.pipeline_states[key] = {
            ...DEFAULT_PIPELINE_STATE,
            conversation_count: (state.conversation_count as number) ?? 0,
            last_extraction_time: (state.last_extraction_time as string) ?? "",
            last_extraction_updated_time: (state.last_extraction_updated_time as string) ?? "",
            last_active_time: (state.last_active_time as number) ?? 0,
            l2_pending_l1_count: (state.l2_pending_l1_count as number) ?? 0,
            l2_last_extraction_time: (state.l2_last_extraction_time as string) ?? "",
          };
        }
      } else {
        // Ensure per-session states have all fields with defaults
        // 中文：确保每个会话的状态都有所有默认字段
        if (cp.runner_states) {
          for (const [key, state] of Object.entries(cp.runner_states)) {
            cp.runner_states[key] = { ...DEFAULT_RUNNER_STATE, ...state };
          }
        }
        if (cp.pipeline_states) {
          for (const [key, state] of Object.entries(cp.pipeline_states)) {
            cp.pipeline_states[key] = { ...DEFAULT_PIPELINE_STATE, ...state };
          }
        }
      }
      return cp;
    } catch {
      return structuredClone(DEFAULT_CHECKPOINT);
    }
  }

  /** Atomic write: write to tmp file, then rename into place. */
  /** 中文：原子写入：先写入临时文件，然后重命名替换原有文件 */
  private async writeRaw(checkpoint: Checkpoint): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, JSON.stringify(checkpoint, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
  }

  // ============================
  // Locked read-modify-write helper
  // ============================
  // 中文：锁定读修改写辅助

  /**
   * Execute a mutating operation under the per-file lock.
   * `fn` receives the current checkpoint and may modify it in place;
   * the updated checkpoint is atomically written back.
   * 中文：在文件锁下执行一个变更操作。
   * `fn` 接收当前检查点并可能就地修改它；
   * 更新后的检查点将原子性地重新写回。
   */
  private async mutate(fn: (cp: Checkpoint) => void | Promise<void>): Promise<Checkpoint> {
    return withFileLock(this.filePath, async () => {
      const cp = await this.readRaw();
      await fn(cp);
      await this.writeRaw(cp);
      return cp;
    });
  }

  // ============================
  // Public API — read-only
  // ============================
  // 中文：公共API — 只读

  /**
   * Read the current checkpoint (unlocked snapshot).
   *
   * NOTE: This does NOT acquire the file lock. The returned snapshot may be
   * stale if a concurrent `mutate()` is in progress. This is acceptable for
   * read-only uses (status display, deciding whether to run a pipeline step).
   *
   * For read-then-write patterns, always use `mutate()` instead — it acquires
   * the lock and re-reads from disk inside the critical section, ensuring the
   * update is based on the latest state.
   * 中文：读取当前检查点（未加锁快照）。
   * 注意：这并不获取文件锁。如果存在并发的`mutate()`操作，返回的快照可能是过时的。
   * 对于只读使用（状态显示、决定是否运行管道步骤），这是可以接受的。
   * 对于读后再写的情况，请始终使用`mutate()` — 它获取锁并在临界区内重新从磁盘读取以确保更新基于最新状态。
   */
  async read(): Promise<Checkpoint> {
    return this.readRaw();
  }

  /** Write a full checkpoint (acquires lock + atomic write). */
  /** 中文：写入完整检查点（获取锁 + 原子写）。 */
  async write(checkpoint: Checkpoint): Promise<void> {
    return withFileLock(this.filePath, () => this.writeRaw(checkpoint));
  }

  // ============================
  // Public API — mutating (all serialized via file lock)
  // ============================
  // 中文：公共API — 变更（全部通过文件锁序列化）

  // ============================
  // Persona methods (L3)
  // ============================
  // 中文：角色方法（L3）

  async markPersonaGenerated(totalProcessed: number): Promise<void> {
    await this.mutate((cp) => {
      cp.last_persona_at = totalProcessed;
      cp.last_persona_time = new Date().toISOString();
      cp.memories_since_last_persona = 0;
      cp.request_persona_update = false;
      cp.persona_update_reason = "";
    });
  }

  async clearPersonaRequest(): Promise<void> {
    await this.mutate((cp) => {
      cp.request_persona_update = false;
      cp.persona_update_reason = "";
    });
  }

  async setPersonaUpdateRequest(reason: string): Promise<void> {
    await this.mutate((cp) => {
      cp.request_persona_update = true;
      cp.persona_update_reason = reason;
    });
  }

  async incrementScenesProcessed(): Promise<void> {
    const cp = await this.mutate((cp) => {
      cp.scenes_processed += 1;
    });
    this.logger.info(`[checkpoint] incrementScenesProcessed: scenes_processed=${cp.scenes_processed}`);
  }

  // ============================
  // Per-session helpers — runner state (L0/L1 owned)
  // ============================
  // 中文：会话辅助 — 运行器状态（L0/L1 所有）

  /**
   * Get or create runner session state for a session.
   * 中文：获取或创建会话运行状态.
   */
  getRunnerState(cp: Checkpoint, sessionKey: string): RunnerSessionState {
    if (!cp.runner_states) {
      cp.runner_states = {};
    }
    let state = cp.runner_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_RUNNER_STATE };
      cp.runner_states[sessionKey] = state;
    }
    return state;
  }

  // ============================
  // Per-session helpers — pipeline state (PipelineManager owned)
  // ============================
  // 中文：会话辅助函数——流水线状态（由PipelineManager拥有）

  /**
   * Get or create pipeline session state for a session.
   * 中文：获取或创建会话流水线状态.
   */
  getPipelineState(cp: Checkpoint, sessionKey: string): PipelineSessionState {
    if (!cp.pipeline_states) {
      cp.pipeline_states = {};
    }
    let state = cp.pipeline_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_PIPELINE_STATE, last_active_time: Date.now() };
      cp.pipeline_states[sessionKey] = state;
    }
    return state;
  }

  /**
   * Get all pipeline states from checkpoint.
   * 中文：从检查点获取所有流水线状态.
   */
  getAllPipelineStates(cp: Checkpoint): Record<string, PipelineSessionState> {
    return cp.pipeline_states ?? {};
  }

  /**
   * Merge pipeline session states into the checkpoint (used by pipeline persister).
   * Acquires the file lock so this is safe against concurrent mutations.
   *
   * This writes ONLY to `pipeline_states`, never touching `runner_states`.
   * This is the core guarantee that eliminates the split-brain overwrite bug.
   * 中文：将会话流水线状态合并到检查点中（用于流水线持久化）。
   * 获取文件锁以确保在此过程中安全地防止并发修改。
   * 仅写入`pipeline_states`，从不接触`runner_states`。
   * 这是消除分裂脑覆盖错误的核心保证。
   */
  async mergePipelineStates(states: Record<string, PipelineSessionState>): Promise<void> {
    await this.mutate((cp) => {
      if (!cp.pipeline_states) cp.pipeline_states = {};
      for (const [key, pState] of Object.entries(states)) {
        cp.pipeline_states[key] = {
          ...cp.pipeline_states[key],
          ...pState,
        };
      }
    });
  }

  // ============================
  // L1-specific methods
  // ============================
  // 中文：L1特定方法

  /**
   * Mark L1 extraction completed: reset sinceL1 counter, advance L1 cursor,
   * and optionally save the last scene name for cross-batch continuity.
   *
   * @param cursorRecordedAtMs - The max recorded_at epoch ms of processed L0 messages.
   *   This becomes the new `last_l1_cursor` value (recorded_at semantics, not conversation timestamp).
   * 中文：标记L1提取完成：重置sinceL1计数器、前进L1光标，并可选地保存最后一个场景名称以实现跨批次连续性。
   * @param cursorRecordedAtMs - 处理的L0消息中最大记录时间戳（单位为毫秒）。
   * 此值成为新的`last_l1_cursor`值（基于记录时间，而非对话时间戳）。
   */
  async markL1ExtractionComplete(
    sessionKey: string,
    memoriesExtracted: number,
    cursorRecordedAtMs?: number,
    lastSceneName?: string,
  ): Promise<void> {
    await this.mutate((cp) => {
      const state = this.getRunnerState(cp, sessionKey);
      if (cursorRecordedAtMs) {
        state.last_l1_cursor = cursorRecordedAtMs;
      }
      if (lastSceneName !== undefined) {
        state.last_scene_name = lastSceneName;
      }
      cp.total_memories_extracted += memoriesExtracted;
      cp.memories_since_last_persona += memoriesExtracted;
    });
    this.logger.info(
      `[checkpoint] markL1ExtractionComplete session=${sessionKey}: ` +
      `extracted=${memoriesExtracted}, cursor=${cursorRecordedAtMs ?? "(unchanged)"}, ` +
      `lastScene="${lastSceneName ?? "(unchanged)"}"`,
    );
  }

  // ============================
  // Atomic capture (race-condition fix)
  // ============================
  // 中文：原子捕获（解决竞态条件问题）

  /**
   * Atomically read the per-session cursor, execute the capture callback,
   * and advance the cursor — all within a single file-lock critical section.
   *
   * This eliminates the race window that existed when `read()` (unlocked) and
   * `advanceSessionCapturedTimestamp()` (locked) were separate calls:
   * two concurrent `agent_end` events could both read the same stale cursor
   * and record duplicate messages.
   *
   * The callback receives `afterTimestamp` (the current per-session cursor)
   * and must return either:
   *   - `{ maxTimestamp, messageCount }` to advance the cursor, or
   *   - `null` to leave the cursor unchanged (nothing captured).
   *
   * L0 conversation count is also incremented inside the lock when messages
   * are captured, removing the need for a separate `incrementL0ConversationCount()` call.
   *
   * @param sessionKey   Per-session identifier
   * @param pluginStartTimestamp  Cold-start floor (used when no cursor exists yet)
   * @param fn  Async callback that performs the actual capture (recordConversation, etc.)
   * 中文：原子地读取会话游标、执行捕获回调并前进游标——全部在一个文件锁临界区完成。这消除了`read()`（未加锁）和`advanceSessionCapturedTimestamp()`（加锁）是单独调用时存在的竞态窗口：两个并发的`agent_end`事件都可能读取相同的过时游标并记录重复的消息。回调接收`afterTimestamp`（当前会话游标），必须返回以下之一：- `{ maxTimestamp, messageCount }`以前进游标，或- `null`以保持游标不变（未捕获）。当消息被捕获时，在锁内增加L0对话计数，移除单独的`incrementL0ConversationCount()`调用。@param sessionKey   会话标识符@param pluginStartTimestamp  冷启动底线（在尚未存在游标时使用）@param fn  执行实际捕获操作的异步回调（recordConversation等）
   */
  async captureAtomically(
    sessionKey: string,
    pluginStartTimestamp: number | undefined,
    fn: (afterTimestamp: number) => Promise<{ maxTimestamp: number; messageCount: number } | null>,
  ): Promise<void> {
    await this.mutate(async (cp) => {
      // Read the per-session cursor inside the lock
      // 中文：在锁内读取会话游标
      const state = this.getRunnerState(cp, sessionKey);
      let afterTimestamp = state.last_captured_timestamp || 0;

      // Cold-start guard (same logic that was previously in auto-capture.ts)
      // 中文：冷启动防护（之前在auto-capture.ts中的相同逻辑）
      if (afterTimestamp === 0 && pluginStartTimestamp && pluginStartTimestamp > 0) {
        afterTimestamp = pluginStartTimestamp;
      }

      const result = await fn(afterTimestamp);

      if (result) {
        // Advance per-session cursor (runner-owned)
        // 中文：前进会话游标（runner拥有）
        state.last_captured_timestamp = result.maxTimestamp;
        // Global stats (aggregate only — not used for filtering)
        // 中文：全局统计信息（仅聚合，不用于过滤）
        cp.last_captured_timestamp = Math.max(cp.last_captured_timestamp, result.maxTimestamp);
        cp.total_processed += result.messageCount;
        // Increment L0 conversation count (was a separate mutate() call before)
        // 中文：增加L0对话计数（之前是单独的mutate()调用）
        cp.l0_conversations_count += 1;
      }
    });
  }

}
