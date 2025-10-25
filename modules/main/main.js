import {
  initialiseWorkingMemory,
  setWorkingMemorySession,
  setWorkingMemoryProjectStructure,
  setWorkingMemoryNodeContext,
  setWorkingMemoryMessages,
  setWorkingMemoryWorkingHistory,
  appendWorkingMemoryMessage,
  getWorkingMemorySettings,
  updateWorkingMemorySettings,
  subscribeWorkingMemorySettings,
  resetWorkingMemory,
} from '../common/workingMemory.js';
import { openWorkingMemoryViewer } from '../common/workingMemoryViewer.js';

const AUTOSAVE_DELAY = 1600;
const DEFAULT_VERSION_INTERVAL = 6000;
const API_BASE = '/api';
const PROJECT_STORAGE_KEY = 'story-graph-project';
const PROJECT_CONTEXT_STORAGE_KEY = 'story-graph-project-context';
const SESSION_STORAGE_PREFIX = 'story-graph-session:';
const USER_ID_STORAGE_KEY = 'story-graph-user-id';

const state = {
  appConfig: {},
  configError: null,
  projectId: null,
  projectName: '',
  session: null,
  sessionError: null,
  graphNodes: [],
  graphEdges: [],
  selectedNodeId: null,
  draftNode: null,
  autosaveState: 'idle',
  isDirty: false,
  errorBanner: null,
  messages: [],
  messagesStatus: 'idle',
  newMessage: '',
  summary: null,
  summaryDraft: '',
  checkpoints: [],
  checkpointName: '',
  newMetaKey: '',
  newMetaValue: '',
  newEdgeTarget: '',
  newEdgeType: 'LINKS_TO',
  newEdgeDirection: 'outgoing',
  versionCursor: null,
};

const runtime = {
  autosaveTimer: null,
  versionInterval: null,
  seededPositions: new Set(),
  nodeElements: new Map(),
  edgeElements: [],
  dragging: null,
  workingMemorySettingsUnsubscribe: null,
};

const ui = { workingMemoryControls: null, workingMemoryButton: null };

function ensureWorkingMemorySettingsUI(settings) {
  if (!ui.workingMemoryPanel) {
    return null;
  }

  if (
    ui.workingMemoryControls &&
    ui.workingMemoryControls.historyInput &&
    ui.workingMemoryPanel.contains(ui.workingMemoryControls.historyInput)
  ) {
    return ui.workingMemoryControls;
  }

  ui.workingMemoryPanel.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Working Memory Settings';
  ui.workingMemoryPanel.appendChild(heading);

  const description = document.createElement('p');
  description.textContent = 'Control how the local working memory bundle is assembled for the active project.';
  ui.workingMemoryPanel.appendChild(description);

  const historyField = document.createElement('div');
  historyField.className = 'field';
  const historyLabel = document.createElement('label');
  historyLabel.textContent = 'History length';
  const historyInput = document.createElement('input');
  historyInput.type = 'number';
  historyInput.min = '1';
  historyInput.max = String(200);
  historyInput.value = String(settings.history_length || 20);
  historyInput.addEventListener('change', () => {
    const parsed = Number.parseInt(historyInput.value, 10);
    const currentSettings = getWorkingMemorySettings();
    updateWorkingMemorySettings({ history_length: Number.isNaN(parsed) ? currentSettings.history_length : parsed });
  });
  historyField.appendChild(historyLabel);
  historyField.appendChild(historyInput);
  ui.workingMemoryPanel.appendChild(historyField);

  const toggleGroup = document.createElement('div');
  toggleGroup.className = 'toggle-group';
  const toggleDefinitions = [
    { key: 'include_project_structure', label: 'Include project structure' },
    { key: 'include_context', label: 'Include node context' },
    { key: 'include_working_history', label: 'Include working history' },
  ];
  const toggles = {};
  toggleDefinitions.forEach(({ key, label }) => {
    const row = document.createElement('label');
    row.className = 'toggle-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(settings[key]);
    checkbox.addEventListener('change', () => {
      updateWorkingMemorySettings({ [key]: checkbox.checked });
    });
    const text = document.createElement('span');
    text.textContent = label;
    row.appendChild(checkbox);
    row.appendChild(text);
    toggleGroup.appendChild(row);
    toggles[key] = checkbox;
  });
  ui.workingMemoryPanel.appendChild(toggleGroup);

  const autoRefreshField = document.createElement('div');
  autoRefreshField.className = 'field';
  const autoRefreshLabel = document.createElement('label');
  autoRefreshLabel.textContent = 'Auto-refresh interval (ms)';
  const autoRefreshInput = document.createElement('input');
  autoRefreshInput.type = 'number';
  autoRefreshInput.min = '0';
  autoRefreshInput.placeholder = '0 (disabled)';
  autoRefreshInput.value = settings.auto_refresh_interval ? String(settings.auto_refresh_interval) : '';
  autoRefreshInput.addEventListener('change', () => {
    const trimmed = autoRefreshInput.value.trim();
    updateWorkingMemorySettings({
      auto_refresh_interval: trimmed === '' ? 0 : Number.parseInt(trimmed, 10),
    });
  });
  autoRefreshField.appendChild(autoRefreshLabel);
  autoRefreshField.appendChild(autoRefreshInput);
  ui.workingMemoryPanel.appendChild(autoRefreshField);

  const actions = document.createElement('div');
  actions.className = 'working-memory-actions';
  const viewButton = document.createElement('button');
  viewButton.type = 'button';
  viewButton.className = 'secondary-button';
  viewButton.textContent = 'View working memory';
  viewButton.addEventListener('click', () => {
    openWorkingMemoryViewer();
  });
  actions.appendChild(viewButton);
  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.textContent = 'Reset Working Memory';
  resetButton.addEventListener('click', () => {
    const activeNodeId = state.selectedNodeId || '';
    resetWorkingMemory();
    initialiseWorkingMemory({
      projectId: state.projectId || '',
      sessionId: state.session?.id || '',
      activeNodeId,
    });
    syncWorkingMemoryProjectStructure();
    syncWorkingMemoryNodeContext();
    syncWorkingMemoryMessages();
    syncWorkingMemoryWorkingHistory();
    syncWorkingMemorySession();
  });
  actions.appendChild(resetButton);
  ui.workingMemoryPanel.appendChild(actions);

  ui.workingMemoryControls = { historyInput, toggles, autoRefreshInput };
  return ui.workingMemoryControls;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

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
        type: typeof item.type === 'string' && item.type ? item.type : '',
      };
    })
    .filter(Boolean);
}

function deriveNodeTypeForMemory(node = {}) {
  const meta = node.meta || {};
  if (typeof meta.elementType === 'string' && meta.elementType.trim()) {
    return meta.elementType.trim();
  }
  if (typeof node.type === 'string' && node.type.trim()) {
    return node.type.trim();
  }
  if (typeof meta.builder === 'string' && meta.builder.trim()) {
    return meta.builder.trim();
  }
  return 'project';
}

function buildWorkingMemoryMeta(meta = {}, extras = {}) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const result = {};
  const noteCandidates = [
    extras.notes,
    source.notes,
    source.projectData?.notes,
    source.elementData?.notes,
  ];
  const note = noteCandidates.find((value) => typeof value === 'string' && value.trim());
  if (note) {
    result.notes = note;
  }
  const customFieldsSource =
    extras.customFields ||
    source.customFields ||
    source.projectData?.customFields ||
    source.elementData?.customFields ||
    [];
  const customFields = sanitiseCustomFields(customFieldsSource);
  if (customFields.length) {
    result.customFields = cloneForMemory(customFields);
  }
  const linkedSource = extras.linked_elements || source.linked_elements || [];
  const linkedElements = sanitiseLinkedElements(linkedSource);
  if (linkedElements.length) {
    result.linked_elements = cloneForMemory(linkedElements);
  }
  return result;
}

