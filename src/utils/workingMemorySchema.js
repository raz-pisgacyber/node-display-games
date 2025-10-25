const DEFAULT_CONFIG = {
  history_length: 20,
  include_project_structure: true,
  include_context: true,
  include_working_history: true,
  auto_refresh_interval: 0,
};

const WORKING_MEMORY_PARTS = new Set([
  'session',
  'project_structure',
  'node_context',
  'fetched_context',
  'working_history',
  'messages',
  'last_user_message',
  'config',
]);

const MAX_HISTORY_LENGTH = 200;
const MAX_AUTO_REFRESH_INTERVAL = 600;

function clamp(value, min, max) {
  const lower = min === undefined ? value : Math.max(value, min);
  const upper = max === undefined ? lower : Math.min(lower, max);
  return upper;
}

function normaliseNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return clamp(fallback, min, max);
  }
  return clamp(parsed, min, max);
}

function ensureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
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
      // Ignore and fall back below.
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
    label: safeString(node.label || node.title || ''),
    type: safeString(node.type || ''),
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

function sanitiseNodeContext(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  const id = safeString(context.id || context.node_id || '');
  return {
    id,
    label: safeString(context.label || context.title || ''),
    type: safeString(context.type || context.builder || ''),
    meta: {
      ...ensureObject(context.meta),
      ...(context.notes ? { notes: safeString(context.notes) } : {}),
      ...(context.customFields ? { customFields: sanitiseCustomFields(context.customFields) } : {}),
      ...(context.linked_elements
        ? { linked_elements: sanitiseLinkedElements(context.linked_elements) }
        : {}),
    },
  };
}

function sanitiseFetchedContext(context) {
  const source = ensureObject(context);
  return cloneJson(source);
}

function sanitiseWorkingHistory(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  if (typeof value.text === 'string') {
    return value.text;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return '';
  }
}

function sanitiseMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const createdAtValue = message.created_at;
  let created_at = '';
  if (createdAtValue instanceof Date) {
    created_at = createdAtValue.toISOString();
  } else if (typeof createdAtValue === 'string') {
    created_at = createdAtValue;
  }
  return {
    id: safeString(message.id),
    session_id: safeString(message.session_id),
    node_id:
      message.node_id === null || message.node_id === undefined || message.node_id === ''
        ? null
        : safeString(message.node_id),
    role: safeString(message.role || 'user'),
    content: safeString(message.content || ''),
    created_at,
  };
}

function sortMessagesByTimestamp(messages) {
  return messages
    .slice()
    .sort((a, b) => {
      const aTime = a.created_at ? Date.parse(a.created_at) || 0 : 0;
      const bTime = b.created_at ? Date.parse(b.created_at) || 0 : 0;
      return aTime - bTime;
    });
}

function sanitiseMessages(messages, { historyLength } = {}) {
  const limit = clamp(historyLength || DEFAULT_CONFIG.history_length, 1, MAX_HISTORY_LENGTH);
  const list = Array.isArray(messages) ? messages : [];
  const sanitised = list.map(sanitiseMessage).filter(Boolean);
  const ordered = sortMessagesByTimestamp(sanitised);
  if (ordered.length <= limit) {
    return ordered;
  }
  return ordered.slice(ordered.length - limit);
}

function deriveLastUserMessage(messages) {
  if (!Array.isArray(messages)) {
    return '';
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry?.role === 'user' && entry.content) {
      return entry.content;
    }
  }
  return '';
}

function sanitiseLastUserMessage(value, { messages } = {}) {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return deriveLastUserMessage(messages || []);
}

function sanitiseConfig(config) {
  const source = ensureObject(config);
  return {
    history_length: normaliseNumber(source.history_length, DEFAULT_CONFIG.history_length, 1, MAX_HISTORY_LENGTH),
    include_project_structure: Boolean(
      source.include_project_structure ?? DEFAULT_CONFIG.include_project_structure
    ),
    include_context: Boolean(source.include_context ?? DEFAULT_CONFIG.include_context),
    include_working_history: Boolean(
      source.include_working_history ?? DEFAULT_CONFIG.include_working_history
    ),
    auto_refresh_interval: normaliseNumber(
      source.auto_refresh_interval,
      DEFAULT_CONFIG.auto_refresh_interval,
      0,
      MAX_AUTO_REFRESH_INTERVAL
    ),
  };
}

