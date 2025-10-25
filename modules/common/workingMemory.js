import { fetchJSON } from './api.js';

const DEFAULT_CONFIG = {
  history_length: 20,
  include_project_structure: true,
  include_context: true,
  include_working_history: true,
  auto_refresh_interval: 0,
};

const MAX_HISTORY_LENGTH = 200;

function safeString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function cloneJson(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (error) {
      // Ignore and fall back.
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

function normaliseHistoryLength(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_CONFIG.history_length;
  }
  return Math.min(parsed, MAX_HISTORY_LENGTH);
}

function normaliseAutoRefreshInterval(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return DEFAULT_CONFIG.auto_refresh_interval;
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
      const key = safeString(field.key).trim();
      const value = safeString(field.value);
      if (!key && !value) {
        return null;
      }
      return { key, value };
    })
    .filter(Boolean);
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
  return { from, to, type: safeString(edge.type || 'LINKS_TO') };
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

function graphsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

function sanitiseNodeContext(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  return {
    id: safeString(context.id ?? context.node_id ?? ''),
    label: safeString(context.label ?? context.title ?? ''),
    type: safeString(context.type ?? context.builder ?? ''),
    meta: sanitiseMeta(context.meta, {
      notes: context.notes,
      customFields: context.customFields,
      linked_elements: context.linked_elements,
    }),
  };
}

function sanitiseFetchedContext(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  return cloneJson(context);
}

function sanitiseMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const createdAt = message.created_at instanceof Date ? message.created_at.toISOString() : safeString(message.created_at || '');
  return {
    id: safeString(message.id),
    session_id: safeString(message.session_id),
    node_id:
      message.node_id === null || message.node_id === undefined || message.node_id === ''
        ? null
        : safeString(message.node_id),
    role: safeString(message.role || 'user'),
    content: safeString(message.content || ''),
    created_at: createdAt,
  };
}

function sortMessages(messages) {
  return messages
    .slice()
    .sort((a, b) => {
      const aTime = a.created_at ? Date.parse(a.created_at) || 0 : 0;
      const bTime = b.created_at ? Date.parse(b.created_at) || 0 : 0;
      return aTime - bTime;
    });
}

