/**
 * auto-capture hook (v3): records conversation messages locally (L0),
 * then notifies the MemoryPipelineManager for L1/L2/L3 scheduling.
 *
 * Key design decisions:
 * - Always write L0 locally via l0-recorder.
 * - When VectorStore + EmbeddingService are available, also write L0 vector index.
 * - Notify MemoryPipelineManager for L1/L2/L3 trigger evaluation.
 * - L1 Runner reads from VectorStore DB (primary) or L0 JSONL files (fallback).
 * - Extraction is NOT triggered here. The pipeline manager decides when.
 * 中文：自动捕获挂钩（v3）：在本地记录对话消息（L0），然后通知MemoryPipelineManager进行L1/L2/L3调度。
 * 关键设计决策包括：
 * - 始终通过l0-recorder将L0数据本地写入。
 * - 当向量存储+嵌入式服务可用时，也写入L0向量索引。
 * - 通知MemoryPipelineManager进行L1/L2/L3触发评估。
 * - L1运行器从向量存储数据库（主）或L0 JSONL文件（备用）读取数据。
 * - 不在此处触发提取。由管道管理器决定何时触发。
 */

import crypto from "node:crypto";
import type { MemoryTdaiConfig } from "../../config.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import type { MemoryPipelineManager } from "../../utils/pipeline-manager.js";
import { recordConversation } from "../conversation/l0-recorder.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { IMemoryStore, L0Record } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";

import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [capture]";

export interface AutoCaptureResult {
  /** Whether the scheduler was notified (conversation count incremented) */
  /** 中文：调度程序是否已通知（对话计数增加) */
  schedulerNotified: boolean;
  /** Number of messages recorded to L0 */
  /** 中文：记录到L0的消息数量 */
  l0RecordedCount: number;
  /** Number of L0 message vectors written */
  /** 中文：写入的L0消息向量数量 */
  l0VectorsWritten: number;
  /** Filtered messages for L1 immediate use */
  /** 中文：供L1立即使用的过滤后消息 */
  filteredMessages: ConversationMessage[];
}

/**
 * Generate a unique L0 record ID for vector indexing.
 * Includes an index to distinguish multiple messages within the same round.
 * 中文：为向量索引生成唯一的L0记录ID。
 * 包括一个索引来区分同一轮次内的多条消息。
 */
function generateL0RecordId(sessionKey: string, index: number): string {
  return `l0_${sessionKey}_${Date.now()}_${index}_${crypto.randomBytes(3).toString("hex")}`;
}

