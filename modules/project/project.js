import NodeBase from '../../core/nodebase.js';
import ProjectNode from './ProjectNode.js';
import util, { enableZoomPan, ensureCanvas, log } from '../../core/util.js';
import AutosaveManager from '../common/autosaveManager.js';
import { fetchGraph, createNode, createEdge, createCheckpoint } from '../common/api.js';
import {
  initialiseWorkingMemory,
  setWorkingMemoryProjectStructure,
  setWorkingMemoryNodeContext,
  setWorkingMemorySession,
} from '../common/workingMemory.js';
import { openWorkingMemoryViewer } from '../common/workingMemoryViewer.js';

const PROJECT_STORAGE_KEY = 'story-graph-project';
const PROJECT_CONTEXT_STORAGE_KEY = 'story-graph-project-context';

const STATUS_LABELS = {
  idle: 'Idle',
  dirty: 'Editing…',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Autosave failed',
};

function cloneForMemory(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    if (Array.isArray(value)) {
      return value.map((item) => cloneForMemory(item));
    }
    if (typeof value === 'object') {
      const result = {};
      Object.entries(value).forEach(([key, entry]) => {
        if (entry === undefined) {
          return;
        }
        if (entry === null) {
          result[key] = null;
        } else if (typeof entry === 'object') {
          result[key] = cloneForMemory(entry);
        } else if (typeof entry !== 'function') {
          result[key] = entry;
        }
      });
      return result;
    }
    return value;
  }
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
    .map((item) => {
      if (!item || typeof item !== 'object' || !item.id) {
        return null;
      }
      return {
        id: String(item.id),
        label: typeof item.label === 'string' && item.label ? item.label : String(item.id),
        type:
          typeof item.type === 'string' && item.type
            ? item.type
            : typeof item.elementType === 'string' && item.elementType
            ? item.elementType
            : 'element',
      };
    })
    .filter(Boolean);
}

function buildWorkingMemoryMeta(meta = {}, extras = {}) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const result = {};
  const noteCandidates = [extras.notes, source.notes, source.projectData?.notes];
  const note = noteCandidates.find((value) => typeof value === 'string' && value.trim());
  if (note) {
    result.notes = note;
  }
  const customFieldsSource =
    extras.customFields || source.customFields || source.projectData?.customFields || [];
  const customFields = sanitiseCustomFields(customFieldsSource);
  if (customFields.length) {
    result.customFields = cloneForMemory(customFields);
  }
  const linkedSource =
    extras.linked_elements || extras.linkedElements || source.linked_elements || [];
  const linkedElements = sanitiseLinkedElements(linkedSource);
  if (linkedElements.length) {
    result.linked_elements = cloneForMemory(linkedElements);
  }
  return result;
}

function buildNodeContextFromInstance(node) {
  if (!node) {
    return null;
  }
  const context = {
    id: node.id,
    label: node.title || node.meta?.title || '',
    type: 'project',
    meta: buildWorkingMemoryMeta(node.meta || {}, {
      notes: typeof node.notes === 'string' ? node.notes : node.meta?.notes,
      customFields: node.projectData?.customFields ?? node.meta?.projectData?.customFields,
      linked_elements: (typeof node.ensureLinkState === 'function'
        ? node.ensureLinkState()?.items
        : node.linkState?.items) || [],
    }),
  };
  return context;
}

function buildProjectStructureSnapshot(projectId) {
  const nodes = [];
  const edges = [];
  if (NodeBase?.instances instanceof Map) {
    NodeBase.instances.forEach((instance) => {
      if (!instance) {
        return;
      }
      if (projectId && instance.projectId && instance.projectId !== projectId) {
        return;
      }
      const builderType = (instance.meta?.builder || '').toLowerCase();
      if (builderType && builderType !== 'project') {
        return;
      }
      nodes.push({
        id: String(instance.id),
        label: instance.title || '',
        type: 'project',
        builder: 'project',
      });
      if (Array.isArray(instance.children)) {
        instance.children.forEach((child) => {
          if (!child) return;
          if (projectId && child.projectId && child.projectId !== projectId) {
            return;
          }
          edges.push({
            from: String(instance.id),
            to: String(child.id),
            type: 'CHILD_OF',
          });
        });
      }
    });
  }
  return { nodes, edges };
}

