/**
 * SerialQueue: a lightweight task queue with concurrency=1.
 *
 * Equivalent to `new PQueue({ concurrency: 1 })` but with zero external
 * dependencies. Supports:
 * - Serial execution (FIFO)
 * - `add(fn)` to enqueue a task (returns the task's result promise)
 * - `onIdle()` to wait until all queued tasks have completed
 * - `pause()` / `start()` to suspend/resume execution
 * - `size` to check pending task count
 * - Optional debug logger for enqueue/dequeue/complete diagnostics
 * 中文：SerialQueue: 一个并发数为1的轻量级任务队列。
 * 等同于 `new PQueue({ concurrency: 1 })` 但无外部依赖。支持：
 * - 串行执行（FIFO）
 * - 使用 `add(fn)` 入队一个任务（返回该任务的结果 promise）
 * - 使用 `onIdle()` 等待所有入队的任务完成
 * - 暂停/恢复执行使用 `pause()` / `start()`
 * - 使用 `size` 查看待处理的任务数量
 * - 可选调试日志用于入队/出队/完成诊断
 */

type Task<T = unknown> = () => Promise<T>;

interface QueueEntry {
  task: Task;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class SerialQueue {
  /** Human-readable name for logging / diagnostics. */
  /** 中文：日志/诊断用的人类可读名称。 */
  public readonly name: string;

  private queue: QueueEntry[] = [];
  private running = false;
  private paused = false;
  private idleResolvers: Array<() => void> = [];

  /** Optional debug logger — receives diagnostic messages for enqueue/dequeue/complete. */
  /** 中文：可选的调试日志 — 接收入队/出队/完成的诊断消息。 */
  private debugFn?: (msg: string) => void;

  constructor(name = "unnamed") {
    this.name = name;
  }

  /** Set a debug logger for queue diagnostics. */
  /** 中文：为队列诊断设置一个调试日志。 */
  setDebugLogger(fn: (msg: string) => void): void {
    this.debugFn = fn;
  }

  /** Number of tasks waiting to be executed. */
  /** 中文：等待执行的任务数量。 */
  get size(): number {
    return this.queue.length;
  }

  /** Whether a task is currently executing. */
  /** 中文：当前是否有任务正在执行。 */
  get pending(): boolean {
    return this.running;
  }

  /** Whether the queue is idle (no queued tasks and nothing running). */
  /** 中文：队列是否空闲（无排队任务且无运行中的任务）。 */
  get idle(): boolean {
    return this.queue.length === 0 && !this.running;
  }

  /** Add a task to the queue. Returns the task's result promise. */
  /** 中文：将任务添加到队列。返回该任务的结果 promise。 */
  add<T>(task: Task<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as Task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.debugFn?.(`[queue:${this.name}] enqueued, pending=${this.queue.length}, running=${this.running}`);
      this.drain();
    });
  }

  /** Pause the queue. Currently running task will finish, but no new tasks start. */
  /** 中文：暂停队列。当前正在运行的任务会完成，但不会开始新任务。 */
  pause(): void {
    this.paused = true;
  }

  /** Resume the queue after pause(). */
  /** 中文：调用pause()后恢复队列。 */
  start(): void {
    this.paused = false;
    this.drain();
  }

  /** Returns a promise that resolves when all queued tasks have completed. */
  /** 中文：返回一个promise，在所有排队任务完成后解析。 */
  onIdle(): Promise<void> {
    if (this.queue.length === 0 && !this.running) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  /** Clear all pending (not yet started) tasks. */
  /** 中文：清除所有待处理（尚未启动）的任务。 */
  clear(): void {
    for (const entry of this.queue) {
      entry.reject(new Error("Queue cleared"));
    }
    this.queue = [];
  }

  private drain(): void {
    if (this.running || this.paused || this.queue.length === 0) return;

    const entry = this.queue.shift()!;
    this.running = true;

    this.debugFn?.(`[queue:${this.name}] dequeued, starting execution (remaining=${this.queue.length})`);

    entry
      .task()
      .then((result) => entry.resolve(result))
      .catch((err) => entry.reject(err))
      .finally(() => {
        this.running = false;
        this.debugFn?.(`[queue:${this.name}] task completed (remaining=${this.queue.length})`);
        if (this.queue.length === 0) {
          // Notify idle waiters
          // 中文：通知空闲等待者
          const resolvers = this.idleResolvers;
          this.idleResolvers = [];
          for (const resolve of resolvers) resolve();
        } else {
          this.drain();
        }
      });
  }
}
