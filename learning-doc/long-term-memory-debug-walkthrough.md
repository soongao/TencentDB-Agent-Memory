# 长期记忆 Debug 链路走查：从一轮真实对话到下一轮召回

本文用一个具体场景模拟长期记忆从“捕获”到“召回”的完整过程。示例输入是人为构造的，但每一步对应项目里的真实代码链路。

如果你只想先看图，先打开：[长期记忆图版入口](./long-term-memory-visual-map.md)。这篇长文只作为查代码细节和 debug 顺序的补充。

范围限定：

- 只看长期记忆主链路。
- 不看 `src/offload/` 的短期上下文压缩。
- 默认宿主是 OpenClaw。
- 默认配置是 SQLite 后端、`capture/extraction/recall` 开启。
- 如果 `embedding.provider = "none"`，向量召回不可用，会走 keyword/FTS 可用路径或降级。

## 1. 示例场景

假设用户在一次对话里告诉 Agent：

```text
用户：
我最近在做 TencentDB Agent Memory 项目拆解，后面回答请尽量用中文，
并且我关注长期记忆链路，暂时不想看 offload。

助手：
好的，我会优先围绕长期记忆 L0/L1/L2/L3、召回、存储和 pipeline 调度来解释。
```

这轮对话里，长期记忆系统理论上应该沉淀出几类信息：

```text
instruction:
- 用户希望后续回答尽量用中文。
- 用户当前关注长期记忆链路，暂时不看 offload。

episodic:
- 用户最近在拆解 TencentDB Agent Memory 项目。

persona:
- 用户偏好工程化、链路化的项目拆解方式。
```

后续用户再问：

```text
用户：
继续讲我关注的那条主链路。
```

系统应该能召回“用户关注长期记忆链路，暂时不看 offload”，然后在回答里优先讲长期记忆主链路。

下面按代码路径走完整过程。

## 2. 插件启动阶段：长期记忆能力如何被接上

入口文件：

```text
index.ts
```

启动阶段大致链路：

```text
register(api)
  -> parseConfig(api.pluginConfig)
  -> initTimeModule()
  -> initDataDirectories(pluginDataDir)
  -> new OpenClawHostAdapter(...)
  -> new TdaiCore(...)
  -> core.initialize()
  -> registerTool(tdai_memory_search)
  -> registerTool(tdai_conversation_search)
  -> api.on("before_prompt_build", ...)
  -> api.on("before_message_write", ...)
  -> api.on("agent_end", ...)
  -> api.on("gateway_stop", ...)
```

你调试时先确认这些日志或状态：

```text
[memory-tdai] Registering plugin
[memory-tdai] Config parsed
[memory-tdai] Data dir
[memory-tdai] Registering before_prompt_build hook
[memory-tdai] Registering agent_end hook
```

对应能力：

- `before_prompt_build` 负责下一轮对话前召回。
- `agent_end` 负责本轮对话后捕获和写入。
- `before_message_write` 负责防止 `<relevant-memories>` 这种注入内容污染历史消息。

## 3. 初始化 Core：store 和 pipeline 怎么准备好

入口文件：

```text
src/core/tdai-core.ts
```

`core.initialize()` 里做两件关键事：

```text
initDataDirectories(this.dataDir)
this.storeReady = this.initStores()
this.scheduler = createPipelineManager(...)
this.storeReady.then(() => this.wirePipelineRunners())
```

对应代码概念：

- `initStores()` 创建 SQLite 或 TCVDB store。
- `createPipelineManager()` 创建 L1/L2/L3 调度器。
- `wirePipelineRunners()` 把 L1/L2/L3 runner 接到 scheduler 上。

关键文件：

```text
src/utils/pipeline-factory.ts
src/utils/pipeline-manager.ts
src/core/store/factory.ts
```

如果这里失败，后续现象通常是：

- L0 JSONL 可能还能写。
- 向量/FTS 检索不可用。
- L1 dedup 和 recall 会降级。
- 日志里会看到 `Store init failed` 或 `Store is in degraded mode`。

## 4. 第一轮对话前：before_prompt_build 先尝试召回

第一轮对话通常还没有历史记忆。

OpenClaw 在构造 prompt 前触发：

```text
before_prompt_build
  -> core.handleBeforeRecall(userText, sessionKey)
  -> performAutoRecall(...)
```

入口文件：

```text
index.ts
src/core/tdai-core.ts
src/core/hooks/auto-recall.ts
```

这时 `userText` 是：

