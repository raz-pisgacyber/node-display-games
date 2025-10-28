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
  if (projectId !== undefined && projectId !== null) {
    const value = `${projectId}`.trim();
    if (value) {
      return fetchJSON(`/api/graph/${encodeURIComponent(value)}`);
    }
  }
  return fetchJSON('/api/graph');
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

export async function fetchMessages({ sessionId, nodeId, limit, cursor } = {}) {
  const sessionIdText = sessionId === undefined || sessionId === null ? '' : `${sessionId}`.trim();
  const nodeIdText = nodeId === undefined || nodeId === null ? '' : `${nodeId}`.trim();
  if (!sessionIdText && !nodeIdText) {
    throw new Error('sessionId or nodeId is required');
  }
  const params = new URLSearchParams();
  if (nodeIdText) {
    params.set('node_id', nodeIdText);
  }
  if (sessionIdText) {
    params.set('session_id', sessionIdText);
  }
  if (limit !== undefined && limit !== null) {
    const limitValue = typeof limit === 'number' ? limit : Number.parseInt(`${limit}`, 10);
    if (Number.isFinite(limitValue) && limitValue > 0) {
      params.set('limit', String(limitValue));
    }
  }
  if (cursor !== undefined && cursor !== null) {
    const cursorValue = typeof cursor === 'number' ? cursor : Number.parseInt(`${cursor}`, 10);
    if (Number.isFinite(cursorValue) && cursorValue >= 0) {
      params.set('cursor', String(cursorValue));
    }
  }
  const data = await fetchJSON(`/api/messages?${params.toString()}`);
  return {
    messages: Array.isArray(data?.messages) ? data.messages : [],
    total_count: Number.isInteger(data?.total_count) ? data.total_count : 0,
    filtered_count: Number.isInteger(data?.filtered_count) ? data.filtered_count : 0,
    has_more: Boolean(data?.has_more),
    next_cursor: data?.next_cursor ?? null,
    last_user_message: typeof data?.last_user_message === 'string' ? data.last_user_message : '',
  };
}

export async function sendMessage({
  sessionId,
  nodeId = null,
  role = 'user',
  content,
  messageType = 'user_reply',
  keepalive,
} = {}) {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  if (!role) {
    throw new Error('role is required');
  }
  const trimmed = typeof content === 'string' ? content.trim() : '';
  if (!trimmed) {
    throw new Error('content is required');
  }
  const body = {
    session_id: sessionId,
    role,
    content: trimmed,
    message_type: messageType,
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
