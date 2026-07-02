/**
 * OffloadStateManager: In-memory state + persistent state.json coordination.
 * Manages pendingToolPairs buffer, active MMD tracking, and processed IDs.
 *
 * Each instance is bound to a single session via StorageContext.
 * No global mutable state — all I/O goes through the frozen ctx.
 * 中文：OffloadStateManager: 内存状态 + 状态.json持久化协调。
 * 管理待处理ToolPair缓冲区、活跃MMD跟踪和已处理ID。
 * 每个实例通过StorageContext绑定到单个会话。
 * 无全局可变状态 — 所有I/O均通过冻结的ctx进行。
 */
import {
  readStateFile,
  writeStateFile,
  ensureDirs,
  createStorageContext,
  parseSessionKey,
  readOffloadEntries,
  extractConfirmedIdsFromEntries,
  extractDeletedIdsFromEntries,
  registerSession,
  listMmds,
} from "./storage.js";
import type { StorageContext } from "./storage.js";
import type { ToolPair, PluginState, OffloadEntry, L15Boundary } from "./types.js";

const DEFAULT_STATE: PluginState & { estimatedSystemOverhead: number | null } = {
  activeMmdFile: null,
  activeMmdId: null,
  mmdCounter: 0,
  lastSessionKey: null,
  lastOffloadedToolCallId: null,
  lastL2TriggerTime: null,
  estimatedSystemOverhead: null,
};

export class OffloadStateManager {
  /** Immutable storage path context — set by init() or switchSession() */
  /** 中文：Immutable存储路径上下文 — 由init()或switchSession()设置 */
  private _ctx: StorageContext | null = null;

  /** Buffered tool pairs waiting to be processed by L1 */
  /** 中文：等待L1处理的缓冲Tool对集合 */
  pendingToolPairs: Array<ToolPair & { _sessionId?: string | null }> = [];
  /** Set of already-processed tool call IDs to prevent duplicates */
  /** 中文：已处理工具调用ID集，防止重复 */
  processedToolCallIds = new Set<string>();
  /** Persistent state (synced with state.json) */
  /** 中文：持久化状态（与state.json同步） */
  private state: PluginState & { estimatedSystemOverhead: number | null } = { ...DEFAULT_STATE };
  /** Whether state has been loaded from disk */
  /** 中文：是否从磁盘加载了状态 */
  private loaded = false;
  /** Mutex for L1 pipeline to prevent concurrent runs */
  /** 中文：用于防止L1流水线并发运行的互斥锁 */
  private l1Lock: Promise<unknown> = Promise.resolve();

  // ─── Runtime-only flags (not persisted) ──────────────────────────────────
  // 中文：─── 运行时仅用标志（未保存） ──────────────────────────────────
  private mmdInjectionReady = false;
  private injectedMmdVersions: Record<string, string> = {};

  /** Whether L1.5 has successfully executed for the current session/prompt.
   * 中文：是否当前会话/提示已成功执行L1.5。L2必须在满足此条件后才触发。
   *  L2 must wait for this to be true before triggering. */
  l15Settled = false;
  /** Unique instance ID for debugging (each new OffloadStateManager gets a new id). */
  /** 中文：用于调试的唯一实例ID（每次新建OffloadStateManager都会获得一个新的id）。 */
  readonly _instanceId = ++OffloadStateManager._instanceCounter;
  private static _instanceCounter = 0;

