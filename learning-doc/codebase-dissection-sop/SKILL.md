---
name: codebase-dissection-sop
description: Use when asked to 拆解/understand/onboard a codebase, trace a feature/debug chain, map entrypoints/data/storage/async flow, or generate learning docs with diagrams and interactive debug HTML.
---

# Codebase Dissection SOP

Use this skill to turn an unfamiliar repository into a small set of useful maps: entrypoints, scenario flow, data/storage map, async pipeline, debug playbook, and a human-friendly interactive HTML walkthrough.

Core rule: do not read by directory order. Read by event flow.

```text
External event
  -> entry adapter
  -> core facade/service
  -> domain logic
  -> storage/external dependency
  -> async/background work
  -> output/side effect
```

## Operating Rules

- Start from the user's target capability, not the whole repo.
- Use one realistic input value throughout the walkthrough.
- Track data shape changes, state writes, and failure behavior at every step.
- Prefer repo indexes, code graphs, language tools, or `rg` to locate code before opening broad file trees.
- Preserve user changes. Do not refactor while dissecting unless explicitly asked.
- Produce Markdown files for each major step. Do not leave the dissection only in chat.
- Include enough diagrams that the user can understand the flow without reading long prose.
- Finish with one realistic debug walkthrough using concrete values.
- Build an interactive HTML walkthrough when documentation is requested, unless the user explicitly says not to.
- Keep docs concise; prefer diagrams, tables, and step cards over long prose.

## Required Output Directory

When the user asks for reusable learning material or project dissection docs, create a dedicated docs directory in the target repo. Prefer:

```text
learning-doc/<capability-or-project>-dissection/
```

If `learning-doc/` already exists, use it. If the repo has a different docs convention, follow the repo convention. Keep generated artifacts grouped together.

Required files:

```text
00-scope.md
01-entrypoints.md
02-main-flow.md
03-data-flow.md
04-storage-map.md
05-async-pipeline.md
06-config-control-plane.md
07-extension-points.md
08-debug-walkthrough.md
09-debug-playbook.md
10-visual-map.md
interactive-debug-walkthrough.html
```

If a phase is not applicable, still create the file and state why it is not applicable.

## Diagram Requirements

Every major Markdown file must include at least one useful diagram or visual table.

Prefer Mermaid diagrams:

```text
flowchart       for architecture and data flow
sequenceDiagram for request/debug walkthroughs
stateDiagram    for schedulers, retries, lifecycle, checkpoints
classDiagram    for interfaces/adapters when helpful
erDiagram       for relational storage
```

Minimum diagram set for a full dissection:

```text
1. Entrypoint map
2. Main happy-path sequence
3. Data transformation flow
4. Storage/state map
5. Async pipeline/state diagram
6. Debug decision tree
7. Code anchor map
```

Keep each diagram small enough to read. Split one large graph into multiple diagrams rather than producing a dense wall.

## Phase 1: Scope

Write one boundary sentence before deep reading:

```text
This pass dissects: <capability / request / workflow>.
This pass does not cover: <nearby but out-of-scope areas>.
```

Classify the target:

```text
startup flow | request flow | background job | CLI command | plugin hook |
core feature | storage path | cache path | queue path | bug/debug path
```

Write `00-scope.md` with:

```text
- Target capability
- Out-of-scope areas
- User-facing questions this dissection answers
- One high-level diagram showing the target boundary
```

## Phase 2: Find Entrypoints

First locate project metadata and startup files:

```text
package.json | pyproject.toml | go.mod | pom.xml | Cargo.toml
README* | main.* | index.* | app.* | server.* | cmd/ | src/main/
```

Then build an entrypoint table:

```text
External event        Code entry                  Notes
HTTP request          routes/*.ts                 route registration
CLI command           cli/index.ts                command parser
Message queue         workers/consumer.*          async processing
Timer/cron            jobs/*.ts                   scheduled work
Plugin hook           index.ts api.on(...)        host callback
UI action             component handler           user event
```

Stop when you can answer:

```text
How does the project start?
Which handlers/hooks/routes are registered?
Where are config, core services, storage clients initialized?
```

Write `01-entrypoints.md` with:

```text
- Entrypoint table
- Startup sequence diagram
- External event -> code handler map
- First breakpoint/log locations
```

## Phase 3: Choose One Scenario Value

Create concrete values and reuse them throughout the analysis.

Example:

```text
requestId = "req-demo-001"
userId = "u-10001"
sessionId = "s-demo-001"
input = "Help me inspect the long-term memory flow."
```

At every function boundary ask:

```text
What is the input here?
What is returned?
What fields were added, transformed, filtered, or dropped?
What state was read or written?
What happens on empty data, timeout, dependency failure, or duplicate request?
```

