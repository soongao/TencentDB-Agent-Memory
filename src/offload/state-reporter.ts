/**
 * Plugin state & L3 token consumption reporter.
 *
 * Uploads runtime diagnostics to the backend `/offload/v1/store` endpoint
 * so operators can inspect plugin activity and L3 compression efficiency
 * off-host.
 *
 * The backend keys stored documents by `X-User-Id` (upsert semantics), so
 * every report represents the latest snapshot for that user. We therefore
 * include BOTH:
 *   - `cumulative`: monotonically-increasing counters (total tokens saved,
 *     total tool calls, total L3 triggers) maintained as module-level
 *     globals so they survive across per-trigger reports.
 *   - `recent`: the most recent L3 trigger's detailed accounting
 *     (tokens/msgs before and after) for spot inspection.
 *
 * Four pieces of information are reported on every L3 trigger:
 *   1. Plugin state snapshot (active MMD, pending pairs, L1.5 settled, etc.)
 *   2. L3 token accounting (tokensBefore/After, savings, fixed overhead)
 *   3. Cumulative + recent counters
 *   4. Patch-health signal — only meaningful for `after_tool_call` hook:
 *      the upstream runtime patch is expected to populate `event.messages`
 *      with the current conversation. If `event.messages` is missing/empty
 *      the patch did NOT take effect and L3 cannot operate from this hook.
 *
 * All reporting is fire-and-forget — rejection is logged but never thrown
 * back to the caller so hook execution stays unaffected.
 * 中文：插件状态 & L3令牌消耗报告器。
 * 将运行时诊断上传到后端的 `/offload/v1/store` 接口
 * 以便操作员可以在离机情况下检查插件活动和L3压缩效率。
 * 后端通过 `X-User-Id` 存储文档（插入语义），因此每份报告代表该用户的最新快照。我们因此包括以下两部分：
 * - `累积`: 严格递增的计数器（节省的总令牌、工具调用总数、L3触发次数）作为模块级全局变量维护，以跨每次触发报告生存。
 * - `最近`: 最近一次L3触发的详细核算
 * (触发前后的令牌/消息) 用于现场检查。
 * 每次L3触发报告四条信息：
 * 1. 插件状态快照（活动MMD、待处理对、L1.5结算等）
 * 2. L3令牌核算 (触发前后的令牌，节省量，固定开销)
 * 3. 累积 + 最近计数器
 * 4. 补丁健康信号 — 仅在 `after_tool_call` 挂钩有意义：上游运行时补丁应将当前的 `messages` 数组附加到事件对象中。如果 `event.messages` 缺失或为空，则补丁未生效，L3无法从此挂钩操作。
 * 所有报告都是即发即弃 — 拒绝会被记录但不会返回给调用者，因此挂钩执行不受影响。
 */
import type { BackendClient, StoreStatePayload } from "./backend-client.js";
import type { OffloadStateManager } from "./state-manager.js";
import type { PluginLogger } from "./types.js";
import { nowChinaISO } from "./time-utils.js";

// ─── Fixed overhead constants ────────────────────────────────────────────────
// 中文：─── 固定开销常量 ────────────────────────────────────────────────

/**
 * Fixed L3 "patch overhead" charged per trigger.
 *
 * The context-offload runtime patch injects a small amount of boilerplate
 * (scanner loops, message-mutation wrappers, sentinel fields like
 * `_offloaded` / `_mmdContextMessage`) before the compression routine runs.
 * That boilerplate adds a roughly constant token cost per invocation that
 * is NOT captured by the tiktoken snapshot delta (which only measures
 * compressed vs uncompressed messages).
 *
 * We account for it here with a single fixed constant so cost/benefit
 * tracking on the backend is monotonic. The value is a conservative estimate
 * that can be tuned as the runtime patch evolves.
 * 中文：固定L3 "补丁开销"，每次触发时收取。
 * 上下文卸载运行时补丁在压缩例行程序运行前注入少量样板代码
 * （扫描循环、消息变异包装器、哨兵字段如 `_offloaded` / `_mmdContextMessage`）。
 * 这些样板代码为每次调用添加了大致恒定的令牌成本，
 * 而 tiktoken 摘要增量仅衡量压缩与未压缩的消息之间的差异。
 * 我们在此使用单一固定常量进行核算，以便后端的成本/效益跟踪严格递增。该值是一个保守估计，随着运行时补丁的发展可以调整。
 */
export const L3_FIXED_PATCH_COST_TOKENS = 80;

