const express = require('express');
const { randomUUID } = require('crypto');

const {
  extractNode,
  serialiseMeta,
  newVersionMeta,
  validateRelationshipType,
} = require('../src/utils/neo4jHelpers');
const { getWriteSession } = require('../src/db/neo4j');
const { pool } = require('../src/db/mysql');
const { upsertNodeVersion, deleteNodeVersion } = require('../src/utils/nodeVersions');
const config = require('../src/config');

const router = express.Router();

const toolSchemas = [
  {
    name: 'createNode',
    description: 'Create a new graph node for the active project.',
    input_schema: {
      type: 'object',
      required: ['builder', 'label'],
      properties: {
        builder: { type: 'string', description: 'Originating builder or surface (project/elements/main).' },
        label: { type: 'string', description: 'Node label to assign.' },
        content: { type: 'string', description: 'Optional content/body for the node.' },
        meta: { type: 'object', description: 'Optional metadata object stored on the node.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'updateNode',
    description: 'Update an existing node with new field values.',
    input_schema: {
      type: 'object',
      required: ['node_id', 'fields'],
      properties: {
        node_id: { type: 'string', description: 'Identifier of the node to update.' },
        fields: {
          type: 'object',
          description: 'Subset of node fields to update. Accepts label, content, meta, or metaUpdates.',
          properties: {
            label: { type: 'string' },
            content: { type: 'string' },
            meta: { type: 'object' },
            metaUpdates: { type: 'object' },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'deleteNode',
    description: 'Delete a node and its relationships.',
    input_schema: {
      type: 'object',
      required: ['node_id'],
      properties: {
        node_id: { type: 'string', description: 'Identifier of the node to delete.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'linkNodes',
    description: 'Create a relationship between two nodes.',
    input_schema: {
      type: 'object',
      required: ['from_id', 'to_id'],
      properties: {
        from_id: { type: 'string', description: 'Origin node id.' },
        to_id: { type: 'string', description: 'Destination node id.' },
        type: { type: 'string', description: 'Relationship type. Defaults to LINKS_TO.' },
        props: { type: 'object', description: 'Optional relationship properties.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'unlinkNodes',
    description: 'Remove a relationship between two nodes.',
    input_schema: {
      type: 'object',
      required: ['from_id', 'to_id'],
      properties: {
        from_id: { type: 'string', description: 'Origin node id.' },
        to_id: { type: 'string', description: 'Destination node id.' },
        type: { type: 'string', description: 'Relationship type. Defaults to LINKS_TO.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'getWorkingMemory',
    description: 'Return the current working memory snapshot passed from the client.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'updateWorkingMemory',
    description: 'Merge updated working memory JSON into the active snapshot.',
    input_schema: {
      type: 'object',
      required: ['memory_json'],
      properties: {
        memory_json: {
          type: 'object',
          description: 'Partial or full working memory structure produced by the AI.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'updateThought',
    description: 'Provide a transient reasoning update for the UI.',
    input_schema: {
      type: 'object',
      required: ['stage', 'content'],
      properties: {
        stage: { type: 'string', description: 'Short label for the reasoning stage.' },
        content: { type: 'string', description: 'Human-readable reasoning detail.' },
      },
      additionalProperties: false,
    },
  },
];

class ToolError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ToolError';
    this.status = status;
  }
}

function ensureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function sanitiseCustomFields(list = []) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((field) => {
      if (!field || typeof field !== 'object') {
        return null;
      }
      const key = typeof field.key === 'string' ? field.key.trim() : '';
      const value = typeof field.value === 'string' ? field.value : '';
      if (!key && !value) {
        return null;
      }
      return { key, value };
    })
    .filter(Boolean);
}

function sanitiseLinkedElements(list = []) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const id = typeof entry.id === 'string' ? entry.id : entry.id?.toString?.();
      if (!id) {
        return null;
      }
      return {
        id,
        label:
          typeof entry.label === 'string' && entry.label
            ? entry.label
            : id,
        type: typeof entry.type === 'string' ? entry.type : '',
      };
    })
    .filter(Boolean);
}

function sanitiseStructureNode(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  const id = typeof node.id === 'string' ? node.id : node.id?.toString?.();
  if (!id) {
    return null;
  }
  const label =
    typeof node.label === 'string' ? node.label : node.title?.toString?.() || '';
  const type =
    typeof node.type === 'string'
      ? node.type
      : typeof node.builder === 'string'
      ? node.builder
      : '';
  return { id, label, type };
}

function sanitiseStructureEdge(edge) {
  if (!edge || typeof edge !== 'object') {
    return null;
  }
  const from =
    typeof edge.from === 'string' ? edge.from : edge.from?.toString?.();
  const to = typeof edge.to === 'string' ? edge.to : edge.to?.toString?.();
  if (!from || !to) {
    return null;
  }
  return {
    from,
    to,
    type: typeof edge.type === 'string' ? edge.type : 'LINKS_TO',
  };
}

function sanitiseStructure(structure) {
  if (!structure || typeof structure !== 'object') {
    return { nodes: [], edges: [] };
  }
  const nodes = Array.isArray(structure.nodes)
    ? structure.nodes.map(sanitiseStructureNode).filter(Boolean)
    : [];
  const edges = Array.isArray(structure.edges)
    ? structure.edges.map(sanitiseStructureEdge).filter(Boolean)
    : [];
  return { nodes, edges };
}

function sanitiseMeta(meta = {}, fallbacks = {}) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const result = {};
  const noteCandidates = [
    source.notes,
    fallbacks.notes,
    source.projectData?.notes,
    source.elementData?.notes,
  ];
  const note = noteCandidates.find((value) => typeof value === 'string' && value.trim());
  if (note) {
    result.notes = note;
  }
  const customFieldsSource =
    source.customFields ||
    fallbacks.customFields ||
    source.projectData?.customFields ||
    source.elementData?.customFields ||
    [];
  const customFields = sanitiseCustomFields(customFieldsSource);
  if (customFields.length) {
    result.customFields = customFields;
  }
  const linkedSource = source.linked_elements || fallbacks.linked_elements || [];
  const linkedElements = sanitiseLinkedElements(linkedSource);
  if (linkedElements.length) {
    result.linked_elements = linkedElements;
  }
  return result;
}

function sanitiseNodeContext(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  const id = typeof context.id === 'string' ? context.id : context.node_id?.toString?.() || '';
  const label =
    typeof context.label === 'string'
      ? context.label
      : context.title?.toString?.() || '';
  const type =
    typeof context.type === 'string'
      ? context.type
      : typeof context.builder === 'string'
      ? context.builder
      : '';
  return {
    id,
    label,
    type,
    meta: sanitiseMeta(context.meta, {
      notes: context.notes,
      customFields: context.customFields,
      linked_elements: context.linked_elements,
    }),
  };
}

function normaliseMemory(memory) {
  const base = ensureObject(memory);
  const session = ensureObject(base.session);
  const messages = Array.isArray(base.messages) ? [...base.messages] : [];
  const configSnapshot = ensureObject(base.config);
  return {
    session: {
      session_id: typeof session.session_id === 'string' ? session.session_id : '',
      project_id: typeof session.project_id === 'string' ? session.project_id : '',
      active_node_id: typeof session.active_node_id === 'string' ? session.active_node_id : '',
      timestamp: typeof session.timestamp === 'string' ? session.timestamp : new Date().toISOString(),
    },
    project_structure: sanitiseStructure(base.project_structure),
    node_context: sanitiseNodeContext(base.node_context),
    fetched_context: ensureObject(base.fetched_context),
    working_history: typeof base.working_history === 'string' ? base.working_history : '',
    messages,
    last_user_message:
      typeof base.last_user_message === 'string'
        ? base.last_user_message
        : deriveLastUserMessage(messages),
    config: {
      history_length: normaliseNumber(configSnapshot.history_length, 20, 1, 200),
      include_project_structure: Boolean(
        configSnapshot.include_project_structure ?? true
      ),
      include_context: Boolean(configSnapshot.include_context ?? true),
      include_working_history: Boolean(
        configSnapshot.include_working_history ?? true
      ),
      auto_refresh_interval: normaliseNumber(
        configSnapshot.auto_refresh_interval,
        0,
        0,
        600
      ),
    },
  };
}

function deriveLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry && typeof entry === 'object' && entry.role === 'user') {
      const content = entry.content;
      if (typeof content === 'string') {
        return content;
      }
      if (Array.isArray(content)) {
        return content
          .map((part) => (typeof part === 'string' ? part : part?.text || ''))
          .filter(Boolean)
          .join(' ')
          .trim();
      }
    }
  }
  return '';
}

function normaliseNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return clamp(fallback, min, max);
  }
  return clamp(parsed, min, max);
}

function clamp(value, min, max) {
  const lower = min === undefined ? value : Math.max(value, min);
  const upper = max === undefined ? lower : Math.min(lower, max);
  return upper;
}

function mergeWorkingMemory(base, updates) {
  const incoming = ensureObject(updates);
  const next = normaliseMemory(base);
  if (incoming.session) {
    next.session = {
      ...next.session,
      ...ensureObject(incoming.session),
    };
  }
  if (incoming.project_structure !== undefined) {
    next.project_structure = sanitiseStructure(incoming.project_structure);
  }
  if (incoming.node_context !== undefined) {
    next.node_context = sanitiseNodeContext(incoming.node_context);
  }
  if (incoming.fetched_context !== undefined) {
    next.fetched_context = ensureObject(incoming.fetched_context);
  }
  if (incoming.working_history !== undefined) {
    next.working_history =
      typeof incoming.working_history === 'string'
        ? incoming.working_history
        : next.working_history;
  }
  if (incoming.messages !== undefined) {
    next.messages = Array.isArray(incoming.messages)
      ? [...incoming.messages]
      : next.messages;
  }
  if (incoming.last_user_message !== undefined) {
    next.last_user_message =
      typeof incoming.last_user_message === 'string'
        ? incoming.last_user_message
        : next.last_user_message;
  } else if (incoming.messages !== undefined) {
    next.last_user_message = deriveLastUserMessage(next.messages);
  }
  if (incoming.config) {
    const configUpdate = ensureObject(incoming.config);
    next.config = {
      ...next.config,
      history_length:
        configUpdate.history_length !== undefined
          ? normaliseNumber(
              configUpdate.history_length,
              next.config.history_length,
              1,
              200
            )
          : next.config.history_length,
      include_project_structure:
        configUpdate.include_project_structure !== undefined
          ? Boolean(configUpdate.include_project_structure)
          : next.config.include_project_structure,
      include_context:
        configUpdate.include_context !== undefined
          ? Boolean(configUpdate.include_context)
          : next.config.include_context,
      include_working_history:
        configUpdate.include_working_history !== undefined
          ? Boolean(configUpdate.include_working_history)
          : next.config.include_working_history,
      auto_refresh_interval:
        configUpdate.auto_refresh_interval !== undefined
          ? normaliseNumber(
              configUpdate.auto_refresh_interval,
              next.config.auto_refresh_interval,
              0,
              600
            )
          : next.config.auto_refresh_interval,
    };
  }
  return next;
}

function resolveProjectId(memory) {
  const normalised = normaliseMemory(memory);
  return normalised.session.project_id || config.defaults.projectId;
}

async function runCreateNode(args, memory) {
  const { builder, label, content = '', meta = {} } = ensureObject(args);
  if (!builder) {
    throw new ToolError('builder is required');
  }
  if (!label) {
    throw new ToolError('label is required');
  }
  const projectId = resolveProjectId(memory).toString();
  const { versionId, lastModified } = newVersionMeta();
  const nodeId = randomUUID();
  const session = getWriteSession();
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `CREATE (n:ProjectNode {id: $id, project_id: $projectId, label: $label, content: $content, meta: $meta, version_id: $versionId, last_modified: datetime($lastModified)})
         RETURN n`,
        {
          id: nodeId,
          projectId,
          label,
          content,
          meta: serialiseMeta(meta),
          versionId,
          lastModified,
        }
      )
    );
    const nodeRecord = result.records[0]?.get('n');
    if (!nodeRecord) {
      throw new ToolError('Failed to create node', 500);
    }
    const node = extractNode(nodeRecord);
    const connection = await pool.getConnection();
    try {
      await upsertNodeVersion(connection, { ...node, project_id: projectId });
    } finally {
      connection.release();
    }
    return { node, project_id: projectId, builder };
  } finally {
    await session.close();
  }
}

async function runUpdateNode(args, memory) {
  const { node_id: nodeId, fields } = ensureObject(args);
  if (!nodeId) {
    throw new ToolError('node_id is required');
  }
  const updates = ensureObject(fields);
  const core = {};
  if (updates.label !== undefined) core.label = updates.label;
  if (updates.content !== undefined) core.content = updates.content;
  const hasCore = Object.keys(core).length > 0;
  const hasMetaReplace = updates.meta !== undefined;
  const metaReplace = hasMetaReplace ? ensureObject(updates.meta) : null;
  const metaUpdates = ensureObject(updates.metaUpdates);
  const projectId = resolveProjectId(memory).toString();
  if (!hasCore && !hasMetaReplace && Object.keys(metaUpdates).length === 0) {
    throw new ToolError('No updates provided');
  }
  const { versionId, lastModified } = newVersionMeta();
  const session = getWriteSession();
  try {
    const result = await session.writeTransaction(async (tx) => {
      const existing = await tx.run(
        `MATCH (n:ProjectNode {id: $id})
         WHERE coalesce(n.project_id, $projectId) = $projectId
         RETURN n`,
        { id: nodeId, projectId }
      );
      if (!existing.records.length) {
        return null;
      }
      const existingNode = extractNode(existing.records[0].get('n'));
      const mergedMeta = hasMetaReplace
        ? metaReplace
        : { ...ensureObject(existingNode.meta), ...metaUpdates };
      const query = [
        'MATCH (n:ProjectNode {id: $id})',
        'WHERE coalesce(n.project_id, $projectId) = $projectId',
        'SET n.project_id = $projectId',
      ];
      const params = {
        id: nodeId,
        projectId,
        lastModified,
        versionId,
      };
      if (hasCore) {
        params.core = core;
        query.push('SET n += $core');
      }
      if (hasMetaReplace || Object.keys(metaUpdates).length > 0) {
        params.meta = serialiseMeta(mergedMeta);
        query.push('SET n.meta = $meta');
      }
      query.push('SET n.last_modified = datetime($lastModified), n.version_id = $versionId');
      query.push('RETURN n');
      const updateResult = await tx.run(query.join('\n'), params);
      return updateResult.records[0]?.get('n') || null;
    });
    if (!result) {
      throw new ToolError('Node not found', 404);
    }
    const node = extractNode(result);
    const connection = await pool.getConnection();
    try {
      await upsertNodeVersion(connection, { ...node, project_id: projectId });
    } finally {
      connection.release();
    }
    return { node };
  } finally {
    await session.close();
  }
}

async function runDeleteNode(args, memory) {
  const { node_id: nodeId } = ensureObject(args);
  if (!nodeId) {
    throw new ToolError('node_id is required');
  }
  const projectId = resolveProjectId(memory).toString();
  const session = getWriteSession();
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `MATCH (n:ProjectNode {id: $id})
         WHERE coalesce(n.project_id, $projectId) = $projectId
         WITH n
         DETACH DELETE n
         RETURN count(n) AS deleted`,
        { id: nodeId, projectId }
      )
    );
    const deleted = result.records[0]?.get('deleted') || 0;
    if (!deleted) {
      throw new ToolError('Node not found', 404);
    }
    const connection = await pool.getConnection();
    try {
      await deleteNodeVersion(connection, nodeId, projectId);
    } finally {
      connection.release();
    }
    return { deleted: true };
  } finally {
    await session.close();
  }
}

async function runLinkNodes(args, memory) {
  const { from_id: fromId, to_id: toId, type, props = {} } = ensureObject(args);
  if (!fromId || !toId) {
    throw new ToolError('from_id and to_id are required');
  }
  const relationshipType = validateRelationshipType(type);
  const projectId = resolveProjectId(memory).toString();
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
        { from: fromId, to: toId, props: ensureObject(props), projectId }
      )
    );
    const edge = result.records[0]?.get('edge');
    if (!edge) {
      throw new ToolError('Nodes not found', 404);
    }
    return { edge };
  } finally {
    await session.close();
  }
}

