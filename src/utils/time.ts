/**
 * Unified time module — the single source of truth for all timezone-aware
 * timestamp formatting in the plugin.
 *
 * Other modules MUST NOT directly call `toISOString()`, `getHours()`, or
 * `Intl.DateTimeFormat` for user/LLM-facing timestamps. Import from here instead.
 *
 * Design: module-level singleton. `initTimeModule()` is called once during
 * plugin registration; all subsequent calls read the resolved timezone.
 * 中文：统一时间模块——插件中所有时区感知的时间戳格式化的单一来源。
 */

// ============================
// Internal state
// ============================
// 中文：内部状态

let _resolvedTz = "UTC"; // default, overwritten by initTimeModule()
// 中文：默认值，将在initTimeModule()中被覆盖

interface Logger {
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

let _logger: Logger | undefined;

// ============================
// Initialization
// ============================
// 中文：初始化时间模块。在插件注册期间仅调用一次。

/**
 * Initialize the time module. Called once during plugin register.
 * Subsequent hot-reloads also go through here.
 * 中文：热重载后也通过这里进行初始化。
 */
export function initTimeModule(cfg: { timezone?: string }, logger?: Logger): void {
  _resolvedTz = resolveTimeZone(cfg.timezone, logger);
  _logger = logger;
  _logger?.debug?.(`[time] Timezone resolved: "${_resolvedTz}"`);
}

/**
 * Returns the currently active IANA timezone name (or offset string).
 * Useful for diagnostics and prompt generation.
 * 中文：返回当前活动的IANA时区名称（或偏移字符串）。
 */
export function getActiveTimeZone(): string {
  return _resolvedTz;
}

/**
 * @internal test-only — reset to pre-init state.
 * Avoids cross-test pollution when vitest runs multiple tests in the same process.
 * 中文：@internal 只供测试 —— 重置为初始状态。
 */
export function _resetTimeModuleForTest(): void {
  _resolvedTz = "UTC";
  _logger = undefined;
}

// ============================
// A-type: UTC instants (for storage)
// ============================
// 中文：A型：UTC瞬间（用于存储）

/**
 * Current time as UTC ISO 8601 string with "Z" suffix.
 * Used for SQLite/TCVDB timestamps, cursors, and any machine-compared instants.
 * 中文：当前时间作为带“Z”后缀的UTC ISO 8601字符串。
 */
export function nowInstantISO(): string {
  return new Date().toISOString();
}

// ============================
// B-type: Local date/datetime (follows configured tz)
// ============================
// 中文：B型：本地日期/时间（遵循配置的时区）

/**
 * Format a Date as "YYYY-MM-DD" in the configured timezone.
 * Used for L0 JSONL shard filenames and cleaner day boundaries.
 * 中文：按照配置的时区格式化日期为"YYYY-MM-DD"。用于L0 JSONL分片文件名和更清晰的日边界。
 */
export function formatLocalDate(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

/**
 * Format a Date as "YYYY-MM-DD HH:mm:ss" in the configured timezone.
 * Used for cleaner audit logs and human-readable local timestamps.
 * 中文：按照配置的时区格式化日期为"YYYY-MM-DD HH:mm:ss"。用于更清晰的审计日志和可读性更强的本地时间戳。
 */
export function formatLocalDateTime(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Compute the start-of-day (00:00:00.000) in the configured timezone for a given date.
 * Returns a UTC millisecond timestamp.
 * Used by memory-cleaner for cutoff calculations.
 * 中文：根据给定日期计算配置时区中的当天开始时刻（00:00:00.000）。返回UTC毫秒时间戳。由内存清理器用于截止计算。
 */
export function startOfLocalDay(d: Date = new Date()): number {
  // Get the local date components in the configured timezone
  // 中文：获取配置时区中的本地日期组件
  const dateStr = formatLocalDate(d);
  // Parse as midnight in the configured timezone
  // Use a trick: format "YYYY-MM-DDT00:00:00" and find the UTC equivalent
  // 中文：解析为配置时区中的午夜时间
  // 使用技巧：格式化"YYYY-MM-DDT00:00:00"并找到对应的UTC等效值
  const midnightLocal = new Date(`${dateStr}T00:00:00`);

  // We need to find the UTC instant that corresponds to midnight in _resolvedTz.
  // Approach: binary search isn't needed — we can use the timezone offset.
  // 中文：我们需要找到与_resolvedTz中午夜相对应的UTC瞬间。方法：不需要二分查找——可以直接使用时区偏移量。
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Start with an estimate: the date at UTC midnight
  // 中文：从估计值开始：UTC午夜的日期
  const utcMidnight = new Date(`${dateStr}T00:00:00Z`);
  // Check what local time that corresponds to
  // 中文：检查对应的本地时间是什么
  const localParts = formatter.formatToParts(utcMidnight);
  const localHour = parseInt(localParts.find((p) => p.type === "hour")!.value, 10);
  const localMinute = parseInt(localParts.find((p) => p.type === "minute")!.value, 10);
  const localDay = localParts.find((p) => p.type === "day")!.value;
  const targetDay = dateStr.slice(8, 10); // DD from YYYY-MM-DD
  // 中文：YYYY-MM-DD中的DD

  // The offset from UTC to local is: if UTC midnight shows as localHour:localMinute on localDay
  // then local midnight = UTC midnight - (localHour*60 + localMinute) minutes
  // But we need to handle day boundary crossings
  // 中文：从UTC到本地的时区偏移是：如果UTC午夜在本地显示为localHour:localMinute on localDay
  // 那么本地午夜 = UTC午夜 - (localHour*60 + localMinute)分钟
  // 但我们需要处理日期边界跨越问题
  let offsetMinutes = localHour * 60 + localMinute;
  if (localDay !== targetDay) {
    // Day wrapped — means local is behind UTC (negative offset zones)
    // e.g. UTC midnight = previous day 19:00 in America/New_York
    // 中文：日期跨越 — 表示本地时间比UTC晚（负时区）
    // 例如，UTC午夜在America/New_York是前一天的19:00
    offsetMinutes = offsetMinutes - 24 * 60;
  }

  // Local midnight in UTC = UTC midnight - offset
  // 中文：UTC中的本地午夜 = UTC午夜 - 偏移量
  return utcMidnight.getTime() - offsetMinutes * 60 * 1000;
}

// ============================
// C-type: LLM-facing timestamps (ISO 8601 with offset)
// ============================
// 中文：C类型：面向LLM的时间戳（ISO 8601带有时区偏移）

/**
 * Format a timestamp for LLM consumption: ISO 8601 with explicit UTC offset.
 * Example: "2026-04-07T11:04:45+08:00"
 *
 * Handles:
 * - Date objects
 * - ISO 8601 strings (with or without "Z")
 * - Unix millisecond timestamps (numbers)
 *
 * Old UTC data ("Z" suffix) is correctly converted to the configured timezone.
 * 中文：为LLM格式化时间戳：ISO 8601带有显式UTC时区偏移。
 * 示例: "2026-04-07T11:04:45+08:00"
 * 处理:
 * - 日期对象
 * - ISO 8601字符串（带或不带"Z"）
 * - Unix毫秒时间戳（数字）
 * 旧的UTC数据（带有"Z"后缀）正确转换为配置的时间区
 */
export function formatForLLM(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) {
    return String(input); // pass-through for unparseable values
    // 中文：传递给无法解析的值
  }

  // Get components in the configured timezone
  // 中文：获取配置时区中的组件
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const dateTime = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

  // Compute UTC offset for this instant in the configured timezone
  // 中文：计算此时刻在配置时区中的UTC偏移
  const offset = getUtcOffset(d);
  return `${dateTime}${offset}`;
}

/**
 * Generate a timezone declaration string for system prompts.
 * Example: "All timestamps below are in Asia/Shanghai (UTC+08:00). When reasoning about time, use this timezone."
 * 中文：生成系统提示的时间区声明字符串。
 */
export function describeTimeZoneForPrompt(): string {
  const offset = getUtcOffset(new Date());
  return `All timestamps below are in ${_resolvedTz} (UTC${offset}). When reasoning about "yesterday", "last week", or time differences, use this timezone.`;
}

// ============================
// Internal helpers
// ============================
// 中文：内部辅助函数

/**
 * Resolve the timezone configuration string to a validated timezone identifier.
 *
 * Accepts:
 * - "system" or undefined → process system timezone
 * - IANA names: "Asia/Shanghai", "Europe/Berlin", "UTC"
 * - UTC offset strings: "+08:00", "-05:30" (ECMA-402 2024)
 *
 * Invalid values fall back to system timezone with a warning.
 * 中文：将时间区配置字符串解析为有效的时区标识符。
 * 接受：
 * - "system" 或 undefined → 处理系统时区
 * - IANA名称: "Asia/Shanghai", "Europe/Berlin", "UTC"
 * - UTC偏移字符串: "+08:00", "-05:30" (ECMA-402 2024)
 * 无效值将回退到系统时区并发出警告。
 */
function resolveTimeZone(cfg: string | undefined, logger?: Logger): string {
  if (!cfg || cfg === "system") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  // Node 22+ Intl natively supports IANA names and UTC offset strings
  // per ECMA-402 2024 — no manual regex/Etc/GMT conversion needed.
  // 中文：Node 22+ 中的Intl原生支持IANA名称和UTC偏移字符串
  // 根据ECMA-402 2024 —无需手动进行正则表达式/Etc/GMT转换。
  if (validateTimeZone(cfg)) return cfg;
  logger?.warn?.(`[time] Invalid timezone "${cfg}", falling back to system timezone`);
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Validate a timezone string using the Intl API.
 * Works for IANA names and UTC offset strings ("+05:30", "-08:00").
 * 中文：使用Intl API验证时间区字符串。
 * 适用于IANA名称和UTC偏移字符串（"+05:30", "-08:00"）。
 */
function validateTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the UTC offset string (e.g. "+08:00", "-05:30", "+00:00")
 * for a given instant in the configured timezone.
 * 中文：根据配置的时间区计算特定时刻的UTC偏移字符串（例如 "+08:00", "-05:30", "+00:00"）。
 */
function getUtcOffset(d: Date): string {
  // Strategy: compare the "wall clock" time in the target tz vs UTC
  // to derive the offset for this specific instant (handles DST).
  // 中文：策略：比较目标时区与UTC的目标墙表时间
  // to 推导此特定时刻的偏移量（处理夏令时）。
  const utcParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const localParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: _resolvedTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const toMinutes = (parts: Intl.DateTimeFormatPart[]) => {
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);
    const y = get("year"), mo = get("month"), day = get("day");
    const h = get("hour"), mi = get("minute");
    // Convert to a comparable minute-of-epoch (approximate, good enough for offset calc)
    // 中文：转换为可比的分钟数（近似值，足够用于计算偏移量）
    return ((y * 12 + mo) * 31 + day) * 24 * 60 + h * 60 + mi;
  };

  const diffMinutes = toMinutes(localParts) - toMinutes(utcParts);
  const sign = diffMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(diffMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}
