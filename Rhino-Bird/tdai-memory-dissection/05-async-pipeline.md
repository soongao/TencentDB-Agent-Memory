# 05 Async Pipeline

## Async Trigger Points

| Trigger | Code | Async mechanism | State used |
| --- | --- | --- | --- |
| Deferred L0 embedding | `auto-capture.ts` | fire-and-forget promise registered in `TdaiCore.bgTasks` | L0 record ids, embedding service |
| Scheduler start | `tdai-core.ts:ensureSchedulerStarted()` | shared promise gate | checkpoint pipeline states |
| L1 threshold | `pipeline-manager.ts:notifyConversation()` | `SerialQueue("L1")` | `conversation_count`, message buffer |
| L1 idle timeout | `ManagedTimer` from `notifyConversation()` | resettable timer | message buffer |
| L1 retry | `runL1()` catch branch | retry timer, max 5 | restored buffer |
| L2 delay-after-L1 | `advanceL2Timer()` | downward-only timer | `l2LastRunTime`, min interval |
| L2 max interval | `armL2MaxInterval()` | periodic timer | active window |
| L3 persona | `triggerL3()` | global serial queue with pending flag | scene/profile checkpoint |
| CLI Gateway watchdog | `runtime.py:ensure_watchdog_running()` | separate Python process | heartbeat + gateway pid |
| Hermes watchdog | `MemoryTencentdbProvider._watchdog_loop()` | daemon thread | Gateway health |

## Pipeline State Diagram

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Capturing: /capture or agent_end
  Capturing --> L0Written: recordConversation + upsertL0
  L0Written --> Buffered: notifyConversation
  Buffered --> L1Queued: threshold reached
  Buffered --> L1Queued: idle timeout
  Buffered --> L1Queued: flushSession
  L1Queued --> L1Running
  L1Running --> Buffered: failure + restore buffer + retry
  L1Running --> L2Scheduled: success + reset count
  L2Scheduled --> L2Running: delay/max timer fires
  L2Running --> L2Scheduled: failure + arm max interval
  L2Running --> L3Queued: success
  L3Queued --> L3Running
  L3Running --> L3Queued: pending flag set during run
  L3Running --> Idle: persona generated or skipped
```

## Checkpoint / Cursor Behavior

| Cursor/state | Purpose | Updated by |
| --- | --- | --- |
| capture cursor | 避免重复捕获同一批 raw messages | `CheckpointManager.captureAtomically()` |
| `last_l1_cursor` | L1 只处理新 L0 messages | `markL1ExtractionComplete()` |
| `last_scene_name` | L1 extraction 的连续场景上下文 | `markL1ExtractionComplete()` |
| `conversation_count` | 判断是否触发 L1 threshold | `notifyConversation()`, `runL1()` |
| `l2_pending_l1_count` | 标记 L1 后 L2 待处理量 | `runL1()`, `runL2()` |
| `last_extraction_updated_time` | L2 增量读取 L1 records | `runL2()` |
| `total_processed` / persona marker | L3 触发条件 | SceneExtractor / PersonaGenerator |

## Retry, Idempotency, Shutdown

| Concern | Implementation |
| --- | --- |
| concurrent scheduler start | `TdaiCore.schedulerStartPromise` 让并发 capture 等同一个 start。 |
| duplicate L0 capture | `captureAtomically()` + position slice + timestamp cursor。 |
| L1 failure | buffer 放回 `messageBuffers`，最多 5 次 retry。 |
| L2 failure | 不丢状态，重新 arm max interval。 |
| L3 concurrency | `l3Running` + `l3Pending`，全局串行。 |
| per-session end | `flushSession(sessionKey)` 只 flush 当前 session。 |
| process shutdown | `destroy()` flush pipeline，drain bg tasks，close store。 |
| idle Gateway shutdown | CLI watchdog 读 heartbeat，超过 idle timeout 后关闭 hook 启动的 Gateway。 |

## Concrete Scenario Timing

```mermaid
sequenceDiagram
  autonumber
  participant Capture as /capture
  participant PM as PipelineManager
  participant L1 as L1 Queue
  participant L2 as L2 Timer/Queue
  participant L3 as L3 Queue

  Capture->>PM: notifyConversation(codex-rhino-bird-session, 2 messages)
  alt everyNConversations=1 in test config
    PM->>L1: enqueue immediately
  else default config
    PM->>PM: reset idle timer
  end
  L1->>PM: success, l2_pending_l1_count set
  PM->>L2: schedule delay-after-L1
  L2->>PM: scene extraction success
  PM->>L3: triggerL3()
  L3->>PM: persona generated or skipped by trigger
```

