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

export function buildStructureFromGraph(nodes = [], edges = []) {
  const projectGraph = { nodes: [], edges: [] };
  const elementsGraph = { nodes: [], edges: [] };

  const projectNodeMap = new Map();
  const elementNodeMap = new Map();
  const projectChildren = new Map();
  const crossLinks = [];

  nodes.forEach((node) => {
    if (!node) {
      return;
    }
    const id = normaliseId(node.id);
    if (!id) {
      return;
    }
    const meta = node.meta && typeof node.meta === 'object' ? node.meta : {};
    const builderType = classifyBuilder(meta);

    if (builderType === 'project') {
      const label =
        pickFirstString(
          meta.projectData?.title,
          node.label,
          meta.title,
          meta.name
        ) || id;
      const type = pickFirstString(
        meta.projectData?.type,
        meta.type,
        'project'
      ) || 'project';
      const entry = {
        id,
        label,
        type,
        builder: 'project',
        children: [],
        links: [],
      };
      projectGraph.nodes.push(entry);
      projectNodeMap.set(id, entry);
      projectChildren.set(id, new Set());
      return;
    }

    if (builderType === 'elements') {
      const label =
        pickFirstString(
          meta.elementData?.title,
          node.label,
          meta.title,
          meta.name
        ) || id;
      const elementType =
        pickFirstString(
          meta.elementData?.type,
          meta.elementType,
          meta.type,
          'element'
        ) || 'element';
      const entry = {
        id,
        label,
        type: elementType,
        builder: 'elements',
        links: [],
      };
      elementsGraph.nodes.push(entry);
      elementNodeMap.set(id, entry);
      return;
    }

    const fallbackLabel = pickFirstString(node.label, meta.title, meta.name) || id;
    const fallbackType = pickFirstString(meta.type, node.type, 'project') || 'project';
    const entry = {
      id,
      label: fallbackLabel,
      type: fallbackType,
      builder: builderType || 'project',
      children: [],
      links: [],
    };
    projectGraph.nodes.push(entry);
    projectNodeMap.set(id, entry);
    projectChildren.set(id, new Set());
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

  function addCrossLink(sourceId, targetId, type) {
    const key = `${sourceId}->${targetId}:${type}`;
    if (crossLinkSet.has(key)) {
      return;
    }
    crossLinkSet.add(key);
    crossLinks.push({ from: sourceId, to: targetId, type });
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

    const crossesGraphs =
      (fromIsProject && toIsElement) || (fromIsElement && toIsProject);
    if (crossesGraphs) {
      addCrossLink(fromId, toId, type);
    }
  });

  projectGraph.nodes.forEach((node) => {
    const childrenSet = projectChildren.get(node.id);
    node.children = childrenSet ? Array.from(childrenSet) : [];
  });

  return {
    project_graph: projectGraph,
    elements_graph: elementsGraph,
    cross_links: crossLinks,
  };
}

export default buildStructureFromGraph;
