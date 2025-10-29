import { fetchMessages as fetchMessagesApi, sendMessage as sendMessageApi } from './api.js';
import { refreshWorkingMemory } from './workingMemory.js';

const DEFAULT_PAGE_SIZE = 50;

const state = {
  sessionId: '',
  nodeId: null,
  projectId: '',
  status: 'idle',
  messages: [],
  cursor: null,
  hasMore: false,
  totalCount: 0,
  filteredCount: 0,
  lastUserMessage: '',
};

const listeners = new Set();

function cloneMessages(list) {
  return normaliseMessages(list);
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toSortableId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { number: value, string: String(value) };
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return { number: asNumber, string: String(value) };
    }
    return { number: null, string: String(value) };
  }
  if (value === null || value === undefined) {
    return { number: null, string: '' };
  }
  const asString = String(value);
  const parsed = Number.parseInt(asString, 10);
  if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
    return { number: parsed, string: asString };
  }
  return { number: null, string: asString };
}

function compareMessagesChronologically(a, b) {
  const aTime = toTimestamp(a?.created_at);
  const bTime = toTimestamp(b?.created_at);
  if (aTime !== bTime) {
    return aTime - bTime;
  }
  const aId = toSortableId(a?.id);
  const bId = toSortableId(b?.id);
  if (aId.number !== null && bId.number !== null && aId.number !== bId.number) {
    return aId.number - bId.number;
  }
  if (aId.string !== bId.string) {
    return aId.string.localeCompare(bId.string);
  }
  return 0;
}

function buildChronologicalMessages(list) {
  const normalised = normaliseMessages(list);
  normalised.sort(compareMessagesChronologically);
  return normalised;
}

function notify() {
  const snapshot = getMessagesState();
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.warn('Messages store listener failed', error);
    }
  });
}

function normaliseSessionId(value) {
  if (!value) {
    return '';
  }
  return `${value}`.trim();
}

function normaliseNodeId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const trimmed = `${value}`.trim();
  return trimmed ? trimmed : null;
}

function normaliseProjectId(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return `${value}`.trim();
}

function normaliseMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const normalisedType =
    typeof message.message_type === 'string' && message.message_type.trim()
      ? message.message_type.trim()
      : 'user_reply';
  return { ...message, message_type: normalisedType };
}

function normaliseMessages(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map(normaliseMessage)
    .filter((message) => Boolean(message));
}

