/**
 * PersonaTrigger: determines whether to trigger persona generation.
 * Implements the 5 trigger conditions from the legacy system.
 * 中文：PersonaTrigger: 确定是否触发人物生成。
 * 实现来自旧系统中的5个触发条件。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { stripSceneNavigation } from "../scene/scene-navigation.js";

import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [trigger]";

type TriggerLogger = Logger;

export interface TriggerResult {
  should: boolean;
  reason: string;
}

export class PersonaTrigger {
  private dataDir: string;
  private interval: number;
  private logger: TriggerLogger | undefined;

  constructor(opts: { dataDir: string; interval: number; logger?: TriggerLogger }) {
    this.dataDir = opts.dataDir;
    this.interval = opts.interval;
    this.logger = opts.logger;
  }

  async shouldGenerate(): Promise<TriggerResult> {
    const cpManager = new CheckpointManager(this.dataDir);
    const cp = await cpManager.read();
    this.logger?.debug?.(`${TAG} Evaluating: total_processed=${cp.total_processed}, last_persona_at=${cp.last_persona_at}, memories_since=${cp.memories_since_last_persona}, scenes=${cp.scenes_processed}`);

    // Priority 1: Agent explicitly requested persona update
    // 中文：优先级1：代理明确请求更新人物信息
    if (cp.request_persona_update) {
      const result: TriggerResult = {
        should: true,
        reason: `主动请求: ${cp.persona_update_reason || "Agent 请求更新"}`,
      };
      this.logger?.debug?.(`${TAG} Trigger P1 (explicit request): ${result.reason}`);
      return result;
    }

    // Priority 2: Cold start — first extraction done, no persona yet, has scene files
    // 中文：优先级2：冷启动——首次提取完成，尚未生成人物信息，但有场景文件
    if (
      cp.scenes_processed > 0 &&
      cp.last_persona_at === 0 &&
      (await this.hasSceneFiles())
    ) {
      const result: TriggerResult = { should: true, reason: "首次冷启动：首次提取完成且有场景文件" };
      this.logger?.debug?.(`${TAG} Trigger P2 (cold start): scenes_processed=${cp.scenes_processed}, total_processed=${cp.total_processed}`);
      return result;
    }

    // Priority 2.5: Recovery — persona was generated before but persona.md body
    // is now empty (corrupted/missing). Regenerate to restore.
    // 中文：优先级2.5：恢复——之前已生成过人物信息，但persona.md内容为空（损坏/丢失）。重新生成以恢复.
    if (
      cp.last_persona_at > 0 &&
      (await this.hasSceneFiles()) &&
      !(await this.hasPersonaBody())
    ) {
      const result: TriggerResult = { should: true, reason: "恢复：persona.md 正文丢失或为空，需要重新生成" };
      this.logger?.debug?.(`${TAG} Trigger P2.5 (recovery): last_persona_at=${cp.last_persona_at}, persona body missing`);
      return result;
    }

    // Priority 3: First scene block extraction
    // 中文：优先级3：首场景块提取
    if (cp.scenes_processed === 1 && cp.memories_since_last_persona > 0) {
      const result: TriggerResult = { should: true, reason: "首次 Scene Block 提取完成" };
      this.logger?.debug?.(`${TAG} Trigger P3 (first scene): scenes_processed=${cp.scenes_processed}`);
      return result;
    }

    // Priority 4: Reached threshold
    // 中文：优先级4：达到阈值
    if (cp.memories_since_last_persona >= this.interval) {
      const result: TriggerResult = {
        should: true,
        reason: `达到阈值: ${cp.memories_since_last_persona} >= ${this.interval}`,
      };
      this.logger?.debug?.(`${TAG} Trigger P4 (threshold): ${result.reason}`);
      return result;
    }

    this.logger?.debug?.(`${TAG} No trigger conditions met`);
    return { should: false, reason: "" };
  }

  private async hasSceneFiles(): Promise<boolean> {
    const blocksDir = path.join(this.dataDir, "scene_blocks");
    try {
      const files = await fs.readdir(blocksDir);
      const hasFiles = files.some((f) => f.endsWith(".md"));
      return hasFiles;
    } catch {
      return false;
    }
  }

  /**
   * Check whether persona.md has a non-empty body (excluding scene navigation).
   * Returns false if the file doesn't exist, is empty, or only contains
   * scene navigation (no actual persona content).
   * 中文：检查persona.md是否有非空主体（排除场景导航）。如果文件不存在、为空或仅包含
   * 场景导航（没有实际的人物内容），则返回false。
   */
  private async hasPersonaBody(): Promise<boolean> {
    const personaPath = path.join(this.dataDir, "persona.md");
    try {
      const raw = await fs.readFile(personaPath, "utf-8");
      const body = stripSceneNavigation(raw).trim();
      return body.length > 0;
    } catch {
      return false;
    }
  }
}
