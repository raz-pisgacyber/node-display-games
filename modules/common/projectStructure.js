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

export function buildStructureFromGraph(nodes = [], edges = []) {
  const projectGraph = { nodes: [], edges: [] };
  const elementsGraph = { nodes: [], edges: [] };

  const projectNodeMap = new Map();
  const elementNodeMap = new Map();
  const projectChildren = new Map();
  const nodeLinks = new Map();

  nodes.forEach((node) => {
    if (!node) {
      return;
    }
    const id = normaliseId(node.id);
    if (!id) {
      return;
    }
    const meta = node.meta && typeof node.meta === 'object' ? node.meta : {};
    const builderRaw =
      typeof meta.builder === 'string' ? meta.builder.trim().toLowerCase() : '';
    const isProjectNode =
      builderRaw === 'project' || meta.projectData !== undefined;
    const isElementNode =
      builderRaw === 'elements' ||
      meta.elementData !== undefined ||
      meta.elementType !== undefined;

    if (isProjectNode) {
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
      nodeLinks.set(id, new Map());
      return;
    }

    if (isElementNode) {
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
      nodeLinks.set(id, new Map());
      return;
    }

    const fallbackLabel = pickFirstString(node.label, meta.title, meta.name) || id;
    const fallbackType = pickFirstString(meta.type, node.type, 'project') || 'project';
    const entry = {
      id,
      label: fallbackLabel,
      type: fallbackType,
      builder: builderRaw || 'project',
      children: [],
      links: [],
    };
    projectGraph.nodes.push(entry);
    projectNodeMap.set(id, entry);
    projectChildren.set(id, new Set());
    nodeLinks.set(id, new Map());
  });

  const projectEdgeSet = new Set();
  const elementEdgeSet = new Set();

  function addEdge(target, cache, from, to, type) {
    const key = `${from}->${to}:${type}`;
    if (cache.has(key)) {
      return;
    }
    cache.add(key);
    target.push({ from, to, type });
  }

  function addLink(sourceId, targetId, type) {
    const linkBucket = nodeLinks.get(sourceId);
    if (!linkBucket) {
      return;
    }
    const key = `${targetId}:${type}`;
    if (linkBucket.has(key)) {
      return;
    }
    linkBucket.set(key, { to: targetId, type });
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

    if (type === 'CHILD_OF' && fromIsProject && toIsProject) {
      addEdge(projectGraph.edges, projectEdgeSet, fromId, toId, type);
      const childrenSet = projectChildren.get(fromId);
      if (childrenSet) {
        childrenSet.add(toId);
      }
    }

    if (fromIsElement || toIsElement) {
      addEdge(elementsGraph.edges, elementEdgeSet, fromId, toId, type);
    }

    const crossesGraphs =
      (fromIsProject && toIsElement) || (fromIsElement && toIsProject);
    if (crossesGraphs) {
      addLink(fromId, toId, type);
      addLink(toId, fromId, type);
    }
  });

  projectGraph.nodes.forEach((node) => {
    const childrenSet = projectChildren.get(node.id);
    node.children = childrenSet ? Array.from(childrenSet) : [];
    const linkBucket = nodeLinks.get(node.id);
    node.links = linkBucket ? Array.from(linkBucket.values()) : [];
  });

  elementsGraph.nodes.forEach((node) => {
    const linkBucket = nodeLinks.get(node.id);
    node.links = linkBucket ? Array.from(linkBucket.values()) : [];
  });

  return {
    project_graph: projectGraph,
    elements_graph: elementsGraph,
  };
}

export default buildStructureFromGraph;
