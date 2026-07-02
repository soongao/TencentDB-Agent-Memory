/**
 * Seed runtime: L0→L1→L2→L3 orchestration for the `seed` command.
 *
 * Uses the shared pipeline-factory for VectorStore/EmbeddingService init,
 * L1 runner, L2 runner, L3 runner, and persister wiring — keeping this
 * module focused on seed-specific concerns:
 * - Synchronous per-round L0 capture with progress reporting
 * - waitForL1Idle polling (L1 only — see FIXME below)
 * - Ctrl+C graceful shutdown
 *
 * FIXME: Currently we only wait for L1 to become idle before destroying the
 * pipeline.  L2 (scene extraction) and L3 (persona generation) may still be
 * in-flight when `pipeline.destroy()` is called.  This is intentional for now
 * to avoid excessively long seed runs, but means seed output may not include
 * the latest L2/L3 artifacts.  Re-evaluate adding a full L1+L2+L3 idle wait
 * once pipeline-manager exposes reliable L2/L3 idle signals.
 * 中文：种子运行时：L0→L1→L2→L3编排用于`seed`命令。
 * 使用共享的pipeline-factory初始化VectorStore/EmbeddingService，
 * L1运行器、L2运行器、L3运行器和持久化绑定——保持此模块专注于种子特定的问题：
 * - 每轮同步捕获并报告进度
 * - waitForL1Idle轮询（仅限L1 — 请参阅下方的FIXME）
 * - Ctrl+C优雅关闭
 * FIXME：目前我们只在销毁pipeline前等待L1空闲。L2（场景提取）和L3（人物生成）可能仍在进行中时`pipeline.destroy()`被调用。这是为了防止种子运行时间过长而故意为之，但意味着种子输出可能不包含最新的L2/L3成果。一旦pipeline-manager提供可靠的L2/L3空闲信号，重新评估是否添加完整的L1+L2+L3空闲等待。
 */

import path from "node:path";
import { parseConfig } from "../../config.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { performAutoCapture } from "../hooks/auto-capture.js";
import { createPipeline, createL2Runner, createL3Runner } from "../../utils/pipeline-factory.js";
import type { PipelineInstance, PipelineLogger } from "../../utils/pipeline-factory.js";
import { readManifest, writeManifest } from "../../utils/manifest.js";
import { StandaloneLLMRunnerFactory } from "../../adapters/standalone/llm-runner.js";
import type { MemoryPipelineManager } from "../../utils/pipeline-manager.js";
import type { LLMRunner } from "../types.js";
import type {
  NormalizedInput,
  SeedProgress,
  SeedSummary,
} from "./types.js";

const TAG = "[memory-tdai] [seed]";

// ============================
// Seed pipeline options
// ============================
// 中文：种子管道选项

export interface SeedRuntimeOptions {
  /** Directory to store all seed output (L0, checkpoint, vectors.db). */
  /** 中文：用于存储所有种子输出（L0、检查点、vectors.db）的目录。 */
  outputDir: string;
  /** OpenClaw config object (needed for LLM calls in L1). */
  /** 中文：OpenClaw配置对象（在L1中进行LLM调用所需）。 */
  openclawConfig: unknown;
  /** Raw plugin config (same shape as api.pluginConfig). */
  /** 中文：原始插件配置（与api.pluginConfig形状相同）。 */
  pluginConfig?: Record<string, unknown>;
  /** Original input file path (for manifest traceability). */
  /** 中文：原始输入文件路径（用于元数据可追溯性）。 */
  inputFile?: string;
  /** Logger instance. */
  /** 中文：日志实例。 */
  logger: PipelineLogger;
  /** Progress callback (called after each round). */
  /** 中文：进度回调（每轮后调用）。 */
  onProgress?: (progress: SeedProgress) => void;
}

// ============================
// Seed pipeline creation
// ============================
// 中文：种子管道创建

/**
 * Create a seed pipeline using the shared factory, with L2/L3 runners
 * wired via shared factory functions (same logic as index.ts live runtime).
 * 中文：使用共享工厂创建种子管道，通过共享工厂函数连接L2/L3运行器（逻辑与index.ts在线运行时相同）
 */
