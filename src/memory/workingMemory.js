const config = require('../config');
const { getWriteSession, getReadSession } = require('../db/neo4j');
const { pool } = require('../db/mysql');
const { extractNode, parseMeta } = require('../utils/neo4jHelpers');
const { queryWithLogging } = require('../utils/mysqlLogger');

const GLOBAL_NODE_KEY = '__global__';
const RECENT_MESSAGES_LIMIT = 50;

const memoryStore = new Map();
const sessionIndex = new Map();
const nodeIndex = new Map();
const projectIndex = new Map();

function normaliseId(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return `${value}`;
}

function buildKey(sessionId, nodeId) {
  const safeSession = normaliseId(sessionId);
  const safeNode = nodeId === undefined || nodeId === null || nodeId === '' ? GLOBAL_NODE_KEY : normaliseId(nodeId);
  if (!safeSession) {
    throw new Error('sessionId is required to build working memory key');
  }
  return `${safeSession}::${safeNode}`;
}

function clone(value) {
  if (value === null || value === undefined) return value;
  if (typeof global.structuredClone === 'function') {
    return global.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function ensureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function addToIndex(index, id, key) {
  if (!id) return;
  const safeId = normaliseId(id);
  if (!safeId) return;
  const existing = index.get(safeId);
  if (existing) {
    existing.add(key);
    return;
  }
  index.set(safeId, new Set([key]));
}

function removeFromIndex(index, id, key) {
  if (!id) return;
  const safeId = normaliseId(id);
  if (!safeId) return;
  const existing = index.get(safeId);
  if (!existing) return;
  existing.delete(key);
  if (existing.size === 0) {
    index.delete(safeId);
  }
}

function normaliseMessage(row) {
  if (!row) return null;
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || null;
  return {
    id: row.id,
    session_id: normaliseId(row.session_id),
    node_id: row.node_id === null || row.node_id === undefined ? null : normaliseId(row.node_id),
    role: row.role,
    content: row.content,
    created_at: createdAt,
  };
}

function trimStructureNode(node, projectId) {
  if (!node) return null;
  const safeProject = normaliseId(node.project_id || projectId);
  const meta = ensureObject(node.meta);
  return {
    id: normaliseId(node.id),
    label: node.label || '',
    meta,
    project_id: safeProject,
    version_id: node.version_id || null,
    last_modified: node.last_modified || null,
  };
}

function trimStructureEdge(edge, projectId) {
  if (!edge || !edge.from || !edge.to) return null;
  return {
    from: normaliseId(edge.from),
    to: normaliseId(edge.to),
    type: edge.type || 'LINKS_TO',
    props: ensureObject(edge.props),
    project_id: normaliseId(edge.project_id || projectId),
  };
}

function normaliseStructureIndex(index, projectId) {
  const nodes = Array.isArray(index?.nodes)
    ? index.nodes
        .map((node) => trimStructureNode(node, projectId))
        .filter((node) => node && node.id)
    : [];
  const edges = Array.isArray(index?.edges)
    ? index.edges
        .map((edge) => trimStructureEdge(edge, projectId))
        .filter((edge) => edge && edge.from && edge.to)
    : [];
  return { nodes, edges };
}

function normaliseMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  const normalised = messages
    .map((message) => normaliseMessage(message))
    .filter(Boolean)
    .sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
      return aTime - bTime;
    });
  if (normalised.length > RECENT_MESSAGES_LIMIT) {
    return normalised.slice(normalised.length - RECENT_MESSAGES_LIMIT);
  }
  return normalised;
}

async function fetchSessionRecord(sessionId) {
  const [rows] = await queryWithLogging(
    pool,
    'SELECT id, project_id, active_node FROM sessions WHERE id = ?',
    [sessionId]
  );
  return rows[0] || null;
}

