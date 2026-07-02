/**
 * SceneExtractor: LLM-driven memory extraction into scene blocks.
 *
 * Replaces the keyword-based SceneManager.processNewMemories() with an
 * LLM agent that autonomously reads/writes scene block files using tools.
 *
 * Security: The LLM is sandboxed — workspaceDir is set to scene_blocks/
 * so it can ONLY operate on .md scene files. System files (checkpoint,
 * scene_index, persona.md) are physically invisible to the LLM.
 *
 * Flow:
 *   1. Backup + load scene index + build summaries
 *   2. Assemble extraction prompt with memories + scene context
 *   3. Run via CleanContextRunner (tools enabled, sandboxed to scene_blocks/)
 *   4. Cleanup: remove soft-deletes, sync index, update navigation
 *   5. Parse LLM text output for out-of-band persona update signals
 * 中文：场景提取器: 由LLM驱动的场景记忆提取到场景块中。
 * 替换关键字驱动的SceneManager.processNewMemories()为一个
 * 自主读写场景块文件（使用工具）的LLM代理。
 * 安全：LLM被沙盒化 — workspaceDir设置为scene_blocks/
 * 因此它只能操作.md格式的场景文件。系统文件（检查点、场景索引、persona.md）对LLM来说是物理不可见的。
 * 流程：
 * 1. 备份 + 加载场景索引 + 构建摘要
 * 2. 组装提取提示，包含记忆和场景上下文
 * 3. 通过CleanContextRunner（启用工具，沙盒化到scene_blocks/）运行
 * 4. 清理：移除软删除项，同步索引，更新导航
 * 5. 解析LLM文本输出以获取背景更新信号
 */

import fs from "node:fs/promises";
import path from "node:path";
import { formatForLLM } from "../../utils/time.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { BackupManager } from "../../utils/backup.js";
import { readSceneIndex, syncSceneIndex } from "../scene/scene-index.js";
import type { SceneIndexEntry } from "../scene/scene-index.js";
import { parseSceneBlock } from "../scene/scene-format.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import { normalizeSceneFilenames } from "./filename-normalizer.js";
import { buildSceneExtractionPrompt } from "../prompts/scene-extraction.js";
import { report } from "../report/reporter.js";
import type { LLMRunner, Logger } from "../types.js";

const TAG = "[memory-tdai] [extractor]";

type ExtractorLogger = Logger;

export interface ExtractionResult {
  memoriesProcessed: number;
  success: boolean;
  error?: string;
}

export interface SceneExtractorOptions {
  dataDir: string;
  config: unknown;
  model?: string;
  maxScenes?: number;
  sceneBackupCount?: number;
  timeoutMs?: number;
  logger?: ExtractorLogger;
  /** Plugin instance ID for metric reporting (optional) */
  /** 中文：用于度量报告的插件实例ID（可选） */
  instanceId?: string;
  /**
   * Host-neutral LLM runner. When provided, used instead of creating
   * a CleanContextRunner (decouples from OpenClaw runtime).
   * Must be configured with `enableTools: true`.
   * 中文：主机无关的LLM运行器。当提供时，用作替代CleanContextRunner（与OpenClaw运行时解耦）。
   */
  llmRunner?: LLMRunner;
}

/**
 * Parse LLM text output for a persona update request signal.
 *
 * Supports multiple formats for robustness:
 * - Block: [PERSONA_UPDATE_REQUEST]reason: xxx[/PERSONA_UPDATE_REQUEST]
 * - Inline: PERSONA_UPDATE_REQUEST: xxx
 * 中文：解析LLM文本输出以获取背景更新请求信号。
 * 支持多种格式以增强健壮性：
 * - 块格式: [PERSONA_UPDATE_REQUEST]reason: xxx[/PERSONA_UPDATE_REQUEST]
 * - 内联格式: PERSONA_UPDATE_REQUEST: xxx
 */