function buildProjectStructurePayload() {
  if (!state.projectId) {
    return { nodes: [], edges: [] };
  }
  const nodes = state.graphNodes.map((node) => ({
    id: String(node.id),
    label: node.label || '',
    type: deriveNodeTypeForMemory(node),
  }));
  const edges = state.graphEdges.map((edge) => ({
    from: String(edge.from),
    to: String(edge.to),
    type: edge.type || 'LINKS_TO',
  }));
  return { nodes, edges };
}

function syncWorkingMemoryProjectStructure() {
  const payload = buildProjectStructurePayload();
  if (state.projectId) {
    setWorkingMemorySession({ project_id: state.projectId });
  }
  setWorkingMemoryProjectStructure(payload);
}

function buildNodeContextPayload() {
  if (!state.draftNode) {
    return null;
  }
  const context = {
    id: state.draftNode.id,
    label: state.draftNode.label || '',
    type: deriveNodeTypeForMemory(state.draftNode),
    meta: buildWorkingMemoryMeta(state.draftNode.meta || {}, {
      notes: state.draftNode.notes ?? state.draftNode.meta?.notes,
      customFields:
        state.draftNode.meta?.projectData?.customFields ||
        state.draftNode.meta?.elementData?.customFields ||
        state.draftNode.projectData?.customFields ||
        [],
      linked_elements: state.draftNode.meta?.linked_elements || [],
    }),
  };
  return context;
}

function syncWorkingMemoryNodeContext() {
  const context = buildNodeContextPayload();
  if (!context) {
    setWorkingMemoryNodeContext({});
    setWorkingMemorySession({ active_node_id: '' });
    return;
  }
  setWorkingMemoryNodeContext(context);
  setWorkingMemorySession({ active_node_id: context.id });
}

function syncWorkingMemoryMessages() {
  const messages = Array.isArray(state.messages)
    ? state.messages.map((message) => ({
        id: message.id,
        session_id: message.session_id,
        node_id: message.node_id,
        role: message.role,
        content: message.content,
        created_at: message.created_at,
      }))
    : [];
  setWorkingMemoryMessages(messages);
}

function syncWorkingMemoryWorkingHistory() {
  if (state.summary && typeof state.summary === 'object' && typeof state.summary.text === 'string') {
    setWorkingMemoryWorkingHistory(state.summary.text);
  } else if (typeof state.summary === 'string') {
    setWorkingMemoryWorkingHistory(state.summary);
  } else {
    setWorkingMemoryWorkingHistory('');
  }
}

function resetWorkingMemoryForProject(projectId) {
  initialiseWorkingMemory({ projectId });
  setWorkingMemoryProjectStructure({ nodes: [], edges: [] });
  setWorkingMemoryNodeContext({});
  setWorkingMemoryMessages([]);
  setWorkingMemoryWorkingHistory('');
  setWorkingMemorySession({ project_id: projectId || '', active_node_id: '' });
}

function syncWorkingMemorySession() {
  const sessionId = state.session?.id ? String(state.session.id) : '';
  const projectId = state.projectId || state.session?.project_id || '';
  const activeNode = state.selectedNodeId || state.session?.active_node || '';
  setWorkingMemorySession({ session_id: sessionId, project_id: projectId, active_node_id: activeNode });
}

async function fetchJSON(url, options = {}) {
  const finalOptions = { ...options };
  finalOptions.headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (finalOptions.body && typeof finalOptions.body !== 'string') {
    finalOptions.body = JSON.stringify(finalOptions.body);
  }
  const response = await fetch(url, finalOptions);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (data && data.error) {
        message = data.error;
      } else if (typeof data === 'string') {
        message = data;
      }
    } catch (err) {
      const text = await response.text();
      if (text) message = text;
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function normaliseProjectId(value, fallback) {
  const trimmed = (value || '').trim();
  return trimmed || fallback;
}

function parseProjectContext(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.id) return null;
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

function updateStoredProjectContext(context) {
  if (!context || !context.id) {
    window.localStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY);
    window.localStorage.removeItem(PROJECT_STORAGE_KEY);
    return;
  }
  const payload = {
    id: String(context.id),
    name: context.name ? String(context.name) : '',
  };
  window.localStorage.setItem(PROJECT_CONTEXT_STORAGE_KEY, JSON.stringify(payload));
  window.localStorage.setItem(PROJECT_STORAGE_KEY, payload.id);
}

function ensureProjectContext(projectId) {
  if (!projectId) {
    window.localStorage.removeItem(PROJECT_CONTEXT_STORAGE_KEY);
    window.localStorage.removeItem(PROJECT_STORAGE_KEY);
    return null;
  }
  const context = getStoredProjectContext();
  if (context?.id === projectId) {
    updateStoredProjectContext(context);
    return context;
  }
  const payload = { id: projectId, name: '' };
  updateStoredProjectContext(payload);
  return payload;
}

function getProjectNameForId(projectId) {
  if (!projectId) return '';
  const context = getStoredProjectContext();
  if (context?.id === projectId) {
    return context.name || '';
  }
  return '';
}

function determineProjectId(config) {
  const defaultId = config?.default_project_id || 'default_project';
  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get('project') || params.get('project_id');
  const storedContext = getStoredProjectContext();
  const stored = window.localStorage.getItem(PROJECT_STORAGE_KEY);
  const finalId = normaliseProjectId(
    queryValue,
    normaliseProjectId(storedContext?.id, normaliseProjectId(stored, defaultId))
  );
  window.localStorage.setItem(PROJECT_STORAGE_KEY, finalId);
  ensureProjectContext(finalId);
  return finalId;
}

