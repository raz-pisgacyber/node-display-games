const { v4: uuidv4 } = require('uuid');

function parseMeta(meta) {
  if (!meta) {
    return {};
  }
  if (typeof meta === 'string') {
    const trimmed = meta.trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed);
      return parseMeta(parsed);
    } catch (error) {
      return {};
    }
  }
  if (typeof meta.toObject === 'function') {
    return parseMeta(meta.toObject());
  }
  if (meta instanceof Map) {
    return parseMeta(Object.fromEntries(meta.entries()));
  }
  if (Array.isArray(meta)) {
    return meta.map((item) => {
      if (item === null || item === undefined) {
        return item;
      }
      if (typeof item === 'object') {
        return parseMeta(item);
      }
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (!trimmed) {
          return '';
        }
        try {
          return JSON.parse(trimmed);
        } catch (error) {
          return item;
        }
      }
      return item;
    });
  }
  if (typeof meta !== 'object' || meta === null) {
    return {};
  }
  return Object.entries(meta).reduce((acc, [key, value]) => {
    if (value === undefined) {
      return acc;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        acc[key] = '';
        return acc;
      }
      try {
        acc[key] = JSON.parse(trimmed);
        return acc;
      } catch (error) {
        acc[key] = value;
        return acc;
      }
    }
    if (Array.isArray(value)) {
      acc[key] = value.map((item) => (typeof item === 'object' ? parseMeta(item) : item));
      return acc;
    }
    if (typeof value === 'object' && value !== null) {
      acc[key] = parseMeta(value);
      return acc;
    }
    acc[key] = value;
    return acc;
  }, {});
}

function serialiseMeta(meta) {
  if (typeof meta === 'string') {
    const trimmed = meta.trim();
    if (!trimmed) {
      return JSON.stringify({});
    }
    try {
      const parsed = JSON.parse(trimmed);
      return serialiseMeta(parsed);
    } catch (error) {
      return JSON.stringify({});
    }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return JSON.stringify({});
  }
  try {
    return JSON.stringify(meta);
  } catch (error) {
    return JSON.stringify({});
  }
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
