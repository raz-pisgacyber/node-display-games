const express = require('express');
const neo4j = require('neo4j-driver');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const config = require('../config');
const { driver } = require('../db/neo4j');
const { pool } = require('../db/mysql');
const { extractNode, newVersionMeta, validateRelationshipType } = require('../utils/neo4jHelpers');
const { upsertNodeVersion, deleteNodeVersion } = require('../utils/nodeVersions');

const router = express.Router();

function ensureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

router.get('/config', (req, res) => {
  res.json({
    default_project_id: config.defaults.projectId,
    version_poll_interval_ms: config.defaults.versionPollIntervalMs,
  });
});

router.get('/graph', async (req, res, next) => {
  const projectId = (req.query?.project_id || config.defaults.projectId).toString();
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
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
    const nodes = (record?.get('nodes') || []).map((node) => {
      const extracted = extractNode(node);
      if (!extracted.project_id) {
        extracted.project_id = projectId;
      }
      return extracted;
    });
    const edges = (record?.get('edges') || [])
      .filter((edge) => edge && edge.from && edge.to)
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        type: edge.type || 'LINKS_TO',
        props: edge.props || {},
        project_id: projectId,
      }));
    res.json({ nodes, edges });
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.post('/node', async (req, res, next) => {
  const {
    id,
    label,
    content = '',
    meta = {},
    project_id: projectIdInput,
  } = req.body || {};
  if (!label) {
    res.status(400).json({ error: 'label is required' });
    return;
  }
  const nodeId = id || uuidv4();
  const metaData = ensureObject(meta);
  const { versionId, lastModified } = newVersionMeta();
  const projectId = (projectIdInput || config.defaults.projectId).toString();
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `CREATE (n:ProjectNode {id: $id, project_id: $projectId, label: $label, content: $content, meta: $meta, version_id: $versionId, last_modified: datetime($lastModified)})
         RETURN n`,
        { id: nodeId, projectId, label, content, meta: metaData, versionId, lastModified }
      )
    );
    const node = extractNode(result.records[0].get('n'));
    const connection = await pool.getConnection();
    try {
      await upsertNodeVersion(connection, { ...node, project_id: projectId });
    } finally {
      connection.release();
    }
    res.status(201).json(node);
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.patch('/node/:id', async (req, res, next) => {
  const { id } = req.params;
  const { label, content, meta: metaReplace, metaUpdates, project_id: projectIdInput } = req.body || {};
  const coreUpdates = {};
  if (label !== undefined) coreUpdates.label = label;
  if (content !== undefined) coreUpdates.content = content;

  const hasCore = Object.keys(coreUpdates).length > 0;
  const hasMetaReplace = metaReplace !== undefined;
  const metaUpdateObject = ensureObject(metaUpdates);
  const hasMetaUpdates = !hasMetaReplace && Object.keys(metaUpdateObject).length > 0;

  const projectId = (projectIdInput || req.query?.project_id || config.defaults.projectId).toString();

  if (!hasCore && !hasMetaReplace && !hasMetaUpdates) {
    res.status(400).json({ error: 'No updates provided' });
    return;
  }

  const { versionId, lastModified } = newVersionMeta();
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    const parts = ['MATCH (n:ProjectNode {id: $id})', 'WHERE coalesce(n.project_id, $projectId) = $projectId', 'SET n.project_id = $projectId'];
    if (hasCore) {
      parts.push('SET n += $core');
    }
    if (hasMetaReplace) {
      parts.push('SET n.meta = $metaReplace');
    } else if (hasMetaUpdates) {
      parts.push('SET n.meta = coalesce(n.meta, {}) + $metaUpdates');
    }
    parts.push('SET n.last_modified = datetime($lastModified), n.version_id = $versionId');
    parts.push('RETURN n');
    const query = parts.join('\n');
    const params = {
      id,
      lastModified,
      versionId,
      projectId,
    };
    if (hasCore) {
      params.core = coreUpdates;
    }
    if (hasMetaReplace) {
      params.metaReplace = ensureObject(metaReplace);
    }
    if (hasMetaUpdates) {
      params.metaUpdates = metaUpdateObject;
    }
    const result = await session.writeTransaction((tx) => tx.run(query, params));
    if (result.records.length === 0) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    const node = extractNode(result.records[0].get('n'));
    const connection = await pool.getConnection();
    try {
      await upsertNodeVersion(connection, { ...node, project_id: projectId });
    } finally {
      connection.release();
    }
    res.json(node);
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.delete('/node/:id', async (req, res, next) => {
  const { id } = req.params;
  const projectId = (req.body?.project_id || req.query?.project_id || config.defaults.projectId).toString();
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `MATCH (n:ProjectNode {id: $id})
         WHERE coalesce(n.project_id, $projectId) = $projectId
         WITH n
         DETACH DELETE n
         RETURN count(n) AS deleted`,
        {
          id,
          projectId,
        }
      )
    );
    const deleted = result.records[0].get('deleted');
    if (!deleted) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    const connection = await pool.getConnection();
    try {
      await deleteNodeVersion(connection, id, projectId);
    } finally {
      connection.release();
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.post('/edge', async (req, res, next) => {
  const { from, to, type, props = {}, project_id: projectIdInput } = req.body || {};
  if (!from || !to) {
    res.status(400).json({ error: 'from and to are required' });
    return;
  }
  const relationshipType = validateRelationshipType(type);
  const projectId = (projectIdInput || config.defaults.projectId).toString();
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `MATCH (a:ProjectNode {id: $from}), (b:ProjectNode {id: $to})
         WHERE coalesce(a.project_id, $projectId) = $projectId AND coalesce(b.project_id, $projectId) = $projectId
         SET a.project_id = coalesce(a.project_id, $projectId)
         SET b.project_id = coalesce(b.project_id, $projectId)
         CREATE (a)-[r:${relationshipType}]->(b)
         SET r += $props
         RETURN {from: a.id, to: b.id, type: type(r), props: properties(r), project_id: $projectId} AS edge`,
        { from, to, props, projectId }
      )
    );
    if (result.records.length === 0) {
      res.status(404).json({ error: 'Nodes not found' });
      return;
    }
    res.status(201).json(result.records[0].get('edge'));
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.delete('/edge', async (req, res, next) => {
  const { from, to, type, project_id: projectIdInput } = req.body || {};
  if (!from || !to) {
    res.status(400).json({ error: 'from and to are required' });
    return;
  }
  const relationshipType = validateRelationshipType(type);
  const projectId = (projectIdInput || config.defaults.projectId).toString();
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `MATCH (a:ProjectNode {id: $from})-[r:${relationshipType}]->(b:ProjectNode {id: $to})
         WHERE coalesce(a.project_id, $projectId) = $projectId AND coalesce(b.project_id, $projectId) = $projectId
         WITH r
         DELETE r
         RETURN count(*) AS deleted`,
        { from, to, projectId }
      )
    );
    const deleted = result.records[0].get('deleted');
    if (!deleted) {
      res.status(404).json({ error: 'Edge not found' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.get('/versions/check', async (req, res, next) => {
  const { since } = req.query;
  const projectId = (req.query?.project_id || config.defaults.projectId).toString();
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const query = since
      ? `MATCH (n:ProjectNode)
         WHERE coalesce(n.project_id, $projectId) = $projectId AND n.last_modified > datetime($since)
         RETURN n.id AS node_id, n.version_id AS version_id, n.last_modified AS last_modified`
      : `MATCH (n:ProjectNode)
         WHERE coalesce(n.project_id, $projectId) = $projectId
         RETURN n.id AS node_id, n.version_id AS version_id, n.last_modified AS last_modified`;
    const params = since ? { since, projectId } : { projectId };
    const result = await session.run(query, params);
    const versions = result.records.map((record) => ({
      node_id: record.get('node_id'),
      version_id: record.get('version_id'),
      last_modified: record.get('last_modified')?.toString?.() || record.get('last_modified'),
    }));
    res.json({ versions });
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.post('/messages', async (req, res, next) => {
  const { session_id, node_id = null, role, content } = req.body || {};
  const allowedRoles = new Set(['user', 'reflector', 'planner', 'doer', 'tool_result']);
  if (!session_id || !role || !content) {
    res.status(400).json({ error: 'session_id, role and content are required' });
    return;
  }
  if (!allowedRoles.has(role)) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }
  try {
    const [result] = await pool.execute(
      `INSERT INTO messages (session_id, node_id, role, content) VALUES (?, ?, ?, ?)` ,
      [session_id, node_id, role, content]
    );
    res.status(201).json({ id: result.insertId, session_id, node_id, role, content });
  } catch (error) {
    next(error);
  }
});

router.get('/messages', async (req, res, next) => {
  const { session_id, node_id, limit = 50, before } = req.query;
  if (!session_id) {
    res.status(400).json({ error: 'session_id is required' });
    return;
  }
  const cappedLimit = Math.min(parseInt(limit, 10) || 50, 200);
  const params = [session_id];
  let sql = 'SELECT * FROM messages WHERE session_id = ?';
  if (node_id) {
    sql += ' AND (node_id = ? OR node_id IS NULL)';
    params.push(node_id);
  }
  if (before) {
    sql += ' AND created_at < ?';
    params.push(before);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(cappedLimit);
  try {
    const [rows] = await pool.execute(sql, params);
    res.json({ messages: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/summaries/rollup', async (req, res, next) => {
  const { session_id, nodes = [], text, last_n } = req.body || {};
  if (!session_id || !text) {
    res.status(400).json({ error: 'session_id and text are required' });
    return;
  }
  const summaryJson = JSON.stringify({ text, nodes, last_n: last_n ?? null });
  try {
    const [result] = await pool.execute(
      'INSERT INTO summaries (session_id, summary_json) VALUES (?, ?)',
      [session_id, summaryJson]
    );
    res.status(201).json({ id: result.insertId, session_id, summary_json: JSON.parse(summaryJson) });
  } catch (error) {
    next(error);
  }
});

router.get('/summaries', async (req, res, next) => {
  const { session_id, limit = 1 } = req.query;
  if (!session_id) {
    res.status(400).json({ error: 'session_id is required' });
    return;
  }
  const cappedLimit = Math.min(parseInt(limit, 10) || 1, 100);
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      [session_id, cappedLimit]
    );
    const summaries = rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      summary_json: typeof row.summary_json === 'string' ? JSON.parse(row.summary_json) : row.summary_json,
      created_at: row.created_at,
    }));
    res.json({ summaries });
  } catch (error) {
    next(error);
  }
});

router.post('/checkpoints', async (req, res, next) => {
  const { project_id: projectIdInput = config.defaults.projectId, name } = req.body || {};
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const projectId = projectIdInput.toString();
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      `MATCH (n:ProjectNode)
       WHERE coalesce(n.project_id, $projectId) = $projectId
       SET n.project_id = coalesce(n.project_id, $projectId)
       WITH n
       OPTIONAL MATCH (n)-[r]->(m:ProjectNode)
       WHERE coalesce(m.project_id, $projectId) = $projectId
       RETURN collect(DISTINCT n{.*, meta: n.meta}) AS nodes,
              collect(DISTINCT {from: n.id, to: m.id, type: type(r), props: properties(r)}) AS edges`,
      { projectId }
    );
    const record = result.records[0];
    const snapshot = {
      nodes: (record?.get('nodes') || []).map((node) => ({
        ...node,
        project_id: node.project_id || projectId,
        last_modified: node.last_modified?.toString?.() || node.last_modified,
      })),
      edges: (record?.get('edges') || []).filter((edge) => edge && edge.from && edge.to),
    };
    const json = JSON.stringify(snapshot);
    const checksum = crypto.createHash('sha1').update(json).digest('hex');
    const [insertResult] = await pool.execute(
      `INSERT INTO checkpoints (project_id, name, json_snapshot, checksum) VALUES (?, ?, ?, ?)` ,
      [projectId, name, json, checksum]
    );
    res.status(201).json({ id: insertResult.insertId, project_id: projectId, name, checksum });
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.get('/checkpoints', async (req, res, next) => {
  const projectId = (req.query?.project_id || config.defaults.projectId).toString();
  try {
    const [rows] = await pool.execute(
      'SELECT id, project_id, name, created_at, checksum FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC',
      [projectId]
    );
    res.json({ checkpoints: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/checkpoints/:id/restore', async (req, res, next) => {
  const { id } = req.params;
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute('SELECT * FROM checkpoints WHERE id = ?', [id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Checkpoint not found' });
      return;
    }
    const checkpoint = rows[0];
    const projectId = checkpoint.project_id;
    const snapshot = JSON.parse(checkpoint.json_snapshot);
    const nodes = snapshot.nodes || [];
    const edges = snapshot.edges || [];
    const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      await session.writeTransaction(async (tx) => {
        await tx.run(
          `MATCH (n:ProjectNode)
           WHERE coalesce(n.project_id, $projectId) = $projectId
           WITH n
           DETACH DELETE n`,
          { projectId }
        );
        for (const node of nodes) {
          if (node.project_id && node.project_id !== projectId) continue;
          const { versionId, lastModified } = newVersionMeta();
          const metaData = ensureObject(node.meta);
          await tx.run(
            `CREATE (n:ProjectNode {id: $id, project_id: $projectId, label: $label, content: $content, meta: $meta, version_id: $versionId, last_modified: datetime($lastModified)})`,
            {
              id: node.id,
              projectId,
              label: node.label || '',
              content: node.content || '',
              meta: metaData,
              versionId,
              lastModified,
            }
          );
          node.version_id = versionId;
          node.last_modified = lastModified;
          node.project_id = projectId;
        }
        for (const edge of edges) {
          if (!edge.from || !edge.to) continue;
          const relationshipType = validateRelationshipType(edge.type);
          await tx.run(
            `MATCH (a:ProjectNode {id: $from}), (b:ProjectNode {id: $to})
             WHERE coalesce(a.project_id, $projectId) = $projectId AND coalesce(b.project_id, $projectId) = $projectId
             SET a.project_id = coalesce(a.project_id, $projectId)
             SET b.project_id = coalesce(b.project_id, $projectId)
             CREATE (a)-[r:${relationshipType}]->(b)
             SET r += $props`,
            { from: edge.from, to: edge.to, props: ensureObject(edge.props), projectId }
          );
        }
      });
    } finally {
      await session.close();
    }

    await connection.beginTransaction();
    try {
      await connection.execute('DELETE FROM node_versions WHERE project_id = ?', [projectId]);
      for (const node of nodes) {
        if (node.project_id && node.project_id !== projectId) continue;
        await upsertNodeVersion(connection, {
          id: node.id,
          meta: ensureObject(node.meta),
          version_id: node.version_id,
          last_modified: node.last_modified,
          project_id: projectId,
        });
      }
      await connection.execute(
        `DELETE m FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.project_id = ?`,
        [projectId]
      );
      await connection.execute(
        `DELETE su FROM summaries su JOIN sessions s ON su.session_id = s.id WHERE s.project_id = ?`,
        [projectId]
      );
      await connection.execute(
        `UPDATE sessions SET active_node = NULL, last_sync = NULL WHERE project_id = ?`,
        [projectId]
      );
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    }

    res.json({ restored: true });
  } catch (error) {
    next(error);
  } finally {
    connection.release();
  }
});

router.post('/sessions', async (req, res, next) => {
  const { user_id, project_id: projectIdInput = config.defaults.projectId, active_node = null } = req.body || {};
  if (!user_id) {
    res.status(400).json({ error: 'user_id is required' });
    return;
  }
  const projectId = projectIdInput.toString();
  try {
    const [result] = await pool.execute(
      `INSERT INTO sessions (user_id, project_id, active_node, last_sync) VALUES (?, ?, ?, NULL)` ,
      [user_id, projectId, active_node]
    );
    res.status(201).json({ id: result.insertId, user_id, project_id: projectId, active_node });
  } catch (error) {
    next(error);
  }
});

router.patch('/sessions/:id', async (req, res, next) => {
  const { id } = req.params;
  const { active_node, last_sync } = req.body || {};
  const updates = [];
  const params = [];
  if (active_node !== undefined) {
    updates.push('active_node = ?');
    params.push(active_node);
  }
  if (last_sync !== undefined) {
    updates.push('last_sync = ?');
    params.push(last_sync);
  }
  if (updates.length === 0) {
    res.status(400).json({ error: 'No updates provided' });
    return;
  }
  params.push(id);
  try {
    const [result] = await pool.execute(
      `UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ updated: true });
  } catch (error) {
    next(error);
  }
});

router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const session = driver.session({ defaultAccessMode: neo4j.session.READ });
    await session.run('RETURN 1 AS ok');
    await session.close();
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

module.exports = router;
