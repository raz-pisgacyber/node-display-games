const config = require('../config');
const { pool } = require('../db/mysql');
const { queryWithLogging, executeWithLogging } = require('./mysqlLogger');
const { saveNodeWorkingHistory } = require('./mysqlQueries');
const {
  WORKING_MEMORY_PARTS,
  DERIVED_WORKING_MEMORY_PARTS,
  buildDefaultMemory,
  sanitiseWorkingMemoryPart,
  composeWorkingMemory,
} = require('./workingMemorySchema');

// Ensure the working-memory parts registry recognises the split graph payloads.
if (!WORKING_MEMORY_PARTS.has('project_graph')) {
  WORKING_MEMORY_PARTS.add('project_graph');
}
if (!WORKING_MEMORY_PARTS.has('elements_graph')) {
  WORKING_MEMORY_PARTS.add('elements_graph');
}

function normalisePartName(part) {
  if (typeof part !== 'string') {
    return '';
  }
  const trimmed = part.trim().toLowerCase();
  if (trimmed === 'last_message') {
    return 'last_user_message';
  }
  return trimmed;
}

function parseJsonPayload(payload) {
  if (payload === null || payload === undefined) {
    return null;
  }
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch (error) {
      return null;
    }
  }
  if (Buffer.isBuffer(payload)) {
    try {
      return JSON.parse(payload.toString('utf8'));
    } catch (error) {
      return null;
    }
  }
  if (typeof payload === 'object') {
    return payload;
  }
  return null;
}

function normaliseIdentifier(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return `${value}`.trim();
}

function deriveWorkingMemoryScope({ sessionId, projectId, nodeId }) {
  const trimmedSessionId = normaliseIdentifier(sessionId);
  const trimmedProjectId = normaliseIdentifier(projectId) || config.defaults.projectId;
  const trimmedNodeId = normaliseIdentifier(nodeId);

  if (trimmedSessionId) {
    return {
      type: 'session',
      sessionId: trimmedSessionId,
      projectId: trimmedProjectId,
      nodeId: trimmedNodeId,
      selectClause: {
        sql: 'session_id = ?',
        params: [trimmedSessionId],
      },
    };
  }

  if (!trimmedProjectId) {
    throw new Error('projectId is required when sessionId is missing');
  }
  if (!trimmedNodeId) {
    throw new Error('nodeId is required when sessionId is missing');
  }

  return {
    type: 'projectNode',
    sessionId: '',
    projectId: trimmedProjectId,
    nodeId: trimmedNodeId,
    selectClause: {
      sql: 'session_id = ? AND project_id = ? AND node_id = ?',
      params: ['', trimmedProjectId, trimmedNodeId],
    },
  };
}

async function loadWorkingMemory({ sessionId, projectId, nodeId, connection } = {}) {
  const trimmedSessionId = normaliseIdentifier(sessionId);
  const trimmedProjectId = normaliseIdentifier(projectId);
  const trimmedNodeId = normaliseIdentifier(nodeId);

  let scope;
  try {
    scope = deriveWorkingMemoryScope({
      sessionId: trimmedSessionId,
      projectId: trimmedProjectId,
      nodeId: trimmedNodeId,
    });
  } catch (error) {
    if (!trimmedSessionId) {
      return { memory: buildDefaultMemory(), parts: {} };
    }
    throw error;
  }
  const ownConnection = connection || (await pool.getConnection());
  try {
    const [rows] = await queryWithLogging(
      ownConnection,
      `SELECT part, payload, project_id, node_id FROM working_memory_parts WHERE ${scope.selectClause.sql}`,
      scope.selectClause.params
    );
    const parts = {};
    let resolvedProjectId = scope.projectId || '';
    rows.forEach((row) => {
      const name = normalisePartName(row.part);
      if (!WORKING_MEMORY_PARTS.has(name)) {
        return;
      }
      parts[name] = parseJsonPayload(row.payload);
      if (!resolvedProjectId && row.project_id) {
        resolvedProjectId = row.project_id;
      }
    });

    if (!resolvedProjectId) {
      resolvedProjectId = scope.projectId;
    }

    if (parts.project_graph || parts.elements_graph) {
      const mergedStructure = sanitiseWorkingMemoryPart('project_structure', {
        ...(parts.project_structure || {}),
        project_graph: parts.project_graph,
        elements_graph: parts.elements_graph,
      });
      parts.project_structure = mergedStructure;
    }

    if (resolvedProjectId) {
      parts.session = {
        ...(parts.session || {}),
        project_id: resolvedProjectId,
      };
    }
    if (scope.type === 'projectNode' && scope.nodeId) {
      parts.session = {
        ...(parts.session || {}),
        active_node_id: scope.nodeId,
      };
    }
    parts.session = {
      ...(parts.session || {}),
      session_id: scope.sessionId,
    };
    const memory = composeWorkingMemory(parts, parts);
    return { memory, parts };
  } finally {
    if (!connection) {
      ownConnection.release();
    }
  }
}

