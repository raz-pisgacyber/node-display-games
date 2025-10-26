# Repository Guidance

## High-level architecture
- `server.js` bootstraps the Express app, serves static modules from `modules/` and `core/`, and mounts the REST API under `/api`.
- Graph storage lives in Neo4j via `src/db/neo4j.js`; most graph logic is handled inside `src/routes/api.js` with Cypher queries.
- Relational persistence (sessions, messages, summaries, checkpoints, node_versions) uses MySQL via `src/db/mysql.js` and helper utilities in `src/utils/`.
- Front-end modules are plain ES modules served statically. No bundler is involved, so mind browser compatibility with bare module imports.

## Key integration points
- All API endpoints are defined in `src/routes/api.js`. Keep Cypher queries and SQL statements together with the endpoint logic for ease of auditing.
- Versioning helpers in `src/utils/nodeVersions.js` rely on MySQL-specific syntax (`ON DUPLICATE KEY UPDATE`). If you introduce a different SQL backend adjust this helper first.
- Configuration lives in `src/config.js`, sourced from environment variables. Add new configuration keys there and document them in the README.

## Developer workflow expectations
- Use Node.js 18+ when running or adding dependencies.
- Logging should go through the existing `morgan` middleware for HTTP and `console` for API level debugging.
- Prefer async/await and promise-based APIs; avoid introducing callback-style code.
- Tests are currently absent; if you add any, document how to run them in the README.
- When touching database code, provide accompanying schema or migration updates and keep documentation synced.

## Operational notes
- Shutdown hooks should close both Neo4j and MySQL connections (see `server.js`). Maintain this behavior if you extend the server lifecycle.
- Health checking is served via `GET /api/health` which probes both databases—use this to validate configuration in new environments.
- Static content assumes the repository root as the web root; keep relative paths stable when reorganizing modules.

## Additional Rules

- Agents must always read the current README.md and understand the repository structure and configuration before performing any task.
- After completing any action or producing output, agents must update the agent_history file with a summary of what was done.
- Agents must always update the Agent History at the end of this file after completing work.
- The current visual design of the Project Builder and Elements Builder is approved. Functional changes must not alter layout, styles, or interaction aesthetics.

## MCP Interface Layer

- The `/mcp` router exposes AI-facing tools that wrap existing graph routes and the browser-managed working memory JSON.
- Tool metadata is published via `GET /mcp/tools`; tool invocations are sent to `POST /mcp/call` with `{ tool, arguments, memory }`.
- Every tool handler returns an updated working-memory snapshot so orchestration loops can feed the next turn without additional fetches.
- Graph tools (`createNode`, `updateNode`, `deleteNode`, `linkNodes`, `unlinkNodes`) reuse the same Neo4j/MySQL helpers as the REST API and automatically scope work to the active `project_id` found in the provided memory.
- Working-memory helpers (`getWorkingMemory`, `updateWorkingMemory`) treat the provided JSON as the source of truth and return normalised structures with derived `last_user_message` fields.
- `updateThought` emits transient reasoning data for the UI while leaving persisted graph state untouched.

## Working memory schema expectations

