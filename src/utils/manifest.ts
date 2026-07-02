/**
 * Manifest — self-describing metadata for a memory-tdai data directory.
 *
 * Lives at `<dataDir>/.metadata/manifest.json`.
 *
 * - **store**: written once on first successful store init; never overwritten.
 *   On subsequent starts the current config is compared against the persisted
 *   store binding — mismatches are logged at debug level (informational only).
 * - **seed**: written once when a seed run completes; null for live-runtime dirs.
 *
 * This file is informational / read-only from the user's perspective.
 * The plugin reads it on startup for consistency checks.
 * 中文：Manifest — 内存-tdai数据目录的自我描述元数据。
 * 位于 `<dataDir>/.metadata/manifest.json`。
 * - **store**: 只在首次成功存储初始化时写入一次；从不被覆盖。
 * 后续启动时会将当前配置与持久化的存储绑定进行比较 —— 不匹配会在调试级别（仅信息性）记录日志。
 * - **seed**: 在种子运行完成后只写入一次；实时运行目录为 null。
 * 此文件从用户视角来看是信息性的 / 只读的。插件在启动时会读取它以进行一致性检查。
 */

import fs from "node:fs";
import path from "node:path";

// ============================
// Types
// ============================

export interface ManifestStoreInfo {
  type: "sqlite" | "tcvdb";
  sqlite?: {
    /** Relative path to the SQLite DB file (relative to dataDir). */
    /** 中文：SQLite DB文件的相对路径（相对于dataDir）。 */
    path: string;
  };
  tcvdb?: {
    url: string;
    database: string;
    /** User-friendly alias (optional). */
    /** 中文：用户友好的别名（可选）。 */
    alias?: string;
  };
}

export interface ManifestSeedInfo {
  /** Original input file name (basename only). */
  /** 中文：原始输入文件名（仅基名）。 */
  inputFile?: string;
  sessions: number;
  rounds: number;
  messages: number;
  startedAt: string;
  completedAt: string;
}

export interface Manifest {
  /** Schema version for future migrations. */
  /** 中文：未来迁移的模式版本。 */
  version: 1;
  /** Timestamp when the manifest was first created. */
  /** 中文：manifest首次创建的时间戳。 */
  createdAt: string;
  /** Store binding — written once on first init. */
  /** 中文：存储绑定 — 只在首次初始化时写入一次。 */
  store: ManifestStoreInfo;
  /** Seed run info — null for live-runtime directories. */
  /** 中文：种子运行信息 — 实时运行目录为 null。 */
  seed: ManifestSeedInfo | null;
}

// ============================
// Paths
// ============================

const METADATA_DIR = ".metadata";
const MANIFEST_FILE = "manifest.json";

export function manifestPath(dataDir: string): string {
  return path.join(dataDir, METADATA_DIR, MANIFEST_FILE);
}

// ============================
// Read / Write
// ============================
// 中文：读写

/**
 * Read an existing manifest from disk. Returns `null` if not found or unparseable.
 * 中文：从磁盘读取现有manifest。未找到或无法解析时返回`null`。
 */
export function readManifest(dataDir: string): Manifest | null {
  const p = manifestPath(dataDir);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Write a manifest to disk (creates `.metadata/` if needed).
 * 中文：将manifest写入磁盘（如有需要创建`.metadata/`目录）。
 */
export function writeManifest(dataDir: string, manifest: Manifest): void {
  const dir = path.join(dataDir, METADATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    manifestPath(dataDir),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
}

// ============================
// Store binding helpers
// ============================
// 中文：存储绑定辅助项

export interface StoreConfigSnapshot {
  type: "sqlite" | "tcvdb";
  sqlitePath?: string;
  tcvdbUrl?: string;
  tcvdbDatabase?: string;
  tcvdbAlias?: string;
}

/**
 * Build a ManifestStoreInfo from the current store config snapshot.
 * 中文：根据当前store配置快照构建ManifestStoreInfo。
 */
export function buildStoreInfo(snapshot: StoreConfigSnapshot): ManifestStoreInfo {
  const info: ManifestStoreInfo = { type: snapshot.type };
  if (snapshot.type === "sqlite") {
    info.sqlite = { path: snapshot.sqlitePath ?? "vectors.db" };
  } else {
    info.tcvdb = {
      url: snapshot.tcvdbUrl!,
      database: snapshot.tcvdbDatabase!,
      alias: snapshot.tcvdbAlias || undefined,
    };
  }
  return info;
}

/**
 * Compare the persisted store binding against the current config.
 * Returns a list of human-readable mismatch descriptions (empty = all good).
 * 中文：将持久化存储绑定与当前配置进行比较。
 * 返回一系列人类可读的不匹配描述（空表示一切正常）。
 */
export function diffStoreBinding(
  persisted: ManifestStoreInfo,
  current: ManifestStoreInfo,
): string[] {
  const diffs: string[] = [];

  if (persisted.type !== current.type) {
    diffs.push(`store type changed: ${persisted.type} → ${current.type}`);
    return diffs; // no point comparing fields across different types
    // 中文：没有意义比较不同类型的字段
  }

  if (persisted.type === "sqlite" && current.type === "sqlite") {
    if (persisted.sqlite?.path !== current.sqlite?.path) {
      diffs.push(`sqlite path changed: ${persisted.sqlite?.path} → ${current.sqlite?.path}`);
    }
  }

  if (persisted.type === "tcvdb" && current.type === "tcvdb") {
    if (persisted.tcvdb?.url !== current.tcvdb?.url) {
      diffs.push(`tcvdb url changed: ${persisted.tcvdb?.url} → ${current.tcvdb?.url}`);
    }
    if (persisted.tcvdb?.database !== current.tcvdb?.database) {
      diffs.push(`tcvdb database changed: ${persisted.tcvdb?.database} → ${current.tcvdb?.database}`);
    }
  }

  return diffs;
}
