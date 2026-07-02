# 长期记忆核心能力入门指南

本文档只关注 TencentDB Agent Memory 的长期记忆能力，不覆盖 `src/offload/` 下的短期上下文压缩系统。

长期记忆主线可以概括为：

```text
对话结束后写入记忆：
OpenClaw / Gateway
  -> TdaiCore.handleTurnCommitted()
  -> L0 原始对话捕获
  -> Pipeline 调度
  -> L1 结构化记忆抽取
  -> L2 场景归纳
  -> L3 Persona 生成

下一轮对话前使用记忆：
OpenClaw / Gateway
  -> TdaiCore.handleBeforeRecall()
  -> 搜索 L1 结构化记忆
  -> 读取 L2 scene navigation
  -> 读取 L3 persona.md
  -> 注入 prompt
```

## 1. 先建立核心视角

长期记忆不是一个单点功能，而是一套“写入 + 提炼 + 召回”的闭环。

最重要的 5 个问题：

1. 对话如何被捕获？
2. 原始对话如何变成结构化记忆？
3. 结构化记忆如何继续归纳成场景和用户画像？
4. 下一轮对话前如何召回和注入？
5. 数据最终存在本地 SQLite 还是 TCVDB？

如果只想快速理解主线，先看这些文件：

```text
src/core/tdai-core.ts
src/core/hooks/auto-capture.ts
src/core/hooks/auto-recall.ts
src/utils/pipeline-manager.ts
src/utils/pipeline-factory.ts
src/core/store/types.ts
```

## 2. 第一站：TdaiCore

入口文件：

```text
src/core/tdai-core.ts
```

`TdaiCore` 是长期记忆能力的核心门面。OpenClaw、Gateway、Hermes 这些宿主不应该直接操作 L0/L1/L2/L3 细节，而是调用 `TdaiCore`。

重点方法：

| 方法 | 作用 |
|---|---|
| `initialize()` | 初始化数据目录、store、pipeline |
| `handleBeforeRecall()` | 对话前召回记忆 |
| `handleTurnCommitted()` | 对话后捕获并触发 pipeline |
| `searchMemories()` | 搜索 L1 结构化记忆 |
| `searchConversations()` | 搜索 L0 原始对话 |
| `handleSessionEnd()` | flush 指定 session 的待处理工作 |
| `destroy()` | 关闭 scheduler、store、embedding、后台任务 |

建议先读这两个方法：

```text
handleBeforeRecall()
handleTurnCommitted()
```

它们分别代表长期记忆的“读路径”和“写路径”。

## 3. 写路径：对话如何进入长期记忆

写路径从 `handleTurnCommitted()` 开始。

```text
TdaiCore.handleTurnCommitted()
  -> performAutoCapture()
  -> recordConversation()
  -> vectorStore.upsertL0()
  -> scheduler.notifyConversation()
  -> createL1Runner()
  -> extractL1Memories()
  -> write L1
  -> createL2Runner()
  -> SceneExtractor.extract()
  -> createL3Runner()
  -> PersonaGenerator.generateLocalPersona()
```

### 3.1 L0：原始对话捕获

入口文件：

```text
src/core/hooks/auto-capture.ts
src/core/conversation/l0-recorder.ts
```

L0 的目标是保存原始对话证据。它不是抽象总结，而是可追溯的消息记录。

要关注的点：

- `performAutoCapture()` 如何被调用。
- `recordConversation()` 如何从 raw messages 中筛选用户和助手消息。
- checkpoint 如何避免重复捕获历史消息。
- L0 如何同时写入 JSONL 和 store。
- SQLite 下为什么支持后台补 embedding。

关键搜索词：

```text
performAutoCapture
recordConversation
captureAtomically
upsertL0
filteredMessages
```

### 3.2 Pipeline：什么时候抽取 L1

入口文件：

```text
src/utils/pipeline-manager.ts
src/utils/pipeline-factory.ts
```

`auto-capture` 只负责捕获和通知，不直接决定什么时候跑 L1/L2/L3。真正的调度由 `MemoryPipelineManager` 控制。

L1 触发条件主要有两类：

- 会话轮数达到阈值。
- session idle 超时。

新 session 还有 warm-up 机制：

```text
1 -> 2 -> 4 -> ... -> everyNConversations
```

这样可以让新用户/新会话早期更快沉淀记忆，后面降低处理频率。

关键搜索词：

```text
MemoryPipelineManager
notifyConversation
getEffectiveThreshold
advanceWarmupThreshold
enqueueL1
runL1
l1Idle
```

### 3.3 L1：结构化记忆抽取

入口文件：

```text
src/core/record/l1-extractor.ts
src/core/record/l1-dedup.ts
src/core/record/l1-writer.ts
src/core/prompts/l1-extraction.ts
src/core/prompts/l1-dedup.ts
```