- Working memory snapshots must follow the streamlined structure below. Only include the minimal fields and avoid duplicating metadata across sections.
  ```json
  {
    "session": { "session_id": "", "project_id": "", "active_node_id": "", "timestamp": "" },
    "project_structure": {
      "nodes": [{ "id": "", "label": "", "type": "" }],
      "edges": [{ "from": "", "to": "", "type": "" }]
    },
    "node_context": {
      "id": "", "label": "", "type": "",
      "meta": {
        "notes": "",
        "customFields": [{ "key": "", "value": "" }],
        "linked_elements": [{ "id": "", "label": "", "type": "" }]
      }
    },
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
- `project_structure.nodes` must never carry meta or builder payloads—only identifiers, labels, and a lightweight `type` string.
- `node_context.meta` is the single source of truth for node metadata. Persist only the active node’s notes, custom fields, and linked element summaries.
- Autosave, manual saves, and refresh flows should update `node_context.meta` for the active node and fetch a fresh `project_structure` snapshot when needed without bloating payloads.

## Discussion Card Updates

- Discussion panels now render chat-style conversations shared between the user and the AI helper while preserving the existing card footprint and visual language.
- Message history is loaded and persisted through the `/api/messages` endpoints so every node restores its transcript on open.
- A mock “Action” button lives beside the message composer as a placeholder for future AI commands—keep it visually present but non-functional for now.
- Future enhancements should extend this chat to trigger real AI actions while maintaining the current UI patterns.

# Agent History
## [2025-10-23 18:24:00] - codex
Summary of work completed: Reintroduced a dedicated Main Hub with project lifecycle controls, persistent project context, and builder navigation guards while refreshing all builders with visible active-project badges.
Key implementation details or architectural notes: Added `/api/projects`, `/api/project`, and `/api/project/:id` endpoints backed by a new `projects` table in MySQL, created a static hub module with localStorage-driven state management, and taught each builder (main, project, elements) to synchronise and display project metadata from shared storage.
Next steps or handoff notes: Consider implementing project renaming/deletion flows and surfacing hub-side error banners for failed project detail lookups.
## [2025-10-24 20:00:00] - codex
Restored autosave and added Save Checkpoint in both builders without changing UI design. Wired debounced PATCH /api/node updates and immediate flush on navigation/unload. Added checkpoint call to POST /api/checkpoints. Documented the “preserve builder visuals” rule in agents.md. Next: consider adding restore checkpoint control in Hub.
## [2025-10-25 15:45:00] - codex
Finalised autosave backend integration by allowing checkpoint creation without a provided name and introducing PATCH /api/edge for relationship note updates. Reinforced repository guidance on maintaining builder visuals and Agent History upkeep.
## [2025-10-27 12:00:00] - codex
Summary of work completed: Studied current node/edge persistence, autosave flows, and data-card rendering in both builders to prepare a plan for bidirectional project↔element linking with Neo4j relationships.
Key implementation details or architectural notes: Plan proposes introducing a read-only `GET /api/links` endpoint alongside the existing edge mutations, building shared link indexes from `/api/graph` payloads, rendering linked-node sections with add/remove controls inside project and element data cards, and dispatching `builder:link-mutated` events so autosave queues the relationship writes via the existing `/api/edge` endpoints.
Next steps or handoff notes: Implement the documented backend endpoint, link-state helpers, and UI controls; adjust autosave listeners to preserve the new `project-elements` context when queueing link mutations.
## [2025-10-27 18:46:59] - codex
Implemented two-way linking between Project and Elements builders.
Added /api/link, /api/links, and /api/link deletion endpoints.
Integrated link listing and management into both data cards using existing UI patterns.
Maintained full design consistency and autosave integration.

## [2025-10-28 09:15:00] - codex
Resolved Neo4j write access errors by ensuring the `/api/links` fetch runs through a write-mode session when backfilling `project_id` fields.
Confirmed link creation and retrieval routes now operate without triggering read-only transaction failures.
## [2025-10-28 22:00:00] - codex
Converted node discussion cards into chat-driven panels backed by `/api/messages`, added optimistic user sends with persistent history reloads, and introduced a mock Action control for upcoming AI commands while keeping the builder visuals intact.
## [2025-10-29 21:00 UTC] - codex
Migrated working memory to a browser-managed store, introduced a Working Memory Settings panel plus viewer, and removed the server-side workingMemory module while teaching all builders to keep the local JSON snapshot synced with project, node, and message updates.
## [2025-10-30 14:30 UTC] - codex
Stabilised the Working Memory Settings panel so inputs stay focused during live updates and refreshed `agent.md` to document the browser-side store, helper APIs, and viewer integration.
## [2025-10-31 18:15 UTC] - codex
Introduced an `/mcp` interface that maps structured AI tool calls onto existing graph/link endpoints, normalises working-memory JSON in both directions, and exposes schema metadata for orchestration clients.

## [2025-11-01 09:30 UTC] - codex
Summary of work completed: Standardised the browser and MCP working-memory builders around the minimal schema, removing duplicate metadata from project structures while keeping active-node context rich with notes, custom fields, and linked element summaries.
Key implementation details or architectural notes: Updated all builders to emit `project_structure` nodes with only `{id,label,type}`, rewrote working-memory sanitisation on both client and MCP layers, and ensured autosave/refresh routines exclusively persist the active node’s meta payload.
Next steps or handoff notes: Monitor future feature work for schema drift and extend linked-element snapshots if additional relationship metadata becomes essential.
## [2025-11-02 16:45 UTC] - codex
Summary of work completed: Unified project structure loading across builders via a shared service, limited refresh triggers to structural mutations, and ensured MCP’s getWorkingMemory tool simply returns the provided client snapshot.
Key implementation details or architectural notes: Added `modules/common/projectStructureService.js` to cache and sanitise Neo4j graph payloads, taught project/elements builders plus autosave/link workflows to call `rebuildProjectStructure` only after structural API writes, removed UI-driven partial structure rebuilds, and trimmed working-memory sanitisation to `{id,label,type,builder}`.
Next steps or handoff notes: Consider debouncing repeated rebuild requests when batch operations create many structural mutations in rapid succession.
## [2025-10-26 21:03:07 UTC] - assistant
Summary of work completed: Hardened working-memory schema merging so project and elements graphs persist through partial updates and composeWorkingMemory reuses existing snapshots.
Key implementation details or architectural notes: Introduced mergeProjectStructureParts helper, taught sanitiseStructureFromParts and sanitiseWorkingMemoryPart to preserve sibling graphs, and updated composeWorkingMemory/loadWorkingMemory to merge incremental graph payloads without wiping data.
Next steps or handoff notes: Monitor downstream UI updates to ensure they pass existing project_structure when dispatching partial graph changes.
## [2025-11-24 12:00 UTC] - assistant
Summary of work completed: Prevented autosave meta payloads from overwriting sibling builder data and hardened the API’s meta merge logic.
Key implementation details or architectural notes: Updated the browser autosave manager to send `metaUpdates` instead of full `meta` blobs, introduced a deep merge helper on the PATCH /node route, and added conflict detection that rejects meta replacements dropping project or element data.
Next steps or handoff notes: Monitor future node persistence changes to ensure they continue using partial meta updates and extend deep-merge coverage if new nested branches are introduced.
