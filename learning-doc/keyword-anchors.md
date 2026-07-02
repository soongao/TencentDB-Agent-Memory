# TencentDB Agent Memory 关键词锚点

这份文档用于快速定位项目代码。每个锚点都按“关键词 -> 入口文件 -> 作用 -> 继续搜索词”组织，适合后续逐块拆解。

## 1. 总入口与宿主适配

| 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|
| OpenClaw plugin register | `index.ts` | OpenClaw 插件主入口，注册工具、hooks、CLI、offload | `register(api)`、`api.registerTool`、`api.on` |
| TdaiCore | `src/core/tdai-core.ts` | 宿主无关核心门面，承接 recall、capture、search、pipeline | `handleBeforeRecall`、`handleTurnCommitted`、`destroy` |
| HostAdapter | `src/core/types.ts` | 抽象宿主上下文、logger、LLM runner | `HostAdapter`、`RuntimeContext` |
| OpenClawHostAdapter | `src/adapters/openclaw/host-adapter.ts` | OpenClaw runtime 到核心接口的适配 | `getRuntimeContext`、`getLLMRunnerFactory` |
| StandaloneHostAdapter | `src/adapters/standalone/host-adapter.ts` | Gateway/Hermes 场景下的宿主适配 | `platform: "gateway"`、`dataDir` |
| LLMRunner | `src/core/types.ts` | 统一 LLM 调用接口，隔离 OpenClaw 内置模型与 standalone HTTP 模型 | `LLMRunner`、`LLMRunnerFactory` |

## 2. 配置锚点

| 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|
| parseConfig | `src/config.ts` | 将用户配置解析成完整默认配置 | `parseConfig` |
| configSchema | `openclaw.plugin.json` | OpenClaw 插件配置 schema | `configSchema` |
| capture | `src/config.ts` | L0 对话捕获配置 | `CaptureConfig` |
| extraction | `src/config.ts` | L1 记忆抽取配置 | `ExtractionConfig` |
| pipeline | `src/config.ts` | L1/L2/L3 调度配置 | `PipelineTriggerConfig` |
| recall | `src/config.ts` | 自动召回配置 | `RecallConfig` |
| embedding | `src/config.ts` | 向量检索和 embedding 配置 | `EmbeddingConfig` |
| storeBackend | `src/config.ts` | SQLite 或 TCVDB 存储后端选择 | `StoreBackend` |
| offload | `src/config.ts` | Context Offload 开关和压缩参数 | `OffloadConfig` |

## 3. 长期记忆主链路

| 层级 | 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|---|
| L0 | auto-capture | `src/core/hooks/auto-capture.ts` | agent 结束后捕获本轮对话 | `performAutoCapture` |
| L0 | L0 recorder | `src/core/conversation/l0-recorder.ts` | 从 raw messages 中抽取可落盘消息 | `recordConversation` |
| L0 | checkpoint cursor | `src/utils/checkpoint.ts` | 维护捕获游标和 pipeline 状态 | `captureAtomically`、`last_l0_capture_time` |
| L1 | L1 extractor | `src/core/record/l1-extractor.ts` | 调 LLM 从 L0 对话抽取结构化记忆 | `extractL1Memories` |
| L1 | MemoryRecord | `src/core/record/l1-writer.ts` | L1 记忆记录结构 | `MemoryRecord`、`MemoryType` |
| L1 | dedup | `src/core/record/l1-dedup.ts` | 对新记忆做 store/update/merge/skip | `DedupDecision` |
| L1 | writer | `src/core/record/l1-writer.ts` | 写入 L1 JSONL 和 store | `writeMemoryRecords`、`upsertL1` |
| L2 | scene extractor | `src/core/scene/scene-extractor.ts` | 将 L1 记忆归纳成场景块 | `SceneExtractor` |
| L2 | scene index | `src/core/scene/scene-index.ts` | 维护场景索引，支持导航注入 | `SceneIndexEntry`、`readSceneIndex` |
| L2 | scene navigation | `src/core/scene/scene-navigation.ts` | 生成给 LLM 的 scene navigation | `generateSceneNavigation` |
| L3 | persona trigger | `src/core/persona/persona-trigger.ts` | 判断是否需要生成用户画像 | `PersonaTrigger` |
| L3 | persona generator | `src/core/persona/persona-generator.ts` | 生成 `persona.md` | `generateLocalPersona` |
| L2/L3 | profile sync | `src/core/profile/profile-sync.ts` | 本地 L2/L3 与远端 profile store 同步 | `pullProfilesToLocal`、`syncLocalProfilesToStore` |

