/**
 * Pipeline factory: shared infrastructure for creating and wiring
 * MemoryPipelineManager instances with VectorStore, EmbeddingService,
 * L1 runner, L2 runner, L3 runner, and persister.
 *
 * Used by both:
 * - `index.ts` (live plugin runtime)
 * - `seed-runtime.ts` (standalone seed CLI command)
 *
 * This avoids duplicating VectorStore init, L1/L2/L3 extraction logic,
 * persister wiring, and destroy sequences across multiple callers.
 * 中文：管道工厂：创建和连接MemoryPipelineManager实例与VectorStore、EmbeddingService、L1运行器、L2运行器、L3运行器及持久化器的共享基础设施。被以下两者使用：
 * - `index.ts`（实时插件运行时）
 * - `seed-runtime.ts`（独立种子CLI命令）
 * 这避免了在多个调用者中重复VectorStore初始化、L1/L2/L3提取逻辑、持久化器连接及销毁序列。
 */

import fs from "node:fs";
import path from "node:path";
import type { MemoryTdaiConfig } from "../config.js";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { L2Runner, L3Runner } from "./pipeline-manager.js";
import { SessionFilter } from "./session-filter.js";
import { extractL1Memories } from "../core/record/l1-extractor.js";
import { readConversationMessagesGroupedBySessionId } from "../core/conversation/l0-recorder.js";
import type { ConversationMessage } from "../core/conversation/l0-recorder.js";
import { CheckpointManager } from "./checkpoint.js";
import type { PipelineSessionState } from "./checkpoint.js";
import { createStoreBundle } from "../core/store/factory.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import {
  readManifest,
  writeManifest,
  buildStoreInfo,
  diffStoreBinding,
  type Manifest,
} from "./manifest.js";
import { SceneExtractor } from "../core/scene/scene-extractor.js";
import { PersonaTrigger } from "../core/persona/persona-trigger.js";
import { PersonaGenerator } from "../core/persona/persona-generator.js";
import { pullProfilesToLocal, syncLocalProfilesToStore } from "../core/profile/profile-sync.js";
import type { Logger } from "../core/types.js";

const TAG = "[memory-tdai] [pipeline-factory]";

function supportsProfileSyncWrite(store?: IMemoryStore): boolean {
  return !!(store?.syncProfiles || store?.deleteProfiles);
}

// ============================
// Logger interface
// ============================
// 中文：日志记录接口

/** @deprecated Use `Logger` from `../core/types.js` directly. */
/** 中文：@deprecated 请直接使用来自`../core/types.js`的`Logger`。 */
export type PipelineLogger = Logger;

// ============================
// Factory options
// ============================
// 中文：工厂选项

export interface PipelineFactoryOptions {
  /** Plugin data directory (L0, records, scene_blocks, vectors.db, etc.). */
  /** 中文：插件数据目录（L0，记录，场景块，vectors.db等）。 */
  pluginDataDir: string;
  /** Parsed memory-tdai config. */
  /** 中文：解析后的memory-tdai配置。 */
  cfg: MemoryTdaiConfig;
  /** OpenClaw config object (needed for LLM calls in L1). */
  /** 中文：OpenClaw配置对象（用于L1中的LLM调用）。 */
  openclawConfig: unknown;
  /** Logger instance. */
  /** 中文：日志记录实例。 */
  logger: PipelineLogger;
  /** Session filter (optional, defaults to empty). */
  /** 中文：会话过滤器（可选，默认为空）. */
  sessionFilter?: SessionFilter;
  /** Host-neutral LLM runner for L1 extraction (text-only, enableTools=false). */
  /** 中文：无主机的LLM运行器用于L1提取（仅文本，enableTools=false）。 */
  l1LlmRunner?: import("../core/types.js").LLMRunner;
  /** Host-neutral LLM runner for L2/L3 (tool-call enabled, enableTools=true). */
  /** 中文：无主机的LLM运行器用于L2/L3（启用工具调用，enableTools=true）。 */
  l2l3LlmRunner?: import("../core/types.js").LLMRunner;
}

// ============================
// Factory result
// ============================
// 中文：工厂结果

