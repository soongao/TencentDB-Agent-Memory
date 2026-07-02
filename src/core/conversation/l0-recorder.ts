/**
 * L0 Conversation Recorder: records raw conversation messages to local JSONL files.
 *
 * Triggered from agent_end hook. Receives the conversation messages directly from
 * the hook context (no file I/O needed), sanitizes them, filters out noise, and
 * writes to ~/.openclaw/memory-tdai/conversations/YYYY-MM-DD.jsonl
 *
 * Design decisions:
 * - Uses JSONL format (**one message per line** — flat, easy to grep/stream)
 * - One file per day (all sessions merged into the same daily file)
 * - sessionKey is stored as a field in each JSONL line, not in the filename
 * - Independent from system session files — format fully controlled by plugin
 * - Messages are sanitized to remove injected tags (prevent feedback loops)
 * - Short/long/command messages are filtered out
 * 中文：L0对话记录器: 将原始对话消息记录到本地JSONL文件。
 * 触发于agent_end钩子。直接从钩子上下文接收对话消息（无需进行文件I/O操作），对其进行清理，过滤掉噪音，并写入~/.openclaw/memory-tdai/conversations/YYYY-MM-DD.jsonl
 * 设计决策:
 * - 使用JSONL格式（**一行一条消息** — 平铺，易于grep/stream处理）
 * - 每天一个文件（所有会话合并到同一个日文件中）
 * - 会话键存储在每行的JSONL字段中，不在文件名中
 * - 独立于系统会话文件 — 格式完全由插件控制
 * - 消息被清理以移除注入标签（防止反馈循环）
 * - 过滤掉短消息/长消息/命令消息
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sanitizeText, stripCodeBlocks, shouldCaptureL0 } from "../../utils/sanitize.js";
import type { Logger } from "../types.js";
import { formatLocalDate } from "../../utils/time.js";

// ============================
// Types
// ============================

export interface ConversationMessage {
  /** Unique message ID (used by L1 prompt for source_message_ids tracking) */
  /** 中文：唯一的消息ID（用于L1提示跟踪source_message_ids） */
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number; // epoch ms
  // 中文：毫秒 epoch
}

/**
 * Generate a short unique message ID.
 * 中文：生成一个短且唯一的消息ID。
 */