```text
我最近在做 TencentDB Agent Memory 项目拆解，后面回答请尽量用中文，
并且我关注长期记忆链路，暂时不想看 offload。
```

`performAutoRecall()` 会做三件事：

```text
1. search L1 memories
2. read persona.md
3. read scene index and generate scene navigation
```

第一轮通常都为空：

```text
L1 memories: none
persona.md: not found
scene index: not found
```

所以返回：

```text
undefined 或空 RecallResult
```

调试观察点：

```text
[memory-tdai] [recall] No persona file found
[memory-tdai] [recall] No scene index found
[memory-tdai] [recall] no context to inject
```

这一步没有写入长期记忆，只是尝试读取。

## 5. 第一轮对话结束：agent_end 开始捕获

当助手回答结束后，OpenClaw 触发：

```text
agent_end
```

入口文件：

```text
index.ts
```

核心调用：

```text
core.handleTurnCommitted({
  userText,
  assistantText,
  messages,
  sessionKey,
  sessionId,
  startedAt,
  originalUserMessageCount
})
```

进入：

```text
src/core/tdai-core.ts
  -> handleTurnCommitted()
  -> ensureSchedulerStarted()
  -> performAutoCapture()
```

这里有一个重要细节：`ensureSchedulerStarted()` 会读取 checkpoint，把上次未完成的 pipeline 状态恢复回来。

调试观察点：

```text
[memory-tdai] [core] Scheduler started
[memory-tdai] [agent_end] Hook triggered
[memory-tdai] [capture] ...
```

## 6. L0 捕获：原始消息如何落盘

入口文件：

```text
src/core/hooks/auto-capture.ts
src/core/conversation/l0-recorder.ts
src/utils/checkpoint.ts
```

`performAutoCapture()` 先进入 checkpoint 的原子捕获逻辑：

```text
checkpoint.captureAtomically(
  sessionKey,
  pluginStartTimestamp,
  async (afterTimestamp) => {
    filteredMessages = await recordConversation(...)
    return { maxTimestamp, messageCount }
  }
)
```

这一步解决的问题是：同一个 session 并发触发 `agent_end` 时，不要重复读取旧 cursor，导致重复写 L0。

对于我们的示例，`recordConversation()` 大致会筛出：

```text
[
  {
    role: "user",
    content: "我最近在做 TencentDB Agent Memory 项目拆解...",
    timestamp: 具体时间戳
  },
  {
    role: "assistant",
    content: "好的，我会优先围绕长期记忆 L0/L1/L2/L3...",
    timestamp: 具体时间戳
  }
]
```

然后写入 L0 本地文件和 store。

本地文件层面，通常在 plugin data dir 下：

```text
conversations/
```

store 层面调用：

```text
vectorStore.upsertL0(...)
```

SQLite 后端会写：

```text
l0_conversations
l0_fts
l0_vec   # 如果 embedding dimensions > 0
```

如果 `embedding.provider = "none"`：

- `dimensions = 0`
- `l0_vec` 不会真正承担向量检索
- 关键词路径仍取决于 FTS5 是否可用

调试观察点：

```text
[memory-tdai] [capture] L0 capture cursor
[memory-tdai] [capture] L0 recorded: 2 messages
[memory-tdai] [L0-vec-index] START indexing
[memory-tdai] [L0-vec-index] DONE
```

## 7. 通知 Pipeline：为什么不是立刻每次都完整抽取

L0 写完后，`performAutoCapture()` 会通知 scheduler：

```text
scheduler.notifyConversation(sessionKey, [])
```

入口文件：

```text
src/utils/pipeline-manager.ts
```

注意这里传的是空数组：

```text
// Pass empty array: L1 Runner reads from VectorStore DB (or L0 JSONL fallback)
```

也就是说，L1 不依赖这次内存里的 `filteredMessages`，而是回头从持久化的 L0 读取。

`notifyConversation()` 做这些事：

```text
state.conversation_count += 1
state.last_active_time = Date.now()
persistStates()
判断是否达到 L1 threshold
```

如果是新 session，warm-up 默认开启，第一次阈值通常是 1：

```text
conversation_count = 1
effectiveThreshold = 1
=> enqueueL1(sessionKey)
```

调试观察点：

```text
[memory-tdai] [pipeline] [sessionKey] notify: conversation_count=1/1
[memory-tdai] [pipeline] Conversation threshold reached
[memory-tdai] [pipeline] Enqueuing L1
```

如果不是第一次，且没有达到阈值，则会设置 idle timer：