export interface PipelineInstance {
  /** The pipeline scheduler. */
  /** 中文：流水线调度器。 */
  scheduler: MemoryPipelineManager;
  /** VectorStore (undefined if init failed or degraded). */
  /** 中文：向量存储（初始化失败或降级时为未定义）。 */
  vectorStore: IMemoryStore | undefined;
  /** EmbeddingService (undefined if not configured or init failed). */
  /** 中文：嵌入式服务（未配置或初始化失败时为未定义）。 */
  embeddingService: EmbeddingService | undefined;
  /**
   * Destroy all resources (scheduler, VectorStore, EmbeddingService).
   * Call this on shutdown / cleanup.
   * 中文：销毁所有资源（调度器、向量存储、嵌入式服务）。
   * 在关闭/清理时调用此方法。
   */
  destroy: () => Promise<void>;
}

// ============================
// Data directory init
// ============================
// 中文：数据目录初始化

/**
 * Ensure all required data subdirectories exist under `pluginDataDir`.
 * Safe to call multiple times (mkdirSync with `recursive: true`).
 * 中文：确保在`pluginDataDir`下所有必需的数据子目录都存在。
 * 多次调用是安全的（使用`recursive: true`的`mkdirSync`）。
 */
export function initDataDirectories(dataDir: string): void {
  const dirs = ["conversations", "records", "scene_blocks", ".metadata", ".backup"];
  for (const sub of dirs) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
}

// ============================
// Store init (once-async singleton)
// ============================
// 中文：存储初始化（一次性异步单例）

export interface StoreInitResult {
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  /** Whether a background re-index is needed (embedding config changed). */
  /** 中文：是否需要进行后台重新索引（嵌入配置更改）。 */
  needsReindex: boolean;
  reindexReason?: string;
}

/**
 * Cached store init promises — keyed by `pluginDataDir` so that different
 * data directories (e.g. live runtime vs. seed output) each get their own
 * store instance, while concurrent callers for the *same* directory share
 * one initialization.
 * 中文：缓存的存储初始化Promise——以`pluginDataDir`为键，使得不同的数据目录（例如实时运行时与种子输出）各自拥有自己的存储实例，而并发调用同一目录的请求共享一个初始化。
 */
const _storeInitCache = new Map<string, Promise<StoreInitResult>>();

/**
 * Initialize store backend and (optionally) EmbeddingService.
 *
 * **Once-async semantics per dataDir**: the first call for a given
 * `pluginDataDir` creates the store and caches the result; subsequent
 * calls with the same dir return the cached Promise immediately.
 * Call `resetStores()` during shutdown to clear the cache.
 *
 * Supports both SQLite (sync init) and TCVDB (async init) backends.
 * 中文：初始化存储后端和（可选地）EmbeddingService。
 * 每个`pluginDataDir`的数据目录都具有一次性异步语义：首次为给定的`pluginDataDir`创建存储并缓存结果；后续使用相同目录的调用将立即返回缓存的Promise。
 * 在关闭时调用`resetStores()`以清除缓存。
 * 支持SQLite（同步初始化）和TCVDB（异步初始化）后端。
 */
export function initStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  const key = pluginDataDir;
  if (!_storeInitCache.has(key)) {
    _storeInitCache.set(key, _doInitStores(cfg, pluginDataDir, logger));
  }
  return _storeInitCache.get(key)!;
}

/**
 * Reset the cached store singleton(s).
 *
 * Call this during `gateway_stop` (after closing the actual store/embedding
 * resources) so that a subsequent `register()` on hot-restart can
 * re-initialize fresh instances.
 *
 * @param pluginDataDir  If provided, only clear the cache for that dir.
 *                       If omitted, clear all cached stores.
 * 中文：重置缓存的存储单例。
 * 在`gateway_stop`期间调用（在实际关闭存储/嵌入资源之后），以便热重启后的`register()`可以重新初始化新的实例。
 * @param pluginDataDir  如果提供，则仅清除该目录的缓存；如果省略，则清除所有缓存的存储。
 */
export function resetStores(pluginDataDir?: string): void {
  if (pluginDataDir) {
    _storeInitCache.delete(pluginDataDir);
  } else {
    _storeInitCache.clear();
  }
}

/**
 * Internal: actual store initialization logic (called once by the cache).
 * 中文：内部：实际的存储初始化逻辑（由缓存调用一次）。
 */
