import {
  fetchJSON,
  fetchMessages,
  fetchWorkingMemoryContext,
  updateNodeWorkingHistory,
} from './api.js';

const DEFAULT_CONFIG = {
  history_length: 20,
  include_project_structure: true,
  include_context: true,
  include_working_history: true,
  auto_refresh_interval: 0,
};

const MAX_HISTORY_LENGTH = 200;

function defaultMessagesMeta() {
  return {
    total_count: 0,
    filtered_count: 0,
    has_more: false,
    next_cursor: null,
    last_user_message: '',
  };
}

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

function sanitiseStructure(structure, fallback = null) {
  const base = fallback && typeof fallback === 'object'
    ? {
        project_graph: sanitiseGraph(fallback.project_graph),
        elements_graph: sanitiseGraph(fallback.elements_graph),
      }
    : {
        project_graph: sanitiseGraph(),
        elements_graph: sanitiseGraph(),
      };
  if (!structure || typeof structure !== 'object') {
    return base;
  }
  const hasProjectGraph = Object.prototype.hasOwnProperty.call(structure, 'project_graph');
  const hasElementsGraph = Object.prototype.hasOwnProperty.call(structure, 'elements_graph');
  if (hasProjectGraph || hasElementsGraph) {
    return {
      project_graph: hasProjectGraph ? sanitiseGraph(structure.project_graph) : base.project_graph,
      elements_graph: hasElementsGraph
        ? sanitiseGraph(structure.elements_graph)
        : base.elements_graph,
    };
  }
  const fallbackGraph = sanitiseGraph(structure);
  return {
    project_graph: fallbackGraph,
    elements_graph: base.elements_graph,
  };
}

function mergeProjectStructureParts(current, next) {
  const base = sanitiseStructure(current);
  if (!next || typeof next !== 'object') {
    return base;
  }
  const hasProjectGraph = Object.prototype.hasOwnProperty.call(next, 'project_graph');
  const hasElementsGraph = Object.prototype.hasOwnProperty.call(next, 'elements_graph');
  if (hasProjectGraph || hasElementsGraph) {
    return {
      project_graph: hasProjectGraph ? sanitiseGraph(next.project_graph) : base.project_graph,
      elements_graph: hasElementsGraph ? sanitiseGraph(next.elements_graph) : base.elements_graph,
    };
  }
  const fallbackGraph = sanitiseGraph(next);
  return {
    project_graph: fallbackGraph,
    elements_graph: base.elements_graph,
  };
}

function sanitiseStructureFromParts({ projectGraph, elementsGraph, structure, current }) {
  const mergedStructure = mergeProjectStructureParts(current, structure);
  const resolvedProjectGraph =
    projectGraph === undefined ? mergedStructure.project_graph : sanitiseGraph(projectGraph);
  const resolvedElementsGraph =
    elementsGraph === undefined ? mergedStructure.elements_graph : sanitiseGraph(elementsGraph);
  return {
    project_graph: resolvedProjectGraph,
    elements_graph: resolvedElementsGraph,
  };
}

function ensureProjectStructure() {
  if (!memory.project_structure || typeof memory.project_structure !== 'object') {
    memory.project_structure = sanitiseStructure({});
  } else {
    memory.project_structure = sanitiseStructure(memory.project_structure);
  }
  return memory.project_structure;
}

function updateGraphPart(graphKey, graphValue, { sanitise = true } = {}) {
  const structure = ensureProjectStructure();
  const next = sanitise ? sanitiseGraph(graphValue) : cloneJson(graphValue);
  const resolved = sanitise ? next : sanitiseGraph(next);
  const current = structure[graphKey] || { nodes: [], edges: [] };
  if (graphsEqual(current, resolved)) {
    return { changed: false, value: current };
  }
  structure[graphKey] = resolved;
  return { changed: true, value: structure[graphKey] };
}

