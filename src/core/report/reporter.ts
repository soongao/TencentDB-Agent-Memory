import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const REPORT_CONST = {
  PLUGIN: "plugin",
} as const;

export type ReportPayload = Record<string, unknown>;

export interface IReporter {
  reportFunc(category: string, payload: ReportPayload): void;
}

// ── Singleton ──
// 中文：── Singleton ──

let _reporter: IReporter | undefined;

export function initReporter(opts: {
  enabled: boolean;
  type: string;
  logger: { info: (msg: string) => void; debug?: (msg: string) => void };
  instanceId: string;
  pluginVersion: string;
}): void {
  if (_reporter) return;
  if (!opts.enabled) return;
  switch (opts.type) {
    case "local":
      _reporter = new LocalReporter(opts.logger, opts.instanceId, opts.pluginVersion);
      break;
    // TODO: add new reporter type
    // 中文：TODO: 添加新的报告器类型
    default:
      opts.logger.debug?.(`[memory-tdai] Unknown reporter type "${opts.type}", disabled reporting`);
      break;
  }
}

export function setReporter(reporter: IReporter): void {
  _reporter = reporter;
}

/**
 * Reset the reporter singleton so that the next `initReporter` call takes effect.
 * Must be called at plugin re-registration (hot-reload) to pick up config changes.
 * 中文：重置报告器单例，以便下次 `initReporter` 调用生效。
 * 必须在插件重新注册（热加载）时调用以拾取配置更改。
 */
export function resetReporter(): void {
  _reporter = undefined;
}

export function report(event: string, data: ReportPayload): void {
  if (!_reporter) return;
  try {
    _reporter.reportFunc(REPORT_CONST.PLUGIN, { event, ...data });
  } catch { /* never block business logic */ }
  // 中文：不要阻塞业务逻辑
}

// ── LocalReporter (default) ──
// 中文：── LocalReporter （默认） ──

class LocalReporter implements IReporter {
  constructor(
    private readonly logger: { info: (msg: string) => void },
    private readonly instanceId: string,
    private readonly pluginVersion: string,
  ) {}

  reportFunc(category: string, payload: ReportPayload): void {
    try {
      this.logger.info(JSON.stringify({
        tag: "METRIC",
        category,
        plugin: "memory-tdai",
        instanceId: this.instanceId,
        pluginVersion: this.pluginVersion,
        ts: new Date().toISOString(),
        ...payload,
      }));
    } catch { /* swallow */ }
    // 中文：吞下异常
  }
}

// ── Instance ID (persisted per-install) ──
// 中文：── 实例 ID （每安装持久化） ──

let _instanceIdCache: string | undefined;

export async function getOrCreateInstanceId(pluginDataDir: string): Promise<string> {
  if (_instanceIdCache) return _instanceIdCache;

  const idFile = path.join(pluginDataDir, ".metadata", "instance_id");
  try {
    const existing = (await fs.readFile(idFile, "utf-8")).trim();
    if (existing) {
      _instanceIdCache = existing;
      return existing;
    }
  } catch { /* file doesn't exist */ }
  // 中文：文件不存在

  const newId = randomUUID();
  await fs.mkdir(path.dirname(idFile), { recursive: true });
  await fs.writeFile(idFile, newId, "utf-8");
  _instanceIdCache = newId;
  return newId;
}