L1 的目标是把原始对话变成结构化事实。

当前记忆类型是三类：

| 类型 | 含义 |
|---|---|
| `persona` | 用户身份、偏好、长期稳定信息 |
| `episodic` | 具体事件、活动、阶段性经历 |
| `instruction` | 用户明确要求、规则、偏好约束 |

L1 不是简单 append。它会做去重和合并：

| action | 含义 |
|---|---|
| `store` | 新记忆直接保存 |
| `update` | 更新已有记忆 |
| `merge` | 多条相关记忆合并 |
| `skip` | 重复或无价值，跳过 |

关键搜索词：

```text
extractL1Memories
ExtractedMemory
MemoryRecord
DedupDecision
enableDedup
writeMemoryRecords
upsertL1
```

### 3.4 L2：场景归纳

入口文件：

```text
src/core/scene/scene-extractor.ts
src/core/scene/scene-index.ts
src/core/scene/scene-navigation.ts
src/core/prompts/scene-extraction.ts
```

L2 的目标是把 L1 的碎片事实归纳成场景块。

L2 解决的问题是：只靠一堆 L1 记忆，Agent 可能知道很多零散事实，但缺少“这个用户在哪些场景里长期活动”的结构感。

重点关注：

- `SceneExtractor` 如何读取 L1 records。
- scene block 如何保存。
- scene index 如何维护。
- recall 时 scene navigation 如何生成。

关键搜索词：

```text
SceneExtractor
readSceneIndex
generateSceneNavigation
SceneIndexEntry
scene_blocks
```

### 3.5 L3：Persona 用户画像

入口文件：

```text
src/core/persona/persona-trigger.ts
src/core/persona/persona-generator.ts
src/core/prompts/persona-generation.ts
src/core/profile/profile-sync.ts
```

L3 的目标是生成更稳定、更高层的用户画像。

它通常落到：

```text
persona.md
```

重点关注：

- `PersonaTrigger` 如何判断是否该生成。
- `PersonaGenerator` 如何生成本地 persona。
- L2/L3 profile 如何和远端 store 同步。
- 备份数量如何控制。

关键搜索词：

```text
PersonaTrigger
shouldGenerate
PersonaGenerator
generateLocalPersona
persona.md
syncLocalProfilesToStore
pullProfilesToLocal
```

## 4. 读路径：下一轮如何召回长期记忆

入口文件：

```text
src/core/hooks/auto-recall.ts
```

读路径从 `handleBeforeRecall()` 开始。

```text
TdaiCore.handleBeforeRecall()
  -> performAutoRecall()
  -> search L1 memories
  -> read persona.md
  -> read scene index
  -> generate scene navigation
  -> return prependContext / appendSystemContext
```

召回分两部分注入：

| 字段 | 内容 | 注入位置 | 特点 |
|---|---|---|---|
| `prependContext` | 当前 query 相关的 L1 记忆 | 用户 prompt 前 | 每轮变化，动态 |
| `appendSystemContext` | L3 persona、L2 scene navigation、工具说明 | system prompt 后 | 相对稳定，利于缓存 |

重点关注：

- 为什么 L1 记忆放进 `prependContext`。
- 为什么 persona / scene navigation 放进 `appendSystemContext`。
- `<relevant-memories>` 如何在落盘前被清理掉。
- recall 超时后如何降级。

关键搜索词：

```text
performAutoRecall
searchMemories
prependContext
appendSystemContext
MEMORY_TOOLS_GUIDE
stripSceneNavigation
readSceneIndex
generateSceneNavigation
timeoutMs
```

## 5. 主动搜索工具

长期记忆除了自动注入，还提供 Agent 主动搜索工具。

OpenClaw 注册位置：

```text
index.ts
```

工具实现：

```text
src/core/tools/memory-search.ts
src/core/tools/conversation-search.ts
```

两个工具：

| 工具 | 搜索范围 | 用途 |
|---|---|---|
| `tdai_memory_search` | L1 结构化记忆 | 找用户偏好、历史事件、规则、场景事实 |
| `tdai_conversation_search` | L0 原始对话 | 找原话、上下文细节、证据 |

关键搜索词：

```text
tdai_memory_search
tdai_conversation_search
executeMemorySearch
executeConversationSearch
formatSearchResponse
formatConversationSearchResponse
```

## 6. 检索能力：keyword / embedding / hybrid

入口文件：

```text
src/core/hooks/auto-recall.ts
src/core/store/types.ts
src/core/store/sqlite.ts
src/core/store/tcvdb.ts
```

支持三类召回策略：