function persistGraphPart(graphKey, graphValue) {
  const partName = graphKey === 'elements_graph' ? 'elements_graph' : 'project_graph';
  persistPart(partName, graphValue);
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
    message_type: safeString(message.message_type || ''),
    content: safeString(message.content || ''),
    created_at: createdAt,
  };
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toSortableId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { number: value, string: String(value) };
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return { number: asNumber, string: String(value) };
    }
    return { number: null, string: String(value) };
  }
  if (value === null || value === undefined) {
    return { number: null, string: '' };
  }
  const asString = String(value);
  const parsed = Number.parseInt(asString, 10);
  if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
    return { number: parsed, string: asString };
  }
  return { number: null, string: asString };
}

function compareMessagesChronologically(a, b) {
  const aTime = toTimestamp(a?.created_at);
  const bTime = toTimestamp(b?.created_at);
  if (aTime !== bTime) {
    return aTime - bTime;
  }
  const aId = toSortableId(a?.id);
  const bId = toSortableId(b?.id);
  if (aId.number !== null && bId.number !== null && aId.number !== bId.number) {
    return aId.number - bId.number;
  }
  if (aId.string !== bId.string) {
    return aId.string.localeCompare(bId.string);
  }
  return 0;
}

function sortMessages(messages) {
  return messages.slice().sort(compareMessagesChronologically);
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
  let lastUserMessage = '';
  for (let index = 0; index < messages.length; index += 1) {
    const entry = messages[index];
    if (entry?.role === 'user' && entry.content) {
      lastUserMessage = entry.content;
    }
  }
  return lastUserMessage;
}

function sanitiseMessagesMeta(meta = {}, { lastUserMessageFallback } = {}) {
  if (!meta || typeof meta !== 'object') {
    const fallback = defaultMessagesMeta();
    if (lastUserMessageFallback) {
      fallback.last_user_message = safeString(lastUserMessageFallback);
    }
    return fallback;
  }
  const result = defaultMessagesMeta();
  const totalCount = Number.parseInt(meta.total_count, 10);
  if (!Number.isNaN(totalCount) && totalCount >= 0) {
    result.total_count = totalCount;
  }
  const filteredCount = Number.parseInt(meta.filtered_count, 10);
  if (!Number.isNaN(filteredCount) && filteredCount >= 0) {
    result.filtered_count = filteredCount;
  }
  if (meta.has_more !== undefined) {
    result.has_more = Boolean(meta.has_more);
  }
  const cursorValue = meta.next_cursor ?? meta.cursor ?? null;
  if (cursorValue !== null && cursorValue !== undefined && cursorValue !== '') {
    result.next_cursor = safeString(cursorValue);
  }
  const resolvedLastUser =
    typeof meta.last_user_message === 'string' && meta.last_user_message.trim()
      ? safeString(meta.last_user_message)
      : lastUserMessageFallback
      ? safeString(lastUserMessageFallback)
      : '';
  result.last_user_message = resolvedLastUser;
  if (typeof meta.last_synced_at === 'string' && meta.last_synced_at.trim()) {
    result.last_synced_at = meta.last_synced_at;
  }
  return result;
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
  const fallbackLastUser = overrides.last_user_message
    ? safeString(overrides.last_user_message)
    : deriveLastUserMessage(messages);
  const messagesMeta = sanitiseMessagesMeta(overrides.messages_meta, {
    lastUserMessageFallback: fallbackLastUser,
  });
  if (!messagesMeta.last_user_message && fallbackLastUser) {
    messagesMeta.last_user_message = fallbackLastUser;
  }
  const lastUserMessage = messagesMeta.last_user_message || fallbackLastUser;
  const projectStructure = sanitiseStructureFromParts({
    projectGraph: overrides.project_graph,
    elementsGraph: overrides.elements_graph,
    structure: overrides.project_structure,
    current: overrides.project_structure,
  });
  return {
    session: {
      session_id: safeString(overrides.session?.session_id ?? ''),
      project_id: safeString(overrides.session?.project_id ?? ''),
      active_node_id: safeString(overrides.session?.active_node_id ?? ''),
      timestamp: overrides.session?.timestamp || timestamp,
    },
    project_structure: projectStructure,
    node_context: sanitiseNodeContext(overrides.node_context),
    fetched_context: sanitiseFetchedContext(overrides.fetched_context),
    working_history: typeof overrides.working_history === 'string' ? overrides.working_history : '',
    messages,
    messages_meta: messagesMeta,
    last_user_message: lastUserMessage,
    config,
  };
}

