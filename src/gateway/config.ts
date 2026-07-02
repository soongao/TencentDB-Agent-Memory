/**
 * TDAI Gateway — Configuration management.
 *
 * Reads gateway configuration from:
 * 1. `tdai-gateway.yaml` (or JSON) in CWD or data dir
 * 2. Environment variables (override individual fields)
 *
 * Minimal config: just LLM API credentials. Everything else has sensible defaults.
 * 中文：TDAI网关 — 配置管理。
 * 从以下位置读取网关配置：
 * 1. 当前工作目录或数据目录中的 `tdai-gateway.yaml`（或 JSON）
 * 2. 环境变量（覆盖个别字段）
 * 最小配置：仅需LLM API凭证。其他一切都有合理的默认值。
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getEnv } from "../utils/env.js";
import { parseConfig as parseMemoryConfig } from "../config.js";
import type { MemoryTdaiConfig } from "../config.js";
import { normalizeDisableThinking } from "../utils/no-think-fetch.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";

// ============================
// Gateway config types
// ============================
// 中文：网关配置类型

export interface GatewayConfig {
  server: {
    port: number;
    host: string;
    /**
     * Optional API token for HTTP authentication.
     *
     * When set (non-empty string), every route except `GET /health` and CORS
     * preflight (`OPTIONS *`) requires an `Authorization: Bearer <apiKey>`
     * header. Requests without a valid token receive HTTP 401.
     *
     * **Default: undefined** — authentication is disabled, all routes are
     * open (preserves legacy behaviour). A WARN is emitted at startup if the
     * gateway binds to a non-loopback host without an API key set, to avoid
     * silently exposing an unauthenticated endpoint to the network.
     *
     * env: `TDAI_GATEWAY_API_KEY`
     * yaml: `server.apiKey`
     * 中文：可选的HTTP认证API令牌。
     * 当设置（非空字符串），除 `GET /health` 和 CORS 预检 (`OPTIONS *`) 之外的所有路由都需要带有 `Authorization: Bearer <apiKey>` 头部。没有有效令牌的请求将收到 HTTP 401 响应。
     * **默认：未定义** — 认证被禁用，所有路由都是开放的（保持了旧版行为）。如果网关绑定到非回环地址且未设置API密钥，在启动时会发出警告以避免无声地暴露一个未认证端点给网络。
     * env: `TDAI_GATEWAY_API_KEY`
     * yaml: `server.apiKey`
     */
    apiKey?: string;
    /**
     * Optional CORS allow-list.
     *
     * When empty (default), the gateway sends **no** `Access-Control-Allow-*`
     * headers and rejects CORS preflight (`OPTIONS`) with 403 if an `Origin`
     * header is present — browsers will then block all cross-origin requests
     * via same-origin policy.
     *
     * When set, each request's `Origin` is matched against this list and
     * `Access-Control-Allow-Origin` is echoed back only on match. Use the
     * single entry `"*"` to restore the legacy permissive behaviour (only
     * appropriate for local development).
     *
     * env: `TDAI_CORS_ORIGINS` (comma-separated)
     * yaml: `server.corsOrigins` (string[])
     * 中文：可选的CORS允许列表。
     * 当为空（默认），网关发送 **无** `Access-Control-Allow-*` 头部，并在存在 `Origin` 头部时以 403 拒绝 CORS 预检 (`OPTIONS`) — 浏览器将通过同源策略阻止所有跨域请求。
     * 当设置，每个请求的 `Origin` 将与这个列表匹配，仅在匹配时回显 `Access-Control-Allow-Origin`。使用单条目 `"*"` 恢复旧版宽松行为（仅适用于本地开发）。
     * env: `TDAI_CORS_ORIGINS` (逗号分隔)
     * yaml: `server.corsOrigins` (字符串数组)
     */
    corsOrigins: string[];
  };
  data: {
    /** Base directory for TDAI data storage. */
    /** 中文：TDAI数据存储的基础目录。 */
    baseDir: string;
  };
  llm: StandaloneLLMConfig;
  /** Parsed memory-tdai plugin config (recall, capture, extraction, pipeline, etc.). */
  /** 中文：解析的内存-tdai插件配置（回忆、捕获、提取、管道等）。 */
  memory: MemoryTdaiConfig;
}

// ============================
// Config loading
// ============================
// 中文：配置加载

