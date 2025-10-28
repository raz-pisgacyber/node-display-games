# Working Memory Layer

Working memory now persists in MySQL as a modular "LEGO" snapshot. Each
section—session, project structure, node context, fetched context, working
history, messages, last user message, and config—is stored independently and
composed on demand by both the browser UI and the MCP interface.

## Storage modules

- `modules/common/workingMemory.js` owns the in-browser cache. It fetches
  working-memory parts from `/api/working-memory`, pushes granular updates via
  `PATCH /api/working-memory/:part`, and keeps the live snapshot sanitised for
  UI consumers.
- `modules/common/workingMemoryViewer.js` subscribes to the store and renders a
  read-only JSON preview for debugging.

The Node server exposes matching helpers in `src/utils/workingMemoryStore.js`
and reuses them inside the MCP toolchain so AI callers see the same assembled
memory.

## JSON contract

Working memory serialises to the minimal schema defined in `AGENTS.md`:

```
{
  "session": { "session_id": "", "project_id": "", "active_node_id": "", "timestamp": "" },
  "project_structure": {
    "project_graph": { "nodes": [], "edges": [] },
    "elements_graph": { "nodes": [], "edges": [] }
  },
  "node_context": {},
  "fetched_context": {},
  "working_history": "",
  "messages": [],
  "last_user_message": "",
  "config": {
    "history_length": 20,
    "include_project_structure": true,
    "include_context": true,
    "include_working_history": true,
    "auto_refresh_interval": 0
  }
}
```

Client and server sanitisation clamp message history (max 200), strip builder
payloads from graph nodes, and ensure config toggles immediately hide disabled
sections.

## Update helpers

`modules/common/workingMemory.js` exports fine-grained setters so builders can
refresh only the relevant slice while the server persists each piece:

- `initialiseWorkingMemory({ projectId, sessionId, activeNodeId })`
- `setWorkingMemorySession(partial)`
- `setWorkingMemoryProjectGraph(graph)` / `setWorkingMemoryElementsGraph(graph)`
- `setWorkingMemoryProjectStructure(structure)`
- `setWorkingMemoryNodeContext(context)`
- `setWorkingMemoryFetchedContext(context)`
- `setWorkingMemoryMessages(messages)` / `appendWorkingMemoryMessage(message)`
- `setWorkingMemoryWorkingHistory(value)`
- `updateWorkingMemorySettings(partial)` / `getWorkingMemorySettings()`
- `subscribeWorkingMemory(listener)` / `subscribeWorkingMemorySettings(listener)`

Each setter normalises input, updates the local cache, persists the matching SQL
record, and notifies subscribers so the viewer and MCP responses stay in sync.

## Builder integration

- **Main builder (`modules/main/main.js`)** keeps project structure, selected
  node context, messages, summaries, and session metadata aligned with the
  shared snapshot. The Working Memory Settings panel writes through to the SQL
  config part.
- **Project builder (`modules/project/project.js`)** and **Elements builder
  (`modules/elements/elements.js`)** push graph and node updates into working
  memory after each Neo4j mutation or selection change. The toolbar Working
  Memory button still opens the shared viewer.

All builders call `initialiseWorkingMemory` when a project loads so the session
is hydrated from MySQL and ready for incremental updates.

## Server-driven hydration

- `GET /api/working-memory/context` accepts `session_id`, optional
  `node_id`/`project_id`, and returns a sanitised bundle containing the latest
  messages, message metadata, working history, and `last_user_message`.
- `setWorkingMemorySession(partial)` now triggers an on-demand fetch from that
  endpoint whenever the active session or node changes. The store merges the
  server payload into the local snapshot and deduplicates no-op updates.
- Builders should avoid pre-seeding placeholder transcripts or histories when
  switching nodes. Instead, rely on `setWorkingMemorySession` to hydrate the
  viewer and await it before opening the modal when the freshly loaded context
  is required immediately.
