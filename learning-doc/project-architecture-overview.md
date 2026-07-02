# TencentDB Agent Memory 项目架构拆解

本文档记录对 `TencentDB-Agent-Memory` 项目的初步阅读结果，目标是为后续继续拆解代码、讲解模块、定位改造点提供一份索引型材料。

分析依据主要来自：

- `README_CN.md`
- `package.json`
- `openclaw.plugin.json`
- `index.ts`
- `src/config.ts`
- `src/core/tdai-core.ts`
- `src/core/hooks/*`
- `src/utils/pipeline-*.ts`
- `src/core/store/*`
- `src/gateway/server.ts`
- `src/offload/*`
- `scripts/*`

## 1. 项目定位

该项目是一个 TypeScript ESM 包，包名为 `@tencentdb-agent-memory/memory-tencentdb`。

它面向 OpenClaw 和 Hermes 这类 Agent 宿主，提供两类能力：

1. 长期记忆能力：自动记录对话，抽取结构化记忆，归纳场景，生成用户画像，并在下一轮对话前自动召回。
2. 短期上下文压缩能力：把长工具调用结果卸载到文件，生成轻量 Mermaid 任务图，并在上下文接近阈值时替换或删除冗长工具内容。

这两条能力线在代码上相对独立：

- 长期记忆主线集中在 `src/core/`、`src/utils/pipeline-*`、`src/core/store/`。
- Context Offload 主线集中在 `src/offload/`。

OpenClaw 插件入口 `index.ts` 同时注册这两条主线。

## 2. 顶层目录结构

```text
TencentDB-Agent-Memory/
├── index.ts                         # OpenClaw 插件入口
├── package.json                     # npm 包、bin、build/test 脚本
├── openclaw.plugin.json             # OpenClaw 插件元数据和配置 schema
├── README_CN.md / README.md         # 项目说明
├── SKILL.md                         # OpenClaw 安装配置 skill
├── src/
│   ├── config.ts                    # 插件配置类型和 parseConfig
│   ├── core/                        # 长期记忆核心能力
│   ├── utils/                       # pipeline、checkpoint、清理、时间等工具
│   ├── offload/                     # 短期上下文压缩系统
│   ├── adapters/                    # OpenClaw / standalone 宿主适配
│   ├── gateway/                     # Hermes sidecar HTTP Gateway
│   └── cli/                         # OpenClaw CLI 子命令注册
├── scripts/
│   ├── migrate-sqlite-to-tcvdb/     # SQLite -> TCVDB 迁移工具
│   ├── export-tencent-vdb/          # TCVDB 数据导出工具
│   └── read-local-memory/           # 本地记忆读取工具
├── hermes-plugin/                   # Hermes memory provider 包装
├── docker/                          # Hermes 集成镜像
├── assets/                          # README 图片资源
└── learning-doc/                    # 当前学习文档目录
```

## 3. 公开入口

### 3.1 OpenClaw 插件入口

入口文件是 `index.ts`，默认导出 `register(api)`。

它主要做这些事：

- 解析 OpenClaw 插件配置：`parseConfig(api.pluginConfig)`。
- 初始化时间模块、数据目录、指标 reporter。
- 创建 `OpenClawHostAdapter`。
- 创建并初始化 `TdaiCore`。
- 注册两个工具：
  - `tdai_memory_search`
  - `tdai_conversation_search`
- 注册 OpenClaw hooks：
  - `before_prompt_build`：自动召回长期记忆。
  - `before_message_write`：落盘前移除注入的 `<relevant-memories>`。
  - `agent_end`：自动捕获对话并触发 pipeline。
  - `gateway_stop`：关闭 scheduler、store、embedding、cleaner。
- 根据配置注册 Context Offload：`registerOffload(api, cfg.offload)`。
- 注册 CLI 命名空间：`memory-tdai`。

### 3.2 Host-neutral 核心入口

核心门面是 `src/core/tdai-core.ts` 中的 `TdaiCore`。

它将宿主差异收敛到三个抽象：

- `HostAdapter`
- `LLMRunnerFactory`
- `Logger`

`TdaiCore` 对外暴露的主要能力：