## 4. 召回链路

| 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|
| before_prompt_build | `index.ts` | OpenClaw prompt 构造前触发自动召回 | `before_prompt_build` |
| performAutoRecall | `src/core/hooks/auto-recall.ts` | 召回 L1、读取 L3 persona、生成 L2 scene navigation | `performAutoRecall` |
| prependContext | `src/core/hooks/auto-recall.ts` | 注入到用户 prompt 前的动态 L1 记忆 | `prependContext`、`<relevant-memories>` |
| appendSystemContext | `src/core/hooks/auto-recall.ts` | 注入到 system prompt 的 persona / scene / tools guide | `appendSystemContext` |
| memory tools guide | `src/core/hooks/auto-recall.ts` | 告诉 Agent 如何主动调用搜索工具 | `MEMORY_TOOLS_GUIDE` |
| memory search tool | `src/core/tools/memory-search.ts` | Agent 主动搜索 L1 结构化记忆 | `executeMemorySearch` |
| conversation search tool | `src/core/tools/conversation-search.ts` | Agent 主动搜索 L0 原始对话 | `executeConversationSearch` |
| keyword search | `src/core/hooks/auto-recall.ts` | FTS/BM25 关键词召回路径 | `searchByKeyword`、`buildFtsQuery` |
| embedding search | `src/core/hooks/auto-recall.ts` | embedding 向量召回路径 | `searchByEmbedding` |
| hybrid search | `src/core/hooks/auto-recall.ts` | 关键词 + 向量融合召回 | `searchHybrid`、`nativeHybridSearch` |

## 5. Pipeline 调度锚点

| 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|
| MemoryPipelineManager | `src/utils/pipeline-manager.ts` | L1/L2/L3 调度器 | `class MemoryPipelineManager` |
| notifyConversation | `src/utils/pipeline-manager.ts` | 每轮捕获后通知调度器 | `notifyConversation` |
| warm-up threshold | `src/utils/pipeline-manager.ts` | 新 session 从 1 轮触发，逐步提升阈值 | `warmup_threshold`、`advanceWarmupThreshold` |
| L1 idle timer | `src/utils/pipeline-manager.ts` | 用户停止一段时间后触发 L1 | `l1Idle`、`onL1IdleTimeout` |
| L1 queue | `src/utils/pipeline-manager.ts` | 串行执行 L1 | `enqueueL1`、`runL1` |
| L2 downward-only timer | `src/utils/pipeline-manager.ts` | L2 触发时间只提前不推迟 | `advanceL2Timer`、`tryAdvanceTo` |
| L2 queue | `src/utils/pipeline-manager.ts` | 串行执行 L2 scene extraction | `enqueueL2`、`runL2` |
| L3 queue | `src/utils/pipeline-manager.ts` | 串行生成 persona | `enqueueL3`、`runL3` |
| flushSession | `src/utils/pipeline-manager.ts` | 只 flush 单个 session | `flushSession` |
| destroy | `src/utils/pipeline-manager.ts` | 全局关闭 pipeline | `_doFlush`、`DESTROY_TIMEOUT_MS` |
| pipeline factory | `src/utils/pipeline-factory.ts` | 创建 store、runner、scheduler | `createL1Runner`、`createL2Runner`、`createL3Runner` |

## 6. 存储后端锚点

| 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|
| IMemoryStore | `src/core/store/types.ts` | 统一存储接口 | `interface IMemoryStore` |
| StoreCapabilities | `src/core/store/types.ts` | 描述后端是否支持向量、FTS、hybrid | `StoreCapabilities` |
| createStoreBundle | `src/core/store/factory.ts` | 根据配置创建 SQLite 或 TCVDB store | `createStoreBundle` |
| VectorStore | `src/core/store/sqlite.ts` | SQLite + sqlite-vec + FTS5 后端 | `class VectorStore` |
| l1_records | `src/core/store/sqlite.ts` | SQLite L1 metadata 表 | `CREATE TABLE IF NOT EXISTS l1_records` |
| l0_conversations | `src/core/store/sqlite.ts` | SQLite L0 metadata 表 | `CREATE TABLE IF NOT EXISTS l0_conversations` |
| l1_vec / l0_vec | `src/core/store/sqlite.ts` | sqlite-vec 向量虚拟表 | `CREATE VIRTUAL TABLE`、`vec0` |
| l1_fts / l0_fts | `src/core/store/sqlite.ts` | SQLite FTS5 关键词索引 | `fts5`、`tokenizeForFts` |
| TcvdbMemoryStore | `src/core/store/tcvdb.ts` | 腾讯云 VectorDB 后端 | `class TcvdbMemoryStore` |
| TcvdbClient | `src/core/store/tcvdb-client.ts` | TCVDB HTTP API client | `TcvdbClient` |
| nativeHybridSearch | `src/core/store/tcvdb.ts` | TCVDB dense + sparse + RRF 检索 | `searchL1Hybrid`、`hybridSearch` |
| BM25 | `src/core/store/bm25-local.ts` | 本地稀疏向量编码 | `createBM25Encoder` |
| profile collection | `src/core/store/tcvdb.ts` | TCVDB 中保存 L2/L3 profile | `profilesCollection` |

