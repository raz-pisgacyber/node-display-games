const API_BASE = '/api';

function buildUrl(path) {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  if (path.startsWith('/')) {
    return path;
  }
  return `${API_BASE}/${path.replace(/^\/+/, '')}`;
}

export async function fetchJSON(path, options = {}) {
  const url = buildUrl(path);
  const finalOptions = { ...options };
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  finalOptions.headers = headers;
  if (finalOptions.body && typeof finalOptions.body !== 'string') {
    finalOptions.body = JSON.stringify(finalOptions.body);
  }
  if (options.keepalive) {
    finalOptions.keepalive = true;
  }
  const response = await fetch(url, finalOptions);
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
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function withProjectId(payload, projectId) {
  if (!projectId) {
    return { ...payload };
  }
  return { ...payload, project_id: projectId };
}

export async function fetchGraph(projectId) {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return fetchJSON(`/api/graph${query}`);
}

export async function createNode(payload, { projectId, keepalive } = {}) {
  return fetchJSON('/api/node', {
    method: 'POST',
    body: withProjectId(payload, projectId),
    keepalive,
  });
}

export async function updateNode(id, payload, { projectId, keepalive } = {}) {
  const body = withProjectId(payload, projectId);
  return fetchJSON(`/api/node/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    keepalive,
  });
}

export async function createEdge(payload, { projectId, keepalive } = {}) {
  return fetchJSON('/api/edge', {
    method: 'POST',
    body: withProjectId(payload, projectId),
    keepalive,
  });
}

export async function deleteEdge(payload, { projectId, keepalive } = {}) {
  return fetchJSON('/api/edge', {
    method: 'DELETE',
    body: withProjectId(payload, projectId),
    keepalive,
  });
}

export async function updateEdge(payload, { projectId, keepalive } = {}) {
  return fetchJSON('/api/edge', {
    method: 'PATCH',
    body: withProjectId(payload, projectId),
    keepalive,
  });
}

export async function fetchLinks(nodeId, { projectId, type } = {}) {
  if (!nodeId) {
    throw new Error('nodeId is required');
  }
  const params = new URLSearchParams();
  params.set('node_id', nodeId);
  if (projectId) {
    params.set('project_id', projectId);
  }
  if (type) {
    params.set('type', type);
  }
  return fetchJSON(`/api/links?${params.toString()}`);
}

export async function createLink(payload, { projectId, keepalive } = {}) {
  return fetchJSON('/api/link', {
    method: 'POST',
    body: withProjectId(payload, projectId),
    keepalive,
  });
}

export async function deleteLink(payload, { projectId, keepalive } = {}) {
  return fetchJSON('/api/link', {
    method: 'DELETE',
    body: withProjectId(payload, projectId),
    keepalive,
  });
}

export async function fetchMessages(sessionId, { nodeId, limit } = {}) {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  const params = new URLSearchParams();
  params.set('session_id', sessionId);
  if (nodeId) {
    params.set('node_id', nodeId);
  }
  if (limit) {
    params.set('limit', String(limit));
  }
  const data = await fetchJSON(`/api/messages?${params.toString()}`);
  return Array.isArray(data?.messages) ? data.messages : [];
}

export async function sendMessage({ sessionId, nodeId = null, role = 'user', content, keepalive } = {}) {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  if (!role) {
    throw new Error('role is required');
  }
  if (!content || !content.trim()) {
    throw new Error('content is required');
  }
  const body = {
    session_id: sessionId,
    role,
    content,
  };
  if (nodeId) {
    body.node_id = nodeId;
  }
  return fetchJSON('/api/messages', {
    method: 'POST',
    body,
    keepalive,
  });
}

export async function createCheckpoint(projectId, name) {
  const body = { project_id: projectId };
  if (name) {
    body.name = name;
  }
  return fetchJSON('/api/checkpoints', {
    method: 'POST',
    body,
  });
}
