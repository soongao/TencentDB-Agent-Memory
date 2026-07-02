/**
 * BackupManager: generic file/directory backup utility.
 *
 * Provides two backup modes:
 *   - `backupFile(src, category, tag, maxKeep)` — copy a single file
 *   - `backupDirectory(src, category, tag, maxKeep)` — copy an entire directory
 *
 * All backups land under `<backupRoot>/<category>/` with timestamped names.
 * After each backup, entries beyond `maxKeep` are automatically pruned
 * (oldest first, by lexicographic order on the timestamp-embedded name).
 * 中文：BackupManager: 通用文件/目录备份工具。
 * 提供两种备份模式：
 * - `backupFile(src, category, tag, maxKeep)` — 复制单个文件
 * - `backupDirectory(src, category, tag, maxKeep)` — 备份整个目录
 * 所有备份均存放在 `<backupRoot>/<category>/` 下，并带有时间戳的名称。
 * 每次备份后，超过 `maxKeep` 的条目将自动被移除（按嵌入时间戳的名称的字典顺序从最早开始）。
 */

import fs from "node:fs/promises";
import path from "node:path";

export class BackupManager {
  private backupRoot: string;

  /**
   * @param backupRoot - Absolute path to the root backup directory
   *                     (e.g. `<dataDir>/.backup`).
   * 中文：@param backupRoot - 根备份目录的绝对路径
   * (例如 `<dataDir>/.backup`)。
   */
  constructor(backupRoot: string) {
    this.backupRoot = backupRoot;
  }

  /**
   * Backup a single file.
   *
   * Destination: `<backupRoot>/<category>/<category>_<timestamp>_<tag>.<ext>`
   *
   * @param srcFile   - Absolute path to the source file
   * @param category  - Logical grouping (e.g. "persona")
   * @param tag       - Additional identifier (e.g. "offset42")
   * @param maxKeep   - Max backup files to retain in this category (0 = unlimited)
   * 中文：备份单个文件。
   * 目标位置: `<backupRoot>/<category>/<category>_<timestamp>_<tag>.<ext>`
   * @param srcFile   - 源文件的绝对路径
   * @param category  - 逻辑分组 (例如 "persona")
   * @param tag       - 额外标识符 (例如 "offset42")
   * @param maxKeep   - 保留在此类别的最大备份文件数 (0 = 无限)
   */
  async backupFile(
    srcFile: string,
    category: string,
    tag: string,
    maxKeep: number,
  ): Promise<void> {
    try {
      await fs.access(srcFile);
    } catch {
      return; // Source file doesn't exist, nothing to backup
      // 中文：源文件不存在，无内容可备份
    }

    const destDir = path.join(this.backupRoot, category);
    await fs.mkdir(destDir, { recursive: true });

    const ext = path.extname(srcFile); // e.g. ".md"
    const timestamp = formatTimestamp(new Date());
    const destName = `${category}_${timestamp}_${tag}${ext}`;
    await fs.copyFile(srcFile, path.join(destDir, destName));

    if (maxKeep > 0) {
      await pruneOldEntries(destDir, maxKeep, "file");
    }
  }

