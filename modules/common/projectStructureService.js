import { fetchGraph } from './api.js';
import buildStructureFromGraph from './projectStructure.js';
import {
  setWorkingMemoryProjectStructure,
  setWorkingMemorySession,
  getWorkingMemorySettings,
} from './workingMemory.js';

const EMPTY_GRAPH = Object.freeze({ nodes: [], edges: [] });
const EMPTY_STRUCTURE = Object.freeze({
  project_graph: EMPTY_GRAPH,
  elements_graph: EMPTY_GRAPH,
});

function cloneStructure(structure) {
  const projectGraph = structure?.project_graph || EMPTY_GRAPH;
  const elementGraph = structure?.elements_graph || EMPTY_GRAPH;
  return {
    project_graph: {
      nodes: Array.isArray(projectGraph.nodes)
        ? projectGraph.nodes.map((node) => ({ ...node }))
        : [],
      edges: Array.isArray(projectGraph.edges)
        ? projectGraph.edges.map((edge) => ({ ...edge }))
        : [],
    },
    elements_graph: {
      nodes: Array.isArray(elementGraph.nodes)
        ? elementGraph.nodes.map((node) => ({ ...node }))
        : [],
      edges: Array.isArray(elementGraph.edges)
        ? elementGraph.edges.map((edge) => ({ ...edge }))
        : [],
    },
  };
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

function sanitiseStructure(structure) {
  if (!structure || typeof structure !== 'object') {
    return cloneStructure(EMPTY_STRUCTURE);
  }
  const projectGraph = structure.project_graph || {};
  const elementsGraph = structure.elements_graph || {};
  const projectNodes = Array.isArray(projectGraph.nodes)
    ? projectGraph.nodes.map(sanitiseNode).filter(Boolean)
    : [];
  const projectEdges = Array.isArray(projectGraph.edges)
    ? projectGraph.edges.map(sanitiseEdge).filter(Boolean)
    : [];
  const elementNodes = Array.isArray(elementsGraph.nodes)
    ? elementsGraph.nodes.map(sanitiseNode).filter(Boolean)
    : [];
  const elementEdges = Array.isArray(elementsGraph.edges)
    ? elementsGraph.edges.map(sanitiseEdge).filter(Boolean)
    : [];
  return {
    project_graph: { nodes: projectNodes, edges: projectEdges },
    elements_graph: { nodes: elementNodes, edges: elementEdges },
  };
}

const cache = {
  projectId: null,
  structure: null,
  promise: null,
};

function shouldLoadStructure() {
  const settings = getWorkingMemorySettings();
  return settings.include_project_structure !== false;
}

async function fetchStructure(projectId) {
  if (!projectId) {
    return cloneStructure(EMPTY_STRUCTURE);
  }
  const graph = await fetchGraph(projectId);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const built = buildStructureFromGraph(nodes, edges);
  return sanitiseStructure(built);
}

export function clearProjectStructureCache(projectId) {
  if (projectId && cache.projectId && cache.projectId !== projectId) {
    return;
  }
  if (!projectId || cache.projectId === projectId) {
    cache.projectId = projectId || null;
    cache.structure = null;
    cache.promise = null;
  }
}

export async function getProjectStructureSnapshot(projectId, { force = false } = {}) {
  if (!force && cache.projectId === projectId && cache.structure) {
    return cloneStructure(cache.structure);
  }
  if (!force && cache.projectId === projectId && cache.promise) {
    return cache.promise.then(cloneStructure);
  }
  cache.projectId = projectId || null;
  const promise = fetchStructure(projectId)
    .then((structure) => {
      cache.structure = structure;
      cache.promise = null;
      return cloneStructure(structure);
    })
    .catch((error) => {
      if (cache.promise === promise) {
        cache.promise = null;
      }
      throw error;
    });
  cache.promise = promise;
  return promise.then(cloneStructure);
}

export async function syncProjectStructureToWorkingMemory(projectId, { force = false } = {}) {
  const includeStructure = shouldLoadStructure();
  setWorkingMemorySession({ project_id: projectId || '' });
  if (!includeStructure) {
    setWorkingMemoryProjectStructure(cloneStructure(EMPTY_STRUCTURE));
    return cloneStructure(EMPTY_STRUCTURE);
  }
  const structure = await getProjectStructureSnapshot(projectId, { force });
  setWorkingMemoryProjectStructure(structure);
  return cloneStructure(structure);
}

export async function rebuildProjectStructure(projectId) {
  clearProjectStructureCache(projectId);
  return syncProjectStructureToWorkingMemory(projectId, { force: true });
}