export function parsePersonaUpdateSignal(text: string): { reason: string } | null {
  // Block format: [PERSONA_UPDATE_REQUEST]...[/PERSONA_UPDATE_REQUEST]
  // 中文：块格式: [PERSONA_UPDATE_REQUEST]...[/PERSONA_UPDATE_REQUEST]
  const blockMatch = text.match(
    /\[PERSONA_UPDATE_REQUEST\]\s*(?:reason:\s*)?(.+?)\s*\[\/PERSONA_UPDATE_REQUEST\]/s,
  );
  if (blockMatch) return { reason: blockMatch[1]!.trim() };

  // Inline format: PERSONA_UPDATE_REQUEST: reason text
  // 中文：内联格式: PERSONA_UPDATE_REQUEST: reason text
  const inlineMatch = text.match(
    /PERSONA_UPDATE_REQUEST:\s*(.+?)(?:\n|$)/,
  );
  if (inlineMatch) return { reason: inlineMatch[1]!.trim() };

  return null;
}

export class SceneExtractor {
  private dataDir: string;
  private runner: LLMRunner;
  private maxScenes: number;
  private sceneBackupCount: number;
  private timeoutMs: number;
  private logger: ExtractorLogger | undefined;
  private instanceId: string | undefined;

  constructor(opts: SceneExtractorOptions) {
    this.dataDir = opts.dataDir;
    this.maxScenes = opts.maxScenes ?? 15;
    this.sceneBackupCount = opts.sceneBackupCount ?? 10;
    this.timeoutMs = opts.timeoutMs ?? 300_000; // 5 min — LLM may do multiple tool calls
    // 中文：5 min — LLM可能进行多次工具调用
    this.logger = opts.logger;
    this.instanceId = opts.instanceId;

    // Use injected LLMRunner if available, otherwise fall back to CleanContextRunner
    // 中文：如果可用则使用注入的LLMRunner，否则回退到CleanContextRunner
    this.runner = opts.llmRunner ?? new CleanContextRunner({
      config: opts.config,
      modelRef: opts.model,
      enableTools: true,
      logger: opts.logger,
    });

    this.logger?.debug?.(`${TAG} Created: dataDir=${opts.dataDir}, model=${opts.model ?? "(default)"}, maxScenes=${this.maxScenes}, timeout=${this.timeoutMs}ms`);
  }

