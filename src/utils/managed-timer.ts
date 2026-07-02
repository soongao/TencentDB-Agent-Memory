/**
 * ManagedTimer: a named, lifecycle-managed wrapper around setTimeout.
 *
 * Eliminates repetitive clear→set→fire→clean patterns by providing:
 * - `schedule(delayMs, cb)` — cancel any pending timer, set a new one
 * - `scheduleAt(epochMs, cb)` — schedule by absolute time point
 * - `tryAdvanceTo(epochMs, cb)` — only reschedule if new time is *earlier*
 * - `cancel()` — cancel without triggering
 * - `flush()` — trigger immediately (for graceful shutdown)
 * - `pending` — whether a timer is waiting
 *
 * The optional `isDestroyed` guard prevents firing after the owner is torn down.
 * 中文：ManagedTimer: 带有名称并在生命周期内管理的setTimeout包装器。
 * 通过提供以下功能消除了重复的清除→设置→触发→清理模式：
 * - `schedule(delayMs, cb)` — 取消任何待定定时器，设置一个新的
 * - `scheduleAt(epochMs, cb)` — 按绝对时间点安排
 * - `tryAdvanceTo(epochMs, cb)` — 仅在新时间是*更早*时重新安排
 * - `cancel()` — 取消而不触发
 * - `flush()` — 立即触发（用于优雅关闭）
 * - `pending` — 是否有定时器等待
 * 可选的`isDestroyed`防护防止在所有者被销毁后触发。
 */

type TimerHandle = ReturnType<typeof setTimeout>;

export class ManagedTimer {
  private handle: TimerHandle | null = null;
  private callback: (() => void) | null = null;
  /** Absolute epoch-ms when the current timer is scheduled to fire. */
  /** 中文：当前定时器计划触发的绝对epoch-ms时间点。 */
  private scheduledAt = 0;

  constructor(
    /** Human-readable name for logging. */
    /** 中文：供日志记录的人类可读名称。 */
    public readonly name: string,
    /** If provided, checked before firing — skips callback when true. */
    /** 中文：如果提供，触发前进行检查——当为真时跳过回调。 */
    private readonly isDestroyed?: () => boolean,
  ) {}

  // ── Core operations ──────────────────────────────────
  // 中文：── 核心操作 ──────────────────────────────────

  /**
   * Cancel any pending timer and schedule a new one after `delayMs`.
   * The callback fires once; the timer auto-clears after firing.
   * 中文：取消任何待定定时器并在`delayMs`后安排一个新的。
   * 回调仅触发一次；定时器在触发后自动清除。
   */
  schedule(delayMs: number, callback: () => void): void {
    this.cancelInternal();
    this.callback = callback;
    this.scheduledAt = Date.now() + delayMs;
    this.handle = setTimeout(() => this.fire(), delayMs);
    // Don't let pipeline timers keep the process alive in CLI mode.
    // In gateway mode the server listener holds the event loop anyway.
    // 中文：在CLI模式下不要让流水线定时器保持进程存活。
    // 在网关模式下服务器监听器已经持有事件循环。
    this.handle.unref();
  }

  /**
   * Cancel any pending timer and schedule to fire at an absolute epoch-ms.
   * If `epochMs` is in the past, fires on next tick (delay = 0).
   * 中文：取消任何待定定时器并计划在绝对epoch-ms时触发。
   * 如果`epochMs`在过去，则立即触发（延迟=0）。
   */
  scheduleAt(epochMs: number, callback: () => void): void {
    this.cancelInternal();
    this.callback = callback;
    this.scheduledAt = epochMs;
    const delay = Math.max(0, epochMs - Date.now());
    this.handle = setTimeout(() => this.fire(), delay);
    this.handle.unref();
  }

  /**
   * Only reschedule if `epochMs` is *earlier* than the current scheduled time.
   * This implements the "downward-only" timer pattern (L2 scheduling).
   * If no timer is pending, behaves like `scheduleAt()`.
   *
   * @returns true if the timer was actually advanced (or newly set).
   * 中文：只有在 `epochMs` 比当前计划时间更早时才重新安排。
   * 这实现了“单向计时器”模式（L2 调度）。
   * 如果没有待定的计时器，则行为类似于 `scheduleAt()`。
   * @returns 如果实际上将定时器提前设置或首次设置为 true。
   */
  tryAdvanceTo(epochMs: number, callback: () => void): boolean {
    if (this.handle === null) {
      // No pending timer → set it
      // 中文：没有待定的计时器 → 设置它
      this.scheduleAt(epochMs, callback);
      return true;
    }

    if (epochMs < this.scheduledAt) {
      // New time is earlier → reschedule
      // 中文：新时间更早 → 重新安排
      this.scheduleAt(epochMs, callback);
      return true;
    }

    // Current timer is already earlier or equal → keep it
    // 中文：当前计时器已经更早或相同 → 保持不变
    return false;
  }

  /**
   * Cancel the pending timer without triggering the callback.
   * 中文：取消待定的计时器而不触发回调。
   */
  cancel(): void {
    this.cancelInternal();
  }

  /**
   * Immediately trigger the callback (if pending) and clear the timer.
   * Used for graceful shutdown to flush pending work.
   *
   * Note: Unlike `fire()`, this method intentionally does NOT check `isDestroyed`.
   * This is by design — during shutdown, `destroy()` sets `destroyed = true` first,
   * then calls `flush()` to drain pending work. The `isDestroyed` guard only applies
   * to natural timer expiration via `fire()`, not to explicit shutdown flushes.
   * 中文：立即触发回调（如果存在）并清除定时器。
   * 用于平滑关闭以刷新待处理的工作。
   * 注意：与 `fire()` 不同，此方法故意不检查 `isDestroyed`。
   * 这是有意为之 — 在关闭期间，`destroy()` 首先将 `destroyed = true`，
   * 然后调用 `flush()` 以清空待处理的工作。`isDestroyed` 保护仅适用于通过 `fire()` 自然到期的定时器，而不适用于显式关闭刷新。
   */
  flush(): void {
    if (this.handle === null) return;
    const cb = this.callback;
    this.cancelInternal();
    if (cb) cb();
  }

  // ── Accessors ────────────────────────────────────────
  // 中文：── 访问器 ────────────────────────────────────────

  /** Whether a timer is currently pending. */
  /** 中文：当前是否有待定的计时器。 */
  get pending(): boolean {
    return this.handle !== null;
  }

  /** The epoch-ms when the current timer is scheduled to fire (0 if none). */
  /** 中文：当前定时器预计触发的时间戳（如果没有则为0）. */
  get scheduledTime(): number {
    return this.handle !== null ? this.scheduledAt : 0;
  }

  // ── Internals ────────────────────────────────────────
  // 中文：── 内部实现 ───────────────────────────────────────

  private fire(): void {
    const cb = this.callback;
    this.handle = null;
    this.callback = null;
    this.scheduledAt = 0;

    if (this.isDestroyed?.()) return;
    if (cb) cb();
  }

  private cancelInternal(): void {
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
    this.callback = null;
    this.scheduledAt = 0;
  }
}