function limitMessages(messages, historyLength = DEFAULT_CONFIG.history_length) {
  const list = Array.isArray(messages) ? messages : [];
  const sanitised = list.map(sanitiseMessage).filter(Boolean);
  const ordered = sortMessages(sanitised);
  const limit = normaliseHistoryLength(historyLength);
  if (ordered.length <= limit) {
    return ordered;
  }
  return ordered.slice(ordered.length - limit);
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

function buildDefaultMemory(overrides = {}) {
  const timestamp = new Date().toISOString();
  const config = {
    history_length: normaliseHistoryLength(overrides.config?.history_length ?? DEFAULT_CONFIG.history_length),
    include_project_structure: Boolean(
      overrides.config?.include_project_structure ?? DEFAULT_CONFIG.include_project_structure
    ),
    include_context: Boolean(overrides.config?.include_context ?? DEFAULT_CONFIG.include_context),
    include_working_history: Boolean(
      overrides.config?.include_working_history ?? DEFAULT_CONFIG.include_working_history
    ),
    auto_refresh_interval: normaliseAutoRefreshInterval(
      overrides.config?.auto_refresh_interval ?? DEFAULT_CONFIG.auto_refresh_interval
    ),
  };
  const messages = limitMessages(overrides.messages, config.history_length);
  const lastUserMessage = overrides.last_user_message
    ? safeString(overrides.last_user_message)
    : deriveLastUserMessage(messages);
  return {
    session: {
      session_id: safeString(overrides.session?.session_id ?? ''),
      project_id: safeString(overrides.session?.project_id ?? ''),
      active_node_id: safeString(overrides.session?.active_node_id ?? ''),
      timestamp: overrides.session?.timestamp || timestamp,
    },
    project_structure: sanitiseStructure(overrides.project_structure),
    node_context: sanitiseNodeContext(overrides.node_context),
    fetched_context: sanitiseFetchedContext(overrides.fetched_context),
    working_history: typeof overrides.working_history === 'string' ? overrides.working_history : '',
    messages,
    last_user_message: lastUserMessage,
    config,
  };
}

function sanitiseMemorySnapshot(snapshot) {
  const base = buildDefaultMemory();
  if (!snapshot || typeof snapshot !== 'object') {
    return base;
  }
  const session = snapshot.session && typeof snapshot.session === 'object' ? snapshot.session : {};
  const configSource = snapshot.config && typeof snapshot.config === 'object' ? snapshot.config : {};
  const config = {
    history_length: normaliseHistoryLength(configSource.history_length ?? base.config.history_length),
    include_project_structure: Boolean(
      configSource.include_project_structure ?? base.config.include_project_structure
    ),
    include_context: Boolean(configSource.include_context ?? base.config.include_context),
    include_working_history: Boolean(
      configSource.include_working_history ?? base.config.include_working_history
    ),
    auto_refresh_interval: normaliseAutoRefreshInterval(
      configSource.auto_refresh_interval ?? base.config.auto_refresh_interval
    ),
  };
  const messages = limitMessages(snapshot.messages, config.history_length);
  const lastUserMessage = snapshot.last_user_message
    ? safeString(snapshot.last_user_message)
    : deriveLastUserMessage(messages);
  return {
    session: {
      session_id: safeString(session.session_id ?? base.session.session_id),
      project_id: safeString(session.project_id ?? base.session.project_id),
      active_node_id: safeString(session.active_node_id ?? base.session.active_node_id),
      timestamp: typeof session.timestamp === 'string' && session.timestamp
        ? session.timestamp
        : base.session.timestamp,
    },
    project_structure: sanitiseStructure(snapshot.project_structure ?? base.project_structure),
    node_context: sanitiseNodeContext(snapshot.node_context ?? base.node_context),
    fetched_context: sanitiseFetchedContext(snapshot.fetched_context ?? base.fetched_context),
    working_history: typeof snapshot.working_history === 'string' ? snapshot.working_history : '',
    messages,
    last_user_message: lastUserMessage,
    config,
  };
}

function applyConfigVisibility(target) {
  if (!target.config.include_project_structure) {
    target.project_structure = sanitiseStructure({});
  }
  if (!target.config.include_context) {
    target.node_context = {};
  }
  if (!target.config.include_working_history) {
    target.working_history = '';
  }
  target.messages = limitMessages(target.messages, target.config.history_length);
  target.last_user_message = deriveLastUserMessage(target.messages);
}

const memoryListeners = new Set();
const settingsListeners = new Set();

let memory = buildDefaultMemory();
let pendingLoad = null;

function updateTimestamp() {
  memory.session.timestamp = new Date().toISOString();
}

function notifyMemory() {
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
  const snapshot = getWorkingMemorySettings();
  settingsListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.warn('Working memory settings listener failed', error);
    }
  });
}

function persistPart(part, value, options = null) {
  const sessionId = memory.session.session_id;
  if (!sessionId) {
    return Promise.resolve();
  }
  const body = {
    session_id: sessionId,
    project_id: memory.session.project_id || '',
    value,
  };
  if (options && Object.keys(options).length) {
    body.options = options;
  }
  return fetchJSON(`/api/working-memory/${encodeURIComponent(part)}`, {
    method: 'PATCH',
    body,
  }).catch((error) => {
    console.warn(`Failed to persist working memory part ${part}`, error);
  });
}

