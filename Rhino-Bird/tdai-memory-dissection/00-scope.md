# 00 Scope

This pass dissects: TencentDB Agent Memory 的长期记忆核心链路，以及 OpenClaw、Hermes、Codex、Claude Code 四个平台适配层如何把事件、hooks、MCP tools 映射到同一套 Core/Gateway 能力。
This pass does not cover: context offload、seed 批量导入的深层实现、TCVDB 云端部署细节、LLM prompt 质量调参。

## Target Capability

分类：

| 类型 | 本次覆盖 |
| --- | --- |
| startup flow | Gateway 启动、plugin install 生成配置、MCP server stdio 启动 |
| request flow | Gateway `/recall`、`/capture`、`/search/*`、`/session/end` |
| background job | L1/L2/L3 pipeline timers、queues、watchdog idle shutdown |
| CLI command | `tdai-memory session-start/prefetch/sync-turn/end-session` |
| plugin hook | OpenClaw hooks、Hermes MemoryProvider、Codex/Claude hook wrapper |
| core feature | L0 捕获、L1 抽取、L2 scene、L3 persona、MCP 检索 |
| storage path | JSONL、SQLite/VectorStore、checkpoint、scene blocks、persona |

## Questions Answered

| 问题 | 快速答案 |
| --- | --- |
| 核心引擎在哪里？ | `src/core/tdai-core.ts`，是 host-neutral facade。 |
| Gateway 做什么？ | `src/gateway/server.ts` 将 Core 暴露为 HTTP sidecar。 |
| MCP 暴露哪些能力？ | 只暴露 `tdai_memory_search` 和 `tdai_conversation_search`。 |
| hooks/CLI 做什么？ | 启动 Gateway、prefetch、capture、end-session flush。 |
| L0/1/2/3 何时产生？ | L0 同步 capture；L1 threshold/idle/flush；L2 delay/max interval；L3 在 L2 后全局触发。 |
| 新平台怎么接？ | 优先复用 Gateway + shared MCP/CLI；需要进程内深集成再写 `HostAdapter`。 |

## Target Boundary

```mermaid
flowchart LR
  User["用户 prompt / agent turn"] --> Platform["平台适配层\nOpenClaw/Hermes/Codex/Claude"]
  Platform -->|"hooks / tools / HTTP / MCP"| Adapter["适配入口\nHostAdapter / Gateway client / MCP / CLI"]
  Adapter --> Gateway["Gateway sidecar\nsrc/gateway/server.ts"]
  Adapter --> CoreDirect["Direct Core path\nOpenClaw only"]
  Gateway --> Core["TdaiCore\nsrc/core/tdai-core.ts"]
  CoreDirect --> Core
  Core --> Memory["L0/L1/L2/L3\nstorage + async pipeline"]
  Memory --> Recall["注入上下文或 MCP search result"]
```

本目录使用同一组场景值贯穿调试：

| 字段 | 值 |
| --- | --- |
| `userId` | `小明` |
| `sessionKey` | `codex-rhino-bird-session` |
| `sessionId` | `codex-rhino-bird-session-id` |
| `userPrompt` | `Rhino-Bird 架构拆解测试：请记住小明偏好中文结论优先，并要求 Gateway/Core/Hermes/OpenClaw 原始代码不改。` |
| `assistantContent` | `ACK Rhino-Bird memory architecture scenario.` |
| `gatewayUrl` | `http://127.0.0.1:8420` |

