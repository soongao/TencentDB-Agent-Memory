/**
 * Time utilities — all ISO 8601 timestamps use China Standard Time (UTC+08:00).
 * 中文：时间工具 — 所有ISO 8601时间戳使用中国标准时间（UTC+08:00）.
 */

/** China timezone offset in minutes (+8 hours) */
/** 中文：中国时区偏移分钟数（+8小时） */
const CST_OFFSET_MINUTES = 8 * 60;

/**
 * Get the current time as an ISO 8601 string in China Standard Time (UTC+08:00).
 * Format: "2026-03-25T16:53:51.178+08:00"
 * 中文：以中国标准时间（UTC+08:00）获取当前时间为ISO 8601字符串格式："2026-03-25T16:53:51.178+08:00"
 */
export function nowChinaISO(): string {
  return toChinaISO(new Date());
}

/**
 * Convert any Date object to an ISO 8601 string in China Standard Time.
 * Format: "YYYY-MM-DDTHH:mm:ss.SSS+08:00"
 * 中文：将任何Date对象转换为中国标准时间的ISO 8601字符串格式："YYYY-MM-DDTHH:mm:ss.SSS+08:00"
 */
export function toChinaISO(date: Date): string {
  const utcMs = date.getTime();
  const cstMs = utcMs + CST_OFFSET_MINUTES * 60 * 1000;
  const cst = new Date(cstMs);
  const year = cst.getUTCFullYear();
  const month = String(cst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(cst.getUTCDate()).padStart(2, "0");
  const hours = String(cst.getUTCHours()).padStart(2, "0");
  const minutes = String(cst.getUTCMinutes()).padStart(2, "0");
  const seconds = String(cst.getUTCSeconds()).padStart(2, "0");
  const ms = String(cst.getUTCMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}+08:00`;
}
