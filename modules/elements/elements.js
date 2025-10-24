import NodeBase from '../../core/nodebase.js';
import util, { enableZoomPan, ensureCanvas } from '../../core/util.js';
import { ElementNode, CharacterNode, PlaceNode, OtherNode } from './ElementNode.js';
import LinkManager from './LinkManager.js';
import AutosaveManager from '../common/autosaveManager.js';
import { fetchGraph, createNode, createCheckpoint } from '../common/api.js';
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

function buildNodeContextFromInstance(node) {
  if (!node) {
    return null;
  }
  const context = {
    id: node.id,
    label: node.title || '',
    content: node.fullText || '',
    meta: cloneForMemory(node.meta || {}),
  };
  if (node.data) {
    context.data = cloneForMemory(node.data);
  }
  if (typeof node.notes === 'string') {
    context.notes = node.notes;
  }
  if (Array.isArray(node.links)) {
    context.links = Array.from(node.links).map((link) => ({
      other: link.nodeA === node ? link.nodeB?.id : link.nodeA?.id,
      notes: link.notes || '',
    })).filter((item) => item.other);
  }
  return context;
}

function buildElementsStructure(projectId, linkManager) {
  const payloadNodes = [];
  if (NodeBase?.instances instanceof Map) {
    NodeBase.instances.forEach((instance) => {
      if (!instance) {
        return;
      }
      const builderType = (instance.meta?.builder || '').toLowerCase();
      if (builderType && builderType !== 'elements') {
        return;
      }
      if (projectId && instance.projectId && instance.projectId !== projectId) {
        return;
      }
      payloadNodes.push({
        id: String(instance.id),
        label: instance.title || '',
        content: instance.fullText || '',
        meta: cloneForMemory(instance.meta || {}),
        project_id: projectId || instance.projectId || '',
      });
    });
  }
  const payloadEdges = [];
  if (linkManager?.links instanceof Map) {
    linkManager.links.forEach((link) => {
      if (!link?.nodeA?.id || !link?.nodeB?.id) {
        return;
      }
      payloadEdges.push({
        from: String(link.nodeA.id),
        to: String(link.nodeB.id),
        type: 'LINKS_TO',
        props: { context: 'elements', notes: link.notes || '' },
      });
    });
  }
  return { project_id: projectId || '', nodes: payloadNodes, edges: payloadEdges };
}

function syncWorkingMemoryStructure(projectId, linkManager) {
  setWorkingMemoryProjectStructure(buildElementsStructure(projectId, linkManager));
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
  linkManager: null,
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
  syncWorkingMemoryStructure(state.projectId, state.linkManager);
}

function handleLinkMutated(event) {
  const detail = event?.detail || {};
  if (!detail.action || !detail.from || !detail.to) {
    return;
  }
  const eventProject = detail.projectId || state.projectId;
  if (state.projectId && eventProject && eventProject !== state.projectId) {
    return;
  }
  const props = { ...(detail.props || {}), context: 'elements' };
  state.autosave?.markLinkChange({
    action: detail.action,
    from: detail.from,
    to: detail.to,
    type: detail.type || 'LINKS_TO',
    props,
  });
  syncWorkingMemoryStructure(state.projectId, state.linkManager);
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

const createElementModal = ({ onSubmit, onClose } = {}) => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const card = document.createElement('div');
  card.className = 'modal-card';

  const heading = document.createElement('h2');
  heading.textContent = 'Create new element';
  card.appendChild(heading);

  const form = document.createElement('form');

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.required = true;
  nameInput.placeholder = 'e.g. Protagonist, City of Glass';
  form.appendChild(nameLabel);
  form.appendChild(nameInput);

  const typeLabel = document.createElement('label');
  typeLabel.textContent = 'Type';
  const typeSelect = document.createElement('select');
  const typeOptions = [
    ['character', 'Character'],
    ['place', 'Place'],
    ['item', 'Item'],
    ['theme', 'Theme'],
    ['other', 'Other'],
  ];
  typeOptions.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    typeSelect.appendChild(option);
  });
  form.appendChild(typeLabel);
  form.appendChild(typeSelect);

  const actions = document.createElement('div');
  actions.className = 'modal-card__actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'modal-card__button';
  cancelButton.textContent = 'Cancel';

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'modal-card__button modal-card__button--primary';
  submitButton.textContent = 'Create';

  actions.appendChild(cancelButton);
  actions.appendChild(submitButton);
  form.appendChild(actions);
  card.appendChild(form);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
    onClose?.();
  };

  const cancel = () => {
    teardown();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  };

  document.addEventListener('keydown', onKeyDown);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      cancel();
    }
  });

  cancelButton.addEventListener('click', cancel);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const type = typeSelect.value;
    const result = onSubmit?.({ name, type });
    if (result && typeof result.then === 'function') {
      result.catch((error) => console.warn('Element creation request rejected', error));
    }
    teardown();
  });

  nameInput.focus();

  return { close: teardown };
};