async function _doInitStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  let vectorStore: IMemoryStore | undefined;
  let embeddingService: EmbeddingService | undefined;
  let needsReindex = false;
  let reindexReason: string | undefined;

  try {
    const bundle = createStoreBundle(cfg, {
      dataDir: pluginDataDir,
      logger,
    });
    vectorStore = bundle.store;
    embeddingService = bundle.embedding ?? undefined;

    const providerInfo = embeddingService?.getProviderInfo();
    const initResult = await vectorStore.init(providerInfo);

    if (vectorStore.isDegraded()) {
      logger.warn(`${TAG} Store is in degraded mode, falling back to keyword dedup`);
      vectorStore = undefined;
      embeddingService = undefined;
    } else {
      logger.debug?.(
        `${TAG} Store initialized: backend=${cfg.storeBackend}, provider=${cfg.embedding.provider}`,
      );
      needsReindex = initResult.needsReindex;
      reindexReason = initResult.reason;

      // ── Manifest: first-write + config-drift detection ──
      // 中文：── Manifest: 首次写入 + 配置漂移检测 ──
      try {
        const currentStoreInfo = buildStoreInfo(bundle.storeSnapshot);
        const existing = readManifest(pluginDataDir);

        if (!existing) {
          // First init — write manifest
          // 中文：First init — 写入 manifest
          const manifest: Manifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            store: currentStoreInfo,
            seed: null,
          };
          writeManifest(pluginDataDir, manifest);
          logger.debug?.(`${TAG} Manifest created: ${JSON.stringify(currentStoreInfo)}`);
        } else {
          // Compare persisted store binding against current config
          // 中文：比较持久化存储绑定与当前配置
          const diffs = diffStoreBinding(existing.store, currentStoreInfo);
          if (diffs.length > 0) {
            logger.debug?.(
              `${TAG} Store config differs from initial binding recorded in manifest ` +
              `(${diffs.join("; ")}). ` +
              `This is expected if the storage backend was switched intentionally.`,
            );
          }
        }
      } catch (err) {
        logger.warn(`${TAG} Failed to read/write manifest (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.warn(
      `${TAG} Store init failed; vector/FTS recall and dedup conflict detection will be unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    vectorStore = undefined;
    embeddingService = undefined;
  }

  return { vectorStore, embeddingService, needsReindex, reindexReason };
}

// ============================
// L1 Runner factory
// ============================
// 中文：L1 运行器工厂

/**
 * Create the standard L1 runner function.
 *
 * Reads L0 messages (from VectorStore DB or JSONL fallback), groups by sessionId,
 * runs extractL1Memories for each group, and updates the checkpoint cursor.
 * 中文：创建标准的 L1 运行器函数。
 * 从 VectorStore 数据库或 JSONL 回退中读取 L0 消息（按 sessionId 分组），
 * 为每个分组运行 extractL1Memories，并更新检查点游标。
 */
export function createL1Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  logger: PipelineLogger;
  /**
   * Getter for the plugin instance ID used for metric reporting.
   * Called at runner execution time (not at creation time) so that the ID is
   * available even when the runner is wired before instanceId is resolved.
   * Metrics are skipped when the getter returns undefined.
   * 中文：获取用于指标报告的插件实例 ID。
   * 在运行器执行时调用（而非创建时），以便即使在运行器接线前 instanceId 解析完成时也能获得该 ID。
   * 当 getter 返回 undefined 时跳过指标计算。
   */
  getInstanceId?: () => string | undefined;
  /** Host-neutral LLM runner for L1 extraction (standalone/gateway mode). */
  /** 中文：无宿主依赖的 L1 提取运行器（独立/网关模式）。 */
  llmRunner?: import("../core/types.js").LLMRunner;
}): (params: { sessionKey: string }) => Promise<{ processedCount: number }> {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, embeddingService, logger, getInstanceId, llmRunner } = opts;
  const config = openclawConfig as Record<string, unknown> | undefined;

  return async ({ sessionKey }) => {
    if (!config && !llmRunner) {
      logger.debug?.(`${TAG} [l1] No OpenClaw config and no LLM runner, skipping L1 extraction`);
      return { processedCount: 0 };
    }

    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    const cp = await checkpoint.read();
    const runnerState = checkpoint.getRunnerState(cp, sessionKey);

    logger.info(
      `${TAG} [l1] Session ${sessionKey}: l1_cursor=${runnerState.last_l1_cursor || "(start)"}`,
    );

    try {
      let groups: Array<{ sessionId: string; messages: ConversationMessage[] }>;
      let maxRecordedAtMs = 0;

      if (vectorStore && !vectorStore.isDegraded()) {
        const l1Cursor = runnerState.last_l1_cursor > 0
          ? runnerState.last_l1_cursor
          : undefined;
        const dbGroups = await vectorStore.queryL0GroupedBySessionId(sessionKey, l1Cursor);
        groups = dbGroups.map((g) => ({
          sessionId: g.sessionId,
          messages: g.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: m.timestamp,
          })),
        }));
        // Compute max recordedAtMs across all groups for cursor advancement
        // 中文：为所有分组计算最大 recordedAtMs 以推进游标
        for (const g of dbGroups) {
          for (const m of g.messages) {
            if (m.recordedAtMs > maxRecordedAtMs) maxRecordedAtMs = m.recordedAtMs;
          }
        }
        logger.debug?.(`${TAG} [l1] L0 data source: VectorStore DB`);
      } else {
        logger.debug?.(`${TAG} [l1] L0 data source: JSONL files (VectorStore unavailable)`);
        const jsonlGroups = await readConversationMessagesGroupedBySessionId(
          sessionKey,
          pluginDataDir,
          runnerState.last_l1_cursor || undefined,
          logger,
          50,
        );
        groups = jsonlGroups.map((g) => ({
          sessionId: g.sessionId,
          messages: g.messages,
        }));
        // Compute max recordedAtMs from JSONL groups
        // 中文：从JSONL分组计算最大recordedAtMs
        for (const g of jsonlGroups) {
          for (const m of g.messages) {
            if (m.recordedAtMs > maxRecordedAtMs) maxRecordedAtMs = m.recordedAtMs;
          }
        }
      }

      if (groups.length === 0) {
        logger.debug?.(`${TAG} [l1] No new L0 messages for session ${sessionKey}`);
        return { processedCount: 0 };
      }

      const totalMessages = groups.reduce((sum, g) => sum + g.messages.length, 0);
      logger.info(
        `${TAG} [l1] Processing ${totalMessages} L0 messages across ${groups.length} sessionId group(s) for session ${sessionKey}`,
      );

      let totalExtracted = 0;
      let totalStored = 0;
      let lastSceneName: string | undefined;

      for (const group of groups) {
        logger.debug?.(
          `${TAG} [l1] Group sessionId=${group.sessionId || "(empty)"}: ${group.messages.length} messages`,
        );

        const l1Result = await extractL1Memories({
          messages: group.messages,
          sessionKey,
          sessionId: group.sessionId,
          baseDir: pluginDataDir,
          config,
          options: {
            enableDedup: cfg.extraction.enableDedup,
            maxMemoriesPerSession: cfg.extraction.maxMemoriesPerSession,
            model: cfg.extraction.model,
            previousSceneName: lastSceneName ?? (runnerState.last_scene_name || undefined),
            vectorStore,
            embeddingService,
            conflictRecallTopK: cfg.embedding.conflictRecallTopK,
            embeddingTimeoutMs: cfg.embedding.captureTimeoutMs ?? cfg.embedding.timeoutMs,
            llmRunner,
          },
          logger,
          instanceId: getInstanceId?.(),
        });

        totalExtracted += l1Result.extractedCount;
        totalStored += l1Result.storedCount;
        if (l1Result.lastSceneName) {
          lastSceneName = l1Result.lastSceneName;
        }
      }

      // Use maxRecordedAtMs (write time) as cursor — always positive, TCVDB-safe
      // 中文：使用maxRecordedAtMs（写入时间）作为游标——始终为正，TCVDB安全
      await checkpoint.markL1ExtractionComplete(sessionKey, totalStored, maxRecordedAtMs || undefined, lastSceneName);
      logger.info(
        `${TAG} [l1] L1 complete: extracted=${totalExtracted}, stored=${totalStored} (${groups.length} group(s))`,
      );

      return { processedCount: totalMessages };
    } catch (err) {
      logger.error(`${TAG} [l1] L1 failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      throw err;
    }
  };
}

// ============================
// Persister factory
// ============================
// 中文：持久化工厂

/**
 * Create the standard pipeline state persister.
 * Saves pipeline session states to the checkpoint file.
 * 中文：创建标准的管道状态持久化器。
 * 将管道会话状态保存到检查点文件中。
 */
export function createPersister(
  pluginDataDir: string,
  logger: PipelineLogger,
): (states: Record<string, PipelineSessionState>) => Promise<void> {
  return async (states) => {
    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    await checkpoint.mergePipelineStates(states);
  };
}

// ============================
// L2 Runner factory
// ============================
// 中文：L2运行器工厂

/**
 * Create the standard L2 runner function (scene extraction).
 *
 * Reads L1 memory records (incremental via VectorStore or JSONL fallback),
 * runs SceneExtractor, and returns the latest cursor for pipeline-manager
 * to track incremental progress.
 *
 * Used by both `index.ts` (live runtime) and `seed-runtime.ts` (seed CLI).
 * 中文：创建标准的L2运行函数（场景提取）。
 * 通过向量存储或JSONL回退读取L1内存记录（增量），
 * 运行SceneExtractor，并返回最新的游标供pipeline-manager跟踪增量进度。
 * 被`index.ts`（实时运行时）和`seed-runtime.ts`（种子CLI）使用。
 */
export function createL2Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  logger: PipelineLogger;
  instanceId?: string;
  /** Host-neutral LLM runner for L2 scene extraction (standalone/gateway mode). Must have enableTools=true. */
  /** 中文：无主机限制的LLM运行器用于L2场景提取（独立/网关模式）。必须有enableTools=true。 */
  llmRunner?: import("../core/types.js").LLMRunner;
}): L2Runner {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, instanceId, llmRunner } = opts;
  let profileBaseline = new Map<string, { version: number; contentMd5: string; createdAtMs: number }>();

  return async (sessionKey: string, cursor?: string) => {
    logger.debug?.(
      `${TAG} [L2] session=${sessionKey}, updatedAfter=${cursor ?? "(full)"}`,
    );

    if (!openclawConfig && !llmRunner) {
      logger.warn(`${TAG} [L2] No OpenClaw config and no LLM runner, skipping scene extraction`);
      return;
    }

    let records: Array<{ content: string; created_at: string; id: string; updatedAt: string }>;

    if (vectorStore?.pullProfiles && !vectorStore.isDegraded()) {
      profileBaseline = await pullProfilesToLocal(pluginDataDir, vectorStore, logger);
    }

    if (vectorStore && !vectorStore.isDegraded()) {
      const { queryMemoryRecords } = await import("../core/record/l1-reader.js");
      const memRecords = await queryMemoryRecords(vectorStore, {
        sessionKey,
        updatedAfter: cursor,
      }, logger);

      if (memRecords.length === 0) {
        logger.debug?.(
          `${TAG} [L2] No new L1 records since cursor (session=${sessionKey}, updatedAfter=${cursor ?? "(full)"}), skipping scene extraction`,
        );
        return { skipped: true, latestCursor: cursor || undefined };
      }

      logger.debug?.(
        `${TAG} [L2] Incremental query returned ${memRecords.length} record(s) (session=${sessionKey})`,
      );

      records = memRecords.map((r) => ({
        content: r.content,
        created_at: r.createdAt,
        id: r.id,
        updatedAt: r.updatedAt,
      }));
    } else {
      logger.debug?.(`${TAG} [L2] VectorStore unavailable, falling back to JSONL read (session=${sessionKey})`);
      const { readMemoryRecords } = await import("../core/record/l1-reader.js");
      let sessionRecords = await readMemoryRecords(sessionKey, pluginDataDir, logger);

      if (cursor) {
        const beforeCount = sessionRecords.length;
        sessionRecords = sessionRecords.filter((r) => {
          const t = r.updatedAt || r.createdAt || "";
          return t > cursor;
        });
        logger.debug?.(
          `${TAG} [L2] JSONL time filter: ${beforeCount} → ${sessionRecords.length} record(s) (updatedAfter=${cursor})`,
        );
      }

      if (sessionRecords.length === 0) {
        logger.debug?.(`${TAG} [L2] No new L1 records found (JSONL fallback, session=${sessionKey}), skipping scene extraction`);
        return { latestCursor: cursor || undefined };
      }

      records = sessionRecords.map((r) => ({
        content: r.content,
        created_at: r.createdAt,
        id: r.id,
        updatedAt: r.updatedAt,
      }));
    }

    const extractor = new SceneExtractor({
      dataDir: pluginDataDir,
      config: openclawConfig!,
      model: cfg.persona.model,
      maxScenes: cfg.persona.maxScenes,
      sceneBackupCount: cfg.persona.sceneBackupCount,
      logger,
      instanceId,
      llmRunner,
    });

    const memories = records.map((r) => ({
      content: r.content,
      created_at: r.created_at,
      id: r.id,
    }));

    const preCheckpoint = new CheckpointManager(pluginDataDir, logger);
    const preState = await preCheckpoint.read();
    const preScenesProcessed = preState.scenes_processed;
    const preMemoriesSince = preState.memories_since_last_persona;
    const preTotalProcessed = preState.total_processed;

    const extractResult = await extractor.extract(memories);
    if (extractResult.success && extractResult.memoriesProcessed > 0) {
      const checkpoint = new CheckpointManager(pluginDataDir, logger);
      const postState = await checkpoint.read();
      if (
        postState.scenes_processed < preScenesProcessed ||
        postState.total_processed < preTotalProcessed
      ) {
        logger.warn(
          `${TAG} [L2] ⚠️ Checkpoint corruption detected! ` +
          `scenes_processed: ${preScenesProcessed} → ${postState.scenes_processed}, ` +
          `total_processed: ${preTotalProcessed} → ${postState.total_processed}, ` +
          `memories_since: ${preMemoriesSince} → ${postState.memories_since_last_persona}. ` +
          `Repairing...`,
        );
        await checkpoint.write({
          ...postState,
          scenes_processed: Math.max(postState.scenes_processed, preScenesProcessed),
          total_processed: Math.max(postState.total_processed, preTotalProcessed),
          memories_since_last_persona: Math.max(postState.memories_since_last_persona, preMemoriesSince),
        });
        logger.info(`${TAG} [L2] Checkpoint repaired`);
      }

      if (vectorStore && supportsProfileSyncWrite(vectorStore)) {
        await syncLocalProfilesToStore(pluginDataDir, vectorStore, profileBaseline, logger);
      }
      await checkpoint.incrementScenesProcessed();

      const latestCursor = records.reduce((latest, r) => {
        return r.updatedAt > latest ? r.updatedAt : latest;
      }, "");

      logger.debug?.(
        `${TAG} [L2] Extraction complete: processed=${extractResult.memoriesProcessed}, latestCursor=${latestCursor}`,
      );

      return { latestCursor: latestCursor || undefined };
    }
  };
}

// ============================
// L3 Runner factory
// ============================
// 中文：L3运行器工厂

/**
 * Create the standard L3 runner function (persona generation).
 *
 * Uses PersonaTrigger to check if generation is needed, then runs
 * PersonaGenerator. Used by both `index.ts` and `seed-runtime.ts`.
 * 中文：创建标准的L3运行器函数（人物生成）。
 * 使用PersonaTrigger检查是否需要生成，然后运行PersonaGenerator。被`index.ts`和`seed-runtime.ts`使用。
 */
export function createL3Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore?: IMemoryStore;
  logger: PipelineLogger;
  instanceId?: string;
  /** Host-neutral LLM runner for L3 persona generation (standalone/gateway mode). Must have enableTools=true. */
  /** 中文：无宿主的LLM运行器用于L3人物生成（独立/网关模式）。必须有enableTools=true。 */
  llmRunner?: import("../core/types.js").LLMRunner;
}): L3Runner {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, instanceId, llmRunner } = opts;

  return async () => {
    const trigger = new PersonaTrigger({
      dataDir: pluginDataDir,
      interval: cfg.persona.triggerEveryN,
      logger,
    });

    const { should, reason } = await trigger.shouldGenerate();
    if (!should) {
      logger.debug?.(`${TAG} [L3] Persona generation not needed`);
      return;
    }

    if (!openclawConfig && !llmRunner) {
      logger.warn(`${TAG} [L3] No OpenClaw config and no LLM runner, skipping persona generation`);
      return;
    }

    // Pull remote profiles to establish fresh baseline before generation.
    // This ensures syncLocalProfilesToStore() has correct baselineVersion
    // for the optimistic-lock check instead of defaulting to 0.
    // 中文：拉取远程配置文件以建立新鲜的基础线，在生成前确保syncLocalProfilesToStore()具有正确的基础版本baselineVersion，而不是默认为0。
    let profileBaseline = new Map<string, { version: number; contentMd5: string; createdAtMs: number }>();
    if (vectorStore?.pullProfiles && !vectorStore.isDegraded()) {
      profileBaseline = await pullProfilesToLocal(pluginDataDir, vectorStore, logger);
    }

    logger.info(`${TAG} [L3] Starting persona generation: ${reason}`);
    const generator = new PersonaGenerator({
      dataDir: pluginDataDir,
      config: openclawConfig,
      model: cfg.persona.model,
      backupCount: cfg.persona.backupCount,
      logger,
      instanceId,
      llmRunner,
    });
    const genResult = await generator.generateLocalPersona(reason);
    if (!genResult) {
      logger.info(`${TAG} [L3] Persona generation skipped (no changes)`);
      return;
    }

    if (vectorStore && supportsProfileSyncWrite(vectorStore)) {
      await syncLocalProfilesToStore(pluginDataDir, vectorStore, profileBaseline, logger);
    }

    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    const cp = await checkpoint.read();
    await checkpoint.markPersonaGenerated(cp.total_processed);
    logger.info(`${TAG} [L3] Persona generation succeeded`);
  };
}

// ============================
// Pipeline Manager factory
// ============================
// 中文：管道管理器工厂

/**
 * Create a MemoryPipelineManager with the standard config mapping.
 * 中文：创建一个标准配置映射的MemoryPipelineManager。
 */
export function createPipelineManager(
  cfg: MemoryTdaiConfig,
  logger: PipelineLogger,
  sessionFilter?: SessionFilter,
): MemoryPipelineManager {
  return new MemoryPipelineManager(
    {
      everyNConversations: cfg.pipeline.everyNConversations,
      enableWarmup: cfg.pipeline.enableWarmup,
      l1: { idleTimeoutSeconds: cfg.pipeline.l1IdleTimeoutSeconds },
      l2: {
        delayAfterL1Seconds: cfg.pipeline.l2DelayAfterL1Seconds,
        minIntervalSeconds: cfg.pipeline.l2MinIntervalSeconds,
        maxIntervalSeconds: cfg.pipeline.l2MaxIntervalSeconds,
        sessionActiveWindowHours: cfg.pipeline.sessionActiveWindowHours,
      },
    },
    logger,
    sessionFilter ?? new SessionFilter([]),
  );
}

// ============================
// Full pipeline factory
// ============================
// 中文：完整管道工厂

/**
 * Create a fully wired pipeline instance: VectorStore + EmbeddingService +
 * MemoryPipelineManager with L1 runner and persister attached.
 *
 * This is the high-level entry point used by both `index.ts` and `seed-runtime.ts`.
 * Callers should attach L2/L3 runners after creation using `createL2Runner()`
 * and `createL3Runner()` from this module.
 * 中文：创建一个完全装配好的管道实例：向量存储 + 向量服务 + MemoryPipelineManager，附带L1运行器和持久化器。
 * 这是由`index.ts`和`seed-runtime.ts`使用的高级入口点。调用者应在创建后使用此模块的createL2Runner()和createL3Runner()方法附加L2/L3运行器。
 */
export async function createPipeline(opts: PipelineFactoryOptions): Promise<PipelineInstance> {
  const { pluginDataDir, cfg, openclawConfig, logger, sessionFilter, l1LlmRunner } = opts;

  // Ensure data directories exist
  // 中文：确保数据目录存在
  initDataDirectories(pluginDataDir);

  // Initialize stores (once-async: reuses cached result if already initialized)
  // 中文：初始化存储（仅异步一次：已初始化时复用缓存结果）
  const stores = await initStores(cfg, pluginDataDir, logger);
  const { vectorStore, embeddingService } = stores;

  // Create pipeline manager
  // 中文：创建管道管理器
  const scheduler = createPipelineManager(cfg, logger, sessionFilter);

  // Wire L1 runner
  // 中文：绑定L1运行器
  scheduler.setL1Runner(createL1Runner({
    pluginDataDir,
    cfg,
    openclawConfig,
    vectorStore,
    embeddingService,
    logger,
    llmRunner: l1LlmRunner,
  }));

  // Wire persister
  // 中文：绑定持久化组件
  scheduler.setPersister(createPersister(pluginDataDir, logger));

  // Destroy function
  // 中文：销毁函数
  const destroy = async () => {
    logger.info(`${TAG} Destroying pipeline...`);
    await scheduler.destroy();
    if (vectorStore) {
      logger.info(`${TAG} Closing VectorStore`);
      vectorStore.close();
    }
    if (embeddingService?.close) {
      try {
        logger.info(`${TAG} Closing EmbeddingService`);
        await embeddingService.close();
      } catch (err) {
        logger.warn(`${TAG} Error closing EmbeddingService: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    resetStores(pluginDataDir);
    logger.info(`${TAG} Pipeline destroyed`);
  };

  return { scheduler, vectorStore, embeddingService, destroy };
}
