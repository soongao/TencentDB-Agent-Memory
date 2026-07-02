# 长期记忆图版入口

这份只看图，文字尽量少。先按下面顺序看，先建立脑图，再回头查长文。

| 你想看什么 | 看哪张图 |
| --- | --- |
| 长期记忆整体怎么转 | 1. 一张总览图 |
| 一轮对话结束后怎么写记忆 | 2. 写路径 |
| 下一轮对话前怎么召回 | 3. 读路径 |
| L0/L1/L2/L3 分别是什么 | 4. 四层记忆 |
| 数据实际存在哪里 | 5. 数据落在哪里 |
| Pipeline 什么时候触发 | 6. Pipeline 什么时候跑 |
| Debug 应该从哪里查 | 7. Debug 排查树 |
| 代码文件从哪里进 | 8. 关键代码地图 |

## 1. 一张总览图

```mermaid
flowchart LR
  U[用户对话] --> OC[OpenClaw / Gateway]

  OC -->|before_prompt_build| R[读路径: 召回]
  R --> L1S[搜 L1 结构化记忆]
  R --> L2R[读 L2 Scene Navigation]
  R --> L3R[读 L3 Persona]
  L1S --> INJ[注入 Prompt]
  L2R --> INJ
  L3R --> INJ
  INJ --> A[Agent 回答]

  A -->|agent_end / capture| W[写路径: 捕获与提炼]
  W --> L0[L0 原始对话]
  L0 --> P[Pipeline 调度]
  P --> L1[L1 结构化记忆]
  L1 --> L2[L2 场景块]
  L2 --> L3[L3 用户画像 Persona]

  L1 -. 下轮召回 .-> L1S
  L2 -. 下轮召回 .-> L2R
  L3 -. 下轮召回 .-> L3R
```

## 2. 写路径：一轮对话结束后发生什么

```mermaid
sequenceDiagram
  participant OC as OpenClaw/Gateway
  participant Core as TdaiCore
  participant Cap as performAutoCapture
  participant CP as Checkpoint
  participant L0 as L0 Recorder
  participant Store as SQLite/TCVDB
  participant PM as PipelineManager
  participant L1 as L1 Extractor
  participant L2 as SceneExtractor
  participant L3 as PersonaGenerator

  OC->>Core: handleTurnCommitted(turn)
  Core->>Core: ensureSchedulerStarted()
  Core->>Cap: performAutoCapture(...)
  Cap->>CP: captureAtomically(sessionKey)
  CP->>L0: recordConversation(rawMessages)
  L0-->>CP: filteredMessages
  CP-->>Cap: advance capture cursor
  Cap->>Store: upsertL0(messages)
  Cap->>PM: notifyConversation(sessionKey)

  PM->>PM: threshold / idle 判断
  PM->>L1: runL1(sessionKey)
  L1->>Store: queryL0GroupedBySessionId()
  L1->>L1: LLM 抽取 + dedup
  L1->>Store: upsertL1(records)
  L1-->>PM: L1 complete

  PM->>PM: advanceL2Timer()
  PM->>L2: runL2(sessionKey)
  L2->>Store: query L1 records
  L2->>L2: 生成/更新 scene blocks
  L2-->>PM: L2 complete

  PM->>L3: maybe runL3()
  L3->>L3: 判断 triggerEveryN
  L3->>L3: 生成 persona.md
```

## 3. 读路径：下一轮对话前怎么召回

```mermaid
sequenceDiagram
  participant OC as OpenClaw/Gateway
  participant Core as TdaiCore
  participant Recall as performAutoRecall
  participant Store as SQLite/TCVDB
  participant Files as persona.md / scene_index
  participant Prompt as Prompt Builder

  OC->>Core: handleBeforeRecall(userText, sessionKey)
  Core->>Recall: performAutoRecall(...)

  Recall->>Recall: sanitize userText
  Recall->>Store: search L1 memories
  Store-->>Recall: relevant L1 records

  Recall->>Files: read persona.md
  Files-->>Recall: L3 persona 或空

  Recall->>Files: read scene index
  Files-->>Recall: L2 scene navigation 或空

  Recall-->>OC: prependContext + appendSystemContext
  OC->>Prompt: 注入 prompt
```

注入位置：

```mermaid
flowchart TB
  SP[System Prompt] --> ASC[appendSystemContext<br/>Persona + Scene Navigation + Tools Guide]
  U[User Prompt] --> PC[prependContext<br/>相关 L1 记忆]
  PC --> UP[最终用户消息]
  ASC --> FINAL[最终发给模型的上下文]
  UP --> FINAL
```

## 4. 四层记忆分别存什么