async function runUnlinkNodes(args, memory) {
  const { from_id: fromId, to_id: toId, type } = ensureObject(args);
  if (!fromId || !toId) {
    throw new ToolError('from_id and to_id are required');
  }
  const relationshipType = validateRelationshipType(type);
  const projectId = resolveProjectId(memory).toString();
  const session = getWriteSession();
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `MATCH (a:ProjectNode {id: $from})-[r:${relationshipType}]->(b:ProjectNode {id: $to})
         WHERE coalesce(a.project_id, $projectId) = $projectId AND coalesce(b.project_id, $projectId) = $projectId
         WITH r
         DELETE r
         RETURN count(*) AS deleted`,
        { from: fromId, to: toId, projectId }
      )
    );
    const deleted = result.records[0]?.get('deleted') || 0;
    if (!deleted) {
      throw new ToolError('Edge not found', 404);
    }
    return { deleted: true };
  } finally {
    await session.close();
  }
}

function runGetWorkingMemory(_args, memory) {
  return { memory: normaliseMemory(memory) };
}

function runUpdateWorkingMemory(args, memory) {
  const { memory_json: memoryJson } = ensureObject(args);
  if (!memoryJson || typeof memoryJson !== 'object') {
    throw new ToolError('memory_json must be an object');
  }
  const nextMemory = mergeWorkingMemory(memory, memoryJson);
  return { memory: nextMemory };
}