/** L3 trigger site — matches the three places that invoke L3 compression. */
/** 中文：L3触发点 — 匹配调用L3压缩的三个位置。 */
export type L3TriggerStage = "after_tool_call" | "llm_input" | "assemble";

/**
 * Patch-effectiveness signal derived from the after_tool_call event.
 *
 * The upstream runtime patch is expected to attach the current `messages`
 * array to the event object. When the patch is missing, `event.messages`
 * is undefined and L3 cannot inspect or mutate the conversation.
 * 中文：从 `after_tool_call` 事件推导出的补丁有效性信号。
 * 上游运行时补丁应将当前的 `messages` 数组附加到事件对象中。当补丁缺失时，`event.messages` 未定义且L3无法检查或修改对话。
 */
export type PatchEffective = "effective" | "missing_field" | "empty_messages" | "n/a";

/** Inspects `event.messages` to classify patch health for after_tool_call. */
/** 中文：检查 `event.messages` 以对 `after_tool_call` 的补丁健康状况进行分类。 */
export function classifyPatchEffectiveness(
  event: unknown,
  stage: L3TriggerStage,
): { status: PatchEffective; messagesLen: number } {
  // Only after_tool_call depends on the runtime patch for event.messages.
  // 中文：仅 `after_tool_call` 挂钩依赖于运行时补丁的 `event.messages`。
  if (stage !== "after_tool_call") return { status: "n/a", messagesLen: 0 };
  if (!event || typeof event !== "object") {
    return { status: "missing_field", messagesLen: 0 };
  }
  const msgs = (event as { messages?: unknown }).messages;
  if (!Array.isArray(msgs)) return { status: "missing_field", messagesLen: 0 };
  if (msgs.length === 0) return { status: "empty_messages", messagesLen: 0 };
  return { status: "effective", messagesLen: msgs.length };
}

// ─── Global cumulative counters ──────────────────────────────────────────────
//
// Module-level globals that accumulate over the lifetime of the host
// process. They survive across OpenClaw's repeated `registerOffload()` calls
// (which rebuild hook closures but do not reload the module).
// 中文：─── 全局累积计数器 ──────────────────────────────────────────────
// 主机生命周期内累积的模块级全局变量。它们在 OpenClaw 的重复 `registerOffload()` 调用（这会重建挂钩闭包但不重新加载模块）之间生存。

interface CumulativeCounters {
  /** Total tokens saved by L3 compression (sum of max(0, before-after)). */
  /** 中文：L3压缩节省的总token数（before-after的最大值之和）。 */
  totalTokensSaved: number;
  /** Net savings after subtracting fixed patch cost from each trigger. */
  /** 中文：每个触发器减去固定补丁成本后的净节省。 */
  totalNetTokensSaved: number;
  /** Total number of after_tool_call events observed (incl. heartbeats/skips). */
  /** 中文：观察到的after_tool_call事件总数（包括心跳/跳过）。 */
  totalToolCalls: number;
  /** Total number of L3 trigger reports emitted across all stages. */
  /** 中文：所有阶段发出的L3触发报告总数。 */
  totalL3Triggers: number;
  /** Per-stage L3 trigger counts. */
  /** 中文：每阶段L3触发计数。 */
  totalL3TriggersByStage: Record<L3TriggerStage, number>;
  /** Total messages deleted by aggressive compression. */
  /** 中文：被激进压缩删除的总消息数。 */
  totalAggressiveDeleted: number;
  /** Total messages replaced by mild compression. */
  /** 中文：被温和压缩替换的总消息数。 */
  totalMildReplaced: number;
  /** Total emergency compression triggers. */
  /** 中文：紧急压缩触发的总数。 */
  totalEmergencyTriggered: number;
  /** Total messages deleted by emergency compression. */
  /** 中文：紧急压缩删除的消息总数。 */
  totalEmergencyDeleted: number;
  /** Timestamp when counters started accumulating. */
  /** 中文：计数器开始累积的时间戳。 */
  startedAt: string;
}

const _counters: CumulativeCounters = {
  totalTokensSaved: 0,
  totalNetTokensSaved: 0,
  totalToolCalls: 0,
  totalL3Triggers: 0,
  totalL3TriggersByStage: { after_tool_call: 0, llm_input: 0, assemble: 0 },
  totalAggressiveDeleted: 0,
  totalMildReplaced: 0,
  totalEmergencyTriggered: 0,
  totalEmergencyDeleted: 0,
  startedAt: nowChinaISO(),
};