```text
timers.l1Idle.schedule(...)
```

## 8. L1 Runner：从 L0 读取对话并抽取记忆

L1 runner 由这里创建：

```text
src/utils/pipeline-factory.ts
  -> createL1Runner()
```

执行时逻辑是：

```text
读取 checkpoint 中该 session 的 last_l1_cursor
从 vectorStore.queryL0GroupedBySessionId(sessionKey, cursor) 读取新 L0
如果 store 不可用，从 JSONL fallback 读取
对每个 sessionId group 调 extractL1Memories()
markL1ExtractionComplete()
```

对于我们的示例，L1 输入大致是：

```text
User:
我最近在做 TencentDB Agent Memory 项目拆解，后面回答请尽量用中文，
并且我关注长期记忆链路，暂时不想看 offload。

Assistant:
好的，我会优先围绕长期记忆 L0/L1/L2/L3、召回、存储和 pipeline 调度来解释。
```

`extractL1Memories()` 会调用 LLM，期望抽取类似结构：

```json
[
  {
    "content": "用户希望后续回答尽量使用中文。",
    "type": "instruction",
    "priority": 80,
    "scene_name": "项目拆解",
    "source_message_ids": ["..."],
    "metadata": {}
  },
  {
    "content": "用户当前关注 TencentDB Agent Memory 的长期记忆链路，暂时不想看 offload。",
    "type": "instruction",
    "priority": 85,
    "scene_name": "TencentDB Agent Memory 项目拆解",
    "source_message_ids": ["..."],
    "metadata": {}
  },
  {
    "content": "用户最近在做 TencentDB Agent Memory 项目拆解。",
    "type": "episodic",
    "priority": 60,
    "scene_name": "TencentDB Agent Memory 项目拆解",
    "source_message_ids": ["..."],
    "metadata": {
      "activity_start_time": "...",
      "activity_end_time": "..."
    }
  }
]
```

注意：上面 JSON 是为了说明可能结果，不是代码固定输出。

调试观察点：

```text
[memory-tdai] [pipeline-factory] [l1] L0 data source: VectorStore DB
[memory-tdai] [pipeline-factory] [l1] Processing 2 L0 messages
[memory-tdai] [l1-extractor] ...
[memory-tdai] [l1-writer] ...
[memory-tdai] [pipeline-factory] [l1] L1 complete
```

## 9. L1 Dedup：新记忆不是简单 append

入口文件：

```text
src/core/record/l1-dedup.ts
src/core/record/l1-writer.ts
```

如果 `extraction.enableDedup = true`，系统会判断新抽取的记忆是否和已有记忆冲突或重复。

可能动作：

```text
store   -> 直接保存新记忆
update  -> 更新某条已有记忆
merge   -> 合并多条已有记忆和新记忆
skip    -> 跳过
```

对于示例，如果这是第一次保存，大概率是 `store`。

如果之前已经有：

```text
用户偏好中文回答。
```

而这次又抽到：

```text
用户希望后续回答尽量使用中文。
```

dedup 可能会选择 `update` 或 `merge`。

调试观察点：

```text
DedupDecision
target_ids
merged_content
merged_type
merged_priority
```

最终写入：

```text
records/
vectors.db:l1_records
vectors.db:l1_fts
vectors.db:l1_vec   # 如果 embedding 可用
```

TCVDB 后端则写入：

```text
<database>_l1_memories
```

## 10. L1 完成后：L2 timer 被推进

L1 成功后回到：

```text
src/utils/pipeline-manager.ts
  -> runL1()
```

成功后做：

```text
state.l2_pending_l1_count = state.conversation_count
state.conversation_count = 0
advanceWarmupThreshold(state)
persistStates()
advanceL2Timer(sessionKey)
```

`advanceL2Timer()` 的设计是 downward-only：

```text
desiredTime = max(now + l2DelayAfterL1, lastL2 + l2MinInterval)
```

含义：

- L1 刚产出新记忆，L2 应该尽快跟进。
- 但不能太频繁，所以要尊重 `l2MinIntervalSeconds`。
- 如果当前已有更早的 L2 schedule，就不推迟它。

调试观察点：

```text
[memory-tdai] [pipeline] Warm-up advanced
[memory-tdai] [pipeline] L2 timer advanced
```

## 11. L2 Runner：把 L1 归纳成场景

入口文件：

```text
src/utils/pipeline-factory.ts
src/core/scene/scene-extractor.ts
```

L2 timer 到点后：

