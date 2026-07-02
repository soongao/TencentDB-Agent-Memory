# Interactive HTML Blueprint Template

Use `assets/interactive-debug-blueprint-template.html` as the default visual template when this skill needs to generate an interactive debug walkthrough.

The template is intentionally self-contained: embedded CSS, embedded JavaScript, no remote assets, no build step. Copy it to the target docs directory as `interactive-debug-walkthrough.html`, then replace the project-specific data and labels.

## What To Preserve

Keep these interaction patterns unless the user explicitly asks for a different UI:

- Blueprint-style network canvas, not a linear slideshow.
- Separate boards for each path or concern, such as `global`, `read`, `write`, `pipeline`, `storage`, and `failure`.
- Draggable canvas/pannable board.
- Draggable nodes.
- Node-adjacent floating Inspector that opens only on the intended click behavior.
- Draggable floating Inspector.
- Collapsible side Inspector.
- Light/dark theme toggle with `localStorage` persistence.
- Self-contained file that opens directly in a browser.

## Data Model To Replace

Replace the template's long-term-memory-specific constants with the target project's traced data:

```javascript
const nodes = [
  {
    id: "entry",
    label: "HTTP POST /orders",
    kind: "entry",
    x: 40,
    y: 90,
    file: "src/routes/orders.ts",
    line: 42,
    fn: "createOrderHandler",
    summary: "Request entrypoint. Parses order payload and delegates to OrderService.",
    input: { requestId: "req-demo-001", userId: "u-10001" },
    output: { command: "CreateOrderCommand" },
    reads: ["feature flag", "auth context"],
    writes: ["request log"],
    failure: "Invalid body -> returns 400 before service call."
  }
];
```

```javascript
const edges = [
  ["entry", "service", "command", "main"],
  ["service", "repository", "write", "state"]
].map(([from, to, label, kind]) => ({ from, to, label, kind }));
```

```javascript
const modes = {
  global: {
    label: "全局",
    title: "全局调试蓝图",
    summary: "Shows the whole capability from entrypoint to side effects.",
    defaultSelected: "entry",
    nodes: nodes.map(n => n.id)
  },
  main: {
    label: "主链路",
    title: "主链路幕布：请求如何产生最终结果",
    summary: "Use the concrete scenario from 08-debug-walkthrough.md.",
    defaultSelected: "entry",
    edgeKinds: ["main", "state"],
    nodes: ["entry", "service", "repository", "response"]
  }
};
```

```javascript
const boardLayouts = {
  global: Object.fromEntries(nodes.map(n => [n.id, { x: n.x, y: n.y }])),
  main: {
    entry: { x: 40, y: 120 },
    service: { x: 280, y: 120 },
    repository: { x: 520, y: 120 },
    response: { x: 760, y: 120 }
  }
};
```

## Required Boards

For a full project dissection, create boards that match the Markdown docs:

```text
global    whole capability map
main      primary happy path
data      data shape transformations
storage   durable/semi-durable state
async     queue/scheduler/background work, if applicable
failure   debug decision tree and common failure branches
```

Rename board labels to the project language. For example, a compiler may use `parse`, `analyze`, `emit`; a web app may use `route`, `service`, `storage`, `worker`.

## Scenario Consistency

The HTML must reuse the same concrete values from `08-debug-walkthrough.md`.

Good:

```text
requestId = "req-demo-001"
userId = "u-10001"
input = { sku: "db-basic-2c4g", region: "ap-shanghai" }
```

Bad:

```text
requestId = "xxx"
input = "some request"
```

Use those concrete values in:

- footer scenario pills
- each node's `input`
- each node's `output`
- state read/write descriptions
- failure branch examples

## Click Behavior

Use the current two-step node behavior by default:

```text
1. First click on an unselected node selects it and updates the side Inspector.
2. Second click on the selected node opens the node-adjacent floating Inspector.
3. Dragging a node never opens the floating Inspector.
```

This avoids accidental popups during blueprint rearrangement while keeping node details close to the node when the user asks for them.

## Writing Guidance

Keep labels short. Put details in Inspector fields, not inside node labels.

Recommended node kinds:

```text
entry     external entrypoint, route, hook, CLI command
core      facade/service/coordinator
logic     domain logic, transformation, extraction, strategy
state     database, file, cache, queue, checkpoint
failure   debug decision node or failure branch
```

Each node should answer:

```text
What does this code do?
What concrete value enters?
What concrete value leaves?
What state does it read?
What state does it write?
What fails here and how would I inspect it?
```

## Verification

Before finalizing the generated HTML:

```bash
node -e 'const fs=require("fs"); const html=fs.readFileSync("interactive-debug-walkthrough.html","utf8"); const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]); for (const code of scripts) new Function(code); console.log("syntax ok");'
```

If a browser automation tool is available, also open the file and verify:

- nodes render
- mode buttons switch boards
- canvas pans
- nodes drag
- second click on selected node opens floating Inspector
- floating Inspector drags
- sidebar collapses
- dark mode toggles