async function createSeedPipeline(opts: SeedRuntimeOptions): Promise<{ pipeline: PipelineInstance; cfg: MemoryTdaiConfig }> {
  const { outputDir, openclawConfig, pluginConfig, logger } = opts;

  // Parse config — all values come from pluginConfig (or parseConfig defaults)
  // 中文：解析配置——所有值均来自pluginConfig（或parseConfig默认值）
  const cfg = parseConfig(pluginConfig);

  logger.info(
    `${TAG} Creating seed pipeline: outputDir=${outputDir}, ` +
    `everyN=${cfg.pipeline.everyNConversations}, l1Idle=${cfg.pipeline.l1IdleTimeoutSeconds}s, ` +
    `l2Delay=${cfg.pipeline.l2DelayAfterL1Seconds}s, l2Min=${cfg.pipeline.l2MinIntervalSeconds}s, l2Max=${cfg.pipeline.l2MaxIntervalSeconds}s`,
  );

  // Create standalone LLM runners if cfg.llm is configured.
  // Seed always runs outside OpenClaw, so it needs standalone runners
  // unless an explicit openclawConfig is provided (rare).
  // 中文：如果cfg.llm已配置，则创建独立的LLM运行器。种子始终在OpenClaw外部运行，因此除非提供了显式的openclawConfig（很少见），否则需要独立的运行器
  let l1LlmRunner: LLMRunner | undefined;
  let l2l3LlmRunner: LLMRunner | undefined;

  if (cfg.llm.enabled && cfg.llm.apiKey) {
    const runnerFactory = new StandaloneLLMRunnerFactory({
      config: {
        baseUrl: cfg.llm.baseUrl,
        apiKey: cfg.llm.apiKey,
        model: cfg.llm.model,
        maxTokens: cfg.llm.maxTokens,
        timeoutMs: cfg.llm.timeoutMs,
        disableThinking: cfg.llm.disableThinking,
      },
      logger,
    });
    l1LlmRunner = runnerFactory.createRunner({ enableTools: false });
    l2l3LlmRunner = runnerFactory.createRunner({ enableTools: true });
    logger.info(`${TAG} Seed using standalone LLM: model=${cfg.llm.model}`);
  }

  // Use shared factory for everything: store init, L1 runner, persister, destroy
  // 中文：使用共享工厂处理一切：存储初始化、L1运行器、持久化、销毁
  const pipeline = await createPipeline({
    pluginDataDir: outputDir,
    cfg,
    openclawConfig,
    logger,
    l1LlmRunner,
  });

  // Wire L2 runner via shared factory (same logic as index.ts live runtime)
  // 中文：通过共享工厂连接L2运行器（逻辑与index.ts在线运行时相同）
  pipeline.scheduler.setL2Runner(createL2Runner({
    pluginDataDir: outputDir,
    cfg,
    openclawConfig,
    vectorStore: pipeline.vectorStore,
    logger,
    llmRunner: l2l3LlmRunner,
  }));

  // Wire L3 runner via shared factory (same logic as index.ts live runtime)
  // 中文：通过共享工厂连接L3运行器（逻辑与index.ts在线运行时相同）
  pipeline.scheduler.setL3Runner(createL3Runner({
    pluginDataDir: outputDir,
    cfg,
    openclawConfig,
    vectorStore: pipeline.vectorStore,
    logger,
    llmRunner: l2l3LlmRunner,
  }));

  return { pipeline, cfg };
}

// ============================
// waitForL1Idle
// ============================
// 中文：等待L1空闲

/**
 * Poll pipeline queue status until L1 is idle for a given session.
 * Modeled after benchmark-ingest.ts waitForPipelineIdle() but focused on L1 only.
 * 中文：直到给定会话的L1管道队列空闲，检查L1管道队列状态。
 * 参考benchmark-ingest.ts中的waitForPipelineIdle()实现，但仅关注L1.
 */