```text
enqueueL2(sessionKey)
  -> runL2(sessionKey)
  -> createL2Runner(...)
  -> queryMemoryRecords(...)
  -> SceneExtractor.extract(memories)
```

对于示例，L2 可能会创建或更新一个场景：

```text
场景名：TencentDB Agent Memory 项目拆解
场景内容：
- 用户正在拆解 TencentDB Agent Memory 项目。
- 当前关注长期记忆链路。
- 暂时不关注 Context Offload。
- 用户偏好中文、链路化、调试式解释。
```

这类场景会保存到：

```text
scene_blocks/
```

并维护 scene index。

调试观察点：

```text
[memory-tdai] [L2] Incremental query returned N record(s)
[memory-tdai] [L2] Extraction complete
scene_blocks/
scene index
```

如果 TCVDB 支持 profile sync，还会：

```text
pullProfilesToLocal()
syncLocalProfilesToStore()
```

## 12. L3 Runner：生成 Persona

入口文件：

```text
src/core/persona/persona-trigger.ts
src/core/persona/persona-generator.ts
```

L2 完成后可能触发 L3。

但 L3 不是每次都生成，先由 `PersonaTrigger` 判断：

```text
trigger.shouldGenerate()
```

常见条件与配置有关：

```text
persona.triggerEveryN
memories_since_last_persona
```

如果达到条件，执行：

```text
PersonaGenerator.generateLocalPersona(reason)
```

可能生成到：

```text
persona.md
```

示例 persona 可能包含：

```text
- 用户偏好中文沟通。
- 用户偏好围绕代码真实链路进行工程化拆解。
- 用户近期关注 TencentDB Agent Memory 的长期记忆主链路。
```

调试观察点：

```text
[memory-tdai] [L3] Starting persona generation
[memory-tdai] [L3] Persona generation succeeded
persona.md
```

如果记忆数量还没达到阈值，你会看到：

```text
[memory-tdai] [L3] Persona generation not needed
```

这不是异常。

## 13. 第二轮对话前：召回开始生效

现在用户发第二轮：

```text
继续讲我关注的那条主链路。
```

OpenClaw 再次触发：

```text
before_prompt_build
```

调用：

```text
core.handleBeforeRecall("继续讲我关注的那条主链路。", sessionKey)
  -> performAutoRecall()
```

`performAutoRecall()` 会：

```text
1. 清洗 userText
2. 根据 recall.strategy 搜索 L1
3. 读取 persona.md
4. 读取 scene index，生成 scene navigation
5. 返回 RecallResult
```

### 13.1 L1 相关记忆召回

如果 keyword/embedding/hybrid 能搜到，可能召回：

```text
- [instruction|TencentDB Agent Memory 项目拆解] 用户当前关注 TencentDB Agent Memory 的长期记忆链路，暂时不想看 offload。
- [instruction|项目拆解] 用户希望后续回答尽量使用中文。
```

这些会进入：

```text
prependContext
```

格式大致是：

```xml
<relevant-memories>
以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：

- [instruction|TencentDB Agent Memory 项目拆解] 用户当前关注 TencentDB Agent Memory 的长期记忆链路，暂时不想看 offload。
- [instruction|项目拆解] 用户希望后续回答尽量使用中文。
</relevant-memories>
```

### 13.2 Persona 和 Scene Navigation

如果已经有 `persona.md`，会进入：

```text
appendSystemContext
```

如果已经有 scene index，会生成：

```xml
<scene-navigation>
...
</scene-navigation>
```

同时追加：

```xml
<memory-tools-guide>
...
</memory-tools-guide>
```

这部分也进入 `appendSystemContext`。

调试观察点：

```text
[memory-tdai] [recall] Search strategy: hybrid
[memory-tdai] [recall] Persona loaded
[memory-tdai] [recall] Scene navigation generated
[memory-tdai] [before_prompt_build] Recall complete
```

## 14. 为什么还要 before_message_write

因为 `prependContext` 会插到用户 prompt 前。

如果不清理，历史对话里会保存这种内容：

```xml
<relevant-memories>
...
</relevant-memories>
继续讲我关注的那条主链路。
```

这会污染 L0，导致以后系统把“召回出来的记忆”再次当成用户真实说过的话。

所以 `index.ts` 注册了：

```text
before_message_write
```

它会把用户消息里的：

```text
<relevant-memories>...</relevant-memories>
```

移除后再落盘。

调试观察点：

```text
[memory-tdai] [before_message_write] Stripped
```