/**
 * Record a tool-call observation. Called from the `after_tool_call` hook
 * entry regardless of whether L3 compression fires — it counts *all* tool
 * invocations the plugin has seen.
 * 中文：记录一个工具调用观察。无论L3压缩是否触发，此函数都会从`after_tool_call`钩子入口被调用——它统计插件所见过的所有工具调用。
 */
export function recordToolCall(): void {
  _counters.totalToolCalls += 1;
}

/** Returns a shallow copy of the current cumulative counters. */
/** 中文：返回当前累计计数器的一个浅拷贝。 */
export function getCumulativeCounters(): CumulativeCounters {
  return {
    ..._counters,
    totalL3TriggersByStage: { ..._counters.totalL3TriggersByStage },
  };
}

/** Testing hook — wipes counters so unit tests stay isolated. */
/** 中文：测试钩子——清零计数器以使单元测试保持隔离。 */
export function _resetCumulativeCountersForTests(): void {
  _counters.totalTokensSaved = 0;
  _counters.totalNetTokensSaved = 0;
  _counters.totalToolCalls = 0;
  _counters.totalL3Triggers = 0;
  _counters.totalL3TriggersByStage = { after_tool_call: 0, llm_input: 0, assemble: 0 };
  _counters.totalAggressiveDeleted = 0;
  _counters.totalMildReplaced = 0;
  _counters.totalEmergencyTriggered = 0;
  _counters.totalEmergencyDeleted = 0;
  _counters.startedAt = nowChinaISO();
}

// ─── Report payload types ────────────────────────────────────────────────────
// 中文：─── 报告载荷类型 ───────────────────────────────────────────────────────

/** Stable report type tag — one line per reporting category. */
/** 中文：稳定的报告类型标签——每类报告一行。 */
export const REPORT_TYPE_L3 = "offload.l3.trigger" as const;

/** Per-L3-trigger report payload. */
/** 中文：每个L3触发的报告载荷。 */
export interface L3TriggerReport {
  reportType: typeof REPORT_TYPE_L3;
  reportedAt: string;
  sessionKey: string | null;
  stage: L3TriggerStage;
  triggerReason: string;
  pluginState: {
    activeMmdFile: string | null;
    l15Settled: boolean;
    pendingCount: number;
    confirmedOffloadCount: number;
    deletedOffloadCount: number;
  };
  /** Detailed accounting for THIS trigger only. */
  /** 中文：仅对此触发器进行详细核算。 */
  recent: {
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    netTokensSaved: number;
    messagesBefore: number;
    messagesAfter: number;
    messagesRemoved: number;
    durationMs: number;
  };
  /** Threshold context so the report is self-describing. */
  /** 中文：阈值上下文，以便报告具有自描述性。 */
  thresholds: {
    contextWindow: number;
    mildThreshold: number;
    aggressiveThreshold: number;
    fixedPatchCostTokens: number;
    utilisationBeforePct: number;
    utilisationAfterPct: number;
  };
  compression: {
    aboveMild: boolean;
    aboveAggressive: boolean;
    mildReplacedCount: number;
    aggressiveDeletedCount: number;
    emergencyTriggered: boolean;
    emergencyDeletedCount: number;
  };
  /** Process-lifetime cumulative counters (not per-report). */
  /** 中文：进程生命周期累计计数器（而非每份报告）。 */
  cumulative: CumulativeCounters;
  patch: {
    status: PatchEffective;
    messagesLen: number;
  };
}

// ─── Builder & sender ────────────────────────────────────────────────────────
// 中文：── 建造者与发送者 ────────────────────────────────────────────────────────

export interface BuildL3ReportInput {
  stage: L3TriggerStage;
  triggerReason: string;
  stateManager: OffloadStateManager;
  event?: unknown;
  contextWindow: number;
  mildThreshold: number;
  aggressiveThreshold: number;
  tokensBefore: number;
  tokensAfter: number;
  /** Message count before L3 compression ran. */
  /** 中文：L3压缩前的消息计数。 */
  messagesBefore: number;
  /** Message count after L3 compression ran. */
  /** 中文：L3压缩后的消息计数。 */
  messagesAfter: number;
  durationMs: number;
  aboveMild: boolean;
  aboveAggressive: boolean;
  mildReplacedCount?: number;
  aggressiveDeletedCount?: number;
  emergencyTriggered?: boolean;
  emergencyDeletedCount?: number;
}

