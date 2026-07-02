/**
 * Scene filename normalizer.
 *
 * Defensive engineering layer that runs *after* the LLM writes scene_blocks/*.md
 * and *before* syncSceneIndex(). Even though the prompt forbids spaces and
 * punctuation in filenames, LLMs occasionally produce names like
 * `Daily Rhythm in Shanghai.md`. Such names break:
 *   - Markdown navigation refs that downstream tools parse with `\S+\.md`
 *     (e.g. health-checker's scene reference detection).
 *   - Shell-based tools that iterate scene files without quoting.
 *   - URL/path encoding consumers (COS object keys etc).
 *
 * This module renames offenders to a canonical form on disk and lets every
 * other consumer (PersonaGenerator, recall, profile-sync) read the already
 * sanitized name from scene_index.json — no additional changes needed.
 * 中文：场景文件规范化器。
 * 在LLM写入scene_blocks/*.md *之后*且syncSceneIndex() *之前*运行的防御性工程层。尽管提示禁止文件名中包含空格和标点符号，但LLMs偶尔会生成类似`Daily Rhythm in Shanghai.md`的名称。此类名称会导致：
 * - 下游工具使用`\S+\.md`解析Markdown导航引用时出错（例如health-checker的场景引用检测）。
 * - 未引号处理的基于Shell的工具迭代文件时出错。
 * - URL/路径编码消费者（如COS对象键等）。此模块在磁盘上将违规者重命名为规范形式，并让其他消费者（如PersonaGenerator、recall、profile-sync）从scene_index.json中读取已消毒的名字——无需额外更改。
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Normalize a single scene filename.
 *
 * Rules:
 *   - Preserves the `.md` extension (case-insensitive match, lowercased).
 *   - Whitespace runs (spaces / tabs) → single hyphen.
 *   - Strips quotes, brackets, and ASCII punctuation that breaks shell/markdown.
 *   - Collapses consecutive separators (`-`, `_`, `.`).
 *   - Trims leading / trailing separators.
 *   - Falls back to `"scene"` if the stem becomes empty.
 *
 * Allowed character set after normalization (informally):
 *   Unicode letters/numbers, hyphen, underscore, dot.
 *
 * Examples:
 *   "Daily Rhythm in Shanghai.md"  → "Daily-Rhythm-in-Shanghai.md"
 *   "日常生活 健康管理.md"          → "日常生活-健康管理.md"
 *   "Coffee (Yirgacheffe).md"      → "Coffee-Yirgacheffe.md"
 *   "  spaced  .md"                → "spaced.md"
 *   ".MD"                          → "scene.md"
 *   "已经规范.md"                   → "已经规范.md" (no-op)
 */
