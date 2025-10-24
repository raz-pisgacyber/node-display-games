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
