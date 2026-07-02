/**
 * Input loading, validation, normalization, and timestamp handling for the `seed` command.
 *
 * Responsibilities:
 * 1. Load raw JSON from file
 * 2. Detect Format A (`{ sessions: [...] }`) vs Format B (`[...]`)
 * 3. Six-layer validation (file → top-level → session → round → message → timestamp consistency)
 * 4. Normalize into NormalizedInput with auto-generated sessionIds
 * 5. Timestamp all-or-none check + fill strategy
 * 中文：输入加载、验证、规范化以及`seed`命令的时间戳处理。
 * 职责：
 * 1. 从文件中加载原始JSON
 * 2. 检测格式A（`{ sessions: [...] }`） vs 格式B（`[...]`）
 * 3. 六层验证（文件 → 高级别 → 会话 → 轮次 → 消息 → 时间戳一致性检查）
 * 4. 归一化为NormalizedInput，自动生成sessionId
 * 5. 时间戳全或无校验 + 填充策略
 */

import fs from "node:fs";
import crypto from "node:crypto";
import type {
  RawSession,
  FormatA,
  ValidationError,
  NormalizedInput,
  NormalizedSession,
  NormalizedRound,
  NormalizedMessage,
  SeedCommandOptions,
} from "./types.js";

// ============================
// Public API
// ============================
// 中文：Public API

export interface LoadAndValidateResult {
  /** Normalized input ready for pipeline consumption. */
  /** 中文：归一化的输入已准备好供管道消费。 */
  input: NormalizedInput;
  /** Whether the user needs to confirm timestamp auto-fill. */
  /** 中文：用户是否需要确认时间戳自动填充。 */
  needsTimestampConfirmation: boolean;
}

/**
 * Load, validate, and normalize seed input from a file.
 *
 * Throws on fatal validation errors with a human-readable message
 * that includes all collected errors.
 * 中文：从文件加载、验证和规范化种子输入。
 * 在致命验证错误时抛出异常，并附带包含所有收集错误的人类可读消息
 */
export function loadAndValidateInput(
  opts: Pick<SeedCommandOptions, "input" | "sessionKey" | "strictRoundRole">,
): LoadAndValidateResult {
  // Layer 1: File — read + parse
  // 中文：层级1：文件 — 读取 + 解析
  const raw = loadRawInput(opts.input);

  // Layer 2: Top-level — detect A vs B
  // 中文：层级2：高级别 — 检测A vs B
  const sessions = extractSessions(raw);

  // Layers 3-5: session / round / message validation
  // 中文：层级3-5：会话 / 轮次 / 消息验证
  const errors: ValidationError[] = [];
  validateSessions(sessions, opts.strictRoundRole, errors);

  if (errors.length > 0) {
    throw new SeedValidationError(errors);
  }

  // Layer 6: Timestamp consistency (all-have / all-missing / mixed → error)
  // 中文：层6：时间戳一致性（全部存在/全部缺失/混合 → 错误）
  const tsResult = checkTimestampConsistency(sessions);
  if (tsResult.status === "mixed") {
    throw new SeedValidationError([{
      stage: "timestamp_consistency",
      message:
        "Timestamp consistency check failed: some messages have timestamps while others do not. " +
        "All messages must either have timestamps or none must have timestamps.",
    }]);
  }

  // Normalize
  // 中文：归一化
  const normalized = normalizeSessions(sessions, opts.sessionKey);

  return {
    input: {
      sessions: normalized.sessions,
      totalRounds: normalized.totalRounds,
      totalMessages: normalized.totalMessages,
      hasTimestamps: tsResult.status === "all_present",
    },
    needsTimestampConfirmation: tsResult.status === "all_missing",
  };
}

/**
 * Validate and normalize seed input from an already-parsed JSON object.
 *
 * This is the gateway-friendly variant of `loadAndValidateInput` — it skips
 * the file-system layer (Layer 1) and accepts the raw parsed body directly.
 * Timestamps missing from all messages are auto-filled (no interactive
 * confirmation needed in HTTP context).
 *
 * Throws `SeedValidationError` on validation failures.
 * 中文：验证并归一化已解析的JSON对象作为种子输入。
 * 这是`loadAndValidateInput`的友好入口版本——跳过了文件系统层（第1层），直接接受原始解析体。
 * 所有消息中缺少的时间戳将自动填充（无需HTTP上下文中的交互确认）。
 * 在验证失败时抛出`SeedValidationError`。
 */