```mermaid
flowchart TB
  L0[L0 原始对话<br/>用户/助手消息<br/>证据层]
  L1[L1 结构化记忆<br/>persona / episodic / instruction<br/>事实层]
  L2[L2 场景块<br/>某类长期活动或主题<br/>结构层]
  L3[L3 Persona<br/>用户画像<br/>高层稳定偏好]

  L0 -->|LLM extraction| L1
  L1 -->|Scene extraction| L2
  L2 -->|Persona generation| L3

  L0 -. 可搜索原话 .-> Search0[tdai_conversation_search]
  L1 -. 自动召回/工具搜索 .-> Search1[tdai_memory_search]
  L2 -. 注入导航 .-> Nav[scene navigation]
  L3 -. 注入系统上下文 .-> Persona[persona.md]
```

## 5. 数据落在哪里

```mermaid
flowchart LR
  CFG[storeBackend]

  CFG -->|sqlite| SQL[SQLite: vectors.db]
  SQL --> L0T[l0_conversations]
  SQL --> L0F[l0_fts]
  SQL --> L0V[l0_vec]
  SQL --> L1T[l1_records]
  SQL --> L1F[l1_fts]
  SQL --> L1V[l1_vec]

  CFG -->|tcvdb| VDB[Tencent Cloud VectorDB]
  VDB --> C0[database_l0_conversations]
  VDB --> C1[database_l1_memories]
  VDB --> CP[database_profiles]

  FS[本地文件系统] --> JSONL[conversations/ records/]
  FS --> Scene[scene_blocks/]
  FS --> PersonaFile[persona.md]
  FS --> Meta[.metadata checkpoint/manifest]
```

## 6. Pipeline 什么时候跑

```mermaid
stateDiagram-v2
  [*] --> Captured: agent_end 捕获 L0
  Captured --> Notify: scheduler.notifyConversation()

  Notify --> L1Now: conversation_count >= threshold
  Notify --> L1Later: 未达阈值
  L1Later --> L1Now: idle timeout

  L1Now --> L1Run: enqueueL1/runL1
  L1Run --> L2Wait: L1 成功
  L1Run --> Retry: L1 失败
  Retry --> L1Later: 重试 idle timer

  L2Wait --> L2Run: delayAfterL1 + minInterval
  L2Run --> L3Check: L2 完成
  L3Check --> L3Run: PersonaTrigger 通过
  L3Check --> Done: 未达到 triggerEveryN
  L3Run --> Done: persona.md 更新
```

## 7. Debug 排查树

```mermaid
flowchart TB
  Q[长期记忆没生效] --> Q1{before_prompt_build<br/>有触发吗}
  Q1 -->|否| A1[查插件注册和 hook policy]
  Q1 -->|是| Q2{agent_end/capture<br/>有触发吗}

  Q2 -->|否| A2[查 agent 是否 success<br/>capture.enabled<br/>sessionFilter]
  Q2 -->|是| Q3{L0 有记录吗}

  Q3 -->|否| A3[查 recordConversation<br/>sessionKey<br/>capture cursor]
  Q3 -->|是| Q4{L1 有记录吗}

  Q4 -->|否| A4[查 extraction.enabled<br/>scheduler.notifyConversation<br/>threshold/idle<br/>LLM runner]
  Q4 -->|是| Q5{召回命中吗}

  Q5 -->|否| A5[查 recall.strategy<br/>scoreThreshold<br/>embedding/FTS<br/>query 是否太短]
  Q5 -->|是| Q6{Prompt 里注入了吗}

  Q6 -->|否| A6[查 prependContext<br/>appendSystemContext<br/>recall timeout]
  Q6 -->|是| OK[长期记忆链路基本正常]
```

## 8. 关键代码地图

```mermaid
flowchart LR
  Core[src/core/tdai-core.ts]

  Core --> Recall[src/core/hooks/auto-recall.ts]
  Core --> Capture[src/core/hooks/auto-capture.ts]
  Capture --> L0[src/core/conversation/l0-recorder.ts]

  Capture --> PM[src/utils/pipeline-manager.ts]
  PM --> PF[src/utils/pipeline-factory.ts]
  PF --> L1[src/core/record/l1-extractor.ts<br/>l1-dedup.ts<br/>l1-writer.ts]
  PF --> L2[src/core/scene/scene-extractor.ts]
  PF --> L3[src/core/persona/persona-generator.ts]

  L1 --> Store[src/core/store/types.ts]
  Recall --> Store
  Store --> SQLite[src/core/store/sqlite.ts]
  Store --> TCVDB[src/core/store/tcvdb.ts]
```
