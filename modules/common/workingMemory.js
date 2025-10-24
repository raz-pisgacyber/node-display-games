const MEMORY_STORAGE_KEY = 'story-graph-working-memory';
const SETTINGS_STORAGE_KEY = 'story-graph-working-memory-settings';
const SESSION_STORAGE_PREFIX = 'story-graph-session:';

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
    project_structure: {},
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

function sanitiseMeta(meta = {}, fallback = {}) {
  const source = typeof meta === 'object' && meta ? meta : {};
  const result = {};
  const builder = source.builder ?? fallback.builder;
  if (builder) {
    result.builder = safeString(builder);
  }
  const notes = source.notes ?? fallback.notes;
  if (typeof notes === 'string' && notes.trim()) {
    result.notes = notes;
  }
  const projectData = source.projectData ?? fallback.projectData;
  if (projectData && typeof projectData === 'object') {
    result.projectData = cloneJson(projectData);
  }
  return result;
}

function sanitiseStructureNode(node) {
  if (!node) {
    return null;
  }
  const id = safeString(node.id);
  if (!id) {
    return null;
  }
  const meta = sanitiseMeta(node.meta, {
    notes: node.notes,
    projectData: node.projectData,
    builder: node.builder,
  });
  return {
    id,
    label: safeString(node.label ?? node.title ?? ''),
    meta,
  };
}

function sanitiseStructureEdge(edge) {
  if (!edge) {
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

function sanitiseStructure(structure) {
  if (!structure || typeof structure !== 'object') {
    return { nodes: [], edges: [] };
  }
  const nodes = Array.isArray(structure.nodes)
    ? structure.nodes.map(sanitiseStructureNode).filter(Boolean)
    : [];
  const edges = Array.isArray(structure.edges)
    ? structure.edges.map(sanitiseStructureEdge).filter(Boolean)
    : [];
  return { nodes, edges };
}

function sanitiseNodeContext(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  const nodeContext = {
    id: safeString(context.id ?? context.node_id ?? ''),
    label: safeString(context.label ?? context.title ?? ''),
    meta: sanitiseMeta(context.meta, {
      notes: context.notes,
      projectData: context.projectData,
      builder: context.builder,
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
    target.project_structure = {};
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
    scoped.project_structure = { nodes: [], edges: [] };
    scoped.node_context = {};
    scoped.messages = [];
    scoped.last_user_message = '';
    return scoped;
  }
  const structure = snapshot.project_structure || {};
  const nodes = Array.isArray(structure.nodes) ? structure.nodes.filter((node) => node.id === targetId) : [];
  const edges = Array.isArray(structure.edges)
    ? structure.edges.filter((edge) => edge.from === targetId || edge.to === targetId)
    : [];
  scoped.project_structure = { nodes, edges };
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
      target.project_structure = {};
      commitMemory();
    }
    return getWorkingMemorySnapshot();
  }
  target.project_structure = sanitiseStructure(structure);
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