export function normalizeSceneFilename(name: string): string {
  if (!name) return "scene.md";

  // Strip directory components defensively — we only normalize the basename.
  // 中文：防御性地剥离目录组件——我们仅规范化基名。
  const base = name.replace(/^.*[\\/]/, "");

  // Detect & strip `.md` (case-insensitive). Always re-emit lowercase `.md`.
  // 中文：检测并剥离`.md`（不区分大小写）。始终重新发出小写的`.md`。
  const lower = base.toLowerCase();
  const hasMd = lower.endsWith(".md");
  const stem = hasMd ? base.slice(0, -3) : base;

  const safe = stem
    // Replace whitespace runs (incl. NBSP, full-width space) with `-`
    // 中文：将连续的空白字符（包括NBSP、全角空格）替换为 `-`
    .replace(/[\s\u00A0\u3000]+/g, "-")
    // Drop quotes, brackets, and punctuation known to break shells/markdown.
    // Keep Unicode letters/numbers and the safe separators `-`, `_`, `.`.
    // 中文：移除已知会破坏Shell/markdown的引号、括号和标点符号。保留Unicode字母/数字以及安全分隔符 `-`, `_`, `.`。
    .replace(/[()[\]{}<>'"`,;:!?*|/\\=&%$#@^~+]/g, "")
    // Collapse consecutive separators.
    // 中文：压缩连续的分隔符。
    .replace(/-{2,}/g, "-")
    .replace(/_{2,}/g, "_")
    .replace(/\.{2,}/g, ".")
    // Trim leading / trailing separators.
    // 中文：修剪首尾分隔符。
    .replace(/^[-_.]+|[-_.]+$/g, "");

  return (safe || "scene") + ".md";
}

/**
 * Return whether a filename already matches its normalized form.
 * Faster than computing the normalized form when callers only need a yes/no.
 * 中文：返回文件名是否已经与其规范化形式匹配。
 * 当调用者只需获得是/否结果时，比重新计算规范化形式更快。
 */
export function isNormalizedSceneFilename(name: string): boolean {
  return normalizeSceneFilename(name) === name;
}

/**
 * Resolve a non-conflicting target path inside `dir` for the desired filename.
 *
 * If `desired` (e.g. `Daily-Rhythm.md`) already exists in `dir`, append a
 * numeric suffix `-2`, `-3`, ... before the `.md` extension until a free slot
 * is found. Caller may also pass `excludePath` to ignore a known existing file
 * (e.g. the source path of an in-flight rename, when source != target).
 * 中文：在 `dir` 内为期望的文件名解析一个不冲突的目标路径。
 * 如果 `desired`（例如 `Daily-Rhythm.md`）已经在 `dir` 中存在，则在其 `.md` 扩展名之前附加一个数字后缀 `-2`、`-3` 等，直到找到空闲槽位。调用者还可以传递 `excludePath` 以忽略已知存在的文件（例如，在飞行重命名中，当 source 不等于 target 时的源路径）。
 */
export async function resolveUniqueScenePath(
  dir: string,
  desired: string,
  excludePath?: string,
): Promise<string> {
  const target = path.join(dir, desired);
  if (!(await pathExists(target)) || target === excludePath) return target;

  const ext = ".md";
  const stem = desired.endsWith(ext) ? desired.slice(0, -ext.length) : desired;

  // Bound the search to keep this defensive (LLMs rarely produce hundreds of
  // colliding names; if they do, surface the failure rather than spin).
  // 中文：将搜索范围限定在此处以保持防御性（LLMs 很少生成数百个冲突的名字；如果确实如此，则表面失败而不是无限循环）。
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!(await pathExists(candidate)) || candidate === excludePath) {
      return candidate;
    }
  }
  throw new Error(
    `resolveUniqueScenePath: could not find a free slot for ${desired} in ${dir} after 1000 attempts`,
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface NormalizeRenameResult {
  /** Number of files that were actually renamed. */
  /** 中文：实际被重命名的文件数量。 */
  renamed: number;
  /** Number of files that were already normalized (no-op). */
  /** 中文：已经规范化（无操作）的文件数量。 */
  skipped: number;
  /** Per-rename audit entries (oldName → newName). */
  /** 中文：每次重命名的审核条目（oldName → newName）。 */
  renames: Array<{ from: string; to: string }>;
}

/**
 * Walk a scene_blocks directory and rename any `.md` file whose basename does
 * not match `normalizeSceneFilename(basename)`.
 *
 * Safe to call multiple times: subsequent invocations are no-ops once names
 * have stabilized.
 *
 * Notes:
 *   - Non-`.md` files are ignored (the LLM tool surface is restricted to .md,
 *     but the directory may contain transient artifacts).
 *   - Empty / soft-deleted files are not pre-filtered here; the SceneExtractor
 *     cleanup pass handles those before / after this call as appropriate.
 *   - Failures on individual entries are logged via the optional logger and
 *     do not abort the loop — index sync should still see the remaining files.
 * 中文：遍历 `scene_blocks` 目录并重命名任何基础名为 `normalizeSceneFilename(basename)` 不匹配的 `.md` 文件。
 * 多次调用是安全的：后续调用在名称稳定后将变为无操作。
 * 注释:
 * - 忽略非 `.md` 文件（LLM 工具界面仅限于 .md，但目录中可能包含临时文件）。
 * - 空 / 软删除的文件在此处不会预先过滤；SceneExtractor 清理过程会在调用前后适当地处理这些文件。
 * - 个别条目的失败通过可选的日志记录器记录，并不会中断循环——索引同步仍然会看到剩余的文件。
 */
export async function normalizeSceneFilenames(
  blocksDir: string,
  logger?: { debug?: (m: string) => void; warn?: (m: string) => void },
): Promise<NormalizeRenameResult> {
  const result: NormalizeRenameResult = { renamed: 0, skipped: 0, renames: [] };

  let entries: string[];
  try {
    entries = (await fs.readdir(blocksDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return result;
  }

  for (const file of entries) {
    const normalized = normalizeSceneFilename(file);
    if (normalized === file) {
      result.skipped++;
      continue;
    }

    const from = path.join(blocksDir, file);
    let to: string;
    try {
      to = await resolveUniqueScenePath(blocksDir, normalized, from);
    } catch (err) {
      logger?.warn?.(
        `[filename-normalizer] could not resolve unique target for ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.skipped++;
      continue;
    }

    if (to === from) {
      // Filesystem already matched (e.g. case-insensitive FS where source and
      // target collapse to the same inode); treat as a no-op.
      // 中文：文件系统已经匹配（例如，在大小写不敏感的文件系统中，source 和 target 转化为同一个 inode）；视为无操作。
      result.skipped++;
      continue;
    }

    try {
      await fs.rename(from, to);
      result.renamed++;
      result.renames.push({ from: file, to: path.basename(to) });
      logger?.debug?.(`[filename-normalizer] renamed: ${file} → ${path.basename(to)}`);
    } catch (err) {
      logger?.warn?.(
        `[filename-normalizer] rename failed (${file} → ${path.basename(to)}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
