# Neo4j Project/Elements Working Memory Audit

## 1. Neo4j schema and query topology
- **Node model** – All graph records are stored as `ProjectNode` nodes with scalar properties for `id`, `project_id`, `label`, `content`, `meta`, `version_id`, and `last_modified`. Nodes are created via `CREATE (n:ProjectNode { ... })` and are retrieved with a project-scoped `MATCH (n:ProjectNode)` that coerces missing `project_id` values to the active project before returning nodes and outgoing relationships.【F:src/routes/api.js†L146-L209】【F:src/utils/neo4jHelpers.js†L104-L116】
- **Relationship types** – Directed edges default to `LINKS_TO`, but builders create typed relationships (`CHILD_OF`, custom tags) through `/api/edge`, and bidirectional element links via `/api/link`. Both routes enforce the `project_id` scope on source and target nodes before creating or merging the relationship and return the typed edge payload including any stored `props`.【F:src/routes/api.js†L341-L437】【F:src/routes/api.js†L538-L560】
- **Link introspection** – The `/api/links` helper performs an undirected `MATCH (n)-[r]-(m)` for a single node, returning relationship metadata grouped by the linked node’s `meta.builder` subtype. This query is still restricted to the session’s `project_id` and normalises missing builder hints into `unknown` buckets.【F:src/routes/api.js†L445-L530】
- **Graph fetch contract** – `/api/graph` always returns the full set of nodes and relationships for the selected `project_id`, regardless of builder context. Each record includes the raw `meta` JSON, and relationships carry arbitrary `props`, such as the builders’ `context` flag used downstream.【F:src/routes/api.js†L146-L178】

## 2. Data flow into working memory today
1. **Builder bootstrap** – Both Project and Elements builders call `fetchGraph(projectId)` and receive the global node/edge set.【F:modules/project/project.js†L609-L683】【F:modules/elements/elements.js†L751-L822】
2. **Local reconstruction** – Each builder hydrates only its own node class graph:
   - Project Builder instantiates `ProjectNode` instances from nodes tagged `meta.builder === 'project'`, and it derives the hierarchical tree solely from `CHILD_OF` edges whose `props.context` equals `'project'`. Element nodes are ignored after building a small “available elements” lookup.【F:modules/project/project.js†L614-L683】
   - Elements Builder instantiates `ElementNode` subclasses from nodes tagged `meta.builder === 'elements'`, and it only treats relationships whose `props.context` equals `'elements'` as actionable links. Project nodes are reduced to a reference list for linking UI.【F:modules/elements/elements.js†L754-L822】
3. **Working-memory updates** – Each builder recomputes a partial snapshot from its in-memory scene graph:
   - Project Builder emits `{ project_graph: … }` assembled from the active `NodeBase` instances and their `children`, omitting element nodes entirely.【F:modules/project/project.js†L139-L185】
   - Elements Builder emits `{ elements_graph: … }` assembled from the active element nodes and the LinkManager cache, omitting project nodes and cross-graph edges.【F:modules/elements/elements.js†L134-L178】
   - These updates are pushed through `setWorkingMemoryProjectStructure`, which merges whichever graph key (`project_graph` or `elements_graph`) was provided and leaves the other untouched. If the builder supplies only one side, the other graph remains stale or empty.【F:modules/common/workingMemory.js†L761-L828】
4. **High-frequency refreshes** – Builder event handlers call `syncWorkingMemoryStructure` whenever autosave detects a node mutation, when link mutations fire, and when the “Working Memory” button is clicked. Because these hooks are tied to UI interactions rather than structural changes, each event rebuilds the partial graph from the local scene and overwrites the matching portion of working memory.【F:modules/project/project.js†L328-L343】【F:modules/elements/elements.js†L323-L358】

