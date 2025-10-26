function normaliseId(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value.toString === 'function') {
    return value.toString();
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return '';
  }
}

function pickFirstString(...candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    const value = candidates[index];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return '';
}

function classifyBuilder(meta = {}) {
  const raw = typeof meta.builder === 'string' ? meta.builder.toLowerCase() : '';
  if (raw === 'project') return 'project';
  if (raw === 'elements' || meta.elementData || meta.elementType) return 'elements';
  if (meta.projectData) return 'project';
  return 'project';
}

function sanitiseNodeEntry(entry) {
  if (!entry) {
    return null;
  }
  const id = normaliseId(entry.id);
  if (!id) {
    return null;
  }
  const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
  const builderType = classifyBuilder(meta);

  if (builderType === 'elements') {
    const label =
      pickFirstString(
        meta.elementData?.title,
        entry.label,
        meta.title,
        meta.name
      ) || id;
    const elementType =
      pickFirstString(meta.elementData?.type, meta.elementType, meta.type, 'element') || 'element';
    return {
      id,
      label,
      type: elementType,
      builder: 'elements',
      links: [],
    };
  }

  const label =
    pickFirstString(
      meta.projectData?.title,
      entry.label,
      meta.title,
      meta.name
    ) || id;
  const type =
    pickFirstString(meta.projectData?.type, meta.type, 'project') || 'project';
  return {
    id,
    label,
    type,
    builder: 'project',
    links: [],
  };
}

function buildStructureFromGraph(nodes = [], edges = []) {
  const projectGraph = { nodes: [], edges: [] };
  const elementsGraph = { nodes: [], edges: [] };
  const crossLinks = [];

  const projectNodeMap = new Map();
  const elementNodeMap = new Map();
  const projectChildren = new Map();

  nodes.forEach((node) => {
    const entry = sanitiseNodeEntry(node);
    if (!entry) {
      return;
    }
    if (entry.builder === 'elements') {
      elementsGraph.nodes.push(entry);
      elementNodeMap.set(entry.id, entry);
      return;
    }
    projectGraph.nodes.push({ ...entry, children: [] });
    projectNodeMap.set(entry.id, entry);
    projectChildren.set(entry.id, new Set());
  });

  const projectEdgeSet = new Set();
  const elementEdgeSet = new Set();
  const crossLinkSet = new Set();

  function addEdge(target, cache, from, to, type) {
    const key = `${from}->${to}:${type}`;
    if (cache.has(key)) {
      return;
    }
    cache.add(key);
    target.push({ from, to, type });
  }

  function addCrossLink(from, to, type) {
    const key = `${from}->${to}:${type}`;
    if (crossLinkSet.has(key)) {
      return;
    }
    crossLinkSet.add(key);
    crossLinks.push({ from, to, type });
  }

  edges.forEach((edge) => {
    if (!edge) {
      return;
    }
    const fromId = normaliseId(edge.from);
    const toId = normaliseId(edge.to);
    if (!fromId || !toId) {
      return;
    }
    const type =
      typeof edge.type === 'string' && edge.type.trim()
        ? edge.type.trim().toUpperCase()
        : 'LINKS_TO';
    const fromIsProject = projectNodeMap.has(fromId);
    const toIsProject = projectNodeMap.has(toId);
    const fromIsElement = elementNodeMap.has(fromId);
    const toIsElement = elementNodeMap.has(toId);

    if (fromIsProject && toIsProject) {
      addEdge(projectGraph.edges, projectEdgeSet, fromId, toId, type);
      if (type === 'CHILD_OF') {
        const childrenSet = projectChildren.get(fromId);
        if (childrenSet) {
          childrenSet.add(toId);
        }
      }
      return;
    }

    if (fromIsElement && toIsElement) {
      addEdge(elementsGraph.edges, elementEdgeSet, fromId, toId, type);
      return;
    }

    if ((fromIsProject && toIsElement) || (fromIsElement && toIsProject)) {
      addCrossLink(fromId, toId, type);
    }
  });

  projectGraph.nodes = projectGraph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    type: node.type,
    builder: 'project',
    links: node.links || [],
    children: Array.from(projectChildren.get(node.id) || []),
  }));

  return {
    project_graph: projectGraph,
    elements_graph: elementsGraph,
    cross_links: crossLinks,
  };
}

module.exports = {
  buildStructureFromGraph,
};