const init = async (projectId) => {
  const workspace = document.getElementById('workspace');
  if (!workspace) {
    util.log('Workspace element missing for elements builder.');
    return;
  }

  const canvas = ensureCanvas(workspace, { width: 2800, height: 2200 });

  state.projectId = projectId || null;
  initialiseWorkingMemory({ projectId: state.projectId });
  setWorkingMemorySession({ project_id: state.projectId || '' });
  state.statusDot = document.querySelector('[data-status-dot]');
  state.statusLabel = document.querySelector('[data-status-label]');
  state.currentStatus = 'idle';
  state.statusOverrideTimer = null;
  updateStatusIndicator('idle');

  const layout = {
    centerX: canvas.offsetWidth / 2,
    centerY: Math.max(260, canvas.offsetHeight * 0.28),
    spacingX: 320,
    spacingY: 260,
    perRow: 4,
  };

  const elementNodes = [];
  const nodesById = new Map();

  const layoutNodes = () => {
    elementNodes.forEach((node, index) => {
      if (node.manualPosition) {
        return;
      }
      const row = Math.floor(index / layout.perRow);
      const rowStart = row * layout.perRow;
      const itemsInRow = Math.min(layout.perRow, elementNodes.length - rowStart);
      const indexInRow = index - rowStart;
      const offsetX = (indexInRow - (itemsInRow - 1) / 2) * layout.spacingX;
      const offsetY = row * layout.spacingY;
      node.setPosition(layout.centerX + offsetX, layout.centerY + offsetY);
    });
  };

  const linkManager = new LinkManager(canvas);
  ElementNode.attachLinkManager(linkManager);
  state.linkManager = linkManager;

  const autosave = new AutosaveManager({
    projectId,
    onStatusChange: handleStatusChange,
  });
  state.autosave = autosave;

  if (!state.listenersAttached) {
    document.addEventListener('builder:node-mutated', handleNodeMutated);
    document.addEventListener('builder:link-mutated', handleLinkMutated);
    state.listenersAttached = true;
  }
  attachNavigationGuard();
  attachLifecycleHooks();

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

  let activeModal = null;
  let viewport;

  const createElementNode = async ({ name, type }) => {
    const normalizedType = ElementNode.normaliseType(type);
    const node = ElementNode.createNode(normalizedType, {
      canvas,
      title: name,
      x: layout.centerX,
      y: layout.centerY,
      projectId,
    });
    node.projectId = projectId;
    node.manualPosition = false;
    elementNodes.push(node);
    nodesById.set(node.id, node);
    layoutNodes();
    NodeBase.setLastInteractedNode(node);
    if (elementNodes.length === 1 && viewport) {
      viewport.focusOn(
        { x: node.position.x, y: node.position.y },
        {
          scale: 0.88,
          offset: { x: 0, y: -Math.max(120, workspace.clientHeight * 0.16) },
        }
      );
    }

    const payload = node.toPersistence();
    try {
      const created = await createNode(
        { label: payload.label, content: payload.content, meta: payload.meta },
        { projectId }
      );
      if (created?.id && created.id !== node.id) {
        const previousId = node.id;
        nodesById.delete(previousId);
        node.id = created.id;
        if (node.element) {
          node.element.dataset.nodeId = node.id;
        }
        if (NodeBase.instances instanceof Map) {
          NodeBase.instances.delete(previousId);
          NodeBase.instances.set(node.id, node);
        }
      }
      if (created?.meta) {
        node.meta = created.meta;
      }
      nodesById.set(node.id, node);
      syncWorkingMemoryStructure(projectId, linkManager);
      syncWorkingMemoryNode(node, projectId);
      return node;
    } catch (error) {
      console.error('Failed to create element node', error);
      nodesById.delete(node.id);
      const index = elementNodes.indexOf(node);
      if (index >= 0) {
        elementNodes.splice(index, 1);
      }
      NodeBase.unregisterInstance(node);
      node.element?.remove();
      showStatusMessage('Element creation failed', 'error');
      throw error;
    }
  };

  const openCreationModal = () => {
    if (activeModal) {
      return;
    }
    activeModal = createElementModal({
      onSubmit: async ({ name, type }) => {
        try {
          const node = await createElementNode({ name, type });
          NodeBase.setLastInteractedNode(node);
        } catch (error) {
          // Error already handled in createElementNode
        }
      },
      onClose: () => {
        activeModal = null;
      },
    });
  };

  const addButton = document.getElementById('add-element');
  if (addButton) {
    addButton.addEventListener('click', openCreationModal);
  }

  const workingMemoryButton = document.querySelector('[data-action="working-memory"]');
  if (workingMemoryButton) {
    workingMemoryButton.addEventListener('click', () => {
      syncWorkingMemoryStructure(state.projectId, state.linkManager);
      openWorkingMemoryViewer();
    });
  }

  viewport = enableZoomPan(workspace, canvas, {
    minScale: 0.5,
    maxScale: 2.6,
    centerOnLoad: false,
  });

  requestAnimationFrame(() => {
    viewport.focusOn(
      { x: layout.centerX, y: layout.centerY },
      {
        scale: 0.92,
        offset: { x: 0, y: -Math.max(100, workspace.clientHeight * 0.14) },
      }
    );
  });

  linkManager.setEventSuppression(true);
  try {
    const graph = await fetchGraph(projectId);
    const nodes = graph?.nodes || [];
    const edges = graph?.edges || [];
    const availableProjects = nodes
      .filter((node) => (node.meta?.builder || '').toLowerCase() === 'project')
      .map((nodeData) => {
        const meta = nodeData.meta || {};
        const label =
          nodeData.label ||
          meta.title ||
          meta.projectData?.title ||
          (typeof nodeData.id === 'string' ? nodeData.id : String(nodeData.id));
        return {
          id: nodeData.id,
          label,
        };
      });
    ElementNode.setAvailableProjectNodes(availableProjects, projectId);
    nodes
      .filter((node) => (node.meta?.builder || '').toLowerCase() === 'elements')
      .forEach((nodeData) => {
        const meta = nodeData.meta || {};
        const type = ElementNode.normaliseType(meta.elementType || meta.type || 'other');
        const position = meta.position;
        const node = ElementNode.createNode(type, {
          canvas,
          id: nodeData.id,
          title: nodeData.label || meta.title || nodeData.id,
          x: position?.x ?? layout.centerX,
          y: position?.y ?? layout.centerY,
          notes: meta.notes || '',
          discussion: meta.discussion || '',
          fullText: meta.fullText ?? nodeData.content ?? '',
          data: meta.elementData || null,
          color: meta.color || undefined,
          meta,
          projectId,
        });
        node.projectId = projectId;
        node.manualPosition = Boolean(position);
        elementNodes.push(node);
        nodesById.set(node.id, node);
      });
    layoutNodes();

    const processedLinks = new Set();
    edges.forEach((edge) => {
      if ((edge.props?.context || '').toLowerCase() !== 'elements') {
        return;
      }
      const fromNode = nodesById.get(edge.from);
      const toNode = nodesById.get(edge.to);
      if (!fromNode || !toNode) {
        return;
      }
      const linkId = linkManager.getLinkId(fromNode, toNode);
      if (processedLinks.has(linkId)) {
        const existing = linkManager.links.get(linkId);
        if (existing) {
          existing.notes = edge.props?.notes || existing.notes || '';
          existing.projectId = projectId;
        }
        return;
      }
      processedLinks.add(linkId);
      linkManager.createLink(fromNode, toNode, linkId);
      const link = linkManager.links.get(linkId);
      if (link) {
        link.notes = edge.props?.notes || '';
        link.projectId = projectId;
      }
    });
  } catch (error) {
    console.error('Failed to load element graph', error);
    showStatusMessage('Failed to load project data', 'error');
  } finally {
    linkManager.setEventSuppression(false);
  }

  util.log('Elements builder initialised.');

  syncWorkingMemoryStructure(state.projectId, linkManager);

  window.builder = {
    util,
    ElementNode,
    CharacterNode,
    PlaceNode,
    OtherNode,
    LinkManager,
    linkManager,
    viewport,
    elementNodes,
    createElementNode,
    layoutNodes,
    autosave,
  };
};

async function bootstrap() {
  const projectId = applyProjectInfo();
  await init(projectId);
}

document.addEventListener('DOMContentLoaded', bootstrap);
