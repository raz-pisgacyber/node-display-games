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
    const clauses = [];
    const params = [];
    clauses.push(`(${scope.selectClause.sql})`);
    params.push(...scope.selectClause.params);

    let fallbackNodeId = '';
    if (scope.type === 'session' && scope.projectId) {
      const fallbackProjectId = scope.projectId;
      const targetNodeId = scope.nodeId || trimmedNodeId || '';
      clauses.push('(session_id = ? AND project_id = ? AND node_id = ?)');
      params.push('', fallbackProjectId, targetNodeId);
      fallbackNodeId = targetNodeId;
    }

    const whereClause = clauses.join(' OR ');
    const [rows] = await queryWithLogging(
      ownConnection,
      `SELECT session_id, part, payload, project_id, node_id FROM working_memory_parts WHERE ${whereClause}`,
      params
    );
    const fallbackParts = {};
    const primaryParts = {};
    let primaryProjectId = '';
    let primaryNodeId = '';
    let secondaryProjectId = '';
    let secondaryNodeId = fallbackNodeId;
    rows.forEach((row) => {
      const name = normalisePartName(row.part);
      if (!WORKING_MEMORY_PARTS.has(name)) {
        return;
      }
      const payload = parseJsonPayload(row.payload);
      const rowSessionId = normaliseIdentifier(row.session_id);
      if (rowSessionId && rowSessionId === scope.sessionId) {
        primaryParts[name] = payload;
        if (!primaryProjectId && row.project_id) {
          primaryProjectId = row.project_id;
        }
        if (!primaryNodeId && row.node_id) {
          primaryNodeId = row.node_id;
        }
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(fallbackParts, name)) {
        fallbackParts[name] = payload;
      }
      if (!secondaryProjectId && row.project_id) {
        secondaryProjectId = row.project_id;
      }
      if (!secondaryNodeId && row.node_id) {
        secondaryNodeId = row.node_id;
      }
    });

    const resolvedParts = { ...fallbackParts, ...primaryParts };
    let resolvedProjectId = primaryProjectId || secondaryProjectId || scope.projectId || '';
    let resolvedNodeId = primaryNodeId || secondaryNodeId || scope.nodeId || '';

    if (resolvedParts.project_graph || resolvedParts.elements_graph) {
      const mergedStructure = sanitiseWorkingMemoryPart('project_structure', {
        ...(resolvedParts.project_structure || {}),
        project_graph: resolvedParts.project_graph,
        elements_graph: resolvedParts.elements_graph,
      });
      resolvedParts.project_structure = mergedStructure;
    }

    if (resolvedProjectId) {
      resolvedParts.session = {
        ...(resolvedParts.session || {}),
        project_id: resolvedProjectId,
      };
    }
    if (scope.type === 'projectNode' && scope.nodeId) {
      resolvedParts.session = {
        ...(resolvedParts.session || {}),
        active_node_id: scope.nodeId,
      };
    } else if (resolvedNodeId) {
      resolvedParts.session = {
        ...(resolvedParts.session || {}),
        active_node_id:
          resolvedParts.session && resolvedParts.session.active_node_id
            ? resolvedParts.session.active_node_id
            : resolvedNodeId,
      };
    }
    resolvedParts.session = {
      ...(resolvedParts.session || {}),
      session_id: scope.sessionId,
    };
    const memory = composeWorkingMemory(resolvedParts, resolvedParts);
    return { memory, parts: resolvedParts };
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

async function deleteFallbackParts(connection, { projectId, nodeId, parts }) {
  const trimmedProjectId = normaliseIdentifier(projectId);
  const trimmedNodeId = normaliseIdentifier(nodeId);
  if (!trimmedProjectId || !Array.isArray(parts) || parts.length === 0) {
    return;
  }
  const uniqueParts = Array.from(new Set(parts.filter((part) => typeof part === 'string' && part.trim())));
  if (uniqueParts.length === 0) {
    return;
  }
  const placeholders = uniqueParts.map(() => '?').join(', ');
  await executeWithLogging(
    connection,
    `DELETE FROM working_memory_parts
     WHERE session_id = '' AND project_id = ? AND node_id = ? AND part IN (${placeholders})`,
    [trimmedProjectId, trimmedNodeId, ...uniqueParts]
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
      if (scope.type === 'session') {
        await deleteFallbackParts(existingConnection, {
          projectId: targetProjectId,
          nodeId: scopeNodeId,
          parts: ['project_graph', 'elements_graph', 'project_structure'],
        });
      }
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
    if (scope.type === 'session') {
      await deleteFallbackParts(existingConnection, {
        projectId: targetProjectId,
        nodeId: scopeNodeId,
        parts: [name],
      });
    }
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
