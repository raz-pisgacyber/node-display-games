const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const config = require('../config');
const { getReadSession, getWriteSession } = require('../db/neo4j');
const { pool } = require('../db/mysql');
const {
  extractNode,
  newVersionMeta,
  validateRelationshipType,
  serialiseMeta,
  parseMeta,
} = require('../utils/neo4jHelpers');
const { upsertNodeVersion, deleteNodeVersion } = require('../utils/nodeVersions');
const { executeWithLogging, queryWithLogging } = require('../utils/mysqlLogger');

const router = express.Router();

function ensureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normaliseMeta(meta) {
  return ensureObject(parseMeta(meta));
}

function sanitiseMeta(meta) {
  return serialiseMeta(normaliseMeta(meta));
}

function generateCheckpointName(date = new Date()) {
  const fallback = new Date();
  const source = date instanceof Date && !Number.isNaN(date.getTime()) ? date : fallback;
  const pad = (value) => value.toString().padStart(2, '0');
  const year = source.getUTCFullYear();
  const month = pad(source.getUTCMonth() + 1);
  const day = pad(source.getUTCDate());
  const hours = pad(source.getUTCHours());
  const minutes = pad(source.getUTCMinutes());
  const seconds = pad(source.getUTCSeconds());
  return `Checkpoint ${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}

function parseLimitParam(value, defaultValue, maxValue) {
  const rawFallback = Number.isInteger(defaultValue)
    ? defaultValue
    : Number.parseInt(`${defaultValue}`, 10) || 0;
  const fallback = rawFallback > 0 ? rawFallback : 1;
  const parsed =
    typeof value === 'number' && Number.isInteger(value)
      ? value
      : Number.parseInt(value ?? fallback, 10);
  const safe = Number.isNaN(parsed) ? fallback : parsed;
  const positive = safe < 1 ? fallback : safe;
  if (maxValue === undefined) {
    return positive;
  }
  return Math.min(positive, maxValue);
}

router.get('/config', (req, res) => {
  res.json({
    default_project_id: config.defaults.projectId,
    version_poll_interval_ms: config.defaults.versionPollIntervalMs,
  });
});

router.get('/projects', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await queryWithLogging(
      connection,
      'SELECT id, name, created_at FROM projects ORDER BY created_at DESC'
    );
    res.json({ projects: rows });
  } catch (error) {
    next(error);
  } finally {
    connection.release();
  }
});

router.get('/project/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }
  const connection = await pool.getConnection();
  try {
    const [rows] = await queryWithLogging(
      connection,
      'SELECT id, name, created_at FROM projects WHERE id = ?',
      [id]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(rows[0]);
  } catch (error) {
    next(error);
  } finally {
    connection.release();
  }
});

router.post('/project', async (req, res, next) => {
  const body = ensureObject(req.body);
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const providedId = typeof body.id === 'string' ? body.id.trim() : '';

  if (!rawName) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const projectId = providedId || uuidv4();
  if (projectId.length > 64) {
    res.status(400).json({ error: 'id must be 64 characters or fewer' });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await executeWithLogging(connection, 'INSERT INTO projects (id, name) VALUES (?, ?)', [projectId, rawName]);
    const [rows] = await queryWithLogging(
      connection,
      'SELECT id, name, created_at FROM projects WHERE id = ?',
      [projectId]
    );
    const payload = rows[0] || { id: projectId, name: rawName };
    res.status(201).json(payload);
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'Project with this id already exists' });
      return;
    }
    next(error);
  } finally {
    connection.release();
  }
});

router.get('/graph', async (req, res, next) => {
  const projectId = (req.query?.project_id || config.defaults.projectId).toString();
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
  const metaString = sanitiseMeta(meta);
  const { versionId, lastModified } = newVersionMeta();
  const projectId = (projectIdInput || config.defaults.projectId).toString();
  const session = getWriteSession();
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `CREATE (n:ProjectNode {id: $id, project_id: $projectId, label: $label, content: $content, meta: $meta, version_id: $versionId, last_modified: datetime($lastModified)})
         RETURN n`,
        { id: nodeId, projectId, label, content, meta: metaString, versionId, lastModified }
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
  const metaReplaceObject = hasMetaReplace ? normaliseMeta(metaReplace) : null;
  const metaUpdateObject = normaliseMeta(metaUpdates);
  const hasMetaUpdates = !hasMetaReplace && Object.keys(metaUpdateObject).length > 0;

  const projectId = (projectIdInput || req.query?.project_id || config.defaults.projectId).toString();

  if (!hasCore && !hasMetaReplace && !hasMetaUpdates) {
    res.status(400).json({ error: 'No updates provided' });
    return;
  }

  const { versionId, lastModified } = newVersionMeta();
  const session = getWriteSession();
  try {
    const result = await session.writeTransaction(async (tx) => {
      const existingResult = await tx.run(
        `MATCH (n:ProjectNode {id: $id})
         WHERE coalesce(n.project_id, $projectId) = $projectId
         RETURN n`,
        { id, projectId }
      );
      if (existingResult.records.length === 0) {
        return { notFound: true };
      }
      const existingNode = extractNode(existingResult.records[0].get('n'));
      const queryParts = [
        'MATCH (n:ProjectNode {id: $id})',
        'WHERE coalesce(n.project_id, $projectId) = $projectId',
        'SET n.project_id = $projectId',
      ];
      const params = {
        id,
        projectId,
        lastModified,
        versionId,
      };
      if (hasCore) {
        params.core = coreUpdates;
        queryParts.push('SET n += $core');
      }
      if (hasMetaReplace || hasMetaUpdates) {
        const mergedMeta = hasMetaReplace ? { ...metaReplaceObject } : { ...existingNode.meta, ...metaUpdateObject };
        params.meta = sanitiseMeta(mergedMeta);
        queryParts.push('SET n.meta = $meta');
      }
      queryParts.push('SET n.last_modified = datetime($lastModified), n.version_id = $versionId');
      queryParts.push('RETURN n');
      const updateResult = await tx.run(queryParts.join('\n'), params);
      return { updateResult };
    });
    if (!result || result.notFound || result.updateResult.records.length === 0) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    const node = extractNode(result.updateResult.records[0].get('n'));
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
  const session = getWriteSession();
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
  const session = getWriteSession();
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
        { from, to, props: ensureObject(props), projectId }
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
  const session = getWriteSession();
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

router.patch('/edge', async (req, res, next) => {
  const body = ensureObject(req.body);
  const { from, to } = body;
  if (!from || !to) {
    res.status(400).json({ error: 'from and to are required' });
    return;
  }
  const relationshipType = validateRelationshipType(body.type);
  const projectId = (body.project_id || config.defaults.projectId).toString();
  const props = ensureObject(body.props);
  const session = getWriteSession();
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `MATCH (a:ProjectNode {id: $from})-[r:${relationshipType}]->(b:ProjectNode {id: $to})
         WHERE coalesce(a.project_id, $projectId) = $projectId AND coalesce(b.project_id, $projectId) = $projectId
         SET a.project_id = coalesce(a.project_id, $projectId)
         SET b.project_id = coalesce(b.project_id, $projectId)
         SET r = $props
         RETURN {from: a.id, to: b.id, type: type(r), props: properties(r), project_id: $projectId} AS edge`,
        { from, to, projectId, props }
      )
    );
    if (result.records.length === 0) {
      res.status(404).json({ error: 'Edge not found' });
      return;
    }
    res.json(result.records[0].get('edge'));
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.get('/links', async (req, res, next) => {
  const nodeId = req.query?.node_id;
  if (!nodeId) {
    res.status(400).json({ error: 'node_id is required' });
    return;
  }
  const relationshipType = validateRelationshipType(req.query?.type);
  const projectId = (req.query?.project_id || config.defaults.projectId).toString();
  // This query normalises `project_id` on nodes as part of the read, so it
  // needs write access despite serving a GET route.
  const session = getWriteSession();
  try {
    const result = await session.run(
      `MATCH (n:ProjectNode {id: $nodeId})
       WHERE coalesce(n.project_id, $projectId) = $projectId
       SET n.project_id = coalesce(n.project_id, $projectId)
       WITH n
       OPTIONAL MATCH (n)-[r:${relationshipType}]-(m:ProjectNode)
       WHERE coalesce(m.project_id, $projectId) = $projectId
       RETURN n AS node,
              collect({
                other: m,
                type: type(r),
                props: properties(r),
                direction: CASE WHEN startNode(r).id = n.id THEN 'out' ELSE 'in' END
              }) AS links`,
      { nodeId, projectId }
    );
    if (!result.records.length) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    const record = result.records[0];
    const node = extractNode(record.get('node'));
    const rawLinks = record.get('links') || [];
    const links = [];
    const groups = {};
    rawLinks.forEach((entry) => {
      const entryAccessor =
        entry && typeof entry.get === 'function'
          ? (key) => entry.get(key)
          : (key) => (entry && Object.prototype.hasOwnProperty.call(entry, key) ? entry[key] : null);
      const otherNode = entryAccessor('other');
      if (!otherNode) {
        return;
      }
      const extracted = extractNode(otherNode);
      if (!extracted?.id) {
        return;
      }
      const meta = extracted.meta || {};
      const builder = (meta.builder || '').toLowerCase() || 'unknown';
      let subtype = 'default';
      if (builder === 'elements') {
        subtype = (meta.elementType || meta.type || 'other').toLowerCase();
      } else if (builder === 'project') {
        subtype = 'project';
      } else if (builder !== 'unknown') {
        subtype = builder;
      }
      if (!groups[builder]) {
        groups[builder] = {};
      }
      if (!groups[builder][subtype]) {
        groups[builder][subtype] = [];
      }
      const detail = {
        id: extracted.id,
        label: extracted.label || extracted.id,
        builder,
        element_type: builder === 'elements' ? subtype : null,
        project_id: extracted.project_id || projectId,
        relationship_type: entryAccessor('type') || relationshipType,
        direction: entryAccessor('direction') || 'undirected',
        props: ensureObject(entryAccessor('props')),
      };
      groups[builder][subtype].push(detail);
      links.push(detail);
    });
    res.json({
      node_id: node?.id || nodeId,
      project_id: projectId,
      relationship_type: relationshipType,
      links,
      groups,
    });
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.post('/link', async (req, res, next) => {
  const body = ensureObject(req.body);
  const { from, to } = body;
  if (!from || !to) {
    res.status(400).json({ error: 'from and to are required' });
    return;
  }
  const relationshipType = validateRelationshipType(body.type);
  const projectId = (body.project_id || config.defaults.projectId).toString();
  const props = ensureObject(body.props);
  const session = getWriteSession();
  const [source, target] = [from, to].sort();
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `MATCH (a:ProjectNode {id: $source}), (b:ProjectNode {id: $target})
         WHERE coalesce(a.project_id, $projectId) = $projectId AND coalesce(b.project_id, $projectId) = $projectId
         SET a.project_id = coalesce(a.project_id, $projectId)
         SET b.project_id = coalesce(b.project_id, $projectId)
         MERGE (a)-[r:${relationshipType}]-(b)
         SET r += $props
         RETURN {from: a.id, to: b.id, type: type(r), props: properties(r), project_id: $projectId} AS link`,
        { source, target, props, projectId }
      )
    );
    if (!result.records.length) {
      res.status(404).json({ error: 'Nodes not found' });
      return;
    }
    res.status(201).json(result.records[0].get('link'));
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.delete('/link', async (req, res, next) => {
  const body = ensureObject(req.body);
  const { from, to } = body;
  if (!from || !to) {
    res.status(400).json({ error: 'from and to are required' });
    return;
  }
  const relationshipType = validateRelationshipType(body.type);
  const projectId = (body.project_id || config.defaults.projectId).toString();
  const session = getWriteSession();
  const [source, target] = [from, to].sort();
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `MATCH (a:ProjectNode {id: $source})-[r:${relationshipType}]-(b:ProjectNode {id: $target})
         WHERE coalesce(a.project_id, $projectId) = $projectId AND coalesce(b.project_id, $projectId) = $projectId
         WITH r
         DELETE r
         RETURN count(*) AS deleted`,
        { source, target, projectId }
      )
    );
    const deleted = result.records[0].get('deleted');
    if (!deleted) {
      res.status(404).json({ error: 'Link not found' });
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
  const session = getReadSession();
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
    const [result] = await executeWithLogging(
      pool,
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
  const rawLimit = Number.parseInt(limit ?? 50, 10);
  const cappedLimit = parseLimitParam(rawLimit, 50, 200);
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
  sql += ` ORDER BY created_at DESC LIMIT ${cappedLimit}`;
  try {
    const [rows] = await executeWithLogging(pool, sql, params);
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
    const [result] = await executeWithLogging(
      pool,
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
  const rawLimit = Number.parseInt(limit ?? 1, 10);
  const cappedLimit = parseLimitParam(rawLimit, 1, 100);
  try {
    const [rows] = await executeWithLogging(
      pool,
      `SELECT * FROM summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT ${cappedLimit}`,
      [session_id]
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
  const body = ensureObject(req.body);
  const projectId = (body.project_id || config.defaults.projectId).toString();
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const generatedName = generateCheckpointName();
  const checkpointName = (rawName || generatedName).slice(0, 255);
  const session = getWriteSession();
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
        meta: normaliseMeta(node.meta),
        project_id: node.project_id || projectId,
        last_modified: node.last_modified?.toString?.() || node.last_modified,
      })),
      edges: (record?.get('edges') || []).filter((edge) => edge && edge.from && edge.to),
    };
    const json = JSON.stringify(snapshot);
    const checksum = crypto.createHash('sha1').update(json).digest('hex');
    const [insertResult] = await executeWithLogging(
      pool,
      `INSERT INTO checkpoints (project_id, name, json_snapshot, checksum) VALUES (?, ?, ?, ?)` ,
      [projectId, checkpointName, json, checksum]
    );
    res.status(201).json({
      id: insertResult.insertId,
      project_id: projectId,
      name: checkpointName,
      checksum,
    });
  } catch (error) {
    next(error);
  } finally {
    await session.close();
  }
});

router.get('/checkpoints', async (req, res, next) => {
  const projectId = (req.query?.project_id || config.defaults.projectId).toString();
  try {
    const [rows] = await executeWithLogging(
      pool,
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
    const [rows] = await executeWithLogging(connection, 'SELECT * FROM checkpoints WHERE id = ?', [id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Checkpoint not found' });
      return;
    }
    const checkpoint = rows[0];
    const projectId = checkpoint.project_id;
    const snapshot = JSON.parse(checkpoint.json_snapshot);
    const nodes = snapshot.nodes || [];
    const edges = snapshot.edges || [];
    const session = getWriteSession();
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
          const metaData = sanitiseMeta(node.meta);
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
      await executeWithLogging(connection, 'DELETE FROM node_versions WHERE project_id = ?', [projectId]);
      for (const node of nodes) {
        if (node.project_id && node.project_id !== projectId) continue;
        await upsertNodeVersion(connection, {
          id: node.id,
          meta: normaliseMeta(node.meta),
          version_id: node.version_id,
          last_modified: node.last_modified,
          project_id: projectId,
        });
      }
      await executeWithLogging(
        `DELETE m FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.project_id = ?`,
        [projectId]
      );
      await executeWithLogging(
        `DELETE su FROM summaries su JOIN sessions s ON su.session_id = s.id WHERE s.project_id = ?`,
        [projectId]
      );
      await executeWithLogging(
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
    const [result] = await executeWithLogging(
      pool,
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
    const [result] = await executeWithLogging(pool, `UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`, params);
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
  const status = { mysql: 'ok', neo4j: 'ok' };
  let session;
  try {
    await queryWithLogging(pool, 'SELECT 1');
  } catch (error) {
    status.mysql = 'error';
    status.error = error.message;
  }
  try {
    session = getReadSession();
    await session.run('RETURN 1 AS ok');
  } catch (error) {
    status.neo4j = 'error';
    status.error = status.error ? `${status.error}; ${error.message}` : error.message;
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (closeError) {
        // Ignore close errors in health checks.
      }
    }
  }
  const httpStatus = status.mysql === 'ok' && status.neo4j === 'ok' ? 200 : 500;
  res.status(httpStatus).json(status);
});

router.get('/debug/db', async (req, res) => {
  const payload = {
    mysql: { ok: true },
    neo4j: { ok: true },
  };
  let session;
  try {
    const [rows] = await queryWithLogging(pool, 'SELECT NOW() AS now');
    payload.mysql.now = rows?.[0]?.now ?? null;
  } catch (error) {
    payload.mysql = {
      ok: false,
      error: error.message,
      sql: error.sql || null,
      params: error.sqlParams || null,
    };
  }
  try {
    session = getReadSession();
    const result = await session.run('RETURN 1 AS ok');
    const okValue = result.records?.[0]?.get('ok');
    payload.neo4j.okResult = typeof okValue?.toNumber === 'function' ? okValue.toNumber() : okValue;
  } catch (error) {
    payload.neo4j = {
      ok: false,
      error: error.message,
    };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (closeError) {
        // ignore
      }
    }
  }
  const statusCode = payload.mysql.ok !== false && payload.neo4j.ok !== false ? 200 : 500;
  res.status(statusCode).json(payload);
});

module.exports = router;