| strategy | 机制 | 依赖 |
|---|---|---|
| `keyword` | 关键词 / FTS / BM25 | FTS5 或 TCVDB sparse |
| `embedding` | 向量相似度 | embedding service + vector store |
| `hybrid` | 关键词和向量融合 | SQLite 客户端 RRF 或 TCVDB native hybrid |

SQLite 路径：

- L1/L0 metadata 存在普通表。
- 向量存在 `vec0` 虚拟表。
- 关键词索引存在 FTS5 表。
- hybrid 通过客户端 RRF 合并关键词和向量结果。

TCVDB 路径：

- L1/L0 分别是 collection。
- dense embedding 可由服务端生成。
- BM25 sparse vector 由本地 encoder 生成。
- hybrid search 走 TCVDB 原生能力。

关键搜索词：

```text
searchByKeyword
searchByEmbedding
searchHybrid
buildFtsQuery
searchL1Vector
searchL1Fts
searchL1Hybrid
nativeHybridSearch
```

## 7. 存储抽象：先读接口，再读实现

先看接口：

```text
src/core/store/types.ts
```

核心接口：

```text
IMemoryStore
```

它把上层需要的能力分成：

- 生命周期：`init()`、`close()`、`isDegraded()`
- L1 写入：`upsertL1()`、`deleteL1()`
- L1 查询：`queryL1Records()`、`searchL1Vector()`、`searchL1Fts()`、`searchL1Hybrid()`
- L0 写入：`upsertL0()`
- L0 查询：`queryL0ForL1()`、`queryL0GroupedBySessionId()`、`searchL0Vector()`、`searchL0Fts()`
- profile 同步：`pullProfiles()`、`syncProfiles()`、`deleteProfiles()`

然后再看具体实现：

```text
src/core/store/sqlite.ts
src/core/store/tcvdb.ts
src/core/store/factory.ts
```

关键搜索词：

```text
IMemoryStore
StoreCapabilities
createStoreBundle
VectorStore
TcvdbMemoryStore
isDegraded
```

## 8. 配置如何影响长期记忆

入口文件：

```text
src/config.ts
openclaw.plugin.json
```

重点配置组：

| 配置组 | 影响 |
|---|---|
| `capture` | 是否捕获 L0、排除哪些 agent、L0/L1 保留多久 |
| `extraction` | 是否抽取 L1、是否 dedup、单次最大记忆数、使用哪个模型 |
| `pipeline` | L1/L2/L3 的触发频率和 idle 策略 |
| `recall` | 是否自动召回、召回数量、阈值、策略、超时 |
| `embedding` | 是否支持向量检索和向量维度 |
| `storeBackend` | 使用 SQLite 还是 TCVDB |
| `tcvdb` | TCVDB 地址、库名、模型、认证 |
| `bm25` | TCVDB sparse vector 编码 |
| `persona` | L2/L3 生成频率、场景数、备份数 |
| `llm` | 是否绕过宿主模型，使用 standalone LLM 做抽取 |

默认要特别注意：

- `capture.enabled = true`
- `extraction.enabled = true`
- `recall.enabled = true`
- `storeBackend = "sqlite"`
- `embedding.provider = "none"`，所以零配置默认不开向量检索。

## 9. 推荐阅读顺序

建议按下面顺序读，不要一开始就钻进所有文件：

```text
1. src/core/tdai-core.ts
2. src/core/hooks/auto-capture.ts
3. src/core/conversation/l0-recorder.ts
4. src/utils/pipeline-manager.ts
5. src/utils/pipeline-factory.ts
6. src/core/record/l1-extractor.ts
7. src/core/record/l1-dedup.ts
8. src/core/record/l1-writer.ts
9. src/core/hooks/auto-recall.ts
10. src/core/tools/memory-search.ts
11. src/core/tools/conversation-search.ts
12. src/core/store/types.ts
13. src/core/store/sqlite.ts 或 src/core/store/tcvdb.ts
14. src/core/scene/*
15. src/core/persona/*
```

## 10. 可以按这些问题继续拆

后续如果继续写学习文档，可以每个问题单独成篇：

1. L0 捕获如何避免重复记录历史消息？
2. L1 prompt 如何要求模型输出结构化记忆？
3. L1 dedup 如何决定 store/update/merge/skip？
4. Pipeline 的 warm-up 为什么从 1 轮开始？
5. L2 scene block 如何被生成和索引？
6. L3 persona 什么时候生成，如何避免频繁重写？
7. 自动召回为什么拆成 `prependContext` 和 `appendSystemContext`？
8. SQLite 的 FTS5 和 sqlite-vec 如何一起支持 hybrid？
9. TCVDB 的 dense + sparse + RRF 如何映射到 `IMemoryStore`？
10. 失败时 degraded mode 如何保证主流程继续？

