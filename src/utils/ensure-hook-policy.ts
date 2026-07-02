/**
 * ensure-hook-policy.ts
 *
 * Auto-patches openclaw.json to add `hooks.allowConversationAccess: true`
 * for our plugin. Without it, the gateway silently blocks agent_end hooks
 * for non-bundled plugins (v2026.4.23+, PR #70786).
 * 中文：ensure-hook-policy.ts
 * 自动补丁 openclaw.json，添加 `hooks.allowConversationAccess: true`
 * 以供我们的插件使用。否则，在 v2026.4.23+ (PR #70786) 版本中，网关会静默阻止非捆绑插件的 agent_end 挂钩。
 */

import fs from "node:fs";
import path from "node:path";
import { getEnv } from "./env.js";
import JSON5 from "json5";

const PLUGIN_ID = "memory-tencentdb";

/**
 * Minimum host version at which `hooks.allowConversationAccess` is both
 * recognised by the schema and enforced. See header comment.
 * 中文：最低宿主机版本，`hooks.allowConversationAccess` 既被模式识别又强制执行。参见头部注释。
 */
export const HOOK_POLICY_MIN_VERSION: readonly [number, number, number] = [
  2026, 4, 24,
];

/**
 * Parse the leading `x.y.z` numeric prefix from a version string.
 *
 * Accepts:
 *   "2026.4.24"          -> [2026, 4, 24]
 *   "2026.4.24-beta.1"   -> [2026, 4, 24]
 *   "2026.5.3-1"         -> [2026, 5,  3]
 *   "2026.4.24.4"        -> [2026, 4, 24]   (extra segments ignored)
 *
 * Rejects (returns null):
 *   - Non-string values  (undefined / null / number / etc.)
 *   - "unknown" / ""     (no clean numeric prefix)
 *   - "2026.4"           (must have all three segments)
 *   - "v2026.4.24"       (no leading non-digit allowed — keep strict)
 * 中文：从版本字符串中解析前导 `x.y.z` 数字前缀。
 * 接受:
 * "2026.4.24"          -> [2026, 4, 24]
 * "2026.4.24-beta.1"   -> [2026, 4, 24]
 * "2026.5.3-1"         -> [2026, 5,  3]
 * "2026.4.24.4"        -> [2026, 4, 24]   (额外段落忽略)
 * 拒绝 (返回 null):
 * - 非字符串值  (undefined / null / number 等)
 * - "unknown" / ""     (没有干净的数字前缀)
 * - "2026.4"           (必须有三个部分)
 * - "v2026.4.24"       (不允许前导非数字字符 — 保持严格)
 */
export function parseVersionXYZ(v: unknown): [number, number, number] | null {
  if (typeof v !== "string") {
    return null;
  }
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.].*)?$/);
  if (!m) {
    return null;
  }
  const [, a, b, c] = m;
  return [Number(a), Number(b), Number(c)];
}

/**
 * Compare two `[x, y, z]` tuples. Returns negative / 0 / positive like a
 * standard comparator (a - b).
 * 中文：比较两个 `[x, y, z]` 元组。返回值类似于标准比较器 (a - b)。
 */