async function loadMemoryFromServer(sessionId, projectId, overrides = {}) {
  if (!sessionId) {
    return;
  }
  const params = new URLSearchParams({ session_id: sessionId });
  if (projectId) {
    params.set('project_id', projectId);
  }
  try {
    const data = await fetchJSON(`/api/working-memory?${params.toString()}`);
    const next = sanitiseMemorySnapshot(data?.memory);
    memory = next;
    memory.session.session_id = sessionId;
    if (projectId) {
      memory.session.project_id = safeString(projectId);
    }
    if (overrides.project_id !== undefined) {
      memory.session.project_id = safeString(overrides.project_id);
    }
    if (overrides.active_node_id !== undefined) {
      memory.session.active_node_id = safeString(overrides.active_node_id);
    }
    applyConfigVisibility(memory);
    updateTimestamp();
    notifyMemory();
    notifySettings();
    persistPart('session', { ...memory.session });
  } catch (error) {
    console.warn('Failed to load working memory from server', error);
  }
}

function ensureSessionLoaded(sessionId, projectId, overrides = {}) {
  if (!sessionId) {
    return;
  }
  if (pendingLoad) {
    pendingLoad = pendingLoad
      .then(() => loadMemoryFromServer(sessionId, projectId, overrides))
      .catch(() => loadMemoryFromServer(sessionId, projectId, overrides));
  } else {
    pendingLoad = loadMemoryFromServer(sessionId, projectId, overrides);
  }
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
    elementEdges.forEach((edge) => {
      if (edge.from === targetId) {
        elementNodeIds.add(edge.to);
      }
      if (edge.to === targetId) {
        elementNodeIds.add(edge.from);
      }
    });
  }

  const filterNodes = (list, set) =>
    list.filter((node) => node.id === targetId || set.has(node.id));

  scoped.project_structure = {
    project_graph: {
      nodes: hasProjectNode ? filterNodes(projectNodes, projectNodeIds) : [],
      edges: hasProjectNode
        ? projectEdges.filter((edge) => edge.from === targetId || edge.to === targetId)
        : [],
    },
    elements_graph: {
      nodes: hasElementNode ? filterNodes(elementNodes, elementNodeIds) : [],
      edges: hasElementNode
        ? elementEdges.filter((edge) => edge.from === targetId || edge.to === targetId)
        : [],
    },
  };
  scoped.messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.filter((message) => !message.node_id || message.node_id === targetId)
    : [];
  scoped.last_user_message = deriveLastUserMessage(scoped.messages);
  return scoped;
}

export function getWorkingMemorySnapshot() {
  return cloneJson(memory);
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
  memory = buildDefaultMemory();
  if (projectId !== undefined) {
    memory.session.project_id = safeString(projectId);
  }
  if (sessionId !== undefined) {
    memory.session.session_id = safeString(sessionId);
  }
  if (activeNodeId !== undefined) {
    memory.session.active_node_id = safeString(activeNodeId);
  }
  applyConfigVisibility(memory);
  updateTimestamp();
  notifyMemory();
  notifySettings();
  if (memory.session.session_id) {
    ensureSessionLoaded(memory.session.session_id, memory.session.project_id, {
      project_id: memory.session.project_id,
      active_node_id: memory.session.active_node_id,
    });
  }
  return getWorkingMemorySnapshot();
}

export function resetWorkingMemory() {
  memory = buildDefaultMemory();
  updateTimestamp();
  notifyMemory();
  notifySettings();
  return getWorkingMemorySnapshot();
}

