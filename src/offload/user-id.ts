/**
 * User ID resolver for backend reporting.
 *
 * The backend `/offload/v1/store` endpoint keys state by `X-User-Id`.
 * If the plugin config does not provide one, we fall back to the host's
 * primary non-loopback IPv4 address so each machine still maps to a
 * stable identifier. Falls back further to `"unknown-host"` on failure.
 *
 * The resolved value is cached on first read; IP lookup is cheap but
 * callers invoke this per request so caching keeps the hot path clean.
 * 中文：用户ID解析器用于后端报告。
 * 后端的`/offload/v1/store`端点通过`X-User-Id`键入状态。
 * 如果插件配置未提供，则回退到主机的
 * 主要非环回IPv4地址，以便每个机器仍映射到一个
 * 稳定的标识符。进一步失败时回退为`"unknown-host"`。
 * 解析后的值在首次读取时缓存；IP查找成本低廉但调用者每请求都调用此函数，因此缓存保持热点路径清晰。
 */
import * as os from "node:os";

let _cachedUserId: string | null = null;
let _cachedSource: "config" | "ip" | "fallback" | null = null;

/**
 * Find the first non-loopback, non-internal IPv4 address on the host.
 * Returns null when the host has no external-facing interface.
 * 中文：找到主机上的第一个非环回、非内部IPv4地址。
 * 当主机没有面向外部的接口时返回null。
 */
function detectLocalIPv4(): string | null {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const addrs = interfaces[name];
      if (!addrs) continue;
      for (const addr of addrs) {
        // node >= 18 exposes `family` as "IPv4" / "IPv6"; older versions use 4 / 6.
        // 中文：node >= 18 将 `family` 曝露为 "IPv4" / "IPv6"；较旧版本使用 4 / 6。
        const isV4 = addr.family === "IPv4" || (addr.family as unknown as number) === 4;
        if (isV4 && !addr.internal && typeof addr.address === "string") {
          return addr.address;
        }
      }
    }
  } catch {
    /* ignore — detection best-effort */
    /** 中文：ignore — 最佳努力检测 */
  }
  return null;
}

/**
 * Resolve the effective user ID. Priority:
 *   1. `configuredUserId` from plugin config (trimmed, non-empty)
 *   2. Primary non-loopback IPv4 address of the host
 *   3. Literal `"unknown-host"` fallback
 *
 * Result and source are cached — subsequent calls are O(1).
 * 中文：解析当前有效用户ID。优先级：
 * 1. 来自插件配置的`configuredUserId`（修剪后的非空值）
 * 2. 主机的主要非环回IPv4地址
 * 3. 字面量 `"unknown-host"` 回退
 * 结果和来源被缓存 — 后续调用为 O(1)。
 */
export function resolveUserId(configuredUserId?: string | null): string {
  if (_cachedUserId) return _cachedUserId;

  const trimmed = typeof configuredUserId === "string" ? configuredUserId.trim() : "";
  if (trimmed) {
    _cachedUserId = trimmed;
    _cachedSource = "config";
    return _cachedUserId;
  }

  const ip = detectLocalIPv4();
  if (ip) {
    _cachedUserId = ip;
    _cachedSource = "ip";
    return _cachedUserId;
  }

  _cachedUserId = "unknown-host";
  _cachedSource = "fallback";
  return _cachedUserId;
}

/** Returns how the currently-cached user id was resolved (or null if unresolved). */
/** 中文：返回当前缓存用户ID的解析方式（或未解析时返回null）。 */
export function getUserIdSource(): "config" | "ip" | "fallback" | null {
  return _cachedSource;
}

/** Testing hook: wipe the cache so the next resolve() re-evaluates. */
/** 中文：测试挂钩：清除缓存以便下次 resolve() 重新评估。 */
export function _resetUserIdCacheForTests(): void {
  _cachedUserId = null;
  _cachedSource = null;
}
