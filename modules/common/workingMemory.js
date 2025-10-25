const MEMORY_STORAGE_KEY = 'story-graph-working-memory';
const SETTINGS_STORAGE_KEY = 'story-graph-working-memory-settings';
const SESSION_STORAGE_PREFIX = 'story-graph-session:';
const STRUCTURE_STORAGE_PREFIX = 'story-graph-structure:';

const DEFAULT_SETTINGS = {
  history_length: 20,
  include_project_structure: true,
  include_context: true,
  include_working_history: true,
  auto_refresh_interval: 0,
};

const MAX_HISTORY_LENGTH = 200;

let settings = loadSettings();
let memory = loadMemory();

const projectStructureCache = new Map();

const memoryListeners = new Set();
const settingsListeners = new Set();

function cloneJson(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (error) {
      // Fallback below
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    if (Array.isArray(value)) {
      return value.map((item) => cloneJson(item));
    }
    if (value && typeof value === 'object') {
      const result = {};
      Object.entries(value).forEach(([key, entry]) => {
        if (entry === undefined) {
          return;
        }
        if (entry === null) {
          result[key] = null;
        } else if (entry instanceof Date) {
          result[key] = entry.toISOString();
        } else if (typeof entry === 'object') {
          result[key] = cloneJson(entry);
        } else if (typeof entry !== 'function') {
          result[key] = entry;
        }
      });
      return result;
    }
    return value;
  }
}

function loadSettings() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_SETTINGS };
    }
    return {
      history_length: normaliseHistoryLength(parsed.history_length),
      include_project_structure: Boolean(parsed.include_project_structure ?? DEFAULT_SETTINGS.include_project_structure),
      include_context: Boolean(parsed.include_context ?? DEFAULT_SETTINGS.include_context),
      include_working_history: Boolean(parsed.include_working_history ?? DEFAULT_SETTINGS.include_working_history),
      auto_refresh_interval: normaliseAutoRefreshInterval(parsed.auto_refresh_interval),
    };
  } catch (error) {
    console.warn('Failed to load working memory settings', error);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(nextSettings) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
  } catch (error) {
    console.warn('Failed to persist working memory settings', error);
  }
}

function buildDefaultMemory(currentSettings = settings) {
  const timestamp = new Date().toISOString();
  return {
    session: {
      session_id: '',
      project_id: '',
      active_node_id: '',
      timestamp,
    },
    project_structure: sanitiseStructure({}),
    node_context: {},
    fetched_context: {},
    working_history: '',
    messages: [],
    last_user_message: '',
    config: { ...currentSettings },
  };
}

function loadMemory() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return buildDefaultMemory(settings);
  }
  try {
    const raw = window.localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) {
      return buildDefaultMemory(settings);
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return buildDefaultMemory(settings);
    }
    const hydrated = buildDefaultMemory(settings);
    hydrated.session = {
      session_id: safeString(parsed.session?.session_id),
      project_id: safeString(parsed.session?.project_id),
      active_node_id: safeString(parsed.session?.active_node_id),
      timestamp: parsed.session?.timestamp || hydrated.session.timestamp,
    };
    if (parsed.project_structure) {
      hydrated.project_structure = sanitiseStructure(parsed.project_structure);
    }
    if (parsed.node_context) {
      hydrated.node_context = sanitiseNodeContext(parsed.node_context);
    }
    if (parsed.fetched_context) {
      hydrated.fetched_context = sanitiseFetchedContext(parsed.fetched_context);
    }
    hydrated.working_history = typeof parsed.working_history === 'string' ? parsed.working_history : '';
    hydrated.messages = limitMessages(Array.isArray(parsed.messages) ? parsed.messages : []);
    hydrated.last_user_message = deriveLastUserMessage(hydrated.messages);
    hydrated.config = { ...settings };
    return hydrated;
  } catch (error) {
    console.warn('Failed to hydrate working memory, resetting to defaults', error);
    return buildDefaultMemory(settings);
  }
}

function persistMemory() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(memory));
  } catch (error) {
    console.warn('Failed to persist working memory snapshot', error);
  }
}

function notifyMemory() {
  if (!memoryListeners.size) {
    return;
  }
  const snapshot = getWorkingMemorySnapshot();
  memoryListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.warn('Working memory listener failed', error);
    }
  });
}

function notifySettings() {
  if (!settingsListeners.size) {
    return;
  }
  const snapshot = { ...settings };
  settingsListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.warn('Working memory settings listener failed', error);
    }
  });
}

