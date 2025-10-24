# Working Memory Layer

The working memory snapshot now lives entirely in the browser. It is stored in
`localStorage` and mirrored in in-process state so the UI can render without
serialising on every read.

## Storage modules

- `modules/common/workingMemory.js` – owns the canonical snapshot and exposes
  helper functions for initialisation, mutation, settings management, and
  subscriptions. The JSON payload is persisted under the
  `story-graph-working-memory` key.
- `modules/common/workingMemoryViewer.js` – lightweight overlay that
  subscribes to the working-memory store and renders a read-only JSON preview.

## JSON contract

Working memory always serialises to the following shape:

```
{
  "session": { "session_id": "", "project_id": "", "active_node_id": "", "timestamp": "" },
  "project_structure": {},
  "node_context": {},
  "fetched_context": {},
  "working_history": "",
  "messages": [],
  "last_user_message": "",
  "config": {
    "history_length": 20,
    "include_project_structure": true,
    "include_context": true,
    "include_working_history": true
  }
}
```

- Only `messages` and `working_history` originate from SQL queries. All other
  fields are sourced from live client state and refreshed as the user edits the
  project.
- Sanitisation functions in `workingMemory.js` enforce valid JSON and clamp the
  history length (max 200) before persisting.

## Update helpers

`modules/common/workingMemory.js` exposes fine-grained setters so builders can
refresh one portion of the snapshot without touching the rest:

- `initialiseWorkingMemory({ projectId, sessionId, activeNodeId })`
- `setWorkingMemorySession(partial)`
- `setWorkingMemoryProjectStructure(structure)`
- `setWorkingMemoryNodeContext(context)`
- `setWorkingMemoryFetchedContext(context)`
- `setWorkingMemoryMessages(messages)`
- `appendWorkingMemoryMessage(message)`
- `setWorkingMemoryWorkingHistory(value)`
- `updateWorkingMemorySettings(partial)` / `getWorkingMemorySettings()`
- `subscribeWorkingMemory(listener)` / `subscribeWorkingMemorySettings(listener)`

All setters merge into the in-memory copy, normalise input, persist to
`localStorage`, and broadcast to subscribers so the viewer stays in sync.

## Builder integration

- **Main builder (`modules/main/main.js`)** keeps project structure, selected
  node context, messages, summaries, and session metadata aligned with the
  snapshot. The Working Memory Settings panel writes directly to the settings
  store and avoids destroying focused inputs on refresh.
- **Project builder (`modules/project/project.js`)** and **Elements builder
  (`modules/elements/elements.js`)** push graph and node updates into the store
  whenever nodes are selected or mutated. Each toolbar exposes a Working Memory
  icon that opens the shared viewer modal for debugging.

When any builder loads a project, it calls `initialiseWorkingMemory` with the
project id so the snapshot starts with a clean structure and reflects the
current session.

## Settings persistence

Global working-memory settings are stored separately under the
`story-graph-working-memory-settings` key. Toggling these options immediately
updates the live snapshot (e.g. clearing `project_structure` when disabled) so
subscribers never see stale data.
