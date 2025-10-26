import { fetchGraph } from './api.js';
import buildStructureFromGraph from './projectStructure.js';
import {
  setWorkingMemoryProjectGraph,
  setWorkingMemoryElementsGraph,
  setWorkingMemorySession,
  getWorkingMemorySettings,
} from './workingMemory.js';

const EMPTY_GRAPH = Object.freeze({ nodes: [], edges: [] });
function cloneGraph(graph = EMPTY_GRAPH) {
  return {
    nodes: Array.isArray(graph?.nodes)
      ? graph.nodes.map((node) => ({ ...node }))
      : [],
    edges: Array.isArray(graph?.edges)
      ? graph.edges.map((edge) => ({ ...edge }))
      : [],
  };
}

function cloneStructure(structure = {}) {
  const result = {};
  if (Object.prototype.hasOwnProperty.call(structure, 'project_graph')) {
    result.project_graph = cloneGraph(structure.project_graph);
  }
  if (Object.prototype.hasOwnProperty.call(structure, 'elements_graph')) {
    result.elements_graph = cloneGraph(structure.elements_graph);
  }
  return result;
}

function sanitiseNode(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const id = entry.id !== undefined ? String(entry.id) : '';
  if (!id) {
    return null;
  }
  return {
    id,
    label: typeof entry.label === 'string' ? entry.label : '',
    type: typeof entry.type === 'string' ? entry.type : '',
    builder: typeof entry.builder === 'string' ? entry.builder : '',
  };
}

function sanitiseEdge(edge) {
  if (!edge || typeof edge !== 'object') {
    return null;
  }
  const from = edge.from !== undefined ? String(edge.from) : '';
  const to = edge.to !== undefined ? String(edge.to) : '';
  if (!from || !to) {
    return null;
  }
  return {
    from,
    to,
    type: typeof edge.type === 'string' ? edge.type : 'LINKS_TO',
  };
}

function sanitiseGraph(graph) {
  const nodes = Array.isArray(graph?.nodes)
    ? graph.nodes.map(sanitiseNode).filter(Boolean)
    : [];
  const edges = Array.isArray(graph?.edges)
    ? graph.edges.map(sanitiseEdge).filter(Boolean)
    : [];
  return { nodes, edges };
}

function sanitiseStructure(structure) {
  if (!structure || typeof structure !== 'object') {
    return {};
  }
  const result = {};
  if (Object.prototype.hasOwnProperty.call(structure, 'project_graph')) {
    result.project_graph = sanitiseGraph(structure.project_graph);
  }
  if (Object.prototype.hasOwnProperty.call(structure, 'elements_graph')) {
    result.elements_graph = sanitiseGraph(structure.elements_graph);
  }
  return result;
}

const cache = {
  projectId: null,
  project_graph: null,
  elements_graph: null,
  promise: null,
  promiseProjectId: null,
};

function graphsEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function getCachedStructureSnapshot() {
  return {
    project_graph: cloneGraph(cache.project_graph || EMPTY_GRAPH),
    elements_graph: cloneGraph(cache.elements_graph || EMPTY_GRAPH),
  };
}