  /** Set of toolCallIds confirmed offloaded in previous rounds. */
  /** 中文：上一轮确认已卸载的toolCallIds集合。 */
  confirmedOffloadIds = new Set<string>();
  /** Set of toolCallIds that were aggressively DELETED. */
  /** 中文：被激进删除的toolCallIds集合。 */
  deletedOffloadIds = new Set<string>();
  /** Reconciliation retry counter */
  /** 中文：重聚合并重试计数器 */
  _reconcileRetries = new Map<string, number>();
  /** Cached offload entries map */
  /** 中文：缓存的卸载条目映射表 */
  _cachedOffloadMap: Map<string, OffloadEntry> | null = null;
  /** Monotonic version counter */
  /** 中文：单调版本计数器 */
  _offloadMapVersion = 0;
  /** Last MMD injection token count */
  /** 中文：最后一次MMD注入令牌数量 */
  lastMmdInjectedTokens = 0;
  /** Cached system prompt from last llm_input */
  /** 中文：上次llm_input的缓存系统提示 */
  cachedSystemPrompt: string | null = null;
  /** Cached user prompt from last llm_input */
  /** 中文：上次llm_input的缓存用户提示 */
  cachedUserPrompt: string | null = null;
  /** Cached latest turn messages for L2 */
  /** 中文：L2最新的轮次消息缓存 */
  cachedLatestTurnMessages: string | null = null;
  /** Cached recent history for L2 background triggers */
  /** 中文：L2最近历史记录用于背景触发缓存 */
  cachedRecentHistory: string | null = null;
  /** Cached system prompt token count */
  /** 中文：系统提示缓存的令牌计数 */
  cachedSystemPromptTokens: number | null = null;
  /** Cached user prompt token count */
  /** 中文：用户提示缓存的令牌计数 */
  cachedUserPromptTokens: number | null = null;
  /** Force emergency compression on next L3 entry */
  /** 中文：强制在下次L3入口进行紧急压缩 */
  _forceEmergencyNext = false;
  /** Last known total token count from precise tiktoken calculation (P1 quick-skip) */
  /** 中文：精确tiktoken计算的最后已知总令牌计数（P1快速跳过） */
  lastKnownTotalTokens = 0;
  /** Message count at last precise tiktoken calculation (P1 quick-skip) */
  /** 中文：最后精确tiktoken计算的消息计数（P1快速跳过） */
  lastKnownMessageCount = 0;
  /** Consecutive QUICK-SKIP count; reset to 0 on each precise calculation */
  /** 中文：连续的QUICK-SKIP计数；每次精确计算后重置为0 */
  consecutiveQuickSkips = 0;
  /** Boundary info from last aggressive deletion — enables O(1) head-delete on replay.
   *  originalIndex: position of the first kept message in the original input array.
   *  fingerprint: hash of that message for verification.
   *  keptMsgCount: number of messages kept after aggressive.
   * 中文：上次激进删除时的边界信息——在回放时启用O(1)头部删除。
   * originalIndex: 原始输入数组中第一个保留消息的位置。
   * fingerprint: 那条消息的哈希值，用于验证。
   * keptMsgCount: 激进删除后保留的消息数量。
   * remainingTokens: 激进压缩后的总token数（包括系统token）
   *  remainingTokens: total tokens (incl sys) after aggressive compression. */
  _lastAggressiveBoundary: {
    originalIndex: number;
    fingerprint: number;
    keptMsgCount: number;
    remainingTokens: number;
  } | null = null;
  /** Cached tool params from before_tool_call hook */
  /** 中文：before_tool_call钩子缓存的工具参数 */
  _pendingParams = new Map<string, Record<string, unknown>>();
  /** Last L1.5 prompt hash — per-session to avoid cross-session re-trigger skip */
  /** 中文：会话级最后L1.5提示哈希——避免跨会话重新触发跳过 */
  lastL15PromptHash: number | null = null;

  // ─── Fault tolerance fields ─────────────────────────────────────────────
  // 中文：─── 容错字段 ─────────────────────────────────────────────
  /** Per-chunk consecutive L1 failure count. Key = first toolCallId of the chunk. */
  /** 中文：每个片段连续的L1失败计数。Key = 该片段的第一个toolCallId. */
  _l1ChunkFailCounts = new Map<string, number>();
  /** Consecutive L1.5 all-null response count. Reset to 0 on successful judgment. */
  /** 中文：连续的L1.5全空响应计数。在成功判断后重置为0 */
  l15ConsecutiveNullCount = 0;

  // ─── L1.5 Boundary (runtime-only, per-session) ────────────────────────
  // 中文：─── L1.5 边界（运行时专用，每会话） ────────────────────────
  /** Global entry counter, incremented after each appendOffloadEntries. */
  /** 中文：全局入口计数器，在每次appendOffloadEntries后递增。 */
  entryCounter = 0;
  /** Settled boundaries (ascending by startIndex). */
  /** 中文：已确定的边界（按startIndex升序排列）。 */
  l15Boundaries: L15Boundary[] = [];

  // ─── StorageContext accessor ─────────────────────────────────────────────
  // 中文：─── StorageContext 访问器 ─────────────────────────────────────────────

  /** Get the current session's StorageContext. Throws if not initialized. */
  /** 中文：获取当前会话的StorageContext。未初始化时抛出异常。 */
  get ctx(): StorageContext {
    if (!this._ctx) {
      throw new Error("OffloadStateManager: ctx not initialized, call init() or switchSession() first");
    }
    return this._ctx;
  }

  /** Get agent name from ctx (null if not initialized) */
  /** 中文：从ctx中获取代理名称（未初始化时为null） */
  get agentName(): string | null {
    return this._ctx?.agentName ?? null;
  }