  /**
   * Extract a batch of memories into scene blocks using the LLM agent.
   *
   * @param memories - Array of raw memory records from the API
   * @returns Extraction result with count and success flag
   * 中文：使用LLM代理从一批记忆中提取成场景块。
   * @params memories - API返回的原始记忆记录数组
   * @returns 提取结果，包含计数和成功标志
   */
  async extract(memories: Array<{ content: string; created_at: string; id?: string }>): Promise<ExtractionResult> {
    const extractStartMs = Date.now();
    this.logger?.info(`${TAG} extract() start: ${memories.length} memories`);

    if (memories.length === 0) {
      this.logger?.debug?.(`${TAG} extract() skipped: no memories`);
      return { memoriesProcessed: 0, success: true };
    }

    const sceneBlocksDir = path.join(this.dataDir, "scene_blocks");
    const metadataDir = path.join(this.dataDir, ".metadata");

    // Ensure directories exist
    // 中文：确保目录存在
    await fs.mkdir(sceneBlocksDir, { recursive: true });
    await fs.mkdir(metadataDir, { recursive: true });

    // Phase 1: Backup
    // 中文：阶段1：备份
    const backupStartMs = Date.now();
    const cpManager = new CheckpointManager(this.dataDir);
    const cp = await cpManager.read();
    const bm = new BackupManager(path.join(this.dataDir, ".backup"));
    await bm.backupDirectory(sceneBlocksDir, "scene_blocks", `offset${cp.total_processed}`, this.sceneBackupCount);
    this.logger?.debug?.(`${TAG} extract() backup phase: ${Date.now() - backupStartMs}ms`);

    // Phase 2: Load scene index
    // 中文：阶段2：加载场景索引
    const indexStartMs = Date.now();
    const index = await readSceneIndex(this.dataDir);
    this.logger?.debug?.(`${TAG} extract() scene index loaded: ${index.length} entries (${Date.now() - indexStartMs}ms)`);

    // Build scene summaries for the prompt (relative filenames only)
    // 中文：为提示构建场景摘要（仅相对文件名）
    const { summaries: sceneSummaries, filenames: existingSceneFiles } =
      this.buildSceneSummaries(index);

    // Build scene count warning (tiered system)
    // 中文：构建场景计数警告（分层系统）
    let sceneCountWarning: string | undefined;
    const sceneCount = index.length;
    if (sceneCount >= this.maxScenes) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，已达到或超过 ${this.maxScenes} 个上限！\n**你必须先执行 MERGE 操作**，将最相似的 2-4 个场景合并为 1 个，然后再处理新记忆。\n参考合并对象：热度最低或主题高度重叠的场景。`;
      this.logger?.warn(`${TAG} extract() scene count at limit: ${sceneCount}/${this.maxScenes}`);
    } else if (sceneCount === this.maxScenes - 1) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，距离上限只差 1 个！\n本次处理**只能 UPDATE 现有场景，不能 CREATE 新场景**。`;
      this.logger?.warn(`${TAG} extract() scene count near limit (CREATE blocked): ${sceneCount}/${this.maxScenes}`);
    } else if (sceneCount >= this.maxScenes - 3) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，建议优先考虑 UPDATE 或主动 MERGE 相似场景。`;
      this.logger?.debug?.(`${TAG} extract() scene count approaching limit: ${sceneCount}/${this.maxScenes}`);
    }

    // Snapshot scene index + content before LLM — used later to diff created/updated/deleted
    // 中文：在LLM之前快照场景索引+内容——稍后用于差异创建/更新/删除的内容
    const preExtractIndex = new Map(index.map((e) => [e.filename, e.summary]));
    // Also snapshot scene content so we can detect content-only changes vs metadata-only changes
    // 中文：也快照场景内容以便检测内容更改与元数据更改的区别
    const preExtractContent = new Map<string, string>();
    for (const e of index) {
      try {
        const raw = await fs.readFile(path.join(sceneBlocksDir, e.filename), "utf-8");
        const block = parseSceneBlock(raw, e.filename);
        preExtractContent.set(e.filename, block.content);
      } catch { /* non-fatal */ }
      // 中文：非致命性
    }

    // Phase 3: Build prompt
    // 中文：阶段3：构建提示
    const promptStartMs = Date.now();
    const memoriesJson = JSON.stringify(
      memories.map((m) => ({
        content: m.content,
        created_at: m.created_at ? formatForLLM(m.created_at) : m.created_at,
        id: m.id ?? "",
      })),
      null,
      2,
    );

    const currentTimestamp = formatTimestamp(new Date());

    const { systemPrompt, userPrompt } = buildSceneExtractionPrompt({
      memoriesJson,
      sceneSummaries: sceneSummaries || "(无已有场景)",
      currentTimestamp,
      sceneCountWarning,
      existingSceneFiles,
      maxScenes: this.maxScenes,
    });
    this.logger?.debug?.(`${TAG} extract() prompt built: ${userPrompt.length} chars (${Date.now() - promptStartMs}ms)`);

    // Phase 4: Run LLM agent (sandboxed to scene_blocks/)
    // 中文：第4阶段：运行LLM代理（沙箱化至scene_blocks/）
    let llmOutput = "";
    let llmDurationMs = 0;
    try {
      this.logger?.debug?.(`${TAG} extract() starting LLM runner (timeout=${this.timeoutMs}ms, maxTokens=model default)...`);
      const runnerStartMs = Date.now();
      llmOutput = await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: `scene-extract-${Date.now()}`,
        timeoutMs: this.timeoutMs,
        // maxTokens omitted → core uses the resolved model's maxTokens from catalog
        // 中文：省略maxTokens → 核心使用catalog中解析出的模型的最大标记数
        workspaceDir: sceneBlocksDir,
      }) ?? "";
      llmDurationMs = Date.now() - runnerStartMs;
      this.logger?.debug?.(`${TAG} extract() LLM runner completed: ${llmDurationMs}ms`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const totalMs = Date.now() - extractStartMs;
      this.logger?.error(`${TAG} extract() LLM runner failed after ${totalMs}ms: ${errMsg}`);

      // Restore scene_blocks/ from the Phase 1 backup so partial LLM writes
      // (or a wiped sandbox) don't leak into the next recall cycle.
      // Fail-soft: a restore failure must never mask the original LLM error.
      // 中文：从Phase 1备份恢复scene_blocks/，以防止部分LLM写入
      // 或清空的沙箱数据泄露到下一召回周期。
      // 软失败：恢复失败绝不能掩盖原始的LLM错误。
      try {
        const result = await bm.restoreLatestDirectory("scene_blocks", sceneBlocksDir);
        if (result.restored) {
          this.logger?.warn(`${TAG} extract() restored scene_blocks/ from backup: ${result.from}`);
        } else {
          this.logger?.debug?.(`${TAG} extract() no scene_blocks backup to restore from (first run or empty)`);
        }
      } catch (restoreErr) {
        const rMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        this.logger?.warn(`${TAG} extract() restore failed (non-fatal, original LLM error preserved): ${rMsg}`);
      }

      return { memoriesProcessed: 0, success: false, error: errMsg };
    }

    // Phase 5: Subsequent processing — safe cleanup of soft-deleted files
    //
    // Security: The LLM has no `exec` tool and cannot run shell commands.
    // Instead, it "deletes" files by writing the marker `[DELETED]` to the file
    // (writing empty/whitespace-only content is rejected by core's write tool
    // parameter validation). Here we detect and remove those soft-deleted files
    // before syncing the index, so syncSceneIndex won't re-index stale entries.
    //
    // We also detect "META-only" files — files that contain only a META header
    // (e.g. [ARCHIVE] or [CONSOLIDATED] markers) but no actual scene content.
    // These are artifacts of LLM merges that didn't properly delete old files.
    // 中文：第5阶段：后续处理 — 安全清理软删除文件
    // 安全：LLM没有`exec`工具且无法运行shell命令。
    // 相反，它通过向文件写入标记`[DELETED]`来“删除”文件
    // （空内容/空白内容的写入被核心写入工具参数验证拒绝）。
    // 在此我们检测并移除这些软删除文件
    // 以在同步索引前避免syncSceneIndex重新索引过时条目。
    // 我们还检测仅包含META头的文件 — 仅包含META头部但没有实际场景内容的文件。
    // 这些都是LLM合并过程中未正确删除旧文件的结果。
    const cleanupStartMs = Date.now();
    let cleanedCount = 0;
    try {
      const allFiles = (await fs.readdir(sceneBlocksDir)).filter((f) => f.endsWith(".md"));
      for (const file of allFiles) {
        const filePath = path.join(sceneBlocksDir, file);
        const raw = await fs.readFile(filePath, "utf-8");
        if (raw.trim().length === 0 || raw.trim() === "[DELETED]") {
          // Empty file or [DELETED] marker — soft-delete
          // 中文：空文件或[DELETED]标记 — 软删除
          await fs.unlink(filePath);
          cleanedCount++;
          this.logger?.debug?.(`${TAG} extract() removed soft-deleted file: ${file}`);
        } else {
          // Check if file has only META header but no actual content
          // 中文：检查文件是否仅有META头部而无实际内容
          const block = parseSceneBlock(raw, file);
          if (!block.content || block.content.trim().length === 0) {
            await fs.unlink(filePath);
            cleanedCount++;
            this.logger?.debug?.(`${TAG} extract() removed META-only file (no content): ${file}`);
          }
        }
      }
    } catch (cleanupErr) {
      // Non-fatal — log and continue to index sync
      // 中文：非致命错误 — 记录并继续索引同步
      this.logger?.warn(`${TAG} extract() soft-delete cleanup error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
    this.logger?.debug?.(`${TAG} extract() soft-delete cleanup: removed ${cleanedCount} empty files (${Date.now() - cleanupStartMs}ms)`);

