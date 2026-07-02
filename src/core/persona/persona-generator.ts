/**
 * PersonaGenerator: generates or updates user persona using the four-layer
 * deep scan model via CleanContextRunner.
 * 中文：PersonaGenerator: 使用四层深度扫描模型通过CleanContextRunner生成或更新用户画像.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { formatForLLM } from "../../utils/time.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import { buildPersonaPrompt } from "../prompts/persona-generation.js";
import { BackupManager } from "../../utils/backup.js";
import { escapeXmlTags } from "../../utils/sanitize.js";
import { report } from "../report/reporter.js";
import type { LLMRunner, Logger } from "../types.js";

const TAG = "[memory-tdai] [persona]";

export class PersonaGenerator {
  private dataDir: string;
  private runner: LLMRunner;
  private logger: Logger | undefined;
  private backupCount: number;
  private instanceId: string | undefined;

  constructor(opts: {
    dataDir: string;
    config: unknown;
    model?: string;
    backupCount?: number;
    logger?: Logger;
    /** Plugin instance ID for metric reporting (optional) */
    /** 中文：Plugin实例ID用于指标报告（可选） */
    instanceId?: string;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * a CleanContextRunner (decouples from OpenClaw runtime).
     * Must be configured with `enableTools: true`.
     * 中文：主机无关的LLM运行器。当提供时，优先于创建CleanContextRunner使用（解耦自OpenClaw运行时）。
     * 必须配置`enableTools: true`。
     */
    llmRunner?: LLMRunner;
  }) {
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.backupCount = opts.backupCount ?? 3;
    this.instanceId = opts.instanceId;
    // Use injected LLMRunner if available, otherwise fall back to CleanContextRunner
    // 中文：如果可用，则使用注入的LLMRunner，否则回退到CleanContextRunner
    this.runner = opts.llmRunner ?? new CleanContextRunner({
      config: opts.config,
      modelRef: opts.model,
      enableTools: true,
      logger: opts.logger,
    });
    this.logger?.debug?.(`${TAG} Generator created: model=${opts.model ?? "(default)"}, dataDir=${opts.dataDir}`);
  }

  /**
   * Execute local persona generation without advancing checkpoint.
   * 中文：执行本地画像生成而不推进检查点。
   */
  async generateLocalPersona(triggerReason?: string): Promise<boolean> {
    const startMs = Date.now();
    this.logger?.debug?.(`${TAG} Starting generation: reason="${triggerReason ?? "none"}"`);

    const cpManager = new CheckpointManager(this.dataDir);
    const cp = await cpManager.read();
    this.logger?.debug?.(`${TAG} Checkpoint: total_processed=${cp.total_processed}, last_persona_at=${cp.last_persona_at}`);

    const personaPath = path.join(this.dataDir, "persona.md");

    // 1. Read existing persona (strip navigation)
    // 中文：1. 读取现有画像（去除导航）
    let existingPersona: string | undefined;
    try {
      const raw = await fs.readFile(personaPath, "utf-8");
      existingPersona = stripSceneNavigation(raw).trim() || undefined;
      this.logger?.debug?.(`${TAG} Existing persona: ${existingPersona ? `${existingPersona.length} chars` : "empty"}`);
    } catch {
      this.logger?.debug?.(`${TAG} No existing persona file`);
    }

    // 2. Load scene index + identify changed scenes
    // 中文：2. 加载场景索引+识别更改的场景
    const index = await readSceneIndex(this.dataDir);
    const changedScenes = index.filter((e) => {
      if (!cp.last_persona_time) return true;
      const updatedMs = new Date(e.updated).getTime();
      const personaMs = new Date(cp.last_persona_time).getTime();
      // If either date is unparseable (NaN), treat as changed (conservative)
      // 中文：若任一日期无法解析（NaN），视为更改（保守策略）
      if (Number.isNaN(updatedMs) || Number.isNaN(personaMs)) return true;
      return updatedMs > personaMs;
    });
    this.logger?.debug?.(`${TAG} Scene index: ${index.length} total, ${changedScenes.length} changed since last persona`);

    // 3. Read changed scene contents (full raw content including META, matching Python reference)
    // 中文：3. 读取更改的场景内容（包含完整的原始内容，包括META，匹配Python引用)
    const blocksDir = path.join(this.dataDir, "scene_blocks");
    const changedSceneContents: string[] = [];
    for (const entry of changedScenes) {
      try {
        const raw = await fs.readFile(path.join(blocksDir, entry.filename), "utf-8");
        changedSceneContents.push(
          `### [${changedSceneContents.length + 1}] ${entry.filename}\n\n\`\`\`markdown\n${raw}\n\`\`\``,
        );
      } catch {
        this.logger?.warn(`${TAG} Could not read scene block: ${entry.filename}`);
      }
    }

    if (changedSceneContents.length === 0 && existingPersona) {
      this.logger?.debug?.(`${TAG} No scene changes and persona exists, skipping generation`);
      return false;
    }

    // 4. Determine mode
    // 中文：4. 确定模式
    const mode = existingPersona ? "incremental" : "first";
    this.logger?.debug?.(`${TAG} Generation mode: ${mode}, ${changedSceneContents.length} scene blocks to process`);

    // 5. Build changed scenes section with guidance (matching Python reference format)
    // 中文：5. 根据指导构建更改的场景部分（匹配Python引用格式）
    let changedScenesContent: string;
    if (changedSceneContents.length > 0) {
      changedScenesContent =
        `\n\n## 📄 变化场景完整内容\n\n` +
        `*自上次 Persona 更新后，以下 ${changedSceneContents.length} 个场景发生了变化。工程已为你预加载完整内容：*\n\n` +
        changedSceneContents.join("\n\n") +
        `\n\n---\n\n` +
        `⚠️ **重点分析变化场景**：上述场景是自上次更新后的**新增/修改内容**，请**重点分析**这些场景中的新信息。\n`;
    } else {
      changedScenesContent = `\n\n⚠️ **无变化场景**：所有场景均已在上次 Persona 更新中分析过，本次可直接读取所有场景进行全局审视。\n`;
    }

    // 6. Build prompt
    // 中文：6. 构建提示
    const { systemPrompt, userPrompt } = buildPersonaPrompt({
      mode,
      currentTime: formatForLLM(new Date()),
      totalProcessed: cp.total_processed,
      sceneCount: index.length,
      changedSceneCount: changedScenes.length,
      changedScenesContent,
      existingPersona,
      triggerInfo: triggerReason,
      personaFilePath: personaPath,
      checkpointPath: path.join(this.dataDir, ".metadata", "recall_checkpoint.json"),
    });

    // 7. Backup before LLM run (LLM writes persona.md via tools)
    // 中文：7. 在LLM运行前备份（LLM通过tools写入persona.md）
    const bm = new BackupManager(path.join(this.dataDir, ".backup"));
    await bm.backupFile(personaPath, "persona", `offset${cp.total_processed}`, this.backupCount);

    // 8. Run LLM agent (sandboxed to dataDir, tools enabled — LLM writes persona.md directly)
    // 中文：8. 运行LLM代理（沙箱化到dataDir，启用tools——LLM直接写入persona.md)
    try {
      this.logger?.debug?.(`${TAG} Calling LLM for persona generation (timeout=180s, tools=enabled, workspaceDir=${this.dataDir})...`);
      await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: "persona-generation",
        timeoutMs: 180_000,
        // maxTokens omitted → core uses the resolved model's maxTokens from catalog
        // 中文：maxTokens 被省略 → 核心使用catalog中解析出的模型的最大token数
        workspaceDir: this.dataDir,
      });
      this.logger?.debug?.(`${TAG} LLM runner completed`);
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      this.logger?.error(`${TAG} Persona generation failed after ${elapsedMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return false;
    }

    // 9. Read LLM-written persona.md and apply post-processing
    // 中文：9. 读取LLM写的persona.md并应用后处理
    let personaText: string;
    try {
      personaText = await fs.readFile(personaPath, "utf-8");
    } catch {
      // LLM failed to write persona.md — treat as failure
      // 中文：LLM未能写入persona.md——视为失败
      this.logger?.error(`${TAG} LLM did not write persona.md — file not found after runner completed`);
      return false;
    }

    // 10. Strip any navigation the LLM might have added + sanitize for safe injection
    // 中文：10. 去除LLM可能添加的任何导航并进行安全清理
    personaText = escapeXmlTags(stripSceneNavigation(personaText).trim());

    if (!personaText) {
      this.logger?.error(`${TAG} LLM wrote empty persona.md — skipping`);
      return false;
    }

    // 11. Append fresh scene navigation and write final content
    // 中文：11. 添加新鲜场景导航并写出最终内容
    const nav = generateSceneNavigation(index);
    const finalContent = nav ? `${personaText}\n\n${nav}\n` : personaText;
    await fs.writeFile(personaPath, finalContent, "utf-8");

    const elapsedMs = Date.now() - startMs;
    this.logger?.info(`${TAG} Persona written (${finalContent.length} chars) in ${elapsedMs}ms`);

    // ── l3_persona_generation metric ──
    // 中文：── l3_persona_generation 指标 ──
    if (this.instanceId && this.logger) {
      report("l3_persona_generation", {
        triggerReason: triggerReason ?? "unknown",
        mode: existingPersona ? "incremental" : "initial",
        newPersonaContent: personaText,
        newPersonaLength: personaText.length,
        totalDurationMs: elapsedMs,
        success: true,
        error: null,
      });
    }

    return true;
  }

  /**
   * Backward-compatible wrapper: local generation + checkpoint advance.
   * 中文：向后兼容包装器：本地生成+检查点前进。
   */
  async generate(triggerReason?: string): Promise<boolean> {
    const updated = await this.generateLocalPersona(triggerReason);
    if (!updated) return false;

    const cpManager = new CheckpointManager(this.dataDir);
    const cp = await cpManager.read();
    await cpManager.markPersonaGenerated(cp.total_processed);
    return true;
  }
}
