# Working Memory Mixed-Mode Operations

Working-memory persistence now supports two complementary scopes:

- **Session-scoped records** – entries keyed by `session_id`, `project_id`, and `node_id` once a MySQL session exists.
- **Project/node fallbacks** – entries keyed by `project_id` and `node_id` when no session has been established yet (stored with an empty `session_id`).

## Canonical precedence

When both record types exist for the same part, `loadWorkingMemory` prefers the session-scoped payload and only falls back to the project/node value if the session record is missing. This guarantees that live sessions always win without discarding historical fallbacks that pre-date the session.

Context fetch helpers (REST and MCP) reuse this precedence so hydrated working-memory snapshots always mirror the same resolution order.

## Legacy backfill behaviour

During MySQL initialisation the bootstrap process now backfills `working_memory_parts` rows so legacy fallbacks receive explicit `project_id` and `node_id` values. The migration covers rows that were created before the composite primary key existed by:

1. Copying `project_id` from their parent `sessions` row when the entry is session-scoped but missing the project reference.
2. Extracting `project_id` and `active_node_id` from stored session payloads for fallback rows.
3. Filling missing `node_id` values in `node_context` fallbacks using the context payload itself.

These updates ensure mixed-mode queries always discover historical data even if it predates the schema upgrade.

## Duplicate cleanup once sessions arrive

When a session-aware save occurs, the API reconciles fallbacks by deleting the corresponding project/node rows. Operators should no longer see both versions persist long-term; any overlap indicates that a direct SQL write bypassed the helper logic.

If you encounter both a session-scoped and fallback record for the same `(project_id, node_id, part)` tuple:

1. Confirm the session row carries the expected payload.
2. Delete the fallback entry (`session_id = ''`) to avoid re-introducing stale values.
3. If the fallback payload is authoritative, re-save the part through the API with the correct session ID so the session-scoped record inherits the content before cleanup.

Following these steps keeps the store coherent and prevents future merges from loading conflicting state.