/**
 * Load gateway config from file + environment variables.
 *
 * Resolution order for config file:
 * 1. `TDAI_GATEWAY_CONFIG` env var (explicit path)
 * 2. `./tdai-gateway.yaml` or `./tdai-gateway.json` in CWD
 * 3. `<dataDir>/tdai-gateway.yaml` or `<dataDir>/tdai-gateway.json`
 * 4. Pure environment-variable config (no file)
 * 中文：从文件和环境变量加载网关配置。
 * 配置文件的解析顺序：
 * 1. `TDAI_GATEWAY_CONFIG` 环境变量（显式路径）
 * 2. 当前工作目录中的 `./tdai-gateway.yaml` 或 `./tdai-gateway.json`
 * 3. `<dataDir>/tdai-gateway.yaml` 或 `<dataDir>/tdai-gateway.json`
 * 4. 仅环境变量配置（无文件）
 */
export function loadGatewayConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  let fileConfig: Record<string, unknown> = {};

  // Try to load config file
  // 中文：尝试加载配置文件
  const configPath = resolveConfigPath();
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      if (configPath.endsWith(".json")) {
        fileConfig = JSON.parse(raw);
      } else {
      // Full YAML support (arbitrary nesting, anchors, lists, multi-line).
        // We still postprocess ${VAR} env-var interpolation on string leaves
        // below so existing configs that relied on the previous simple parser
        // keep working.
      // 中文：完整支持YAML（任意嵌套、锚点、列表、多行）。虽然下方的字符串叶子节点仍会进行${VAR}环境变量插值后处理，但现有的依赖于旧简单解析器的配置文件依然可以正常工作。
        const parsed = YAML.parse(raw);
        fileConfig = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          ? parsed as Record<string, unknown>
          : {};
      }
      fileConfig = expandEnvVars(fileConfig) as Record<string, unknown>;
    } catch {
      // Config file is optional — malformed files fall back to env-only config.
      // 中文：配置文件是可选的——格式错误的文件将回退到仅使用环境变量的配置。
    }
  }

  // Server config
  // 中文：服务器配置
  const serverConfig = obj(fileConfig, "server");
  const port = envInt("TDAI_GATEWAY_PORT") ?? num(serverConfig, "port") ?? 8420;
  const host = env("TDAI_GATEWAY_HOST") ?? str(serverConfig, "host") ?? "127.0.0.1";

  // Optional auth / CORS — both default to "disabled" so existing setups keep
  // working unchanged. When unset the gateway behaves exactly like before this
  // change (open v1 routes, permissive CORS *will not* be re-introduced — see
  // resolveCorsOrigins below: empty list means "send no CORS headers").
  // 中文：可选的身份验证 / 跨源资源共享（CORS），两者默认为“禁用”，以确保现有设置无需更改即可继续正常工作。未设置时，网关的行为与本次变更前完全相同（开放v1路由，宽松的CORS不会重新引入——参见下方resolveCorsOrigins：空列表意味着“不发送任何CORS头”）。
  const apiKey = env("TDAI_GATEWAY_API_KEY") ?? str(serverConfig, "apiKey");
  const corsOrigins = resolveCorsOrigins(serverConfig);

  // Data config (expand leading ~ to $HOME so Node.js fs/path can resolve it)
  // 中文：数据配置（将前导~扩展为$HOME以便Node.js fs/path解析）
  const dataConfig = obj(fileConfig, "data");
  const rawBaseDir = env("TDAI_DATA_DIR") ?? str(dataConfig, "baseDir") ?? resolveDefaultDataDir();
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  const baseDir = rawBaseDir.startsWith("~/") ? path.join(home, rawBaseDir.slice(2)) : rawBaseDir;

  // LLM config
  // 中文：LLM配置
  const llmConfig = obj(fileConfig, "llm");
  const llm: StandaloneLLMConfig = {
    baseUrl: env("TDAI_LLM_BASE_URL") ?? str(llmConfig, "baseUrl") ?? "https://api.openai.com/v1",
    apiKey: env("TDAI_LLM_API_KEY") ?? str(llmConfig, "apiKey") ?? "",
    model: env("TDAI_LLM_MODEL") ?? str(llmConfig, "model") ?? "gpt-4o",
    maxTokens: envInt("TDAI_LLM_MAX_TOKENS") ?? num(llmConfig, "maxTokens") ?? 4096,
    timeoutMs: envInt("TDAI_LLM_TIMEOUT_MS") ?? num(llmConfig, "timeoutMs") ?? 120_000,
    disableThinking: normalizeDisableThinking(
      envBoolOrStr("TDAI_LLM_DISABLE_THINKING") ?? boolOrStr(llmConfig, "disableThinking")
    ),
  };

  // Memory config (reuse the plugin's parseConfig for full compatibility)
  // 中文：内存配置（重用插件的parseConfig以保持完全兼容性）
  const memoryRaw = obj(fileConfig, "memory");
  const memory = parseMemoryConfig(memoryRaw as Record<string, unknown> | undefined);

  const base: GatewayConfig = {
    server: { port, host, apiKey, corsOrigins },
    data: { baseDir },
    llm,
    memory,
  };

  // Merge overrides one level deep so partial `server`/`data`/`llm` patches
  // (frequently used by e2e tests) don't accidentally drop sibling fields
  // such as `corsOrigins` introduced after they were written.
  // 中文：深层次合并覆盖以防止端到端测试中频繁使用的部分`server`/`data`/`llm`补丁意外地丢弃兄弟字段如`corsOrigins`
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    server: { ...base.server, ...(overrides.server ?? {}) },
    data: { ...base.data, ...(overrides.data ?? {}) },
    llm: { ...base.llm, ...(overrides.llm ?? {}) },
  };
}