export function validateAndNormalizeRaw(
  raw: unknown,
  opts?: { sessionKey?: string; strictRoundRole?: boolean; autoFillTimestamps?: boolean },
): NormalizedInput {
  const strictRoundRole = opts?.strictRoundRole ?? false;
  const autoFillTimestamps = opts?.autoFillTimestamps ?? true;

  // Layer 2: Top-level — detect A vs B
  // 中文：层2：顶级 — 检测A vs B
  const sessions = extractSessions(raw);

  // Layers 3-5: session / round / message validation
  // 中文：层3-5：会话/轮次/消息验证
  const errors: ValidationError[] = [];
  validateSessions(sessions, strictRoundRole, errors);

  if (errors.length > 0) {
    throw new SeedValidationError(errors);
  }

  // Layer 6: Timestamp consistency
  // 中文：层6：时间戳一致性
  const tsResult = checkTimestampConsistency(sessions);
  if (tsResult.status === "mixed") {
    throw new SeedValidationError([{
      stage: "timestamp_consistency",
      message:
        "Timestamp consistency check failed: some messages have timestamps while others do not. " +
        "All messages must either have timestamps or none must have timestamps.",
    }]);
  }

  // Normalize
  // 中文：归一化
  const normalized = normalizeSessions(sessions, opts?.sessionKey);

  const input: NormalizedInput = {
    sessions: normalized.sessions,
    totalRounds: normalized.totalRounds,
    totalMessages: normalized.totalMessages,
    hasTimestamps: tsResult.status === "all_present",
  };

  // Auto-fill timestamps in HTTP context (no interactive prompt)
  // 中文：在HTTP上下文中自动填充时间戳（无需交互提示）
  if (tsResult.status === "all_missing" && autoFillTimestamps) {
    fillTimestamps(input);
  }

  return input;
}

/**
 * Fill timestamps for all messages when the input has no timestamps.
 *
 * Uses a single monotonically increasing counter across ALL sessions
 * to guarantee global timestamp ordering. This is critical when multiple
 * sessions share the same sessionKey — the L0 capture cursor (advanced
 * per-session) would filter out later sessions whose timestamps fall
 * below the cursor if ordering were not globally monotonic.
 * 中文：为输入没有时间戳的所有消息填充时间戳。
 * 使用单个单调递增的计数器跨所有会话
 * 保证全局时间戳顺序。这对于多个会话共享同一sessionKey时至关重要——L0捕获光标（按会话独立推进）将过滤掉时间戳低于光标的后续会话，如果时间戳顺序不是全局单调递增，则会导致错误。
 */
export function fillTimestamps(input: NormalizedInput): void {
  let currentTs = Date.now();
  for (const session of input.sessions) {
    for (const round of session.rounds) {
      for (let i = 0; i < round.messages.length; i++) {
        // Small offset per message to maintain strict ordering
        // 中文：为每个消息维护严格的时间顺序偏移量
        round.messages[i]!.timestamp = currentTs;
        currentTs += 100;
      }
    }
  }
  input.hasTimestamps = true;
}

// ============================
// Validation error class
// ============================
// 中文：验证错误类

export class SeedValidationError extends Error {
  public readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    const summary = errors.map((e) => formatValidationError(e)).join("\n");
    super(`Seed input validation failed (${errors.length} error(s)):\n${summary}`);
    this.name = "SeedValidationError";
    this.errors = errors;
  }
}

function formatValidationError(e: ValidationError): string {
  const parts: string[] = [`  [${e.stage}]`];
  if (e.sourceIndex != null) parts.push(`session[${e.sourceIndex}]`);
  if (e.sessionKey) parts.push(`key="${e.sessionKey}"`);
  if (e.roundIndex != null) parts.push(`round[${e.roundIndex}]`);
  if (e.messageIndex != null) parts.push(`msg[${e.messageIndex}]`);
  parts.push(e.message);
  return parts.join(" ");
}

// ============================
// Layer 1: File loading
// ============================
// 中文：第一层：文件加载

