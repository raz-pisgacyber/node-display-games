const metaHash = require('./metaHash');

async function upsertNodeVersion(connection, node) {
  const hash = metaHash(node.meta || {});
  const sql = `
    INSERT INTO node_versions (node_id, version_id, last_modified, meta_hash)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      version_id = VALUES(version_id),
      last_modified = VALUES(last_modified),
      meta_hash = VALUES(meta_hash)
  `;
  await connection.execute(sql, [node.id, node.version_id, node.last_modified, hash]);
}

async function deleteNodeVersion(connection, nodeId) {
  await connection.execute('DELETE FROM node_versions WHERE node_id = ?', [nodeId]);
}

module.exports = {
  upsertNodeVersion,
  deleteNodeVersion,
};