export async function performAutoCapture(params: {
  messages: unknown[];
  sessionKey: string;
  sessionId?: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  scheduler?: MemoryPipelineManager;
  /** Clean original user prompt from before_prompt_build cache (pre-prependContext). */
  /** 中文：清理before_prompt_build缓存中的原始用户提示（pre-prependContext）。 */
  originalUserText?: string;
  /**
   * Number of messages in the session at before_prompt_build time.
   * Used by l0-recorder to locate the exact user message that originalUserText
   * corresponds to: rawMessages[originalUserMessageCount] is the polluted user message.
   * 中文：在before_prompt_build时刻会话中消息的数量。
   * 用于l0-recorder定位originalUserText对应的精确用户消息：rawMessages[originalUserMessageCount]是被污染的用户消息。
   */
  originalUserMessageCount?: number;
  /** Epoch ms when the plugin was registered (cold-start time).
   *  Used as fallback cursor when checkpoint has no prior timestamp —
   * 中文：插件注册时的epoch毫秒时间（冷启动时间）。用于在检查点没有先前时间戳时作为回退游标——防止第一次agent_end将所有会话历史记录一次性dump到L0。
   *  prevents the first agent_end from dumping all session history into L0. */
  pluginStartTimestamp?: number;
  /** VectorStore for L0 vector indexing (optional). */
  /** 中文：L0向量索引的VectorStore（可选）。 */
  vectorStore?: IMemoryStore;
  /** EmbeddingService for L0 vector indexing (optional). */
  /** 中文：L0向量索引的EmbeddingService（可选）。 */
  embeddingService?: EmbeddingService;
  /**
   * Tracks in-flight fire-and-forget background tasks started by this
   * capture (currently: deferred L0 embedding for SQLite-style stores).
   *
   * When provided, each background task's Promise is added to the set
   * on creation and removed on completion.  This lets the owning
   * ``TdaiCore`` instance await all pending background work before
   * closing ``vectorStore`` / ``embeddingService`` in ``destroy()``,
   * so we never hit an already-closed DB connection with a late
   * ``updateL0Embedding`` call.
   *
   * Optional for backwards compatibility — callers that don't care
   * (tests, short-lived CLI invocations) can omit it and accept the
   * pre-fix behaviour (background task may outlive its owner).
   * 中文：跟踪由此捕获启动的所有在途的fire-and-forget后台任务（当前：SQLite风格存储的延迟L0嵌入）。如果提供，每个后台任务的Promise将在创建时添加到集合中，并在完成时移除。这使得拥有``TdaiCore``实例能够在关闭``vectorStore`` / ``embeddingService``之前等待所有待处理的后台工作，从而避免在``destroy()``方法中收到一个已经关闭的数据库连接上的延迟``updateL0Embedding``调用。
   * 为了向后兼容——不关心的调用者（如测试、短暂的命令行调用）可以省略它并接受预先的行为（后台任务可能超出其所有者的生命期）。
   */
  bgTaskRegistry?: Set<Promise<void>>;
}): Promise<AutoCaptureResult> {
  const {
    messages, sessionKey, sessionId, cfg, pluginDataDir, logger, scheduler,
    originalUserText, originalUserMessageCount, pluginStartTimestamp,
    vectorStore, embeddingService, bgTaskRegistry,
  } = params;
  const tCaptureStart = performance.now();

  const checkpoint = new CheckpointManager(pluginDataDir, logger);

  // ============================
  // Step 1 + 2: L0 recording + checkpoint update (ATOMIC)
  // ============================
  // These steps are combined inside captureAtomically() to prevent the race
  // condition where two concurrent agent_end events both read the same stale
  // cursor and produce duplicate L0 records. The file lock is held for the
  // entire read-cursor → recordConversation → advance-cursor sequence.
  // 中文：步骤1 + 2：L0录制+检查点更新（原子操作）
  // 这些步骤组合在captureAtomically()内部以防止两个并发的agent_end事件同时读取相同的过时游标并生成重复的L0记录。在整个读取游标 → 记录对话 → 进一步游标的序列中保持文件锁。
  const tL0RecordStart = performance.now();
  let filteredMessages: ConversationMessage[] = [];
  try {
    await checkpoint.captureAtomically(
      sessionKey,
      pluginStartTimestamp,
      async (afterTimestamp) => {
        logger?.debug?.(`${TAG} L0 capture cursor (per-session, atomic): afterTimestamp=${afterTimestamp} session=${sessionKey}`);

        if (afterTimestamp === pluginStartTimestamp && pluginStartTimestamp && pluginStartTimestamp > 0) {
          logger?.debug?.(
            `${TAG} No per-session checkpoint cursor found for session=${sessionKey} — ` +
            `using pluginStartTimestamp as floor: ` +
            `${afterTimestamp} (${new Date(afterTimestamp).toISOString()})`,
          );
        }

        filteredMessages = await recordConversation({
          sessionKey,
          sessionId,
          rawMessages: messages,
          baseDir: pluginDataDir,
          logger,
          originalUserText,
          afterTimestamp,
          originalUserMessageCount,
        });

        if (filteredMessages.length === 0) {
          return null; // Nothing captured — cursor stays unchanged
          // 中文：无捕获内容——光标保持不变
        }

        logger?.debug?.(`${TAG} L0 recorded: ${filteredMessages.length} messages for session ${sessionKey}`);
        const maxTs = Math.max(...filteredMessages.map((m) => m.timestamp));
        return { maxTimestamp: maxTs, messageCount: filteredMessages.length };
      },
    );
  } catch (err) {
    logger?.error(`${TAG} L0 recording failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tL0RecordEnd = performance.now();

  // ============================
  // Step 1.5: L0 vector indexing
  // ============================
  // Two paths depending on store capabilities:
  //
  // A) Store supports updateL0Embedding (sqlite):
  //    - Write metadata + FTS immediately WITHOUT embedding (~ms)
  //    - Fire-and-forget background task: embedBatch + updateL0Embedding
  //    - PERF: avoids blocking agent_end with 2-3s embedding calls
  //
  // B) Store does NOT support updateL0Embedding (VDB / remote):
  //    - Embed synchronously, then upsertL0 with embedding in one call
  //    - VDB backends handle embedding server-side or need it upfront
  // 中文：步骤1.5：L0向量索引
  // 两条路径取决于存储能力：
  // A) 存储支持updateL0Embedding（sqlite）：
  // - 立即写入元数据+全文搜索，不嵌入（毫秒级）
  // - fire-and-forget后台任务：embedBatch + updateL0Embedding
  // - 性能优化：避免在agent_end中阻塞2-3s的嵌入调用
  // B) 存储不支持updateL0Embedding（VDB / 远程）：
  // - 同步嵌入，然后在一个调用中upsertL0带嵌入
  // - VDB后端在服务器端处理嵌入或需要提前进行嵌入
  const tL0VecStart = performance.now();
  let l0VectorsWritten = 0;
  let l0EmbedTotalMs = 0;
  let l0UpsertTotalMs = 0;
  logger?.debug?.(
    `${TAG} [L0-vec-index] Check: filteredMessages=${filteredMessages.length}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}`,
  );

  const supportsBgEmbed = vectorStore?.supportsDeferredEmbedding === true;

  if (filteredMessages.length > 0 && vectorStore) {
    const now = new Date().toISOString();
    const bgRecords: Array<{ recordId: string; content: string }> = [];
    logger?.debug?.(
      `${TAG} [L0-vec-index] START indexing ${filteredMessages.length} message(s) for session ${sessionKey} ` +
      `(mode=${supportsBgEmbed ? "async-bg" : "sync"})`,
    );

    for (let i = 0; i < filteredMessages.length; i++) {
      const msg = filteredMessages[i];
      try {
        const l0Record: L0Record = {
          id: generateL0RecordId(sessionKey, i),
          sessionKey,
          sessionId: sessionId || "",
          role: msg.role,
          messageText: msg.content,
          recordedAt: now,
          timestamp: msg.timestamp,
        };

        let embedding: Float32Array | undefined;

        if (!supportsBgEmbed && embeddingService) {
          // Path B (VDB): embed synchronously — needed for upsertL0
          // Skip local embed when using server-side embedding (NoopEmbeddingService, dims=0)
          // 中文：路径B（VDB）：同步嵌入——使用服务器端嵌入时跳过本地嵌入（NoopEmbeddingService，维度=0）
          if (embeddingService.getDimensions() === 0) {
            logger?.debug?.(
              `${TAG} [L0-vec-index] Server-side embedding (dims=0), skipping local embed for message ${i}`,
            );
          } else {
            const tEmbedStart = performance.now();
            try {
              embedding = await embeddingService.embed(msg.content);
              l0EmbedTotalMs += performance.now() - tEmbedStart;
              logger?.debug?.(
                `${TAG} [L0-vec-index] Embedding OK: dims=${embedding.length}, ` +
                `norm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
              );
            } catch (embedErr) {
              l0EmbedTotalMs += performance.now() - tEmbedStart;
              logger?.warn(
                `${TAG} [L0-vec-index] Embedding FAILED for message ${i}, ` +
                `will write metadata only: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
              );
            }
          }
        }

        // Path A (sqlite): pass undefined embedding — metadata + FTS only
        // Path B (VDB): pass embedding (may be undefined on failure)
        // 中文：路径A（sqlite）：传递未定义的嵌入 — 仅元数据+全文搜索
        // 路径B（VDB）：传递嵌入（在失败时可能为undefined）
        const tUpsertStart = performance.now();
        const upsertOk = await vectorStore.upsertL0(l0Record, supportsBgEmbed ? undefined : embedding);
        l0UpsertTotalMs += performance.now() - tUpsertStart;

        if (upsertOk) {
          l0VectorsWritten++;
          if (supportsBgEmbed) {
            bgRecords.push({ recordId: l0Record.id, content: msg.content });
          }
        } else {
          logger?.warn(`${TAG} [L0-vec-index] upsertL0 returned false for message ${i}`);
        }
      } catch (err) {
        logger?.warn?.(`${TAG} [L0-vec-index] FAILED for message ${i} (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const modeLabel = supportsBgEmbed ? "metadata-only, embed=background" : `embed=${l0EmbedTotalMs.toFixed(0)}ms, upsert=${l0UpsertTotalMs.toFixed(0)}ms`;
    logger?.debug?.(`${TAG} [L0-vec-index] DONE: ${l0VectorsWritten}/${filteredMessages.length} records written (${modeLabel})`);

    // Path A only: fire-and-forget background embedding for sqlite stores
    // 中文：仅路径A：为sqlite存储后台异步嵌入
    if (supportsBgEmbed && bgRecords.length > 0 && embeddingService) {
      const bgVectorStore = vectorStore;
      const bgEmbeddingService = embeddingService;
      const bgSnapshot = [...bgRecords];
      const bgLogger = logger;

      // Do NOT await — runs in background after response is sent.
      //
      // Register the task in bgTaskRegistry (if provided) so TdaiCore.destroy()
      // can await it before closing vectorStore / embeddingService.  The
      // ``.finally`` clean-up ensures the entry is removed on both success
      // and failure; without that the set would leak and eventually block
      // shutdown indefinitely.
      // 中文：DO NOT await — 在响应发送后后台运行。
      // 在bgTaskRegistry（如有提供）中注册任务，以便TdaiCore.destroy()可以在关闭vectorStore / embeddingService前等待它。
      // ``.finally`` 清理确保无论成功或失败都会移除条目；否则集合会泄漏并在最终阻塞关闭操作。
      const bgPromise: Promise<void> = (async () => {
        const tBgStart = performance.now();
        try {
          const texts = bgSnapshot.map((r) => r.content);
          const embeddings = await bgEmbeddingService.embedBatch(texts);

          let bgUpdated = 0;
          for (let i = 0; i < bgSnapshot.length; i++) {
            try {
              const ok = await bgVectorStore.updateL0Embedding!(bgSnapshot[i].recordId, embeddings[i]);
              if (ok) bgUpdated++;
            } catch (err) {
              bgLogger?.warn?.(
                `${TAG} [L0-vec-index-bg] Failed to update embedding for ${bgSnapshot[i].recordId}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          const bgMs = performance.now() - tBgStart;
          bgLogger?.debug?.(
            `${TAG} [L0-vec-index-bg] Background embedding complete: ${bgUpdated}/${bgSnapshot.length} vectors updated (${bgMs.toFixed(0)}ms)`,
          );
        } catch (err) {
          const bgMs = performance.now() - tBgStart;
          bgLogger?.warn?.(
            `${TAG} [L0-vec-index-bg] Background embedding failed (${bgMs.toFixed(0)}ms, non-fatal): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();

      if (bgTaskRegistry) {
        bgTaskRegistry.add(bgPromise);
        void bgPromise.finally(() => {
          bgTaskRegistry.delete(bgPromise);
        });
      }
    }
  } else if (filteredMessages.length > 0) {
    logger?.warn(`${TAG} [L0-vec-index] SKIPPED: vectorStore not available`);
  }
  const tL0VecEnd = performance.now();

  // ============================
  // Step 3: Notify scheduler of this conversation round
  // ============================
  // 中文：第3步：通知调度器本次对话轮次
  const tNotifyStart = performance.now();
  // Pass empty array: L1 Runner reads from VectorStore DB (or L0 JSONL fallback), not from in-memory buffers.
  // 中文：传递空数组：L1运行器从VectorStore DB（或L0 JSONL回退）读取，不从内存缓冲区读取。
  if (scheduler) {
    await scheduler.notifyConversation(sessionKey, []);
    logger?.debug?.(`${TAG} Scheduler notified of conversation round (sessionKey=${sessionKey})`);

    const totalMs = performance.now() - tCaptureStart;
    const vecDetail = supportsBgEmbed
      ? `metadata-only, embed=background, msgs=${filteredMessages.length}`
      : `embed=${l0EmbedTotalMs.toFixed(0)}ms, upsert=${l0UpsertTotalMs.toFixed(0)}ms, msgs=${filteredMessages.length}`;
    logger?.info(
      `${TAG} ⏱ Capture timing: total=${totalMs.toFixed(0)}ms, ` +
      `l0Record+checkpoint=${(tL0RecordEnd - tL0RecordStart).toFixed(0)}ms, ` +
      `l0VecIndex=${(tL0VecEnd - tL0VecStart).toFixed(0)}ms (${vecDetail}), ` +
      `notify=${(performance.now() - tNotifyStart).toFixed(0)}ms`,
    );

    return {
      schedulerNotified: true,
      l0RecordedCount: filteredMessages.length,
      l0VectorsWritten,
      filteredMessages,
    };
  }

  const totalMs = performance.now() - tCaptureStart;
  const vecDetail = supportsBgEmbed
    ? `metadata-only, embed=background, msgs=${filteredMessages.length}`
    : `embed=${l0EmbedTotalMs.toFixed(0)}ms, upsert=${l0UpsertTotalMs.toFixed(0)}ms, msgs=${filteredMessages.length}`;
  logger?.info(
    `${TAG} ⏱ Capture timing: total=${totalMs.toFixed(0)}ms, ` +
    `l0Record+checkpoint=${(tL0RecordEnd - tL0RecordStart).toFixed(0)}ms, ` +
    `l0VecIndex=${(tL0VecEnd - tL0VecStart).toFixed(0)}ms (${vecDetail}), ` +
    `notify=${(performance.now() - tNotifyStart).toFixed(0)}ms`,
  );

  logger?.debug?.(`${TAG} No scheduler provided, skipping notification`);
  return {
    schedulerNotified: false,
    l0RecordedCount: filteredMessages.length,
    l0VectorsWritten,
    filteredMessages,
  };
}
