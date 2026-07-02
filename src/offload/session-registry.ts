/**
 * SessionRegistry: Per-session OffloadStateManager routing.
 *
 * Maps sessionKey → { manager, lastAccessMs } with LRU eviction.
 * Eliminates the global singleton stateManager — each session gets
 * its own isolated OffloadStateManager + StorageContext.
 * 中文：SessionRegistry: 每个会话的OffloadStateManager路由。
 * 将sessionKey → { manager, lastAccessMs } 映射，并使用LRU驱逐策略。
 * 消除了全局单一状态管理器——每个会话都有自己的隔离OffloadStateManager + StorageContext。
 */
import { OffloadStateManager } from "./state-manager.js";
import { parseSessionKey } from "./storage.js";

/** Matches internal memory-pipeline sessions (e.g. memory-{taskId}-session-{ts}). */
/** 中文：匹配内部内存管道会话（例如：memory-{taskId}-session-{ts}）。 */
const INTERNAL_SESSION_RE = /memory-.*-session-\d+/;

/** Returns true if the sessionKey belongs to an internal memory-pipeline session. */
/** 中文：如果sessionKey属于内部内存管道会话，则返回true。 */
function isInternalMemorySession(sessionKey: string): boolean {
  return INTERNAL_SESSION_RE.test(sessionKey);
}

/** Per-session context entry held by the registry. */
/** 中文：注册表持有的每个会话的上下文条目。 */
export interface SessionCtx {
  readonly sessionKey: string;
  readonly manager: OffloadStateManager;
  lastAccessMs: number;
}

/** Maximum number of cached sessions before LRU eviction kicks in. */
/** 中文：在LRU驱逐策略启动之前，缓存的最大会话数。 */
const MAX_CACHED_SESSIONS = 20;

/** Routes sessionKey → per-session OffloadStateManager with LRU eviction. */
/** 中文：将sessionKey路由到带有LRU驱逐策略的per-session OffloadStateManager。 */
export class SessionRegistry {
  private _sessions = new Map<string, SessionCtx>();
  private _dataRoot: string;
  readonly _registryId = ++SessionRegistry._registryCounter;
  private static _registryCounter = 0;

  constructor(dataRoot: string) {
    this._dataRoot = dataRoot;
  }

  /** Get the configured data root. */
  /** 中文：获取配置的数据根目录。 */
  get dataRoot(): string {
    return this._dataRoot;
  }

  /**
   * Get or create a per-session manager.
   * First access will create a new OffloadStateManager, call init() + switchSession()
   * to fully initialize storage paths and rebuild in-memory state from offload files.
   * 中文：获取或创建一个per-session管理器。
   * 首次访问时将创建一个新的OffloadStateManager，并调用init() + switchSession()
   * 以完全初始化存储路径并从卸载文件中重建内存状态。
   */
  async resolve(sessionKey: string, realSessionId?: string): Promise<SessionCtx> {
    let entry = this._sessions.get(sessionKey);
    if (entry) {
      entry.lastAccessMs = Date.now();
      return entry;
    }

    // New session — create manager and fully initialize
    // 中文：新会话——创建管理器并完全初始化
    const mgr = new OffloadStateManager();
    const parsed = parseSessionKey(sessionKey);
    if (parsed) {
      const effectiveSessionId = realSessionId || parsed.sessionId;
      await mgr.init(this._dataRoot, parsed.agentName, effectiveSessionId);
      // switchSession rebuilds confirmedOffloadIds, deletedOffloadIds,
      // processedToolCallIds from offload JSONL, registers sessionKey mapping,
      // and resets session-level runtime state.
      // 中文：switchSession从offload JSONL中重建confirmedOffloadIds、deletedOffloadIds和processedToolCallIds，注册sessionKey映射，并重置会话级运行时状态。
      await mgr.switchSession(sessionKey, this._dataRoot, realSessionId);
    } else {
      // sessionKey doesn't match "agent:<name>:<id>" format.
      // Use a sanitized sessionKey as both agentName and sessionId
      // so ctx is always initialized (avoids "ctx not initialized" errors).
      // 中文：sessionKey不符合"agent:<name>:<id>"格式。
      // 使用一个经过清理的sessionKey作为both agentName和sessionId
      // 以确保ctx始终初始化（避免“ctx未初始化”错误）。
      const fallbackName = sessionKey.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 64) || "unknown";
      const fallbackSessionId = realSessionId || `fallback-${Date.now()}`;
      await mgr.init(this._dataRoot, fallbackName, fallbackSessionId);
    }

    entry = { sessionKey, manager: mgr, lastAccessMs: Date.now() };
    this._sessions.set(sessionKey, entry);

    // LRU eviction
    // 中文：最近最少使用淘汰策略
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      this._evictOldest();
    }

    return entry;
  }

  /**
   * Resolve a session only if it is NOT an internal memory-pipeline session.
   *
   * Returns null for memory sessions (e.g. `memory-{taskId}-session-{ts}`),
   * preventing unnecessary OffloadStateManager creation, disk I/O, and LRU
   * cache slot pollution for sessions that should never run offload.
   *
   * Callers that need unconditional resolve (e.g. tests) can still use resolve().
   * 中文：仅在不是内部内存管道会话的情况下解析会话。
   * 对于内存会话（例如`memory-{taskId}-session-{ts}`）返回null，
   * 防止不必要的OffloadStateManager创建、磁盘I/O和LRU缓存槽污染。
   * 需要无条件解析的调用者（例如测试）仍可使用resolve()。
   */
  async resolveIfAllowed(sessionKey: string, realSessionId?: string): Promise<SessionCtx | null> {
    if (isInternalMemorySession(sessionKey)) return null;
    return this.resolve(sessionKey, realSessionId);
  }

  /** Look up an existing session (does not create). Updates lastAccessMs. */
  /** 中文：查找现有会话（不创建）。更新lastAccessMs。 */
  get(sessionKey: string): SessionCtx | undefined {
    const entry = this._sessions.get(sessionKey);
    if (entry) entry.lastAccessMs = Date.now();
    return entry;
  }

  /** Number of cached sessions. */
  /** 中文：缓存中的会话数量。 */
  get size(): number {
    return this._sessions.size;
  }

  /** Iterate over all session keys. */
  /** 中文：遍历所有会话键。 */
  keys(): IterableIterator<string> {
    return this._sessions.keys();
  }

  /** Iterate over all session entries. */
  /** 中文：遍历所有会话条目。 */
  values(): IterableIterator<SessionCtx> {
    return this._sessions.values();
  }

  /** Evict the least-recently-accessed session. */
  /** 中文：移除最近最少使用的会话。 */
  private _evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestMs = Infinity;
    for (const [key, entry] of this._sessions) {
      if (entry.lastAccessMs < oldestMs) {
        oldestMs = entry.lastAccessMs;
        oldestKey = key;
      }
    }
    if (oldestKey) this._sessions.delete(oldestKey);
  }
}
