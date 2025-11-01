# Node Display Games Architecture & Data Flow Guide

## Runtime Overview
- **Express application**: `server.js` configures middleware, serves static modules from `modules/` and `core/`, mounts REST (`/api`) and MCP (`/mcp`) routers, and responds to `/` with the hub UI. It also centralises error handling and graceful shutdown. 【F:server.js†L1-L66】
- **Configuration loading**: `src/config.js` reads `.env` (unless disabled), exposes HTTP port, Neo4j credentials, MySQL pool settings, and default project/version polling values. 【F:src/config.js†L1-L37】
- **Startup sequence**: On boot the app verifies MySQL and Neo4j connectivity before listening, ensuring both data stores are ready. 【F:server.js†L43-L58】

## Data Stores
### MySQL
- Connection pooling uses `mysql2/promise` with settings from `config.mysql`. 【F:src/db/mysql.js†L1-L6】
- Schema bootstrapping creates or upgrades all tables (`projects`, `node_versions`, `sessions`, `messages`, `node_working_history`, `summaries`, `checkpoints`, `working_memory_parts`). 【F:src/db/mysql.js†L7-L200】
- Additional migrations backfill missing columns, enforce composite primary keys/indexes, and normalise working-memory project/node scopes. 【F:src/db/mysql.js†L81-L209】
- `initMysql` ensures the schema before serving requests; `closeMysql` drains the pool on shutdown. 【F:src/db/mysql.js†L212-L238】

### Neo4j
- The Neo4j driver is initialised with Bolt URI and credentials, exposing helpers for read/write sessions and connectivity verification. 【F:src/db/neo4j.js†L1-L40】

### Hybrid responsibilities
- Graph nodes store canonical content in Neo4j while auxiliary metadata (versions, chat history, checkpoints, working memory, sessions) lives in MySQL. Node version hashes (`node_versions.meta_hash`) track changes for polling and conflict detection. 【F:src/utils/nodeVersions.js†L1-L45】【F:src/utils/mysqlQueries.js†L3-L162】

## Project & Graph Lifecycle
### Project records
- REST endpoints list projects, fetch by id, and create new ones. Creation validates names/ids, inserts into MySQL, and returns the persisted record. 【F:src/routes/api.js†L232-L299】
- The hub UI consumes `/api/projects`, persists the active project in `localStorage`, and routes users into the project or elements builders. 【F:modules/hub/hub.js†L5-L357】

### Graph fetching
- `fetchProjectGraph` queries Neo4j for all `ProjectNode` vertices/relationships scoped by `project_id`, normalising missing project ids and collecting edge metadata. 【F:src/routes/api.js†L300-L335】
- Responses include a derived structure built by `buildStructureFromGraph`, which classifies nodes into project/elements subgraphs and records cross-links for the UI. 【F:src/routes/api.js†L337-L346】【F:src/utils/projectStructure.js†L1-L118】

### Node lifecycle
- **Create**: `/api/node` sanitises meta payloads, assigns a UUID/version timestamp, writes the node in Neo4j, then upserts the version hash in MySQL. 【F:src/routes/api.js†L370-L407】【F:src/utils/neo4jHelpers.js†L3-L142】【F:src/utils/nodeVersions.js†L12-L31】
- **Update**: `/api/node/:id` supports partial field updates and deep meta merges, rejecting destructive replacements, and records new versions. 【F:src/routes/api.js†L410-L469】
- **Delete**: `/api/node/:id` removes the node/relationships in Neo4j and deletes the tracked version row. 【F:src/routes/api.js†L520-L537】

### Relationship management
- **Directed edges** (`/api/edge`) create, update, or delete one-way relationships in Neo4j for builder-specific semantics (e.g. hierarchy). 【F:src/routes/api.js†L540-L640】
- **Bidirectional links** (`/api/link`) manage undirected MERGE relationships and return grouped link metadata for UI display. 【F:src/routes/api.js†L700-L807】
- **Version polling**: `/api/versions/check` returns node ids/version ids modified since a timestamp or ever, powering client-side sync. 【F:src/routes/api.js†L809-L833】

### Checkpoints & restoration
- Creating checkpoints snapshots the entire project graph (including node meta) and stores the JSON plus checksum in MySQL. 【F:src/routes/api.js†L1096-L1137】
- Restoring deletes existing project nodes, recreates them/edges from the snapshot, refreshes `node_versions`, and clears related relational state (messages, summaries, session cursors). 【F:src/routes/api.js†L1159-L1247】