function loadRawInput(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new SeedValidationError([{
      stage: "file",
      message: `Input file not found: ${filePath}`,
    }]);
  }

  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) {
    throw new SeedValidationError([{
      stage: "file",
      message: "Input file is empty.",
    }]);
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    throw new SeedValidationError([{
      stage: "file",
      message: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    }]);
  }
}

// ============================
// Layer 2: Top-level format detection
// ============================
// 中文：第二层：顶级格式检测

function extractSessions(raw: unknown): RawSession[] {
  // Format A: { sessions: [...] }
  // 中文：格式A：{ sessions: [...] }
  if (
    raw != null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "sessions" in raw
  ) {
    const obj = raw as FormatA;
    if (!Array.isArray(obj.sessions)) {
      throw new SeedValidationError([{
        stage: "top_level",
        message: 'Format A detected but "sessions" is not an array.',
      }]);
    }
    return obj.sessions;
  }

  // Format B: [...]
  // 中文：格式B：[...]
  if (Array.isArray(raw)) {
    return raw as RawSession[];
  }

  throw new SeedValidationError([{
    stage: "top_level",
    message:
      "Unrecognized input format. Expected either:\n" +
      '  Format A: { "sessions": [...] }\n' +
      "  Format B: [ { sessionKey, conversations }, ... ]",
  }]);
}

// ============================
// Layers 3-5: session / round / message validation
// ============================
// 中文：第三层至第五层：会话/轮次/消息验证

function validateSessions(
  sessions: RawSession[],
  strictRoundRole: boolean,
  errors: ValidationError[],
): void {
  if (sessions.length === 0) {
    errors.push({
      stage: "session",
      message: "No sessions found in input.",
    });
    return;
  }

  for (let si = 0; si < sessions.length; si++) {
    const session = sessions[si]!;

    // Layer 3: session validation
    // 中文：层3：会话验证
    if (!session.sessionKey || typeof session.sessionKey !== "string" || session.sessionKey.trim() === "") {
      errors.push({
        stage: "session",
        sourceIndex: si,
        message: '"sessionKey" is required and must be a non-empty string.',
      });
    }

    if (!Array.isArray(session.conversations)) {
      errors.push({
        stage: "session",
        sourceIndex: si,
        sessionKey: session.sessionKey,
        message: '"conversations" must be a two-dimensional array (array of rounds).',
      });
      continue; // Can't validate rounds
      // 中文：无法验证轮次
    }

    // Check that conversations is a 2D array
    // 中文：检查conversations是否为二维数组
    for (let ri = 0; ri < session.conversations.length; ri++) {
      const round = session.conversations[ri];

      // Layer 4: round validation
      // 中文：层4：轮次验证
      if (!Array.isArray(round)) {
        errors.push({
          stage: "round",
          sourceIndex: si,
          sessionKey: session.sessionKey,
          roundIndex: ri,
          message: "Round must be an array of messages.",
        });
        continue;
      }

      if (round.length === 0) {
        errors.push({
          stage: "round",
          sourceIndex: si,
          sessionKey: session.sessionKey,
          roundIndex: ri,
          message: "Round must be a non-empty array.",
        });
        continue;
      }

      // Strict round-role: each round must have at least one user and one assistant
      // 中文：严格轮次角色：每一轮必须至少有一个用户和一个助手
      if (strictRoundRole) {
        const roles = new Set(round.map((m) => m.role));
        if (!roles.has("user")) {
          errors.push({
            stage: "round",
            sourceIndex: si,
            sessionKey: session.sessionKey,
            roundIndex: ri,
            message: '--strict-round-role: round must contain at least one "user" message.',
          });
        }
        if (!roles.has("assistant")) {
          errors.push({
            stage: "round",
            sourceIndex: si,
            sessionKey: session.sessionKey,
            roundIndex: ri,
            message: '--strict-round-role: round must contain at least one "assistant" message.',
          });
        }
      }

      // Layer 5: message validation
      // 中文：层5：消息验证
      for (let mi = 0; mi < round.length; mi++) {
        const msg = round[mi]!;

        if (!msg.role || typeof msg.role !== "string") {
          errors.push({
            stage: "message",
            sourceIndex: si,
            sessionKey: session.sessionKey,
            roundIndex: ri,
            messageIndex: mi,
            message: '"role" is required and must be a non-empty string.',
          });
        }

        if (!msg.content || typeof msg.content !== "string" || msg.content.trim() === "") {
          errors.push({
            stage: "message",
            sourceIndex: si,
            sessionKey: session.sessionKey,
            roundIndex: ri,
            messageIndex: mi,
            message: '"content" is required and must be a non-empty string.',
          });
        }

        if (msg.timestamp !== undefined) {
          if (typeof msg.timestamp === "number") {
            if (!Number.isInteger(msg.timestamp)) {
              errors.push({
                stage: "message",
                sourceIndex: si,
                sessionKey: session.sessionKey,
                roundIndex: ri,
                messageIndex: mi,
                message: '"timestamp" must be an integer (epoch milliseconds). Negative values are allowed for dates before 1970.',
              });
            }
          } else if (typeof msg.timestamp === "string") {
            if (Number.isNaN(new Date(msg.timestamp).getTime())) {
              errors.push({
                stage: "message",
                sourceIndex: si,
                sessionKey: session.sessionKey,
                roundIndex: ri,
                messageIndex: mi,
                message: `"timestamp" string is not a valid ISO 8601 date: "${msg.timestamp}".`,
              });
            }
          } else {
            errors.push({
              stage: "message",
              sourceIndex: si,
              sessionKey: session.sessionKey,
              roundIndex: ri,
              messageIndex: mi,
              message: '"timestamp" must be a number (epoch ms) or an ISO 8601 string.',
            });
          }
        }
      }
    }
  }
}

