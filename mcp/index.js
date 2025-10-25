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
const { executeWithLogging } = require('../src/utils/mysqlLogger');

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
    description: 'Return the current working memory snapshot from the application runtime.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'sendMessage',
    description: 'Persist a transcript entry for the active session.',
    input_schema: {
      type: 'object',
      required: ['message_type', 'content'],
      properties: {
        message_type: {
          type: 'string',
          description: 'Classify the message intent.',
          enum: ['user_reply', 'inner_process'],
        },
        content: {
          type: 'string',
          description: 'Plain-text message content to store.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'updateWorkingHistory',
    description: 'Persist a working-history summary for a specific node.',
    input_schema: {
      type: 'object',
      required: ['node_id', 'summary_text'],
      properties: {
        node_id: {
          type: 'string',
          description: 'Identifier of the node whose working history should be updated.',
        },
        summary_text: {
          type: 'string',
          description: 'Updated working-history narrative for the node.',
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

const MESSAGE_TYPE_ROLE_MAP = {
  user_reply: 'user',
  inner_process: 'reflector',
};

const VALID_MESSAGE_TYPES = new Set(Object.keys(MESSAGE_TYPE_ROLE_MAP));

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

function sanitiseGraphNode(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  const id = typeof node.id === 'string' ? node.id : node.id?.toString?.();
  if (!id) {
    return null;
  }
  const label =
    typeof node.label === 'string' ? node.label : node.title?.toString?.() || '';
  const type = typeof node.type === 'string' ? node.type : '';
  const builder =
    typeof node.builder === 'string' ? node.builder : type || '';
  const normalisedChildren = Array.isArray(node.children)
    ? Array.from(
        new Set(
          node.children
            .map((child) =>
              typeof child === 'string' ? child : child?.toString?.()
            )
            .filter(Boolean)
        )
      )
    : [];
  const links = Array.isArray(node.links)
    ? node.links
        .map((link) => {
          if (!link || typeof link !== 'object') {
            return null;
          }
          const target =
            typeof link.to === 'string' ? link.to : link.to?.toString?.();
          if (!target) {
            return null;
          }
          const linkType =
            typeof link.type === 'string' ? link.type : 'LINKS_TO';
          return { to: target, type: linkType };
        })
        .filter(Boolean)
    : [];
  const payload = {
    id,
    label,
    type,
    builder,
  };
  if (builder.trim().toLowerCase() === 'project') {
    payload.children = normalisedChildren;
  } else if (normalisedChildren.length) {
    payload.children = normalisedChildren;
  }
  if (links.length) {
    payload.links = links;
  }
  return payload;
}

function sanitiseGraphEdge(edge) {
  if (!edge || typeof edge !== 'object') {
    return null;
  }
  const from =
    typeof edge.from === 'string' ? edge.from : edge.from?.toString?.();
  const to = typeof edge.to === 'string' ? edge.to : edge.to?.toString?.();
  if (!from || !to) {
    return null;
  }
  const type = typeof edge.type === 'string' ? edge.type : 'LINKS_TO';
  return { from, to, type };
}

function sanitiseGraph(graph) {
  if (!graph || typeof graph !== 'object') {
    return { nodes: [], edges: [] };
  }
  const nodes = Array.isArray(graph.nodes)
    ? graph.nodes.map(sanitiseGraphNode).filter(Boolean)
    : [];
  const edges = Array.isArray(graph.edges)
    ? graph.edges.map(sanitiseGraphEdge).filter(Boolean)
    : [];
  return { nodes, edges };
}

function sanitiseStructure(structure) {
  if (!structure || typeof structure !== 'object') {
    return {
      project_graph: { nodes: [], edges: [] },
      elements_graph: { nodes: [], edges: [] },
    };
  }
  if (structure.project_graph || structure.elements_graph) {
    return {
      project_graph: sanitiseGraph(structure.project_graph),
      elements_graph: sanitiseGraph(structure.elements_graph),
    };
  }
  const fallbackGraph = sanitiseGraph(structure);
  return {
    project_graph: fallbackGraph,
    elements_graph: { nodes: [], edges: [] },
  };
}

function normaliseId(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value.toString === 'function') {
    return value.toString();
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return '';
  }
}

function pickFirstString(...candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    const value = candidates[index];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return '';
}

function buildStructureFromGraph(nodes, edges) {
  const projectGraph = { nodes: [], edges: [] };
  const elementsGraph = { nodes: [], edges: [] };

  const projectNodeMap = new Map();
  const elementNodeMap = new Map();
  const projectChildren = new Map();
  const nodeLinks = new Map();

  nodes.forEach((node) => {
    if (!node) {
      return;
    }
    const id = normaliseId(node.id);
    if (!id) {
      return;
    }
    const meta = node.meta && typeof node.meta === 'object' ? node.meta : {};
    const builderRaw =
      typeof meta.builder === 'string' ? meta.builder.trim().toLowerCase() : '';
    const isProjectNode =
      builderRaw === 'project' || meta.projectData !== undefined;
    const isElementNode =
      builderRaw === 'elements' ||
      meta.elementData !== undefined ||
      meta.elementType !== undefined;

    if (isProjectNode) {
      const label =
        pickFirstString(
          meta.projectData?.title,
          node.label,
          meta.title,
          meta.name
        ) || id;
      const type = pickFirstString(
        meta.projectData?.type,
        meta.type,
        'project'
      ) || 'project';
      const entry = {
        id,
        label,
        type,
        builder: 'project',
        children: [],
        links: [],
      };
      projectGraph.nodes.push(entry);
      projectNodeMap.set(id, entry);
      projectChildren.set(id, new Set());
      nodeLinks.set(id, new Map());
      return;
    }

    if (isElementNode) {
      const label =
        pickFirstString(
          meta.elementData?.title,
          node.label,
          meta.title,
          meta.name
        ) || id;
      const elementType = pickFirstString(
        meta.elementData?.type,
        meta.elementType,
        meta.type,
        'element'
      ) || 'element';
      const entry = {
        id,
        label,
        type: elementType,
        builder: 'elements',
        links: [],
      };
      elementsGraph.nodes.push(entry);
      elementNodeMap.set(id, entry);
      nodeLinks.set(id, new Map());
    }
  });

  const projectEdgeSet = new Set();
  const elementEdgeSet = new Set();

  function addEdge(target, cache, from, to, type) {
    const key = `${from}->${to}:${type}`;
    if (cache.has(key)) {
      return;
    }
    cache.add(key);
    target.push({ from, to, type });
  }

  function addLink(sourceId, targetId, type) {
    const linkBucket = nodeLinks.get(sourceId);
    if (!linkBucket) {
      return;
    }
    const key = `${targetId}:${type}`;
    if (linkBucket.has(key)) {
      return;
    }
    linkBucket.set(key, { to: targetId, type });
  }

  edges.forEach((edge) => {
    if (!edge) {
      return;
    }
    const fromId = normaliseId(edge.from);
    const toId = normaliseId(edge.to);
    if (!fromId || !toId) {
      return;
    }
    const type =
      typeof edge.type === 'string' && edge.type.trim()
        ? edge.type.trim().toUpperCase()
        : 'LINKS_TO';
    const fromIsProject = projectNodeMap.has(fromId);
    const toIsProject = projectNodeMap.has(toId);
    const fromIsElement = elementNodeMap.has(fromId);
    const toIsElement = elementNodeMap.has(toId);

    if (type === 'CHILD_OF' && fromIsProject && toIsProject) {
      addEdge(projectGraph.edges, projectEdgeSet, fromId, toId, type);
      const childrenSet = projectChildren.get(fromId);
      if (childrenSet) {
        childrenSet.add(toId);
      }
    }

    if (fromIsElement || toIsElement) {
      addEdge(elementsGraph.edges, elementEdgeSet, fromId, toId, type);
    }

    const crossesGraphs =
      (fromIsProject && toIsElement) || (fromIsElement && toIsProject);
    if (crossesGraphs) {
      addLink(fromId, toId, type);
      addLink(toId, fromId, type);
    }
  });

  projectGraph.nodes.forEach((node) => {
    const childrenSet = projectChildren.get(node.id);
    node.children = childrenSet ? Array.from(childrenSet) : [];
    const linkBucket = nodeLinks.get(node.id);
    node.links = linkBucket ? Array.from(linkBucket.values()) : [];
  });

  elementsGraph.nodes.forEach((node) => {
    const linkBucket = nodeLinks.get(node.id);
    node.links = linkBucket ? Array.from(linkBucket.values()) : [];
  });

  return {
    project_graph: projectGraph,
    elements_graph: elementsGraph,
  };
}

async function loadProjectStructure(projectId) {
  if (!projectId) {
    return sanitiseStructure({});
  }
  const session = getWriteSession();
  try {
    const result = await session.writeTransaction((tx) =>
      tx.run(
        `MATCH (n:ProjectNode)
         WHERE coalesce(n.project_id, $projectId) = $projectId
         SET n.project_id = coalesce(n.project_id, $projectId)
         WITH n
         OPTIONAL MATCH (n)-[r]->(m:ProjectNode)
         WHERE coalesce(m.project_id, $projectId) = $projectId
         RETURN collect(DISTINCT n) AS nodes,
                collect(DISTINCT { from: n.id, to: m.id, type: type(r) }) AS edges`,
        { projectId }
      )
    );
    const record = result.records[0];
    const rawNodes = record?.get('nodes') || [];
    const rawEdges = (record?.get('edges') || []).filter(
      (edge) => edge && edge.from && edge.to
    );
    const extractedNodes = rawNodes.map((node) => {
      const extracted = extractNode(node);
      if (!extracted.project_id) {
        extracted.project_id = projectId;
      }
      return extracted;
    });
    const extractedEdges = rawEdges.map((edge) => ({
      from: normaliseId(edge.from),
      to: normaliseId(edge.to),
      type:
        typeof edge.type === 'string' && edge.type.trim()
          ? edge.type.trim().toUpperCase()
          : 'LINKS_TO',
    }));
    const structure = buildStructureFromGraph(extractedNodes, extractedEdges);
    return sanitiseStructure(structure);
  } finally {
    await session.close();
  }
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

async function runGetWorkingMemory(memory) {
  const baseMemory = normaliseMemory(memory);
  const includeStructure =
    baseMemory?.config?.include_project_structure !== false;
  const projectId = resolveProjectId(baseMemory);
  const projectStructure = includeStructure
    ? await loadProjectStructure(projectId)
    : sanitiseStructure({});
  const nextMemory = {
    ...baseMemory,
    project_structure: projectStructure,
  };
  return { memory: nextMemory, __skipNormalise: true };
}

async function runSendMessage(args, memory) {
  const { message_type: messageTypeRaw, content } = ensureObject(args);
  const messageType =
    typeof messageTypeRaw === 'string' ? messageTypeRaw.trim() : '';
  if (!VALID_MESSAGE_TYPES.has(messageType)) {
    throw new ToolError('message_type must be either user_reply or inner_process');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new ToolError('content must be a non-empty string');
  }
  const baseMemory = normaliseMemory(memory);
  const sessionIdRaw = baseMemory.session.session_id;
  const sessionId =
    typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
  if (!sessionId) {
    throw new ToolError('session_id is required in working memory');
  }
  const nodeIdSource =
    baseMemory.session.active_node_id || baseMemory.node_context?.id || '';
  const nodeIdTrimmed =
    typeof nodeIdSource === 'string' ? nodeIdSource.trim() : '';
  const nodeId = nodeIdTrimmed ? nodeIdTrimmed : null;
  const trimmedContent = content.trim();
  const role = MESSAGE_TYPE_ROLE_MAP[messageType] || 'user';
  const [result] = await executeWithLogging(
    pool,
    'INSERT INTO messages (session_id, node_id, role, content, message_type) VALUES (?, ?, ?, ?, ?)',
    [sessionId, nodeId, role, trimmedContent, messageType]
  );
  const insertedId = result?.insertId;
  let savedMessage = null;
  if (insertedId) {
    const [rows] = await executeWithLogging(
      pool,
      'SELECT id, session_id, node_id, role, content, message_type, created_at FROM messages WHERE id = ?',
      [insertedId]
    );
    savedMessage = Array.isArray(rows) && rows.length ? rows[0] : null;
  }
  const createdAt = savedMessage?.created_at
    ? savedMessage.created_at.toISOString?.() || savedMessage.created_at
    : new Date().toISOString();
  const messagePayload = {
    id: savedMessage?.id ?? insertedId ?? null,
    session_id: savedMessage?.session_id ?? sessionId,
    node_id: savedMessage?.node_id ?? nodeId,
    role: savedMessage?.role ?? role,
    content: savedMessage?.content ?? trimmedContent,
    message_type: savedMessage?.message_type ?? messageType,
    created_at: createdAt,
  };
  return { memory: baseMemory, message: messagePayload };
}

async function runUpdateWorkingHistory(args, memory) {
  const { node_id: nodeIdRaw, summary_text: summaryText } = ensureObject(args);
  const nodeId =
    typeof nodeIdRaw === 'string' ? nodeIdRaw.trim() : '';
  if (!nodeId) {
    throw new ToolError('node_id is required');
  }
  if (typeof summaryText !== 'string') {
    throw new ToolError('summary_text must be a string');
  }
  const baseMemory = normaliseMemory(memory);
  const projectIdRaw = resolveProjectId(baseMemory);
  const projectId =
    typeof projectIdRaw === 'string' ? projectIdRaw.trim() : '';
  if (!projectId) {
    throw new ToolError('project_id is required to update working history');
  }
  await executeWithLogging(
    pool,
    `INSERT INTO node_working_history (project_id, node_id, working_history)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE working_history = VALUES(working_history), updated_at = CURRENT_TIMESTAMP`,
    [projectId, nodeId, summaryText]
  );
  const [rows] = await executeWithLogging(
    pool,
    'SELECT project_id, node_id, working_history, updated_at FROM node_working_history WHERE project_id = ? AND node_id = ?',
    [projectId, nodeId]
  );
  const record = Array.isArray(rows) && rows.length ? rows[0] : null;
  const updatedAt = record?.updated_at
    ? record.updated_at.toISOString?.() || record.updated_at
    : new Date().toISOString();
  const historyPayload = {
    project_id: record?.project_id ?? projectId,
    node_id: record?.node_id ?? nodeId,
    working_history: record?.working_history ?? summaryText,
    updated_at: updatedAt,
  };
  return { memory: baseMemory, history: historyPayload };
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
  getWorkingMemory: async (_, memory) => runGetWorkingMemory(memory),
  sendMessage: async (args, memory) => runSendMessage(args, memory),
  updateWorkingHistory: async (args, memory) => runUpdateWorkingHistory(args, memory),
  updateThought: async (args, memory) => runUpdateThought(args, memory),
};

router.get('/tools', (req, res) => {
  res.json({ tools: toolSchemas });
});

router.get('/working-memory', (req, res) => {
  res.json(null);
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
    const { memory: resultMemory, __skipNormalise, ...rest } = result || {};
    let nextMemory;
    if (__skipNormalise) {
      nextMemory = resultMemory === undefined ? null : resultMemory;
    } else if (resultMemory) {
      nextMemory = normaliseMemory(resultMemory);
    } else {
      nextMemory = memory;
    }
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