export function compareVersionXYZ(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Structured outcome of the hook-policy version gate.
 *
 * Exposed so callers (e.g. index.ts) can log exactly what was compared
 * (`original` raw input, parsed `x.y.z`, and the `min` threshold) without
 * having to re-implement the parse step themselves.
 * 中文：挂钩策略版本门的结构化结果。
 * 暴露给调用者（例如 index.ts）以记录具体比较内容 (`original` 原始输入、解析后的 `x.y.z` 以及 `min` 阈值），无需重新实现解析步骤。
 */
export interface HookPolicyDecision {
  /** Whether the auto-patch should be applied. */
  /** 中文：是否应应用自动补丁。 */
  apply: boolean;
  /** The raw value passed in (useful for logging verbatim). */
  /** 中文：传入的原始值 (用于原样记录日志)。 */
  rawVersion: unknown;
  /** Parsed `[x, y, z]`, or `null` if the input was unparsable. */
  /** 中文：解析后的 `[x, y, z]`，或如果输入无法解析则为 `null`。 */
  parsedXYZ: [number, number, number] | null;
  /** The minimum version threshold the decision was made against. */
  /** 中文：决定此次决策所依据的最小版本阈值。 */
  minXYZ: readonly [number, number, number];
}

/**
 * Decide whether we should apply the `allowConversationAccess` auto-patch
 * for the given host version, returning a structured result that callers
 * can log verbatim.
 *
 * Policy:
 *   - Extract the leading `x.y.z` prefix from `rawVersion` (ignoring any
 *     pre-release suffix like `-beta.N`, `-1`, `-alpha.N`, etc.).
 *   - If the prefix is >= {@link HOOK_POLICY_MIN_VERSION}, `apply = true`.
 *   - If the prefix cannot be parsed (unknown / empty / non-string /
 *     undefined — typical on hosts that don't expose `api.runtime.version`),
 *     `apply = false`.  This is the safe default: old hosts don't have the
 *     gate and don't need patching.
 *
 * NOTE: Very early pre-releases of the MIN version itself (e.g.
 * `2026.4.24-beta.1`) will satisfy the predicate. This is intentional —
 * the field was already recognised in those builds and the usage base is
 * negligible.
 * 中文：判断是否应为给定主机版本应用 `allowConversationAccess` 自动补丁，并返回一个结构化的结果供调用者直接记录。
 * 策略:
 * - 从 `rawVersion` 中提取前缀 `x.y.z`（忽略任何预发行后缀如 `-beta.N`, `-1`, `-alpha.N` 等）。
 * - 如果前缀 >= {@link HOOK_POLICY_MIN_VERSION}，则 `apply = true`。
 * - 如果前缀无法解析（未知 / 空 / 非字符串 / 未定义 —— 常见于不暴露 `api.runtime.version` 的主机），则 `apply = false`。这是安全的默认值：旧主机没有该门和不需要打补丁。
 * 注意: MIN 版本本身的非常早期预发行版（例如 `2026.4.24-beta.1`）也会满足条件。这是有意为之 —— 该字段在这些构建中已经被识别，且使用基础可以忽略。
 */
export function decideHookPolicy(rawVersion: unknown): HookPolicyDecision {
  const parsedXYZ = parseVersionXYZ(rawVersion);
  const apply =
    parsedXYZ !== null &&
    compareVersionXYZ(parsedXYZ, HOOK_POLICY_MIN_VERSION) >= 0;
  return {
    apply,
    rawVersion,
    parsedXYZ,
    minXYZ: HOOK_POLICY_MIN_VERSION,
  };
}

/**
 * Thin boolean wrapper around {@link decideHookPolicy} for callers that
 * only need the yes/no answer.
 * 中文：围绕 {@link decideHookPolicy} 的薄布尔包装器，供仅需是/否答案的调用者使用。
 */
export function shouldApplyHookPolicy(rawVersion: unknown): boolean {
  return decideHookPolicy(rawVersion).apply;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function isGatewayStart(): boolean {
  const args = process.argv.map((v) => String(v || "").toLowerCase());
  const idx = args.findIndex((a) =>
    a.endsWith("openclaw") || a.endsWith("openclaw.mjs") || a.endsWith("entry.js"),
  );
  if (idx < 0) return true;
  const cmd = args.slice(idx + 1).filter((a) => !a.startsWith("-"))[0];
  if (!cmd) return true;
  const skip = ["plugins", "plugin", "install", "uninstall", "update", "doctor", "security", "config", "onboard", "setup", "status", "version", "help"];
  return !skip.includes(cmd);
}

function resolveConfigPath(): string | null {
  // 1. OPENCLAW_CONFIG_PATH env override (same as core uses)
  // 中文：1. OPENCLAW_CONFIG_PATH 环境覆盖（与核心使用的相同）
  const envPath = getEnv("OPENCLAW_CONFIG_PATH")?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;

  // 2. OPENCLAW_STATE_DIR override
  // 中文：2. OPENCLAW_STATE_DIR 覆盖
  const stateDir = getEnv("OPENCLAW_STATE_DIR")?.trim();
  if (stateDir) {
    const p = path.join(stateDir, "openclaw.json");
    if (fs.existsSync(p)) return p;
  }

  // 3. Standard location: ~/.openclaw/openclaw.json
  // 中文：3. 标准位置: ~/.openclaw/openclaw.json
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "";
  if (!home) return null;
  const p = path.join(home, ".openclaw", "openclaw.json");
  return fs.existsSync(p) ? p : null;
}

function hasPolicyAlready(root: unknown): boolean {
  if (!isObj(root)) return false;
  const entry = (root as any)?.plugins?.entries?.[PLUGIN_ID];
  return isObj(entry) && isObj(entry.hooks) && entry.hooks.allowConversationAccess === true;
}

/**
 * Call early in register(). Patches config if missing, triggers restart.
 *
 * Strategy:
 * 1. Try SDK mutateConfigFile (handles path resolution, $include, atomic write,
 *    and triggers gateway restart via afterWrite).
 * 2. Fallback to manual file write if SDK is unavailable or fails.
 * 中文：在 register() 早期调用。如果缺少配置则打补丁，触发重启。
 * 策略:
 * 1. 尝试 SDK mutateConfigFile（处理路径解析、$include、原子写入，并通过 afterWrite 触发网关重启）。
 * 2. 如果 SDK 不可用或失败，则回退到手动文件写入。
 */
export function ensurePluginHookPolicy(params: {
  rootConfig?: unknown;
  runtimeConfig?: {
    mutateConfigFile?: (p: any) => Promise<any>;
  };
  logger: Logger;
}): void {
  const { logger } = params;
  const TAG = "[memory-tdai] [hook-policy]";

  if (!isGatewayStart()) return;
  if (hasPolicyAlready(params.rootConfig)) return;

  // Try SDK path first (handles everything + triggers restart)
  // 中文：优先尝试 SDK 路径（处理一切并触发重启）
  if (params.runtimeConfig?.mutateConfigFile) {
    logger.info(`${TAG} Missing allowConversationAccess, patching via SDK...`);
    params.runtimeConfig.mutateConfigFile({
      afterWrite: { mode: "restart", reason: "memory-tencentdb hook policy auto-patch" },
      mutate: (draft: any) => {
        if (!draft.plugins) draft.plugins = {};
        if (!draft.plugins.entries) draft.plugins.entries = {};
        if (!draft.plugins.entries[PLUGIN_ID]) draft.plugins.entries[PLUGIN_ID] = {};
        if (!draft.plugins.entries[PLUGIN_ID].hooks) draft.plugins.entries[PLUGIN_ID].hooks = {};
        draft.plugins.entries[PLUGIN_ID].hooks.allowConversationAccess = true;
      },
    }).then(() => {
      logger.info(`${TAG} ✅ Patched via SDK — gateway will restart automatically.`);
    }).catch((err: unknown) => {
      logger.warn(`${TAG} SDK mutateConfigFile failed: ${err instanceof Error ? err.message : String(err)}, trying manual fallback...`);
      manualPatch(logger);
    });
    return;
  }

  // Fallback: manual file write
  // 中文：回退：手动文件写入
  manualPatch(logger);
}

function manualPatch(logger: Logger): void {
  const TAG = "[memory-tdai] [hook-policy]";

  const configPath = resolveConfigPath();
  if (!configPath) {
    logger.warn(`${TAG} Cannot locate openclaw.json — please add hooks.allowConversationAccess manually`);
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    parsed = JSON5.parse(raw);
  } catch {
    logger.warn(`${TAG} Failed to parse ${configPath} — please add hooks.allowConversationAccess manually`);
    return;
  }

  if (hasPolicyAlready(parsed)) return;

  if ("$include" in parsed || (isObj(parsed.plugins) && "$include" in parsed.plugins)) {
    logger.warn(`${TAG} Config uses $include — please add manually: plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess = true`);
    return;
  }

  if (!isObj(parsed.plugins)) parsed.plugins = {};
  const plugins = parsed.plugins as Record<string, unknown>;
  if (!isObj(plugins.entries)) plugins.entries = {};
  const entries = plugins.entries as Record<string, unknown>;
  if (!isObj(entries[PLUGIN_ID])) entries[PLUGIN_ID] = {};
  const entry = entries[PLUGIN_ID] as Record<string, unknown>;
  if (!isObj(entry.hooks)) entry.hooks = {};
  (entry.hooks as Record<string, unknown>).allowConversationAccess = true;

  try {
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");
    logger.info(`${TAG} ✅ Auto-added hooks.allowConversationAccess to ${configPath}`);
    logger.warn(`${TAG} ⚠️  Gateway restart required. Run: openclaw gateway restart`);
  } catch (err) {
    logger.warn(`${TAG} Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}. Add manually.`);
  }
}
