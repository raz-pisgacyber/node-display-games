# Working Memory Persistence Follow-up Plan

## Verified behaviour
- **Client persistence path** — `setWorkingMemoryWorkingHistory` only pushes updates into the `working_memory_parts` snapshot through `persistPart('working_history', next)`, so the browser never writes to `node_working_history`.【F:modules/common/workingMemory.js†L1125-L1147】
- **Server hydration path** — `/api/working-memory/context` hydrates the viewer by reading messages from `messages`, counting rows, and fetching working history from `node_working_history` with a summary fallback.【F:src/routes/api.js†L869-L934】【F:src/utils/mysqlQueries.js†L80-L103】
- **Existing writers** — Only the MCP `updateWorkingHistory` tool inserts into `node_working_history`, leaving UI edits invisible after node changes.【F:mcp/index.js†L980-L1014】
- **Message ingestion** — Messages accept a `node_id` but treat it as optional in `validateMessagePayload`, so historical rows often lack node scope and are filtered out during hydration when switching nodes.【F:src/utils/validators.js†L29-L64】【F:src/routes/api.js†L869-L908】

## Remediation tasks

### 1. Keep `node_working_history` in sync with UI edits
1. In `modules/common/workingMemory.js`, teach `setWorkingMemoryWorkingHistory` to call a new helper (e.g., `updateNodeWorkingHistory`) right after `persistPart` succeeds. Pass the current `session.session_id`, `session.project_id`, and `session.active_node_id` so the server can write the canonical record. Guard the call so it only fires when a node is active and history is enabled.【F:modules/common/workingMemory.js†L1104-L1147】
2. Add `updateNodeWorkingHistory` to `modules/common/api.js`. POST to `/api/node-working-history` with `{ project_id, node_id, working_history }` and reuse the existing `fetchJSON` helper for consistent error handling.【F:modules/common/api.js†L1-L80】
3. On the server, introduce `POST /api/node-working-history` in `src/routes/api.js`. Validate the payload, then upsert into `node_working_history` using `INSERT ... ON DUPLICATE KEY UPDATE`, mirroring the MCP handler’s logic.【F:src/routes/api.js†L869-L934】【F:mcp/index.js†L980-L1014】【F:src/db/mysql.js†L1-L58】
4. Extract the shared SQL into `src/utils/mysqlQueries.js` (e.g., `saveNodeWorkingHistory`) so both the new endpoint and the MCP tool share one code path. Return the stored row (including `updated_at`) to confirm success.【F:src/utils/mysqlQueries.js†L80-L103】
5. Update `saveWorkingMemoryPart` so that when `part === 'working_history'` and a `projectId`+`options.nodeId` are present, it also writes to `node_working_history`. This keeps MCP, UI, and any future callers consistent.【F:src/utils/workingMemoryStore.js†L1-L120】

### 2. Ensure every new message carries a `node_id`
1. Strengthen `validateMessagePayload` to require `node_id` whenever the active session indicates a node. If the client omits it, resolve the node ID by querying the session (`fetchSessionById`) before insertion; reject the request if no node can be inferred.【F:src/utils/validators.js†L29-L64】【F:src/routes/api.js†L869-L908】
2. Update the client send helpers (`modules/common/messagesStore.js` and any builder-specific senders) to always pass the selected node ID so validation does not fail. Leverage the existing `state.nodeId` tracking that already drives fetches.【F:modules/common/messagesStore.js†L1-L120】【F:modules/main/main.js†L420-L480】
3. Extend the MCP `sendMessage` tool to require a `node_id` argument (or derive it from the provided working memory) and forward it to the SQL insert.【F:mcp/index.js†L907-L1014】

### 3. Backfill legacy data
1. Write a one-off migration script under `scripts/` that scans `messages` for rows with `node_id IS NULL` but a known session. For each, pull the historical active node from `working_memory_parts` (if available) or from recent summaries; otherwise log for manual resolution.【F:src/utils/workingMemoryStore.js†L1-L120】【F:src/routes/api.js†L869-L934】
2. The same script should hydrate `node_working_history` by copying the most recent `working_history` payload from `working_memory_parts` per `(project_id, active_node_id)` pair. Reuse the shared upsert helper from step 1.4 to guarantee consistent writes.【F:src/utils/workingMemoryStore.js†L80-L120】【F:src/utils/mysqlQueries.js†L80-L103】
3. Document the migration steps and verification checklist in `agent.md` so operators know to run it once in production and how to confirm every node now surfaces history in the viewer.【F:agent.md†L1-L120】

### 4. Regression coverage
1. Add integration tests (or a lightweight smoke harness) that saves working history via the UI helpers, switches the active node, and confirms `/api/working-memory/context` returns the persisted text. Mock the fetches to avoid brittle MySQL dependencies if a full test harness is unavailable.【F:modules/common/workingMemory.js†L595-L1028】【F:src/routes/api.js†L869-L934】
2. Capture the message send flow in tests to ensure inserts without `node_id` now fail fast while properly scoped requests succeed. Cover REST and MCP entry points to lock behaviour down.【F:src/routes/api.js†L760-L834】【F:mcp/index.js†L907-L1014】
