/**
 * Session filtering for memory-tdai.
 *
 * Decides whether a session should be ignored by the memory plugin
 * (capture, recall, pipeline scheduling). All skip rules are compiled
 * into a flat list of matchers at construction time — zero per-call overhead.
 * 中文：内存-tdai的会话过滤。
 * 决定是否应由内存插件（捕获、回忆、管道调度）忽略某个会话。所有跳过规则在构造时编译成一个扁平的匹配列表——无每次调用开销。
 */

// ============================
// Types
// ============================

export interface AgentHookContext {
  sessionKey?: string;
  sessionId?: string;
  trigger?: string;
}

type SessionKeyMatcher = (sessionKey: string) => boolean;

// ============================
// Non-interactive trigger detection
// ============================
// 中文：非交互触发检测

const SKIP_TRIGGERS = new Set(["cron", "heartbeat", "automation", "schedule"]);

/**
 * Returns true when the hook was fired by a non-interactive trigger
 * (heartbeat, cron job, automation, etc.) — these produce no meaningful
 * user conversation and should not be captured or counted.
 * 中文：当挂钩由非交互触发（心跳、定时任务、自动化等）触发时返回true——这些不会产生有意义的用户对话，不应被捕获或计数。
 */
export function isNonInteractiveTrigger(trigger?: string, sessionKey?: string): boolean {
  if (trigger && SKIP_TRIGGERS.has(trigger.toLowerCase())) return true;
  if (sessionKey) {
    if (/:cron:/i.test(sessionKey) || /:heartbeat:/i.test(sessionKey)) return true;
  }
  return false;
}

// ============================
// Built-in skip rules (always active)
// ============================
// 中文：内置跳过规则（始终激活）

/**
 * Hard-coded matchers that identify internal / non-user sessions.
 * These are always applied regardless of user configuration.
 * 中文：内置的匹配器，用于识别内部/非用户会话。
 * 这些始终会被应用，无论用户配置如何.
 */
const BUILTIN_MATCHERS: SessionKeyMatcher[] = [
  // Scene extraction runner sessions
  // 中文：场景提取运行时会话
  (key) => key.includes(":memory-scene-extract-"),
  // OpenClaw subagent sessions
  // 中文：OpenClaw 子代理会话
  (key) => key.includes(":subagent:"),
  // Temporary / internal utility sessions (e.g. temp:slug-generator)
  // 中文：临时/内部实用工具会话（例如：temp:slug-generator）
  (key) => key.startsWith("temp:"),
];

// ============================
// Glob → matcher compiler
// ============================
// 中文：全局 → 匹配器编译器

/**
 * Turn a simple glob pattern (only `*` supported) into a matcher
 * that tests the full sessionKey.
 *
 * Since sessionKeys look like `agent:<agentId>:...`, we match the
 * glob against the whole key so users can write patterns like
 * `bench-judge-*` (matched anywhere) or more specific ones.
 * 中文：将简单的通配符模式（仅支持 `*`）转换为一个匹配器，用于测试完整的sessionKey。由于sessionKeys看起来像`agent:<agentId>:...`，我们整个key与通配符进行匹配，以便用户可以编写如`bench-judge-*`（任意位置匹配）或更具体的模式。
 */
function globToMatcher(pattern: string): SessionKeyMatcher {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp(escaped);
  return (key) => re.test(key);
}

// ============================
// SessionFilter
// ============================
// 中文：会话过滤器

/**
 * Unified filter: construct once at plugin startup, then call
 * `shouldSkip(sessionKey)` or `shouldSkipCtx(ctx)` at each gate.
 * 中文：统一的过滤器：在插件启动时构建一次，然后在每个关卡调用`shouldSkip(sessionKey)`或`shouldSkipCtx(ctx)`。
 */
export class SessionFilter {
  private readonly matchers: SessionKeyMatcher[];

  constructor(excludeAgents: string[] = []) {
    // Merge built-in rules + user-configured exclude patterns into one flat list
    // 中文：将内置规则与用户配置的排除模式合并为一个扁平列表
    const userMatchers = excludeAgents
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map(globToMatcher);

    this.matchers = [...BUILTIN_MATCHERS, ...userMatchers];
  }

  /** Should this sessionKey be skipped? */
  /** 中文：此sessionKey是否应被跳过？ */
  shouldSkip(sessionKey: string): boolean {
    return this.matchers.some((m) => m(sessionKey));
  }

  /** Should this hook context be skipped? */
  /** 中文：此挂钩上下文是否应被跳过？ */
  shouldSkipCtx(ctx: AgentHookContext): boolean {
    if (!ctx.sessionKey) return true;
    if (ctx.sessionId?.startsWith("memory-")) return true;
    if (isNonInteractiveTrigger(ctx.trigger, ctx.sessionKey)) return true;
    return this.shouldSkip(ctx.sessionKey);
  }
}