  /** Get session id from ctx (null if not initialized) */
  /** 中文：从ctx中获取会话ID（未初始化时为null） */
  get sessionId(): string | null {
    return this._ctx?.sessionId ?? null;
  }

  // ─── Initialization ──────────────────────────────────────────────────────
  // 中文：─── 初始化 ──────────────────────────────────────────────────────

  /**
   * Initialize the manager for a specific agent + session.
   * Creates StorageContext, ensures directories, and loads persistent state.
   * 中文：初始化特定代理+会话的管理器。
   * 创建StorageContext，确保目录，并加载持久状态。
   */
  async init(dataRoot: string, agentName: string, sessionId: string): Promise<void> {
    this._ctx = createStorageContext(dataRoot, agentName, sessionId);
    await ensureDirs(this._ctx);
    const loadedState = await readStateFile(this._ctx, DEFAULT_STATE);
    this.state = { ...DEFAULT_STATE, ...loadedState };
    this.loaded = true;
  }

  async save(): Promise<void> {
    await writeStateFile(this.ctx, this.state);
  }

  // ─── Tool Pair Buffer ────────────────────────────────────────────────────
  // 中文：─── 工具对缓冲区 ─────────────────────────────────────────────────────
  addToolPair(pair: ToolPair): void {
    if (this.processedToolCallIds.has(pair.toolCallId)) return;
    (pair as ToolPair & { _sessionId?: string | null })._sessionId = this._ctx?.sessionId ?? null;
    this.pendingToolPairs.push(pair as ToolPair & { _sessionId?: string | null });
  }

  getPendingCount(): number {
    return this.pendingToolPairs.length;
  }

  hasPending(): boolean {
    return this.pendingToolPairs.length > 0;
  }

  takePending(max: number): Array<ToolPair & { _sessionId?: string | null }> {
    const taken = this.pendingToolPairs.splice(0, max);
    for (const pair of taken) {
      this.processedToolCallIds.add(pair.toolCallId);
    }
    return taken;
  }

  isProcessed(toolCallId: string): boolean {
    return this.processedToolCallIds.has(toolCallId);
  }

  // ─── Active MMD ──────────────────────────────────────────────────────────
  // 中文：─── 活动MMD ─────────────────────────────────────────────────────────
  getActiveMmdFile(): string | null {
    return this.state.activeMmdFile;
  }

  getActiveMmdId(): string | null {
    return this.state.activeMmdId;
  }

  setActiveMmd(file: string | null, id: string | null): void {
    this.state.activeMmdFile = file;
    this.state.activeMmdId = id;
  }

  async nextMmdNumber(): Promise<number> {
    try {
      const existingFiles = await listMmds(this.ctx);
      let maxOnDisk = 0;
      for (const f of existingFiles) {
        const m = f.match(/^(\d+)-/);
        if (m) {
          const num = parseInt(m[1], 10);
          if (num > maxOnDisk) maxOnDisk = num;
        }
      }
      if (maxOnDisk >= this.state.mmdCounter) {
        this.state.mmdCounter = maxOnDisk;
      }
    } catch {
      /* If listing fails, fall through with in-memory counter */
      /** 中文：如果列出失败，则使用内存中的计数器继续执行 */
    }
    this.state.mmdCounter += 1;
    return this.state.mmdCounter;
  }

  getMmdCounter(): number {
    return this.state.mmdCounter;
  }

  // ─── Session / Multi-Agent ──────────────────────────────────────────────
  // 中文：─── 会话/多代理 ─────────────────────────────────────────────────────
  getLastSessionKey(): string | null {
    return this.state.lastSessionKey;
  }

  setLastSessionKey(key: string | null): void {
    this.state.lastSessionKey = key;
  }