## 7. Embedding 锚点

| 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|
| EmbeddingService | `src/core/store/embedding.ts` | embedding 统一接口 | `interface EmbeddingService` |
| OpenAIEmbeddingService | `src/core/store/embedding.ts` | OpenAI-compatible embedding | `OpenAIEmbeddingService` |
| ZeroEntropyEmbeddingService | `src/core/store/embedding.ts` | ZeroEntropy 原生 embedding 协议 | `ZeroEntropyEmbeddingService` |
| LocalEmbeddingService | `src/core/store/embedding.ts` | node-llama-cpp 本地 embedding，代码保留 | `LocalEmbeddingService` |
| NoopEmbeddingService | `src/core/store/embedding.ts` | TCVDB 服务端 embedding 场景下的 no-op | `NoopEmbeddingService` |
| provider none | `src/config.ts` | 默认禁用向量能力 | `providerRaw === "none"` |
| embedding config error | `src/config.ts` | embedding 配置缺字段时降级 | `embeddingConfigError` |

## 8. Context Offload 锚点

| 层级 | 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|---|
| 入口 | registerOffload | `src/offload/index.ts` | 注册 offload hooks 和 context engine | `registerOffload` |
| 状态 | SessionRegistry | `src/offload/session-registry.ts` | 管理不同 session 的 offload state manager | `SessionRegistry` |
| 状态 | OffloadStateManager | `src/offload/state-manager.ts` | 管理 pending pairs、MMD、状态文件 | `OffloadStateManager` |
| 存储 | StorageContext | `src/offload/storage.ts` | 管理 refs、mmds、jsonl、state 文件路径 | `StorageContext` |
| L1 | after_tool_call | `src/offload/hooks/after-tool-call.ts` | 收集工具调用结果，触发压缩检查 | `createAfterToolCallHandler` |
| L1 | flushL1 | `src/offload/index.ts` | 将 tool pairs 变成摘要 entries | `flushL1` |
| L1 | refs | `src/offload/storage.ts` | 保存原始工具结果 Markdown | `writeRefMd` |
| L1.5 | task boundary | `src/offload/index.ts` | 判断任务延续/切换/结束 | `attemptL15`、`judgeL15` |
| L2 | Mermaid | `src/offload/pipelines/l2-mermaid.ts` | 根据 entries 生成或 patch Mermaid 图 | `checkL2Trigger`、`backfillNodeIds` |
| L3 | before_prompt_build | `src/offload/hooks/before-prompt-build.ts` | prompt 前重放压缩状态并注入 MMD | `createBeforePromptBuildHandler` |
| L3 | mild compression | `src/offload/hooks/llm-input-l3.ts` | 将工具结果替换为摘要 | `compressByScoreCascade` |
| L3 | aggressive compression | `src/offload/hooks/llm-input-l3.ts` | 删除部分旧工具消息并注入历史 MMD | `aggressiveCompressUntilBelowThreshold` |
| L3 | emergency compression | `src/offload/hooks/llm-input-l3.ts` | 兜底强压缩 | `emergencyCompress` |
| 注入 | MMD injector | `src/offload/mmd-injector.ts` | 找插入位置并注入 active/history MMD | `injectMmdIntoMessages` |
| 计数 | token tracker | `src/offload/context-token-tracker.ts` | 计算上下文 token 快照 | `buildTiktokenContextSnapshot` |
| 后端 | BackendClient | `src/offload/backend-client.ts` | 远端 offload backend client | `l1Summarize`、`l15Judge`、`l2Generate` |
| 本地 | LocalLlmClient | `src/offload/local-llm/index.ts` | 本地 OpenAI-compatible LLM 调用 | `LocalLlmClient` |

## 9. Gateway / Hermes 锚点