function sanitiseSession(session) {
  const base = ensureObject(session);
  return {
    session_id: safeString(base.session_id),
    project_id: safeString(base.project_id),
    active_node_id: safeString(base.active_node_id),
    timestamp:
      typeof base.timestamp === 'string' && base.timestamp
        ? base.timestamp
        : new Date().toISOString(),
  };
}

function sanitiseWorkingMemoryPart(part, value, options = {}) {
  switch (part) {
    case 'session':
      return sanitiseSession(value);
    case 'project_structure':
      return sanitiseStructure(value);
    case 'node_context':
      return sanitiseNodeContext(value);
    case 'fetched_context':
      return sanitiseFetchedContext(value);
    case 'working_history':
      return sanitiseWorkingHistory(value);
    case 'messages':
      return sanitiseMessages(value, { historyLength: options.historyLength });
    case 'last_user_message':
      return sanitiseLastUserMessage(value, { messages: options.messages });
    case 'config':
      return sanitiseConfig(value);
    default:
      return value;
  }
}

function buildDefaultMemory(overrides = {}) {
  const timestamp = new Date().toISOString();
  const config = sanitiseConfig(overrides.config || DEFAULT_CONFIG);
  return {
    session: {
      session_id: '',
      project_id: '',
      active_node_id: '',
      timestamp,
    },
    project_structure: sanitiseStructure(overrides.project_structure),
    node_context: sanitiseNodeContext(overrides.node_context),
    fetched_context: sanitiseFetchedContext(overrides.fetched_context),
    working_history: sanitiseWorkingHistory(overrides.working_history),
    messages: sanitiseMessages(overrides.messages, { historyLength: config.history_length }),
    last_user_message: sanitiseLastUserMessage(overrides.last_user_message, {
      messages: overrides.messages,
    }),
    config,
  };
}

function composeWorkingMemory(parts = {}) {
  const defaults = buildDefaultMemory();
  const incomingConfig = parts.config || defaults.config;
  const config = sanitiseConfig(incomingConfig);

  const session = sanitiseSession({ ...defaults.session, ...ensureObject(parts.session) });
  const projectStructure = sanitiseStructure(parts.project_structure || defaults.project_structure);
  const nodeContext = sanitiseNodeContext(parts.node_context || defaults.node_context);
  const fetchedContext = sanitiseFetchedContext(parts.fetched_context || defaults.fetched_context);
  const workingHistory = sanitiseWorkingHistory(parts.working_history || defaults.working_history);
  const messages = sanitiseMessages(parts.messages || defaults.messages, {
    historyLength: config.history_length,
  });
  const lastUserMessage = sanitiseLastUserMessage(parts.last_user_message, { messages });

  return {
    session,
    project_structure: projectStructure,
    node_context: nodeContext,
    fetched_context: fetchedContext,
    working_history: workingHistory,
    messages,
    last_user_message: lastUserMessage || deriveLastUserMessage(messages),
    config,
  };
}

function normaliseWorkingMemory(memory) {
  const source = ensureObject(memory);
  const parts = {};
  Object.keys(source).forEach((key) => {
    if (WORKING_MEMORY_PARTS.has(key)) {
      parts[key] = source[key];
    }
  });
  return composeWorkingMemory(parts);
}

module.exports = {
  DEFAULT_CONFIG,
  WORKING_MEMORY_PARTS,
  MAX_HISTORY_LENGTH,
  buildDefaultMemory,
  sanitiseWorkingMemoryPart,
  composeWorkingMemory,
  normaliseWorkingMemory,
  deriveLastUserMessage,
};