// ============================
// Helpers
// ============================
// 中文：Helpers

function resolveConfigPath(): string | null {
  // 1. Explicit env var
  // 中文：1. 显式环境变量
  const explicit = getEnv("TDAI_GATEWAY_CONFIG")?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  // 2. CWD
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) return p;
  }

  // 3. Default data dir
  // 中文：3. 默认数据目录
  const dataDir = resolveDefaultDataDir();
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function resolveDefaultDataDir(): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";

  // New canonical location: everything related to standalone/Hermes-mode TDAI
  // is collected under ~/.memory-tencentdb/ to avoid scattering top-level dirs
  // in $HOME. The Gateway data dir lives at:
  //
  //   ~/.memory-tencentdb/memory-tdai/
  //
  // Note: this only governs the standalone/Hermes fallback. Under the openclaw
  // host the plugin data dir is decided by `resolveStateDir() + "memory-tdai"`
  // (typically ~/.openclaw/memory-tdai/) which is intentionally NOT changed.
  // 中文：新的标准位置：所有与独立/Hermes模式TDAI相关的内容都集中收集在~/.memory-tencentdb/下，以避免将顶级目录分散在$HOME中。网关数据目录位于：~/.memory-tencentdb/memory-tdai/注意：这仅管理独立/Hermes回退模式。在openclaw宿主机下，插件数据目录由`resolveStateDir() + "memory-tdai"`决定（通常为~/.openclaw/memory-tdai/），这是故意不变的
  const root = getEnv("MEMORY_TENCENTDB_ROOT") ?? path.join(home, ".memory-tencentdb");
  const newDefault = path.join(root, "memory-tdai");

  // Backward compatibility: if the new location does not yet exist but the
  // legacy ~/memory-tdai still has data, keep using the legacy dir so existing
  // users don't silently lose their memory store. The install script
  // (install_hermes_memory_tencentdb.sh, Step 0) will migrate it on next run.
  // 中文：向后兼容性：如果新位置尚不存在但旧的~/memory-tdai仍然有数据，则继续使用旧目录，以便现有用户不会默默地丢失其记忆存储。安装脚本（install_hermes_memory_tencentdb.sh，步骤0）将在下次运行时对其进行迁移
  try {
    if (!fs.existsSync(newDefault)) {
      const legacy = path.join(home, "memory-tdai");
      if (fs.existsSync(legacy)) {
        // Stderr-only deprecation hint; doesn't pollute structured logs.
        // 中文：仅stderr弃用提示；不污染结构化日志
        process.stderr.write(
          `[tdai-gateway] DEPRECATED: using legacy data dir ${legacy}; ` +
          `move it to ${newDefault} (or set TDAI_DATA_DIR / MEMORY_TENCENTDB_ROOT) to silence this warning.\n`,
        );
        return legacy;
      }
    }
  } catch {
    // existsSync should not throw, but guard anyway.
    // 中文：existsSync不应抛出，但要进行防护
  }

  return newDefault;
}