## 3. Why project_structure changes with builder context
- **Partial snapshots** – Project Builder never instantiates element nodes, so its `project_graph` update contains only hierarchical records. Elements Builder never instantiates project nodes, so its `elements_graph` update contains only relational records. Switching builders swaps which partial snapshot was most recently written into working memory, yielding empty `elements_graph` entries in Project Builder sessions and empty `project_graph` entries in Elements Builder sessions.【F:modules/project/project.js†L139-L185】【F:modules/elements/elements.js†L134-L178】【F:modules/common/workingMemory.js†L761-L828】
- **Contextual filtering** – Edges are filtered by `edge.props.context`, so any relationship created without a matching context flag is dropped from the local reconstruction. When a builder becomes active, it recalculates and persists its filtered view, potentially removing cross-builder relationships that exist in Neo4j but are invisible to the current builder’s filters.【F:modules/project/project.js†L669-L683】【F:modules/elements/elements.js†L796-L822】
- **Active-node driven refresh** – Node selection and mutation events trigger structure rebuilds even when the global graph is unchanged. Because those rebuilds consult only the builder-local caches, the working memory payload effectively mirrors the currently focused builder scene instead of the project-wide graph.【F:modules/project/project.js†L328-L343】【F:modules/elements/elements.js†L323-L358】

## 4. Existing unified model references
- The shared `buildStructureFromGraph` helper classifies raw Neo4j nodes into `project_graph` and `elements_graph` slices while preserving cross-graph links. It is already used by the Main Hub to emit a complete `project_structure` after loading `/api/graph`, and by the MCP `loadProjectStructure` helper exposed to AI tools.【F:modules/common/projectStructure.js†L31-L207】【F:modules/main/main.js†L313-L322】【F:modules/main/main.js†L1893-L1914】【F:mcp/index.js†L523-L563】
- These implementations prove that a single Neo4j query can populate the unified structure `{ project_graph: { nodes, edges }, elements_graph: { nodes, edges } }` without relying on builder-local caches.

## 5. Desired steady-state behaviour
```
"project_structure": {
  "project_graph": { "nodes": [...], "edges": [...] },
  "elements_graph": { "nodes": [...], "edges": [...] }
}
```
- Populate both graphs with **all** nodes and edges scoped to the current `project_id`, regardless of which builder is active. Builder-specific metadata (e.g., `builder: 'project'` or `builder: 'elements'`) remains discoverable via node `meta` and should be used only to classify the node type, not to filter which nodes are included.【F:modules/common/projectStructure.js†L31-L207】
- Refresh the structure only when structural mutations occur in Neo4j (create/update/delete node, create/update/delete edge/link), mirroring the MCP toolchain’s `runGetWorkingMemory` behaviour that reloads the full graph on demand.【F:mcp/index.js†L919-L931】

## 6. Recommended fix strategy
1. **Centralise project-structure loading**
   - Extract a shared service (browser-side module or REST endpoint) that wraps `/api/graph` and `buildStructureFromGraph` so both builders request the complete structure instead of rebuilding from scene graphs. This can mirror the MCP `loadProjectStructure` logic to guarantee parity.【F:mcp/index.js†L523-L563】【F:modules/common/projectStructure.js†L31-L207】
2. **Scope refresh triggers to structural events**
   - After graph mutations (`createNode`, `updateNode`, `deleteNode`, `createEdge`, `deleteEdge`, `createLink`, `deleteLink`), request the unified structure once and update working memory. Avoid recomputing structure on node selection, autosave status changes, or link hover events to keep working memory stable.【F:modules/project/project.js†L586-L605】【F:modules/elements/elements.js†L340-L358】
3. **Preserve both graphs in working memory**
   - Update builders so `setWorkingMemoryProjectStructure` always receives the full `{ project_graph, elements_graph }` bundle. When a builder only needs to refresh one slice (e.g., a new element link), merge the change locally but re-send both graphs to avoid leaving stale data behind.【F:modules/common/workingMemory.js†L761-L828】
4. **Backfill missing relationship context**
   - Ensure relationship writes include the appropriate `props.context` so neither builder filters them out unintentionally. Consider defaulting context at write-time based on the initiating builder to avoid silent drops during reconstruction.【F:modules/project/project.js†L586-L594】【F:modules/elements/elements.js†L796-L822】

Implementing the above will keep `project_structure` global, deterministic, and independent of builder focus, so the AI layer always receives the complete hierarchy (`CHILD_OF`) alongside the relational web (`LINKS_TO`) for the active project.