Record the chosen values in `02-main-flow.md` before tracing code. Reuse those exact values in later docs and the HTML walkthrough.

## Phase 4: Trace The Happy Path

Draw the first path before branching:

```text
entry
  -> parse/validate input
  -> auth/filter/session resolution
  -> core service/facade
  -> domain logic
  -> storage read
  -> external call if any
  -> storage write
  -> response/side effect
```

Keep a module table:

```text
Module        Input        Output       Reads        Writes       Failure behavior
Controller    request      DTO          none         none         400 / skip
Service       DTO          result       cache/DB     DB/event     fallback/retry
Repository    query        rows         DB           DB           empty/throw
Worker        event        ack          queue/DB     DB/log       retry/DLQ
```

Write:

```text
02-main-flow.md
  - happy-path sequence diagram
  - concrete input values
  - function-by-function chain
  - final output/side effect

03-data-flow.md
  - table of input/output shape changes
  - data transformation diagram
  - fields added/filtered/dropped
```

## Phase 5: Map State

Inventory every durable or semi-durable state location:

```text
relational tables
document stores
vector indexes
local files
object storage
caches
queues
checkpoint files
session state
in-memory maps
```

Use this table:

```text
State              Location                 Writer              Reader
User profile       users table              UserService         Auth/ProfileService
Session            cache + sessions table    SessionManager      RequestHandler
Task checkpoint    .metadata/checkpoint      Worker              Scheduler
Search index       vector/FTS index          Indexer             Recall/Search
```

State is the ground truth. If a concept is important but has no state, mark it as computed/transient.

Write `04-storage-map.md` with:

```text
- state table
- storage read/write diagram
- table/file/cache/queue/checkpoint names
- writer and reader code anchors
```

## Phase 6: Trace Async Work

Search for delayed work:

```text
event emit | queue publish | worker | scheduler | cron |
setTimeout | background task | callback | webhook | promise not awaited
```

Trace async paths separately:

```text
main request finishes
  -> event/task scheduled
  -> worker/runner picks it up
  -> reads checkpoint/input state
  -> writes derived state
  -> marks progress
```

Check:

```text
idempotency | retry limit | checkpoint cursor | concurrency lock |
backpressure | partial failure | shutdown handling
```

Write `05-async-pipeline.md` with:

```text
- async trigger points
- scheduler/worker state diagram
- checkpoint/cursor behavior
- retry, idempotency, and shutdown notes
```

## Phase 7: Read Config As Control Plane

Extract only behavior-changing config:

```text
enabled flags
provider/backend selection
strategy selection
limits/topK/batch sizes
timeouts
retention/TTL
retry counts
```

Table:

```text
Config key              Default       Controls
feature.enabled         true          whether path runs
recall.maxResults       5             topK retrieval
store.backend           sqlite        storage implementation
timeoutMs               5000          skip/fallback threshold
```

Use config to explain why code may exist but not execute.

Write `06-config-control-plane.md` with:

```text
- config table
- feature flags
- limits/timeouts/topK/batch sizes
- strategy/provider/backend switches
- how config changes the traced flow
```

## Phase 8: Identify Extension Points

Look for:

```text
interface | adapter | provider | strategy | factory | registry | plugin | hook
```

Table:

```text
Extension point       Purpose                     Implementations
Store interface       switch storage backend       SQLite / cloud DB
LLM provider          switch model/runtime         host / standalone
Strategy              switch algorithm             keyword / vector / hybrid
Adapter               isolate host framework       web / CLI / plugin host
```

Write `07-extension-points.md` with:

```text
- extension point table
- interface/adapter/factory diagram
- implementation list
- where to add a new backend/provider/strategy
```

## Phase 9: Build Debug Playbook

For any capability, use this fixed order:

```text
1. Did the external entrypoint fire?
2. Is the feature enabled by config?
3. Is input present and correctly shaped?
4. Did filters/session/auth skip it?
5. Did the core service run?
6. Did it read expected prior state?
7. Did it write expected new state?
8. Did async scheduling happen?
9. Did the downstream worker/runner process it?
10. Was the result injected/returned/persisted?
11. Did timeout/fallback/degradation hide the failure?
12. Are logs/metrics/checkpoints consistent?
```

Then run a realistic debug walkthrough on paper using concrete values close to production data. Do not use vague placeholders once the scenario starts.

Debug walkthrough rules:

```text
- Start from a specific user/request/event input.
- Show exact values at each major function boundary.
- Show expected state before and after each write.
- Show what breakpoint/log to inspect at each step.
- Include at least one failure branch and how to rule it out.
- End by proving how the final output was produced or why it failed.
```

Write:

