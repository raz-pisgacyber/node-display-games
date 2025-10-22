const metaHash = require('./metaHash');

async function upsertNodeVersion(connection, node) {
  const hash = metaHash(node.meta || {});
  const sql = `
    INSERT INTO node_versions (project_id, node_id, version_id, last_modified, meta_hash)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      version_id = VALUES(version_id),
      last_modified = VALUES(last_modified),
      meta_hash = VALUES(meta_hash),
      project_id = VALUES(project_id)
  `;
  await connection.execute(sql, [node.project_id, node.id, node.version_id, node.last_modified, hash]);
}

async function deleteNodeVersion(connection, nodeId, projectId) {
  const sql = projectId
    ? 'DELETE FROM node_versions WHERE project_id = ? AND node_id = ?'
    : 'DELETE FROM node_versions WHERE node_id = ?';
  const params = projectId ? [projectId, nodeId] : [nodeId];
  await connection.execute(sql, params);
}

module.exports = {
  upsertNodeVersion,
  deleteNodeVersion,
};
