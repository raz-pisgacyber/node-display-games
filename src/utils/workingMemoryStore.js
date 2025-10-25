const config = require('../config');
const { pool } = require('../db/mysql');
const { queryWithLogging, executeWithLogging } = require('./mysqlLogger');
const {
  WORKING_MEMORY_PARTS,
  buildDefaultMemory,
  sanitiseWorkingMemoryPart,
  composeWorkingMemory,
} = require('./workingMemorySchema');

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
      parts[name] = row.payload;
      if (!resolvedProjectId && row.project_id) {
        resolvedProjectId = row.project_id;
      }
    });
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
    const memory = composeWorkingMemory(parts);
    return { memory, parts };
  } finally {
    if (!connection) {
      ownConnection.release();
    }
  }
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
    const sanitised = sanitiseWorkingMemoryPart(name, value, options);

    await executeWithLogging(
      existingConnection,
      `INSERT INTO working_memory_parts (session_id, project_id, part, payload)
       VALUES (?, ?, ?, CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE project_id = VALUES(project_id), payload = VALUES(payload), updated_at = CURRENT_TIMESTAMP`,
      [sessionId, targetProjectId, name, JSON.stringify(sanitised)]
    );
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