这个 hook 是长期记忆闭环里很重要的防污染点。

## 15. 第二轮结束后：继续捕获和增量抽取

第二轮 `agent_end` 后，又进入同样写路径：

```text
agent_end
  -> handleTurnCommitted()
  -> performAutoCapture()
  -> recordConversation()
  -> upsertL0()
  -> notifyConversation()
```

区别是：

- checkpoint 已有 L0 capture cursor。
- L1 runner 只读 cursor 之后的新 L0。
- L2 runner 也按 `last_extraction_updated_time` 读增量 L1。
- dedup 可能会更新已有长期偏好，而不是新增重复记忆。

这就是长期记忆的增量闭环。

## 16. 一次完整 Debug 时建议按这个顺序看日志

### 16.1 启动日志

确认插件、配置、store、pipeline：

```text
Registering plugin
Config parsed
Data dir
Stores initialized
Pipeline runners wired
Registering before_prompt_build hook
Registering agent_end hook
```

### 16.2 第一轮对话前

确认召回为空是正常的：

```text
before_prompt_build
performAutoRecall
No persona file found
No scene index found
no context to inject
```

### 16.3 第一轮对话后

确认 L0 捕获：

```text
agent_end
L0 capture cursor
L0 recorded
L0-vec-index DONE
Scheduler notified
```

### 16.4 L1 执行

确认从 L0 读取并抽取：

```text
L0 data source: VectorStore DB 或 JSONL files
Processing N L0 messages
L1 complete: extracted=..., stored=...
```

### 16.5 L2/L3

确认是否达到触发条件：

```text
L2 timer advanced
L2 running
Extraction complete
L3 Persona generation not needed
或
L3 Persona generation succeeded
```

### 16.6 第二轮对话前

确认召回生效：

```text
Search strategy
hits=N
Persona loaded
Scene navigation generated
Recall complete
```

## 17. 如果结果不符合预期，按这些分支排查

### 17.1 L0 没记录

看：

```text
capture.enabled
agent_end 是否 success
sessionFilter 是否跳过
sessionKey 是否为空
recordConversation 是否筛掉了消息
```

关键搜索词：

```text
cfg.capture.enabled
sessionFilter.shouldSkipCtx
resolveSessionKey
recordConversation
filteredMessages.length
```

### 17.2 L0 有记录，但 L1 没抽取

看：

```text
extraction.enabled
scheduler 是否创建
notifyConversation 是否触发
conversation_count 是否达到阈值
idle timer 是否还没到
L1 runner 是否缺 LLM config
```

关键搜索词：

```text
cfg.extraction.enabled
createPipelineManager
notifyConversation
enqueueL1
createL1Runner
No OpenClaw config and no LLM runner
```

### 17.3 L1 有记录，但召回不到

看：

```text
recall.enabled
recall.strategy
scoreThreshold 是否过高
embedding 是否没配置
FTS5 是否可用
查询文本是否太短或被 sanitize 后太短
```

关键搜索词：

```text
cfg.recall.enabled
scoreThreshold
embeddingAvailable
isFtsAvailable
sanitizeText
searchByKeyword
searchByEmbedding
searchHybrid
```

### 17.4 Persona 没生成

这通常不是 bug。

看：

```text
persona.triggerEveryN
memories_since_last_persona
PersonaTrigger.shouldGenerate()
```

关键搜索词：

```text
PersonaTrigger
shouldGenerate
triggerEveryN
memories_since_last_persona
```

### 17.5 召回内容污染了历史

看：

```text
before_message_write 是否触发
用户消息 content 是 string 还是 parts
是否包含 <relevant-memories>
```

关键搜索词：

```text
before_message_write
STRIP_RE
<relevant-memories>
```

## 18. 这条链路的最小心智模型

你可以把长期记忆当成两个半闭环：

```text
写入闭环：
agent_end
  -> L0 raw evidence
  -> L1 structured memory
  -> L2 scene
  -> L3 persona

读取闭环：
before_prompt_build
  -> query L1
  -> load L2 scene navigation
  -> load L3 persona
  -> inject prompt
  -> before_message_write strip injected memory
```

真正 debug 时，不要一上来怀疑 LLM 抽取。先确认：

```text
hook 有没有触发
sessionKey 是否稳定
L0 有没有写入
scheduler 有没有通知
L1 是否触发
store 是否 degraded
recall strategy 是否可用
```

这些确认完，再去看 prompt、dedup、scene、persona 的质量问题。