export function setWorkingMemorySession(partial = {}) {
  const next = { ...memory.session };
  const overrides = {};
  if (partial.session_id !== undefined) {
    next.session_id = safeString(partial.session_id);
  }
  if (partial.project_id !== undefined) {
    next.project_id = safeString(partial.project_id);
    overrides.project_id = next.project_id;
  }
  if (partial.active_node_id !== undefined) {
    next.active_node_id = safeString(partial.active_node_id);
    overrides.active_node_id = next.active_node_id;
  }
  const sessionChanged = next.session_id !== memory.session.session_id;
  const projectChanged = next.project_id !== memory.session.project_id;
  const nodeChanged = next.active_node_id !== memory.session.active_node_id;
  if (!sessionChanged && !projectChanged && !nodeChanged) {
    return getWorkingMemorySnapshot();
  }
  memory.session = next;
  updateTimestamp();
  applyConfigVisibility(memory);
  notifyMemory();
  notifySettings();
  if (sessionChanged) {
    ensureSessionLoaded(memory.session.session_id, memory.session.project_id, overrides);
  } else if (memory.session.session_id) {
    persistPart('session', { ...memory.session });
  }
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryProjectStructure(structure = {}) {
  if (!memory.config.include_project_structure) {
    if (!graphIsEmpty(memory.project_structure?.project_graph) || !graphIsEmpty(memory.project_structure?.elements_graph)) {
      memory.project_structure = sanitiseStructure({});
      updateTimestamp();
      notifyMemory();
    }
    return getWorkingMemorySnapshot();
  }
  const next = sanitiseStructure(structure);
  if (graphsEqual(memory.project_structure, next)) {
    return getWorkingMemorySnapshot();
  }
  memory.project_structure = next;
  updateTimestamp();
  notifyMemory();
  persistPart('project_structure', next);
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryNodeContext(context) {
  if (!memory.config.include_context) {
    if (Object.keys(memory.node_context || {}).length) {
      memory.node_context = {};
      updateTimestamp();
      notifyMemory();
    }
    return getWorkingMemorySnapshot();
  }
  const next = sanitiseNodeContext(context);
  if (JSON.stringify(memory.node_context) === JSON.stringify(next)) {
    return getWorkingMemorySnapshot();
  }
  memory.node_context = next;
  updateTimestamp();
  notifyMemory();
  persistPart('node_context', next);
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryFetchedContext(context) {
  const next = sanitiseFetchedContext(context);
  if (JSON.stringify(memory.fetched_context) === JSON.stringify(next)) {
    return getWorkingMemorySnapshot();
  }
  memory.fetched_context = next;
  updateTimestamp();
  notifyMemory();
  persistPart('fetched_context', next);
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryMessages(messages) {
  const next = limitMessages(messages, memory.config.history_length);
  if (JSON.stringify(memory.messages) === JSON.stringify(next)) {
    return getWorkingMemorySnapshot();
  }
  memory.messages = next;
  memory.last_user_message = deriveLastUserMessage(next);
  updateTimestamp();
  notifyMemory();
  persistPart('messages', next, { historyLength: memory.config.history_length });
  persistPart('last_user_message', memory.last_user_message, { messages: next });
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryWorkingHistory(value) {
  if (!memory.config.include_working_history) {
    if (memory.working_history) {
      memory.working_history = '';
      updateTimestamp();
      notifyMemory();
    }
    return getWorkingMemorySnapshot();
  }
  const next = typeof value === 'string' ? value : value?.text ? value.text : (() => {
      try {
        return JSON.stringify(value);
      } catch (error) {
        return '';
      }
    })();
  if (memory.working_history === next) {
    return getWorkingMemorySnapshot();
  }
  memory.working_history = next;
  updateTimestamp();
  notifyMemory();
  persistPart('working_history', next);
  return getWorkingMemorySnapshot();
}

export function getWorkingMemorySettings() {
  return { ...memory.config };
}

export function updateWorkingMemorySettings(partial = {}) {
  const next = { ...memory.config };
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
  if (JSON.stringify(memory.config) === JSON.stringify(next)) {
    return getWorkingMemorySettings();
  }
  memory.config = next;
  applyConfigVisibility(memory);
  updateTimestamp();
  notifyMemory();
  notifySettings();
  persistPart('config', next);
  if (memory.session.session_id) {
    persistPart('session', { ...memory.session });
  }
  return getWorkingMemorySettings();
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
    listener(getWorkingMemorySettings());
  } catch (error) {
    console.warn('Initial working memory settings listener failed', error);
  }
  return () => {
    settingsListeners.delete(listener);
  };
}

export function appendWorkingMemoryMessage(message) {
  const existing = Array.isArray(memory.messages) ? memory.messages.slice() : [];
  existing.push(message);
  setWorkingMemoryMessages(existing);
}

export function getStoredSession() {
  return null;
}

applyConfigVisibility(memory);
updateTimestamp();
notifyMemory();
notifySettings();