function generateMessageId(): string {
  return `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * New flat format: one message per JSONL line.
 * 中文：新的扁平格式：每条消息占一行JSONL。
 */
export interface L0MessageRecord {
  sessionKey: string;
  sessionId: string;
  recordedAt: string; // ISO timestamp
  // 中文：ISO 时间戳
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number; // epoch ms
  // 中文：毫秒 epoch
}

/**
 * A group of conversation messages (used by downstream consumers).
 * Each L0ConversationRecord represents one or more messages from the same recording event.
 * 中文：一组对话消息（供下游消费者使用）。
 * 每个L0ConversationRecord代表同一录制事件中的一条或多条消息。
 */
export interface L0ConversationRecord {
  sessionKey: string;
  sessionId: string;
  recordedAt: string; // ISO timestamp
  // 中文：ISO 时间戳
  messageCount: number;
  messages: ConversationMessage[];
}

const TAG = "[memory-tdai][l0]";

// ============================
// Core function
// ============================
// 中文：核心功能

/**
 * Record a conversation round to the L0 JSONL file.
 *
 * Only records **incremental** messages (new since the last capture).
 * Uses `afterTimestamp` as the primary filter to skip already-captured history.
 *
 * @param sessionKey - The session key for this conversation
 * @param rawMessages - Raw messages from the agent_end hook context (full session history)
 * @param baseDir - Base data directory (~/.openclaw/memory-tdai/)
 * @param logger - Optional logger
 * @param originalUserText - Clean original user prompt (pre-prependContext)
 * @param afterTimestamp - Epoch ms cursor: only messages with timestamp > this are new.
 *                         Pass 0 or omit for the first capture of a session.
 * @returns Filtered messages (for L1 to use directly), or empty array if nothing worth recording
 * 中文：将对话轮次记录到L0 JSONL文件。
 * 仅记录**增量**消息（自上次捕获以来的新消息）。
 * 使用`afterTimestamp`作为主要过滤器以跳过已捕获的历史。
 * @param sessionKey - 本次对话的会话键
 * @param rawMessages - 来自agent_end钩子上下文的原始消息（完整会话历史记录）
 * @param baseDir - 基础数据目录 (~/.openclaw/memory-tdai/)
 * @param logger - 可选日志器
 * @param originalUserText - 清理后的原始用户提示（pre-prependContext）
 * @param afterTimestamp - 以毫秒为单位的时间戳游标：只有时间戳大于此值的消息是新的。
 * 首次捕获会话时传递0或省略。
 * @returns 被清理的消息（供L1直接使用），或者如果没有任何值得记录则返回空数组
 */
export async function recordConversation(params: {
  sessionKey: string;
  sessionId?: string;
  rawMessages: unknown[];
  baseDir: string;
  logger?: Logger;
  /** Clean original user prompt (pre-prependContext) */
  /** 中文：清理后的原始用户提示（pre-prependContext） */
  originalUserText?: string;
  /** Epoch ms cursor: only process messages with timestamp strictly greater than this. */
  /** 中文：Epoch ms光标：仅处理时间戳严格大于此值的消息。 */
  afterTimestamp?: number;
  /**
   * Number of messages in the session at before_prompt_build time.
   * Used to locate the exact user message that originalUserText corresponds to:
   * rawMessages[originalUserMessageCount] is the user message appended by the framework
   * AFTER before_prompt_build, i.e. the one whose content was polluted by prependContext.
   * 中文：会话中在before_prompt_build时刻的消息数量。
   * 用于定位originalUserText对应的精确用户消息：
   * rawMessages[originalUserMessageCount]是框架在before_prompt_build之后附加的用户消息，即其内容被prependContext污染了。
   */
  originalUserMessageCount?: number;
}): Promise<ConversationMessage[]> {
  const { sessionKey, sessionId, rawMessages, baseDir, logger, originalUserText, afterTimestamp, originalUserMessageCount } = params;

  // Step 1: Position slice + extract user/assistant messages.
  //
  // Dual protection against duplicate capture:
  //   Layer 1 (position slice): Use originalUserMessageCount (cached at before_prompt_build)
  //     to slice rawMessages — only keep messages added AFTER the prompt build, i.e. this
  //     turn's new messages. This is immune to timestamp drift after gateway restarts.
  //   Layer 2 (timestamp cursor): The existing afterTimestamp filter below acts as a fallback
  //     when the position slice is unavailable (cache expired, process restart, etc.).
  // 中文：步骤1：位置切片+提取用户/助手消息。
  // 双重保护防止重复捕获：
  // 第一层（位置切片）：使用before_prompt_build时缓存的originalUserMessageCount
  // 从rawMessages中切片——仅保留prompt构建之后添加的消息，即本回合的新消息。这在网关重启后的时间戳漂移情况下免疫。
  // 第二层（时间戳光标）：现有的afterTimestamp过滤器作为位置切片不可用（缓存过期、进程重启等）时的备用方案。
  const usePositionSlice = originalUserMessageCount != null && originalUserMessageCount > 0
    && originalUserMessageCount <= rawMessages.length;
  const slicedMessages = usePositionSlice
    ? rawMessages.slice(originalUserMessageCount)
    : rawMessages;

  const allExtracted = extractUserAssistantMessages(slicedMessages);

  if (usePositionSlice) {
    logger?.debug?.(
      `${TAG} Position slice: ${rawMessages.length} raw → ${slicedMessages.length} new (sliceStart=${originalUserMessageCount})`,
    );
  }

  // Diagnostic: check whether the framework actually provides timestamp on raw messages.
  // If all raw timestamps are missing, the timestamp cursor is effectively useless and
  // position slice becomes the sole incremental mechanism.
  // 中文：诊断：检查框架是否实际提供了raw消息的时间戳。
  // 如果所有原始时间戳都缺失，时间戳光标实际上无用且
  // 位置切片成为唯一的增量机制。
  if (slicedMessages.length > 0) {
    const firstRaw = slicedMessages[0] as Record<string, unknown> | undefined;
    const rawTs = firstRaw?.timestamp;
    const hasRawTs = typeof rawTs === "number";
    logger?.debug?.(
      `${TAG} Raw message[0] timestamp probe: ${hasRawTs ? `present (${rawTs})` : `missing (type=${typeof rawTs}, value=${String(rawTs)})`}`,
    );
  }

  logger?.debug?.(`${TAG} Extracted ${allExtracted.length} user/assistant messages from ${slicedMessages.length} total`);

  // Step 1.5: Incremental filter — only keep messages newer than the cursor.
  //
  // Uses strict greater-than (>) which is safe because:
  //   - The cursor is set to max(timestamps) of the LAST recorded batch.
  //   - The next agent turn's messages will have timestamps strictly greater than
  //     the previous turn (there's at least one LLM API call between turns, which
  //     takes hundreds of milliseconds minimum — no same-millisecond collision).
  //   - All messages within a single turn are captured together as one batch,
  //     so even if multiple messages share the same timestamp, they are either
  //     all included (new batch) or all excluded (already captured).
  //   - If a message lacks a timestamp field, extractUserAssistantMessages()
  //     assigns Date.now() at extraction time, which is always > previous cursor.
  // 中文：步骤1.5：增量过滤器——仅保留比光标新近的消息。
  // 使用严格大于（>）操作符是安全的因为：
  // - 光标设置为上次记录批次的最大时间戳。
  // - 下一个代理回合的消息将具有严格大于
  // 上一回合的时间戳（至少有一次LLM API调用，需要数百毫秒——没有同秒碰撞）。
  // - 单个回合内的所有消息被同时捕获作为一个批次，
  // 所以即使多个消息共享相同的时间戳，它们要么全部包含（新批次）要么全部排除（已捕获）。
  // - 如果消息缺少时间戳字段，在提取时extractUserAssistantMessages()会分配Date.now()，这总是大于先前的光标。
  const cursor = afterTimestamp ?? 0;
  const extracted = cursor !== 0
    ? allExtracted.filter((m) => m.timestamp > cursor)
    : allExtracted;

  if (extracted.length > 0) {
    const first = extracted[0];
    logger?.debug?.(
      `${TAG} First captured message: role=${first.role}, ts=${first.timestamp}, ` +
      `date=${new Date(first.timestamp).toISOString()}, content=${first.content.slice(0, 80)}${first.content.length > 80 ? "…" : ""}`,
    );
  }

  if (cursor > 0) {
    logger?.debug?.(
      `${TAG} Incremental filter: ${allExtracted.length} total → ${extracted.length} new (cursor=${cursor})`,
    );

    // Safety valve: if timestamp filter passed everything through and position slice
    // was not available, this likely indicates timestamp drift after a gateway restart.
    // 中文：安全阀：如果时间戳过滤器通过了所有内容且位置切片不可用，这很可能表明网关重启后的时间戳漂移。
    if (!usePositionSlice && extracted.length === allExtracted.length && allExtracted.length > 8) {
      logger?.warn?.(
        `${TAG} ⚠ Safety valve: all ${allExtracted.length} messages passed timestamp filter (cursor=${cursor}) — ` +
        `possible timestamp drift after gateway restart. Position slice was not available (no cached messageCount).`,
      );
    }
  }

  if (extracted.length === 0) {
    logger?.debug?.(`${TAG} No new user/assistant messages to record`);
    return [];
  }

  // Step 2: Replace polluted user messages with cached original prompt.
  //
  // Background:
  //   The framework appends the user's message to the session after before_prompt_build,
  //   then injects prependContext into it. So the user message in rawMessages is polluted.
  //   We cached the clean prompt (originalUserText) and the message count at
  //   before_prompt_build time (originalUserMessageCount) to identify which raw message
  //   is the real user input.
  //
  // Strategy:
  //   When position slice is active, the polluted user message is slicedMessages[0].
  //   Otherwise, fall back to rawMessages[originalUserMessageCount].
  //   In both cases, find the timestamp and match it in `extracted` for replacement.
  //   If matching fails, skip replacement — sanitizeText() in Step 3 is the safety net.
  // 中文：步骤2：用缓存的原始提示替换被污染的用户消息。
  // 背景：
  // 框架在before_prompt_build之后将用户的消息附加到会话中，然后注入prependContext。因此rawMessages中的用户消息被污染了。
  // 我们缓存了干净的提示（originalUserText）和在before_prompt_build时刻的消息计数（originalUserMessageCount），以识别哪个原始消息是真正的用户输入。
  // 策略：
  // 当位置切片有效时，被污染的用户消息为slicedMessages[0]。否则，回退到rawMessages[originalUserMessageCount]。
  // 无论哪种情况，在`extracted`中找到时间戳并进行替换。
  // 如果匹配失败，则跳过替换——Step 3中的sanitizeText()是安全网。
  if (originalUserText) {
    // Determine the target raw message that contains the polluted user prompt
    // 中文：确定包含被污染用户提示的目标原始消息
    const targetRaw: Record<string, unknown> | undefined = usePositionSlice
      ? slicedMessages[0] as Record<string, unknown> | undefined
      : (originalUserMessageCount != null && originalUserMessageCount >= 0 && originalUserMessageCount < rawMessages.length)
        ? rawMessages[originalUserMessageCount] as Record<string, unknown> | undefined
        : undefined;

    const targetTs = targetRaw && typeof targetRaw.timestamp === "number" ? targetRaw.timestamp : undefined;

    if (targetTs != null) {
      let replaced = false;
      for (let i = 0; i < extracted.length; i++) {
        if (extracted[i].role === "user" && extracted[i].timestamp === targetTs) {
          logger?.debug?.(
            `${TAG} Replacing user message at timestamp=${targetTs} with cached original prompt ` +
            `(${originalUserText.length} chars, was ${extracted[i].content.length} chars) [positionSlice=${usePositionSlice}]`,
          );
          extracted[i] = { ...extracted[i], content: originalUserText };
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        logger?.warn?.(
          `${TAG} Target user message (ts=${targetTs}) not found in extracted batch — ` +
          `possibly filtered by cursor. Skipping replacement, will rely on sanitizeText().`,
        );
      }
    } else if (targetRaw) {
      logger?.warn?.(
        `${TAG} Target raw message has no valid timestamp — ` +
        `skipping replacement, will rely on sanitizeText().`,
      );
    } else {
      logger?.warn?.(
        `${TAG} Have originalUserText but cannot locate target raw message — ` +
        `skipping replacement, will rely on sanitizeText().`,
      );
    }
  }

  // Step 3: Sanitize and filter
  // 中文：步骤3：清理和过滤
  const filtered = extracted
    .map((m) => {
      let content = sanitizeText(m.content);
      // Strip fenced code blocks from assistant replies to reduce embedding noise
      // 中文：从助手回复中移除围栏代码块以减少嵌入噪声
      if (m.role === "assistant") {
        content = stripCodeBlocks(content);
      }
      return { id: m.id, role: m.role, content, timestamp: m.timestamp };
    })
    .filter((m) => shouldCaptureL0(m.content));

  logger?.debug?.(`${TAG} After sanitize+filter: ${filtered.length} messages (from ${extracted.length})`);

  if (filtered.length === 0) {
    logger?.debug?.(`${TAG} All messages filtered out, skipping L0 write`);
    return [];
  }

  // Step 4: Write to JSONL file — one message per line (flat format)
  // 中文：步骤4：写入JSONL文件——每条消息一行（扁平格式）
  const now = new Date().toISOString();
  const lines: string[] = [];
  for (const msg of filtered) {
    const record: L0MessageRecord = {
      sessionKey,
      sessionId: sessionId || "",
      recordedAt: now,
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
    };
    lines.push(JSON.stringify(record));
  }

  const shardDate = formatLocalDate(new Date());
  const outDir = path.join(baseDir, "conversations");
  const outPath = path.join(outDir, `${shardDate}.jsonl`);

  try {
    await fs.mkdir(outDir, { recursive: true });
    // Append each message as its own JSONL line
    // 中文：将每条消息单独作为JSONL行追加
    await fs.appendFile(outPath, lines.join("\n") + "\n", "utf-8");
    logger?.debug?.(`${TAG} Recorded ${filtered.length} messages to ${outPath}`);
  } catch (err) {
    logger?.error(`${TAG} Failed to write L0 file: ${err instanceof Error ? err.message : String(err)}`);
    // Return filtered messages anyway so L1 can still process them
    // 中文：即使清理后仍返回这些消息以便L1可以继续处理
  }

  return filtered;
}

/**
 * Read all L0 conversation records for a session.
 * Returns records in chronological order.
 *
 * File format: `YYYY-MM-DD.jsonl` (daily files, all sessions merged).
 * Each line is an L0MessageRecord; filtered by sessionKey at line level.
 * 中文：读取会话的所有L0对话记录。
 * 按时间顺序返回记录。
 * 文件格式：`YYYY-MM-DD.jsonl`（每日文件，所有会话合并）。
 * 每行是一个L0MessageRecord；在行级别通过sessionKey过滤。
 */
export async function readConversationRecords(
  sessionKey: string,
  baseDir: string,
  logger?: Logger,
): Promise<L0ConversationRecord[]> {
  const conversationsDir = path.join(baseDir, "conversations");

  // Daily file pattern: YYYY-MM-DD.jsonl
  // 中文：每日文件模式：YYYY-MM-DD.jsonl
  const dateFilePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

  let entries: string[];
  try {
    const dirEntries = await fs.readdir(conversationsDir, { withFileTypes: true });
    entries = dirEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    // Directory doesn't exist yet — normal for first conversation
    // 中文：目录尚不存在——对于首次对话是正常的
    return [];
  }

  const targetFiles = entries
    .filter((name) => dateFilePattern.test(name))
    .sort();

  if (targetFiles.length === 0) {
    return [];
  }

  const records: L0ConversationRecord[] = [];

  for (const fileName of targetFiles) {
    const filePath = path.join(conversationsDir, fileName);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      logger?.warn?.(`${TAG} Failed to read L0 file: ${filePath}`);
      continue;
    }

    const lines = raw.split("\n").filter((line: string) => line.trim());
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;

        // Filter by sessionKey at line level
        // 中文：按行过滤 sessionKey
        const lineSessionKey = parsed.sessionKey as string | undefined;
        if (lineSessionKey !== sessionKey) continue;

        if (typeof parsed.role === "string" && typeof parsed.content === "string") {
          // Flat format: { sessionKey, sessionId, recordedAt, id, role, content, timestamp }
          // Wrap into L0ConversationRecord for uniform downstream consumption
          // 中文：扁平格式: { sessionKey, sessionId, recordedAt, id, role, content, timestamp }
          // 封装为 L0ConversationRecord 以统一下游消费
          const msg: ConversationMessage = {
            id: (typeof parsed.id === "string" && parsed.id) ? parsed.id : generateMessageId(),
            role: parsed.role as "user" | "assistant",
            content: parsed.content as string,
            timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
          };
          records.push({
            sessionKey: (parsed.sessionKey as string) || sessionKey,
            sessionId: (parsed.sessionId as string) || "",
            recordedAt: (parsed.recordedAt as string) || new Date().toISOString(),
            messageCount: 1,
            messages: [msg],
          });
        } else {
          logger?.warn?.(`${TAG} Unrecognized JSONL line format in ${filePath}:${i + 1}`);
        }
      } catch {
        logger?.warn?.(`${TAG} Skipping malformed JSONL line in ${filePath}:${i + 1}`);
      }
    }
  }

  records.sort((a, b) => {
    const ta = Date.parse(a.recordedAt);
    const tb = Date.parse(b.recordedAt);
    const na = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
    const nb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
    return na - nb;
  });

  return records;
}

/**
 * Read L0 messages across all conversation records for a session,
 * optionally filtered by a cursor timestamp (messages after the cursor).
 *
 * When `limit` is provided, only the **newest** `limit` messages are returned
 * (matching the DB path's `ORDER BY timestamp DESC LIMIT ?` behavior).
 * Returned messages are always in chronological order (oldest → newest).
 *
 * NOTE: potential optimization — records are chronologically ordered (append-only JSONL),
 * so a reverse scan could skip entire old records. Deferred for now; see Issue 5 in
 * docs/05-known-issues.md.
 * 中文：读取会话记录中该会话的所有 L0 消息,
 * 可选地通过游标时间戳过滤 (游标之后的消息).
 * 当提供 `limit` 时，仅返回最新的 `limit` 条消息
 * (匹配 DB 路径的 `ORDER BY timestamp DESC LIMIT ?` 行为).
 * 返回的消息始终按时间顺序排列（最早 → 最新）.
 * 注意: 可能的优化 — 记录按时间顺序排序 (追加只读 JSONL)，
 * 因此反向扫描可以跳过整个旧记录. 但暂不实施；参见 docs/05-known-issues.md 中的问题 5.
 */
export async function readConversationMessages(
  sessionKey: string,
  baseDir: string,
  afterTimestamp?: number,
  logger?: Logger,
  limit?: number,
): Promise<ConversationMessage[]> {
  const records = await readConversationRecords(sessionKey, baseDir, logger);
  const allMessages: ConversationMessage[] = [];

  for (const record of records) {
    for (const msg of record.messages) {
      if (afterTimestamp && msg.timestamp <= afterTimestamp) continue;
      allMessages.push(msg);
    }
  }

  // Truncate to newest `limit` messages (keep tail, since array is chronological)
  // 中文：截断为最新的 `limit` 条消息（保留尾部，因为数组是按时间顺序排列的）
  if (limit != null && limit > 0 && allMessages.length > limit) {
    logger?.debug?.(
      `${TAG} readConversationMessages: truncating ${allMessages.length} → ${limit} (newest)`,
    );
    return allMessages.slice(-limit);
  }

  return allMessages;
}

/**
 * A group of conversation messages sharing the same sessionId.
 * 中文：具有相同 sessionId 的一组会话消息.
 */
export interface SessionIdMessageGroup {
  sessionId: string;
  messages: Array<ConversationMessage & { recordedAtMs: number }>;
}

/**
 * Read L0 messages for a session, grouped by sessionId.
 *
 * Within the same sessionKey, different sessionIds represent different conversation
 * instances (e.g. after /reset). L1 extraction should process each group independently
 * so that each group's sessionId is correctly associated with its extracted memories.
 *
 * When `limit` is provided, only the **newest** `limit` messages (across all groups)
 * are retained — matching the DB path's `ORDER BY recorded_at DESC LIMIT ?` behavior.
 * Groups that become empty after truncation are dropped.
 *
 * Groups are returned in chronological order (by earliest message timestamp).
 * Messages within each group are also in chronological order.
 *
 * @param afterRecordedAtMs - Epoch ms cursor: only messages with recordedAt > this are included.
 * 中文：读取会话的所有 L0 消息，并按 sessionId 分组.
 * 在同一 sessionKey 下，不同的 sessionIds 代表不同的会话实例 (例如 /reset). L1 提取应独立处理每个分组
 * 以确保每个分组的 sessionId 正确关联其提取的记忆.
 * 当提供 `limit` 时，仅保留最新的 `limit` 条消息（跨所有分组）
 * (匹配 DB 路径的 `ORDER BY recorded_at DESC LIMIT ?` 行为).
 * 被截断后为空的分组将被丢弃.
 * 按最早消息时间戳返回分组.
 * 每个分组内的消息也按时间顺序排列.
 * @afterRecordedAtMs - 仅包含 recordedAt > 此值的消息（毫秒级时间戳游标）
 */
export async function readConversationMessagesGroupedBySessionId(
  sessionKey: string,
  baseDir: string,
  afterRecordedAtMs?: number,
  logger?: Logger,
  limit?: number,
): Promise<SessionIdMessageGroup[]> {
  const records = await readConversationRecords(sessionKey, baseDir, logger);

  // Collect all messages with their sessionId, filtering by recorded_at cursor
  // 中文：收集所有带有 sessionId 的消息，并通过 recorded_at 游标过滤
  const allMessages: Array<{ sessionId: string; msg: ConversationMessage & { recordedAtMs: number } }> = [];

  for (const record of records) {
    const sid = record.sessionId || "";
    const recMs = Date.parse(record.recordedAt) || 0;
    if (afterRecordedAtMs && recMs <= afterRecordedAtMs) continue;
    for (const msg of record.messages) {
      allMessages.push({ sessionId: sid, msg: { ...msg, recordedAtMs: recMs } });
    }
  }

  // Sort by timestamp ASC (chronological) — records are already roughly ordered
  // by recordedAt, but messages within may not be perfectly sorted by timestamp.
  // 中文：按 timestamp 升序排序 (时间顺序) — 记录已大致按 recordedAt 排序，但消息内部可能未完全按 timestamp 排序.
  allMessages.sort((a, b) => a.msg.timestamp - b.msg.timestamp);

  // Truncate to newest `limit` messages (keep tail)
  // 中文：最新 `limit` 条消息（保留尾部）
  let selected = allMessages;
  if (limit != null && limit > 0 && allMessages.length > limit) {
    logger?.debug?.(
      `${TAG} readConversationMessagesGroupedBySessionId: truncating ${allMessages.length} → ${limit} (newest)`,
    );
    selected = allMessages.slice(-limit);
  }

  // Re-group by sessionId
  // 中文：按 sessionId 重新分组
  const groupMap = new Map<string, Array<ConversationMessage & { recordedAtMs: number }>>();
  for (const { sessionId, msg } of selected) {
    let group = groupMap.get(sessionId);
    if (!group) {
      group = [];
      groupMap.set(sessionId, group);
    }
    group.push(msg);
  }

  // Convert to array, sorted by earliest message timestamp in each group
  // 中文：转换为数组，并按每个分组中最早的消息时间戳排序
  const groups: SessionIdMessageGroup[] = [];
  for (const [sessionId, messages] of groupMap) {
    if (messages.length > 0) {
      groups.push({ sessionId, messages });
    }
  }
  groups.sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);

  return groups;
}

// ============================
// Helpers
// ============================
// 中文：辅助函数

/**
 * Extract user and assistant messages from raw hook message array.
 * 中文：从原始 hook 消息数组中提取用户和助手消息.
 */
function extractUserAssistantMessages(messages: unknown[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string | undefined;

    if (role !== "user" && role !== "assistant") continue;

    let content: string | undefined;
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      const textParts: string[] = [];
      for (const part of m.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as Record<string, unknown>).type === "text"
        ) {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === "string") textParts.push(text);
        }
      }
      content = textParts.join("\n");
    }

    // Strip inline base64 image data URIs that some providers embed in string content.
    // These are not useful for memory and would pollute FTS / embedding indexes.
    // 中文：移除嵌入在字符串内容中的 inline base64 图像数据 URI，这些对于内存无用且会污染 FTS / 嵌入索引。
    if (content && /data:image\/[a-z+]+;base64,/i.test(content)) {
      content = content.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, "[image]");
    }

    if (content && content.trim()) {
      const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
      result.push({
        id: (typeof m.id === "string" && m.id) ? m.id : generateMessageId(),
        role: role as "user" | "assistant",
        content: content.trim(),
        timestamp: ts,
      });
    }
  }

  return result;
}