function sanitiseMemorySnapshot(snapshot, currentMemory = null) {
  const base =
    currentMemory && typeof currentMemory === 'object' ? cloneJson(currentMemory) : buildDefaultMemory();
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
  const fallbackLastUser = snapshot.last_user_message
    ? safeString(snapshot.last_user_message)
    : base.messages_meta?.last_user_message || base.last_user_message || deriveLastUserMessage(messages);
  const messagesMetaSource =
    snapshot.messages_meta !== undefined ? snapshot.messages_meta : base.messages_meta;
  const messagesMeta = sanitiseMessagesMeta(messagesMetaSource, {
    lastUserMessageFallback: fallbackLastUser,
  });
  if (!messagesMeta.last_user_message && fallbackLastUser) {
    messagesMeta.last_user_message = fallbackLastUser;
  }
  const lastUserMessage = messagesMeta.last_user_message || fallbackLastUser;
  const projectStructure = sanitiseStructureFromParts({
    projectGraph: snapshot.project_graph,
    elementsGraph: snapshot.elements_graph,
    structure: snapshot.project_structure ?? base.project_structure,
    current: base.project_structure,
  });
  return {
    session: {
      session_id: safeString(session.session_id ?? base.session.session_id),
      project_id: safeString(session.project_id ?? base.session.project_id),
      active_node_id: safeString(session.active_node_id ?? base.session.active_node_id),
      timestamp: typeof session.timestamp === 'string' && session.timestamp
        ? session.timestamp
        : base.session.timestamp,
    },
    project_structure: projectStructure,
    node_context: sanitiseNodeContext(snapshot.node_context ?? base.node_context),
    fetched_context: sanitiseFetchedContext(snapshot.fetched_context ?? base.fetched_context),
    working_history: typeof snapshot.working_history === 'string' ? snapshot.working_history : '',
    messages,
    messages_meta: messagesMeta,
    last_user_message: lastUserMessage,
    config,
  };
}

function applyConfigVisibility(target) {
  if (!target.config.include_project_structure) {
    if (!hiddenProjectStructureFrozen) {
      hiddenProjectStructure = mergeProjectStructureParts(hiddenProjectStructure, target.project_structure);
      hiddenProjectStructureFrozen = true;
    }
    target.project_structure = sanitiseStructure({});
  } else if (hiddenProjectStructure) {
    target.project_structure = mergeProjectStructureParts(target.project_structure, hiddenProjectStructure);
    resetHiddenProjectStructure();
  } else {
    hiddenProjectStructureFrozen = false;
  }
  if (!target.config.include_context) {
    target.node_context = {};
  }
  if (!target.config.include_working_history) {
    target.working_history = '';
  }
  target.messages = limitMessages(target.messages, target.config.history_length);
  target.messages_meta = sanitiseMessagesMeta(target.messages_meta, {
    lastUserMessageFallback: deriveLastUserMessage(target.messages),
  });
  if (!target.messages_meta.last_user_message) {
    target.messages_meta.last_user_message = deriveLastUserMessage(target.messages);
  }
  target.last_user_message =
    target.messages_meta.last_user_message || deriveLastUserMessage(target.messages);
}

const memoryListeners = new Set();
const settingsListeners = new Set();

let memory = buildDefaultMemory();
let hiddenProjectStructure = null;
let hiddenProjectStructureFrozen = false;
let pendingLoad = null;
let nodeHydrationController = null;
let nodeHydrationSequence = 0;
const pendingRefreshes = new Map();
const DEFAULT_REFRESH_REASON = 'manual';

function cancelNodeHydration() {
  if (nodeHydrationController) {
    nodeHydrationController.abort();
    nodeHydrationController = null;
  }
}

/**
 * Internal helper that performs the actual working-memory hydration. Prefer using
 * {@link refreshWorkingMemory} so duplicate refresh requests are naturally
 * deduplicated across modules.
 */
