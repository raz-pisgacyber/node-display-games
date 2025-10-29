const { executeWithLogging } = require('./mysqlLogger');

function buildMessageFilters({ sessionId, projectId, nodeId, cursor, direction = 'ASC' } = {}) {
  const filters = [];
  const params = [];
  let joinSessions = false;

  if (sessionId) {
    filters.push('m.session_id = ?');
    params.push(sessionId);
  } else if (projectId) {
    joinSessions = true;
    filters.push('s.project_id = ?');
    params.push(projectId);
  }
  if (nodeId) {
    filters.push('m.node_id = ?');
    params.push(nodeId);
  }
  if (cursor !== null && cursor !== undefined) {
    const numericCursor = Number(cursor);
    if (!Number.isNaN(numericCursor)) {
      if (direction === 'DESC') {
        filters.push('m.id < ?');
      } else {
        filters.push('m.id > ?');
      }
      params.push(numericCursor);
    }
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return { whereClause, params, joinSessions };
}

async function fetchMessagesPage(connection, {
  sessionId,
  projectId,
  nodeId,
  limit,
  cursor,
  direction = 'ASC',
  includeExtraRow = false,
} = {}) {
  const safeLimit = Number.isInteger(limit) ? Math.max(limit, 1) : Math.max(Number.parseInt(limit, 10) || 1, 1);
  const pageSize = includeExtraRow ? safeLimit + 1 : safeLimit;
  const order = direction === 'DESC' ? 'DESC' : 'ASC';

  const { whereClause, params, joinSessions } = buildMessageFilters({
    sessionId,
    projectId,
    nodeId,
    cursor,
    direction,
  });
  const fromClause = joinSessions
    ? 'FROM messages m INNER JOIN sessions s ON m.session_id = s.id'
    : 'FROM messages m';
  const sql = `
    SELECT m.id, m.session_id, m.node_id, m.role, m.content, m.message_type, m.created_at
    ${fromClause}
    ${whereClause}
    ORDER BY m.id ${order}
    LIMIT ${pageSize}
  `;

  const [rows] = await executeWithLogging(connection, sql, params);
  const hasMore = includeExtraRow && rows.length > safeLimit;
  const messages = hasMore ? rows.slice(0, safeLimit) : rows;

  return { sql, params, messages, hasMore };
}

async function countMessagesForScope(connection, { sessionId, projectId, nodeId } = {}) {
  const { whereClause, params, joinSessions } = buildMessageFilters({ sessionId, projectId, nodeId });
  const fromClause = joinSessions
    ? 'FROM messages m INNER JOIN sessions s ON m.session_id = s.id'
    : 'FROM messages m';
  const sql = `SELECT COUNT(*) AS total_count ${fromClause} ${whereClause}`;
  const [rows] = await executeWithLogging(connection, sql, params);
  return Number(rows?.[0]?.total_count || 0);
}

async function fetchLastUserMessageForScope(connection, { sessionId, projectId, nodeId } = {}) {
  const { whereClause, params, joinSessions } = buildMessageFilters({ sessionId, projectId, nodeId });
  const fromClause = joinSessions
    ? 'FROM messages m INNER JOIN sessions s ON m.session_id = s.id'
    : 'FROM messages m';
  const sql = `
    SELECT m.content
    ${fromClause}
    ${whereClause ? `${whereClause} AND` : 'WHERE'} m.role = ?
    ORDER BY m.id DESC
    LIMIT 1
  `;
  const finalParams = [...params, 'user'];
  const [rows] = await executeWithLogging(connection, sql, finalParams);
  return rows?.[0]?.content || '';
}

async function fetchMessagesForHistory(connection, { sessionId, projectId, nodeId, limit } = {}) {
  const { messages } = await fetchMessagesPage(connection, {
    sessionId,
    projectId,
    nodeId,
    limit,
    direction: 'DESC',
    includeExtraRow: false,
  });
  return messages.slice().reverse();
}

async function fetchWorkingHistoryForNode(connection, { projectId, nodeId } = {}) {
  if (!projectId || !nodeId) {
    return null;
  }
  const sql = `
    SELECT project_id, node_id, working_history, updated_at
    FROM node_working_history
    WHERE project_id = ? AND node_id = ?
    LIMIT 1
  `;
  const [rows] = await executeWithLogging(connection, sql, [projectId, nodeId]);
  return rows && rows.length ? rows[0] : null;
}

async function saveNodeWorkingHistory(connection, { projectId, nodeId, workingHistory } = {}) {
  if (!connection) {
    throw new Error('connection is required');
  }
  const trimmedProjectId = projectId ? `${projectId}`.trim() : '';
  const trimmedNodeId = nodeId ? `${nodeId}`.trim() : '';
  if (!trimmedProjectId) {
    throw new Error('projectId is required');
  }
  if (!trimmedNodeId) {
    throw new Error('nodeId is required');
  }
  let workingHistoryText = '';
  if (workingHistory !== undefined && workingHistory !== null) {
    if (typeof workingHistory === 'string') {
      workingHistoryText = workingHistory;
    } else {
      try {
        workingHistoryText = JSON.stringify(workingHistory);
      } catch (error) {
        workingHistoryText = '';
      }
    }
  }
  await executeWithLogging(
    connection,
    `INSERT INTO node_working_history (project_id, node_id, working_history)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE working_history = VALUES(working_history), updated_at = CURRENT_TIMESTAMP`,
    [trimmedProjectId, trimmedNodeId, workingHistoryText]
  );
  return {
    projectId: trimmedProjectId,
    nodeId: trimmedNodeId,
    workingHistory: workingHistoryText,
  };
}

function parseSummaryPayload(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }
  if (typeof value === 'object') {
    return value;
  }
  return null;
}

async function fetchLatestSummaryText(connection, { sessionId, nodeId } = {}) {
  if (!sessionId) {
    return '';
  }

  let summaryRow = null;
  if (nodeId) {
    const sqlWithNode = `
      SELECT summary_json
      FROM summaries
      WHERE session_id = ?
        AND JSON_CONTAINS(summary_json, JSON_QUOTE(?), '$.nodes')
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const [rowsWithNode] = await executeWithLogging(connection, sqlWithNode, [sessionId, nodeId]);
    if (Array.isArray(rowsWithNode) && rowsWithNode.length) {
      summaryRow = rowsWithNode[0];
    }
  }

  if (!summaryRow) {
    const sql = `
      SELECT summary_json
      FROM summaries
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const [rows] = await executeWithLogging(connection, sql, [sessionId]);
    if (Array.isArray(rows) && rows.length) {
      summaryRow = rows[0];
    }
  }

  if (!summaryRow) {
    return '';
  }
  const payload = parseSummaryPayload(summaryRow.summary_json);
  if (!payload) {
    return '';
  }
  if (typeof payload.text === 'string') {
    return payload.text;
  }
  return '';
}

async function fetchSessionById(connection, sessionId) {
  if (!sessionId) {
    return null;
  }
  const sql = `
    SELECT id, project_id, active_node
    FROM sessions
    WHERE id = ?
    LIMIT 1
  `;
  const [rows] = await executeWithLogging(connection, sql, [sessionId]);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

module.exports = {
  buildMessageFilters,
  fetchMessagesPage,
  countMessagesForScope,
  fetchLastUserMessageForScope,
  fetchMessagesForHistory,
  fetchWorkingHistoryForNode,
  saveNodeWorkingHistory,
  fetchLatestSummaryText,
  fetchSessionById,
};