function normaliseCursor(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) && asNumber >= 0 ? asNumber : null;
  }
  const parsed = Number.parseInt(`${value}`, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

export function getMessagesState() {
  return {
    sessionId: state.sessionId,
    nodeId: state.nodeId,
    projectId: state.projectId,
    status: state.status,
    messages: cloneMessages(state.messages),
    cursor: state.cursor,
    hasMore: state.hasMore,
    totalCount: state.totalCount,
    filteredCount: state.filteredCount,
    lastUserMessage: state.lastUserMessage,
  };
}

export function subscribeMessagesStore(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  listeners.add(listener);
  try {
    listener(getMessagesState());
  } catch (error) {
    console.warn('Initial messages listener failed', error);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function setMessagesContext({ sessionId, nodeId, projectId } = {}) {
  const nextSessionId = normaliseSessionId(sessionId);
  const nextNodeId = normaliseNodeId(nodeId);
  const nextProjectId = projectId === undefined ? state.projectId : normaliseProjectId(projectId);
  const sessionChanged = nextSessionId !== state.sessionId;
  const nodeChanged = nextNodeId !== state.nodeId;
  const projectChanged = nextProjectId !== state.projectId;

  if (!sessionChanged && !nodeChanged && !projectChanged) {
    return false;
  }

  state.sessionId = nextSessionId;
  state.nodeId = nextNodeId;
  state.projectId = nextProjectId;

  // --- Added block to share session globally ---
  if (nextSessionId) {
    window.__active_session_id = nextSessionId;
    try {
      localStorage.setItem('session_id', nextSessionId);
    } catch (err) {
      console.warn('Failed to persist session_id', err);
    }
  } else {
    delete window.__active_session_id;
    try {
      localStorage.removeItem('session_id');
    } catch (err) {
      console.warn('Failed to clear session_id', err);
    }
  }
  // --- End added block ---

  state.messages = [];
  state.cursor = null;
  state.hasMore = false;
  state.totalCount = 0;
  state.filteredCount = 0;
  state.lastUserMessage = '';
  state.status = nextSessionId || nextNodeId ? 'idle' : 'empty';
  notify();
  return true;
}


export function resetMessagesStore() {
  state.messages = [];
  state.cursor = null;
  state.hasMore = false;
  state.totalCount = 0;
  state.filteredCount = 0;
  state.lastUserMessage = '';
  state.status = state.sessionId || state.nodeId ? 'idle' : 'empty';
  notify();
}

function requestWorkingMemoryRefresh(reason) {
  const projectId = normaliseProjectId(state.projectId);
  const nodeId = normaliseNodeId(state.nodeId);
  if (!projectId || !nodeId) {
    return;
  }
  refreshWorkingMemory({ projectId, nodeId, reason }).catch((error) => {
    console.warn('Failed to refresh working memory after messages update', error);
  });
}

function buildFetchOptions({ reset, limit } = {}) {
  const options = { limit: limit || DEFAULT_PAGE_SIZE };
  if (state.nodeId) {
    options.nodeId = state.nodeId;
  } else if (state.sessionId) {
    options.sessionId = state.sessionId;
  }
  if (!reset) {
    const cursor = normaliseCursor(state.cursor);
    if (cursor !== null) {
      options.cursor = cursor;
    }
  }
  return options;
}

export async function fetchMessagesPage({ reset = false, limit } = {}) {
  if (!state.sessionId && !state.nodeId) {
    resetMessagesStore();
    return { messages: [] };
  }
  const effectiveReset = reset || !state.messages.length;
  state.status = state.messages.length ? 'updating' : 'loading';
  notify();
  try {
    const data = await fetchMessagesApi(buildFetchOptions({ reset: effectiveReset, limit }));
    const incomingMessages = normaliseMessages(data?.messages);
    const combined = effectiveReset ? incomingMessages : state.messages.concat(incomingMessages);
    state.messages = buildChronologicalMessages(combined);
    const fallbackCursor = state.messages.length ? state.messages[state.messages.length - 1]?.id : null;
    state.cursor = normaliseCursor(data?.next_cursor ?? fallbackCursor);
    state.hasMore = Boolean(data?.has_more);
    state.totalCount = Number.isInteger(data?.total_count) ? data.total_count : state.messages.length;
    state.filteredCount = Number.isInteger(data?.filtered_count)
      ? data.filtered_count
      : state.messages.length;
    state.lastUserMessage = typeof data?.last_user_message === 'string' ? data.last_user_message : '';
    state.status = 'ready';
    notify();
    requestWorkingMemoryRefresh('message:paginate');
    return data;
  } catch (error) {
    state.status = 'error';
    notify();
    throw error;
  }
}

export async function sendMessageToSession(content, { role = 'user', messageType = 'user_reply' } = {}) {
  if (!state.sessionId) {
    throw new Error('Cannot send a message without an active session');
  }
  state.status = 'sending';
  notify();
  try {
    await sendMessageApi({
      sessionId: state.sessionId,
      nodeId: state.nodeId,
      role,
      content,
      messageType,
    });
    await fetchMessagesPage({ reset: true });
  } catch (error) {
    state.status = 'error';
    notify();
    throw error;
  }
}

export function clearMessagesContext() {
  setMessagesContext({ sessionId: '', nodeId: null, projectId: '' });
  resetMessagesStore();
}

export function notifyOptimisticRecoverySucceeded() {
  requestWorkingMemoryRefresh('message:recovery');
}