async function hydrateActiveNodeContext({ sessionId, projectId, nodeId }) {
  // Ensure identifiers come from active state or persistent storage
  const storedSession =
    sessionId ||
    memory.session?.session_id ||
    window.__active_session_id ||
    (typeof localStorage !== 'undefined' ? localStorage.getItem('session_id') : null);
  const effectiveSessionId = safeString(storedSession).trim();
  const effectiveProjectId = safeString(
    projectId === undefined ? memory.session?.project_id : projectId
  ).trim();
  const effectiveNodeId = safeString(
    nodeId === undefined ? memory.session?.active_node_id : nodeId
  ).trim();

  if (!effectiveProjectId || !effectiveNodeId) {
    console.warn('hydrateActiveNodeContext: missing scope identifiers');
    return;
  }

  cancelNodeHydration();
  nodeHydrationSequence += 1;
  const token = nodeHydrationSequence;
  const controller = new AbortController();
  nodeHydrationController = controller;
  const includeWorkingHistory = memory.config.include_working_history !== false;
  const historyLength = normaliseHistoryLength(memory.config.history_length);
  try {
    let payload = await fetchWorkingMemoryContext({
      sessionId: effectiveSessionId || undefined,
      projectId: effectiveProjectId || undefined,
      nodeId: effectiveNodeId || undefined,
      historyLength,
      includeWorkingHistory,
      signal: controller.signal,
    });

    // Fallback: if no messages returned, query them directly
    if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
      try {
        const directParams = {
          nodeId: effectiveNodeId || undefined,
          limit: historyLength,
        };
        if (effectiveSessionId) {
          directParams.sessionId = effectiveSessionId;
        } else if (effectiveProjectId) {
          directParams.projectId = effectiveProjectId;
        }
        const direct = await fetchMessages(directParams);
        payload = { ...payload, messages: direct.messages, messages_meta: direct };
      } catch (e) {
        console.warn('Fallback fetchMessages failed', e);
      }
    }

    if (controller.signal.aborted || token !== nodeHydrationSequence) {
      return;
    }
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const hasMessages = Array.isArray(payload.messages);
    const hasMeta = payload.messages_meta && typeof payload.messages_meta === 'object';
    const hasLastUser = Object.prototype.hasOwnProperty.call(payload, 'last_user_message');
    if (hasMessages || hasMeta || hasLastUser) {
      let metadata = hasMeta ? payload.messages_meta : undefined;
      if (!metadata && hasLastUser) {
        metadata = {
          ...(memory.messages_meta ? memory.messages_meta : defaultMessagesMeta()),
          last_user_message:
            typeof payload.last_user_message === 'string'
              ? payload.last_user_message
              : '',
        };
      }
      const messageList = hasMessages ? payload.messages : memory.messages;
      setWorkingMemoryMessages(messageList, metadata);
    }
    if (
      includeWorkingHistory &&
      Object.prototype.hasOwnProperty.call(payload, 'working_history') &&
      effectiveNodeId
    ) {
      setWorkingMemoryWorkingHistory(payload.working_history);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    console.warn('Failed to hydrate working memory context', error);
  } finally {
    if (nodeHydrationController === controller) {
      nodeHydrationController = null;
    }
  }
}

function buildRefreshKey(projectId, nodeId, reason) {
  const projectKey = safeString(projectId).trim();
  const nodeKey = safeString(nodeId).trim();
  const reasonKey = (() => {
    if (reason === undefined || reason === null) {
      return DEFAULT_REFRESH_REASON;
    }
    const value = safeString(reason).trim();
    return value || DEFAULT_REFRESH_REASON;
  })();
  return `${projectKey}::${nodeKey}::${reasonKey}`;
}

/**
 * Request a working-memory refresh for a specific project/node scope. Duplicate
 * calls with the same identifiers and reason will reuse the in-flight request.
 */
export function refreshWorkingMemory({ projectId, nodeId, reason } = {}) {
  const resolvedProjectId = safeString(
    projectId === undefined ? memory.session?.project_id : projectId
  ).trim();
  const resolvedNodeId = safeString(
    nodeId === undefined ? memory.session?.active_node_id : nodeId
  ).trim();
  if (!resolvedProjectId || !resolvedNodeId) {
    return Promise.resolve();
  }
  const key = buildRefreshKey(resolvedProjectId, resolvedNodeId, reason);
  const existing = pendingRefreshes.get(key);
  if (existing) {
    return existing;
  }
  const refreshPromise = hydrateActiveNodeContext({
    sessionId: '',
    projectId: resolvedProjectId,
    nodeId: resolvedNodeId,
  }).finally(() => {
    if (pendingRefreshes.get(key) === refreshPromise) {
      pendingRefreshes.delete(key);
    }
  });
  pendingRefreshes.set(key, refreshPromise);
  return refreshPromise;
}


