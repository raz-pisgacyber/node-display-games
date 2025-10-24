const API_BASE = '/api';
const SESSION_STORAGE_PREFIX = 'story-graph-session:';
const USER_ID_STORAGE_KEY = 'story-graph-user-id';

const pendingSessions = new Map();

function getStorageKey(projectId) {
  return `${SESSION_STORAGE_PREFIX}${projectId}`;
}

function getOrCreateUserId() {
  const existing = window.localStorage.getItem(USER_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const generated = `guest_${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(USER_ID_STORAGE_KEY, generated);
  return generated;
}

function parseStoredSession(raw, projectId) {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (!parsed.id || parsed.project_id !== projectId) {
      return null;
    }
    return parsed;
  } catch (error) {
    console.warn('Failed to parse stored session', error);
    return null;
  }
}

function storeSession(projectId, session, userId) {
  const key = getStorageKey(projectId);
  const payload = { ...session, user_id: userId, project_id: projectId };
  window.localStorage.setItem(key, JSON.stringify(payload));
  return payload;
}

async function requestSession(projectId) {
  const userId = getOrCreateUserId();
  const response = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, project_id: projectId }),
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (data && typeof data === 'object' && data.error) {
        message = data.error;
      } else if (typeof data === 'string') {
        message = data;
      }
    } catch (error) {
      const text = await response.text();
      if (text) {
        message = text;
      }
    }
    throw new Error(message);
  }
  const data = await response.json();
  return storeSession(projectId, data, userId);
}

export async function ensureSession(projectId) {
  if (!projectId) {
    throw new Error('projectId is required to create a session');
  }
  const key = getStorageKey(projectId);
  const cached = parseStoredSession(window.localStorage.getItem(key), projectId);
  if (cached?.id) {
    return cached;
  }
  if (pendingSessions.has(projectId)) {
    return pendingSessions.get(projectId);
  }
  const promise = requestSession(projectId)
    .catch((error) => {
      window.localStorage.removeItem(key);
      throw error;
    })
    .finally(() => {
      pendingSessions.delete(projectId);
    });
  pendingSessions.set(projectId, promise);
  return promise;
}

export function clearStoredSession(projectId) {
  if (!projectId) {
    return;
  }
  const key = getStorageKey(projectId);
  window.localStorage.removeItem(key);
}
