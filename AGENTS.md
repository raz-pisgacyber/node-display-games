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