  /**
   * Switch to a new session. Rebuilds StorageContext and reloads state.
   * @param sessionKey - Full session key (e.g. "agent:main:session-123")
   * @param dataRoot - Storage root directory
   * @param realSessionId - Optional override for the parsed sessionId
   * 中文：切换到新会话。重建StorageContext并重新加载状态。
   * @param sessionKey - 完整的会话键（例如：“agent:main:session-123”）
   * @param dataRoot - 存储根目录
   * @param realSessionId - 可选的解析后的sessionId覆盖值
   */
  async switchSession(
    sessionKey: string,
    dataRoot: string,
    realSessionId?: string,
  ): Promise<boolean> {
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return false;
    const prevAgent = this._ctx?.agentName;
    const effectiveSessionId = realSessionId || parsed.sessionId;

    // Create new immutable StorageContext
    // 中文：创建新的不可变StorageContext
    this._ctx = createStorageContext(dataRoot, parsed.agentName, effectiveSessionId);
    await ensureDirs(this._ctx);
    if (realSessionId) {
      await registerSession(this._ctx, sessionKey, realSessionId).catch(() => {});
    }
    if (prevAgent !== parsed.agentName) {
      const loadedState = await readStateFile(this._ctx, DEFAULT_STATE);
      this.state = { ...DEFAULT_STATE, ...loadedState };
    }
    try {
      const entries = await readOffloadEntries(this._ctx);
      this.confirmedOffloadIds = extractConfirmedIdsFromEntries(
        entries as Array<OffloadEntry & { offloaded?: unknown }>,
      );
      this.deletedOffloadIds = extractDeletedIdsFromEntries(
        entries as Array<OffloadEntry & { offloaded?: unknown }>,
      );
      this.processedToolCallIds = new Set<string>();
      for (const e of entries) {
        if (e.tool_call_id) {
          this.processedToolCallIds.add(e.tool_call_id);
          const norm = e.tool_call_id.replace(/_/g, "");
          if (norm !== e.tool_call_id) {
            this.processedToolCallIds.add(norm);
          }
        }
      }
      this.pendingToolPairs = [];
      this.injectedMmdVersions = {};
      this.mmdInjectionReady = false;
      this.l15Settled = false;
      this.lastMmdInjectedTokens = 0;
      this.cachedUserPrompt = null;
      this.lastL15PromptHash = null;
      // Restore entryCounter from persisted entries; reset boundaries
      // 中文：从持久化条目中恢复entryCounter；重置边界
      this.entryCounter = entries.length;
      this.l15Boundaries = [];
      // Reset P1 quick-skip state
      // 中文：重置P1快速跳过状态
      this.lastKnownTotalTokens = 0;
      this.lastKnownMessageCount = 0;
      this.consecutiveQuickSkips = 0;
      this._forceEmergencyNext = false;
      this._lastAggressiveBoundary = null;
      // Keep cachedSystemPrompt/Tokens across switchSession within the same agent
      // 中文：在同一个代理内的switchSession之间保持cachedSystemPrompt/Tokens缓存
      if (prevAgent !== parsed.agentName) {
        this.cachedSystemPrompt = null;
        this.cachedSystemPromptTokens = null;
        this.cachedUserPromptTokens = null;
      }
      this._cachedOffloadMap = null;
      this._offloadMapVersion++;
      this.cachedLatestTurnMessages = null;
      this.cachedRecentHistory = null;
      this._reconcileRetries = new Map();
      this._pendingParams = new Map();
      this._l1ChunkFailCounts = new Map();
      this.l15ConsecutiveNullCount = 0;
    } catch {
      this.confirmedOffloadIds = new Set();
      this.deletedOffloadIds = new Set();
      this.processedToolCallIds = new Set();
      this.pendingToolPairs = [];
    }
    this.state.lastSessionKey = sessionKey;
    await this.save();
    return true;
  }

  getLastOffloadedToolCallId(): string | null {
    return this.state.lastOffloadedToolCallId;
  }

  setLastOffloadedToolCallId(toolCallId: string | null): void {
    this.state.lastOffloadedToolCallId = toolCallId;
  }

  // ─── L1 Mutex ────────────────────────────────────────────────────────────
  // 中文：─── L1互斥量 ────────────────────────────────────────────────────────────
  acquireL1Lock(): Promise<() => void> {
    let release!: () => void;
    const prev = this.l1Lock;
    this.l1Lock = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    return prev.then(() => release);
  }

  // ─── L2 Trigger Tracking ───────────────────────────────────────────────
  // 中文：─── L2触发跟踪 ───────────────────────────────────────────────
  getLastL2TriggerTime(): string | null {
    return this.state.lastL2TriggerTime;
  }

  setLastL2TriggerTime(time: string | null): void {
    this.state.lastL2TriggerTime = time;
  }