- `initialize()`：初始化目录、store、pipeline。
- `destroy()`：销毁 scheduler、store、embedding、后台任务。
- `handleBeforeRecall(userText, sessionKey)`：召回记忆。
- `handleTurnCommitted(turn)`：捕获一轮对话并触发 pipeline。
- `searchMemories(params)`：搜索 L1 结构化记忆。
- `searchConversations(params)`：搜索 L0 原始对话。
- `handleSessionEnd(sessionKey)`：只 flush 指定 session，不销毁全局 scheduler。

### 3.3 Hermes / Gateway 入口

`src/gateway/server.ts` 提供 HTTP Gateway，供 Hermes sidecar 使用。

主要路由：

- `GET /health`
- `POST /recall`
- `POST /capture`
- `POST /search/memories`
- `POST /search/conversations`
- `POST /session/end`
- `POST /seed`

Gateway 内部同样创建 `TdaiCore`，只是使用 `StandaloneHostAdapter`，不依赖 OpenClaw runtime。

### 3.4 CLI 和脚本入口

`package.json` 中暴露三个 bin：

- `migrate-sqlite-to-tcvdb`
- `export-tencent-vdb`
- `read-local-memory`

OpenClaw CLI 命名空间由 `src/cli/index.ts` 注册，目前主要接入 `seed` 子命令，用于批量灌入历史对话并跑 L0 -> L1。

## 4. 长期记忆主链路

长期记忆采用 L0 -> L1 -> L2 -> L3 分层。

### 4.1 L0: 原始对话层

职责：

- 从 OpenClaw `agent_end` 或 Gateway `/capture` 捕获原始对话。
- 过滤、清洗、去重，避免重复捕获历史消息。
- 写入本地 JSONL 和 store。

关键代码：

- `src/core/hooks/auto-capture.ts`
- `src/core/conversation/l0-recorder.ts`
- `src/utils/checkpoint.ts`

核心流程：

```text
agent_end
  -> TdaiCore.handleTurnCommitted()
  -> performAutoCapture()
  -> CheckpointManager.captureAtomically()
  -> recordConversation()
  -> vectorStore.upsertL0()
  -> scheduler.notifyConversation()
```

重点设计：

- 捕获游标通过 checkpoint 维护。
- `captureAtomically()` 把读取游标、录制消息、推进游标放在一个原子区间，降低并发重复捕获风险。
- SQLite store 支持 L0 先写 metadata/FTS，再后台补 embedding。
- TCVDB store 不走本地 sqlite deferred embedding 路径，通常依赖服务端 embedding 或同步写入。

### 4.2 L1: 结构化记忆层

职责：

- 从 L0 对话中抽取结构化事实。
- 记忆类型目前是三类：
  - `persona`
  - `episodic`
  - `instruction`
- 对抽取结果做去重、更新、合并或跳过。
- 写入 L1 JSONL 和 store。

关键代码：

- `src/core/record/l1-extractor.ts`
- `src/core/record/l1-writer.ts`
- `src/core/record/l1-dedup.ts`
- `src/core/record/l1-reader.ts`
- `src/core/prompts/l1-extraction.ts`
- `src/core/prompts/l1-dedup.ts`

L1 调度不在 `auto-capture.ts` 里直接做，而是由 `MemoryPipelineManager` 决定何时触发。

### 4.3 L2: 场景块层

职责：

- 将 L1 记忆按语义场景归纳成 scene blocks。
- 维护 scene index，供召回阶段生成 scene navigation。
- 支持从远端 profile store 拉取/同步本地 L2 内容。

关键代码：

- `src/core/scene/scene-extractor.ts`
- `src/core/scene/scene-index.ts`
- `src/core/scene/scene-navigation.ts`
- `src/core/scene/scene-format.ts`
- `src/core/prompts/scene-extraction.ts`

L2 runner 由 `src/utils/pipeline-factory.ts` 中的 `createL2Runner()` 创建。

### 4.4 L3: Persona 用户画像层

职责：

- 基于 L2 场景和 L1 记忆生成全局用户画像。
- 生成 `persona.md`。
- 控制生成频率和备份数量。
- 支持 profile 同步到远端 store。

关键代码：

- `src/core/persona/persona-trigger.ts`
- `src/core/persona/persona-generator.ts`
- `src/core/profile/profile-sync.ts`
- `src/core/prompts/persona-generation.ts`