async function persistPart({ connection, sessionId, projectId, nodeId, name, value }) {
  const serialisable = value === undefined ? null : value;
  await executeWithLogging(
    connection,
    `INSERT INTO working_memory_parts (session_id, project_id, node_id, part, payload)
     VALUES (?, ?, ?, ?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE project_id = VALUES(project_id), node_id = VALUES(node_id), payload = VALUES(payload), updated_at = CURRENT_TIMESTAMP`,
    [sessionId, projectId, nodeId || '', name, JSON.stringify(serialisable)]
  );
}

async function saveWorkingMemoryPart({
  sessionId,
  projectId,
  nodeId,
  part,
  value,
  connection,
  options = {},
} = {}) {
  const name = normalisePartName(part);
  if (!WORKING_MEMORY_PARTS.has(name)) {
    throw new Error('Invalid working memory part');
  }

  const trimmedSessionId = normaliseIdentifier(sessionId);
  const trimmedProjectId = normaliseIdentifier(projectId);
  const nodeCandidates = [
    nodeId,
    options.nodeId,
    options.node_id,
    options.node,
    options.activeNodeId,
    options.active_node_id,
  ];
  let resolvedNodeId = '';
  for (const candidate of nodeCandidates) {
    const normalised = normaliseIdentifier(candidate);
    if (normalised) {
      resolvedNodeId = normalised;
      break;
    }
  }

  let scope;
  try {
    scope = deriveWorkingMemoryScope({
      sessionId: trimmedSessionId,
      projectId: trimmedProjectId,
      nodeId: resolvedNodeId,
    });
  } catch (error) {
    throw new Error(error?.message || 'projectId and nodeId are required when sessionId is missing');
  }

  const scopeNodeId = scope.type === 'projectNode' ? scope.nodeId : resolvedNodeId;
  const targetProjectId = scope.projectId;

  const existingConnection = connection || (await pool.getConnection());
  try {
    if (DERIVED_WORKING_MEMORY_PARTS.has(name)) {
      const sanitisedStructure = sanitiseWorkingMemoryPart('project_structure', value);
      await persistPart({
        connection: existingConnection,
        sessionId: scope.sessionId,
        projectId: targetProjectId,
        nodeId: scopeNodeId,
        name: 'project_graph',
        value: sanitisedStructure.project_graph,
      });
      await persistPart({
        connection: existingConnection,
        sessionId: scope.sessionId,
        projectId: targetProjectId,
        nodeId: scopeNodeId,
        name: 'elements_graph',
        value: sanitisedStructure.elements_graph,
      });
      await persistPart({
        connection: existingConnection,
        sessionId: scope.sessionId,
        projectId: targetProjectId,
        nodeId: scopeNodeId,
        name: 'project_structure',
        value: sanitisedStructure,
      });
      return { part: name, value: sanitisedStructure };
    }

    const sanitised = sanitiseWorkingMemoryPart(name, value, options);
    await persistPart({
      connection: existingConnection,
      sessionId: scope.sessionId,
      projectId: targetProjectId,
      nodeId: scopeNodeId,
      name,
      value: sanitised,
    });
    if (name === 'working_history' && targetProjectId && scopeNodeId) {
      await saveNodeWorkingHistory(existingConnection, {
        projectId: targetProjectId,
        nodeId: scopeNodeId,
        workingHistory: sanitised,
      });
    }
    return { part: name, value: sanitised };
  } finally {
    if (!connection) {
      existingConnection.release();
    }
  }
}

module.exports = {
  WORKING_MEMORY_PARTS,
  loadWorkingMemory,
  saveWorkingMemoryPart,
};