function getOrCreateUserId() {
  const existing = window.localStorage.getItem(USER_ID_STORAGE_KEY);
  if (existing) return existing;
  const userId = `guest_${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(USER_ID_STORAGE_KEY, userId);
  return userId;
}

async function getOrCreateSession(projectId) {
  const key = `${SESSION_STORAGE_PREFIX}${projectId}`;
  const cached = window.localStorage.getItem(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed?.id && parsed?.project_id === projectId) {
        return parsed;
      }
    } catch (err) {
      console.warn('Failed to parse cached session', err);
    }
  }
  const userId = getOrCreateUserId();
  const created = await fetchJSON(`${API_BASE}/sessions`, {
    method: 'POST',
    body: { user_id: userId, project_id: projectId },
  });
  const stored = { ...created, user_id: userId, project_id: projectId };
  window.localStorage.setItem(key, JSON.stringify(stored));
  return stored;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function parseMetaValue(input) {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (!Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return input;
  }
}

function stringifyMetaValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function cloneNode(node) {
  return {
    ...node,
    meta: node.meta ? JSON.parse(JSON.stringify(node.meta)) : {},
  };
}

function maybeParseMetaValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  const isComposite = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!isComposite) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return value;
  }
}

function normaliseMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    if (typeof meta === 'string') {
      const parsed = maybeParseMetaValue(meta);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
    return {};
  }
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => {
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          return [
            key,
            value.map((item) => (item && typeof item === 'object' ? normaliseMeta(item) : maybeParseMetaValue(item))),
          ];
        }
        return [key, normaliseMeta(value)];
      }
      return [key, maybeParseMetaValue(value)];
    })
  );
}

function hydrateNode(node) {
  if (!node) return node;
  return {
    ...node,
    meta: normaliseMeta(node.meta),
  };
}

function setErrorBanner(message) {
  state.errorBanner = message;
  renderErrorBanner();
}

function clearErrorBanner() {
  if (state.errorBanner) {
    state.errorBanner = null;
    renderErrorBanner();
  }
}

function updateAutosaveState(status) {
  state.autosaveState = status;
  renderStatus();
}

function getStatusLabel() {
  switch (state.autosaveState) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Autosave failed';
    case 'idle':
      return 'Idle';
    case 'dirty':
      return 'Editing…';
    default:
      return 'Idle';
  }
}

function renderStatus() {
  if (!ui.statusDot || !ui.statusLabel) return;
  ui.statusDot.className = `status-dot ${state.autosaveState}`;
  ui.statusLabel.textContent = getStatusLabel();
}

function renderProjectBadge() {
  if (!ui.projectBadge) return;
  ui.projectBadge.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'header-project-label';
  label.textContent = 'Active Project';
  const value = document.createElement('strong');
  value.className = 'header-project-value';
  if (state.projectId) {
    const name = state.projectName?.trim();
    value.textContent = name ? `${name} (${state.projectId})` : state.projectId;
    value.title = state.projectId;
  } else {
    value.textContent = 'None selected';
  }
  ui.projectBadge.appendChild(label);
  ui.projectBadge.appendChild(value);
}

function renderErrorBanner() {
  if (!ui.errorBanner || !ui.errorMessage) return;
  if (state.errorBanner) {
    ui.errorBanner.classList.remove('hidden');
    ui.errorMessage.textContent = state.errorBanner;
  } else {
    ui.errorBanner.classList.add('hidden');
    ui.errorMessage.textContent = '';
  }
}

function renderSessionPanel() {
  if (!ui.sessionPanel) return;
  ui.sessionPanel.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Session';
  ui.sessionPanel.appendChild(heading);

  if (state.projectId) {
    const projectField = document.createElement('div');
    projectField.className = 'field';
    const projectLabel = document.createElement('label');
    projectLabel.textContent = 'Project';
    const projectValue = document.createElement('div');
    projectValue.textContent = state.projectName || state.projectId;
    projectValue.title = state.projectId;
    projectField.appendChild(projectLabel);
    projectField.appendChild(projectValue);
    ui.sessionPanel.appendChild(projectField);

    const idField = document.createElement('div');
    idField.className = 'field';
    const idLabel = document.createElement('label');
    idLabel.textContent = 'Project ID';
    const idValue = document.createElement('div');
    idValue.textContent = state.projectId;
    idField.appendChild(idLabel);
    idField.appendChild(idValue);
    ui.sessionPanel.appendChild(idField);
  }

  if (state.configError) {
    const banner = document.createElement('div');
    banner.className = 'summary-banner';
    const title = document.createElement('h3');
    title.textContent = 'Configuration warning';
    const message = document.createElement('p');
    message.textContent = state.configError;
    banner.appendChild(title);
    banner.appendChild(message);
    ui.sessionPanel.appendChild(banner);
  }

  if (state.sessionError) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.sessionError;
    ui.sessionPanel.appendChild(empty);
  }

  if (state.session && !state.sessionError) {
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.textContent = 'Session';
    const value = document.createElement('div');
    value.textContent = state.session.id;
    field.appendChild(label);
    field.appendChild(value);
    ui.sessionPanel.appendChild(field);
  }

  if (state.summary && state.summary.text) {
    const banner = document.createElement('div');
    banner.className = 'summary-banner';
    const title = document.createElement('h3');
    title.textContent = 'Summary';
    const message = document.createElement('p');
    message.textContent = state.summary.text;
    banner.appendChild(title);
    banner.appendChild(message);
    ui.sessionPanel.appendChild(banner);
  }
}

function renderWorkingMemorySettings() {
  if (!ui.workingMemoryPanel) return;

  const settings = getWorkingMemorySettings();
  const controls = ensureWorkingMemorySettingsUI(settings);
  if (!controls) {
    return;
  }

  const historyValue = String(settings.history_length || 20);
  if (controls.historyInput !== document.activeElement && controls.historyInput.value !== historyValue) {
    controls.historyInput.value = historyValue;
  }

  if (
    controls.autoRefreshInput &&
    controls.autoRefreshInput !== document.activeElement
  ) {
    const nextValue = settings.auto_refresh_interval ? String(settings.auto_refresh_interval) : '';
    if (controls.autoRefreshInput.value !== nextValue) {
      controls.autoRefreshInput.value = nextValue;
    }
  }

  Object.entries(controls.toggles || {}).forEach(([key, checkbox]) => {
    const next = Boolean(settings[key]);
    if (checkbox.checked !== next) {
      checkbox.checked = next;
    }
  });
}

function renderNodeInspector() {
  if (!ui.nodeInspector) return;
  ui.nodeInspector.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Node inspector';
  ui.nodeInspector.appendChild(heading);

  if (!state.draftNode) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select a node to edit details.';
    ui.nodeInspector.appendChild(empty);
    return;
  }

  const labelField = document.createElement('div');
  labelField.className = 'field';
  const labelLabel = document.createElement('label');
  labelLabel.textContent = 'Label';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.value = state.draftNode.label || '';
  labelInput.addEventListener('input', (event) => {
    state.draftNode.label = event.target.value;
    state.isDirty = true;
    updateAutosaveState('dirty');
    scheduleAutosave();
    syncWorkingMemoryNodeContext();
  });
  labelField.appendChild(labelLabel);
  labelField.appendChild(labelInput);
  ui.nodeInspector.appendChild(labelField);

  const contentField = document.createElement('div');
  contentField.className = 'field';
  const contentLabel = document.createElement('label');
  contentLabel.textContent = 'Content';
  const contentInput = document.createElement('textarea');
  contentInput.value = state.draftNode.content || '';
  contentInput.addEventListener('input', (event) => {
    state.draftNode.content = event.target.value;
    state.isDirty = true;
    updateAutosaveState('dirty');
    scheduleAutosave();
    syncWorkingMemoryNodeContext();
  });
  contentField.appendChild(contentLabel);
  contentField.appendChild(contentInput);
  ui.nodeInspector.appendChild(contentField);

  const metaField = document.createElement('div');
  metaField.className = 'field';
  const metaLabel = document.createElement('label');
  metaLabel.textContent = 'Metadata';
  metaField.appendChild(metaLabel);

  const metaGrid = document.createElement('div');
  metaGrid.className = 'meta-grid';
  const entries = Object.entries(state.draftNode.meta || {});
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'meta-empty';
    empty.textContent = 'No metadata yet.';
    metaGrid.appendChild(empty);
  }
  entries.forEach(([key, value]) => {
    const originalKey = key;
    const row = document.createElement('div');
    row.className = 'meta-row';
    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.value = key;
    keyInput.addEventListener('change', (event) => {
      const nextKey = event.target.value.trim();
      const meta = { ...(state.draftNode.meta || {}) };
      const currentValue = meta[originalKey];
      delete meta[originalKey];
      if (nextKey) {
        meta[nextKey] = currentValue;
      }
      state.draftNode.meta = meta;
      state.isDirty = true;
      updateAutosaveState('dirty');
      scheduleAutosave();
      syncWorkingMemoryNodeContext();
      renderNodeInspector();
    });
    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.value = stringifyMetaValue(value);
    valueInput.addEventListener('input', (event) => {
      const parsed = parseMetaValue(event.target.value);
      const meta = { ...(state.draftNode.meta || {}) };
      meta[key] = parsed;
      state.draftNode.meta = meta;
      state.isDirty = true;
      updateAutosaveState('dirty');
      scheduleAutosave();
      syncWorkingMemoryNodeContext();
    });
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'secondary-button';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      const meta = { ...(state.draftNode.meta || {}) };
      delete meta[originalKey];
      state.draftNode.meta = meta;
      state.isDirty = true;
      updateAutosaveState('dirty');
      scheduleAutosave();
      syncWorkingMemoryNodeContext();
      renderNodeInspector();
    });
    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(removeButton);
    metaGrid.appendChild(row);
  });

  const newRow = document.createElement('div');
  newRow.className = 'meta-row meta-row--new';
  const newKeyInput = document.createElement('input');
  newKeyInput.type = 'text';
  newKeyInput.placeholder = 'key';
  newKeyInput.value = state.newMetaKey;
  const newValueInput = document.createElement('input');
  newValueInput.type = 'text';
  newValueInput.placeholder = 'value';
  newValueInput.value = state.newMetaValue;
  newValueInput.addEventListener('input', (event) => {
    state.newMetaValue = event.target.value;
  });
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.textContent = 'Add';
  addButton.disabled = !state.newMetaKey.trim();
  newKeyInput.addEventListener('input', (event) => {
    state.newMetaKey = event.target.value;
    addButton.disabled = !state.newMetaKey.trim();
  });
  addButton.addEventListener('click', () => {
    if (!state.newMetaKey.trim()) return;
    const parsed = parseMetaValue(state.newMetaValue);
    state.draftNode.meta = { ...(state.draftNode.meta || {}), [state.newMetaKey.trim()]: parsed };
    state.newMetaKey = '';
    state.newMetaValue = '';
    state.isDirty = true;
    updateAutosaveState('dirty');
    scheduleAutosave();
    syncWorkingMemoryNodeContext();
    renderNodeInspector();
  });
  newRow.appendChild(newKeyInput);
  newRow.appendChild(newValueInput);
  newRow.appendChild(addButton);
  metaGrid.appendChild(newRow);
  metaField.appendChild(metaGrid);
  ui.nodeInspector.appendChild(metaField);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'secondary-button';
  deleteButton.textContent = 'Delete node';
  deleteButton.addEventListener('click', handleDeleteNode);
  ui.nodeInspector.appendChild(deleteButton);
}

function renderEdgesPanel() {
  if (!ui.edgesPanel) return;
  ui.edgesPanel.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Edges';
  ui.edgesPanel.appendChild(heading);

  if (!state.selectedNodeId) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select a node to inspect edges.';
    ui.edgesPanel.appendChild(empty);
    return;
  }

  const connected = state.graphEdges.filter(
    (edge) => edge.from === state.selectedNodeId || edge.to === state.selectedNodeId
  );

  if (connected.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No edges linked.';
    ui.edgesPanel.appendChild(empty);
  } else {
    connected.forEach((edge) => {
      const item = document.createElement('div');
      item.className = 'checkpoint-item';
      const span = document.createElement('span');
      const direction = edge.from === state.selectedNodeId ? '→' : '←';
      const other = edge.from === state.selectedNodeId ? edge.to : edge.from;
      const strong = document.createElement('strong');
      strong.textContent = `${direction} ${other}`;
      const time = document.createElement('time');
      time.textContent = edge.type || 'LINKS_TO';
      span.appendChild(strong);
      span.appendChild(time);
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'secondary-button';
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => handleDeleteEdge(edge));
      item.appendChild(span);
      item.appendChild(removeButton);
      ui.edgesPanel.appendChild(item);
    });
  }

  const form = document.createElement('form');
  form.className = 'edge-form';
  form.addEventListener('submit', handleAddEdge);

  const targetLabel = document.createElement('label');
  targetLabel.textContent = 'Create connection';
  form.appendChild(targetLabel);

  const controlRow = document.createElement('div');
  controlRow.className = 'edge-form__controls';

  const directionSelect = document.createElement('select');
  directionSelect.innerHTML = `
    <option value="outgoing">From selected → target</option>
    <option value="incoming">From target → selected</option>
  `;
  directionSelect.value = state.newEdgeDirection;
  directionSelect.addEventListener('change', (event) => {
    state.newEdgeDirection = event.target.value;
  });

  const targetSelect = document.createElement('select');
  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = 'Choose node';
  targetSelect.appendChild(placeholderOption);
  const nodes = state.graphNodes.filter((node) => node.id !== state.selectedNodeId);
  const availableIds = nodes.map((node) => node.id);
  nodes.forEach((node) => {
    const option = document.createElement('option');
    option.value = node.id;
    option.textContent = node.label || node.id;
    targetSelect.appendChild(option);
  });
  if (!availableIds.includes(state.newEdgeTarget)) {
    state.newEdgeTarget = '';
  }
  targetSelect.value = state.newEdgeTarget;
  const typeInput = document.createElement('input');
  typeInput.type = 'text';
  typeInput.placeholder = 'Type (default LINKS_TO)';
  typeInput.value = state.newEdgeType;
  typeInput.addEventListener('input', (event) => {
    state.newEdgeType = event.target.value;
  });

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.textContent = 'Add edge';
  submitButton.disabled = !state.newEdgeTarget;

  targetSelect.addEventListener('change', (event) => {
    state.newEdgeTarget = event.target.value;
    submitButton.disabled = !state.newEdgeTarget;
  });

  controlRow.appendChild(directionSelect);
  controlRow.appendChild(targetSelect);
  controlRow.appendChild(typeInput);
  controlRow.appendChild(submitButton);
  form.appendChild(controlRow);
  ui.edgesPanel.appendChild(form);
}

function renderMessagesPanel() {
  if (!ui.messagesPanel) return;
  ui.messagesPanel.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Messages';
  ui.messagesPanel.appendChild(heading);

  if (state.messagesStatus === 'loading') {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Loading messages…';
    ui.messagesPanel.appendChild(empty);
  } else if (state.messagesStatus === 'error') {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Failed to load messages.';
    ui.messagesPanel.appendChild(empty);
  } else if (state.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No messages yet.';
    ui.messagesPanel.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'messages';
    state.messages.forEach((message) => {
      const item = document.createElement('div');
      item.className = 'message';
      const header = document.createElement('div');
      header.className = 'message-header';
      const role = document.createElement('span');
      role.textContent = message.role;
      const time = document.createElement('span');
      time.textContent = formatDate(message.created_at);
      header.appendChild(role);
      header.appendChild(time);
      const content = document.createElement('div');
      content.className = 'message-content';
      content.textContent = message.content;
      item.appendChild(header);
      item.appendChild(content);
      list.appendChild(item);
    });
    ui.messagesPanel.appendChild(list);
  }

  const form = document.createElement('form');
  form.className = 'messages-form';
  form.addEventListener('submit', handleMessageSubmit);
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Leave a note about this session';
  textarea.value = state.newMessage;
  textarea.addEventListener('input', (event) => {
    state.newMessage = event.target.value;
    submit.disabled = !state.newMessage.trim() || !state.session;
  });
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Add message';
  submit.disabled = !state.newMessage.trim() || !state.session;
  form.appendChild(textarea);
  form.appendChild(submit);
  ui.messagesPanel.appendChild(form);
}

function renderSummaryPanel() {
  if (!ui.summaryPanel) return;
  ui.summaryPanel.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Summary';
  ui.summaryPanel.appendChild(heading);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Save summary';
  button.disabled = !state.summaryDraft.trim() || !state.session;
  button.addEventListener('click', handleSaveSummary);
  ui.summaryPanel.appendChild(button);

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Summarise what changed...';
  textarea.value = state.summaryDraft;
  textarea.addEventListener('input', (event) => {
    state.summaryDraft = event.target.value;
    button.disabled = !state.summaryDraft.trim() || !state.session;
  });
  ui.summaryPanel.insertBefore(textarea, button);
}

function renderCheckpointsPanel() {
  if (!ui.checkpointsPanel) return;
  ui.checkpointsPanel.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Checkpoints';
  ui.checkpointsPanel.appendChild(heading);

  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.textContent = 'New checkpoint';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Checkpoint name';
  input.value = state.checkpointName;
  input.addEventListener('input', (event) => {
    state.checkpointName = event.target.value;
    button.disabled = !state.checkpointName.trim() || !state.projectId;
  });
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Save checkpoint';
  button.disabled = !state.checkpointName.trim() || !state.projectId;
  button.addEventListener('click', handleSaveCheckpoint);
  field.appendChild(label);
  field.appendChild(input);
  field.appendChild(button);
  ui.checkpointsPanel.appendChild(field);

  const list = document.createElement('div');
  list.className = 'checkpoint-list';
  if (state.checkpoints.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No checkpoints saved yet.';
    list.appendChild(empty);
  } else {
    state.checkpoints.forEach((checkpoint) => {
      const item = document.createElement('div');
      item.className = 'checkpoint-item';
      const span = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = checkpoint.name;
      const time = document.createElement('time');
      time.textContent = formatDate(checkpoint.created_at);
      span.appendChild(strong);
      span.appendChild(time);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'secondary-button';
      restore.textContent = 'Restore';
      restore.addEventListener('click', () => handleRestoreCheckpoint(checkpoint.id));
      item.appendChild(span);
      item.appendChild(restore);
      list.appendChild(item);
    });
  }
  ui.checkpointsPanel.appendChild(list);
}

function renderGraph() {
  if (!ui.graphCanvas) return;
  const svg = ui.graphCanvas;
  const NS = 'http://www.w3.org/2000/svg';
  runtime.nodeElements.clear();
  runtime.edgeElements = [];

  while (svg.firstChild) {
    svg.removeChild(svg.firstChild);
  }

  const nodes = state.graphNodes;
  const edges = state.graphEdges;

  if (ui.graphEmpty) {
    ui.graphEmpty.style.display = nodes.length ? 'none' : 'flex';
  }

  if (nodes.length === 0) {
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  nodes.forEach((node, index) => {
    const position = node.meta?.position;
    if (position && typeof position.x === 'number' && typeof position.y === 'number') {
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x);
      maxY = Math.max(maxY, position.y);
    } else {
      const fallback = {
        x: 200 + (index % 4) * 220,
        y: 160 + Math.floor(index / 4) * 200,
      };
      minX = Math.min(minX, fallback.x);
      minY = Math.min(minY, fallback.y);
      maxX = Math.max(maxX, fallback.x);
      maxY = Math.max(maxY, fallback.y);
    }
  });
  if (minX === Infinity) {
    minX = 0;
    maxX = 1200;
    minY = 0;
    maxY = 800;
  }
  const margin = 200;
  const viewWidth = Math.max(400, maxX - minX + margin * 2);
  const viewHeight = Math.max(400, maxY - minY + margin * 2);
  const viewX = minX - margin;
  const viewY = minY - margin;
  svg.setAttribute('viewBox', `${viewX} ${viewY} ${viewWidth} ${viewHeight}`);

  const edgesGroup = document.createElementNS(NS, 'g');
  edgesGroup.classList.add('graph-edges');
  const nodesGroup = document.createElementNS(NS, 'g');
  nodesGroup.classList.add('graph-nodes');

  const nodePositions = new Map();
  nodes.forEach((node) => {
    const position = node.meta?.position || { x: 0, y: 0 };
    nodePositions.set(node.id, position);
  });

  edges.forEach((edge) => {
    const from = nodePositions.get(edge.from);
    const to = nodePositions.get(edge.to);
    if (!from || !to) return;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x);
    line.setAttribute('y2', to.y);
    line.classList.add('graph-edge');
    edgesGroup.appendChild(line);
    let labelElement = null;
    if (edge.type && edge.type !== 'LINKS_TO') {
      labelElement = document.createElementNS(NS, 'text');
      labelElement.classList.add('graph-edge-label');
      labelElement.textContent = edge.type;
      labelElement.setAttribute('x', (from.x + to.x) / 2);
      labelElement.setAttribute('y', (from.y + to.y) / 2);
      edgesGroup.appendChild(labelElement);
    }
    runtime.edgeElements.push({
      from: edge.from,
      to: edge.to,
      line,
      label: labelElement,
    });
  });

  nodes.forEach((node) => {
    const position = node.meta?.position || { x: 0, y: 0 };
    const group = document.createElementNS(NS, 'g');
    group.classList.add('graph-node');
    if (node.id === state.selectedNodeId) {
      group.classList.add('selected');
    }
    group.dataset.nodeId = node.id;

    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', position.x);
    circle.setAttribute('cy', position.y);
    circle.setAttribute('r', 38);

    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', position.x);
    label.setAttribute('y', position.y + 4);
    label.textContent = node.label || node.id;

    group.appendChild(circle);
    group.appendChild(label);

    group.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      selectNode(node.id);
      startDrag(node.id, event);
    });
    group.addEventListener('click', (event) => {
      event.stopPropagation();
      selectNode(node.id);
    });

    nodesGroup.appendChild(group);
    runtime.nodeElements.set(node.id, { group, circle, label });
  });

  svg.appendChild(edgesGroup);
  svg.appendChild(nodesGroup);
}

function refreshUI() {
  renderProjectBadge();
  renderStatus();
  renderErrorBanner();
  renderWorkingMemorySettings();
  renderSessionPanel();
  renderNodeInspector();
  renderEdgesPanel();
  renderMessagesPanel();
  renderSummaryPanel();
  renderCheckpointsPanel();
  renderGraph();
}

function selectNode(nodeId) {
  if (state.selectedNodeId === nodeId && state.draftNode) {
    return;
  }
  clearAutosaveTimer();
  state.selectedNodeId = nodeId;
  if (nodeId) {
    const node = state.graphNodes.find((item) => item.id === nodeId);
    state.draftNode = node ? cloneNode(node) : null;
    state.newMetaKey = '';
    state.newMetaValue = '';
    state.newEdgeTarget = '';
    state.newEdgeType = 'LINKS_TO';
    state.newEdgeDirection = 'outgoing';
    state.isDirty = false;
    updateAutosaveState('saved');
  } else {
    state.draftNode = null;
    state.isDirty = false;
    updateAutosaveState('idle');
  }
  syncWorkingMemoryNodeContext();
  syncWorkingMemorySession();
  renderNodeInspector();
  renderEdgesPanel();
  renderGraph();
  refreshMessages();
  if (state.session) {
    fetchJSON(`${API_BASE}/sessions/${state.session.id}`, {
      method: 'PATCH',
      body: { active_node: nodeId || null },
    }).catch((err) => console.warn('Failed to update session', err));
  }
}

function clearAutosaveTimer() {
  if (runtime.autosaveTimer) {
    clearTimeout(runtime.autosaveTimer);
    runtime.autosaveTimer = null;
  }
}

function scheduleAutosave() {
  clearAutosaveTimer();
  runtime.autosaveTimer = setTimeout(runAutosave, AUTOSAVE_DELAY);
}

async function runAutosave() {
  runtime.autosaveTimer = null;
  if (!state.draftNode || !state.selectedNodeId || !state.projectId) {
    return;
  }
  const original = state.graphNodes.find((node) => node.id === state.selectedNodeId);
  if (!original) return;
  const payload = {};
  if (state.draftNode.label !== original.label) {
    payload.label = state.draftNode.label || '';
  }
  if (state.draftNode.content !== original.content) {
    payload.content = state.draftNode.content || '';
  }
  if (!deepEqual(state.draftNode.meta, original.meta)) {
    payload.meta = state.draftNode.meta || {};
  }
  if (Object.keys(payload).length === 0) {
    state.isDirty = false;
    updateAutosaveState('saved');
    return;
  }
  payload.project_id = state.projectId;
  updateAutosaveState('saving');
  try {
    const updatedRaw = await fetchJSON(`${API_BASE}/node/${state.selectedNodeId}`, {
      method: 'PATCH',
      body: payload,
    });
    const updated = hydrateNode(updatedRaw);
    const index = state.graphNodes.findIndex((node) => node.id === updated.id);
    if (index >= 0) {
      state.graphNodes[index] = updated;
    }
    state.draftNode = cloneNode(updated);
    syncWorkingMemoryProjectStructure();
    syncWorkingMemoryNodeContext();
    state.isDirty = false;
    updateAutosaveState('saved');
    renderGraph();
    renderNodeInspector();
    renderEdgesPanel();
  } catch (error) {
    console.error(error);
    updateAutosaveState('error');
    setErrorBanner(error?.message || 'Request failed');
  }
}

function applyDefaultPositions() {
  state.graphNodes.forEach((node, index) => {
    const position = node.meta?.position;
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') {
      const newPosition = {
        x: 200 + (index % 4) * 220,
        y: 160 + Math.floor(index / 4) * 200,
      };
      node.meta = { ...(node.meta || {}), position: newPosition };
      if (!runtime.seededPositions.has(node.id) && state.projectId) {
        runtime.seededPositions.add(node.id);
        fetchJSON(`${API_BASE}/node/${node.id}`, {
          method: 'PATCH',
          body: { meta: node.meta, project_id: state.projectId },
        }).catch((err) => console.warn('Failed to seed node position', err));
      }
    }
  });
}

function getSvgPoint(event) {
  const svg = ui.graphCanvas;
  if (!svg) {
    return { x: 0, y: 0 };
  }
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) {
    return { x: point.x, y: point.y };
  }
  const inverse = ctm.inverse();
  const transformed = point.matrixTransform(inverse);
  return { x: transformed.x, y: transformed.y };
}

function startDrag(nodeId, event) {
  if (!ui.graphCanvas) return;
  const { x, y } = getSvgPoint(event);
  const node = state.graphNodes.find((item) => item.id === nodeId);
  if (!node) return;
  const position = node.meta?.position || { x: 0, y: 0 };
  runtime.dragging = {
    nodeId,
    pointerId: event.pointerId,
    offsetX: x - position.x,
    offsetY: y - position.y,
  };
  try {
    ui.graphCanvas.setPointerCapture(event.pointerId);
  } catch (err) {
    // Pointer capture may fail; ignore.
  }
}

function updateNodeElementPosition(nodeId, position) {
  const entry = runtime.nodeElements.get(nodeId);
  if (!entry) return;
  entry.circle.setAttribute('cx', position.x);
  entry.circle.setAttribute('cy', position.y);
  entry.label.setAttribute('x', position.x);
  entry.label.setAttribute('y', position.y + 4);
}

function updateEdgesForNode(nodeId) {
  runtime.edgeElements.forEach((edge) => {
    if (edge.from !== nodeId && edge.to !== nodeId) return;
    const fromNode = state.graphNodes.find((node) => node.id === edge.from);
    const toNode = state.graphNodes.find((node) => node.id === edge.to);
    if (!fromNode || !toNode) return;
    const fromPos = fromNode.meta?.position || { x: 0, y: 0 };
    const toPos = toNode.meta?.position || { x: 0, y: 0 };
    edge.line.setAttribute('x1', fromPos.x);
    edge.line.setAttribute('y1', fromPos.y);
    edge.line.setAttribute('x2', toPos.x);
    edge.line.setAttribute('y2', toPos.y);
    if (edge.label) {
      edge.label.setAttribute('x', (fromPos.x + toPos.x) / 2);
      edge.label.setAttribute('y', (fromPos.y + toPos.y) / 2);
    }
  });
}

function handlePointerMove(event) {
  if (!runtime.dragging || runtime.dragging.pointerId !== event.pointerId) return;
  event.preventDefault();
  const { x, y } = getSvgPoint(event);
  const newPosition = {
    x: x - runtime.dragging.offsetX,
    y: y - runtime.dragging.offsetY,
  };
  const node = state.graphNodes.find((item) => item.id === runtime.dragging.nodeId);
  if (!node) return;
  node.meta = { ...(node.meta || {}), position: newPosition };
  if (state.draftNode && state.draftNode.id === node.id) {
    state.draftNode.meta = { ...(state.draftNode.meta || {}), position: newPosition };
  }
  updateNodeElementPosition(node.id, newPosition);
  updateEdgesForNode(node.id);
}

function persistNodePosition(nodeId, position) {
  if (!state.projectId) return;
  const node = state.graphNodes.find((item) => item.id === nodeId);
  if (!node) return;
  const meta = { ...(node.meta || {}), position };
  node.meta = meta;
  if (state.draftNode && state.draftNode.id === nodeId) {
    state.draftNode.meta = { ...(state.draftNode.meta || {}), position };
  }
  syncWorkingMemoryProjectStructure();
  if (state.draftNode && state.draftNode.id === nodeId) {
    syncWorkingMemoryNodeContext();
  }
  if (!state.isDirty) {
    updateAutosaveState('saving');
  }
  fetchJSON(`${API_BASE}/node/${nodeId}`, {
    method: 'PATCH',
    body: { meta, project_id: state.projectId },
  })
    .then(() => {
      if (!state.isDirty) {
        updateAutosaveState('saved');
      }
      clearErrorBanner();
    })
    .catch((error) => {
      console.warn('Failed to persist position', error);
      if (!state.isDirty) {
        updateAutosaveState('error');
      }
      setErrorBanner(error?.message || 'Failed to persist position');
    });
}

function handlePointerUp(event) {
  if (!runtime.dragging || runtime.dragging.pointerId !== event.pointerId) return;
  const { nodeId } = runtime.dragging;
  runtime.dragging = null;
  try {
    ui.graphCanvas.releasePointerCapture(event.pointerId);
  } catch (err) {
    // ignore
  }
  const node = state.graphNodes.find((item) => item.id === nodeId);
  if (!node) return;
  const position = node.meta?.position;
  if (position) {
    persistNodePosition(nodeId, position);
  }
}

function handlePointerCancel(event) {
  if (!runtime.dragging || runtime.dragging.pointerId !== event.pointerId) return;
  runtime.dragging = null;
  try {
    ui.graphCanvas.releasePointerCapture(event.pointerId);
  } catch (err) {
    // ignore
  }
}

async function handleAddNode() {
  if (!state.projectId) return;
  const label = window.prompt('Node label', 'New Story Node');
  if (!label) return;
  const position = {
    x: 200 + (state.graphNodes.length % 4) * 220,
    y: 160 + Math.floor(state.graphNodes.length / 4) * 200,
  };
  try {
    const createdRaw = await fetchJSON(`${API_BASE}/node`, {
      method: 'POST',
      body: { label, content: '', meta: { position }, project_id: state.projectId },
    });
    const created = hydrateNode(createdRaw);
    state.graphNodes.push(created);
    runtime.seededPositions.add(created.id);
    clearErrorBanner();
    syncWorkingMemoryProjectStructure();
    selectNode(created.id);
    renderGraph();
  } catch (error) {
    console.error(error);
    setErrorBanner(error?.message || 'Request failed');
  }
}

async function handleDeleteNode() {
  if (!state.selectedNodeId || !state.projectId) return;
  const node = state.graphNodes.find((item) => item.id === state.selectedNodeId);
  const name = node?.label || state.selectedNodeId;
  if (!window.confirm(`Delete node "${name}"?`)) {
    return;
  }
  try {
    await fetchJSON(`${API_BASE}/node/${state.selectedNodeId}`, {
      method: 'DELETE',
      body: { project_id: state.projectId },
    });
    state.graphNodes = state.graphNodes.filter((item) => item.id !== state.selectedNodeId);
    state.graphEdges = state.graphEdges.filter(
      (edge) => edge.from !== state.selectedNodeId && edge.to !== state.selectedNodeId
    );
    runtime.seededPositions.delete(state.selectedNodeId);
    syncWorkingMemoryProjectStructure();
    selectNode(null);
    clearErrorBanner();
    renderGraph();
    renderEdgesPanel();
  } catch (error) {
    console.error(error);
    setErrorBanner(error?.message || 'Request failed');
  }
}

async function handleDeleteEdge(edge) {
  if (!state.projectId) return;
  try {
    await fetchJSON(`${API_BASE}/edge`, {
      method: 'DELETE',
      body: { from: edge.from, to: edge.to, type: edge.type, project_id: state.projectId },
    });
    state.graphEdges = state.graphEdges.filter((item) => item !== edge);
    clearErrorBanner();
    syncWorkingMemoryProjectStructure();
    renderGraph();
    renderEdgesPanel();
  } catch (error) {
    console.error(error);
    setErrorBanner(error?.message || 'Request failed');
  }
}

async function handleAddEdge(event) {
  event.preventDefault();
  if (!state.projectId || !state.selectedNodeId || !state.newEdgeTarget) return;
  const type = state.newEdgeType.trim() || 'LINKS_TO';
  const target = state.newEdgeTarget;
  let from = state.selectedNodeId;
  let to = target;
  if (state.newEdgeDirection === 'incoming') {
    from = target;
    to = state.selectedNodeId;
  }
  try {
    const created = await fetchJSON(`${API_BASE}/edge`, {
      method: 'POST',
      body: { from, to, type, project_id: state.projectId },
    });
    state.graphEdges.push(created);
    state.newEdgeTarget = '';
    clearErrorBanner();
    syncWorkingMemoryProjectStructure();
    renderGraph();
    renderEdgesPanel();
  } catch (error) {
    console.error(error);
    setErrorBanner(error?.message || 'Request failed');
  }
}

async function handleMessageSubmit(event) {
  event.preventDefault();
  if (!state.session || !state.newMessage.trim()) return;
  try {
    const created = await fetchJSON(`${API_BASE}/messages`, {
      method: 'POST',
      body: {
        session_id: state.session.id,
        node_id: state.selectedNodeId || null,
        role: 'user',
        content: state.newMessage.trim(),
      },
    });
    appendWorkingMemoryMessage({
      id: created?.id,
      session_id: state.session.id,
      node_id: state.selectedNodeId || null,
      role: 'user',
      content: state.newMessage.trim(),
      created_at: new Date().toISOString(),
    });
    state.newMessage = '';
    clearErrorBanner();
    renderMessagesPanel();
    refreshMessages();
  } catch (error) {
    console.error(error);
    setErrorBanner(error?.message || 'Request failed');
  }
}

async function handleSaveSummary() {
  if (!state.session || !state.summaryDraft.trim()) return;
  try {
    const payload = {
      session_id: state.session.id,
      nodes: state.selectedNodeId ? [state.selectedNodeId] : [],
      text: state.summaryDraft.trim(),
      last_n: state.messages.length,
    };
    const saved = await fetchJSON(`${API_BASE}/summaries/rollup`, {
      method: 'POST',
      body: payload,
    });
    state.summary = saved.summary_json;
    state.summaryDraft = '';
    clearErrorBanner();
    syncWorkingMemoryWorkingHistory();
    renderSessionPanel();
    renderSummaryPanel();
  } catch (error) {
    console.error(error);
    setErrorBanner(error?.message || 'Request failed');
  }
}

async function handleSaveCheckpoint() {
  if (!state.projectId) return;
  const name = state.checkpointName.trim();
  if (!name) return;
  try {
    await fetchJSON(`${API_BASE}/checkpoints`, {
      method: 'POST',
      body: { name, project_id: state.projectId },
    });
    state.checkpointName = '';
    clearErrorBanner();
    renderCheckpointsPanel();
    await loadCheckpoints();
  } catch (error) {
    console.error(error);
    setErrorBanner(error?.message || 'Request failed');
  }
}

async function handleRestoreCheckpoint(checkpointId) {
  if (!checkpointId || !state.projectId) return;
  if (!window.confirm('Restore checkpoint? Current graph will be replaced.')) {
    return;
  }
  try {
    await fetchJSON(`${API_BASE}/checkpoints/${checkpointId}/restore`, { method: 'POST' });
    clearErrorBanner();
    await loadGraph();
    await loadCheckpoints();
  } catch (error) {
    console.error(error);
    setErrorBanner(error?.message || 'Request failed');
  }
}

async function refreshMessages() {
  if (!state.session) {
    state.messages = [];
    state.messagesStatus = 'idle';
    renderMessagesPanel();
    setWorkingMemoryMessages([]);
    return;
  }
  state.messagesStatus = 'loading';
  renderMessagesPanel();
  const params = new URLSearchParams({ session_id: state.session.id, limit: '50' });
  if (state.selectedNodeId) {
    params.set('node_id', state.selectedNodeId);
  }
  try {
    const data = await fetchJSON(`${API_BASE}/messages?${params.toString()}`);
    state.messages = (data.messages || []).slice().reverse();
    state.messagesStatus = 'ready';
    syncWorkingMemoryMessages();
  } catch (error) {
    console.error(error);
    state.messagesStatus = 'error';
  }
  renderMessagesPanel();
}

async function loadSummary() {
  if (!state.session) return;
  try {
    const data = await fetchJSON(`${API_BASE}/summaries?session_id=${state.session.id}&limit=1`);
    const latest = data.summaries?.[0];
    if (latest) {
      state.summary = latest.summary_json;
    }
  } catch (error) {
    console.warn('Failed to load summary', error);
  }
  syncWorkingMemoryWorkingHistory();
  renderSessionPanel();
}

async function loadCheckpoints() {
  if (!state.projectId) return;
  const params = new URLSearchParams({ project_id: state.projectId });
  try {
    const data = await fetchJSON(`${API_BASE}/checkpoints?${params.toString()}`);
    state.checkpoints = data.checkpoints || [];
  } catch (error) {
    console.warn('Failed to load checkpoints', error);
  }
  renderCheckpointsPanel();
}

async function loadGraph() {
  if (!state.projectId) return;
  try {
    const params = new URLSearchParams({ project_id: state.projectId });
    const data = await fetchJSON(`${API_BASE}/graph?${params.toString()}`);
    state.graphNodes = (data.nodes || []).map(hydrateNode);
    state.graphEdges = data.edges || [];
    state.versionCursor = new Date().toISOString();
    applyDefaultPositions();
    if (state.selectedNodeId) {
      const updated = state.graphNodes.find((node) => node.id === state.selectedNodeId);
      if (updated) {
        state.draftNode = cloneNode(updated);
      } else {
        selectNode(null);
      }
    }
    clearErrorBanner();
    syncWorkingMemoryProjectStructure();
    if (state.draftNode) {
      syncWorkingMemoryNodeContext();
    }
  } catch (error) {
    console.error(error);
    setErrorBanner(error?.message || 'Failed to load graph');
  }
  renderGraph();
  renderEdgesPanel();
}

function stopVersionPolling() {
  if (runtime.versionInterval) {
    clearInterval(runtime.versionInterval);
    runtime.versionInterval = null;
  }
}

function startVersionPolling() {
  stopVersionPolling();
  if (!state.projectId) return;
  const pollInterval = state.appConfig?.version_poll_interval_ms || DEFAULT_VERSION_INTERVAL;
  runtime.versionInterval = setInterval(checkForUpdates, pollInterval);
}

async function checkForUpdates() {
  if (!state.projectId || !state.versionCursor) return;
  const params = new URLSearchParams({ project_id: state.projectId, since: state.versionCursor });
  try {
    const data = await fetchJSON(`${API_BASE}/versions/check?${params.toString()}`);
    state.versionCursor = new Date().toISOString();
    if (data?.versions?.length) {
      await loadGraph();
    }
  } catch (error) {
    console.warn('Version check failed', error);
  }
}

function setProjectId(projectId) {
  if (state.projectId === projectId) return;
  if (projectId) {
    const context = ensureProjectContext(projectId);
    state.projectName = context?.name || '';
  } else {
    ensureProjectContext(null);
    state.projectName = '';
  }
  state.projectId = projectId;
  state.graphNodes = [];
  state.graphEdges = [];
  state.selectedNodeId = null;
  state.draftNode = null;
  state.autosaveState = 'idle';
  state.isDirty = false;
  state.messages = [];
  state.messagesStatus = 'idle';
  state.summary = null;
  state.summaryDraft = '';
  state.checkpoints = [];
  state.checkpointName = '';
  state.newMessage = '';
  state.errorBanner = null;
  state.versionCursor = null;
  runtime.seededPositions.clear();
  stopVersionPolling();
  clearAutosaveTimer();
  resetWorkingMemoryForProject(projectId);
  refreshUI();
  if (projectId) {
    if (state.projectName) {
      updateStoredProjectContext({ id: projectId, name: state.projectName });
    } else {
      loadProjectDetails(projectId);
    }
    loadGraph();
    loadCheckpoints();
    loadSessionForProject(projectId);
    startVersionPolling();
  }
}

async function loadProjectDetails(projectId) {
  if (!projectId) return;
  try {
    const data = await fetchJSON(`${API_BASE}/project/${encodeURIComponent(projectId)}`);
    if (data?.id === projectId) {
      state.projectName = data.name || '';
      updateStoredProjectContext({ id: projectId, name: state.projectName });
      renderProjectBadge();
      renderSessionPanel();
    }
  } catch (error) {
    console.warn('Failed to load project metadata', error);
  }
}

async function loadSessionForProject(projectId) {
  state.session = null;
  state.sessionError = null;
  renderSessionPanel();
  syncWorkingMemorySession();
  try {
    const session = await getOrCreateSession(projectId);
    state.session = session;
    state.sessionError = null;
    renderSessionPanel();
    syncWorkingMemorySession();
    refreshMessages();
    loadSummary();
  } catch (error) {
    console.error(error);
    state.sessionError = error?.message || 'Failed to initialise session';
    renderSessionPanel();
  }
}

function initialiseUI() {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="header-start">
          <a class="header-back" href="/">← Back to Hub</a>
          <div class="header-title">
            <h1>Story Graph Studio</h1>
            <span>Visual editor with live Neo4j + MySQL sync</span>
          </div>
        </div>
        <div class="header-project" data-project-badge>
          <span class="header-project-label">Active Project</span>
          <strong class="header-project-value">None selected</strong>
        </div>
        <div class="header-actions">
          <button type="button" data-action="add-node">Add node</button>
          <button type="button" data-action="working-memory" title="View working memory for the selected node">🧠 Working Memory</button>
          <div class="status-indicator" aria-live="polite">
            <span class="status-dot" data-status-dot></span>
            <span data-status-label>Idle</span>
          </div>
        </div>
      </header>
      <section class="graph-panel">
        <div class="summary-banner hidden" data-error-banner>
          <h3>Error</h3>
          <p data-error-message></p>
        </div>
        <div class="graph-wrapper">
          <svg class="graph-canvas" data-graph-canvas></svg>
          <div class="graph-empty empty-state" data-graph-empty>Start by adding a node.</div>
        </div>
      </section>
      <aside class="sidebar">
        <div class="panel" data-working-memory-panel></div>
        <div class="panel" data-session-panel></div>
        <div class="panel" data-node-inspector></div>
        <div class="panel" data-edges-panel></div>
        <div class="panel" data-messages-panel></div>
        <div class="panel" data-summary-panel></div>
        <div class="panel" data-checkpoints-panel></div>
      </aside>
    </div>
  `;

  ui.addNodeButton = root.querySelector('[data-action="add-node"]');
  ui.statusDot = root.querySelector('[data-status-dot]');
  ui.statusLabel = root.querySelector('[data-status-label]');
  ui.errorBanner = root.querySelector('[data-error-banner]');
  ui.errorMessage = root.querySelector('[data-error-message]');
  ui.projectBadge = root.querySelector('[data-project-badge]');
  ui.graphCanvas = root.querySelector('[data-graph-canvas]');
  ui.graphEmpty = root.querySelector('[data-graph-empty]');
  ui.workingMemoryPanel = root.querySelector('[data-working-memory-panel]');
  ui.workingMemoryControls = null;
  ui.workingMemoryButton = root.querySelector('[data-action="working-memory"]');
  ui.sessionPanel = root.querySelector('[data-session-panel]');
  ui.nodeInspector = root.querySelector('[data-node-inspector]');
  ui.edgesPanel = root.querySelector('[data-edges-panel]');
  ui.messagesPanel = root.querySelector('[data-messages-panel]');
  ui.summaryPanel = root.querySelector('[data-summary-panel]');
  ui.checkpointsPanel = root.querySelector('[data-checkpoints-panel]');

  ui.addNodeButton?.addEventListener('click', handleAddNode);
  ui.workingMemoryButton?.addEventListener('click', () => {
    syncWorkingMemoryProjectStructure();
    syncWorkingMemoryNodeContext();
    syncWorkingMemoryWorkingHistory();
    syncWorkingMemoryMessages();
    const activeNodeId = state.selectedNodeId || '';
    setWorkingMemorySession({ active_node_id: activeNodeId });
    openWorkingMemoryViewer({ nodeOnly: true, nodeId: activeNodeId });
  });
  ui.graphCanvas?.addEventListener('pointermove', handlePointerMove);
  ui.graphCanvas?.addEventListener('pointerup', handlePointerUp);
  ui.graphCanvas?.addEventListener('pointercancel', handlePointerCancel);
  ui.graphCanvas?.addEventListener('click', (event) => {
    if (event.target === ui.graphCanvas) {
      selectNode(null);
    }
  });

  if (!runtime.workingMemorySettingsUnsubscribe) {
    runtime.workingMemorySettingsUnsubscribe = subscribeWorkingMemorySettings(() => {
      renderWorkingMemorySettings();
    });
  }

  refreshUI();
}

async function loadConfigAndStart() {
  try {
    const data = await fetchJSON(`${API_BASE}/config`);
    state.appConfig = data || {};
    state.configError = null;
  } catch (error) {
    console.error(error);
    state.appConfig = {};
    state.configError = error?.message || 'Failed to load configuration';
  }
  renderSessionPanel();
  const projectId = determineProjectId(state.appConfig);
  setProjectId(projectId);
}

document.addEventListener('DOMContentLoaded', () => {
  initialiseUI();
  loadConfigAndStart();
});