function resetHiddenProjectStructure() {
  hiddenProjectStructure = null;
  hiddenProjectStructureFrozen = false;
}

function thawHiddenProjectStructure() {
  hiddenProjectStructureFrozen = false;
}

function getHiddenStructureSnapshot() {
  return sanitiseStructure(hiddenProjectStructure);
}

function updateHiddenGraphPart(graphKey, graphValue) {
  const previous = getHiddenStructureSnapshot();
  const sanitised = sanitiseGraph(graphValue);
  const merged = mergeProjectStructureParts(previous, { [graphKey]: sanitised });
  const previousGraph = previous[graphKey] || { nodes: [], edges: [] };
  const nextGraph = merged[graphKey] || { nodes: [], edges: [] };
  const changed = !graphsEqual(previousGraph, nextGraph);
  hiddenProjectStructure = merged;
  return { changed, value: nextGraph };
}

function updateHiddenStructureSnapshot(structure) {
  const previous = getHiddenStructureSnapshot();
  const sanitised = sanitiseStructure(structure, previous);
  const merged = mergeProjectStructureParts(previous, sanitised);
  const changedProject = !graphsEqual(previous.project_graph, merged.project_graph);
  const changedElements = !graphsEqual(previous.elements_graph, merged.elements_graph);
  hiddenProjectStructure = merged;
  return {
    changedProject,
    changedElements,
    value: merged,
  };
}

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
  const sessionId = safeString(memory.session.session_id).trim();
  const projectId = safeString(memory.session.project_id).trim();
  const activeNodeId = safeString(memory.session.active_node_id).trim();
  const payloadOptions = options ? { ...options } : {};
  if (
    activeNodeId &&
    payloadOptions.nodeId === undefined &&
    payloadOptions.node_id === undefined
  ) {
    payloadOptions.nodeId = activeNodeId;
  }
  const scopedNodeId = safeString(
    payloadOptions.node_id ?? payloadOptions.nodeId ?? activeNodeId
  ).trim();
  if (!sessionId && (!projectId || !scopedNodeId)) {
    return Promise.resolve();
  }
  const body = {
    session_id: sessionId,
    project_id: projectId,
    node_id: scopedNodeId,
    value,
  };
  if (Object.keys(payloadOptions).length) {
    body.options = payloadOptions;
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
    thawHiddenProjectStructure();
    const fallbackMemory = hiddenProjectStructure
      ? { ...memory, project_structure: mergeProjectStructureParts(memory.project_structure, hiddenProjectStructure) }
      : memory;
    const next = sanitiseMemorySnapshot(data?.memory, fallbackMemory);
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
  const structure = sanitiseStructure(snapshot.project_structure || {});
  const fallbackStructure = cloneJson(structure);
  const targetId = nodeId ? safeString(nodeId) : scoped.session?.active_node_id || '';
  if (!targetId) {
    scoped.project_structure = fallbackStructure;
    return scoped;
  }
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

  if (!hasProjectNode && !hasElementNode) {
    scoped.project_structure = fallbackStructure;
    return scoped;
  }

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

  const scopedStructure = {
    project_graph: hasProjectNode
      ? {
          nodes: filterNodes(projectNodes, projectNodeIds),
          edges: projectEdges.filter((edge) => edge.from === targetId || edge.to === targetId),
        }
      : fallbackStructure.project_graph,
    elements_graph: hasElementNode
      ? {
          nodes: filterNodes(elementNodes, elementNodeIds),
          edges: elementEdges.filter((edge) => edge.from === targetId || edge.to === targetId),
        }
      : fallbackStructure.elements_graph,
  };

  scoped.project_structure = scopedStructure;
  scoped.messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.filter((message) => !message.node_id || message.node_id === targetId)
    : [];
  const metaFallback = sanitiseMessagesMeta(snapshot.messages_meta, {
    lastUserMessageFallback: snapshot.last_user_message || deriveLastUserMessage(snapshot.messages || []),
  });
  const scopedMeta = {
    ...metaFallback,
    filtered_count: scoped.messages.length,
  };
  const scopedLastUser = scoped.messages.length
    ? deriveLastUserMessage(scoped.messages)
    : scopedMeta.last_user_message;
  scoped.messages_meta = sanitiseMessagesMeta(
    { ...scopedMeta, last_user_message: scopedLastUser },
    { lastUserMessageFallback: scopedLastUser }
  );
  scoped.last_user_message = scoped.messages_meta.last_user_message;
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
  resetHiddenProjectStructure();
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
  resetHiddenProjectStructure();
  updateTimestamp();
  notifyMemory();
  notifySettings();
  return getWorkingMemorySnapshot();
}