L3 runner 由 `createL3Runner()` 创建，触发逻辑由 `PersonaTrigger` 判断。

## 5. Pipeline 调度机制

Pipeline 管理器是 `src/utils/pipeline-manager.ts` 中的 `MemoryPipelineManager`。

它管理 L0 -> L1 -> L2 -> L3 的异步调度，不直接关心存储和 LLM 细节。

主要机制：

- 每个 session 有独立状态。
- L1 有两类触发：
  - 会话轮数达到阈值。
  - session idle 超时。
- 新 session 支持 warm-up：
  - 触发阈值从 1 开始。
  - 每次成功 L1 后翻倍。
  - 最终达到配置的 `everyNConversations`。
- L2 使用 downward-only timer：
  - L1 完成后尽快推进 L2。
  - 同时受 `l2MinIntervalSeconds` 限制。
  - 活跃 session 受 `l2MaxIntervalSeconds` 兜底轮询。
- L3 使用全局串行队列和 pending flag，避免并发生成 persona。
- `flushSession(sessionKey)` 只处理指定 session。
- `destroy()` 才是全局 shutdown 语义。

关键工厂：

- `src/utils/pipeline-factory.ts`
  - `initDataDirectories()`
  - `initStores()`
  - `createL1Runner()`
  - `createL2Runner()`
  - `createL3Runner()`
  - `createPipelineManager()`

## 6. 自动召回链路

自动召回发生在 OpenClaw `before_prompt_build` 或 Gateway `/recall`。

关键代码：

- `src/core/hooks/auto-recall.ts`
- `src/core/tools/memory-search.ts`
- `src/core/tools/conversation-search.ts`

核心流程：

```text
before_prompt_build
  -> TdaiCore.handleBeforeRecall(userText, sessionKey)
  -> performAutoRecall()
  -> search L1 memories
  -> read persona.md
  -> read scene index and build scene navigation
  -> return prependContext / appendSystemContext
```

召回内容分两类：

- `prependContext`
  - 当前 query 相关的 L1 记忆。
  - 注入到用户 prompt 前。
  - 包裹在 `<relevant-memories>` 中。
- `appendSystemContext`
  - persona、scene navigation、memory tools guide。
  - 追加到 system prompt。
  - 相对稳定，利于 prompt cache。

搜索策略：

- `keyword`
  - SQLite 下使用 FTS5 BM25。
  - TCVDB 下可映射到稀疏/混合检索。
- `embedding`
  - 使用 embeddingService + vectorStore。
- `hybrid`
  - SQLite 下 keyword + embedding 并行，然后 RRF 合并。
  - TCVDB 下优先走 native hybrid search。

召回有整体超时控制：`recall.timeoutMs`，默认 5000ms。超时会跳过记忆注入，不阻塞用户请求。

## 7. 存储抽象与后端

存储接口是 `src/core/store/types.ts` 中的 `IMemoryStore`。

上层模块只依赖接口，不直接依赖 SQLite 或 TCVDB。

### 7.1 SQLite 后端

实现文件：`src/core/store/sqlite.ts`。

主要特点：

- 使用 Node 22 的 `node:sqlite`。
- 加载 `sqlite-vec` 扩展。
- 一个 `vectors.db` 里同时管理 L0 和 L1。
- L1 表：
  - `l1_records`
  - `l1_vec`
  - `l1_fts`
- L0 表：
  - `l0_conversations`
  - `l0_vec`
  - `l0_fts`
- 支持 FTS5，写入侧对中文做 jieba 分词索引。
- 支持 embedding provider 变更检测，必要时重建 vector table。
- 当 sqlite-vec 或 schema 初始化失败时进入 degraded 模式，上层降级运行。

### 7.2 TCVDB 后端

实现文件：`src/core/store/tcvdb.ts`。

主要特点：

- 通过 `TcvdbClient` 调用腾讯云 VectorDB HTTP API。
- 创建三个 collection：
  - `<database>_l1_memories`
  - `<database>_l0_conversations`
  - `<database>_profiles`