async function waitForL1Idle(
  scheduler: MemoryPipelineManager,
  sessionKeys: string[],
  logger: PipelineLogger,
  opts: {
    pollIntervalMs?: number;
    stableRounds?: number;
    maxWaitMs?: number;
  } = {},
): Promise<void> {
  const pollInterval = opts.pollIntervalMs ?? 1_000;
  const stableRounds = opts.stableRounds ?? 3;
  const maxWait = opts.maxWaitMs ?? 300_000; // 5 min default
  // 中文：5 min默认

  const startTime = Date.now();
  let consecutiveIdle = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > maxWait) {
      logger.warn(`${TAG} [waitL1] Max wait time reached (${(maxWait / 1000).toFixed(0)}s), proceeding`);
      break;
    }

    const queues = scheduler.getQueueSizes();

    // Check per-session: buffered messages + conversation count
    // 中文：每一会话：检查缓冲消息数+对话数量
    let totalBuffered = 0;
    let totalConversationCount = 0;
    for (const key of sessionKeys) {
      totalBuffered += scheduler.getBufferedMessageCount(key);
      const state = scheduler.getSessionState(key);
      if (state) {
        totalConversationCount += state.conversation_count;
      }
    }

    const isIdle =
      queues.l1Idle &&
      totalBuffered === 0 &&
      totalConversationCount === 0;

    if (isIdle) {
      consecutiveIdle++;
      if (consecutiveIdle >= stableRounds) {
        logger.debug?.(`${TAG} [waitL1] L1 stable for ${stableRounds} consecutive polls`);
        return;
      }
    } else {
      consecutiveIdle = 0;
      logger.debug?.(
        `${TAG} [waitL1] Waiting: l1Queue=${queues.l1}, l1Pending=${queues.l1Pending}, l1Idle=${queues.l1Idle}, ` +
        `buffered=${totalBuffered}, convCount=${totalConversationCount}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

// ============================
// Main execution function
// ============================
// 中文：主执行函数

/**
 * Execute the seed pipeline: feed normalized input through L0 → L1.
 *
 * L2/L3 runners are wired but their completion is **not** awaited — see the
 * module-level FIXME.  The pipeline is destroyed after L1 idle, so L2/L3 may
 * be interrupted mid-run.
 *
 * This is the core runtime called by `src/cli/commands/seed.ts` after
 * all input validation and user confirmation are complete.
 * 中文：执行种子管道：将规范化输入通过L0 → L1传递。
 * L2/L3运行器已连接，但其完成情况**不**等待——参见
 * 模块级别的FIXME。在L1空闲后销毁管道，因此L2/L3可能在运行中被中断。
 * 这是由`src/cli/commands/seed.ts`调用的核心运行时，在所有输入验证和用户确认完成后调用。
 */
export async function executeSeed(
  input: NormalizedInput,
  opts: SeedRuntimeOptions,
): Promise<SeedSummary> {
  const { logger, onProgress } = opts;
  const startTime = Date.now();

  // Track interrupt signal
  // 中文：跟踪中断信号
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) {
      // Second Ctrl+C — force exit
      // 中文：第二次Ctrl+C — 强制退出
      logger.warn(`${TAG} Force exit (second Ctrl+C)`);
      process.exit(1);
    }
    interrupted = true;
    logger.warn(`${TAG} Interrupt received, finishing current round and shutting down...`);
  };
  process.on("SIGINT", onSigint);

  let pipeline: PipelineInstance | undefined;
  let totalL0Recorded = 0;
  let roundsProcessed = 0;

  try {
    // Create and start pipeline (returns both the pipeline instance and the
    // seed-optimized config so we don't need to parse config again)
    // 中文：创建并启动管道（返回管道实例以及种子优化配置，以便我们无需再次解析配置）
    const seed = await createSeedPipeline(opts);
    pipeline = seed.pipeline;
    const seedCfg = seed.cfg;

    pipeline.scheduler.start({});
    logger.info(`${TAG} Pipeline started, processing ${input.sessions.length} session(s), ${input.totalRounds} round(s)`);

    // Seed-specific: use 0 so the cold-start guard in captureAtomically()
    // does NOT filter out historical messages. In live mode Date.now()
    // prevents the first agent_end from dumping full session history,
    // but seed intentionally feeds all historical data.
    // 中文：针对种子：使用0使得captureAtomically()中的冷启动防护
    // 不过滤历史消息。在实时模式中Date.now()防止首次agent_end从输出完整会话历史记录，
    // 但种子故意提供所有历史数据。
    const captureStartTimestamp = 0;

    // Process each session → each round
    // Key invariant: after every everyNConversations rounds we must wait for L1
    // to finish before feeding more rounds. Without this pause the for-loop
    // would dump all rounds into L0 back-to-back and L1 would only run once
    // with the full batch (defeating the "every N" batching semantics).
    // 中文：逐个处理每个会话→每轮对话
    // 关键不变量：在每everyNConversations轮对话后，我们必须等待L1完成后再喂入更多轮次。如果没有这个暂停，for-loop将会连续将所有轮次倒入L0中，并且L1只会运行一次完整的批次（违背了“每隔N个”的分批语义）。
    const everyN = seedCfg.pipeline.everyNConversations;

    for (const session of input.sessions) {
      if (interrupted) break;

      logger.info(`${TAG} Session: key="${session.sessionKey}" id="${session.sessionId}" rounds=${session.rounds.length}`);

      for (let ri = 0; ri < session.rounds.length; ri++) {
        if (interrupted) break;

        const round = session.rounds[ri]!;
        roundsProcessed++;

        // Build messages in the format expected by performAutoCapture.
        // Field must be named "timestamp" (not "ts") because l0-recorder's
        // extractUserAssistantMessages reads m.timestamp for incremental filtering.
        // 中文：按照performAutoCapture期望的格式构建消息。
        // 字段必须命名为"timestamp"（而不是"ts"），因为l0-recorder的extractUserAssistantMessages通过读取m.timestamp来进行增量过滤。
        const messages = round.messages.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        }));

        try {
          const result = await performAutoCapture({
            messages,
            sessionKey: session.sessionKey,
            sessionId: session.sessionId,
            cfg: seedCfg,
            pluginDataDir: opts.outputDir,
            logger,
            scheduler: pipeline.scheduler,
            pluginStartTimestamp: captureStartTimestamp,
            vectorStore: pipeline.vectorStore,
            embeddingService: pipeline.embeddingService,
          });

          totalL0Recorded += result.l0RecordedCount;
        } catch (err) {
          logger.error(
            `${TAG} L0 capture failed for session="${session.sessionKey}" round=${ri}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Report progress
        // 中文：报告进度
        onProgress?.({
          currentRound: roundsProcessed,
          totalRounds: input.totalRounds,
          sessionKey: session.sessionKey,
          stage: "l0_captured",
        });

        // After every N rounds, wait for the triggered L1 to finish before
        // feeding the next batch. This keeps L1 batches aligned with the
        // everyNConversations boundary instead of letting all rounds pile up.
        // 中文：在每N轮对话后，等待触发的L1完成后再喂入下一批次。这保持了L1批次与everyNConversations边界对齐，而不是让所有轮次堆积在一起。
        const roundInSession = ri + 1; // 1-based
        if (roundInSession % everyN === 0 && !interrupted) {
          onProgress?.({
            currentRound: roundsProcessed,
            totalRounds: input.totalRounds,
            sessionKey: session.sessionKey,
            stage: "l1_waiting",
          });

          logger.info(
            `${TAG} Pausing after round ${roundInSession}/${session.rounds.length} ` +
            `for session="${session.sessionKey}" — waiting for L1 to drain`,
          );

          await waitForL1Idle(
            pipeline.scheduler,
            [session.sessionKey],
            logger,
            { pollIntervalMs: 500, stableRounds: 2, maxWaitMs: 120_000 },
          );
        }
      }

      // After all rounds for this session, wait for any residual L1 work
      // (handles the tail when total rounds is not a multiple of everyN)
      // 中文：在本会话的所有轮次完成后，等待任何残留的L1工作完成
      // （处理当总轮次数不是everyN的倍数时的尾部情况）
      if (!interrupted) {
        onProgress?.({
          currentRound: roundsProcessed,
          totalRounds: input.totalRounds,
          sessionKey: session.sessionKey,
          stage: "l1_waiting",
        });

        await waitForL1Idle(
          pipeline.scheduler,
          [session.sessionKey],
          logger,
          { pollIntervalMs: 1_000, stableRounds: 3, maxWaitMs: 300_000 },
        );

        logger.info(`${TAG} L1 idle for session="${session.sessionKey}"`);
      }
    }

    // Final wait for all sessions
    // 中文：最后等待所有会话完成
    if (!interrupted) {
      const allKeys = input.sessions.map((s) => s.sessionKey);
      logger.info(`${TAG} Final L1 idle wait for all sessions...`);
      await waitForL1Idle(
        pipeline.scheduler,
        allKeys,
        logger,
        { pollIntervalMs: 1_000, stableRounds: 3, maxWaitMs: 300_000 },
      );
    }
  } finally {
    process.removeListener("SIGINT", onSigint);

    // Graceful shutdown
    // 中文：优雅地关闭
    if (pipeline) {
      try {
        await pipeline.destroy();
      } catch (err) {
        logger.error(`${TAG} Pipeline destroy error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const durationMs = Date.now() - startTime;

  const summary: SeedSummary = {
    sessionsProcessed: input.sessions.length,
    roundsProcessed,
    messagesProcessed: input.totalMessages,
    l0RecordedCount: totalL0Recorded,
    durationMs,
    outputDir: opts.outputDir,
  };

  if (interrupted) {
    logger.warn(`${TAG} Seed interrupted after ${roundsProcessed}/${input.totalRounds} rounds`);
  } else {
    logger.info(
      `${TAG} Seed complete: sessions=${summary.sessionsProcessed}, ` +
      `rounds=${summary.roundsProcessed}, messages=${summary.messagesProcessed}, ` +
      `l0Recorded=${summary.l0RecordedCount}, duration=${(durationMs / 1000).toFixed(1)}s`,
    );
  }

  // Append seed info to manifest (non-fatal if it fails)
  // 中文：将种子信息追加到清单中（如果失败则非致命）
  try {
    const manifest = readManifest(opts.outputDir);
    if (manifest) {
      manifest.seed = {
        inputFile: opts.inputFile ? path.basename(opts.inputFile) : undefined,
        sessions: summary.sessionsProcessed,
        rounds: summary.roundsProcessed,
        messages: summary.messagesProcessed,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
      };
      writeManifest(opts.outputDir, manifest);
      logger.info(`${TAG} Manifest updated with seed info`);
    }
  } catch (err) {
    logger.warn(`${TAG} Failed to update manifest with seed info (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  return summary;
}