async function fetchStructureIndex(projectId) {
  const session = getWriteSession();
  try {
    const result = await session.run(
      `MATCH (n:ProjectNode)
       WHERE coalesce(n.project_id, $projectId) = $projectId
       SET n.project_id = coalesce(n.project_id, $projectId)
       WITH n
       OPTIONAL MATCH (n)-[r]->(m:ProjectNode)
       WHERE coalesce(m.project_id, $projectId) = $projectId
       RETURN collect(DISTINCT n) AS nodes,
              collect(DISTINCT {from: n.id, to: m.id, type: type(r), props: properties(r)}) AS edges`,
      { projectId }
    );
    const record = result.records[0];
    const nodes = (record?.get('nodes') || []).map((node) => extractNode(node));
    const edges = record?.get('edges') || [];
    return normaliseStructureIndex({ nodes, edges }, projectId);
  } finally {
    await session.close();
  }
}

async function fetchCurrentNode(projectId, nodeId) {
  if (!nodeId) return null;
  const session = getReadSession();
  try {
    const result = await session.run(
      `MATCH (n:ProjectNode {id: $id})
       WHERE coalesce(n.project_id, $projectId) = $projectId
       RETURN n`,
      { id: nodeId, projectId }
    );
    if (!result.records.length) {
      return null;
    }
    const node = extractNode(result.records[0].get('n'));
    if (!node.project_id) {
      node.project_id = projectId;
    }
    if (node.meta && typeof node.meta === 'string') {
      node.meta = parseMeta(node.meta);
    }
    return node;
  } finally {
    await session.close();
  }
}

async function fetchRecentMessages(sessionId, nodeId) {
  const params = [sessionId];
  let sql = 'SELECT id, session_id, node_id, role, content, created_at FROM messages WHERE session_id = ?';
  if (nodeId) {
    sql += ' AND (node_id = ? OR node_id IS NULL)';
    params.push(nodeId);
  }
  sql += ` ORDER BY created_at DESC LIMIT ${RECENT_MESSAGES_LIMIT}`;
  const [rows] = await queryWithLogging(pool, sql, params);
  return normaliseMessages(rows.reverse());
}

async function fetchLatestSummary(sessionId) {
  const [rows] = await queryWithLogging(
    pool,
    'SELECT summary_json, created_at FROM summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
    [sessionId]
  );
  if (!rows.length) {
    return null;
  }
  const row = rows[0];
  let summary = row.summary_json;
  if (typeof summary === 'string') {
    try {
      summary = JSON.parse(summary);
    } catch (error) {
      summary = { text: summary };
    }
  }
  return {
    summary,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || null,
  };
}

function normaliseMemory(memory) {
  if (!memory) return null;
  const cloneMemory = clone(memory);
  if (cloneMemory && cloneMemory.context_data) {
    cloneMemory.context_data = ensureObject(cloneMemory.context_data);
  }
  return cloneMemory;
}

function registerMemory(memory) {
  const key = buildKey(memory.session_id, memory.node_id);
  memoryStore.set(key, memory);
  addToIndex(sessionIndex, memory.session_id, key);
  if (memory.node_id) {
    addToIndex(nodeIndex, memory.node_id, key);
  }
  addToIndex(projectIndex, memory.project_id, key);
  return key;
}

function removeMemoryByKey(key) {
  const existing = memoryStore.get(key);
  if (!existing) {
    return;
  }
  memoryStore.delete(key);
  removeFromIndex(sessionIndex, existing.session_id, key);
  if (existing.node_id) {
    removeFromIndex(nodeIndex, existing.node_id, key);
  }
  removeFromIndex(projectIndex, existing.project_id, key);
}

function getKeysForSession(sessionId) {
  if (!sessionId) return [];
  const safeSession = normaliseId(sessionId);
  const keys = sessionIndex.get(safeSession);
  return keys ? Array.from(keys) : [];
}

function getKeysForNode(nodeId) {
  if (!nodeId) return [];
  const safeNode = normaliseId(nodeId);
  const keys = nodeIndex.get(safeNode);
  return keys ? Array.from(keys) : [];
}