// ============================
// Layer 6: Timestamp consistency
// ============================
// 中文：层6：时间戳一致性

interface TimestampCheckResult {
  status: "all_present" | "all_missing" | "mixed";
}

function checkTimestampConsistency(sessions: RawSession[]): TimestampCheckResult {
  let hasTs = false;
  let missingTs = false;

  for (const session of sessions) {
    if (!Array.isArray(session.conversations)) continue;
    for (const round of session.conversations) {
      if (!Array.isArray(round)) continue;
      for (const msg of round) {
        if (msg.timestamp !== undefined && msg.timestamp !== null) {
          hasTs = true;
        } else {
          missingTs = true;
        }
        // Early exit on mixed
        // 中文：早期退出混合情况
        if (hasTs && missingTs) {
          return { status: "mixed" };
        }
      }
    }
  }

  if (hasTs && !missingTs) return { status: "all_present" };
  if (!hasTs && missingTs) return { status: "all_missing" };
  // No messages at all — treat as all_missing (will be caught by session validation)
  // 中文：没有任何消息——视为all_missing（将在会话验证中被捕获）
  return { status: "all_missing" };
}

// ============================
// Normalization
// ============================
// 中文：归一化

function normalizeSessions(
  sessions: RawSession[],
  fallbackSessionKey?: string,
): { sessions: NormalizedSession[]; totalRounds: number; totalMessages: number } {
  const normalized: NormalizedSession[] = [];
  let totalRounds = 0;
  let totalMessages = 0;

  for (let si = 0; si < sessions.length; si++) {
    const raw = sessions[si]!;

    const sessionKey = raw.sessionKey || fallbackSessionKey || "seed-user";
    const sessionId = raw.sessionId || crypto.randomUUID();

    const rounds: NormalizedRound[] = [];
    for (const rawRound of raw.conversations) {
      if (!Array.isArray(rawRound)) continue;

      const messages: NormalizedMessage[] = rawRound.map((msg) => ({
        role: msg.role,
        content: msg.content,
        // Normalize timestamp: ISO string → epoch ms, number → pass-through, missing → 0 (filled later)
        // 中文：归一化时间戳：ISO字符串→毫秒时间戳，数字→通过传递，缺失→0（稍后填充）
        timestamp: msg.timestamp == null
          ? 0
          : typeof msg.timestamp === "string"
            ? new Date(msg.timestamp).getTime()
            : msg.timestamp,
      }));

      rounds.push({ messages });
      totalMessages += messages.length;
    }

    totalRounds += rounds.length;
    normalized.push({
      sessionKey,
      sessionId,
      rounds,
      sourceIndex: si,
    });
  }

  return { sessions: normalized, totalRounds, totalMessages };
}
