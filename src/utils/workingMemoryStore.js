const config = require('../config');
const { pool } = require('../db/mysql');
const { queryWithLogging, executeWithLogging } = require('./mysqlLogger');
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

async function loadWorkingMemory({ sessionId, projectId, connection } = {}) {
  if (!sessionId) {
    return { memory: buildDefaultMemory(), parts: {} };
  }
  const ownConnection = connection || (await pool.getConnection());
  try {
    const [rows] = await queryWithLogging(
      ownConnection,
      'SELECT part, payload, project_id FROM working_memory_parts WHERE session_id = ?',
      [sessionId]
    );
    const parts = {};
    let resolvedProjectId = projectId || '';
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
    parts.session = {
      ...(parts.session || {}),
      session_id: sessionId,
    };
    const memory = composeWorkingMemory(parts, parts);
    return { memory, parts };
  } finally {
    if (!connection) {
      ownConnection.release();
    }
  }
}

async function persistPart({ connection, sessionId, projectId, name, value }) {
  await executeWithLogging(
    connection,
    `INSERT INTO working_memory_parts (session_id, project_id, part, payload)
     VALUES (?, ?, ?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE project_id = VALUES(project_id), payload = VALUES(payload), updated_at = CURRENT_TIMESTAMP`,
    [sessionId, projectId, name, JSON.stringify(value)]
  );
}

async function saveWorkingMemoryPart({
  sessionId,
  projectId,
  part,
  value,
  connection,
  options = {},
} = {}) {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  const name = normalisePartName(part);
  if (!WORKING_MEMORY_PARTS.has(name)) {
    throw new Error('Invalid working memory part');
  }
  const targetProjectId = projectId || config.defaults.projectId;

  const existingConnection = connection || (await pool.getConnection());
  try {
    if (DERIVED_WORKING_MEMORY_PARTS.has(name)) {
      const sanitisedStructure = sanitiseWorkingMemoryPart('project_structure', value);
      await persistPart({
        connection: existingConnection,
        sessionId,
        projectId: targetProjectId,
        name: 'project_graph',
        value: sanitisedStructure.project_graph,
      });
      await persistPart({
        connection: existingConnection,
        sessionId,
        projectId: targetProjectId,
        name: 'elements_graph',
        value: sanitisedStructure.elements_graph,
      });
      await persistPart({
        connection: existingConnection,
        sessionId,
        projectId: targetProjectId,
        name: 'project_structure',
        value: sanitisedStructure,
      });
      return { part: name, value: sanitisedStructure };
    }

    const sanitised = sanitiseWorkingMemoryPart(name, value, options);
    await persistPart({
      connection: existingConnection,
      sessionId,
      projectId: targetProjectId,
      name,
      value: sanitised,
    });
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