function ensureMemory() {
  if (!memory) {
    memory = buildDefaultMemory(settings);
  }
  return memory;
}

function touchTimestamp() {
  ensureMemory().session.timestamp = new Date().toISOString();
}

function commitMemory() {
  touchTimestamp();
  persistMemory();
  notifyMemory();
}

function safeString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function normaliseHistoryLength(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_SETTINGS.history_length;
  }
  return Math.min(parsed, MAX_HISTORY_LENGTH);
}

function normaliseAutoRefreshInterval(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return DEFAULT_SETTINGS.auto_refresh_interval;
  }
  return parsed;
}

function sanitiseCustomFields(list = []) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((field) => {
      if (!field || typeof field !== 'object') {
        return null;
      }
      const key = safeString(field.key ?? '').trim();
      const value = safeString(field.value ?? '');
      return { key, value };
    })
    .filter((field) => field && (field.key || field.value));
}

function sanitiseLinkedElements(list = []) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const id = safeString(entry.id);
      if (!id) {
        return null;
      }
      return {
        id,
        label: safeString(entry.label || id),
        type: safeString(entry.type || ''),
      };
    })
    .filter(Boolean);
}

function sanitiseMeta(meta = {}, fallback = {}) {
  const source = typeof meta === 'object' && meta ? meta : {};
  const result = {};
  const notes = source.notes ?? fallback.notes;
  if (typeof notes === 'string' && notes.trim()) {
    result.notes = notes;
  }
  const customFields = source.customFields ?? fallback.customFields;
  if (customFields) {
    const sanitised = sanitiseCustomFields(customFields);
    if (sanitised.length) {
      result.customFields = sanitised;
    }
  }
  const linkedElements = source.linked_elements ?? fallback.linked_elements;
  if (linkedElements) {
    const sanitised = sanitiseLinkedElements(linkedElements);
    if (sanitised.length) {
      result.linked_elements = sanitised;
    }
  }
  return result;
}

function sanitiseGraphNode(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  const id = safeString(node.id);
  if (!id) {
    return null;
  }
  return {
    id,
    label: safeString(node.label ?? node.title ?? ''),
    type: safeString(node.type ?? ''),
    builder: safeString(node.builder || node.type || ''),
  };
}

function sanitiseGraphEdge(edge) {
  if (!edge || typeof edge !== 'object') {
    return null;
  }
  const from = safeString(edge.from);
  const to = safeString(edge.to);
  if (!from || !to) {
    return null;
  }
  return {
    from,
    to,
    type: safeString(edge.type || 'LINKS_TO'),
  };
}

function sanitiseGraph(graph) {
  if (!graph || typeof graph !== 'object') {
    return { nodes: [], edges: [] };
  }
  const nodes = Array.isArray(graph.nodes)
    ? graph.nodes.map(sanitiseGraphNode).filter(Boolean)
    : [];
  const edges = Array.isArray(graph.edges)
    ? graph.edges.map(sanitiseGraphEdge).filter(Boolean)
    : [];
  return { nodes, edges };
}

function normaliseGraphForComparison(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  const normalisedNodes = nodes
    .map((node) => {
      if (!node || typeof node !== 'object') {
        return null;
      }
      const payload = {
        id: safeString(node.id),
        label: safeString(node.label ?? ''),
        type: safeString(node.type ?? ''),
        builder: safeString(node.builder ?? ''),
      };
      if (Array.isArray(node.children) && node.children.length) {
        payload.children = [...new Set(node.children.map((child) => safeString(child)).filter(Boolean))].sort();
      }
      if (Array.isArray(node.links) && node.links.length) {
        payload.links = node.links
          .map((link) => {
            if (!link || typeof link !== 'object') {
              return null;
            }
            const to = safeString(link.to);
            if (!to) {
              return null;
            }
            return { to, type: safeString(link.type || 'LINKS_TO') };
          })
          .filter(Boolean)
          .sort((a, b) => {
            if (a.to !== b.to) {
              return a.to.localeCompare(b.to);
            }
            return a.type.localeCompare(b.type);
          });
      }
      return payload;
    })
    .filter((node) => node && node.id)
    .sort((a, b) => a.id.localeCompare(b.id));

  const normalisedEdges = edges
    .map((edge) => {
      if (!edge || typeof edge !== 'object') {
        return null;
      }
      const from = safeString(edge.from);
      const to = safeString(edge.to);
      if (!from || !to) {
        return null;
      }
      return { from, to, type: safeString(edge.type || 'LINKS_TO') };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.from !== b.from) {
        return a.from.localeCompare(b.from);
      }
      if (a.to !== b.to) {
        return a.to.localeCompare(b.to);
      }
      return a.type.localeCompare(b.type);
    });

  return { nodes: normalisedNodes, edges: normalisedEdges };
}