## Working Memory System
- **API endpoints** expose raw part retrieval (`GET /api/working-memory`), targeted updates (`PATCH /api/working-memory/:part`), node working-history persistence, and composed context bundles (`GET /api/working-memory/context`). 【F:src/routes/api.js†L99-L205】【F:src/routes/api.js†L889-L1040】
- **Persistence model**: `working_memory_parts` stores JSON fragments keyed by session/project/node/part. The store derives the correct scope (session-scoped vs project-node fallback), merges session/fallback rows, and composes a normalised memory object. 【F:src/utils/workingMemoryStore.js†L1-L212】
- **Writes**: Saving a part sanitises payloads using `workingMemorySchema`, persists project/elements graph splits, prunes fallback rows when a session owns the data, and mirrors working-history writes into `node_working_history`. 【F:src/utils/workingMemoryStore.js†L250-L363】
- **Schema rules**: `workingMemorySchema` defines allowed parts, default config, and sanitisation routines for structure graphs, node context, message history, and derived metadata such as `last_user_message`. 【F:src/utils/workingMemorySchema.js†L1-L210】【F:src/utils/workingMemorySchema.js†L356-L420】

## Messaging, Sessions, and Summaries
- **Sessions**: `/api/sessions` creates user/project sessions; `/api/sessions/:id` updates active node or sync timestamp. 【F:src/routes/api.js†L1260-L1307】
- **Message ingestion**: `/api/messages` validates payloads, inserts rows into MySQL (capturing role, type, optional node scope), and returns the persisted record. 【F:src/routes/api.js†L836-L880】
- **Message retrieval**: `/api/messages` paginates either by session or node+project, computing counts and last user message via helper queries. 【F:src/routes/api.js†L889-L953】【F:src/utils/mysqlQueries.js†L3-L162】
- **Summaries & working history**: Helpers fetch recent summaries and working history per node; the API exposes `/api/node-working-history` for manual updates and `/api/working-memory/context` for consolidated bundles. 【F:src/routes/api.js†L173-L205】【F:src/routes/api.js†L955-L1040】【F:src/utils/mysqlQueries.js†L101-L224】

## Front-End Modules & Data Flow
- **Hub**: `modules/hub/hub.js` drives the landing page—loading projects from `/api/projects`, storing the active project id/name in `localStorage`, showing project metadata, and routing to builder pages with `?project=` query parameters. 【F:modules/hub/hub.js†L5-L357】
- **Shared API client**: `modules/common/api.js` wraps fetch calls for graph CRUD, links, checkpoints, messages, working memory, and node working-history, adding project scopes and client-side validation. 【F:modules/common/api.js†L1-L297】
- **Working memory client**: Builders initialise and reset working memory snapshots, expose viewer controls, and keep settings in sync with local storage/UI toggles. 【F:modules/main/main.js†L160-L194】
- **Messages store**: `modules/common/messagesStore.js` maintains chat state—scoping by session/node, paginating via the API wrapper, updating working memory after fetches, and sending new messages. 【F:modules/common/messagesStore.js†L1-L324】

## End-to-End Data Flows
- **Creating a node**: The builder calls `createNode` from the shared API module, optionally scoping by project. The server validates and writes the node to Neo4j, then synchronises `node_versions` in MySQL for later diffing. 【F:modules/common/api.js†L139-L145】【F:src/routes/api.js†L370-L407】【F:src/utils/nodeVersions.js†L12-L31】
- **Rendering the main project view**: Clients fetch `/api/graph` (via `fetchGraph`) to obtain nodes, edges, and derived structure metadata. The backend queries Neo4j and bundles project/elements subgraphs for immediate consumption. 【F:modules/common/api.js†L129-L137】【F:src/routes/api.js†L300-L346】
- **Chat messaging**: The UI binds to `messagesStore`, which fetches `/api/messages` pages and updates working memory. Sending a message posts to `/api/messages`, and on success the store reloads the latest history. 【F:modules/common/messagesStore.js†L247-L315】【F:modules/common/api.js†L211-L287】【F:src/routes/api.js†L836-L953】
- **Working memory synchronisation**: When builders adjust context, `saveWorkingMemoryPart` records sanitised fragments in MySQL and backfills node history tables; retrieving working memory composes session and fallback rows into a complete snapshot for clients or MCP tools. 【F:src/routes/api.js†L130-L205】【F:src/utils/workingMemoryStore.js†L63-L363】

## Operational Utilities
- **Health checks**: `/api/health` pings both databases and reports failures alongside SQL diagnostics. 【F:src/routes/api.js†L1309-L1337】
- **Debug endpoints**: `/api/config` exposes default project/poll values, aiding client configuration. 【F:src/routes/api.js†L99-L104】

Use this document as a blueprint for reproducing the architecture: replicate the dual-database model, respect working-memory part semantics, and mirror the REST contract consumed by the hub, builders, and chat interfaces to achieve feature parity.