  // ─── Full State Access ───────────────────────────────────────────────────
  // 中文：─── 全局状态访问 ───────────────────────────────────────────────────
  getState(): Readonly<PluginState> {
    return { ...this.state };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  // ─── MMD Injection Control ──────────────────────────────────────────────
  // 中文：─── MMD注入控制 ──────────────────────────────────────────────
  setMmdInjectionReady(ready: boolean): void {
    this.mmdInjectionReady = ready;
  }

  isMmdInjectionReady(): boolean {
    return this.mmdInjectionReady;
  }

  // ─── Injected MMD Version Tracking ──────────────────────────────────────
  // 中文：─── 注入的MMD版本跟踪 ──────────────────────────────────────
  setInjectedMmdVersion(filename: string, fingerprint: string): void {
    this.injectedMmdVersions[filename] = fingerprint;
  }

  getInjectedMmdVersion(filename: string): string | null {
    return this.injectedMmdVersions[filename] ?? null;
  }

  removeInjectedMmdVersion(filename: string): void {
    delete this.injectedMmdVersions[filename];
  }

  getAllInjectedMmdVersions(): Record<string, string> {
    return { ...this.injectedMmdVersions };
  }

  clearInjectedMmdVersions(): void {
    this.injectedMmdVersions = {};
  }

  // ─── Token Tracking ─────────────────────────────────────────────────────
  // 中文：─── 令牌跟踪 ─────────────────────────────────────────────────────
  setEstimatedSystemOverhead(tokens: number): void {
    (this.state as unknown as Record<string, unknown>).estimatedSystemOverhead = tokens;
  }

  getEstimatedSystemOverhead(): number | null {
    return (this.state as unknown as Record<string, unknown>).estimatedSystemOverhead as number | null;
  }

  // ─── Offload Map Cache ──────────────────────────────────────────────────
  // 中文：─── Offload Map Cache ──────────────────────────────────────────────────
  invalidateOffloadMapCache(): void {
    this._cachedOffloadMap = null;
    this._offloadMapVersion++;
  }

  getCachedOffloadMap(): Map<string, OffloadEntry> | null {
    return this._cachedOffloadMap;
  }

  setCachedOffloadMap(map: Map<string, OffloadEntry>): void {
    this._cachedOffloadMap = map;
  }

  getOffloadMapVersion(): number {
    return this._offloadMapVersion;
  }

  // ─── Before Tool Call Params Cache ───────────────────────────────────────
  // 中文：─── Before Tool Call Params Cache ───────────────────────────────────────
  cacheToolParams(toolCallId: string, params: Record<string, unknown>): void {
    this._pendingParams.set(toolCallId, params);
    if (this._pendingParams.size > 100) {
      const oldest = this._pendingParams.keys().next().value;
      if (oldest !== undefined) this._pendingParams.delete(oldest);
    }
  }

  consumeToolParams(toolCallId: string): Record<string, unknown> | null {
    const params = this._pendingParams.get(toolCallId);
    if (params !== undefined) {
      this._pendingParams.delete(toolCallId);
    }
    return params ?? null;
  }

  // ─── L1.5 Boundary Helpers ─────────────────────────────────────────────
  // 中文：─── L1.5 Boundary Helpers ─────────────────────────────────────────────

  /**
   * Append a new boundary (must be in ascending startIndex order).
   * If the last boundary has the same startIndex, overwrite it instead of
   * appending — this happens during fast task switching when no tool calls
   * (and thus no L1 entries) are produced between consecutive L1.5 judgments.
   * 中文：在 startIndex 升序的情况下追加一个新的边界。
   * 如果最后一个边界具有相同的 startIndex，则覆盖它而不是追加 — 这发生在快速任务切换期间，即在连续的 L1.5 判断之间没有产生任何工具调用（因此也没有 L1 条目）时。
   */
  pushBoundary(boundary: L15Boundary): void {
    const last = this.l15Boundaries.at(-1);
    if (last && last.startIndex === boundary.startIndex) {
      this.l15Boundaries[this.l15Boundaries.length - 1] = boundary;
    } else {
      this.l15Boundaries.push(boundary);
    }
  }

  /**
   * Find the boundary that covers the given entry index.
   * Returns the last boundary whose startIndex <= entryIndex,
   * or null if no boundary covers it (entry predates all boundaries).
   * 中文：查找包含给定条目索引的边界。
   * 返回满足 startIndex <= entryIndex 的最后一个边界，
   * or null 如果没有任何边界覆盖它（该条目早于所有边界）。
   */
  resolveEntryBoundary(entryIndex: number): L15Boundary | null {
    let matched: L15Boundary | null = null;
    for (const b of this.l15Boundaries) {
      if (b.startIndex <= entryIndex) {
        matched = b;
      } else {
        break; // boundaries are ascending by startIndex
        // 中文：起始索引startIndex处的边界值是递增的
      }
    }
    return matched;
  }
}