function applyStructureToCache(structure) {
  const sanitised = sanitiseStructure(structure);
  let projectGraphChanged = false;
  let elementsGraphChanged = false;

  if (Object.prototype.hasOwnProperty.call(sanitised, 'project_graph')) {
    if (!graphsEqual(cache.project_graph, sanitised.project_graph)) {
      cache.project_graph = sanitised.project_graph;
      projectGraphChanged = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(sanitised, 'elements_graph')) {
    if (!graphsEqual(cache.elements_graph, sanitised.elements_graph)) {
      cache.elements_graph = sanitised.elements_graph;
      elementsGraphChanged = true;
    }
  }

  if (projectGraphChanged !== elementsGraphChanged) {
    const changed = projectGraphChanged ? 'project_graph' : 'elements_graph';
    console.debug(
      '[projectStructureService] Updated only %s for project %s',
      changed,
      cache.projectId ?? 'unknown'
    );
  }

  return getCachedStructureSnapshot();
}

function shouldLoadStructure() {
  const settings = getWorkingMemorySettings();
  return settings.include_project_structure !== false;
}

async function fetchStructure(projectId) {
  if (!projectId) {
    return {
      project_graph: EMPTY_GRAPH,
      elements_graph: EMPTY_GRAPH,
    };
  }
  const graph = await fetchGraph(projectId);
  if (graph && (graph.project_graph || graph.elements_graph)) {
    return sanitiseStructure({
      project_graph: graph.project_graph,
      elements_graph: graph.elements_graph,
    });
  }
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const built = buildStructureFromGraph(nodes, edges);
  const sanitised = sanitiseStructure(built);
  if (
    !Object.prototype.hasOwnProperty.call(sanitised, 'project_graph') ||
    !Object.prototype.hasOwnProperty.call(sanitised, 'elements_graph')
  ) {
    console.debug(
      '[projectStructureService] Partial structure received for project %s',
      projectId
    );
  }
  return sanitised;
}

function applySnapshotToWorkingMemory(projectId, structure, includeStructure) {
  if (cache.projectId && cache.projectId !== projectId) {
    clearProjectStructureCache();
  }
  cache.projectId = projectId || null;
  const snapshot = structure
    ? applyStructureToCache(structure)
    : getCachedStructureSnapshot();

  setWorkingMemorySession({ project_id: projectId || '' });

  if (Object.prototype.hasOwnProperty.call(snapshot, 'project_graph')) {
    setWorkingMemoryProjectGraph(snapshot.project_graph);
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, 'elements_graph')) {
    setWorkingMemoryElementsGraph(snapshot.elements_graph);
  }

  return cloneStructure(snapshot);
}

export function clearProjectStructureCache(projectId) {
  if (projectId && cache.projectId && cache.projectId !== projectId) {
    return;
  }
  if (!projectId || cache.projectId === projectId) {
    cache.projectId = projectId || null;
    cache.project_graph = null;
    cache.elements_graph = null;
    cache.promise = null;
    cache.promiseProjectId = null;
  }
}

export async function getProjectStructureSnapshot(projectId, { force = false } = {}) {
  if (cache.projectId && cache.projectId !== projectId) {
    clearProjectStructureCache();
  }
  if (!force && cache.projectId === projectId) {
    if (cache.project_graph || cache.elements_graph) {
      return getCachedStructureSnapshot();
    }
    if (cache.promise && cache.promiseProjectId === projectId) {
      return cache.promise.then(cloneStructure);
    }
  }
  cache.projectId = projectId || null;
  const promise = fetchStructure(projectId)
    .then((structure) => {
      const snapshot = applyStructureToCache(structure);
      cache.promise = null;
      cache.promiseProjectId = null;
      return snapshot;
    })
    .catch((error) => {
      if (cache.promise === promise) {
        cache.promise = null;
        cache.promiseProjectId = null;
      }
      throw error;
    });
  cache.promise = promise;
  cache.promiseProjectId = projectId || null;
  return promise;
}

export async function syncProjectStructureToWorkingMemory(
  projectId,
  { force = false, structure } = {}
) {
  const includeStructure = shouldLoadStructure();
  const needsBootstrap = !cache.project_graph && !cache.elements_graph;
  if (structure) {
    return applySnapshotToWorkingMemory(projectId, structure, includeStructure);
  }

  let resolvedStructure;
  if (includeStructure || force || needsBootstrap) {
    resolvedStructure = await getProjectStructureSnapshot(projectId, { force });
  } else {
    resolvedStructure = getCachedStructureSnapshot();
  }

  return applySnapshotToWorkingMemory(
    projectId,
    resolvedStructure,
    includeStructure || needsBootstrap
  );
}

export async function rebuildProjectStructure(projectId, options = {}) {
  clearProjectStructureCache(projectId);
  return syncProjectStructureToWorkingMemory(projectId, { ...options, force: true });
}
