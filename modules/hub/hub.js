const API_BASE = '/api';
const PROJECT_STORAGE_KEY = 'story-graph-project';
const PROJECT_CONTEXT_STORAGE_KEY = 'story-graph-project-context';

const state = {
  projects: [],
  loadingProjects: false,
  projectsError: null,
  creating: false,
  createError: null,
  notice: '',
  activeProjectId: null,
  activeProjectName: null,
};

const ui = {};
let noticeTimer = null;

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

function storeProjectContext(context) {
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

function setNotice(message, { autoClear = true } = {}) {
  state.notice = message;
  if (ui.notice) {
    ui.notice.textContent = message || '';
  }
  if (noticeTimer) {
    window.clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  if (message && autoClear) {
    noticeTimer = window.setTimeout(() => {
      noticeTimer = null;
      setNotice('');
    }, 4000);
  }
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
    } catch (error) {
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

function formatDate(input) {
  if (!input) return '';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderProjectsList() {
  if (!ui.projectList) return;
  ui.projectList.innerHTML = '';

  if (state.loadingProjects) {
    const loading = document.createElement('p');
    loading.className = 'hub-empty';
    loading.textContent = 'Loading projects…';
    ui.projectList.appendChild(loading);
    return;
  }

  if (state.projectsError) {
    const error = document.createElement('p');
    error.className = 'hub-empty';
    error.textContent = state.projectsError;
    ui.projectList.appendChild(error);
    return;
  }

  if (!state.projects.length) {
    const empty = document.createElement('p');
    empty.className = 'hub-empty';
    empty.textContent = 'No projects yet. Create one to get started!';
    ui.projectList.appendChild(empty);
    return;
  }

  state.projects.forEach((project) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hub-project';
    if (state.activeProjectId === project.id) {
      button.classList.add('hub-project--active');
    }

    const name = document.createElement('p');
    name.className = 'hub-project__name';
    name.textContent = project.name;

    const meta = document.createElement('p');
    meta.className = 'hub-project__meta';
    const createdAt = formatDate(project.created_at);
    meta.textContent = createdAt ? `Created ${createdAt}` : `ID: ${project.id}`;

    button.appendChild(name);
    button.appendChild(meta);

    button.addEventListener('click', () => {
      setActiveProject(project);
    });

    ui.projectList.appendChild(button);
  });
}

function renderActiveProject() {
  if (!ui.activeProject) return;
  if (state.activeProjectId) {
    const name = state.activeProjectName?.trim();
    const label = name ? `${name} (${state.activeProjectId})` : state.activeProjectId;
    ui.activeProject.textContent = label;
  } else {
    ui.activeProject.textContent = 'None selected';
  }
}

function updateMarbleState() {
  if (!ui.marbles) return;
  const disabled = !state.activeProjectId;
  ui.marbles.forEach((button) => {
    if (disabled) {
      button.setAttribute('disabled', 'true');
    } else {
      button.removeAttribute('disabled');
    }
  });
}

function renderCreateState() {
  if (ui.createButton) {
    ui.createButton.disabled = state.creating;
  }
  if (ui.createInput) {
    ui.createInput.disabled = state.creating;
  }
  if (ui.createError) {
    if (state.createError) {
      ui.createError.hidden = false;
      ui.createError.textContent = state.createError;
    } else {
      ui.createError.hidden = true;
      ui.createError.textContent = '';
    }
  }
}

function setActiveProject(project) {
  if (!project) {
    state.activeProjectId = null;
    state.activeProjectName = null;
    storeProjectContext(null);
    renderActiveProject();
    updateMarbleState();
    renderProjectsList();
    return;
  }

  if (
    state.activeProjectId === project.id &&
    (state.activeProjectName || '') === (project.name || '')
  ) {
    storeProjectContext({ id: project.id, name: project.name || '' });
    renderActiveProject();
    updateMarbleState();
    renderProjectsList();
    return;
  }

  state.activeProjectId = project.id;
  state.activeProjectName = project.name || '';
  storeProjectContext({ id: project.id, name: project.name || '' });
  renderActiveProject();
  renderProjectsList();
  updateMarbleState();
  setNotice(`Active project set to “${project.name || project.id}”.`);
}

async function loadProjects() {
  state.loadingProjects = true;
  state.projectsError = null;
  renderProjectsList();
  try {
    const data = await fetchJSON(`${API_BASE}/projects`);
    state.projects = Array.isArray(data?.projects) ? data.projects : [];
    const active = state.activeProjectId;
    if (active) {
      const match = state.projects.find((project) => project.id === active);
      if (match) {
        state.activeProjectName = match.name || '';
        storeProjectContext({ id: match.id, name: match.name || '' });
      }
    }
  } catch (error) {
    console.error(error);
    state.projectsError = error?.message || 'Failed to load projects';
  } finally {
    state.loadingProjects = false;
    renderProjectsList();
    renderActiveProject();
    updateMarbleState();
  }
}

async function createProject(name) {
  state.creating = true;
  state.createError = null;
  renderCreateState();
  try {
    const payload = await fetchJSON(`${API_BASE}/project`, {
      method: 'POST',
      body: { name },
    });
    if (payload) {
      state.projectsError = null;
      state.projects = [payload, ...state.projects.filter((item) => item.id !== payload.id)];
      setActiveProject(payload);
    }
    if (ui.createForm) {
      ui.createForm.reset();
    }
  } catch (error) {
    console.error(error);
    state.createError = error?.message || 'Failed to create project';
  } finally {
    state.creating = false;
    renderCreateState();
    renderProjectsList();
  }
}

function handleCreateSubmit(event) {
  event.preventDefault();
  if (!ui.createInput) return;
  const name = ui.createInput.value.trim();
  if (!name) {
    ui.createInput.focus();
    return;
  }
  createProject(name);
}

function handleMarbleClick(event) {
  const { builder } = event.currentTarget.dataset;
  if (!state.activeProjectId) {
    setNotice('Select or create a project to open a builder.', { autoClear: false });
    return;
  }
  const base = builder === 'project' ? '/modules/project/project.html' : '/modules/elements/elements.html';
  const url = `${base}?project=${encodeURIComponent(state.activeProjectId)}`;
  window.location.href = url;
}

function refreshProjects() {
  loadProjects();
}

function bindUI() {
  ui.projectList = document.querySelector('[data-project-list]');
  ui.createForm = document.querySelector('[data-create-form]');
  ui.createInput = ui.createForm?.querySelector('input[name="project-name"]');
  ui.createButton = ui.createForm?.querySelector('[data-action="create-project"]');
  ui.createError = document.querySelector('[data-create-error]');
  ui.activeProject = document.querySelector('[data-active-project]');
  ui.notice = document.querySelector('[data-hub-notice]');
  ui.marbles = Array.from(document.querySelectorAll('[data-builder]'));
  ui.refreshButton = document.querySelector('[data-action="refresh-projects"]');

  ui.createForm?.addEventListener('submit', handleCreateSubmit);
  ui.refreshButton?.addEventListener('click', refreshProjects);
  ui.marbles.forEach((button) => {
    button.addEventListener('click', handleMarbleClick);
  });
}

function bootstrap() {
  bindUI();
  state.loadingProjects = true;
  renderProjectsList();
  renderActiveProject();
  updateMarbleState();

  const context = getStoredProjectContext();
  if (context?.id) {
    state.activeProjectId = context.id;
    state.activeProjectName = context.name || '';
    storeProjectContext(context);
    renderActiveProject();
    updateMarbleState();
  }

  loadProjects();
}

document.addEventListener('DOMContentLoaded', bootstrap);