function env(key: string): string | undefined {
  const v = getEnv(key)?.trim();
  return v || undefined;
}

function envInt(key: string): number | undefined {
  const v = env(key);
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read an env var that may be a boolean ("true"/"false"/"1"/"0")
 * or a plain string (strategy name like "deepseek", "anthropic").
 * Returns the lowercase string for strategy names.
 * 中文：读取可能为布尔值（"true"/"false"/"1"/"0"）或普通字符串（如策略名称 "deepseek", "anthropic"）的环境变量。
 * 返回策略名称时的小写字符串。
 */
function envBoolOrStr(key: string): boolean | string | undefined {
  const raw = env(key);
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return v; // lowercase strategy name
  // 中文：小写策略名称
}

/** Read a field that may be boolean or string from a config object. */
/** 中文：从配置对象中读取可能是布尔值或字符串的字段。 */
function boolOrStr(src: Record<string, unknown>, key: string): boolean | string | undefined {
  const v = src[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function obj(c: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = c[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function str(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(src: Record<string, unknown>, key: string): number | undefined {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Read `server.corsOrigins` from yaml or `TDAI_CORS_ORIGINS` from env.
 *
 * Accepted yaml shapes (yaml has precedence over env):
 *   server:
 *     corsOrigins: []                              # explicit empty → no CORS
 *     corsOrigins: ["https://app.example.com"]     # array of allowed origins
 *     corsOrigins: "https://a,https://b"           # comma-separated string
 *
 * Env: `TDAI_CORS_ORIGINS="https://a,https://b"`
 *
 * Returns `[]` when nothing is set — the server interprets that as
 * "do not emit any CORS headers" (most restrictive default).
 * 中文：从yaml文件中读取 `server.corsOrigins` 或从环境变量中读取 `TDAI_CORS_ORIGINS` 。
 * yaml格式（优先级高于环境变量）：
 * server:
 * corsOrigins: []                              # 显式空数组 → 不启用CORS
 * corsOrigins: ["https://app.example.com"]     # 允许的源域名列表
 * corsOrigins: "https://a,https://b"           # 逗号分隔字符串
 * 环境变量：`TDAI_CORS_ORIGINS="https://a,https://b"`
 * 未设置时返回 `[]` —— 服务器将其解释为“不发送任何CORS头”（最严格的默认值）。
 */
function resolveCorsOrigins(serverConfig: Record<string, unknown>): string[] {
  // 1. YAML takes precedence so an explicit `corsOrigins: []` can mean
  //    "I want CORS off" even when the env var leaks in from the shell.
  // 中文：1. yaml优先级更高，因此显式定义的 `corsOrigins: []` 可以表示 "关闭CORS" 即使环境变量从外壳中泄露进来。
  const raw = serverConfig["corsOrigins"];
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map(s => s.trim());
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }

  // 2. Fall back to env. Empty string from env is treated as "not set".
  // 中文：2. 失败后回退到环境变量。环境变量为空字符串被视为未设置。
  const envValue = env("TDAI_CORS_ORIGINS");
  if (!envValue) return [];
  return envValue.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Recursively replace ``${VAR_NAME}`` placeholders in string leaves with
 * the corresponding ``process.env`` value. Missing variables expand to an
 * empty string, matching the behaviour of the previous simple YAML parser
 * so existing configs keep working after the switch to the full YAML lib.
 *
 * - Only whole-string matches (``"${VAR}"``) are substituted, preserving
 *   types: numbers/booleans/null pass through unchanged.
 * - Arrays and nested objects are walked in-place (new arrays/objects are
 *   returned; the input is not mutated).
 * 中文：递归地用对应的 `process.env` 值替换字符串中的 ``${VAR_NAME}`` 占位符。
 * 缺失的变量扩展为空字符串，与之前简单的yaml解析器的行为一致，因此现有配置在切换到完整的yaml库后仍能正常工作。
 * - 仅整串匹配（``"${VAR}"``）会被替换，类型：数字/布尔值/空值保持不变。
 * - 数组和嵌套对象会原地遍历（返回新的数组/对象；输入不会被修改）。
 */
function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    const m = value.match(/^\$\{(\w+)\}$/);
    if (m) {
      return process.env[m[1]!] ?? "";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVars(v);
    }
    return out;
  }
  return value;
}