function syncWorkingMemoryStructure(projectId) {
  if (projectId) {
    setWorkingMemorySession({ project_id: projectId });
  }
  setWorkingMemoryProjectStructure(buildProjectStructureSnapshot(projectId));
}

function syncWorkingMemoryNode(node, projectId) {
  const context = buildNodeContextFromInstance(node);
  if (context) {
    setWorkingMemoryNodeContext(context);
    setWorkingMemorySession({ project_id: projectId || '', active_node_id: context.id });
  }
}

const state = {
  projectId: null,
  autosave: null,
  statusDot: null,
  statusLabel: null,
  statusOverrideTimer: null,
  currentStatus: 'idle',
  listenersAttached: false,
  lifecycleAttached: false,
  navigationGuardAttached: false,
  nodeInteractionAttached: false,
};

function parseProjectContext(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.id) {
      return null;
    }
    return {
      id: String(parsed.id),
      name: typeof parsed.name === 'string' ? parsed.name : '',
    };
  } catch (error) {
    console.warn('Failed to parse stored project context', error);
    return null;
  }
}

function getStoredProjectContext() {
  const raw = window.localStorage.getItem(PROJECT_CONTEXT_STORAGE_KEY);
  return parseProjectContext(raw);
}

function updateStoredProjectContext(projectId, name = '') {
  if (!projectId) {
    window.localStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY);
    window.localStorage.removeItem(PROJECT_STORAGE_KEY);
    return;
  }
  const payload = {
    id: String(projectId),
    name: name ? String(name) : '',
  };
  window.localStorage.setItem(PROJECT_CONTEXT_STORAGE_KEY, JSON.stringify(payload));
  window.localStorage.setItem(PROJECT_STORAGE_KEY, payload.id);
}

function applyProjectInfo() {
  const info = document.querySelector('[data-project-info]');
  const params = new URLSearchParams(window.location.search);
  const queryId = params.get('project') || params.get('project_id');
  let context = getStoredProjectContext();
  let projectId = queryId || context?.id || '';
  if (projectId) {
    if (!context || context.id !== projectId) {
      updateStoredProjectContext(projectId, context?.id === projectId ? context.name : '');
      context = getStoredProjectContext();
    } else {
      updateStoredProjectContext(context.id, context.name);
    }
    projectId = context?.id || projectId;
  }
  if (info) {
    info.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'toolbar-project__label';
    label.textContent = 'Active Project';
    const value = document.createElement('span');
    value.className = 'toolbar-project__value';
    if (projectId) {
      const name = context?.name?.trim();
      value.textContent = name ? `${name} (${projectId})` : projectId;
      value.title = projectId;
    } else {
      value.textContent = 'None selected';
    }
    info.appendChild(label);
    info.appendChild(value);
  }
  if (projectId) {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
  }
  return projectId;
}

function updateStatusIndicator(status) {
  if (!state.statusDot || !state.statusLabel) {
    return;
  }
  const classList = ['status-dot'];
  if (status === 'saving') {
    classList.push('saving');
  } else if (status === 'saved') {
    classList.push('saved');
  } else if (status === 'error') {
    classList.push('error');
  }
  state.statusDot.className = classList.join(' ');
  state.statusLabel.textContent = STATUS_LABELS[status] || STATUS_LABELS.idle;
}

function handleStatusChange(status) {
  state.currentStatus = status;
  if (state.statusOverrideTimer) {
    return;
  }
  updateStatusIndicator(status);
}

function showStatusMessage(message, type = 'saved') {
  if (!state.statusDot || !state.statusLabel) {
    return;
  }
  if (state.statusOverrideTimer) {
    window.clearTimeout(state.statusOverrideTimer);
    state.statusOverrideTimer = null;
  }
  const classList = ['status-dot'];
  if (type === 'error') {
    classList.push('error');
  } else if (type === 'saved') {
    classList.push('saved');
  }
  state.statusDot.className = classList.join(' ');
  state.statusLabel.textContent = message;
  state.statusOverrideTimer = window.setTimeout(() => {
    state.statusOverrideTimer = null;
    updateStatusIndicator(state.currentStatus);
  }, 2400);
}

