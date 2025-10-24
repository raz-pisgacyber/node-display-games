# Working Memory Layer

The working memory store keeps a short-lived, in-process snapshot of the active AI
session for a given `(session_id, node_id)` pair. It is initialised when a session
focuses a node, refreshed after each relevant persistence event, and read back when
assembling the payload for an AI call.

## Data model

Each entry is keyed by `session_id::node_id` (with `node_id` falling back to a
`__global__` token when empty) and currently tracks:

- `project_id`
- `current_node` → hydrated node payload (including `content` and parsed `meta`)
- `structure_index` → graph overview without node `content`
- `recent_messages` → up to 50 chronological chat records scoped to the node (and
  session-wide messages when `node_id` is `NULL`)
- `work_history_summary` → most recent summary record and timestamp
- `context_data` → mutable object for ad-hoc context expansion
- `last_user_input` → most recent user-authored message content
- `created_at` / `updated_at` timestamps for debugging

The store is in-memory only. Entries are cleared when the session’s active node is
unset, when a checkpoint restore replaces the project graph, or when the server
restarts.

## Helpers

`src/memory/workingMemory.js` exports the primary management functions:

- `initWorkingMemory(sessionId, nodeId)` – bootstrap a fresh entry by querying
  Neo4j for the target node and full structure index, plus MySQL for messages and
  summaries.
- `getWorkingMemory(sessionId, nodeId)` – return a clone of the stored snapshot for
  safe consumption.
- `updateWorkingMemory(sessionId, nodeId, updates)` – merge partial updates or
  functional patches into an existing record.
- `clearWorkingMemory(sessionId, nodeId)` – drop one entry, all entries for a
  session, or every stored snapshot when called without identifiers.
- `refreshStructureIndexForProject(projectId)` – pull a fresh project graph and
  refresh every entry tied to that project.
- `appendMessageToWorkingMemory` / `appendMessageToSessionMemories` – record new
  chat events while keeping the rolling history size bounded.

## Integration touchpoints

`src/routes/api.js` now keeps the store in sync by:

- Initialising or clearing working memory whenever `/sessions/:id` changes its
  `active_node`.
- Refreshing structure indexes and updating node snapshots after node/edge
  mutations or checkpoint restores.
- Appending messages and updating summaries when `/api/messages` and
  `/api/summaries/rollup` persist new rows.

Future AI orchestration can call `getWorkingMemory` before composing a prompt,
merge any tool-sourced context via `updateWorkingMemory`, and rely on the data
layer to keep the cache coherent in the background.