- L1/L0 collection 启用服务端 embedding。
- 支持 BM25 sparse vector，依赖 `@tencentdb-agent-memory/tcvdb-text`。
- 支持 native hybrid search：dense + sparse + RRF。
- L2/L3 profile 通过 profiles collection 同步。
- 所有方法倾向于返回空结果或 false，不让远端错误打断主流程。

### 7.3 Embedding 服务

实现文件：`src/core/store/embedding.ts`。

支持的服务形态：

- OpenAI-compatible remote embedding。
- ZeroEntropy native embedding。
- LocalEmbeddingService，基于 `node-llama-cpp`，代码仍保留。
- NoopEmbeddingService，供 TCVDB 这类服务端 embedding 后端使用。

配置层 `src/config.ts` 当前默认 `embedding.provider = "none"`，这会禁用向量搜索。用户配置远端 provider 时，必须提供 `apiKey/baseUrl/model/dimensions`，否则会降级为非向量模式。

## 8. Context Offload 链路

Context Offload 是短期上下文压缩系统，和长期记忆 L0 -> L3 是另一条链路。

入口：`src/offload/index.ts` 的 `registerOffload(api, offloadConfig)`。

它做的事情：

- 创建或复用 `SessionRegistry`。
- 按配置选择后端：
  - `backend`：调用远端 offload backend。
  - `local`：直接调用 OpenAI-compatible LLM。
  - `collect`：采集为主。
- 注册 OpenClaw hooks 和 context engine。
- 维护 offload 状态、refs、jsonl、Mermaid 文件。

### 8.1 Offload 数据结构

关键路径由 `StorageContext` 管理，见 `src/offload/storage.ts`：

- `refs/`
  - 保存原始工具调用结果的 Markdown。
- `mmds/`
  - 保存 Mermaid 任务图。
- `offload-<sessionId>.jsonl`
  - 保存工具调用摘要条目。
- `state.json`
  - 保存 session 内 offload 状态。

### 8.2 L1: 工具调用摘要

触发点：`after_tool_call`。

关键文件：

- `src/offload/hooks/after-tool-call.ts`
- `src/offload/index.ts`

流程：

```text
after_tool_call
  -> 收集 toolName/toolCallId/params/result/error
  -> 写入 pending tool pairs
  -> flushL1()
  -> 写 refs/*.md 保留原始结果
  -> LLM/backend 生成摘要 entries
  -> 写 offload jsonl
```

如果 L1 调用失败超过重试上限，会生成 degraded fallback entry，保证链路继续可用。

### 8.3 L1.5: 任务边界判断

L1.5 判断当前用户消息是否延续旧任务、开启新任务或结束任务。

核心逻辑在 `src/offload/index.ts` 的 `attemptL15()` / `judgeL15()` 附近。

结果会影响：

- 当前 active MMD 文件。
- 当前 entries 属于哪个任务。
- 是否可以注入 MMD。

失败时会走 fail-safe，把边界标为 short，避免错误 MMD 污染上下文。

### 8.4 L2: Mermaid 任务图生成

关键文件：

- `src/offload/pipelines/l2-mermaid.ts`
- `src/offload/index.ts`

流程：

```text
offload jsonl 中 node_id=null 的 entries 达到阈值
  -> runL2WithBackend()
  -> 读取当前 MMD
  -> LLM/backend 生成 Mermaid patch
  -> patchMmd()
  -> backfill node_id
```

设计目标是让上下文里只保留轻量 Mermaid 任务图，需要详情时再通过 node_id 找回 refs 原文。

### 8.5 L3: 上下文压缩

触发点：

- `after_tool_call`
- `before_prompt_build`

关键文件：

- `src/offload/hooks/after-tool-call.ts`
- `src/offload/hooks/before-prompt-build.ts`
- `src/offload/hooks/llm-input-l3.ts`
- `src/offload/l3-helpers.ts`
- `src/offload/context-token-tracker.ts`

压缩分级：

- mild：
  - 替换工具结果为摘要。
- aggressive：
  - 删除较旧或低分工具内容。
  - 注入历史 MMD 作为结构化上下文。
- emergency：
  - 当仍然超过阈值时执行更强的兜底裁剪。

`before_prompt_build` 还会做 fast-path reapply：

- 对已经 confirmed offload 的消息重新替换。
- 对已经 deleted 的消息重新删除。
- 再注入 active/history MMD。