    // Phase 5b: Normalize filenames (defensive — LLM occasionally produces names
    // with spaces / punctuation despite the prompt forbidding them, e.g.
    // "Daily Rhythm in Shanghai.md". Such names break downstream consumers
    // that parse Markdown navigation refs with `\S+\.md` style regexes
    // (health-checker), shell tools, and URL-encoded path consumers.
    //
    // Renaming here — *before* syncSceneIndex — means scene_index.json and
    // every downstream reader (PersonaGenerator, recall, profile-sync) only
    // ever sees canonical filenames. Idempotent and safe to run repeatedly.
    // 中文：第5b阶段：规范化文件名（防御性措施 — LLM偶尔会生成包含空格/标点的名称
    // 尽管提示禁止了它们，例如"Daily Rhythm in Shanghai.md"。此类名称会破坏下游消费者
    // 使用`\S+\.md`风格正则解析Markdown导航引用（健康检查器）、shell工具和URL编码路径消费者。
    // 在此重命名 — 在syncSceneIndex之前 — 确保scene_index.json及所有下游读取器（PersonaGenerator、召回、profile-sync）仅见标准文件名。此操作可重复执行且安全无害。
    const normStartMs = Date.now();
    try {
      const normResult = await normalizeSceneFilenames(sceneBlocksDir, this.logger);
      if (normResult.renamed > 0) {
        this.logger?.info(
          `${TAG} extract() filename normalization: renamed ${normResult.renamed}, skipped ${normResult.skipped} (${Date.now() - normStartMs}ms)`,
        );
      } else {
        this.logger?.debug?.(
          `${TAG} extract() filename normalization: skipped ${normResult.skipped} (${Date.now() - normStartMs}ms)`,
        );
      }
    } catch (normErr) {
      // Non-fatal — log and continue. Index sync below will simply pick up
      // whatever names are present on disk.
      // 中文：非致命错误——记录并继续。以下的索引同步将简单地拾取磁盘上存在的名称.
      this.logger?.warn(`${TAG} extract() filename normalization error: ${normErr instanceof Error ? normErr.message : String(normErr)}`);
    }