function handleNodeMutated(event) {
  const detail = event?.detail || {};
  const { node, reason } = detail;
  if (!node) {
    return;
  }
  if (state.projectId && node.projectId && node.projectId !== state.projectId) {
    return;
  }
  if (!node.projectId) {
    node.projectId = state.projectId;
  }
  state.autosave?.markNodeDirty(node, reason);
  syncWorkingMemoryNode(node, state.projectId);
  syncWorkingMemoryStructure(state.projectId);
}

function attachNavigationGuard() {
  if (state.navigationGuardAttached) {
    return;
  }
  const backLink = document.querySelector('.toolbar-back');
  if (!backLink) {
    return;
  }
  backLink.addEventListener('click', (event) => {
    if (!state.autosave?.hasPending()) {
      return;
    }
    event.preventDefault();
    const target = backLink.href;
    state.autosave
      ?.flush()
      .catch((error) => {
        console.warn('Failed to flush autosave before navigation', error);
      })
      .finally(() => {
        window.location.href = target;
      });
  });
  state.navigationGuardAttached = true;
}

function attachLifecycleHooks() {
  if (state.lifecycleAttached) {
    return;
  }
  window.addEventListener('beforeunload', () => {
    if (state.autosave?.hasPending()) {
      state.autosave.flush({ keepalive: true });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      state.autosave?.flush({ keepalive: true });
    }
  });
  state.lifecycleAttached = true;
}

function handleLastInteractedNodeEvent(event) {
  const detail = event?.detail || {};
  const builder = typeof detail.builder === 'string' ? detail.builder.toLowerCase() : '';
  if (builder && builder !== 'project') {
    return;
  }
  const nodeId = detail.nodeId ? String(detail.nodeId) : '';
  if (!nodeId) {
    setWorkingMemoryNodeContext({});
    setWorkingMemorySession({ active_node_id: '' });
    return;
  }
  const node = NodeBase.getLastInteractedNode?.();
  if (!node || String(node.id) !== nodeId) {
    return;
  }
  if (state.projectId && node.projectId && node.projectId !== state.projectId) {
    return;
  }
  syncWorkingMemoryNode(node, state.projectId);
}

function attachNodeInteractionTracker() {
  if (state.nodeInteractionAttached) {
    return;
  }
  window.addEventListener('nodebase:last-interacted', handleLastInteractedNodeEvent);
  state.nodeInteractionAttached = true;
}