  /**
   * Backup an entire directory (shallow copy of all files).
   *
   * Destination: `<backupRoot>/<category>/<category>_<timestamp>_<tag>/`
   *
   * @param srcDir    - Absolute path to the source directory
   * @param category  - Logical grouping (e.g. "scene_blocks")
   * @param tag       - Additional identifier (e.g. "offset42")
   * @param maxKeep   - Max backup directories to retain in this category (0 = unlimited)
   * 中文：备份整个目录（浅层复制所有文件）。
   * 目标位置: `<backupRoot>/<category>/<category>_<timestamp>_<tag>/`
   * @param srcDir    - 源目录的绝对路径
   * @param category  - 逻辑分组 (例如 "scene_blocks")
   * @param tag       - 额外标识符 (例如 "offset42")
   * @param maxKeep   - 保留在此类别的最大备份目录数 (0 = 无限)
   */
  async backupDirectory(
    srcDir: string,
    category: string,
    tag: string,
    maxKeep: number,
  ): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(srcDir, { withFileTypes: true });
    } catch {
      return; // Source directory doesn't exist
      // 中文：源目录不存在
    }

    // Only backup regular files (skip subdirectories to avoid EISDIR errors)
    // 中文：仅备份普通文件（跳过子目录以避免 EISDIR 错误）
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (files.length === 0) return;

    const parentDir = path.join(this.backupRoot, category);
    const timestamp = formatTimestamp(new Date());
    const destDir = path.join(parentDir, `${category}_${timestamp}_${tag}`);
    await fs.mkdir(destDir, { recursive: true });

    for (const file of files) {
      await fs.copyFile(path.join(srcDir, file), path.join(destDir, file));
    }

    if (maxKeep > 0) {
      await pruneOldEntries(parentDir, maxKeep, "directory");
    }
  }

  /**
   * Find the latest backup directory for a category.
   *
   * Backup directory names are `<category>_<timestamp>_<tag>` where the
   * timestamp is `YYYYMMDD_HHmmss` (lexicographic order = chronological order),
   * so the lexicographically largest entry is the most recent one.
   *
   * @param category - Logical grouping (e.g. "scene_blocks")
   * @returns Absolute path to the latest backup directory, or undefined if none.
   * 中文：查找指定逻辑分组的最新备份目录。
   * 备份目录名称为 `<category>_<timestamp>_<tag>`，其中时间戳格式为 `YYYYMMDD_HHmmss` (字典顺序 = 日期顺序)，
   * 因此字典序最大的条目是最新的一个。
   * @param category - 逻辑分组 (例如 "scene_blocks")
   * @returns 指向最新备份目录的绝对路径，如果没有则返回 undefined。
   */
  async findLatestBackup(category: string): Promise<string | undefined> {
    const parentDir = path.join(this.backupRoot, category);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(parentDir, { withFileTypes: true });
    } catch {
      return undefined; // No backup directory yet
      // 中文：尚未创建备份目录
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length === 0) return undefined;
    dirs.sort(); // ascending — oldest first; last = newest
    // 中文：ascending — 最旧的优先；last = 最新
    return path.join(parentDir, dirs[dirs.length - 1]);
  }

  /**
   * Restore the latest backup of `category` into `destDir`.
   *
   * Strategy:
   *   1. Find the latest backup directory; if none exists, do nothing
   *      (fail-soft: never clobber the destination when there is no
   *      ground truth to restore from).
   *   2. Wipe `destDir` and recreate it.
   *   3. Copy every regular file from the backup directory into `destDir`.
   *
   * @param category - Logical grouping (e.g. "scene_blocks")
   * @param destDir  - Absolute path to the directory to restore into
   * @returns `{ restored: true, from }` when a backup was applied,
   *          `{ restored: false }` when no backup was found.
   * @throws  Lets fs errors during wipe/copy propagate so callers can decide
   *          whether to fail-soft (log) or fail-hard.
   * 中文：将 `category` 的最新备份恢复到 `destDir` 中。
   * 策略：
   * 1. 查找最新的备份目录；如果不存在，则不执行任何操作
   * (软失败: 当没有可供恢复的真实数据时，从不覆盖目标)。
   * 2. 清空并重新创建 `destDir`。
   * 3. 将备份目录中的每个普通文件复制到 `destDir` 中。
   * @param category - 逻辑分组 (例如 "scene_blocks")
   * @param destDir  - 恢复的目标目录的绝对路径
   * @returns `{ restored: true, from }` 当应用了备份时，
   * `{ restored: false }` 当未找到任何备份时。
   * @throws 让 fs 错误在擦除/复制期间传播，以便调用者决定是否软失败（记录）或硬失败。
   */
  async restoreLatestDirectory(
    category: string,
    destDir: string,
  ): Promise<{ restored: boolean; from?: string }> {
    const from = await this.findLatestBackup(category);
    if (!from) return { restored: false };

    // Wipe the destination first so any partial LLM writes are removed,
    // then recreate the directory and copy regular files back.
    // 中文：首先清空目标以移除任何不完整的 LLM 写入内容，
    // 然后重新创建目录并将普通文件恢复回去。
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.mkdir(destDir, { recursive: true });

    const entries = await fs.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      await fs.copyFile(path.join(from, entry.name), path.join(destDir, entry.name));
    }

    return { restored: true, from };
  }
}

// ============================
// Helpers
// ============================
// 中文：Helpers

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "_",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

/**
 * Keep only the newest `maxKeep` entries in a directory.
 * Entries are sorted by name ascending (oldest first) since backup names
 * embed timestamps, so lexicographic order = chronological order.
 *
 * @param dir     - Directory containing the backup entries
 * @param maxKeep - Number of entries to retain
 * @param kind    - "file" to unlink, "directory" to rm -rf
 * 中文：仅保留目录中的最新 `maxKeep` 条目。
 * 条目按名称升序（从旧到新）排序，因为备份名称嵌入了时间戳，所以字典顺序 = 时间顺序。
 * @param dir     - 包含备份条目的目录
 * @param maxKeep - 保留的条目数量
 * @param kind    - "file" 以 unlink 删除，"directory" 以 rm -rf 删除
 */
async function pruneOldEntries(
  dir: string,
  maxKeep: number,
  kind: "file" | "directory",
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  entries.sort(); // ascending — oldest first
  // 中文：ascending — 最旧的优先
  const toRemove = entries.slice(0, Math.max(0, entries.length - maxKeep));

  for (const name of toRemove) {
    try {
      if (kind === "file") {
        await fs.unlink(path.join(dir, name));
      } else {
        await fs.rm(path.join(dir, name), { recursive: true, force: true });
      }
    } catch {
      // best-effort
      // 中文：best-effort
    }
  }
}