    // Phase 6: Sync scene index (rebuilds from remaining non-empty files)
    // 中文：第6阶段：同步场景索引（从剩余非空文件重建）
    const syncStartMs = Date.now();
    await syncSceneIndex(this.dataDir);
    this.logger?.debug?.(`${TAG} extract() scene index synced: ${Date.now() - syncStartMs}ms`);

    // Phase 7: Update persona.md navigation (GAP-4 fix)
    // 中文：第7阶段：更新persona.md导航（GAP-4修复）
    const navStartMs = Date.now();
    try {
      await this.updateSceneNavigation();
      this.logger?.debug?.(`${TAG} extract() persona.md navigation updated: ${Date.now() - navStartMs}ms`);
    } catch (navErr) {
      // Non-fatal — log and continue
      // 中文：非致命错误——记录并继续.
      this.logger?.warn(`${TAG} extract() failed to update persona navigation: ${navErr instanceof Error ? navErr.message : String(navErr)}`);
    }

    // Phase 8: Parse LLM output for out-of-band persona update signal
    // 中文：第8阶段：解析LLM输出以获取离散的人格更新信号
    if (llmOutput) {
      const signal = parsePersonaUpdateSignal(llmOutput);
      if (signal) {
        await cpManager.setPersonaUpdateRequest(signal.reason);
        this.logger?.debug?.(`${TAG} extract() persona update requested by LLM: ${signal.reason}`);
      }
    }

    const totalMs = Date.now() - extractStartMs;
    this.logger?.info(`${TAG} extract() completed: ${memories.length} memories processed in ${totalMs}ms`);

    // ── l2_extraction metric ──
    // 中文：── l2_extraction 指标 ──
    if (this.instanceId && this.logger) {
      // Read updated scene index to report final state + diff against pre-extract snapshot
      // 中文：读取更新后的场景索引以报告最终状态+与预提取快照的差异
      let resultScenes: Array<{ title: string; summary: string; content: string; status: "created" | "updated" }> = [];
      let scenesCreated = 0;
      let scenesUpdated = 0;
      let scenesDeleted = 0;
      try {
        const finalIndex = await readSceneIndex(this.dataDir);
        const postFilenames = new Set<string>();
        for (const e of finalIndex) {
          postFilenames.add(e.filename);
          const oldSummary = preExtractIndex.get(e.filename);
          // Read scene block content from disk
          // 中文：从磁盘读取场景块内容
          let content = "";
          try {
            const blockPath = path.join(sceneBlocksDir, e.filename);
            const raw = await fs.readFile(blockPath, "utf-8");
            const block = parseSceneBlock(raw, e.filename);
            content = block.content;
          } catch { /* file read failure is non-fatal */ }
          // 中文：文件读取失败是非致命性的

          if (oldSummary === undefined) {
            // New scene
            // 中文：新场景
            scenesCreated++;
            resultScenes.push({
              title: e.filename.replace(/\.md$/, ""),
              summary: e.summary,
              content,
              status: "created",
            });
          } else {
            // Existing scene — check if content actually changed (not just metadata)
            // 中文：现有场景——检查内容是否实际更改（不只是元数据）
            const oldContent = preExtractContent.get(e.filename) ?? "";
            if (content !== oldContent) {
              scenesUpdated++;
              resultScenes.push({
                title: e.filename.replace(/\.md$/, ""),
                summary: e.summary,
                content,
                status: "updated",
              });
            }
            // If only metadata (summary/heat) changed but content is the same, skip
            // 中文：如果只有元数据（摘要/热度）更改但内容相同，则跳过
          }
        }
        // Scenes in pre-extract but missing from post-extract = deleted
        // 中文：预提取中的场景但在后提取中缺失=删除
        for (const [filename] of preExtractIndex) {
          if (!postFilenames.has(filename)) {
            scenesDeleted++;
          }
        }
      } catch { /* non-fatal */ }
      // 中文：非致命性

      report("l2_extraction", {
        inputMemoryCount: memories.length,
        resultSceneCount: resultScenes.length,
        resultScenes,
        scenesCreated,
        scenesUpdated,
        scenesDeleted,
        llmDurationMs,
        totalDurationMs: totalMs,
        success: true,
        error: null,
      });
    }