function getKeysForProject(projectId) {
  if (!projectId) return [];
  const safeProject = normaliseId(projectId);
  const keys = projectIndex.get(safeProject);
  return keys ? Array.from(keys) : [];
}

function mergePatch(existing, patch) {
  const now = new Date().toISOString();
  const next = { ...existing, updated_at: now };

  if (patch.structure_index !== undefined) {
    next.structure_index = normaliseStructureIndex(patch.structure_index, existing.project_id);
  }
  if (patch.current_node !== undefined) {
    next.current_node = patch.current_node;
  }
  if (patch.recent_messages !== undefined) {
    next.recent_messages = normaliseMessages(patch.recent_messages);
  }
  if (patch.append_recent_messages) {
    const combined = Array.isArray(next.recent_messages) ? [...next.recent_messages] : [];
    const appendList = normaliseMessages(patch.append_recent_messages);
    combined.push(...appendList);
    if (combined.length > RECENT_MESSAGES_LIMIT) {
      next.recent_messages = combined.slice(combined.length - RECENT_MESSAGES_LIMIT);
    } else {
      next.recent_messages = combined;
    }
  }
  if (patch.work_history_summary !== undefined) {
    next.work_history_summary = patch.work_history_summary;
  }
  if (patch.context_data !== undefined) {
    const base = ensureObject(next.context_data);
    next.context_data = { ...base, ...ensureObject(patch.context_data) };
  }
  if (patch.clear_context_data) {
    next.context_data = {};
  }
  if (patch.last_user_input !== undefined) {
    next.last_user_input = patch.last_user_input === null || patch.last_user_input === undefined ? '' : `${patch.last_user_input}`;
  }
  if (patch.reset_last_user_input) {
    next.last_user_input = '';
  }
  return next;
}

async function initWorkingMemory(sessionId, nodeId) {
  const sessionRecord = await fetchSessionRecord(sessionId);
  if (!sessionRecord) {
    throw new Error('Session not found for working memory initialisation');
  }
  const projectId = normaliseId(sessionRecord.project_id || config.defaults.projectId);
  const targetNodeId = nodeId || sessionRecord.active_node || null;
  const safeNodeId = targetNodeId === null || targetNodeId === undefined || targetNodeId === '' ? null : normaliseId(targetNodeId);

  const [structureIndex, currentNode, recentMessages, summary] = await Promise.all([
    fetchStructureIndex(projectId),
    fetchCurrentNode(projectId, safeNodeId),
    fetchRecentMessages(sessionRecord.id, safeNodeId),
    fetchLatestSummary(sessionRecord.id),
  ]);

  clearWorkingMemory(sessionRecord.id, safeNodeId);

  const now = new Date().toISOString();
  const memory = {
    session_id: normaliseId(sessionRecord.id),
    node_id: safeNodeId,
    project_id: projectId,
    structure_index: structureIndex,
    current_node: currentNode,
    recent_messages: recentMessages,
    work_history_summary: summary,
    context_data: {},
    last_user_input: '',
    created_at: now,
    updated_at: now,
  };

  registerMemory(memory);
  return normaliseMemory(memory);
}

function getWorkingMemory(sessionId, nodeId) {
  try {
    const key = buildKey(sessionId, nodeId);
    return normaliseMemory(memoryStore.get(key));
  } catch (error) {
    return null;
  }
}

function updateWorkingMemory(sessionId, nodeId, updates) {
  let key;
  try {
    key = buildKey(sessionId, nodeId);
  } catch (error) {
    return null;
  }
  const existing = memoryStore.get(key);
  if (!existing) {
    return null;
  }
  const patch = typeof updates === 'function' ? updates(normaliseMemory(existing)) || {} : updates || {};
  if (!patch || typeof patch !== 'object') {
    const refreshed = { ...existing, updated_at: new Date().toISOString() };
    memoryStore.set(key, refreshed);
    return normaliseMemory(refreshed);
  }
  const next = mergePatch(existing, patch);
  memoryStore.set(key, next);
  return normaliseMemory(next);
}

