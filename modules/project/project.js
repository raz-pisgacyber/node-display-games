import ProjectNode from './ProjectNode.js';
import util, { enableZoomPan, ensureCanvas, log } from '../../core/util.js';

const PROJECT_STORAGE_KEY = 'story-graph-project';
const PROJECT_CONTEXT_STORAGE_KEY = 'story-graph-project-context';

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

const init = () => {
  const workspace = document.getElementById('workspace');
  if (!workspace) {
    log('Workspace element missing.');
    return;
  }

  const canvas = ensureCanvas(workspace, { width: 2400, height: 2400 });

  const canvasCenterX = canvas.offsetWidth / 2;
  const canvasCenterY = Math.max(220, canvas.offsetHeight * 0.24);

  const rootNode = new ProjectNode({ canvas, x: canvasCenterX, y: canvasCenterY });

  const viewport = enableZoomPan(workspace, canvas, {
    minScale: 0.5,
    maxScale: 2.4,
    centerOnLoad: false,
  });

  requestAnimationFrame(() => {
    viewport.focusOn(
      { x: rootNode.position.x, y: rootNode.position.y },
      {
        scale: 0.82,
        offset: { x: 0, y: -Math.max(140, workspace.clientHeight * 0.18) },
      }
    );
  });

  log('Project builder initialised.');

  window.builder = {
    util,
    rootNode,
    viewport,
  };
};

function bootstrap() {
  applyProjectInfo();
  init();
}

document.addEventListener('DOMContentLoaded', bootstrap);
