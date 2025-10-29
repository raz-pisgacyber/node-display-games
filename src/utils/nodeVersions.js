const metaHash = require('./metaHash');
const { executeWithLogging } = require('./mysqlLogger');

function normalizeMySQLDate(isoString) {
  if (!isoString) return null;
  return isoString
    .replace('T', ' ')
    .replace('Z', '')
    .replace(/(\.\d{6})\d+$/, '$1'); // keep microseconds ≤6 digits
}

async function upsertNodeVersion(connection, node) {
  const hash = metaHash(node.meta || {});
  const cleanDate = normalizeMySQLDate(node.last_modified);

  const sql = `
    INSERT INTO node_versions (project_id, node_id, version_id, last_modified, meta_hash)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      version_id = VALUES(version_id),
      last_modified = VALUES(last_modified),
      meta_hash = VALUES(meta_hash),
      project_id = VALUES(project_id)
  `;
  await executeWithLogging(connection, sql, [
    node.project_id,
    node.id,
    node.version_id,
    cleanDate,
    hash
  ]);
}

async function deleteNodeVersion(connection, nodeId, projectId) {
  const sql = projectId
    ? 'DELETE FROM node_versions WHERE project_id = ? AND node_id = ?'
    : 'DELETE FROM node_versions WHERE node_id = ?';
  const params = projectId ? [projectId, nodeId] : [nodeId];
  await executeWithLogging(connection, sql, params);
}

module.exports = {
  upsertNodeVersion,
  deleteNodeVersion,
};