| 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|
| TdaiGateway | `src/gateway/server.ts` | Hermes sidecar HTTP server | `class TdaiGateway` |
| /recall | `src/gateway/server.ts` | HTTP 召回入口 | `handleRecall` |
| /capture | `src/gateway/server.ts` | HTTP 捕获入口 | `handleCapture` |
| /search/memories | `src/gateway/server.ts` | HTTP L1 搜索入口 | `handleSearchMemories` |
| /search/conversations | `src/gateway/server.ts` | HTTP L0 搜索入口 | `handleSearchConversations` |
| /session/end | `src/gateway/server.ts` | HTTP session flush 入口 | `handleSessionEnd` |
| /seed | `src/gateway/server.ts` | HTTP 批量灌入历史数据入口 | `handleSeed` |
| Gateway auth | `src/gateway/server.ts` | 可选 Bearer 鉴权 | `checkAuth`、`TDAI_GATEWAY_API_KEY` |
| Hermes provider | `hermes-plugin/memory/memory_tencentdb/` | Hermes memory provider 包装 | `client.py`、`supervisor.py` |

## 10. CLI / 迁移 / 导出锚点

| 关键词 | 入口文件 | 作用 | 继续搜索 |
|---|---|---|---|
| memory-tdai CLI | `src/cli/index.ts` | OpenClaw CLI 命名空间 | `registerMemoryTdaiCli` |
| seed command | `src/cli/commands/seed.ts` | 批量导入历史对话 | `registerSeedCommand` |
| seed runtime | `src/core/seed/seed-runtime.ts` | seed 数据跑 L0/L1 pipeline | `executeSeed` |
| SQLite -> TCVDB | `scripts/migrate-sqlite-to-tcvdb/` | 本地 SQLite 数据迁移到 TCVDB | `sqlite-to-tcvdb.ts` |
| TCVDB export | `scripts/export-tencent-vdb/export-tencent-vdb.ts` | 导出 TCVDB collection 到 JSONL | `exportCollection` |
| read local memory | `scripts/read-local-memory/read-local-memory.ts` | 读取本地记忆数据 | `read-local-memory` |
| package bin | `package.json` | npm bin 入口 | `bin` |

## 11. 调试和风险锚点

| 关键词 | 入口文件 | 为什么重要 | 继续搜索 |
|---|---|---|---|
| degraded mode | `src/core/store/sqlite.ts` / `src/core/store/tcvdb.ts` | store 失败时主流程不崩 | `isDegraded` |
| store init cache | `src/utils/pipeline-factory.ts` | 防止同一 dataDir 并发重复初始化 store | `_storeInitCache` |
| schedulerStartPromise | `src/core/tdai-core.ts` | 防止并发请求重复启动 scheduler | `schedulerStartPromise` |
| bgTasks drain | `src/core/tdai-core.ts` | 关闭前等待后台 embedding 写入 | `bgTasks` |
| recall timeout | `src/core/hooks/auto-recall.ts` | 召回超时不阻塞用户 | `timeoutMs`、`Promise.race` |
| hook policy | `src/utils/ensure-hook-policy.ts` | OpenClaw 新版本 hook 权限补丁 | `ensurePluginHookPolicy` |
| before_message_write strip | `index.ts` | 防止召回注入污染历史对话 | `<relevant-memories>` |
| patch effectiveness | `src/offload/hooks/after-tool-call.ts` | 判断 after_tool_call 是否拿到 messages | `classifyPatchEffectiveness` |
| gateway shutdown | `src/gateway/server.ts` | Gateway 停止时关闭 core | `stop()` |
| memory cleaner | `src/utils/memory-cleaner.ts` | L0/L1 TTL 清理 | `LocalMemoryCleaner` |

## 12. 建议阅读路线

1. 从 `index.ts` 读插件生命周期，先看工具和 hooks 如何注册。
2. 读 `src/core/tdai-core.ts`，理解核心能力边界。
3. 读 `src/core/hooks/auto-capture.ts` 和 `src/core/hooks/auto-recall.ts`，串起捕获和召回。
4. 读 `src/utils/pipeline-manager.ts`，理解 L1/L2/L3 什么时候运行。
5. 读 `src/utils/pipeline-factory.ts`，理解 runner 如何接上 LLM、store 和 checkpoint。
6. 读 `src/core/store/types.ts`，再分别读 SQLite 和 TCVDB 实现。
7. 最后单独读 `src/offload/index.ts` 和 `src/offload/hooks/*`，把短期压缩链路和长期记忆链路区分开。