function graphsEqual(a, b) {
  const first = normaliseGraphForComparison(a);
  const second = normaliseGraphForComparison(b);
  return JSON.stringify(first) === JSON.stringify(second);
}

function sanitiseStructure(structure) {
  if (!structure || typeof structure !== 'object') {
    return {
      project_graph: { nodes: [], edges: [] },
      elements_graph: { nodes: [], edges: [] },
    };
  }
  if (structure.project_graph || structure.elements_graph) {
    return {
      project_graph: sanitiseGraph(structure.project_graph),
      elements_graph: sanitiseGraph(structure.elements_graph),
    };
  }
  const fallback = sanitiseGraph(structure);
  return {
    project_graph: fallback,
    elements_graph: { nodes: [], edges: [] },
  };
}

function graphIsEmpty(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  return nodes.length === 0 && edges.length === 0;
}

function getStructureStorageKey(projectId) {
  const id = safeString(projectId);
  return `${STRUCTURE_STORAGE_PREFIX}${id}`;
}

function getCachedProjectStructure(projectId) {
  const id = safeString(projectId);
  if (!id) {
    return null;
  }
  if (projectStructureCache.has(id)) {
    return sanitiseStructure(projectStructureCache.get(id));
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(getStructureStorageKey(id));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const sanitised = sanitiseStructure(parsed);
    projectStructureCache.set(id, sanitised);
    return sanitiseStructure(sanitised);
  } catch (error) {
    console.warn('Failed to load cached project structure', error);
    return null;
  }
}

function storeCachedProjectStructure(projectId, structure) {
  const id = safeString(projectId);
  if (!id) {
    return;
  }
  const sanitised = sanitiseStructure(structure);
  projectStructureCache.set(id, sanitised);
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(getStructureStorageKey(id), JSON.stringify(sanitised));
  } catch (error) {
    console.warn('Failed to persist project structure cache', error);
  }
}

function clearCachedProjectStructure(projectId) {
  if (!projectId) {
    projectStructureCache.clear();
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const keys = Object.keys(window.localStorage);
        keys
          .filter((key) => key.startsWith(STRUCTURE_STORAGE_PREFIX))
          .forEach((key) => {
            window.localStorage.removeItem(key);
          });
      } catch (error) {
        console.warn('Failed to clear cached project structures', error);
      }
    }
    return;
  }
  const id = safeString(projectId);
  if (!id) {
    return;
  }
  projectStructureCache.delete(id);
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.removeItem(getStructureStorageKey(id));
  } catch (error) {
    console.warn('Failed to remove cached project structure', error);
  }
}

function sanitiseNodeContext(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  const nodeContext = {
    id: safeString(context.id ?? context.node_id ?? ''),
    label: safeString(context.label ?? context.title ?? ''),
    type: safeString(context.type ?? context.builder ?? ''),
    meta: sanitiseMeta(context.meta, {
      notes: context.notes,
      customFields: context.customFields,
      linked_elements: context.linked_elements,
    }),
  };
  return nodeContext;
}

function sanitiseFetchedContext(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return cloneJson(value);
}

function sanitiseMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const createdAt = message.created_at instanceof Date ? message.created_at.toISOString() : safeString(message.created_at || '');
  return {
    id: safeString(message.id),
    session_id: safeString(message.session_id),
    node_id: message.node_id === null || message.node_id === undefined || message.node_id === ''
      ? null
      : safeString(message.node_id),
    role: safeString(message.role || 'user'),
    content: safeString(message.content || ''),
    created_at: createdAt,
  };
}

function limitMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sanitised = list
    .map(sanitiseMessage)
    .filter(Boolean)
    .sort((a, b) => {
      const aTime = a.created_at ? Date.parse(a.created_at) || 0 : 0;
      const bTime = b.created_at ? Date.parse(b.created_at) || 0 : 0;
      return aTime - bTime;
    });
  const max = normaliseHistoryLength(settings.history_length);
  if (sanitised.length <= max) {
    return sanitised;
  }
  return sanitised.slice(sanitised.length - max);
}

function deriveLastUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry?.role === 'user' && entry.content) {
      return entry.content;
    }
  }
  return '';
}

function applySettingsToMemory() {
  const target = ensureMemory();
  target.config = { ...settings };
  if (!settings.include_project_structure) {
    target.project_structure = sanitiseStructure({});
  }
  if (!settings.include_context) {
    target.node_context = {};
  }
  if (!settings.include_working_history) {
    target.working_history = '';
  }
  target.messages = limitMessages(target.messages || []);
  target.last_user_message = deriveLastUserMessage(target.messages);
}

function buildNodeScopedSnapshot(snapshot, nodeId) {
  const scoped = cloneJson(snapshot);
  const targetId = nodeId ? safeString(nodeId) : scoped.session?.active_node_id || '';
  if (!targetId) {
    scoped.project_structure = sanitiseStructure({});
    scoped.node_context = {};
    scoped.messages = [];
    scoped.last_user_message = '';
    return scoped;
  }
  const structure = sanitiseStructure(snapshot.project_structure || {});
  const projectNodes = Array.isArray(structure.project_graph?.nodes)
    ? structure.project_graph.nodes
    : [];
  const projectEdges = Array.isArray(structure.project_graph?.edges)
    ? structure.project_graph.edges
    : [];
  const elementNodes = Array.isArray(structure.elements_graph?.nodes)
    ? structure.elements_graph.nodes
    : [];
  const elementEdges = Array.isArray(structure.elements_graph?.edges)
    ? structure.elements_graph.edges
    : [];

  const projectNodeIds = new Set();
  const elementNodeIds = new Set();

  const hasProjectNode = projectNodes.some((node) => node.id === targetId);
  const hasElementNode = elementNodes.some((node) => node.id === targetId);
  if (hasProjectNode) {
    projectNodeIds.add(targetId);
    projectEdges.forEach((edge) => {
      if (edge.from === targetId) {
        projectNodeIds.add(edge.to);
      }
      if (edge.to === targetId) {
        projectNodeIds.add(edge.from);
      }
    });
  }
  if (hasElementNode) {
    elementNodeIds.add(targetId);
    elementEdges.forEach((edge) => {
      if (edge.from === targetId) {
        elementNodeIds.add(edge.to);
      }
      if (edge.to === targetId) {
        elementNodeIds.add(edge.from);
      }
    });
  }

  elementEdges.forEach((edge) => {
    if (edge.from === targetId && edge.to) {
      elementNodeIds.add(edge.to);
    }
    if (edge.to === targetId && edge.from) {
      elementNodeIds.add(edge.from);
    }
  });

  const scopedProjectNodes = hasProjectNode
    ? projectNodes.filter((node) => projectNodeIds.has(node.id))
    : [];
  const scopedProjectEdges = hasProjectNode
    ? projectEdges.filter(
        (edge) => projectNodeIds.has(edge.from) || projectNodeIds.has(edge.to)
      )
    : [];

  const scopedElementNodes = (hasElementNode || hasProjectNode)
    ? elementNodes.filter((node) => elementNodeIds.has(node.id))
    : [];
  const scopedElementEdges = (hasElementNode || hasProjectNode)
    ? elementEdges.filter(
        (edge) =>
          elementNodeIds.has(edge.from) ||
          elementNodeIds.has(edge.to) ||
          projectNodeIds.has(edge.from) ||
          projectNodeIds.has(edge.to)
      )
    : [];

  scoped.project_structure = sanitiseStructure({
    project_graph: { nodes: scopedProjectNodes, edges: scopedProjectEdges },
    elements_graph: { nodes: scopedElementNodes, edges: scopedElementEdges },
  });
  if (snapshot.node_context?.id === targetId) {
    scoped.node_context = cloneJson(snapshot.node_context);
  } else {
    scoped.node_context = {};
  }
  scoped.messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.filter((message) => !message.node_id || message.node_id === targetId)
    : [];
  scoped.last_user_message = deriveLastUserMessage(scoped.messages);
  return scoped;
}