const init = async (projectId) => {
  const workspace = document.getElementById('workspace');
  if (!workspace) {
    log('Workspace element missing.');
    return;
  }

  const canvas = ensureCanvas(workspace, { width: 2400, height: 2400 });

  state.projectId = projectId || null;
  initialiseWorkingMemory({ projectId: state.projectId });
  setWorkingMemorySession({ project_id: state.projectId || '' });
  state.statusDot = document.querySelector('[data-status-dot]');
  state.statusLabel = document.querySelector('[data-status-label]');
  state.currentStatus = 'idle';
  state.statusOverrideTimer = null;
  updateStatusIndicator('idle');

  const canvasCenterX = canvas.offsetWidth / 2;
  const canvasCenterY = Math.max(220, canvas.offsetHeight * 0.24);

  const autosave = new AutosaveManager({
    projectId,
    onStatusChange: handleStatusChange,
  });
  state.autosave = autosave;

  if (!state.listenersAttached) {
    document.addEventListener('builder:node-mutated', handleNodeMutated);
    state.listenersAttached = true;
  }
  attachNavigationGuard();
  attachLifecycleHooks();
  attachNodeInteractionTracker();

  const checkpointButton = document.querySelector('[data-action="save-checkpoint"]');
  if (checkpointButton) {
    checkpointButton.addEventListener('click', async () => {
      if (!state.projectId) {
        return;
      }
      checkpointButton.disabled = true;
      try {
        await state.autosave?.flush();
        await createCheckpoint(state.projectId);
        showStatusMessage('Checkpoint saved', 'saved');
      } catch (error) {
        console.error('Failed to save checkpoint', error);
        showStatusMessage('Checkpoint failed', 'error');
      } finally {
        checkpointButton.disabled = false;
      }
    });
  }

  const workingMemoryButton = document.querySelector('[data-action="working-memory"]');
  if (workingMemoryButton) {
    workingMemoryButton.addEventListener('click', () => {
      const lastNode = NodeBase.getLastInteractedNode?.();
      syncWorkingMemoryStructure(state.projectId);
      if (lastNode && (!state.projectId || lastNode.projectId === state.projectId)) {
        syncWorkingMemoryNode(lastNode, state.projectId);
      }
      const activeId = lastNode?.id || '';
      setWorkingMemorySession({ project_id: state.projectId || '', active_node_id: activeId });
      openWorkingMemoryViewer({ nodeOnly: true, nodeId: activeId });
    });
  }

  const nodesById = new Map();
  const attachedChildIds = new Set();

  const instantiateNode = (nodeData) => {
    const meta = nodeData.meta || {};
    const position = meta.position || { x: canvasCenterX, y: canvasCenterY };
    const node = new ProjectNode({
      canvas,
      id: nodeData.id,
      title: nodeData.label || meta.title || nodeData.id,
      x: position.x,
      y: position.y,
      notes: meta.notes || '',
      discussion: meta.discussion || '',
      fullText: meta.fullText ?? nodeData.content ?? '',
      meta,
      projectId,
    });
    node.projectId = projectId;
    node.manualPosition = Boolean(meta.position);
    nodesById.set(node.id, node);
    node.onAddChild = () => handleAddChild(node);
    return node;
  };

  const attachChild = (parent, child, { expand = false } = {}) => {
    if (!parent || !child) {
      return;
    }
    child.parent = parent;
    if (!parent.children.includes(child)) {
      parent.children.push(child);
    }
    parent.onChildrenChanged?.();
    if (expand) {
      if (!parent.expanded) {
        parent.expandChildren();
      } else if (!child.manualPosition) {
        parent.layoutChildren();
      }
      child.show();
    } else {
      if (parent.expanded && !child.manualPosition) {
        parent.layoutChildren();
      }
      if (!parent.expanded) {
        child.hide();
      } else {
        child.show();
      }
    }
  };

  const handleAddChild = async (parent) => {
    const label = window.prompt('Name the new story beat or chapter');
    if (!label) {
      return null;
    }
    const defaultPosition = {
      x: parent.position.x + (parent.childOrbit || 220) * 0.6,
      y: parent.position.y + (parent.childOrbit || 220) * 0.8,
    };
    const meta = {
      builder: 'project',
      position: defaultPosition,
      notes: '',
      discussion: '',
      fullText: '',
      childOrbit: Math.max(160, (parent.childOrbit ?? 220) * 0.78),
      pyramidSpacing: { ...parent.pyramidSpacing },
      projectData: {
        title: label,
        notes: '',
        customFields: [],
      },
    };
    try {
      const created = await createNode({ label, content: '', meta }, { projectId });
      const createdMeta = created?.meta || meta;
      const position = createdMeta.position || defaultPosition;
      const child = new ProjectNode({
        canvas,
        id: created?.id,
        title: created?.label || label,
        x: position.x,
        y: position.y,
        notes: createdMeta.notes || '',
        discussion: createdMeta.discussion || '',
        fullText: created?.content || '',
        meta: createdMeta,
        projectId,
      });
      child.projectId = projectId;
      child.manualPosition = false;
      nodesById.set(child.id, child);
      child.onAddChild = () => handleAddChild(child);
      attachChild(parent, child, { expand: true });
      attachedChildIds.add(child.id);
      try {
        await createEdge(
          {
            from: parent.id,
            to: child.id,
            type: 'CHILD_OF',
            props: { context: 'project' },
          },
          { projectId }
        );
      } catch (edgeError) {
        console.error('Failed to link child node', edgeError);
        showStatusMessage('Child created but link failed', 'error');
      }
      syncWorkingMemoryStructure(projectId);
      syncWorkingMemoryNode(child, projectId);
      return child;
    } catch (error) {
      console.error('Failed to create project child node', error);
      showStatusMessage('Failed to add child node', 'error');
      return null;
    }
  };

  const builderNodes = [];
  try {
    const graph = await fetchGraph(projectId);
    const nodes = graph?.nodes || [];
    const edges = graph?.edges || [];
    const availableElements = nodes
      .filter((node) => (node.meta?.builder || '').toLowerCase() === 'elements')
      .map((nodeData) => {
        const meta = nodeData.meta || {};
        const elementType = ProjectNode.normaliseElementType(
          meta.elementType || meta.type || meta.elementData?.type || 'other'
        );
        const label =
          nodeData.label ||
          meta.title ||
          meta.elementData?.title ||
          (typeof nodeData.id === 'string' ? nodeData.id : String(nodeData.id));
        return {
          id: nodeData.id,
          label,
          type: elementType,
        };
      });
    ProjectNode.setAvailableElements(availableElements, projectId);
    nodes
      .filter((node) => (node.meta?.builder || '').toLowerCase() === 'project')
      .forEach((nodeData) => {
        builderNodes.push(nodeData);
      });

    if (!builderNodes.length) {
      const payload = {
        label: 'Project',
        content: '',
        meta: {
          builder: 'project',
          position: { x: canvasCenterX, y: canvasCenterY },
          notes: '',
          discussion: '',
          fullText: '',
          projectData: {
            title: 'Project',
            notes: '',
            customFields: [],
          },
        },
      };
      try {
        const created = await createNode(payload, { projectId });
        if (created) {
          builderNodes.push(created);
        }
      } catch (creationError) {
        console.error('Failed to seed project root node', creationError);
        showStatusMessage('Failed to initialise project node', 'error');
      }
    }

    builderNodes.forEach((nodeData) => instantiateNode(nodeData));

    edges
      .filter(
        (edge) =>
          (edge.props?.context || '').toLowerCase() === 'project' &&
          (edge.type || '').toUpperCase() === 'CHILD_OF'
      )
      .forEach((edge) => {
        const parent = nodesById.get(edge.from);
        const child = nodesById.get(edge.to);
        if (!parent || !child) {
          return;
        }
        attachChild(parent, child, { expand: false });
        attachedChildIds.add(child.id);
      });
  } catch (error) {
    console.error('Failed to load project graph', error);
    showStatusMessage('Failed to load project data', 'error');
  }

  const rootNodes = [];
  nodesById.forEach((node, id) => {
    if (!attachedChildIds.has(id)) {
      rootNodes.push(node);
    }
  });

  let rootNode = rootNodes[0] || nodesById.values().next().value || null;
  if (!rootNode) {
    rootNode = new ProjectNode({ canvas, x: canvasCenterX, y: canvasCenterY, projectId });
    rootNode.projectId = projectId;
    nodesById.set(rootNode.id, rootNode);
    rootNodes.push(rootNode);
    rootNode.onAddChild = () => handleAddChild(rootNode);
  }

  rootNodes.forEach((node) => {
    node.show();
    node.onAddChild = () => handleAddChild(node);
  });

  const viewport = enableZoomPan(workspace, canvas, {
    minScale: 0.5,
    maxScale: 2.4,
    centerOnLoad: false,
  });

  requestAnimationFrame(() => {
    if (rootNode) {
      viewport.focusOn(
        { x: rootNode.position.x, y: rootNode.position.y },
        {
          scale: 0.82,
          offset: { x: 0, y: -Math.max(140, workspace.clientHeight * 0.18) },
        }
      );
    }
  });

  log('Project builder initialised.');

  syncWorkingMemoryStructure(state.projectId);

  window.builder = {
    util,
    rootNode,
    viewport,
    autosave,
    nodesById,
  };
};

async function bootstrap() {
  const projectId = applyProjectInfo();
  await init(projectId);
}

document.addEventListener('DOMContentLoaded', bootstrap);