export function buildL3TriggerReport(input: BuildL3ReportInput): L3TriggerReport {
  const {
    stage,
    triggerReason,
    stateManager,
    event,
    contextWindow,
    mildThreshold,
    aggressiveThreshold,
    tokensBefore,
    tokensAfter,
    messagesBefore,
    messagesAfter,
    durationMs,
    aboveMild,
    aboveAggressive,
    mildReplacedCount = 0,
    aggressiveDeletedCount = 0,
    emergencyTriggered = false,
    emergencyDeletedCount = 0,
  } = input;

  const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
  const netTokensSaved = tokensSaved - L3_FIXED_PATCH_COST_TOKENS;
  const patch = classifyPatchEffectiveness(event, stage);

  // ── Cumulative update (side effect — counters persist across triggers) ──
  // 中文：── 累积更新（副作用 — 计数器在触发器之间持续存在） ──
  _counters.totalTokensSaved += tokensSaved;
  _counters.totalNetTokensSaved += netTokensSaved;
  _counters.totalL3Triggers += 1;
  _counters.totalL3TriggersByStage[stage] =
    (_counters.totalL3TriggersByStage[stage] ?? 0) + 1;
  _counters.totalAggressiveDeleted += aggressiveDeletedCount;
  _counters.totalMildReplaced += mildReplacedCount;
  if (emergencyTriggered) _counters.totalEmergencyTriggered += 1;
  _counters.totalEmergencyDeleted += emergencyDeletedCount;

  // Safe read: stateManager is private-field-heavy, use only public getters.
  // 中文：安全读取：stateManager是私有字段密集型，仅使用公共获取器。
  let activeMmdFile: string | null = null;
  try { activeMmdFile = stateManager.getActiveMmdFile?.() ?? null; } catch { /* ignore */ }
  // 中文：ignore
  let sessionKey: string | null = null;
  try { sessionKey = stateManager.getLastSessionKey?.() ?? null; } catch { /* ignore */ }
  // 中文：ignore
  let pendingCount = 0;
  try { pendingCount = stateManager.getPendingCount?.() ?? 0; } catch { /* ignore */ }
  // 中文：ignore

  return {
    reportType: REPORT_TYPE_L3,
    reportedAt: nowChinaISO(),
    sessionKey,
    stage,
    triggerReason,
    pluginState: {
      activeMmdFile,
      l15Settled: stateManager.l15Settled === true,
      pendingCount,
      confirmedOffloadCount: stateManager.confirmedOffloadIds?.size ?? 0,
      deletedOffloadCount: stateManager.deletedOffloadIds?.size ?? 0,
    },
    recent: {
      tokensBefore,
      tokensAfter,
      tokensSaved,
      netTokensSaved,
      messagesBefore,
      messagesAfter,
      messagesRemoved: Math.max(0, messagesBefore - messagesAfter),
      durationMs,
    },
    thresholds: {
      contextWindow,
      mildThreshold,
      aggressiveThreshold,
      fixedPatchCostTokens: L3_FIXED_PATCH_COST_TOKENS,
      utilisationBeforePct: contextWindow > 0 ? +((tokensBefore / contextWindow) * 100).toFixed(2) : 0,
      utilisationAfterPct: contextWindow > 0 ? +((tokensAfter / contextWindow) * 100).toFixed(2) : 0,
    },
    compression: {
      aboveMild,
      aboveAggressive,
      mildReplacedCount,
      aggressiveDeletedCount,
      emergencyTriggered,
      emergencyDeletedCount,
    },
    cumulative: getCumulativeCounters(),
    patch,
  };
}

/**
 * Fire-and-forget upload of an L3 report to the backend store endpoint.
 * Must never throw — rejection is logged at warn level only.
 * 中文：火速上传L3报告至后端存储端点。
 * 绝不能抛出错误——拒绝仅在警告级别记录
 */
export function reportL3Trigger(
  backendClient: BackendClient | null,
  report: L3TriggerReport,
  logger: PluginLogger,
): void {
  if (!backendClient) return;
  try {
    backendClient
      .storeState(report as unknown as StoreStatePayload)
      .then(() => {
        logger.debug?.(
          `[context-offload] state-report OK: stage=${report.stage} reason=${report.triggerReason} ` +
          `recentSaved=${report.recent.tokensSaved} cumSaved=${report.cumulative.totalTokensSaved} ` +
          `toolCalls=${report.cumulative.totalToolCalls} patch=${report.patch.status}`,
        );
      })
      .catch((err) => {
        logger.warn(`[context-offload] state-report FAILED: stage=${report.stage} — ${err}`);
      });
  } catch (err) {
    logger.warn(`[context-offload] state-report schedule FAILED: ${err}`);
  }
}