function runUpdateThought(args, memory) {
  const { stage, content } = ensureObject(args);
  if (!stage || !content) {
    throw new ToolError('stage and content are required');
  }
  return {
    memory: normaliseMemory(memory),
    thought: {
      stage,
      content,
      timestamp: new Date().toISOString(),
    },
  };
}

const toolHandlers = {
  createNode: runCreateNode,
  updateNode: runUpdateNode,
  deleteNode: runDeleteNode,
  linkNodes: runLinkNodes,
  unlinkNodes: runUnlinkNodes,
  getWorkingMemory: async (args, memory) => runGetWorkingMemory(args, memory),
  updateWorkingMemory: async (args, memory) => runUpdateWorkingMemory(args, memory),
  updateThought: async (args, memory) => runUpdateThought(args, memory),
};

router.get('/tools', (req, res) => {
  res.json({ tools: toolSchemas });
});

router.post('/call', async (req, res, next) => {
  const body = req.body || {};
  const toolName = body.tool;
  const args = body.arguments || {};
  const memory = normaliseMemory(body.memory);

  const handler = toolHandlers[toolName];
  if (!handler) {
    next(new ToolError(`Unknown tool: ${toolName}`, 404));
    return;
  }
  try {
    const result = await handler(args, memory);
    const { memory: resultMemory, ...rest } = result || {};
    const nextMemory = resultMemory ? normaliseMemory(resultMemory) : memory;
    const payload = {
      tool: toolName,
      result: rest,
      memory: nextMemory,
    };
    res.json(payload);
  } catch (error) {
    if (error instanceof ToolError) {
      res.status(error.status).json({ error: error.message, tool: toolName });
      return;
    }
    next(error);
  }
});

module.exports = router;