export async function setWorkingMemorySession(partial = {}) {
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
  if (sessionChanged || nodeChanged) {
    cancelNodeHydration();
  }
  if (sessionChanged || projectChanged) {
    resetHiddenProjectStructure();
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
  if (
    nodeChanged &&
    (memory.session.session_id || (memory.session.project_id && memory.session.active_node_id))
  ) {
    try {
      await refreshWorkingMemory({
        projectId: memory.session.project_id,
        nodeId: memory.session.active_node_id,
        reason: 'session-node-change',
      });
    } catch (error) {
      console.warn('Failed to hydrate working memory after node change', error);
    }
  }
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryProjectGraph(graph = {}) {
  const includeStructure = memory.config.include_project_structure !== false;
  if (!includeStructure) {
    const { changed, value } = updateHiddenGraphPart('project_graph', graph);
    if (!changed) {
      return getWorkingMemorySnapshot();
    }
    updateTimestamp();
    notifyMemory();
    persistGraphPart('project_graph', value);
    return getWorkingMemorySnapshot();
  }
  const { changed, value } = updateGraphPart('project_graph', graph);
  if (!changed) {
    return getWorkingMemorySnapshot();
  }
  updateTimestamp();
  notifyMemory();
  persistGraphPart('project_graph', value);
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryElementsGraph(graph = {}) {
  const includeStructure = memory.config.include_project_structure !== false;
  if (!includeStructure) {
    const { changed, value } = updateHiddenGraphPart('elements_graph', graph);
    if (!changed) {
      return getWorkingMemorySnapshot();
    }
    updateTimestamp();
    notifyMemory();
    persistGraphPart('elements_graph', value);
    return getWorkingMemorySnapshot();
  }
  const { changed, value } = updateGraphPart('elements_graph', graph);
  if (!changed) {
    return getWorkingMemorySnapshot();
  }
  updateTimestamp();
  notifyMemory();
  persistGraphPart('elements_graph', value);
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryProjectStructure(structure = {}) {
  const includeStructure = memory.config.include_project_structure !== false;
  if (!includeStructure) {
    const { changedProject, changedElements, value } = updateHiddenStructureSnapshot(structure);
    if (!changedProject && !changedElements) {
      return getWorkingMemorySnapshot();
    }
    updateTimestamp();
    notifyMemory();
    if (changedProject) {
      persistGraphPart('project_graph', value.project_graph);
    }
    if (changedElements) {
      persistGraphPart('elements_graph', value.elements_graph);
    }
    return getWorkingMemorySnapshot();
  }
  const current = ensureProjectStructure();
  const sanitised = sanitiseStructure(structure, current);
  const projectUpdate = updateGraphPart('project_graph', sanitised.project_graph, { sanitise: false });
  const elementsUpdate = updateGraphPart('elements_graph', sanitised.elements_graph, { sanitise: false });
  if (!projectUpdate.changed && !elementsUpdate.changed) {
    return getWorkingMemorySnapshot();
  }
  updateTimestamp();
  notifyMemory();
  if (projectUpdate.changed) {
    persistGraphPart('project_graph', projectUpdate.value);
  }
  if (elementsUpdate.changed) {
    persistGraphPart('elements_graph', elementsUpdate.value);
  }
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
  const targetNodeId = safeString(next.id || memory.session.active_node_id).trim();
  persistPart('node_context', next, targetNodeId ? { nodeId: targetNodeId } : undefined);
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
  const targetNodeId = safeString(memory.session.active_node_id).trim();
  persistPart('fetched_context', next, targetNodeId ? { nodeId: targetNodeId } : undefined);
  return getWorkingMemorySnapshot();
}

export function setWorkingMemoryMessages(messages, metadata = null) {
  const nextMessages = limitMessages(messages, memory.config.history_length);
  const metaSource = metadata === null || metadata === undefined ? memory.messages_meta : metadata;
  const sanitisedMeta = sanitiseMessagesMeta(metaSource, {
    lastUserMessageFallback: deriveLastUserMessage(nextMessages),
  });
  if (!sanitisedMeta.last_user_message) {
    sanitisedMeta.last_user_message = deriveLastUserMessage(nextMessages);
  }
  const resolvedLastUser = sanitisedMeta.last_user_message || deriveLastUserMessage(nextMessages);
  const messagesChanged = JSON.stringify(memory.messages) !== JSON.stringify(nextMessages);
  const metaChanged = JSON.stringify(memory.messages_meta) !== JSON.stringify(sanitisedMeta);
  const lastUserChanged = memory.last_user_message !== resolvedLastUser;
  if (!messagesChanged && !metaChanged && !lastUserChanged) {
    return getWorkingMemorySnapshot();
  }
  memory.messages = nextMessages;
  memory.messages_meta = sanitisedMeta;
  memory.last_user_message = resolvedLastUser;
  updateTimestamp();
  notifyMemory();
  const activeNodeId = safeString(memory.session.active_node_id).trim();
  const nodeOptions = activeNodeId ? { nodeId: activeNodeId } : undefined;
  persistPart('messages_meta', sanitisedMeta, nodeOptions);
  const lastUserOptions = {
    messages: nextMessages,
    metadata: sanitisedMeta,
  };
  if (activeNodeId) {
    lastUserOptions.nodeId = activeNodeId;
  }
  persistPart('last_user_message', memory.last_user_message, lastUserOptions);
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
  const activeNodeId = safeString(memory.session?.active_node_id).trim();
  const projectId = safeString(memory.session?.project_id).trim();
  const persistPromise = persistPart(
    'working_history',
    next,
    activeNodeId ? { nodeId: activeNodeId } : undefined
  );
  if (
    activeNodeId &&
    projectId &&
    persistPromise &&
    typeof persistPromise.then === 'function'
  ) {
    persistPromise
      .then(() =>
        updateNodeWorkingHistory({
          projectId,
          nodeId: activeNodeId,
          workingHistory: next,
        })
      )
      .catch((error) => {
        console.warn('Failed to sync node working history', error);
      });
  }
  return getWorkingMemorySnapshot();
}

export function getWorkingMemorySettings() {
  return { ...memory.config };
}

export function ensureProjectStructureIncluded() {
  if (memory.config.include_project_structure) {
    return getWorkingMemorySettings();
  }
  return updateWorkingMemorySettings({ include_project_structure: true });
}

export function updateWorkingMemorySettings(partial = {}) {
  const next = { ...memory.config };
  if (partial.history_length !== undefined) {
    next.history_length = normaliseHistoryLength(partial.history_length);
  }
  if (partial.include_project_structure !== undefined) {
    next.include_project_structure = Boolean(partial.include_project_structure);
  }
  const includeProjectStructureChanged =
    partial.include_project_structure !== undefined &&
    next.include_project_structure !== memory.config.include_project_structure;
  if (includeProjectStructureChanged && !next.include_project_structure) {
    thawHiddenProjectStructure();
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

export function appendWorkingMemoryMessage(message, metadata = null) {
  const existing = Array.isArray(memory.messages) ? memory.messages.slice() : [];
  existing.push(message);
  const metaSource = metadata === null || metadata === undefined ? memory.messages_meta : metadata;
  setWorkingMemoryMessages(existing, metaSource);
}

export function getStoredSession() {
  return null;
}

applyConfigVisibility(memory);
updateTimestamp();
notifyMemory();
notifySettings();