```text
08-debug-walkthrough.md
  - concrete scenario values
  - sequence diagram of the debug run
  - step-by-step breakpoint/log checklist
  - observed/expected data table
  - state before/after table

09-debug-playbook.md
  - reusable decision tree
  - common failure modes
  - first files/functions to inspect
  - commands or queries useful for inspection
```

## Phase 10: Output Package

When asked to document the dissection, create all required artifacts unless the user narrows scope:

```text
00-scope.md              target and boundaries
01-entrypoints.md        startup/routes/hooks/commands/workers
02-main-flow.md          one realistic scenario from input to output
03-data-flow.md          shape changes and transformations
04-storage-map.md        tables/files/cache/queues/checkpoints
05-async-pipeline.md     background work and scheduling
06-config-control-plane.md config switches and limits
07-extension-points.md   interfaces/adapters/providers/strategies
08-debug-walkthrough.md  realistic values walked through like debugging
09-debug-playbook.md     reusable failure decision tree
10-visual-map.md         Mermaid diagram index
interactive-debug-walkthrough.html human-friendly interactive walkthrough
```

Keep each document short. Prefer diagrams and tables over long prose.

## Interactive HTML Walkthrough

Create `interactive-debug-walkthrough.html` after the Markdown docs are complete.

Use the bundled blueprint template as the default starting point:

```text
assets/interactive-debug-blueprint-template.html
```

Before generating the HTML, read:

```text
references/interactive-html-blueprint-template.md
```

Copy the template into the target docs directory, then replace the project-specific `nodes`, `edges`, `modes`, `boardLayouts`, titles, footer scenario pills, and Inspector content with the concrete values from the dissection.

The HTML should let the user feel like they debugged the code once without opening the IDE. It should be a blueprint-style network canvas, not only a linear stepper. Include:

```text
- A global network canvas
- Separate boards/modes for major paths, such as main flow, data, storage, async, and failure
- Draggable canvas/pannable board
- Draggable nodes with edges that update as nodes move
- Node-adjacent floating Inspector for concrete data, state, and failure branches
- Draggable floating Inspector
- Collapsible side Inspector
- Light/dark theme toggle
- Concrete input/output values for every node
- State reads/writes for every node
- Breakpoint/log hints for every node
- Links to local source files using relative paths where practical
```

Implementation guidance:

```text
- Prefer a single self-contained HTML file with embedded CSS and JS.
- Use semantic HTML, accessible buttons, and readable typography.
- Do not require a build step.
- Do not load remote assets.
- Do not use Mermaid CDN inside the HTML unless the user explicitly accepts network dependency.
- Keep the first screen useful: title, scenario values, global blueprint, mode buttons, and first selected node.
- Keep node labels short; put details in Inspector fields.
```

The HTML must be derived from the same scenario values used in `08-debug-walkthrough.md`.

Recommended node model:

```javascript
const nodes = [
  {
    id: "entry",
    label: "External event",
    kind: "entry",
    x: 40,
    y: 90,
    file: "src/server.ts",
    line: 42,
    fn: "handleRequest",
    summary: "External request enters the handler and is converted into a command.",
    input: { requestId: "req-demo-001" },
    output: { command: "CreateThingCommand" },
    reads: ["config"],
    writes: [],
    failure: "Request body missing -> returns 400"
  }
];
```

Recommended edge and board model:

```javascript
const edges = [
  ["entry", "service", "command", "main"],
  ["service", "repository", "write", "state"]
].map(([from, to, label, kind]) => ({ from, to, label, kind }));

const modes = {
  global: { label: "全局", nodes: nodes.map(n => n.id), defaultSelected: "entry" },
  main: { label: "主链路", nodes: ["entry", "service", "repository"], edgeKinds: ["main", "state"], defaultSelected: "entry" }
};
```

Default click behavior:

```text
1. First click on an unselected node selects it and updates the side Inspector.
2. Second click on the selected node opens the node-adjacent floating Inspector.
3. Dragging a node never opens the floating Inspector.
```

## Completion Checklist

Before final response, verify:

```text
- Every required Markdown file exists.
- Every major Markdown file has a diagram or visual table.
- The debug walkthrough uses one concrete realistic scenario.
- The interactive HTML opens without a build step.
- The HTML and Markdown use the same scenario values.
- Source file references are specific enough for the user to jump into code.
- The final answer lists the created files and the best starting file.
```

## Minimal Final Summary

End with:

```text
Entrypoints: <files/functions>
Main flow: <one-line chain>
State: <storage/files>
Async work: <workers/schedulers>
Debug first: <first 3 breakpoints/logs>
Docs created/updated: <paths>
```

## Example Mental Model

For any project, compress your understanding to:

```text
<entrypoint> receives <concrete input>,
<core service> transforms it,
<storage layer> persists/loads state,
<async layer> derives follow-up state,
and <output layer> returns or injects the final result.
```