## 9. 配置模型

配置定义和默认值在 `src/config.ts`。

主要配置组：

- `timezone`
- `capture`
- `extraction`
- `persona`
- `pipeline`
- `recall`
- `embedding`
- `storeBackend`
- `tcvdb`
- `bm25`
- `memoryCleanup`
- `report`
- `llm`
- `offload`

OpenClaw 配置 schema 在 `openclaw.plugin.json`，与 `parseConfig()` 基本对应。

需要注意的默认行为：

- `capture.enabled = true`
- `extraction.enabled = true`
- `recall.enabled = true`
- `storeBackend = "sqlite"`
- `embedding.provider = "none"`，因此零配置默认不开向量检索。
- `offload.enabled = false`，短期压缩默认关闭。

## 10. 稳定性与并发设计点

代码里有不少显式防护，后续拆解可以重点看这些点：

1. Store init once-async
   - `src/utils/pipeline-factory.ts` 用 `_storeInitCache` 按 `pluginDataDir` 缓存初始化 Promise。

2. Scheduler start gate
   - `TdaiCore` 用 `schedulerStartPromise` 避免并发请求重复启动 scheduler。

3. Session end 和 gateway stop 分离
   - `handleSessionEnd()` 只 flush 指定 session。
   - `destroy()` 才销毁 scheduler/store/embedding。

4. Background embedding drain
   - SQLite L0 deferred embedding 是 fire-and-forget。
   - `TdaiCore.destroy()` 会在关闭 store 前等待后台任务，带 5 秒 timeout。

5. Capture atomic checkpoint
   - `performAutoCapture()` 通过 `CheckpointManager.captureAtomically()` 保护捕获游标。

6. Recall timeout
   - `performAutoRecall()` 用 `Promise.race` 防止召回阻塞用户。

7. Degraded mode
   - SQLite 和 TCVDB 初始化失败或能力缺失时，上层会降级到更少能力，而不是直接崩溃。

8. Offload patch-effectiveness detection
   - `after_tool_call` 会检测 `event.messages` 是否存在，判断 OpenClaw runtime patch 是否生效。

## 11. 推荐拆解顺序

如果后续要系统拆这个项目，建议按以下顺序：

1. 先讲整体入口和生命周期
   - `index.ts`
   - `TdaiCore`
   - `HostAdapter`
   - `LLMRunner`

2. 再讲长期记忆数据流
   - auto recall
   - auto capture
   - L0 recorder
   - L1 extractor/dedup/writer
   - L2 scene
   - L3 persona

3. 再讲 pipeline 调度
   - threshold
   - idle timer
   - warm-up
   - L2 downward-only timer
   - session flush
   - checkpoint

4. 再讲存储后端
   - `IMemoryStore`
   - SQLite schema
   - TCVDB collections
   - embedding service
   - profile sync

5. 单独讲 Context Offload
   - hooks
   - refs/jsonl/mmd
   - L1/L1.5/L2/L3
   - compression policy
   - context engine

6. 最后讲工具链
   - seed CLI
   - SQLite -> TCVDB migration
   - TCVDB export
   - read-local-memory
   - Hermes plugin / Docker

## 12. 后续值得深入的问题

这些是后续继续拆解时可以单独成文的问题：

1. `recordConversation()` 如何从 OpenClaw message 中准确抽取本轮用户和助手消息？
2. L1 extraction prompt 的输出 schema 和 dedup 策略如何保证稳定？
3. SQLite FTS5 + sqlite-vec 的查询质量和性能边界在哪里？
4. TCVDB native hybrid search 的 sparse vector 生成和 RRF 细节如何工作？
5. L2 scene index 如何被注入给 LLM，以及 LLM 如何通过 `read_file` 下钻？
6. Offload 的 active MMD 和 history MMD 分别在什么位置注入？
7. `before_message_write` 去除 `<relevant-memories>` 是否覆盖所有消息形态？
8. `gateway_stop` 3 秒超时下是否可能丢失尚未 flush 的 pipeline 工作？
9. Hermes Gateway 的鉴权默认关闭，生产部署应如何配置？
10. 迁移脚本如何校验 SQLite 与 TCVDB 的层级数据一致性？