function readStoredSession(projectId) {
  if (!projectId || typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(`${SESSION_STORAGE_PREFIX}${projectId}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (!parsed.id) {
      return null;
    }
    return parsed;
  } catch (error) {
    console.warn('Failed to read stored session for working memory', error);
    return null;
  }
}

export function getWorkingMemorySnapshot() {
  return cloneJson(ensureMemory());
}

export function getWorkingMemorySnapshotForNode(nodeId) {
  const snapshot = getWorkingMemorySnapshot();
  return buildNodeScopedSnapshot(snapshot, nodeId);
}

export function serialiseWorkingMemory(options = {}) {
  try {
    const snapshot = getWorkingMemorySnapshot();
    const payload = options.nodeOnly ? buildNodeScopedSnapshot(snapshot, options.nodeId) : snapshot;
    return JSON.stringify(payload, null, 2);
  } catch (error) {
    console.warn('Failed to serialise working memory', error);
    return '{}';
  }
}

export function initialiseWorkingMemory({ projectId, sessionId, activeNodeId } = {}) {
  const storedSession = projectId ? readStoredSession(projectId) : null;
  memory = buildDefaultMemory(settings);
  if (projectId !== undefined) {
    memory.session.project_id = safeString(projectId);
    const cachedStructure = getCachedProjectStructure(projectId);
    if (cachedStructure) {
      memory.project_structure = sanitiseStructure(cachedStructure);
    }
  }
  if (storedSession) {
    memory.session.session_id = safeString(storedSession.id);
    memory.session.project_id = safeString(storedSession.project_id ?? projectId ?? memory.session.project_id);
    memory.session.active_node_id = safeString(storedSession.active_node ?? '');
  } else if (sessionId !== undefined) {
    memory.session.session_id = safeString(sessionId);
  }
  if (activeNodeId !== undefined) {
    memory.session.active_node_id = safeString(activeNodeId);
  }
  applySettingsToMemory();
  commitMemory();
  return getWorkingMemorySnapshot();
}

export function resetWorkingMemory() {
  memory = buildDefaultMemory(settings);
  commitMemory();
  return getWorkingMemorySnapshot();
}

export function setWorkingMemorySession(partial = {}) {
  const target = ensureMemory();
  let changed = false;
  if (partial.session_id !== undefined) {
    const next = safeString(partial.session_id);
    if (target.session.session_id !== next) {
      target.session.session_id = next;
      changed = true;
    }
  }
  if (partial.project_id !== undefined) {
    const next = safeString(partial.project_id);
    if (target.session.project_id !== next) {
      target.session.project_id = next;
      changed = true;
    }
  }
  if (partial.active_node_id !== undefined) {
    const next = safeString(partial.active_node_id);
    if (target.session.active_node_id !== next) {
      target.session.active_node_id = next;
      changed = true;
    }
  }
  if (!changed) {
    return getWorkingMemorySnapshot();
  }
  applySettingsToMemory();
  commitMemory();
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryProjectStructure(structure = {}) {
  const target = ensureMemory();
  if (structure.project_id !== undefined) {
    setWorkingMemorySession({ project_id: structure.project_id });
  }
  if (!settings.include_project_structure) {
    if (Object.keys(target.project_structure || {}).length) {
      target.project_structure = sanitiseStructure({});
      commitMemory();
    }
    return getWorkingMemorySnapshot();
  }
  const projectId = safeString(target.session.project_id || structure.project_id || '');
  const cached = projectId ? getCachedProjectStructure(projectId) : null;
  const current = sanitiseStructure(target.project_structure || cached || {});
  const next = {
    project_graph: current.project_graph,
    elements_graph: current.elements_graph,
  };

  const hasProjectGraph = Object.prototype.hasOwnProperty.call(structure || {}, 'project_graph');
  const hasElementsGraph = Object.prototype.hasOwnProperty.call(structure || {}, 'elements_graph');
  const hasLegacyGraph =
    !hasProjectGraph &&
    !hasElementsGraph &&
    structure &&
    typeof structure === 'object' &&
    (Array.isArray(structure.nodes) || Array.isArray(structure.edges));

  let updated = false;
  let receivedUpdate = false;

  if (hasProjectGraph) {
    receivedUpdate = true;
    const sanitisedProject = sanitiseGraph(structure.project_graph);
    if (!graphsEqual(current.project_graph, sanitisedProject)) {
      next.project_graph = sanitisedProject;
      updated = true;
    }
  } else if (!hasLegacyGraph && cached && graphIsEmpty(current.project_graph)) {
    const cachedProject = sanitiseGraph(cached.project_graph);
    if (!graphsEqual(current.project_graph, cachedProject)) {
      next.project_graph = cachedProject;
      updated = true;
      if (!graphIsEmpty(cachedProject)) {
        receivedUpdate = true;
      }
    }
  }

  if (hasElementsGraph) {
    receivedUpdate = true;
    const sanitisedElements = sanitiseGraph(structure.elements_graph);
    if (!graphsEqual(current.elements_graph, sanitisedElements)) {
      next.elements_graph = sanitisedElements;
      updated = true;
    }
  } else if (cached && graphIsEmpty(current.elements_graph)) {
    const cachedElements = sanitiseGraph(cached.elements_graph);
    if (!graphsEqual(current.elements_graph, cachedElements)) {
      next.elements_graph = cachedElements;
      updated = true;
      if (!graphIsEmpty(cachedElements)) {
        receivedUpdate = true;
      }
    }
  }

  if (hasLegacyGraph) {
    receivedUpdate = true;
    const sanitisedLegacy = sanitiseGraph(structure);
    if (!graphsEqual(current.project_graph, sanitisedLegacy)) {
      next.project_graph = sanitisedLegacy;
      updated = true;
    }
  }

  if (!receivedUpdate) {
    return getWorkingMemorySnapshot();
  }

  if (!updated) {
    return getWorkingMemorySnapshot();
  }

  target.project_structure = sanitiseStructure(next);
  if (projectId) {
    storeCachedProjectStructure(projectId, target.project_structure);
  }
  commitMemory();
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryNodeContext(context) {
  const target = ensureMemory();
  if (!settings.include_context) {
    if (Object.keys(target.node_context || {}).length) {
      target.node_context = {};
      commitMemory();
    }
    return getWorkingMemorySnapshot();
  }
  target.node_context = sanitiseNodeContext(context);
  commitMemory();
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryFetchedContext(context) {
  const target = ensureMemory();
  target.fetched_context = sanitiseFetchedContext(context);
  commitMemory();
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryMessages(messages) {
  const target = ensureMemory();
  target.messages = limitMessages(messages);
  target.last_user_message = deriveLastUserMessage(target.messages);
  commitMemory();
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryWorkingHistory(value) {
  const target = ensureMemory();
  if (!settings.include_working_history) {
    if (target.working_history) {
      target.working_history = '';
      commitMemory();
    }
    return getWorkingMemorySnapshot();
  }
  if (typeof value === 'string') {
    target.working_history = value;
  } else if (value && typeof value === 'object') {
    if (typeof value.text === 'string') {
      target.working_history = value.text;
    } else {
      try {
        target.working_history = JSON.stringify(value);
      } catch (error) {
        target.working_history = '';
      }
    }
  } else {
    target.working_history = '';
  }
  commitMemory();
  return getWorkingMemorySnapshot();
}

export function getWorkingMemorySettings() {
  return { ...settings };
}

export function updateWorkingMemorySettings(partial = {}) {
  const next = { ...settings };
  if (partial.history_length !== undefined) {
    next.history_length = normaliseHistoryLength(partial.history_length);
  }
  if (partial.include_project_structure !== undefined) {
    next.include_project_structure = Boolean(partial.include_project_structure);
  }
  if (partial.include_context !== undefined) {
    next.include_context = Boolean(partial.include_context);
  }
  if (partial.include_working_history !== undefined) {
    next.include_working_history = Boolean(partial.include_working_history);
  }
  if (partial.auto_refresh_interval !== undefined) {
    next.auto_refresh_interval = normaliseAutoRefreshInterval(partial.auto_refresh_interval);
  }
  settings = next;
  saveSettings(settings);
  applySettingsToMemory();
  commitMemory();
  notifySettings();
  return { ...settings };
}

export function subscribeWorkingMemory(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  memoryListeners.add(listener);
  try {
    listener(getWorkingMemorySnapshot());
  } catch (error) {
    console.warn('Initial working memory listener execution failed', error);
  }
  return () => {
    memoryListeners.delete(listener);
  };
}

export function subscribeWorkingMemorySettings(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  settingsListeners.add(listener);
  try {
    listener({ ...settings });
  } catch (error) {
    console.warn('Initial working memory settings listener failed', error);
  }
  return () => {
    settingsListeners.delete(listener);
  };
}

export function appendWorkingMemoryMessage(message) {
  const target = ensureMemory();
  const existing = Array.isArray(target.messages) ? target.messages.slice() : [];
  existing.push(message);
  setWorkingMemoryMessages(existing);
}

export function getStoredSession(projectId) {
  return readStoredSession(projectId);
}

applySettingsToMemory();
commitMemory();
notifySettings();
