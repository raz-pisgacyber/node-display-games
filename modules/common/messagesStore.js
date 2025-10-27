import { fetchMessages as fetchMessagesApi, sendMessage as sendMessageApi } from './api.js';

const DEFAULT_PAGE_SIZE = 50;

const state = {
  sessionId: '',
  nodeId: null,
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

export function setMessagesContext({ sessionId, nodeId } = {}) {
  const nextSessionId = normaliseSessionId(sessionId);
  const nextNodeId = normaliseNodeId(nodeId);
  const sessionChanged = nextSessionId !== state.sessionId;
  const nodeChanged = nextNodeId !== state.nodeId;
  if (!sessionChanged && !nodeChanged) {
    return false;
  }
  state.sessionId = nextSessionId;
  state.nodeId = nextNodeId;
  state.messages = [];
  state.cursor = null;
  state.hasMore = false;
  state.totalCount = 0;
  state.filteredCount = 0;
  state.lastUserMessage = '';
  state.status = nextSessionId ? 'idle' : 'empty';
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
  state.status = state.sessionId ? 'idle' : 'empty';
  notify();
}

function buildFetchOptions({ reset, limit } = {}) {
  const options = { limit: limit || DEFAULT_PAGE_SIZE };
  if (state.nodeId) {
    options.nodeId = state.nodeId;
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
  if (!state.sessionId) {
    resetMessagesStore();
    return { messages: [] };
  }
  const effectiveReset = reset || !state.messages.length;
  state.status = state.messages.length ? 'updating' : 'loading';
  notify();
  try {
    const data = await fetchMessagesApi(state.sessionId, buildFetchOptions({ reset: effectiveReset, limit }));
    const incomingMessages = normaliseMessages(data?.messages);
    state.messages = effectiveReset
      ? incomingMessages
      : normaliseMessages(state.messages.concat(incomingMessages));
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
  setMessagesContext({ sessionId: '', nodeId: null });
  resetMessagesStore();
}
