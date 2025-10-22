const { v4: uuidv4 } = require('uuid');

function tryParseJson(value) {
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

function parseMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return meta || {};
  }
  return Object.entries(meta).reduce((acc, [key, value]) => {
    acc[key] = value && typeof value === 'object' ? value : tryParseJson(value);
    return acc;
  }, {});
}

function serialiseMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return {};
  }
  return Object.entries(meta).reduce((acc, [key, value]) => {
    if (value === undefined) {
      return acc;
    }
    if (value && typeof value === 'object') {
      acc[key] = JSON.stringify(value);
    } else {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function extractNode(recordNode) {
  if (!recordNode) return null;
  const properties = recordNode.properties || {};
  const lastModified = properties.last_modified;
  return {
    id: properties.id,
    label: properties.label || '',
    content: properties.content || '',
    meta: parseMeta(properties.meta || {}),
    project_id: properties.project_id || null,
    last_modified: formatNeo4jDate(lastModified),
    version_id: properties.version_id,
  };
}

function formatNeo4jDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.toString) {
    return value.toString();
  }
  return new Date().toISOString();
}

function validateRelationshipType(type) {
  if (!type) return 'LINKS_TO';
  const valid = type.toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(valid)) {
    throw new Error('Invalid relationship type.');
  }
  return valid;
}

function newVersionMeta() {
  return {
    versionId: uuidv4(),
    lastModified: new Date().toISOString(),
  };
}

module.exports = {
  extractNode,
  formatNeo4jDate,
  validateRelationshipType,
  newVersionMeta,
  parseMeta,
  serialiseMeta,
};
