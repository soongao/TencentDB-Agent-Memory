/**
 * Auth-profile API key resolver for offload local mode.
 *
 * OpenClaw stores model credentials in two places:
 *   1. `models.providers[provider].apiKey` — plaintext in openclaw.json
 *   2. auth-profiles store — the credential "vault" populated by `openclaw auth`
 *
 * The offload local-llm path historically only read location (1). When users
 * manage their keys via auth-profiles (location 2) — the OpenClaw-recommended
 * default — the lookup misses and L1/L1.5/L2 get disabled (see issue #90).
 *
 * This module provides a SYNCHRONOUS fallback that reads the key from the
 * auth-profile store, so `registerOffload` keeps its synchronous contract and
 * no race is introduced around `backendClient`.
 *
 * Compatibility: the `openclaw/plugin-sdk/provider-auth` subpath only exists on
 * newer OpenClaw versions. All host calls are guarded so that on older hosts
 * (or any unexpected failure) we silently fall back to the previous behavior
 * of "config-tree only".
 * 中文：Auth-profile API密钥解析器用于卸载本地模式。
 * OpenClaw将模型凭证存储在两个地方：
 * 1. `models.providers[provider].apiKey` — 在openclaw.json中明文存储
 * 2. auth-profiles存储库 — 由`openclaw auth`填充的“保险库”凭证
 * 卸载本地-llm路径历史地仅读取位置（1）。当用户通过auth-profiles（位置2）管理其密钥时——这是OpenClaw推荐的默认方式——查找会失败，L1/L1.5/L2将被禁用（参见问题#90）。
 * 此模块提供了一个同步回退方案，从auth-profile存储中读取密钥，因此`registerOffload`保持其同步合约不变，并且不会在`backendClient`周围引入竞争条件。
 * 兼容性：仅存在于较新版本OpenClaw中的`openclaw/plugin-sdk/provider-auth`子路径。所有主机调用都受到保护，以便在旧版主机（或任何意外失败）上我们无声地回退到“配置树”仅有的行为。
 */
import { createRequire } from "node:module";

import type { PluginLogger } from "./types.js";

const TAG = "[context-offload] [auth-profile]";

// The plugin is ESM ("type": "module"), so `require` is not a global. Create a
// CJS require bound to this module's URL — matches the pattern in the plugin
// entry (index.ts) and lets us tolerate a missing SDK subpath on older hosts.
// 中文：插件是ESM（"type": "module"），因此`require`不是全局的。创建一个绑定于此模块URL的CJS require — 与插件入口（index.ts）中的模式匹配，使我们在旧版主机上容忍缺少子路径的情况。
const _require = createRequire(import.meta.url);

/**
 * Resolve an API key for `providerKey` from OpenClaw's auth-profile store.
 *
 * Returns the plaintext key for the first `api_key`-type profile bound to the
 * provider, or `undefined` when nothing usable is found (no profile, only
 * oauth/token credentials, indirect keyRef-only storage, or an older host that
 * does not expose the auth-profile SDK).
 *
 * This is intentionally synchronous: the underlying store loaders
 * (`ensureAuthProfileStore`, `listProfilesForProvider`) are synchronous, which
 * lets the caller resolve the key inline without awaiting.
 *
 * @param api - OpenClaw plugin api (its `config` is forwarded to the resolver).
 * @param providerKey - Provider name parsed from the model ref (e.g. "xiaomi").
 * @param logger - Optional logger; failures are reported at debug level.
 * 中文：从OpenClaw的auth-profile存储中为`providerKey`解析API密钥。
 * 返回第一个绑定到提供者的`api_key`类型配置文件的明文密钥，或者当未找到可用项（没有配置文件、只有oauth/token凭证、间接keyRef仅存储或旧版主机不暴露auth-profile SDK）时返回`undefined`。
 * 此操作故意是同步的：底层存储加载器（`ensureAuthProfileStore`, `listProfilesForProvider`）是同步的，这使得调用者可以在不等待的情况下在线解析密钥。
 * @param api - OpenClaw插件api（其`config`转发给解析器）。
 * @param providerKey - 从模型引用中解析的提供程序名称（例如"xiaomi"）。
 * @param logger - 可选的日志记录器；失败在调试级别上报。
 */
export function resolveApiKeyFromAuthProfile(
  api: { config?: unknown },
  providerKey: string,
  logger?: PluginLogger,
  _loadSdkOverride?: () => ProviderAuthSdk | undefined,
): string | undefined {
  try {
    // Lazily load the SDK subpath so a missing export on older OpenClaw
    // versions degrades gracefully instead of crashing module load.
    // 中文：懒加载子路径，以便旧版OpenClaw版本缺少导出时能够优雅降级而不是模块加载崩溃。
    const sdk = _loadSdkOverride ? _loadSdkOverride() : loadProviderAuthSdk();
    if (!sdk) return undefined;

    const { ensureAuthProfileStore, listProfilesForProvider, resolveOpenClawAgentDir } = sdk;
    if (
      typeof ensureAuthProfileStore !== "function" ||
      typeof listProfilesForProvider !== "function"
    ) {
      return undefined;
    }

    const agentDir =
      typeof resolveOpenClawAgentDir === "function" ? resolveOpenClawAgentDir() : undefined;

    const store = ensureAuthProfileStore(agentDir, { config: api.config });
    if (!store || typeof store !== "object") return undefined;

    const profileIds = listProfilesForProvider(store, providerKey);
    if (!Array.isArray(profileIds) || profileIds.length === 0) return undefined;

    const profiles = (store as { profiles?: Record<string, unknown> }).profiles ?? {};
    for (const id of profileIds) {
      const cred = profiles[id] as { type?: string; key?: string } | undefined;
      // Only api_key credentials carry a directly-usable plaintext key.
      // oauth/token profiles, or api_key profiles that store only a keyRef
      // (indirect/keychain), cannot be consumed by the OpenAI-compatible
      // local-llm caller, so we skip them.
      // 中文：只有api_key凭证携带可以直接使用的明文密钥。
      // oauth/token配置文件或仅存储keyRef（间接/密钥链）的api_key配置文件无法被OpenAI兼容的本地-llm调用者消费，因此我们跳过它们。
      if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key.length > 0) {
        logger?.debug?.(`${TAG} Resolved api key for provider "${providerKey}" from profile "${id}"`);
        return cred.key;
      }
    }
    return undefined;
  } catch (err) {
    logger?.debug?.(
      `${TAG} Auth-profile lookup unavailable for provider "${providerKey}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

interface ProviderAuthSdk {
  ensureAuthProfileStore?: (
    agentDir?: string,
    options?: { config?: unknown },
  ) => { profiles?: Record<string, unknown> } | null | undefined;
  listProfilesForProvider?: (store: unknown, provider: string) => string[];
  resolveOpenClawAgentDir?: () => string;
}

/**
 * Load the `openclaw/plugin-sdk/provider-auth` subpath.
 *
 * Uses the module-scoped CJS require so a missing subpath (older hosts)
 * surfaces as a caught error rather than an unhandled module-resolution
 * failure.
 * 中文：加载`openclaw/plugin-sdk/provider-auth`子路径。
 * 使用模块作用域的CJS require，以便缺少子路径（旧版主机）表现为被捕获的错误而不是未处理的模块解析失败。
 */
function loadProviderAuthSdk(): ProviderAuthSdk | undefined {
  try {
    return _require("openclaw/plugin-sdk/provider-auth") as ProviderAuthSdk;
  } catch {
    return undefined;
  }
}