function updateWorkingMemoryForNode(nodeId, updates) {
  const keys = getKeysForNode(nodeId);
  let count = 0;
  for (const key of keys) {
    const existing = memoryStore.get(key);
    if (!existing) continue;
    updateWorkingMemory(existing.session_id, existing.node_id, updates);
    count += 1;
  }
  return count;
}

function updateWorkingMemoryForSession(sessionId, updates) {
  const keys = getKeysForSession(sessionId);
  let count = 0;
  for (const key of keys) {
    const existing = memoryStore.get(key);
    if (!existing) continue;
    updateWorkingMemory(existing.session_id, existing.node_id, updates);
    count += 1;
  }
  return count;
}

async function refreshStructureIndexForProject(projectId) {
  const keys = getKeysForProject(projectId);
  if (!keys.length) {
    return null;
  }
  const structureIndex = await fetchStructureIndex(projectId);
  for (const key of keys) {
    const memory = memoryStore.get(key);
    if (!memory) continue;
    updateWorkingMemory(memory.session_id, memory.node_id, { structure_index: structureIndex });
  }
  return structureIndex;
}

function appendMessageToWorkingMemory(sessionId, nodeId, message) {
  const normalised = normaliseMessage(message);
  if (!normalised) return null;
  return updateWorkingMemory(sessionId, nodeId, (memory) => {
    const combined = Array.isArray(memory.recent_messages) ? [...memory.recent_messages] : [];
    combined.push(normalised);
    const limited = combined.length > RECENT_MESSAGES_LIMIT
      ? combined.slice(combined.length - RECENT_MESSAGES_LIMIT)
      : combined;
    const patch = { recent_messages: limited };
    if (normalised.role === 'user') {
      patch.last_user_input = normalised.content || '';
    }
    return patch;
  });
}

function appendMessageToSessionMemories(sessionId, message) {
  const normalised = normaliseMessage(message);
  if (!normalised) return 0;
  const keys = getKeysForSession(sessionId);
  let count = 0;
  for (const key of keys) {
    const memory = memoryStore.get(key);
    if (!memory) continue;
    appendMessageToWorkingMemory(memory.session_id, memory.node_id, normalised);
    count += 1;
  }
  return count;
}

function clearWorkingMemory(sessionId, nodeId) {
  if (!sessionId && !nodeId) {
    memoryStore.clear();
    sessionIndex.clear();
    nodeIndex.clear();
    projectIndex.clear();
    return;
  }
  if (sessionId && nodeId !== undefined) {
    const key = buildKey(sessionId, nodeId);
    removeMemoryByKey(key);
    return;
  }
  if (sessionId && (nodeId === undefined || nodeId === null || nodeId === '')) {
    const keys = getKeysForSession(sessionId);
    for (const key of keys) {
      removeMemoryByKey(key);
    }
    return;
  }
  if (!sessionId && nodeId) {
    const keys = getKeysForNode(nodeId);
    for (const key of keys) {
      removeMemoryByKey(key);
    }
  }
}

function clearWorkingMemoryByNode(nodeId) {
  clearWorkingMemory(null, nodeId);
}

function clearWorkingMemoryByProject(projectId) {
  const keys = getKeysForProject(projectId);
  for (const key of keys) {
    removeMemoryByKey(key);
  }
}

function serialiseWorkingMemory(sessionId, nodeId) {
  const memory = getWorkingMemory(sessionId, nodeId);
  if (!memory) return null;
  return JSON.stringify(memory, null, 2);
}

module.exports = {
  initWorkingMemory,
  getWorkingMemory,
  updateWorkingMemory,
  clearWorkingMemory,
  clearWorkingMemoryByNode,
  clearWorkingMemoryByProject,
  updateWorkingMemoryForNode,
  updateWorkingMemoryForSession,
  refreshStructureIndexForProject,
  appendMessageToWorkingMemory,
  appendMessageToSessionMemories,
  serialiseWorkingMemory,
};