    return { memoriesProcessed: memories.length, success: true };
  }

  /**
   * Build human-readable scene summaries for the prompt,
   * and collect the list of existing scene filenames (relative).
   *
   * Includes a capacity counter at the top (e.g. "当前场景总数：5 / 15")
   * so the LLM can immediately see how close it is to the limit.
   */
  private buildSceneSummaries(
    index: SceneIndexEntry[],
  ): { summaries: string; filenames: string[] } {
    if (index.length === 0) return { summaries: "", filenames: [] };

    const lines: string[] = [];
    const filenames: string[] = [];

    // Inject capacity counter at the top — LLM sees this first
    lines.push(`**当前场景总数：${index.length} / ${this.maxScenes}**`);
    lines.push("");

    for (const entry of index) {
      filenames.push(entry.filename);
      lines.push(`### ${entry.filename}`);
      lines.push(`**热度**: ${entry.heat} | **更新**: ${entry.updated}`);
      lines.push(`**summary**: ${entry.summary}`);
      lines.push("");
    }
    return { summaries: lines.join("\n"), filenames };
  }

  /**
   * Update the scene navigation section at the end of persona.md.
   *
   * Reads the current scene index, generates the navigation block, then
   * strips any existing navigation from persona.md and appends the new one.
   *
   * IMPORTANT: If the persona body is empty (PersonaGenerator hasn't run yet),
   * we skip writing to avoid creating a persona.md that only contains the
   * scene navigation. PersonaGenerator.generate() will write the full
   * persona + navigation when it runs.
   * 中文：更新人物md文件末尾的场景导航部分。读取当前场景索引，生成导航块，然后从人物md中移除任何现有导航并追加新的。重要的是：如果人物主体为空（尚未运行PersonaGenerator），则跳过写入以避免创建仅包含场景导航的人物md文件。当PersonaGenerator.generate()运行时会写入完整的人物+导航。
   */
  private async updateSceneNavigation(): Promise<void> {
    const personaPath = path.join(this.dataDir, "persona.md");
    const index = await readSceneIndex(this.dataDir);
    const nav = generateSceneNavigation(index);

    let existing = "";
    try {
      existing = await fs.readFile(personaPath, "utf-8");
    } catch {
      // No persona file yet — PersonaGenerator will create it with navigation.
      // Don't write a navigation-only file.
      // 中文：尚未有人物文件——PersonaGenerator将创建它并包含导航。不要编写只包含导航的文件。
      this.logger?.debug?.(`${TAG} updateSceneNavigation() skipped: no persona file yet, waiting for PersonaGenerator`);
      return;
    }

    if (!existing.trim() && !nav) return;

    const stripped = stripSceneNavigation(existing).trimEnd();

    // If the persona body is empty (only navigation existed), don't overwrite
    // with a navigation-only file. Let PersonaGenerator handle full generation.
    // 中文：如果人物主体为空（只有导航存在），不要用只包含导航的文件覆盖。让PersonaGenerator处理完整的生成。
    if (!stripped) {
      this.logger?.debug?.(`${TAG} updateSceneNavigation() skipped: persona body is empty, waiting for PersonaGenerator`);
      return;
    }

    const updated = nav ? `${stripped}\n\n${nav}\n` : `${stripped}\n`;

    // persona.md is at dataDir root, no subdir needed
    // 中文：人物md文件位于dataDir根目录，无需子目录
    await fs.writeFile(personaPath, updated, "utf-8");
  }
}

function formatTimestamp(d: Date): string {
  return formatForLLM(d);
}
