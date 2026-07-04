# 10 Visual Map

This file is the diagram index for the dissection package.

## Global Architecture

```mermaid
flowchart TB
  subgraph Platforms["Platforms"]
    OpenClaw["OpenClaw\nindex.ts"]
    Hermes["Hermes\nMemoryProvider"]
    Codex["Codex plugin"]
    Claude["Claude Code plugin"]
  end
  subgraph Shared["Shared packages"]
    MCP["tdai-memory-mcp"]
    CLI["tdai-memory-cli"]
    Hook["tdai-memory-hook"]
  end
  subgraph GatewayLayer["Gateway layer"]
    GW["TdaiGateway"]
    Standalone["StandaloneHostAdapter"]
  end
  subgraph CoreLayer["Core engine"]
    Core["TdaiCore"]
    Recall["Auto Recall"]
    Capture["Auto Capture"]
    Pipeline["L1/L2/L3 Pipeline"]
  end
  subgraph State["State"]
    L0["L0 conversations"]
    L1["L1 records"]
    L2["L2 scene blocks"]
    L3["L3 persona"]
  end

  OpenClaw --> Core
  Hermes --> GW
  Codex --> MCP
  Codex --> Hook
  Claude --> MCP
  Claude --> Hook
  Hook --> CLI
  CLI --> GW
  MCP --> GW
  GW --> Standalone --> Core
  Core --> Recall
  Core --> Capture
  Core --> Pipeline
  Capture --> L0
  Pipeline --> L1
  Pipeline --> L2
  Pipeline --> L3
  Recall --> L1
  Recall --> L2
  Recall --> L3
```

## Code Anchor Map

```mermaid
flowchart LR
  A["plugins/tdai-memory*"] --> B["packages/tdai-memory-mcp"]
  A --> C["packages/tdai-memory-cli"]
  B --> D["src/gateway/server.ts"]
  C --> D
  D --> E["src/core/tdai-core.ts"]
  F["index.ts OpenClaw"] --> E
  G["hermes-plugin/.../__init__.py"] --> D
  E --> H["src/core/hooks/auto-recall.ts"]
  E --> I["src/core/hooks/auto-capture.ts"]
  E --> J["src/utils/pipeline-manager.ts"]
  J --> K["src/utils/pipeline-factory.ts"]
```

## Minimum Reading Order

| Order | File | Why |
| --- | --- | --- |
| 1 | `src/core/tdai-core.ts` | Understand common facade. |
| 2 | `src/gateway/server.ts` | Understand HTTP routes to Core. |
| 3 | `src/core/hooks/auto-capture.ts` | Understand L0 capture and scheduler notify. |
| 4 | `src/utils/pipeline-manager.ts` | Understand L1/L2/L3 timing and queues. |
| 5 | `src/utils/pipeline-factory.ts` | Understand actual L1/L2/L3 runners. |
| 6 | `packages/tdai-memory-mcp/tdai_memory_mcp/protocol.py` | Understand MCP tool path. |
| 7 | `packages/tdai-memory-cli/tdai_memory_cli/hook.py` | Understand hook normalization. |
| 8 | `index.ts` and `hermes-plugin/.../__init__.py` | Understand native platform adapters. |

## HTML Walkthrough

Open `interactive-debug-walkthrough.html` in this directory for a clickable blueprint using the same scenario values as `08-debug-walkthrough.md`.

