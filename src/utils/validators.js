class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

function ensurePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normaliseNonEmptyString(value) {
  if (value === undefined || value === null) {
    return '';
  }
  const trimmed = typeof value === 'string' ? value.trim() : `${value}`.trim();
  return trimmed;
}

function normaliseOptionalString(value) {
  const trimmed = normaliseNonEmptyString(value);
  return trimmed ? trimmed : null;
}

function validateMessagePayload(rawBody, {
  allowedRoles = [],
  allowedMessageTypes = [],
  defaultMessageType = 'user_reply',
} = {}) {
  const body = ensurePlainObject(rawBody);
  const allowedRolesSet = new Set(allowedRoles);
  const allowedMessageTypesSet = new Set(allowedMessageTypes);

  const sessionId = normaliseNonEmptyString(body.session_id);
  if (!sessionId) {
    throw new ValidationError('session_id is required');
  }

  const role = normaliseNonEmptyString(body.role);
  if (!role) {
    throw new ValidationError('role is required');
  }
  if (allowedRolesSet.size && !allowedRolesSet.has(role)) {
    throw new ValidationError('Invalid role');
  }

  if (body.content === undefined || body.content === null) {
    throw new ValidationError('content is required');
  }
  if (typeof body.content !== 'string') {
    throw new ValidationError('content must be a string');
  }
  const content = body.content.trim();
  if (!content) {
    throw new ValidationError('content is required');
  }

  const messageTypeCandidate = normaliseNonEmptyString(body.message_type);
  let messageType = messageTypeCandidate || defaultMessageType;
  if (!messageType) {
    messageType = defaultMessageType;
  }
  if (allowedMessageTypesSet.size && !allowedMessageTypesSet.has(messageType)) {
    throw new ValidationError('Invalid message_type');
  }

  const nodeId = normaliseOptionalString(body.node_id);

  return { sessionId, nodeId, role, content, messageType };
}

module.exports = {
  ValidationError,
  validateMessagePayload,
};
